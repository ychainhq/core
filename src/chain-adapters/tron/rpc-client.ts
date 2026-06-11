export interface TronBlockResponse {
  blockID: string;
  block_header: {
    raw_data: {
      number: number;
      timestamp: number;
      parentHash: string;
    };
  };
  transactions?: Array<{ txID: string }>;
}

export interface TronTransactionInfoResponse {
  id?: string;
  blockNumber?: number;
  blockTimeStamp?: number;
  blockHash?: string;
  receipt?: { result?: string };
}

export class TronRpcClient {
  private readonly baseUrl: string;

  constructor(nodeUrl: string) {
    this.baseUrl = nodeUrl.replace(/\/$/, '');
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`TRON node HTTP ${res.status} for ${path}`);
    }

    return res.json() as Promise<T>;
  }

  getNowBlock(): Promise<TronBlockResponse> {
    return this.post<TronBlockResponse>('/wallet/getnowblock', { visible: true });
  }

  getBlockByNumber(height: number): Promise<TronBlockResponse> {
    return this.post<TronBlockResponse>('/wallet/getblockbynum', { num: height, visible: true });
  }

  getTransactionInfo(txHash: string): Promise<TronTransactionInfoResponse | Record<string, never>> {
    return this.post<TronTransactionInfoResponse | Record<string, never>>(
      '/wallet/gettransactioninfobyid',
      { value: txHash },
    );
  }

  getAccount(address: string): Promise<{ balance?: number }> {
    return this.post<{ balance?: number }>('/wallet/getaccount', { address, visible: true });
  }

  broadcastTransaction(transaction: unknown): Promise<{ result?: boolean; txid?: string; code?: string; message?: string }> {
    return this.post('/wallet/broadcasttransaction', transaction as Record<string, unknown>);
  }
}
