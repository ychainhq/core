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
  // Round to 8 decimal places and convert to satoshi
  const btcStr = btcFloat.toFixed(8);
  const [intPart, fracPart = ''] = btcStr.split('.');
  const fracPadded = fracPart.padEnd(8, '0').slice(0, 8);
  return (BigInt(intPart) * BigInt(100_000_000) + BigInt(fracPadded)).toString();
}

export class BitcoinAdapter implements IChainAdapter {
  public readonly chain = 'bitcoin';
  private readonly rpc: BitcoinRpcClient;
  private readonly network: string;

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
      const blockCount = tx.blockhash ? await this.rpc.getBlockCount() : 0;
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
        // Check if it's in the mempool
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
   * Get address balance.
   *
   * Strategy:
   * 1. If a watch-only wallet is configured, use getreceivedbyaddress (fast).
   * 2. Otherwise, use scantxoutset (slow, blocking — for production use electrs/mempool.space).
   *
   * NOTE: scantxoutset is a heavy blocking operation. In production environments,
   * use an external indexer (electrs, mempool.space API) or a watch-only wallet
   * with proper address import for much better performance.
   */
  async getAddressBalance(address: string): Promise<AddressBalance> {
    if (config.BITCOIN_RPC_WALLET) {
      // Watch-only wallet path — fast
      try {
        const confirmed = await this.rpc.getReceivedByAddress(address, 1);
        const total = await this.rpc.getReceivedByAddress(address, 0);
        const unconfirmed = total - confirmed;

        return {
          address,
          confirmed: btcFloatToSatoshi(confirmed),
          unconfirmed: btcFloatToSatoshi(Math.max(0, unconfirmed)),
          total: btcFloatToSatoshi(total),
        };
      } catch (err) {
        logger.warn('Failed to get balance via wallet, falling back to scantxoutset', { address });
      }
    }

    // Fallback: scantxoutset (slow, blocking)
    // WARNING: This is a heavy operation. Use only if no watch-only wallet is available.
    logger.warn('Using scantxoutset for address balance — this is slow. Configure BITCOIN_RPC_WALLET for production.', { address });
    const descriptor = `addr(${address})`;
    const result = await this.rpc.scanTxOutSet(descriptor);

    const confirmedSat = result.unspents
      ? result.unspents.reduce((sum: bigint, utxo: any) => sum + BigInt(btcFloatToSatoshi(utxo.amount)), BigInt(0))
      : BigInt(0);

    return {
      address,
      confirmed: confirmedSat.toString(),
      unconfirmed: '0',
      total: confirmedSat.toString(),
    };
  }

  /**
   * Get UTXOs for an address.
   *
   * Strategy:
   * 1. If watch-only wallet configured: use listunspent (fast).
   * 2. Otherwise: use scantxoutset (slow, blocking).
   *
   * NOTE: Same caveat as getAddressBalance — prefer watch-only wallet or external indexer.
   */
  async getUtxosForAddress(address: string, minConfirmations = 0): Promise<Utxo[]> {
    if (config.BITCOIN_RPC_WALLET) {
      // Watch-only wallet path
      try {
        const unspent = await this.rpc.listUnspent(minConfirmations, 9999999, [address]);
        return unspent.map((u: any) => ({
          txHash: u.txid,
          vout: u.vout,
          address: u.address,
          amount: btcFloatToSatoshi(u.amount),
          scriptPubKey: u.scriptPubKey,
          confirmations: u.confirmations,
          height: u.height ?? null,
        }));
      } catch (err) {
        logger.warn('Failed to list UTXOs via wallet, falling back to scantxoutset', { address });
      }
    }

    // Fallback: scantxoutset
    // WARNING: Heavy blocking operation. Use watch-only wallet or external indexer in production.
    logger.warn('Using scantxoutset for UTXOs — this is slow. Configure BITCOIN_RPC_WALLET for production.', { address });
    const descriptor = `addr(${address})`;
    const result = await this.rpc.scanTxOutSet(descriptor);

    if (!result.unspents) return [];

    return result.unspents
      .filter((u: any) => u.confirmations >= minConfirmations)
      .map((u: any) => ({
        txHash: u.txid,
        vout: u.vout,
        address: u.desc?.includes(address) ? address : u.address || address,
        amount: btcFloatToSatoshi(u.amount),
        scriptPubKey: u.scriptPubKey || '',
        confirmations: u.confirmations ?? 0,
        height: u.height ?? null,
      }));
  }

  async estimateSmartFee(targetBlocks: number): Promise<FeeEstimate> {
    const result = await this.rpc.estimateSmartFee(targetBlocks, 'CONSERVATIVE');
    // feerate is in BTC/kB, convert to sat/vbyte
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

  async walletCreateFundedPsbt(inputs: any[], outputs: any[], options?: any): Promise<any> {
    return this.rpc.walletCreateFundedPsbt(inputs, outputs, 0, options || {});
  }

  async finalizePsbt(psbt: string): Promise<any> {
    return this.rpc.finalizePsbt(psbt);
  }

  isValidAddress(address: string): boolean {
    return validateBitcoinAddress(address, this.network);
  }
}
