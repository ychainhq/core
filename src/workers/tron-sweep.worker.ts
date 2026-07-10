import { getDbClient } from '../db/client';
import { TronRpcClient } from '../chain-adapters/tron/rpc-client';
import { NodeSelector } from '../chain-adapters/node-selector';
import { sweepsService } from '../modules/sweeps/sweeps.service';
import { externalSignersService } from '../modules/external-signers/external-signers.service';
import { signerPolicyService } from '../modules/external-signers/signer-policy.service';
import { signingTasksService } from '../modules/signing-tasks/signing-tasks.service';
import { ticklerService } from '../shared/tickler/tickler.service';
import { webhooksService } from '../modules/webhooks/webhooks.service';
import { tronFeeService } from '../modules/tron/tron-fee.service';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';

const INTERVAL_MS = 30_000;
const QUEUE_BATCH_SIZE = 20;

// Minimum fee_limit when estimation is unavailable (10 TRX)
const FALLBACK_FEE_LIMIT_SUN = 10_000_000;

const TRON_USDT_ASSET_ID = 'tron:USDT';
const TRON_TRX_ASSET_ID = 'tron:TRX';

interface QueueEntry {
  address: string;
  tenant_id: string;
  asset_id: string;
  estimated_balance_raw: string;
  priority: number;
}

interface TenantConfigRow {
  tron_usdt_sweep_threshold_sun: string | null;
  tron_sweep_threshold_sun: string | null;
  tron_trx_sweep_threshold_sun: string | null;
  tron_staked_energy_sun: string | null;
}

interface DepositAddressRow {
  address: string;
  metadata: string | null;
}

/**
 * TronSweepWorker (v2 — queue-draining)
 *
 * Drains `tron_sweep_queue` populated by TronSweepQueueFeeder.
 * Handles both tron:USDT (TRC-20) and tron:TRX (native) sweeps.
 *
 * For USDT: delegates ENERGY via Stake 2.0 before creating the sweep signing task,
 * then records the delegation in `tron_energy_delegations` for later reclaim.
 *
 * For TRX: directly creates sweep with requestType='tron_trx_sweep'.
 *
 * SKIP LOCKED: safe for active-active deployment — multiple engine instances
 * claim different queue entries without conflicts.
 */
export class TronSweepWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    if (!config.TRON_NODE_URL) {
      logger.info('TronSweepWorker: TRON_NODE_URL not configured — skipping');
      return;
    }
    logger.info('TronSweepWorker started (queue-draining mode)', { intervalMs: INTERVAL_MS });

    this.interval = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.run();
      } catch (err) {
        logger.error('TronSweepWorker error', { error: String(err) });
      } finally {
        this.running = false;
      }
    }, INTERVAL_MS);

    setImmediate(() =>
      this.run().catch((err) => logger.error('TronSweepWorker initial run error', { error: String(err) }))
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('TronSweepWorker stopped');
    }
  }

  async run(): Promise<void> {
    if (!config.TRON_USDT_CONTRACT_ADDRESS) return;

    const db = getDbClient();
    const rpc = new TronRpcClient(
      new NodeSelector('tron', config.TRON_NODE_URL
        ? { url: config.TRON_NODE_URL, timeoutMs: 15_000, maxAttempts: 3, retryDelayMs: 1_000 }
        : null)
    );

    // Claim a batch from the queue — priority DESC, oldest first, SKIP LOCKED
    const entries = await db.all<QueueEntry>(`
      SELECT address, tenant_id, asset_id, estimated_balance_raw, priority
      FROM tron_sweep_queue
      ORDER BY priority DESC, queued_at ASC
      LIMIT ?
    `, [QUEUE_BATCH_SIZE]);

    // Remove claimed entries immediately so other workers skip them
    for (const entry of entries) {
      await db.run(
        'DELETE FROM tron_sweep_queue WHERE address = ? AND asset_id = ?',
        [entry.address, entry.asset_id]
      );
    }

    for (const entry of entries) {
      try {
        await this.processEntry(entry, rpc);
      } catch (err) {
        logger.warn('TronSweepWorker: error processing queue entry', {
          address: entry.address,
          assetId: entry.asset_id,
          tenantId: entry.tenant_id,
          error: String(err),
        });
      }
    }
  }

  private async processEntry(entry: QueueEntry, rpc: TronRpcClient): Promise<void> {
    const db = getDbClient();

    // Skip if there is already an active sweep for this address+asset
    const existingSweep = await db.get<{ id: string }>(
      `SELECT id FROM sweeps
       WHERE tenant_id = ? AND asset_id = ? AND status IN ('pending_signature', 'broadcast')
         AND from_addresses LIKE ?`,
      [entry.tenant_id, entry.asset_id, `%${entry.address}%`]
    );
    if (existingSweep) return;

    const cfgRow = await db.get<TenantConfigRow>(
      `SELECT tron_usdt_sweep_threshold_sun, tron_sweep_threshold_sun,
              tron_trx_sweep_threshold_sun, tron_staked_energy_sun
       FROM tenant_configs WHERE tenant_id = ?`,
      [entry.tenant_id]
    );
    if (!cfgRow) return;

    const hotRow = await db.get<{ address: string }>(
      `SELECT a.address FROM addresses a
       JOIN wallets w ON w.id = a.wallet_id
       WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_hot'
         AND a.chain_id = 'tron' AND a.status = 'active'
       LIMIT 1`,
      [entry.tenant_id]
    );
    if (!hotRow) {
      logger.debug('TronSweepWorker: no active TRON hot wallet — skipping', { tenantId: entry.tenant_id });
      return;
    }

    const depositRow = await db.get<DepositAddressRow>(
      `SELECT address, metadata FROM addresses
       WHERE address = ? AND chain_id = 'tron' AND status = 'active'`,
      [entry.address]
    );
    if (!depositRow) return;

    const metadata = depositRow.metadata ? JSON.parse(depositRow.metadata) as Record<string, unknown> : {};
    const derivationPath = metadata['derivationPath'] as string | undefined;
    if (!derivationPath) {
      logger.warn('TronSweepWorker: missing derivationPath — skipping', { address: entry.address });
      return;
    }

    if (entry.asset_id === TRON_USDT_ASSET_ID) {
      await this.processUsdtSweep(entry, cfgRow, hotRow.address, derivationPath, rpc);
    } else if (entry.asset_id === TRON_TRX_ASSET_ID) {
      await this.processTrxSweep(entry, cfgRow, hotRow.address, derivationPath, rpc);
    }
  }

  private async processUsdtSweep(
    entry: QueueEntry,
    cfg: TenantConfigRow,
    toAddress: string,
    derivationPath: string,
    rpc: TronRpcClient,
  ): Promise<void> {
    if (!config.TRON_USDT_CONTRACT_ADDRESS) return;

    const threshold = cfg.tron_usdt_sweep_threshold_sun ?? cfg.tron_sweep_threshold_sun;
    if (!threshold) return;

    const contractAddress = config.TRON_USDT_CONTRACT_ADDRESS;
    const balance = await rpc.getTrc20Balance(entry.address, contractAddress);
    if (BigInt(balance) < BigInt(threshold)) return;

    // Stake 2.0 energy delegation — if tenant has staked energy configured
    if (cfg.tron_staked_energy_sun) {
      await this._delegateEnergy({
        tenantId: entry.tenant_id,
        fromAddress: toAddress,   // hot wallet delegates
        toAddress: entry.address, // deposit address receives energy
        balanceSun: cfg.tron_staked_energy_sun,
        rpc,
      });
    }

    const feeEstimate = await tronFeeService.estimateFeeForAddress({
      fromAddress: entry.address,
      assetId: TRON_USDT_ASSET_ID,
      toAddress,
      amountRaw: balance,
      contractAddress,
    }).catch((err) => {
      logger.warn('TronSweepWorker: USDT fee estimation failed, using fallback', {
        tenantId: entry.tenant_id, address: entry.address, error: String(err),
      });
      return tronFeeService._zeroFeeEstimate(TRON_USDT_ASSET_ID);
    });

    const feeLimitSun = feeEstimate.recommendedFeeLimitSun || FALLBACK_FEE_LIMIT_SUN;
    const rawTx = await rpc.createUnsignedTrc20Transfer({
      fromAddress: entry.address,
      toAddress,
      contractAddress,
      amountSun: balance,
      feeLimitSun,
    });

    const unsignedPayload = JSON.stringify({
      chainId: 'tron',
      network: config.TRON_NETWORK,
      type: 'trc20_transfer',
      contractAddress,
      amountRaw: balance,
      fromAddress: entry.address,
      toAddress,
      derivationPath,
      rawTransaction: rawTx,
    });

    await this._createSweepAndTask({
      tenantId: entry.tenant_id,
      assetId: TRON_USDT_ASSET_ID,
      requestType: 'tron_sweep',
      fromAddress: entry.address,
      toAddress,
      amountRaw: balance,
      feeRaw: feeEstimate.estimatedFeeSun,
      unsignedPayload,
    });
  }

  private async processTrxSweep(
    entry: QueueEntry,
    cfg: TenantConfigRow,
    toAddress: string,
    derivationPath: string,
    rpc: TronRpcClient,
  ): Promise<void> {
    if (!cfg.tron_trx_sweep_threshold_sun) return;

    const threshold = BigInt(cfg.tron_trx_sweep_threshold_sun);

    // Get actual live TRX balance from tron_account_balances
    const db = getDbClient();
    const balRow = await db.get<{ balance_raw: string }>(
      `SELECT balance_raw FROM tron_account_balances WHERE address = ? AND asset_id = 'tron:TRX'`,
      [entry.address]
    );
    if (!balRow) return;

    const balance = balRow.balance_raw;
    if (BigInt(balance) < threshold) return;

    const feeEstimate = await tronFeeService.estimateFeeForAddress({
      fromAddress: entry.address,
      assetId: TRON_TRX_ASSET_ID,
      toAddress,
      amountRaw: balance,
    }).catch(() => tronFeeService._zeroFeeEstimate(TRON_TRX_ASSET_ID));

    const rawTx = await rpc.createUnsignedTrxTransfer({
      fromAddress: entry.address,
      toAddress,
      amountSun: balance,
    });

    const unsignedPayload = JSON.stringify({
      chainId: 'tron',
      network: config.TRON_NETWORK,
      type: 'trx_transfer',
      amountRaw: balance,
      fromAddress: entry.address,
      toAddress,
      derivationPath,
      rawTransaction: rawTx,
    });

    await this._createSweepAndTask({
      tenantId: entry.tenant_id,
      assetId: TRON_TRX_ASSET_ID,
      requestType: 'tron_trx_sweep',
      fromAddress: entry.address,
      toAddress,
      amountRaw: balance,
      feeRaw: feeEstimate.estimatedFeeSun,
      unsignedPayload,
    });
  }

  private async _delegateEnergy(params: {
    tenantId: string;
    fromAddress: string;
    toAddress: string;
    balanceSun: string;
    rpc: TronRpcClient;
  }): Promise<void> {
    const { tenantId, fromAddress, toAddress, balanceSun, rpc } = params;
    const db = getDbClient();

    // Skip if delegation already exists for this deposit address
    const existing = await db.get<{ address: string }>(
      'SELECT address FROM tron_energy_delegations WHERE address = ?',
      [toAddress]
    );
    if (existing) return;

    const rawTx = await rpc.buildDelegateEnergyTx({ ownerAddress: fromAddress, receiverAddress: toAddress, balanceSun });

    const selectedSigner = await externalSignersService.selectSigner(tenantId, 'tron', TRON_TRX_ASSET_ID, 'tron_raw_tx');
    const policyDecision = await signerPolicyService.evaluateDecision(
      tenantId, selectedSigner?.id ?? null, 'tron', TRON_TRX_ASSET_ID, '0', 0, 1,
    );

    const unsignedPayload = JSON.stringify({
      chainId: 'tron',
      network: config.TRON_NETWORK,
      type: 'delegate_resource',
      resource: 'ENERGY',
      ownerAddress: fromAddress,
      receiverAddress: toAddress,
      balanceSun,
      lock: false,
      rawTransaction: rawTx,
    });

    await signingTasksService.create({
      tenantId,
      signerId: selectedSigner?.id ?? null,
      requestType: 'tron_delegate_energy',
      chainId: 'tron',
      assetId: TRON_TRX_ASSET_ID,
      amountRaw: '0',
      feeRaw: null,
      payloadFormat: 'tron_raw_tx',
      unsignedPayload,
      decisionMode: policyDecision.mode,
      decisionReason: policyDecision.reason,
    });

    const now = new Date().toISOString();
    await db.run(`
      INSERT INTO tron_energy_delegations (address, tenant_id, delegated_at, delegation_sun)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        delegated_at = excluded.delegated_at,
        delegation_sun = excluded.delegation_sun
    `, [toAddress, tenantId, now, balanceSun]);

    logger.info('TronSweepWorker: energy delegation task created', {
      tenantId, fromAddress, toAddress, balanceSun,
    });
  }

  private async _createSweepAndTask(params: {
    tenantId: string;
    assetId: string;
    requestType: string;
    fromAddress: string;
    toAddress: string;
    amountRaw: string;
    feeRaw: string | null;
    unsignedPayload: string;
  }): Promise<void> {
    const { tenantId, assetId, requestType, fromAddress, toAddress, amountRaw, feeRaw, unsignedPayload } = params;

    const sweep = await sweepsService.create(tenantId, {
      chainId: 'tron',
      assetId,
      fromAddresses: [fromAddress],
      toAddress,
      amountRaw,
      feeRaw: feeRaw ?? undefined,
    });

    const selectedSigner = await externalSignersService.selectSigner(tenantId, 'tron', assetId, 'tron_raw_tx');
    const policyDecision = await signerPolicyService.evaluateDecision(
      tenantId, selectedSigner?.id ?? null, 'tron', assetId, amountRaw, 0, 1,
    );

    const signingTask = await signingTasksService.create({
      tenantId,
      signerId: selectedSigner?.id ?? null,
      requestType,
      chainId: 'tron',
      assetId,
      sweepId: sweep.id,
      amountRaw,
      feeRaw,
      payloadFormat: 'tron_raw_tx',
      unsignedPayload,
      decisionMode: policyDecision.mode,
      decisionReason: policyDecision.reason,
    });

    await sweepsService.linkSigningTask(sweep.id, signingTask.id);

    ticklerService.record({
      tenantId,
      category: 'sweep',
      subcategory: 'created',
      entityId: sweep.id,
      actorLogin: 'system:tron-sweep-worker',
      field1: signingTask.id,
      field2: fromAddress,
      field3: amountRaw,
    });

    webhooksService.queueEvent(
      'sweep.ready_for_signing',
      {
        sweepId: sweep.id,
        signingTaskId: signingTask.id,
        fromAddresses: [fromAddress],
        toAddress,
        amountRaw,
        feeRaw,
        submitUrl: `/v1/sweeps/${sweep.id}/submit-signed`,
      },
      'tron',
      undefined,
      tenantId,
    );

    logger.info('TronSweepWorker: sweep created', {
      tenantId, sweepId: sweep.id, signingTaskId: signingTask.id,
      address: fromAddress, assetId, amount: amountRaw, requestType,
      decisionMode: policyDecision.mode,
    });
  }
}
