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

const INTERVAL_MS = 60_000;
const TRON_USDT_ASSET_ID = 'tron:USDT';

// Minimum fee_limit when estimation is unavailable (10 TRX)
const FALLBACK_FEE_LIMIT_SUN = 10_000_000;

interface TenantSweepRow {
  tenant_id: string;
  tron_sweep_threshold_sun: string;
}

interface DepositAddressRow {
  address: string;
  metadata: string | null;
}

/**
 * TronSweepWorker
 *
 * Polls at INTERVAL_MS. For each tenant with tron_sweep_threshold_sun set,
 * it checks all active TRON deposit addresses. When a deposit address holds
 * more USDT than the threshold, it:
 *
 *  1. Calls TronRpcClient.createUnsignedTrc20Transfer() to build an unsigned tx
 *  2. Creates a sweeps record (status=pending_signature)
 *  3. Creates a signing_task with payload format tron_raw_tx and requestType=tron_sweep
 *     — the unsigned payload envelope includes derivationPath for the signer's HD derivation
 *  4. Links the signing task to the sweep
 *  5. Records tickler and fires sweep.ready_for_signing webhook
 *
 * One signing task per deposit address (TRON is account-based, not UTXO-based).
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
    logger.info('TronSweepWorker started', { intervalMs: INTERVAL_MS });

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
    if (!config.TRON_NODE_URL || !config.TRON_USDT_CONTRACT_ADDRESS) return;

    const db = getDbClient();
    const tenantRows = await db.all<TenantSweepRow>(`
      SELECT t.id AS tenant_id, tc.tron_sweep_threshold_sun
      FROM tenants t
      JOIN tenant_configs tc ON tc.tenant_id = t.id
      WHERE t.status = 'active'
        AND tc.tron_sweep_threshold_sun IS NOT NULL
        AND tc.tron_xpub IS NOT NULL
    `);

    for (const row of tenantRows) {
      try {
        await this.processTenant(row.tenant_id, row.tron_sweep_threshold_sun);
      } catch (err) {
        logger.warn('TronSweepWorker: error processing tenant', {
          tenantId: row.tenant_id,
          error: String(err),
        });
      }
    }
  }

  private async processTenant(tenantId: string, sweepThresholdSun: string): Promise<void> {
    const db = getDbClient();

    const coldAddr = await db.get<{ address: string }>(`
      SELECT a.address
      FROM addresses a
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_cold'
        AND a.chain_id = 'tron' AND a.status = 'active'
      LIMIT 1
    `, [tenantId]);

    if (!coldAddr) {
      logger.debug('TronSweepWorker: no active TRON cold wallet address — skipping', { tenantId });
      return;
    }

    const depositAddrs = await db.all<DepositAddressRow>(`
      SELECT a.address, a.metadata
      FROM addresses a
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'customer_deposits'
        AND a.chain_id = 'tron' AND a.status = 'active'
    `, [tenantId]);

    if (depositAddrs.length === 0) return;

    const tronFallback = config.TRON_NODE_URL
      ? { url: config.TRON_NODE_URL, timeoutMs: 15_000, maxAttempts: 3, retryDelayMs: 1_000 }
      : null;
    const rpc = new TronRpcClient(new NodeSelector('tron', tronFallback));
    const contractAddress = config.TRON_USDT_CONTRACT_ADDRESS!;
    const threshold = BigInt(sweepThresholdSun);

    for (const addrRow of depositAddrs) {
      try {
        await this.processDepositAddress(
          tenantId, addrRow, coldAddr.address,
          contractAddress, rpc, threshold,
        );
      } catch (err) {
        logger.warn('TronSweepWorker: error on deposit address', {
          tenantId, address: addrRow.address, error: String(err),
        });
      }
    }
  }

  private async processDepositAddress(
    tenantId: string,
    addrRow: DepositAddressRow,
    toAddress: string,
    contractAddress: string,
    rpc: TronRpcClient,
    threshold: bigint,
  ): Promise<void> {
    const db = getDbClient();
    const address = addrRow.address;

    const metadata = addrRow.metadata ? JSON.parse(addrRow.metadata) as Record<string, unknown> : {};
    const derivationPath = metadata['derivationPath'] as string | undefined;

    if (!derivationPath) {
      logger.warn('TronSweepWorker: deposit address missing derivationPath metadata — skipping', {
        tenantId, address,
      });
      return;
    }

    // Block if there is already an active sweep for this address
    const existingSweep = await db.get<{ id: string }>(
      `SELECT id FROM sweeps
       WHERE tenant_id = ? AND status IN ('pending_signature', 'broadcast')
         AND from_addresses LIKE ?`,
      [tenantId, `%${address}%`]
    );
    if (existingSweep) return;

    const balance = await rpc.getTrc20Balance(address, contractAddress);
    if (BigInt(balance) < threshold) return;

    // Dynamic fee estimation for this specific sweep tx
    const feeEstimate = await tronFeeService.estimateFeeForAddress({
      fromAddress: address,
      assetId: TRON_USDT_ASSET_ID,
      toAddress,
      amountRaw: balance,
      contractAddress,
    }).catch((err) => {
      logger.warn('TronSweepWorker: fee estimation failed, using fallback', { tenantId, address, error: String(err) });
      return tronFeeService._zeroFeeEstimate(TRON_USDT_ASSET_ID);
    });

    const feeLimitSun = feeEstimate.recommendedFeeLimitSun || FALLBACK_FEE_LIMIT_SUN;
    const rawTx = await rpc.createUnsignedTrc20Transfer({
      fromAddress: address,
      toAddress,
      contractAddress,
      amountSun: balance,
      feeLimitSun,
    });

    // Build the signing task envelope — derivationPath is required for HD child-key derivation
    const unsignedPayload = JSON.stringify({
      chainId: 'tron',
      network: config.TRON_NETWORK,
      type: 'trc20_transfer',
      contractAddress,
      amountRaw: balance,
      fromAddress: address,
      toAddress,
      derivationPath,
      rawTransaction: rawTx,
    });

    const sweep = await sweepsService.create(tenantId, {
      chainId: 'tron',
      assetId: TRON_USDT_ASSET_ID,
      fromAddresses: [address],
      toAddress,
      amountRaw: balance,
      feeRaw: feeEstimate.estimatedFeeSun, // actual predicted cost, not the cap
    });

    const selectedSigner = await externalSignersService.selectSigner(
      tenantId, 'tron', TRON_USDT_ASSET_ID, 'tron_raw_tx',
    );
    const policyDecision = await signerPolicyService.evaluateDecision(
      tenantId,
      selectedSigner?.id ?? null,
      'tron',
      TRON_USDT_ASSET_ID,
      balance,
      0,
      1,
    );

    const signingTask = await signingTasksService.create({
      tenantId,
      signerId: selectedSigner?.id ?? null,
      requestType: 'tron_sweep',
      chainId: 'tron',
      assetId: TRON_USDT_ASSET_ID,
      sweepId: sweep.id,
      amountRaw: balance,
      feeRaw: feeEstimate.estimatedFeeSun, // actual predicted cost, not the cap
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
      field2: address,
      field3: balance,
    });

    webhooksService.queueEvent(
      'sweep.ready_for_signing',
      {
        sweepId: sweep.id,
        signingTaskId: signingTask.id,
        fromAddresses: [address],
        toAddress,
        amountRaw: balance,
        feeRaw: feeEstimate.estimatedFeeSun,
        submitUrl: `/v1/sweeps/${sweep.id}/submit-signed`,
      },
      'tron',
      undefined,
      tenantId,
    );

    logger.info('TronSweepWorker: USDT sweep created', {
      tenantId,
      sweepId: sweep.id,
      signingTaskId: signingTask.id,
      address,
      amount: balance,
      decisionMode: policyDecision.mode,
    });
  }
}
