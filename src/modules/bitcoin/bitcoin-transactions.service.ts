import crypto from 'crypto';
import { adapterRegistry } from '../../chain-adapters/registry';
import { getDbClient } from '../../db/client';
import { ValidationError, UnprocessableEntityError, NotFoundError } from '../../shared/errors/index';
import { satoshiToBtc, addSatoshi, formatAssetDisplay } from '../../shared/money/index';
import { tronBalancesService } from '../tron/tron-balances.service';
import { TronAdapter } from '../../chain-adapters/tron/adapter';
import { config } from '../../config/index';
import { validateRawTransaction, validatePsbt } from '../../shared/validation/bitcoin';
import { transactionsService } from '../transactions/transactions.service';
import { webhooksService } from '../webhooks/webhooks.service';
import { utxoLockService } from '../../shared/utxo-lock/utxo-lock.service';
import { estimateTxVsize } from '../../chain-adapters/bitcoin/tx-sizer';

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

    const estimatedSize = estimateTxVsize({
      inputCount: selected.length,
      outputs: [
        ...input.outputs.map(o => ({ address: o.address })),
        { address: input.changeAddress },
      ],
    });
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

    const db = getDbClient();
    const txId = `tx_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    await db.run(`
      INSERT INTO transactions (id, chain_id, tx_hash, psbt, status, fee_raw, fee_rate, wallet_id, metadata, created_at, updated_at)
      VALUES (?, 'bitcoin', NULL, ?, 'prepared', ?, ?, ?, ?, ?, ?)
    `, [
      txId,
      psbtResult?.psbt ?? null,
      coinSel.estimatedFee,
      feeRate.toString(),
      input.walletId ?? null,
      JSON.stringify({ tenantId, fromAddresses: input.fromAddresses }),
      now,
      now
    ]);

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
    const tx = await transactionsService.upsertByHash(chain, txHash, {
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
      transactionsService.getByTxHash(chain, txHash),
    ]);
    return { ...(rawTx as Record<string, unknown>), local: localTx ?? null };
  },

  async getTransactionStatus(chain: string, txHash: string): Promise<Record<string, unknown>> {
    const adapter = adapterRegistry.get(chain);
    const status = await adapter.getTransactionStatus(txHash);
    const localTx = await transactionsService.getByTxHash(chain, txHash);
    return { ...((status as unknown) as Record<string, unknown>), localStatus: localTx?.status ?? null };
  },

  async getAddressUtxos(tenantId: string, address: string, minConfirmations = 0): Promise<unknown[]> {
    const adapter = adapterRegistry.get('bitcoin');
    const utxos = await adapter.getUtxosForAddress(address, minConfirmations, tenantId);
    return utxos.map((u) => ({ ...u, amount_display: satoshiToBtc(u.amount) }));
  },

  async getWalletUtxos(tenantId: string, walletId: string, minConfirmations = 0): Promise<unknown[]> {
    const db = getDbClient();
    const wallet = await db.get('SELECT * FROM wallets WHERE id = ? AND tenant_id = ?', [walletId, tenantId]);
    if (!wallet) throw new NotFoundError('Wallet', walletId);

    const addresses = await db.all<{ address: string }>(
      "SELECT address FROM addresses WHERE wallet_id = ? AND chain_id = 'bitcoin' AND status = 'active'",
      [walletId]
    );

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
    if (chain === 'tron') {
      if (!asset || asset === 'tron:TRX' || asset === 'TRX') {
        const bal = await adapterRegistry.get('tron').getAddressBalance(address, tenantId);
        return {
          address, chain,
          asset:               'tron:TRX',
          confirmed:           bal.confirmed,
          confirmed_display:   formatAssetDisplay(bal.confirmed, 6, 'TRX'),
          unconfirmed:         bal.unconfirmed,
          unconfirmed_display: formatAssetDisplay(bal.unconfirmed, 6, 'TRX'),
          total:               bal.total,
          total_display:       formatAssetDisplay(bal.total, 6, 'TRX'),
        };
      }
      if (asset === 'tron:USDT' || asset === 'USDT') {
        const contractAddress = config.TRON_USDT_CONTRACT_ADDRESS ?? '';
        const tronAdapter = adapterRegistry.get('tron') as TronAdapter;
        const total = await tronAdapter.getTrc20Balance(address, contractAddress);
        return {
          address, chain,
          asset:               'tron:USDT',
          confirmed:           total,
          confirmed_display:   formatAssetDisplay(total, 6, 'USDT'),
          unconfirmed:         '0',
          unconfirmed_display: formatAssetDisplay('0', 6, 'USDT'),
          total,
          total_display:       formatAssetDisplay(total, 6, 'USDT'),
        };
      }
    }
    const bal = await utxoLockService.getAddressBalance(tenantId, chain, address);
    return {
      address,
      chain,
      asset: asset ?? 'bitcoin:BTC',
      confirmed:           bal.confirmed,
      confirmed_display:   formatAssetDisplay(bal.confirmed, 8, 'BTC'),
      unconfirmed:         bal.unconfirmed,
      unconfirmed_display: formatAssetDisplay(bal.unconfirmed, 8, 'BTC'),
      total:               bal.total,
      total_display:       formatAssetDisplay(bal.total, 8, 'BTC'),
    };
  },

  async getWalletBalances(tenantId: string, walletId: string): Promise<Record<string, unknown>> {
    const db = getDbClient();
    const wallet = await db.get('SELECT id FROM wallets WHERE id = ? AND tenant_id = ?', [walletId, tenantId]);
    if (!wallet) throw new NotFoundError('Wallet', walletId);

    const chainIds = await db.all<{ chain_id: string }>(
      'SELECT DISTINCT chain_id FROM addresses WHERE wallet_id = ? AND status = ?', [walletId, 'active'],
    );

    const balances: Record<string, Record<string, unknown>> = {};

    for (const { chain_id } of chainIds) {
      if (chain_id === 'bitcoin') {
        const chainBalances = await utxoLockService.getWalletBalances(walletId);
        const b = chainBalances['bitcoin'] ?? { confirmed: '0', unconfirmed: '0', total: '0' };
        balances['bitcoin:BTC'] = {
          confirmed:           b.confirmed,
          unconfirmed:         b.unconfirmed,
          total:               b.total,
          confirmed_display:   formatAssetDisplay(b.confirmed, 8, 'BTC'),
          unconfirmed_display: formatAssetDisplay(b.unconfirmed, 8, 'BTC'),
          total_display:       formatAssetDisplay(b.total, 8, 'BTC'),
        };
      } else if (chain_id === 'tron') {
        const tron = await tronBalancesService.getWalletBalances(walletId);
        balances['tron:TRX'] = {
          confirmed:           tron.trxSun,
          unconfirmed:         '0',
          total:               tron.trxSun,
          confirmed_display:   formatAssetDisplay(tron.trxSun, 6, 'TRX'),
          unconfirmed_display: formatAssetDisplay('0', 6, 'TRX'),
          total_display:       formatAssetDisplay(tron.trxSun, 6, 'TRX'),
          stale:               tron.stale,
          cache_updated_at:    tron.cacheUpdatedAt,
        };
        balances['tron:USDT'] = {
          confirmed:           tron.usdtSun,
          unconfirmed:         '0',
          total:               tron.usdtSun,
          confirmed_display:   formatAssetDisplay(tron.usdtSun, 6, 'USDT'),
          unconfirmed_display: formatAssetDisplay('0', 6, 'USDT'),
          total_display:       formatAssetDisplay(tron.usdtSun, 6, 'USDT'),
          stale:               tron.stale,
          cache_updated_at:    tron.cacheUpdatedAt,
        };
      }
    }

    return { walletId, balances };
  },
};
