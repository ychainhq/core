import { getDbClient } from '../db/client';
import { BitcoinAdapter } from '../chain-adapters/bitcoin/adapter';
import { enrichSweepPsbt } from '../chain-adapters/bitcoin/psbt-enricher';
import { sweepsService } from '../modules/sweeps/sweeps.service';
import { webhooksService } from '../modules/webhooks/webhooks.service';
import { externalSignersService } from '../modules/external-signers/external-signers.service';
import { signerPolicyService } from '../modules/external-signers/signer-policy.service';
import { signingTasksService } from '../modules/signing-tasks/signing-tasks.service';
import { ticklerService } from '../shared/tickler/tickler.service';
import { btcToSatoshi } from '../shared/money/index';
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
 *   1. Builds a PSBT via Bitcoin Core walletCreateFundedPsbt (watch-only FWallet)
 *   2. Creates a `sweeps` record with status 'pending_signature'
 *   3. Fires a `sweep.ready_for_signing` webhook with the PSBT payload
 *
 * The tenant's signing daemon receives the webhook, signs the PSBT, and calls
 * POST /v1/sweeps/:sweepId/submit-signed to finalize and broadcast.
 */
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

    // Find tenants with an active hot wallet address (sweep destination)
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
    const adapter = new BitcoinAdapter();

    // Find tenant_hot wallet address (sweep destination)
    const hotAddr = await db.get<{ address: string }>(`
      SELECT a.address
      FROM addresses a
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'tenant_hot'
        AND a.chain_id = 'bitcoin' AND a.status = 'active'
      LIMIT 1
    `, [tenantId]);

    if (!hotAddr) {
      return; // No hot wallet address — cannot sweep
    }

    // Load tenant xpub — needed for PSBT enrichment (public-key derivation only)
    const tenantCfg = await db.get<{ btc_xpub: string | null }>(
      'SELECT btc_xpub FROM tenant_configs WHERE tenant_id = ?', [tenantId]
    );

    if (!tenantCfg?.btc_xpub) {
      logger.warn('SweepWorker: tenant has no btc_xpub — cannot enrich PSBT', { tenantId });
      return;
    }

    const accountXpub = tenantCfg.btc_xpub;
    const btcNetwork = this.getBtcNetwork();

    // Find all deposit addresses for this tenant (from customer_deposits wallet)
    const depositAddresses = await db.all<{ address: string }>(`
      SELECT DISTINCT a.address
      FROM addresses a
      JOIN wallets w ON w.id = a.wallet_id
      WHERE w.tenant_id = ? AND w.wallet_role = 'customer_deposits'
        AND a.chain_id = 'bitcoin' AND a.status = 'active'
    `, [tenantId]);

    if (depositAddresses.length === 0) return;

    // If there's already a pending sweep that has a signing_task, nothing to do.
    // If the pending sweep has no signing_task_id (created before migration 020 or before this fix),
    // we must create a signing task for it so the signer daemon can pick it up.
    // Block on any active sweep — pending_signature OR broadcast.
    // Without this check: after signing+broadcast the UTXOs are still is_spent=0 in cached_utxos
    // (until the indexer processes the utxo_spent event), so SweepWorker would repeatedly create
    // new duplicate sweeps for the same UTXOs every interval.
    const existingPending = await db.get<{ id: string; psbt: string | null; amount_raw: string; fee_raw: string | null; signing_task_id: string | null }>(
      "SELECT id, psbt, amount_raw, fee_raw, signing_task_id FROM sweeps WHERE tenant_id = ? AND status IN ('pending_signature', 'broadcast') LIMIT 1",
      [tenantId]
    );

    if (existingPending) {
      if (existingPending.signing_task_id) {
        // Check whether the existing signing task is still actionable.
        // If it has expired, been rejected, or failed, clear it so the recovery
        // path below can create a fresh signing task.
        const existingTask = await db.get<{ status: string }>(
          'SELECT status FROM signing_tasks WHERE id = ?',
          [existingPending.signing_task_id]
        );
        const isActive = existingTask &&
          !['expired', 'rejected', 'failed'].includes(existingTask.status);
        if (isActive) {
          return; // Task is still pending/claimed — signer will handle it
        }
        logger.warn('SweepWorker: signing task expired/failed — recreating', {
          sweepId: existingPending.id, taskId: existingPending.signing_task_id,
          taskStatus: existingTask?.status, tenantId,
        });
        await sweepsService.clearSigningTask(existingPending.id);
        existingPending.signing_task_id = null;
      }

      // Recover: create missing signing task for the orphaned pending sweep
      if (existingPending.psbt) {
        logger.warn('SweepWorker: recovering orphaned pending sweep — creating missing signing task', {
          sweepId: existingPending.id, tenantId,
        });

        // Enrich orphaned PSBT with bip32Derivation — address derived from witnessUtxo.script
        // which is embedded in the stored PSBT binary (filled by utxoupdatepsbt at creation time)
        let recoveryPsbt = existingPending.psbt;
        try {
          recoveryPsbt = await enrichSweepPsbt(
            existingPending.psbt, tenantId, accountXpub, btcNetwork
          );
          logger.info('SweepWorker: orphaned PSBT enriched with bip32Derivation', {
            sweepId: existingPending.id,
          });
        } catch (enrichErr) {
          logger.warn('SweepWorker: PSBT enrichment failed during recovery, using plain PSBT', {
            sweepId: existingPending.id, error: String(enrichErr),
          });
        }

        const selectedSigner = await externalSignersService.selectSigner(tenantId, 'bitcoin', 'bitcoin:BTC', 'btc_psbt');
        const policyDecision = await signerPolicyService.evaluateDecision(
          tenantId, selectedSigner?.id ?? null, 'bitcoin', 'bitcoin:BTC',
          existingPending.amount_raw, 5, 1
        );

        const signingTask = await signingTasksService.create({
          tenantId,
          signerId: selectedSigner?.id ?? null,
          requestType: 'btc_sweep',
          chainId: 'bitcoin',
          assetId: 'bitcoin:BTC',
          sweepId: existingPending.id,
          amountRaw: existingPending.amount_raw,
          feeRaw: existingPending.fee_raw ?? undefined,
          payloadFormat: 'btc_psbt',
          unsignedPayload: recoveryPsbt,
          decisionMode: policyDecision.mode,
          decisionReason: policyDecision.reason,
        });

        await sweepsService.linkSigningTask(existingPending.id, signingTask.id);

        await ticklerService.record({
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
      return;
    }

    // v3: read UTXOs from cached_utxos (populated by DepositEventProcessorWorker via
    // btc-indexer chain_events). Do NOT call listunspent — Bitcoin Core is stateless in v3.
    const utxoRows = await db.all<{ address: string; tx_hash: string; vout: number; amount_raw: string }>(`
      SELECT address, tx_hash, vout, amount_raw
      FROM cached_utxos
      WHERE tenant_id = ?
        AND chain_id = 'bitcoin'
        AND is_spent = 0
        AND is_locked = 0
        AND confirmations >= 1
        AND wallet_role = 'customer_deposits'
    `, [tenantId]);

    const sweepableUtxos: Array<{ address: string; txHash: string; vout: number; amount: string }> = [];
    let totalSats = BigInt(0);

    for (const u of utxoRows) {
      sweepableUtxos.push({ address: u.address, txHash: u.tx_hash, vout: u.vout, amount: u.amount_raw });
      totalSats += BigInt(u.amount_raw);
    }

    const threshold = BigInt(sweepThresholdSats);
    if (totalSats < threshold || sweepableUtxos.length === 0) return;

    logger.info('SweepWorker: threshold reached, building PSBT', {
      tenantId,
      totalSats: totalSats.toString(),
      threshold: sweepThresholdSats,
      utxoCount: sweepableUtxos.length,
    });

    // Estimate fee (target 6 blocks). adapter.estimateSmartFee already returns sat/vbyte.
    let feeRateSatPerVbyte = 5; // fallback
    try {
      const feeEst = await adapter.estimateSmartFee(6);
      if (feeEst.feeRate) feeRateSatPerVbyte = feeEst.feeRate;
    } catch {
      logger.warn('SweepWorker: fee estimation failed, using fallback', { tenantId });
    }

    // Build unsigned PSBT via createpsbt + utxoupdatepsbt.
    // walletCreateFundedPsbt fails on watch-only wallets with addr() descriptors
    // because those are not "solvable". createpsbt skips that check entirely and
    // utxoupdatepsbt fills in witness_utxo from the global UTXO set so the
    // external signer can compute the segwit sighash.
    const txVbytes = 42 + 68 * sweepableUtxos.length; // P2WPKH: 42 overhead + 68/input
    const feeSats = BigInt(Math.ceil(feeRateSatPerVbyte * txVbytes));
    const outputSats = totalSats - feeSats;

    if (outputSats <= BigInt(546)) {
      logger.warn('SweepWorker: sweep amount after fee is at or below dust threshold', {
        tenantId, totalSats: totalSats.toString(), feeSats: feeSats.toString(),
      });
      return;
    }

    let psbtBase64: string;
    const fromAddresses = [...new Set(sweepableUtxos.map((u) => u.address))];
    try {
      const inputs = sweepableUtxos.map((u) => ({ txid: u.txHash, vout: u.vout }));
      const outputBtc = parseFloat((Number(outputSats) / 1e8).toFixed(8));
      psbtBase64 = await adapter.createUnsignedPsbt(inputs, [{ [hotAddr.address]: outputBtc }]);
    } catch (err) {
      logger.warn('SweepWorker: failed to create PSBT (non-fatal)', { tenantId, err: String(err) });
      return;
    }

    // Enrich PSBT with bip32Derivation per input — address derived from witnessUtxo.script,
    // no private key in engine
    try {
      psbtBase64 = await enrichSweepPsbt(psbtBase64, tenantId, accountXpub, btcNetwork);
    } catch (err) {
      logger.warn('SweepWorker: PSBT enrichment failed (non-fatal, signer may reject)', {
        tenantId, err: String(err),
      });
    }

    // Create sweep record
    const sweep = await sweepsService.create(tenantId, {
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      fromAddresses,
      toAddress: hotAddr.address,
      amountRaw: totalSats.toString(),
      feeRaw: feeSats.toString(),
      psbt: psbtBase64,
    });

    // Select signer and evaluate policy — same pattern as withdrawal-batcher
    const selectedSigner = await externalSignersService.selectSigner(
      tenantId, 'bitcoin', 'bitcoin:BTC', 'btc_psbt'
    );

    const policyDecision = await signerPolicyService.evaluateDecision(
      tenantId,
      selectedSigner?.id ?? null,
      'bitcoin',
      'bitcoin:BTC',
      outputSats.toString(),
      feeRateSatPerVbyte,
      sweepableUtxos.length
    );

    // Create signing task so the signer daemon can poll and claim it
    const signingTask = await signingTasksService.create({
      tenantId,
      signerId: selectedSigner?.id ?? null,
      requestType: 'btc_sweep',
      chainId: 'bitcoin',
      assetId: 'bitcoin:BTC',
      sweepId: sweep.id,
      amountRaw: outputSats.toString(),
      feeRaw: feeSats.toString(),
      feeRateSatVb: feeRateSatPerVbyte.toString(),
      payloadFormat: 'btc_psbt',
      unsignedPayload: psbtBase64,
      decisionMode: policyDecision.mode,
      decisionReason: policyDecision.reason,
    });

    // Backlink via service — enkapsulacja SQL (worker nie pisze bezpośrednio do sweeps)
    await sweepsService.linkSigningTask(sweep.id, signingTask.id);

    // Tickler — każda mutacja musi być zalogowana
    await ticklerService.record({
      tenantId,
      category: 'sweep',
      subcategory: 'created',
      entityId: sweep.id,
      actorLogin: 'system:sweep-worker',
      field1: signingTask.id,
      field2: policyDecision.mode,
      newValue: sweep,
    });

    // Fire webhook for backward compatibility (tenants without polling signer)
    webhooksService.queueEvent(
      'sweep.ready_for_signing',
      {
        sweepId: sweep.id,
        signingTaskId: signingTask.id,
        psbt: psbtBase64,
        fromAddresses: sweep.from_addresses,
        toAddress: sweep.to_address,
        amountRaw: sweep.amount_raw,
        feeRaw: sweep.fee_raw,
        submitUrl: `/v1/sweeps/${sweep.id}/submit-signed`,
      },
      'bitcoin',
      undefined,
      tenantId
    );

    logger.info('SweepWorker: sweep and signing task created', {
      sweepId: sweep.id,
      signingTaskId: signingTask.id,
      decisionMode: policyDecision.mode,
      tenantId,
    });
  }
}
