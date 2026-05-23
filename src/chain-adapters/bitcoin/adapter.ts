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

  constructor() {
    this.rpc = new BitcoinRpcClient();
    this.network = config.BITCOIN_NETWORK;
  }

  /**
   * Provision a watch-only Bitcoin Core wallet for a tenant.
   * Called once when a tenant is created. Idempotent: loads existing wallet if already present.
   */
  async provisionTenantWallet(tenantId: string): Promise<void> {
    const walletName = btcWalletName(tenantId);
    try {
      await this.rpc.createWatchOnlyWallet(walletName);
      logger.info('Bitcoin Core watch-only wallet created', { tenantId, walletName });
    } catch (err: any) {
      // -4 = wallet already exists on disk; load it instead
      if (err?.message?.includes('-4') || err?.message?.includes('already exists')) {
        try {
          await this.rpc.loadWallet(walletName);
          logger.info('Bitcoin Core wallet loaded (already existed)', { tenantId, walletName });
        } catch (loadErr: any) {
          // -35 = wallet already loaded — that's fine
          if (!loadErr?.message?.includes('-35') && !loadErr?.message?.includes('already loaded')) {
            throw loadErr;
          }
          logger.debug('Bitcoin Core wallet already loaded', { tenantId, walletName });
        }
      } else {
        throw err;
      }
    }
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
   * Get all UTXOs known to a tenant's watch-only wallet.
   * This is the high-throughput path for workers: one RPC per tenant instead
   * of one RPC per watched address.
   */
  async getWalletUtxos(tenantId: string, minConfirmations = 0): Promise<Utxo[]> {
    const walletName = btcWalletName(tenantId);
    const unspent = await this.rpc.listUnspent(minConfirmations, 9999999, [], walletName);
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
   * Import a new address into the tenant's watch-only wallet.
   * timestamp='now' means no historical rescan — BTC Core tracks from current block forward.
   * Use this when the address is freshly derived and cannot have prior history.
   */
  async importAddressForTenant(address: string, tenantId: string, label = ''): Promise<void> {
    const walletName = btcWalletName(tenantId);
    await this.rpc.importDescriptors(
      [{ desc: `addr(${address})`, timestamp: 'now', label }],
      walletName
    );
    logger.info('Address imported into tenant wallet', { tenantId, walletName, address });
  }

  /**
   * Import an existing address with a specific scan start timestamp (Unix seconds).
   * BTC Core rescans blocks from that time forward — used on startup reconciliation
   * to recover addresses after a wallet reset.
   */
  async importAddressWithTimestamp(address: string, tenantId: string, label: string, timestampSec: number): Promise<void> {
    const walletName = btcWalletName(tenantId);
    await this.rpc.importDescriptors(
      [{ desc: `addr(${address})`, timestamp: timestampSec, label }],
      walletName
    );
    logger.info('Address reimported with timestamp', { tenantId, walletName, address, timestampSec });
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

  isValidAddress(address: string): boolean {
    return validateBitcoinAddress(address, this.network);
  }
}
