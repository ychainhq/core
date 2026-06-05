import { BitcoinRpcClient } from './rpc-client';
import {
  IChainAdapter,
  BlockchainInfo,
  Block,
  TransactionStatus,
  AddressBalance,
  Utxo,
  FeeEstimate,
  MempoolAcceptResult,
} from '../types';
import { validateBitcoinAddress } from '../../shared/validation/bitcoin';
import { config } from '../../config/index';
import { logger } from '../../shared/logging/index';
import { ValidationError } from '../../shared/errors/index';
import { estimateTxVsize } from './tx-sizer';

const FALLBACK_FEE_RATE_SAT_VB = 5; // used when Bitcoin Core estimatesmartfee is unavailable
const FEE_RATE_CACHE_TTL_MS = parseInt(process.env['BTC_FEE_RATE_CACHE_TTL_MS'] ?? '30000', 10);

// Convert BTC float to satoshi string (use string math to avoid float issues)
function btcFloatToSatoshi(btcFloat: number): string {
  const btcStr = btcFloat.toFixed(8);
  const [intPart, fracPart = ''] = btcStr.split('.');
  const fracPadded = fracPart.padEnd(8, '0').slice(0, 8);
  return (BigInt(intPart) * BigInt(100_000_000) + BigInt(fracPadded)).toString();
}

/** Returns the Bitcoin Core wallet name for a given tenant. */
export function btcWalletName(tenantId: string): string {
  return `btc_${tenantId}`;
}

export class BitcoinAdapter implements IChainAdapter {
  public readonly chain = 'bitcoin';
  private readonly rpc: BitcoinRpcClient;
  private readonly network: string;
  private readonly feeRateCache = new Map<string, { feeRate: number; expiresAt: number }>();

  constructor() {
    this.rpc = new BitcoinRpcClient();
    this.network = config.BITCOIN_NETWORK;
  }

  async getBlockchainInfo(): Promise<BlockchainInfo> {
    const info = await this.rpc.getBlockchainInfo();
    return {
      chain: info.chain,
      blocks: info.blocks,
      bestBlockHash: info.bestblockhash,
      difficulty: info.difficulty,
      medianTime: info.mediantime,
      verificationProgress: info.verificationprogress,
      initialBlockDownload: info.initialblockdownload,
      chainWork: info.chainwork,
    };
  }

  async getBlockCount(): Promise<number> {
    return this.rpc.getBlockCount();
  }

  async getBlockHash(height: number): Promise<string> {
    return this.rpc.getBlockHash(height);
  }

  async getBlock(hashOrHeight: string | number): Promise<Block> {
    const raw = await this.rpc.getBlock(hashOrHeight, 1);
    return {
      hash: raw.hash,
      height: raw.height,
      time: raw.time,
      medianTime: raw.mediantime,
      nTx: raw.nTx,
      tx: raw.tx,
      previousBlockHash: raw.previousblockhash,
      nextBlockHash: raw.nextblockhash,
      confirmations: raw.confirmations,
      size: raw.size,
      weight: raw.weight,
      version: raw.version,
      difficulty: raw.difficulty,
    };
  }

  async getRawTransaction(txHash: string, verbose = true): Promise<any> {
    return this.rpc.getRawTransaction(txHash, verbose);
  }

  async getRawMempool(): Promise<string[]> {
    return this.rpc.getRawMempool();
  }

  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    try {
      const tx = await this.rpc.getRawTransaction(txHash, true);
      const blockHeight = tx.blockheight ?? null;
      const confirmations = tx.confirmations ?? 0;

      return {
        txHash,
        confirmed: confirmations > 0,
        blockHeight,
        blockHash: tx.blockhash ?? null,
        blockTime: tx.blocktime ?? null,
        confirmations,
        inMempool: confirmations === 0,
      };
    } catch (err: any) {
      if (err?.code === 'TX_NOT_FOUND') {
        try {
          await this.rpc.getMempoolEntry(txHash);
          return {
            txHash,
            confirmed: false,
            blockHeight: null,
            blockHash: null,
            blockTime: null,
            confirmations: 0,
            inMempool: true,
          };
        } catch {
          return {
            txHash,
            confirmed: false,
            blockHeight: null,
            blockHash: null,
            blockTime: null,
            confirmations: 0,
            inMempool: false,
          };
        }
      }
      throw err;
    }
  }

  /**
   * Get address balance using the tenant's watch-only wallet.
   */
  async getAddressBalance(address: string, tenantId: string): Promise<AddressBalance> {
    const walletName = btcWalletName(tenantId);
    const confirmed = await this.rpc.getReceivedByAddress(address, 1, walletName);
    const total = await this.rpc.getReceivedByAddress(address, 0, walletName);
    const unconfirmed = total - confirmed;

    return {
      address,
      confirmed: btcFloatToSatoshi(confirmed),
      unconfirmed: btcFloatToSatoshi(Math.max(0, unconfirmed)),
      total: btcFloatToSatoshi(total),
    };
  }

  /**
   * Get UTXOs for an address using the tenant's watch-only wallet.
   * Requires the address to be imported via importAddressForTenant first.
   */
  async getUtxosForAddress(address: string, minConfirmations = 0, tenantId: string): Promise<Utxo[]> {
    const walletName = btcWalletName(tenantId);
    const unspent = await this.rpc.listUnspent(minConfirmations, 9999999, [address], walletName);
    return unspent.map((u: any) => ({
      txHash: u.txid,
      vout: u.vout,
      address: u.address,
      amount: btcFloatToSatoshi(u.amount),
      scriptPubKey: u.scriptPubKey,
      confirmations: u.confirmations,
      height: u.height ?? null,
    }));
  }

  /**
   * Import a P2WPKH treasury address using wpkh(<pubkey>) descriptor so that
   * Bitcoin Core marks it as solvable. Required for walletcreatefundedpsbt with
   * pre-selected inputs (used by the withdrawal batcher).
   */
  async importSolvableAddressForTenant(pubkeyHex: string, tenantId: string, label = ''): Promise<void> {
    const walletName = btcWalletName(tenantId);
    await this.rpc.importDescriptors(
      [{ desc: `wpkh(${pubkeyHex})`, timestamp: 'now', label }],
      walletName
    );
    logger.info('Solvable address imported into tenant wallet', { tenantId, walletName, label });
  }

  async estimateSmartFee(targetBlocks: number): Promise<FeeEstimate> {
    const result = await this.rpc.estimateSmartFee(targetBlocks, 'CONSERVATIVE');
    const btcPerKb = result.feerate ?? 0.00001;
    const satPerVbyte = Math.ceil((btcPerKb * 100_000_000) / 1000);

    return {
      targetBlocks,
      feeRate: satPerVbyte,
      mode: 'conservative',
    };
  }

  /**
   * Estimate fee rate in sat/vbyte with caching, fallback, and optional min/max clamping.
   *
   * Cache key includes targetBlocks + clamp params so different callers with different
   * policies don't share a stale cached value.
   *
   * - maxSatVb: tenant ceiling — never pay more than this (e.g. btc_max_fee_rate_sat_vb)
   * - minSatVb: tenant floor — never pay less than this (e.g. btc_min_fee_rate_sat_vb)
   * - fallbackSatVb: used when Bitcoin Core is unreachable (default: FALLBACK_FEE_RATE_SAT_VB)
   */
  async estimateFeeRateSatVb(params: {
    targetBlocks: number;
    maxSatVb?: number;
    minSatVb?: number | null;
    fallbackSatVb?: number;
  }): Promise<number> {
    const { targetBlocks, maxSatVb, minSatVb, fallbackSatVb = FALLBACK_FEE_RATE_SAT_VB } = params;
    const cacheKey = `${targetBlocks}:${maxSatVb ?? ''}:${minSatVb ?? ''}`;

    const cached = this.feeRateCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.feeRate;
    }

    let feeRate = fallbackSatVb;
    try {
      const est = await this.estimateSmartFee(targetBlocks);
      feeRate = est.feeRate;
    } catch {
      logger.warn('BitcoinAdapter: fee estimation failed, using fallback', { targetBlocks, fallbackSatVb });
    }

    if (maxSatVb !== undefined) feeRate = Math.min(feeRate, maxSatVb);
    if (minSatVb != null)       feeRate = Math.max(feeRate, minSatVb);

    this.feeRateCache.set(cacheKey, { feeRate, expiresAt: Date.now() + FEE_RATE_CACHE_TTL_MS });
    return feeRate;
  }

  async testMempoolAccept(rawTx: string): Promise<MempoolAcceptResult> {
    const results = await this.rpc.testMempoolAccept([rawTx]);
    const result = results[0];
    return {
      txid: result.txid,
      allowed: result.allowed,
      rejectReason: result['reject-reason'],
      vsize: result.vsize,
      fees: result.fees ? { base: result.fees.base } : undefined,
    };
  }

  async sendRawTransaction(rawTx: string): Promise<string> {
    return this.rpc.sendRawTransaction(rawTx);
  }

  async decodeRawTransaction(rawTx: string): Promise<any> {
    return this.rpc.decodeRawTransaction(rawTx);
  }

  async decodePsbt(psbt: string): Promise<any> {
    return this.rpc.decodePsbt(psbt);
  }

  /**
   * @deprecated Use createUnsignedPsbt + external signing instead for better security and wallet compatibility.
   * @param inputs 
   * @param outputs 
   * @param options 
   * @param tenantId 
   * @returns 
   */
  async walletCreateFundedPsbt(inputs: any[], outputs: any[], options?: any, tenantId?: string): Promise<any> {
    return this.rpc.walletCreateFundedPsbt(
      inputs,
      outputs,
      0,
      options || {},
      false,
      tenantId ? btcWalletName(tenantId) : undefined,
    );
  }

  async finalizePsbt(psbt: string): Promise<any> {
    return this.rpc.finalizePsbt(psbt);
  }

  /**
   * Build an unsigned PSBT without wallet involvement.
   * Uses createpsbt (no solvability requirement) then utxoupdatepsbt to fill
   * in witness_utxo fields from the global UTXO set — required so the external
   * signer can compute the segwit sighash for each input.
   */
  async createUnsignedPsbt(
    inputs: Array<{ txid: string; vout: number; sequence?: number }>,
    outputs: Array<Record<string, number>>,
  ): Promise<string> {
    const psbt = await this.rpc.createPsbt(inputs, outputs);
    return this.rpc.utxoUpdatePsbt(psbt);
  }

  /**
   * Build an unsigned withdrawal PSBT without any Bitcoin Core wallet.
   * Stateless replacement for walletCreateFundedPsbt in the withdrawal path.
   *
   * Computes vsize from actual address types, derives fee and change, then calls
   * createpsbt + utxoupdatepsbt (network-level RPCs — no named wallet required).
   *
   * Throws ValidationError if the locked UTXOs are insufficient to cover outputs + fee.
   */
  async buildWithdrawalPsbt(params: {
    inputs: Array<{ txid: string; vout: number; amountSats: bigint }>;
    recipientOutputs: Array<{ address: string; amountSats: bigint }>;
    changeAddress: string;
    feeRateSatVb: number;
    rbf: boolean;
  }): Promise<{ psbt: string; feeSats: bigint }> {
    const { inputs, recipientOutputs, changeAddress, feeRateSatVb, rbf } = params;

    const totalInputSats = inputs.reduce((s, i) => s + i.amountSats, 0n);
    const totalOutputSats = recipientOutputs.reduce((s, o) => s + o.amountSats, 0n);

    // Estimate vsize assuming a change output will be present
    const vsizeWithChange = estimateTxVsize({
      inputCount: inputs.length,
      outputs: [
        ...recipientOutputs.map(o => ({ address: o.address })),
        { address: changeAddress },
      ],
    });

    const feeWithChangeSats = BigInt(Math.ceil(vsizeWithChange * feeRateSatVb));
    const changeSats = totalInputSats - totalOutputSats - feeWithChangeSats;

    if (changeSats < 0n) {
      throw new ValidationError(
        `Insufficient UTXOs: need ${totalOutputSats + feeWithChangeSats} sats, locked ${totalInputSats} sats`,
      );
    }

    // Drop change if it would be dust (< 546 sats); remainder goes to miners as extra fee
    const DUST_THRESHOLD = 546n;
    const includeChange = changeSats >= DUST_THRESHOLD;
    const actualFeeSats = includeChange
      ? feeWithChangeSats
      : totalInputSats - totalOutputSats;

    const psbtOutputs: Record<string, number>[] = [
      ...recipientOutputs.map(o => ({ [o.address]: Number(o.amountSats) / 1e8 })),
      ...(includeChange ? [{ [changeAddress]: Number(changeSats) / 1e8 }] : []),
    ];

    const psbtInputs = inputs.map(i => ({
      txid: i.txid,
      vout: i.vout,
      // opt-in RBF per BIP 125: sequence <= 0xFFFFFFFD
      ...(rbf ? { sequence: 0xFFFFFFFD } : {}),
    }));

    const psbt = await this.createUnsignedPsbt(psbtInputs, psbtOutputs);
    return { psbt, feeSats: actualFeeSats };
  }

  isValidAddress(address: string): boolean {
    return validateBitcoinAddress(address, this.network);
  }
}
