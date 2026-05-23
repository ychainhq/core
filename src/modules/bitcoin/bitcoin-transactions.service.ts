import crypto from 'crypto';
import { adapterRegistry } from '../../chain-adapters/registry';
import { getDb } from '../../db/sqlite';
import { ValidationError, UnprocessableEntityError, NotFoundError } from '../../shared/errors/index';
import { satoshiToBtc, addSatoshi } from '../../shared/money/index';
import { validateRawTransaction, validatePsbt } from '../../shared/validation/bitcoin';
import { transactionsService } from '../transactions/transactions.service';
import { webhooksService } from '../webhooks/webhooks.service';

const INPUT_SIZE = 68;
const OUTPUT_SIZE = 31;
const TX_OVERHEAD = 10;

interface CoinSelectionInput {
  fromAddresses: string[];
  outputs: Array<{ address: string; amount: string }>;
  feeRate: number;
  changeAddress: string;
}

interface SelectedInput {
  txHash: string;
  vout: number;
  address: string;
  amount: string;
  scriptPubKey: string;
  confirmations: number;
}

async function selectCoins(input: CoinSelectionInput, tenantId: string): Promise<{
  selectedInputs: SelectedInput[];
  outputs: Array<{ address: string; amount: string }>;
  estimatedFee: string;
  changeAmount: string;
}> {
  const adapter = adapterRegistry.get('bitcoin');

  let allUtxos: any[] = [];
  for (const addr of input.fromAddresses) {
    const utxos = await adapter.getUtxosForAddress(addr, 0, tenantId);
    allUtxos.push(...utxos);
  }

  allUtxos.sort((a, b) => {
    if (b.confirmations !== a.confirmations) return b.confirmations - a.confirmations;
    return Number(BigInt(b.amount) - BigInt(a.amount));
  });

  const targetAmount = input.outputs.reduce((sum, o) => sum + BigInt(o.amount), BigInt(0));
  const selected: typeof allUtxos = [];
  let selectedTotal = BigInt(0);

  for (const utxo of allUtxos) {
    selected.push(utxo);
    selectedTotal += BigInt(utxo.amount);

    const estimatedSize = selected.length * INPUT_SIZE + (input.outputs.length + 1) * OUTPUT_SIZE + TX_OVERHEAD;
    const estimatedFee = BigInt(Math.ceil(estimatedSize * input.feeRate));

    if (selectedTotal >= targetAmount + estimatedFee) {
      const changeAmount = selectedTotal - targetAmount - estimatedFee;
      return {
        selectedInputs: selected.map((u) => ({
          txHash: u.txHash,
          vout: u.vout,
          address: u.address,
          amount: u.amount,
          scriptPubKey: u.scriptPubKey,
          confirmations: u.confirmations,
        })),
        outputs: input.outputs,
        estimatedFee: estimatedFee.toString(),
        changeAmount: changeAmount.toString(),
      };
    }
  }

  throw new UnprocessableEntityError('Insufficient funds for the requested transaction', {
    available: selectedTotal.toString(),
    required: targetAmount.toString(),
  });
}

export const bitcoinTransactionsService = {
  async getFees(): Promise<{
    feeRates: Record<string, { feeRate: number; targetBlocks: number }>;
    unit: string;
    timestamp: string;
  }> {
    const adapter = adapterRegistry.get('bitcoin');
    const [low, normal, high] = await Promise.all([
      adapter.estimateSmartFee(12).catch(() => ({ feeRate: 1, targetBlocks: 12, mode: 'conservative' })),
      adapter.estimateSmartFee(6).catch(() => ({ feeRate: 2, targetBlocks: 6, mode: 'conservative' })),
      adapter.estimateSmartFee(2).catch(() => ({ feeRate: 5, targetBlocks: 2, mode: 'conservative' })),
    ]);

    return {
      feeRates: {
        low: { feeRate: low.feeRate, targetBlocks: low.targetBlocks },
        normal: { feeRate: normal.feeRate, targetBlocks: normal.targetBlocks },
        high: { feeRate: high.feeRate, targetBlocks: high.targetBlocks },
      },
      unit: 'sat/vbyte',
      timestamp: new Date().toISOString(),
    };
  },

  async coinSelection(tenantId: string, input: CoinSelectionInput): Promise<Record<string, unknown>> {
    const adapter = adapterRegistry.get('bitcoin');

    for (const addr of [...input.fromAddresses, input.changeAddress]) {
      if (!adapter.isValidAddress(addr)) throw new ValidationError(`Invalid Bitcoin address: ${addr}`);
    }
    for (const out of input.outputs) {
      if (!adapter.isValidAddress(out.address)) throw new ValidationError(`Invalid Bitcoin output address: ${out.address}`);
    }

    const result = await selectCoins(input, tenantId);
    const changeAmount = BigInt(result.changeAmount);
    const allOutputs = [...result.outputs];
    if (changeAmount > BigInt(546)) {
      allOutputs.push({ address: input.changeAddress, amount: changeAmount.toString() });
    }

    return {
      selectedInputs: result.selectedInputs.map((i) => ({ ...i, amount_display: satoshiToBtc(i.amount) })),
      outputs: allOutputs.map((o) => ({ ...o, amount_display: satoshiToBtc(o.amount) })),
      estimatedFee: result.estimatedFee,
      estimatedFee_display: satoshiToBtc(result.estimatedFee),
      feeRate: input.feeRate,
      changeAddress: input.changeAddress,
      changeAmount: changeAmount > BigInt(546) ? changeAmount.toString() : '0',
    };
  },

  async prepare(tenantId: string, input: {
    fromAddresses: string[];
    outputs: Array<{ address: string; amount: string }>;
    changeAddress: string;
    feePolicy?: { feeRate?: number; targetBlocks?: number };
    format?: 'psbt' | 'raw';
    walletId?: string;
  }): Promise<Record<string, unknown>> {
    const adapter = adapterRegistry.get('bitcoin');
    const feeRate = input.feePolicy?.feeRate ??
      (await adapter.estimateSmartFee(input.feePolicy?.targetBlocks ?? 6)).feeRate;

    const coinSel = await selectCoins({
      fromAddresses: input.fromAddresses,
      outputs: input.outputs,
      feeRate,
      changeAddress: input.changeAddress,
    }, tenantId);

    const changeAmount = BigInt(coinSel.changeAmount);
    const finalOutputs = [...input.outputs];
    if (changeAmount > BigInt(546)) {
      finalOutputs.push({ address: input.changeAddress, amount: changeAmount.toString() });
    }

    let psbtResult: any = null;
    if ((input.format ?? 'psbt') === 'psbt') {
      try {
        const inputs = coinSel.selectedInputs.map((i) => ({ txid: i.txHash, vout: i.vout }));
        const outputs = finalOutputs.map((o) => ({
          [o.address]: Number((BigInt(o.amount) * BigInt(100)) / BigInt(100_000_000)) / 100,
        }));
        psbtResult = await adapter.walletCreateFundedPsbt(inputs, outputs, { feeRate: feeRate / 100000 }, tenantId);
      } catch {
        // Fall back to raw-format metadata.
      }
    }

    const db = getDb();
    const txId = `tx_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO transactions (id, chain_id, tx_hash, psbt, status, fee_raw, fee_rate, wallet_id, metadata, created_at, updated_at)
      VALUES (?, 'bitcoin', NULL, ?, 'prepared', ?, ?, ?, ?, ?, ?)
    `).run(
      txId,
      psbtResult?.psbt ?? null,
      coinSel.estimatedFee,
      feeRate.toString(),
      input.walletId ?? null,
      JSON.stringify({ tenantId, fromAddresses: input.fromAddresses }),
      now,
      now
    );

    return {
      txId,
      format: psbtResult ? 'psbt' : 'raw',
      psbt: psbtResult?.psbt ?? null,
      inputs: coinSel.selectedInputs.map((i) => ({ ...i, amount_display: satoshiToBtc(i.amount) })),
      outputs: finalOutputs.map((o) => ({ ...o, amount_display: satoshiToBtc(o.amount) })),
      estimatedFee: coinSel.estimatedFee,
      estimatedFee_display: satoshiToBtc(coinSel.estimatedFee),
      feeRate,
      status: 'prepared',
    };
  },

  async finalizePsbt(psbt: string): Promise<{ rawTransaction: string; complete: boolean }> {
    if (!validatePsbt(psbt)) throw new ValidationError('Invalid PSBT format');
    const adapter = adapterRegistry.get('bitcoin');
    const result = await adapter.finalizePsbt(psbt);
    if (!result.complete) throw new UnprocessableEntityError('PSBT is not complete — missing signatures');
    return { rawTransaction: result.hex, complete: result.complete };
  },

  async broadcast(tenantId: string, chain: string, rawTransaction: string): Promise<Record<string, unknown>> {
    const adapter = adapterRegistry.get(chain);
    if (chain === 'bitcoin' && !validateRawTransaction(rawTransaction)) {
      throw new ValidationError('Invalid raw transaction format');
    }

    await adapter.decodeRawTransaction(rawTransaction);
    const acceptResult = await adapter.testMempoolAccept(rawTransaction);
    if (!acceptResult.allowed) {
      throw new UnprocessableEntityError(`Transaction rejected by mempool: ${acceptResult.rejectReason}`, {
        rejectReason: acceptResult.rejectReason,
      });
    }

    const txHash = await adapter.sendRawTransaction(rawTransaction);
    const tx = transactionsService.upsertByHash(chain, txHash, {
      raw_tx: rawTransaction,
      status: 'broadcasted',
      broadcast_at: new Date().toISOString(),
      metadata: { tenantId },
    });

    webhooksService.queueEvent('transaction.broadcasted', {
      txHash,
      chain,
      status: 'broadcasted',
      txId: tx.id,
    }, chain, undefined, tenantId);

    return { txHash, txId: tx.id, status: 'broadcasted', vsize: acceptResult.vsize };
  },

  async validateRaw(chain: string, rawTransaction: string): Promise<unknown> {
    const adapter = adapterRegistry.get(chain);
    return adapter.testMempoolAccept(rawTransaction);
  },

  async getTransaction(chain: string, txHash: string): Promise<Record<string, unknown>> {
    const adapter = adapterRegistry.get(chain);
    const [rawTx, localTx] = await Promise.all([
      adapter.getRawTransaction(txHash, true),
      Promise.resolve(transactionsService.getByTxHash(chain, txHash)),
    ]);
    return { ...(rawTx as Record<string, unknown>), local: localTx ?? null };
  },

  async getTransactionStatus(chain: string, txHash: string): Promise<Record<string, unknown>> {
    const adapter = adapterRegistry.get(chain);
    const status = await adapter.getTransactionStatus(txHash);
    const localTx = transactionsService.getByTxHash(chain, txHash);
    return { ...((status as unknown) as Record<string, unknown>), localStatus: localTx?.status ?? null };
  },

  async getAddressUtxos(tenantId: string, address: string, minConfirmations = 0): Promise<unknown[]> {
    const adapter = adapterRegistry.get('bitcoin');
    const utxos = await adapter.getUtxosForAddress(address, minConfirmations, tenantId);
    return utxos.map((u) => ({ ...u, amount_display: satoshiToBtc(u.amount) }));
  },

  async getWalletUtxos(tenantId: string, walletId: string, minConfirmations = 0): Promise<unknown[]> {
    const db = getDb();
    const wallet = db.prepare('SELECT * FROM wallets WHERE id = ? AND tenant_id = ?').get(walletId, tenantId);
    if (!wallet) throw new NotFoundError('Wallet', walletId);

    const addresses = db
      .prepare("SELECT address FROM addresses WHERE wallet_id = ? AND chain_id = 'bitcoin' AND status = 'active'")
      .all(walletId) as { address: string }[];

    const allUtxos: unknown[] = [];
    for (const { address } of addresses) {
      try {
        allUtxos.push(...await bitcoinTransactionsService.getAddressUtxos(tenantId, address, minConfirmations));
      } catch {
        // Skip failed addresses.
      }
    }
    return allUtxos;
  },

  async getAddressBalance(tenantId: string, chain: string, address: string, asset?: string): Promise<Record<string, unknown>> {
    const adapter = adapterRegistry.get(chain);
    const balance = await adapter.getAddressBalance(address, tenantId);
    return {
      address,
      chain,
      asset: asset ?? `${chain}:${chain === 'bitcoin' ? 'BTC' : 'ETH'}`,
      confirmed: balance.confirmed,
      confirmed_display: satoshiToBtc(balance.confirmed),
      unconfirmed: balance.unconfirmed,
      unconfirmed_display: satoshiToBtc(balance.unconfirmed),
      total: balance.total,
      total_display: satoshiToBtc(balance.total),
    };
  },

  async getWalletBalances(tenantId: string, walletId: string): Promise<Record<string, unknown>> {
    const db = getDb();
    const wallet = db.prepare('SELECT * FROM wallets WHERE id = ? AND tenant_id = ?').get(walletId, tenantId);
    if (!wallet) throw new NotFoundError('Wallet', walletId);

    const addresses = db
      .prepare('SELECT * FROM addresses WHERE wallet_id = ? AND status = ?')
      .all(walletId, 'active') as { chain_id: string; address: string }[];

    const chainGroups = new Map<string, string[]>();
    for (const addr of addresses) {
      if (!chainGroups.has(addr.chain_id)) chainGroups.set(addr.chain_id, []);
      chainGroups.get(addr.chain_id)!.push(addr.address);
    }

    const balances: Record<string, Record<string, string>> = {};
    for (const [chain, addrs] of chainGroups.entries()) {
      const adapter = adapterRegistry.get(chain);
      let totalConfirmed = '0';
      let totalUnconfirmed = '0';

      for (const addr of addrs) {
        try {
          const bal = await adapter.getAddressBalance(addr, tenantId);
          totalConfirmed = addSatoshi(totalConfirmed, bal.confirmed);
          totalUnconfirmed = addSatoshi(totalUnconfirmed, bal.unconfirmed);
        } catch {
          // Skip failed addresses.
        }
      }

      const total = addSatoshi(totalConfirmed, totalUnconfirmed);
      balances[chain] = {
        confirmed: totalConfirmed,
        unconfirmed: totalUnconfirmed,
        total,
        confirmed_display: satoshiToBtc(totalConfirmed),
        unconfirmed_display: satoshiToBtc(totalUnconfirmed),
        total_display: satoshiToBtc(total),
      };
    }

    return { walletId, balances };
  },
};
