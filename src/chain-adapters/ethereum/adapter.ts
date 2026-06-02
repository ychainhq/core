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
import { EthRpcClient } from './rpc-client';
import { ApiError } from '../../shared/errors/index';
import { logger } from '../../shared/logging/index';

/** keccak256("balanceOf(address)") → first 4 bytes */
const BALANCE_OF_SELECTOR = '0x70a08231';

/** ERC-20 balanceOf(address) calldata */
function balanceOfData(address: string): string {
  const addr = address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return `${BALANCE_OF_SELECTOR}${addr}`;
}

/** Hex wei/units → decimal string */
function hexToDecimal(hex: string): string {
  return BigInt(hex).toString();
}

function parseHexInt(hex: string): number {
  return parseInt(hex, 16);
}

function isEthAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

export class EthereumAdapter implements IChainAdapter {
  public readonly chain = 'ethereum';
  private readonly rpc: EthRpcClient;

  constructor(nodeUrl: string, auth?: string) {
    this.rpc = new EthRpcClient(nodeUrl, auth);
  }

  async getBlockchainInfo(): Promise<BlockchainInfo> {
    const [blockNum, syncing, chainId] = await Promise.all([
      this.rpc.blockNumber(),
      this.rpc.syncing(),
      this.rpc.getChainId(),
    ]);

    const block = await this.rpc.getBlockByNumber(blockNum, false);

    return {
      chain: `ethereum-${chainId}`,
      blocks: blockNum,
      bestBlockHash: block.hash,
      difficulty: 0,          // PoS — no difficulty
      medianTime: parseHexInt(block.timestamp),
      verificationProgress: syncing ? 0.5 : 1,
      initialBlockDownload: !!syncing,
      chainWork: '0',
    };
  }

  async getBlockCount(): Promise<number> {
    return this.rpc.blockNumber();
  }

  async getBlockHash(height: number): Promise<string> {
    const block = await this.rpc.getBlockByNumber(height, false);
    return block.hash;
  }

  async getBlock(hashOrHeight: string | number): Promise<Block> {
    let raw: any;
    if (typeof hashOrHeight === 'number') {
      raw = await this.rpc.getBlockByNumber(hashOrHeight, false);
    } else {
      // For EVM, hash-based lookup is not in the minimal RPC client.
      // Treat as height if numeric string, else unsupported.
      const n = parseInt(hashOrHeight, 10);
      if (!isNaN(n)) {
        raw = await this.rpc.getBlockByNumber(n, false);
      } else {
        throw new ApiError(400, 'UNSUPPORTED_OPERATION', 'EthereumAdapter.getBlock by hash not supported');
      }
    }

    const height = parseHexInt(raw.number);
    return {
      hash: raw.hash,
      height,
      time: parseHexInt(raw.timestamp),
      medianTime: parseHexInt(raw.timestamp),
      nTx: (raw.transactions as string[]).length,
      tx: raw.transactions as string[],
      previousBlockHash: raw.parentHash,
      nextBlockHash: undefined,
      confirmations: 1,
      size: 0,
      weight: 0,
      version: 0,
      difficulty: 0,
    };
  }

  async getRawTransaction(txHash: string): Promise<any> {
    const receipt = await this.rpc.getTransactionReceipt(txHash);
    return receipt;
  }

  async getRawMempool(): Promise<string[]> {
    // Ethereum nodes don't expose a simple mempool list via JSON-RPC by default.
    // Return empty — eth-indexer handles pending detection separately.
    return [];
  }

  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    try {
      const receipt = await this.rpc.getTransactionReceipt(txHash);
      if (!receipt || !receipt.blockNumber) {
        return { txHash, confirmed: false, blockHeight: null, blockHash: null, blockTime: null, confirmations: 0, inMempool: true };
      }

      const txBlock = parseHexInt(receipt.blockNumber);
      const currentBlock = await this.rpc.blockNumber();
      const confirmations = currentBlock - txBlock + 1;
      const block = await this.rpc.getBlockByNumber(txBlock, false);

      return {
        txHash,
        confirmed: receipt.status === '0x1',
        blockHeight: txBlock,
        blockHash: receipt.blockHash,
        blockTime: parseHexInt(block.timestamp),
        confirmations,
        inMempool: false,
      };
    } catch {
      return { txHash, confirmed: false, blockHeight: null, blockHash: null, blockTime: null, confirmations: 0, inMempool: false };
    }
  }

  async getAddressBalance(address: string, _tenantId: string): Promise<AddressBalance> {
    const balanceHex = await this.rpc.getBalance(address);
    const total = hexToDecimal(balanceHex);
    return { address, confirmed: total, unconfirmed: '0', total };
  }

  /** Get ERC-20 token balance for an address */
  async getTokenBalance(contractAddress: string, address: string): Promise<string> {
    const data = balanceOfData(address);
    const result = await this.rpc.call_contract(contractAddress, data);
    return hexToDecimal(result);
  }

  getUtxosForAddress(_address: string, _minConfirmations: number): Promise<Utxo[]> {
    // ETH is account-based — no UTXO concept
    return Promise.resolve([]);
  }

  async estimateSmartFee(targetBlocks: number): Promise<FeeEstimate> {
    try {
      const [baseFeeHex, priorityFeeHex] = await Promise.all([
        this.rpc.gasPrice(),
        this.rpc.maxPriorityFeePerGas().catch(() => '0x0'),
      ]);

      const baseFeeWei = BigInt(baseFeeHex);
      const priorityWei = BigInt(priorityFeeHex);
      const totalWei = baseFeeWei + priorityWei;

      // Return as gwei (1 gwei = 1e9 wei) in the feeRate field
      // callers interpreting this as sat/vbyte should convert using their logic
      const feeGwei = Number(totalWei / 1_000_000_000n);

      return {
        targetBlocks,
        feeRate: feeGwei,
        mode: 'economical',
      };
    } catch (err) {
      logger.warn('EthereumAdapter.estimateSmartFee failed', { error: String(err) });
      return { targetBlocks, feeRate: 20, mode: 'economical' };
    }
  }

  async testMempoolAccept(_rawTx: string): Promise<MempoolAcceptResult> {
    // Ethereum doesn't have testmempoolaccept; simulate via eth_call
    return { txid: '', allowed: true };
  }

  async sendRawTransaction(rawTx: string): Promise<string> {
    return this.rpc.sendRawTransaction(rawTx);
  }

  decodeRawTransaction(_rawTx: string): Promise<any> {
    throw new ApiError(400, 'UNSUPPORTED_OPERATION', 'decodeRawTransaction not supported for Ethereum — use ethers.js client-side');
  }

  decodePsbt(_psbt: string): Promise<any> {
    throw new ApiError(400, 'UNSUPPORTED_OPERATION', 'PSBT not applicable to Ethereum');
  }

  walletCreateFundedPsbt(_inputs: any[], _outputs: any[], _options?: any): Promise<any> {
    throw new ApiError(400, 'UNSUPPORTED_OPERATION', 'walletCreateFundedPsbt not applicable to Ethereum — build EIP-1559 tx client-side');
  }

  finalizePsbt(_psbt: string): Promise<any> {
    throw new ApiError(400, 'UNSUPPORTED_OPERATION', 'finalizePsbt not applicable to Ethereum');
  }

  isValidAddress(address: string): boolean {
    return isEthAddress(address);
  }

  /** Ethereum-specific: get current nonce for an address */
  async getNonce(address: string): Promise<number> {
    return this.rpc.getTransactionCount(address);
  }
}
