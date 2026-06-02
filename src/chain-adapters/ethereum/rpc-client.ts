import { logger } from '../../shared/logging/index';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
  id: number;
}

export interface EthBlock {
  hash: string;
  number: string;        // hex
  parentHash: string;
  timestamp: string;     // hex unix seconds
  transactions: string[] | EthTxDetail[];
  baseFeePerGas?: string;
}

export interface EthTxDetail {
  hash: string;
  from: string;
  to: string | null;
  value: string;         // hex wei
  gas: string;
  gasPrice: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  input: string;
  nonce: string;
  blockHash: string | null;
  blockNumber: string | null;
  transactionIndex: string | null;
}

export interface EthReceipt {
  transactionHash: string;
  blockHash: string | null;
  blockNumber: string | null;
  status: string;        // '0x1' = success, '0x0' = failed
  gasUsed: string;
  effectiveGasPrice: string;
  logs: EthLog[];
}

export interface EthLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  blockHash: string;
}

export interface FeeHistory {
  baseFeePerGas: string[];
  reward: string[][];
}

export class EthRpcClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private reqId = 0;

  constructor(nodeUrl: string, auth?: string) {
    this.baseUrl = nodeUrl;
    this.headers = { 'Content-Type': 'application/json' };
    if (auth) this.headers['Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
  }

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const id = ++this.reqId;
    const body: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    let attempts = 0;
    let lastErr: unknown;

    while (attempts < 3) {
      try {
        const res = await fetch(this.baseUrl, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        const data = await res.json() as JsonRpcResponse<T>;
        if (data.error) {
          throw new Error(`ETH RPC error ${data.error.code}: ${data.error.message}`);
        }
        return data.result as T;
      } catch (err) {
        lastErr = err;
        attempts++;
        if (attempts < 3) await new Promise(r => setTimeout(r, 1000 * attempts));
      }
    }
    throw lastErr;
  }

  async blockNumber(): Promise<number> {
    const hex = await this.call<string>('eth_blockNumber');
    return parseInt(hex, 16);
  }

  async getBlockByNumber(height: number, fullTx = false): Promise<EthBlock> {
    const tag = `0x${height.toString(16)}`;
    return this.call<EthBlock>('eth_getBlockByNumber', [tag, fullTx]);
  }

  async getTransactionReceipt(txHash: string): Promise<EthReceipt | null> {
    return this.call<EthReceipt | null>('eth_getTransactionReceipt', [txHash]);
  }

  async getLogs(params: {
    fromBlock?: string;
    toBlock?: string;
    address?: string | string[];
    topics?: (string | null)[];
  }): Promise<EthLog[]> {
    return this.call<EthLog[]>('eth_getLogs', [params]);
  }

  async getBalance(address: string, tag = 'latest'): Promise<string> {
    return this.call<string>('eth_getBalance', [address, tag]);
  }

  async call_contract(to: string, data: string, tag = 'latest'): Promise<string> {
    return this.call<string>('eth_call', [{ to, data }, tag]);
  }

  async getTransactionCount(address: string, tag = 'latest'): Promise<number> {
    const hex = await this.call<string>('eth_getTransactionCount', [address, tag]);
    return parseInt(hex, 16);
  }

  async gasPrice(): Promise<string> {
    return this.call<string>('eth_gasPrice');
  }

  async maxPriorityFeePerGas(): Promise<string> {
    return this.call<string>('eth_maxPriorityFeePerGas');
  }

  async feeHistory(blockCount: number, newest = 'latest', percentiles = [50]): Promise<FeeHistory> {
    return this.call<FeeHistory>('eth_feeHistory', [`0x${blockCount.toString(16)}`, newest, percentiles]);
  }

  async sendRawTransaction(rawTx: string): Promise<string> {
    return this.call<string>('eth_sendRawTransaction', [rawTx]);
  }

  async estimateGas(params: { from?: string; to: string; data?: string; value?: string }): Promise<string> {
    return this.call<string>('eth_estimateGas', [params]);
  }

  async syncing(): Promise<false | { currentBlock: string; highestBlock: string }> {
    return this.call<false | { currentBlock: string; highestBlock: string }>('eth_syncing');
  }

  async getChainId(): Promise<number> {
    const hex = await this.call<string>('eth_chainId');
    return parseInt(hex, 16);
  }
}
