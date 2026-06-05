import { getDbClient } from '../db/client';
import { BitcoinAdapter, DUST_THRESHOLD_SATS } from '../chain-adapters/bitcoin/adapter';
import { enrichSweepPsbt } from '../chain-adapters/bitcoin/psbt-enricher';
import { estimateTxVsize } from '../chain-adapters/bitcoin/tx-sizer';
import { sweepsService } from '../modules/sweeps/sweeps.service';
import { webhooksService } from '../modules/webhooks/webhooks.service';
import { externalSignersService } from '../modules/external-signers/external-signers.service';
import { signerPolicyService } from '../modules/external-signers/signer-policy.service';
import { signingTasksService } from '../modules/signing-tasks/signing-tasks.service';
import { ticklerService } from '../shared/tickler/tickler.service';
import { logger } from '../shared/logging/index';
import { config } from '../config/index';
import * as bitcoin from 'bitcoinjs-lib';

/**
 * SweepWorker
 *
 * Runs on a configurable interval. For each tenant that has:
 *   - a btc_sweep_threshold_sats set
 *   - a tenant_hot wallet with at least one address
 *
 * it checks the total unconfirmed+confirmed UTXOs sitting on customer deposit
 * addresses. When the total exceeds the sweep threshold, it:
 *
 *   1. Builds a PSBT via createpsbt + utxoupdatepsbt (stateless, no FWallet)
 *   2. Enriches the PSBT with bip32Derivation hints via enrichSweepPsbt
 *   3. Creates a `sweeps` record with status 'pending_signature'
 *   4. Creates a signing_task so the signer daemon can poll and claim it
 *   5. Fires a `sweep.ready_for_signing` webhook for backward compatibility
 */

interface TenantSweepContext {
  hotAddress: string;
  accountXpub: string;
  feeTargetBlocks: number;
  btcNetwork: bitcoin.networks.Network;
}

interface SweepableUtxo {
  address: string;
  txHash: string;
  vout: number;
  amount: string;
}

interface PendingSweepRow {
  id: string;
  psbt: string | null;
  amount_raw: string;
  fee_raw: string | null;
  signing_task_id: string | null;
}

const FALLBACK_FEE_RATE_SAT_VB = 5;

export class SweepWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    logger.info('SweepWorker started', { intervalMs: config.SWEEP_WORKER_INTERVAL_MS });

    this.interval = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.run();
      } catch (err) {
        logger.error('SweepWorker error', { error: String(err) });
      } finally {
        this.running = false;
      }
    }, config.SWEEP_WORKER_INTERVAL_MS);

    setImmediate(() =>
      this.run().catch((err) => logger.error('SweepWorker initial run error', { error: String(err) }))
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('SweepWorker stopped');
    }
  }

  async run(): Promise<void> {
    const db = getDbClient();

    const tenantRows = await db.all<{ tenant_id: string; btc_sweep_threshold_sats: string }>(`
      SELECT DISTINCT t.id as tenant_id, tc.btc_sweep_threshold_sats
      FROM tenants t
      JOIN tenant_configs tc ON tc.tenant_id = t.id
      WHERE t.status = 'active'
        AND tc.btc_sweep_threshold_sats IS NOT NULL
    `);

    for (const row of tenantRows) {
      try {
        await this.processTenant(row.tenant_id, row.btc_sweep_threshold_sats);
      } catch (err) {
        logger.warn('SweepWorker: error processing tenant', { tenantId: row.tenant_id, error: String(err) });
      }
    }
  }

  private getBtcNetwork(): bitcoin.networks.Network {
    switch (config.BITCOIN_NETWORK) {
      case 'testnet': return bitcoin.networks.testnet;
      case 'regtest': return bitcoin.networks.regtest;
      default:        return bitcoin.networks.bitcoin;
    }
  }

  private async processTenant(tenantId: string, sweepThresholdSats: string): Promise<void> {
    const db = getDbClient();

    const ctx = await this.resolveTenantSweepContext(tenantId);
    if (!ctx){
      logger.warn('SweepWorker: tenant missing hot wallet address or xpub — skipping', { tenantId });
      return;
    } 

    // Guard: if there are no deposit addresses at all, skip regardless of UTXOs.
    const depositAddresses = await db.all<{ address: string }>(`
      SELECT DISTINCT a.address
      FROM addresses a
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'customer_deposits'
        AND a.chain_id = 'bitcoin' AND a.status = 'active'
    `, [tenantId]);
    if (depositAddresses.length === 0){
      logger.info('SweepWorker: no active deposit addresses — skipping', { tenantId });
      return;
    };

    // Block on any active sweep. Without this, after signing+broadcast the UTXOs are
    // still is_spent=0 in cached_utxos until the indexer processes utxo_spent, so
    // the worker would create duplicate sweeps every interval.
    const existingPending = await db.get<PendingSweepRow>(
      "SELECT id, psbt, amount_raw, fee_raw, signing_task_id FROM sweeps WHERE tenant_id = ? AND status IN ('pending_signature', 'broadcast') LIMIT 1",
      [tenantId],
    );
    if (existingPending) {
      await this.handleExistingPendingSweep(tenantId, existingPending, ctx);
      return;
    }

    const utxos = await this.collectSweepableUtxos(tenantId);
    const totalSats = utxos.reduce((s, u) => s + BigInt(u.amount), 0n);

    if (totalSats < BigInt(sweepThresholdSats) || utxos.length === 0){
      logger.info('SweepWorker: threshold not reached or no UTXOs — skipping', { tenantId, totalSats: totalSats.toString(), threshold: sweepThresholdSats, utxoCount: utxos.length });
      return;
    };

    logger.info('SweepWorker: threshold reached, building PSBT', {
      tenantId,
      totalSats: totalSats.toString(),
      threshold: sweepThresholdSats,
      utxoCount: utxos.length,
    });

    const adapter = new BitcoinAdapter();
    const feeRateSatVb = await adapter.estimateFeeRateSatVb({
      targetBlocks: ctx.feeTargetBlocks,
    });

    const txVbytes = estimateTxVsize({
      inputCount: utxos.length,
      outputs: [{ address: ctx.hotAddress }],
    });
    const feeSats = BigInt(Math.ceil(feeRateSatVb * txVbytes));
    const outputSats = totalSats - feeSats;

    if (outputSats <= DUST_THRESHOLD_SATS) {
      logger.warn('SweepWorker: sweep amount after fee is at or below dust threshold', {
        tenantId, totalSats: totalSats.toString(), feeSats: feeSats.toString(),
      });
      return;
    }

    const psbt = await this.buildAndEnrichPsbt(utxos, ctx.hotAddress, outputSats, tenantId, ctx, adapter);
    if (!psbt){
      logger.warn('SweepWorker: PSBT build failed — aborting sweep', { tenantId });
      return;
    }

    const fromAddresses = [...new Set(utxos.map(u => u.address))];
    const sweep = await sweepsService.create(tenantId, {
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      fromAddresses,
      toAddress: ctx.hotAddress,
      amountRaw: totalSats.toString(),
      feeRaw: feeSats.toString(),
      psbt,
    });

    const { signingTask, policyDecision } = await this.createAndLinkSigningTask({
      tenantId,
      sweepId: sweep.id,
      psbt,
      amountRaw: outputSats.toString(),
      feeRaw: feeSats.toString(),
      feeRateSatVb,
      utxoCount: utxos.length,
    });

    this.recordSweepCreated({ tenantId, sweep, signingTask, policyDecision, psbt });
  }

  /**
   * Load the prerequisites for sweep processing. Returns null when the tenant
   * cannot be swept (missing hot wallet address or xpub).
   */
  private async resolveTenantSweepContext(tenantId: string): Promise<TenantSweepContext | null> {
    const db = getDbClient();

    const hotAddr = await db.get<{ address: string }>(`
      SELECT a.address
      FROM addresses a
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_hot'
        AND a.chain_id = 'bitcoin' AND a.status = 'active'
      LIMIT 1
    `, [tenantId]);

    if (!hotAddr) return null;

    const tenantCfg = await db.get<{ btc_xpub: string | null; btc_fee_target_blocks: number }>(
      'SELECT btc_xpub, btc_fee_target_blocks FROM tenant_configs WHERE tenant_id = ?',
      [tenantId],
    );

    if (!tenantCfg?.btc_xpub) {
      logger.warn('SweepWorker: tenant has no btc_xpub — cannot enrich PSBT', { tenantId });
      return null;
    }

    return {
      hotAddress: hotAddr.address,
      accountXpub: tenantCfg.btc_xpub,
      feeTargetBlocks: tenantCfg.btc_fee_target_blocks,
      btcNetwork: this.getBtcNetwork(),
    };
  }

  /**
   * Return all unlocked, unspent, confirmed customer-deposit UTXOs from cached_utxos.
   * v3: UTXOs are populated by btc-indexer via chain_events; Bitcoin Core listunspent is not used.
   */
  private async collectSweepableUtxos(tenantId: string): Promise<SweepableUtxo[]> {
    const db = getDbClient();
    const rows = await db.all<{ address: string; tx_hash: string; vout: number; amount_raw: string }>(`
      SELECT address, tx_hash, vout, amount_raw
      FROM cached_utxos
      WHERE tenant_id = ?
        AND chain_id = 'bitcoin'
        AND is_spent = 0
        AND is_locked = 0
        AND confirmations >= 1
        AND wallet_role = 'customer_deposits'
    `, [tenantId]);

    return rows.map(u => ({
      address: u.address,
      txHash: u.tx_hash,
      vout: u.vout,
      amount: u.amount_raw,
    }));
  }

  /**
   * Handle a sweep that is already in pending_signature or broadcast status.
   *
   * Three cases:
   *   1. Has an active signing task  → nothing to do, signer will handle it.
   *   2. Has an expired/failed task  → clear old task, create a fresh one (recovery).
   *   3. No signing task at all      → create a signing task (orphan recovery).
   */
  private async handleExistingPendingSweep(
    tenantId: string,
    existingPending: PendingSweepRow,
    ctx: TenantSweepContext,
  ): Promise<void> {
    const db = getDbClient();

    if (existingPending.signing_task_id) {
      const existingTask = await db.get<{ status: string }>(
        'SELECT status FROM signing_tasks WHERE id = ?',
        [existingPending.signing_task_id],
      );
      const isActive = existingTask && !['expired', 'rejected', 'failed'].includes(existingTask.status);
      if (isActive) return;

      logger.warn('SweepWorker: signing task expired/failed — recreating', {
        sweepId: existingPending.id,
        taskId: existingPending.signing_task_id,
        taskStatus: existingTask?.status,
        tenantId,
      });
      await sweepsService.clearSigningTask(existingPending.id);
      existingPending.signing_task_id = null;
    }

    if (!existingPending.psbt) return;

    logger.warn('SweepWorker: recovering orphaned pending sweep — creating missing signing task', {
      sweepId: existingPending.id, tenantId,
    });

    // Enrich the stored PSBT — witnessUtxo.script is already embedded by utxoupdatepsbt
    // at creation time, so we can derive the address→bip32 path without extra RPC calls.
    let psbt = existingPending.psbt;
    try {
      psbt = await enrichSweepPsbt(psbt, tenantId, ctx.accountXpub, ctx.btcNetwork);
      logger.info('SweepWorker: orphaned PSBT enriched with bip32Derivation', {
        sweepId: existingPending.id,
      });
    } catch (enrichErr) {
      logger.warn('SweepWorker: PSBT enrichment failed during recovery, using plain PSBT', {
        sweepId: existingPending.id, error: String(enrichErr),
      });
    }

    const { signingTask, policyDecision } = await this.createAndLinkSigningTask({
      tenantId,
      sweepId: existingPending.id,
      psbt,
      amountRaw: existingPending.amount_raw,
      feeRaw: existingPending.fee_raw ?? undefined,
      feeRateSatVb: FALLBACK_FEE_RATE_SAT_VB,
      utxoCount: 1,
    });

    ticklerService.record({
      tenantId,
      category: 'sweep',
      subcategory: 'signing_task_recovered',
      entityId: existingPending.id,
      actorLogin: 'system:sweep-worker',
      field1: signingTask.id,
      field2: policyDecision.mode,
    });

    logger.info('SweepWorker: orphaned sweep recovered', {
      sweepId: existingPending.id, signingTaskId: signingTask.id, tenantId,
    });
  }

  /**
   * Build the unsigned PSBT via the adapter and enrich it with bip32Derivation hints.
   * Enrichment failure is non-fatal — the signer may reject unsigned but engine won't block.
   * Returns null if the underlying RPC call fails (caller should abort the sweep).
   */
  private async buildAndEnrichPsbt(
    utxos: SweepableUtxo[],
    hotAddress: string,
    outputSats: bigint,
    tenantId: string,
    ctx: TenantSweepContext,
    adapter: BitcoinAdapter,
  ): Promise<string | null> {
    let psbt: string;
    try {
      psbt = await adapter.buildSweepPsbt(utxos, hotAddress, outputSats);
    } catch (err) {
      logger.warn('SweepWorker: failed to create PSBT (non-fatal)', { tenantId, err: String(err) });
      return null;
    }

    try {
      psbt = await enrichSweepPsbt(psbt, tenantId, ctx.accountXpub, ctx.btcNetwork);
    } catch (err) {
      logger.warn('SweepWorker: PSBT enrichment failed (non-fatal, signer may reject)', {
        tenantId, err: String(err),
      });
    }

    return psbt;
  }

  /**
   * Select signer, evaluate policy, create and link the signing task.
   * Shared between the happy path (new sweep) and the recovery path (orphaned sweep).
   */
  private async createAndLinkSigningTask(params: {
    tenantId: string;
    sweepId: string;
    psbt: string;
    amountRaw: string;
    feeRaw: string | undefined;
    feeRateSatVb?: number;
    utxoCount?: number;
  }): Promise<{ signingTask: { id: string }; policyDecision: { mode: string; reason?: string } }> {
    const { tenantId, sweepId, psbt, amountRaw, feeRaw, feeRateSatVb, utxoCount } = params;
    const resolvedFeeRate = feeRateSatVb ?? FALLBACK_FEE_RATE_SAT_VB;
    const resolvedCount = utxoCount ?? 1;

    const selectedSigner = await externalSignersService.selectSigner(
      tenantId, 'bitcoin', 'bitcoin:BTC', 'btc_psbt',
    );
    const policyDecision = await signerPolicyService.evaluateDecision(
      tenantId,
      selectedSigner?.id ?? null,
      'bitcoin',
      'bitcoin:BTC',
      amountRaw,
      resolvedFeeRate,
      resolvedCount,
    );

    const signingTask = await signingTasksService.create({
      tenantId,
      signerId: selectedSigner?.id ?? null,
      requestType: 'btc_sweep',
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      sweepId,
      amountRaw,
      feeRaw,
      ...(feeRateSatVb !== undefined ? { feeRateSatVb: feeRateSatVb.toString() } : {}),
      payloadFormat: 'btc_psbt',
      unsignedPayload: psbt,
      decisionMode: policyDecision.mode,
      decisionReason: policyDecision.reason,
    });

    await sweepsService.linkSigningTask(sweepId, signingTask.id);

    return { signingTask, policyDecision };
  }

  /**
   * Record the tickler audit entry and fire the backward-compat webhook.
   */
  private recordSweepCreated(params: {
    tenantId: string;
    sweep: any;
    signingTask: { id: string };
    policyDecision: { mode: string; reason?: string };
    psbt: string;
  }): void {
    const { tenantId, sweep, signingTask, policyDecision, psbt } = params;

    ticklerService.record({
      tenantId,
      category: 'sweep',
      subcategory: 'created',
      entityId: sweep.id,
      actorLogin: 'system:sweep-worker',
      field1: signingTask.id,
      field2: policyDecision.mode,
      newValue: sweep,
    });

    webhooksService.queueEvent(
      'sweep.ready_for_signing',
      {
        sweepId: sweep.id,
        signingTaskId: signingTask.id,
        psbt,
        fromAddresses: sweep.from_addresses,
        toAddress: sweep.to_address,
        amountRaw: sweep.amount_raw,
        feeRaw: sweep.fee_raw,
        submitUrl: `/v1/sweeps/${sweep.id}/submit-signed`,
      },
      'bitcoin',
      undefined,
      tenantId,
    );

    logger.info('SweepWorker: sweep and signing task created', {
      sweepId: sweep.id,
      signingTaskId: signingTask.id,
      decisionMode: policyDecision.mode,
      tenantId,
    });
  }
}
