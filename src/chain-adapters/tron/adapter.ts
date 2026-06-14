import crypto from 'crypto';
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
import { ApiError } from '../../shared/errors/index';
import { TronRpcClient, TronUnsignedTransaction } from './rpc-client';
import { NodeSelector } from '../node-selector';
import { TronFeeEstimate } from './tron-types';
import { tronFeeService } from '../../modules/tron/tron-fee.service';

export interface TronUnsignedWithdrawalTx {
  unsignedPayload: string;
  txID: string;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export class TronAdapter implements IChainAdapter {
  public readonly chain = 'tron';
  private readonly rpc: TronRpcClient;

  constructor(nodeSelector: NodeSelector) {
    this.rpc = new TronRpcClient(nodeSelector);
  }

  async getBlockchainInfo(): Promise<BlockchainInfo> {
    const block = await this.rpc.getNowBlock();
    return {
      chain: 'tron',
      blocks: block.block_header.raw_data.number,
      bestBlockHash: block.blockID,
      difficulty: 0,
      medianTime: Math.floor(block.block_header.raw_data.timestamp / 1000),
      verificationProgress: 1,
      initialBlockDownload: false,
      chainWork: '0',
    };
  }

  async getBlockCount(): Promise<number> {
    const block = await this.rpc.getNowBlock();
    return block.block_header.raw_data.number;
  }

  async getBlockHash(height: number): Promise<string> {
    const block = await this.rpc.getBlockByNumber(height);
    return block.blockID;
  }

  async getBlock(hashOrHeight: string | number): Promise<Block> {
    if (typeof hashOrHeight !== 'number') {
      const n = parseInt(hashOrHeight, 10);
      if (Number.isNaN(n)) {
        throw new ApiError(400, 'UNSUPPORTED_OPERATION', 'TRON block lookup by hash is not supported by this adapter');
      }
      hashOrHeight = n;
    }

    const block = await this.rpc.getBlockByNumber(hashOrHeight);
    const height = block.block_header.raw_data.number;
    return {
      hash: block.blockID,
      height,
      time: Math.floor(block.block_header.raw_data.timestamp / 1000),
      medianTime: Math.floor(block.block_header.raw_data.timestamp / 1000),
      nTx: block.transactions?.length ?? 0,
      tx: (block.transactions ?? []).map((tx) => tx.txID),
      previousBlockHash: block.block_header.raw_data.parentHash,
      confirmations: 1,
      size: 0,
      weight: 0,
      version: 0,
      difficulty: 0,
    };
  }

  async getRawTransaction(txHash: string): Promise<any> {
    return this.rpc.getTransactionInfo(txHash);
  }

  async getRawMempool(): Promise<string[]> {
    return [];
  }

  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    const info = await this.rpc.getTransactionInfo(txHash);
    if (Object.keys(info).length === 0 || !('blockNumber' in info) || info.blockNumber === undefined) {
      return { txHash, confirmed: false, blockHeight: null, blockHash: null, blockTime: null, confirmations: 0, inMempool: false };
    }

    const tip = await this.getBlockCount();
    const confirmations = Math.max(0, tip - info.blockNumber + 1);
    return {
      txHash,
      confirmed: info.receipt?.result === 'SUCCESS',
      blockHeight: info.blockNumber,
      blockHash: info.blockHash ?? null,
      blockTime: info.blockTimeStamp ? Math.floor(info.blockTimeStamp / 1000) : null,
      confirmations,
      inMempool: false,
    };
  }

  async getAddressBalance(address: string, _tenantId: string): Promise<AddressBalance> {
    const account = await this.rpc.getAccount(address);
    const total = BigInt(account.balance ?? 0).toString();
    return { address, confirmed: total, unconfirmed: '0', total };
  }

  async getTrc20Balance(address: string, contractAddress: string): Promise<string> {
    return this.rpc.getTrc20Balance(address, contractAddress);
  }

  getUtxosForAddress(_address: string, _minConfirmations: number, _tenantId: string): Promise<Utxo[]> {
    return Promise.resolve([]);
  }

  estimateSmartFee(targetBlocks: number): Promise<FeeEstimate> {
    // TRON does not use a fee-rate model — costs depend on bandwidth/energy resources.
    // Use estimateTronFee() for accurate per-tx estimation.
    return Promise.resolve({ targetBlocks, feeRate: 0, mode: 'resource_model' });
  }

  /**
   * Estimate TRON fee for a specific transaction.
   * Delegates to tronFeeService which owns cache and computation logic.
   */
  estimateTronFee(params: {
    fromAddress: string;
    assetId: 'tron:TRX' | 'tron:USDT';
    toAddress: string;
    amountRaw: string;
    contractAddress?: string;
  }): Promise<TronFeeEstimate> {
    return tronFeeService.estimateFeeForAddress(params);
  }

  testMempoolAccept(rawTx: string): Promise<MempoolAcceptResult> {
    return Promise.resolve({ txid: hashPayload(rawTx), allowed: true });
  }

  async sendRawTransaction(rawTx: string): Promise<string> {
    const payload = JSON.parse(rawTx);
    const result = await this.rpc.broadcastTransaction(payload);
    if (!result.result) {
      throw new ApiError(400, 'BROADCAST_REJECTED', result.message ?? result.code ?? 'TRON transaction rejected');
    }
    return result.txid ?? hashPayload(rawTx);
  }

  decodeRawTransaction(rawTx: string): Promise<any> {
    return Promise.resolve(JSON.parse(rawTx));
  }

  decodePsbt(_psbt: string): Promise<any> {
    throw new ApiError(400, 'UNSUPPORTED_OPERATION', 'PSBT not applicable to TRON');
  }

  walletCreateFundedPsbt(): Promise<any> {
    throw new ApiError(400, 'UNSUPPORTED_OPERATION', 'walletCreateFundedPsbt not applicable to TRON');
  }

  finalizePsbt(_psbt: string): Promise<any> {
    throw new ApiError(400, 'UNSUPPORTED_OPERATION', 'finalizePsbt not applicable to TRON');
  }

  isValidAddress(address: string): boolean {
    return isValidTronAddress(address);
  }

  /**
   * Build an unsigned TRON withdrawal transaction.
   * For TRC-20 tokens (assetId = 'tron:USDT'): calls triggersmartcontract.
   * For native TRX (assetId = 'tron:TRX'): calls createtransaction.
   * Returns `{ unsignedPayload: raw_data_hex, txID }` for the external signer.
   */
  async buildUnsignedWithdrawalTx(params: {
    fromAddress: string;
    toAddress: string;
    assetId: string;
    amountRaw: string;
    feeLimitSun: number;
    contractAddress?: string;
  }): Promise<TronUnsignedWithdrawalTx> {
    const { fromAddress, toAddress, assetId, amountRaw, feeLimitSun, contractAddress } = params;

    let tx: TronUnsignedTransaction;

    if (assetId === 'tron:TRX') {
      tx = await this.rpc.createUnsignedTrxTransfer({
        fromAddress,
        toAddress,
        amountSun: amountRaw,
      });
    } else {
      // TRC-20 (e.g. tron:USDT)
      if (!contractAddress) {
        throw new ApiError(400, 'MISSING_CONTRACT_ADDRESS', `Contract address required for asset ${assetId}`);
      }
      tx = await this.rpc.createUnsignedTrc20Transfer({
        fromAddress,
        toAddress,
        contractAddress,
        amountSun: amountRaw,
        feeLimitSun,
      });
    }

    return {
      unsignedPayload: tx.raw_data_hex,
      txID: tx.txID,
    };
  }
}

function hashPayload(payload: string): string {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function isValidTronAddress(address: string): boolean {
  try {
    const decoded = base58Decode(address);
    if (decoded.length !== 25) return false;
    const payload = decoded.subarray(0, 21);
    const checksum = decoded.subarray(21);
    if (payload[0] !== 0x41) return false;
    const expected = sha256(sha256(payload)).subarray(0, 4);
    return checksum.equals(expected);
  } catch {
    return false;
  }
}

function base58Decode(value: string): Buffer {
  let num = 0n;
  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('invalid base58');
    num = num * 58n + BigInt(index);
  }

  let hex = num.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let buf = Buffer.from(hex, 'hex');

  let leadingZeroes = 0;
  for (const char of value) {
    if (char === BASE58_ALPHABET[0]) leadingZeroes += 1;
    else break;
  }
  if (leadingZeroes > 0) {
    buf = Buffer.concat([Buffer.alloc(leadingZeroes), buf]);
  }

  return buf;
}

function sha256(buf: Buffer): Buffer {
  return crypto.createHash('sha256').update(buf).digest();
}
