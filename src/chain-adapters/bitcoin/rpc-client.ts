import { config } from '../../config/index';
import { logger } from '../../shared/logging/index';
import { ApiError } from '../../shared/errors/index';

interface JsonRpcRequest {
  jsonrpc: '1.1';
  id: string;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse<T = unknown> {
  result: T | null;
  error: {
    code: number;
    message: string;
  } | null;
  id: string;
}

export class BitcoinRpcClient {
  private readonly baseUrl: string;
  private readonly auth: string;
  private readonly walletUrl: string | null;
  private requestId = 0;

  constructor() {
    this.baseUrl = config.BITCOIN_RPC_URL;
    this.auth = Buffer.from(
      `${config.BITCOIN_RPC_USER}:${config.BITCOIN_RPC_PASSWORD}`
    ).toString('base64');

    this.walletUrl = config.BITCOIN_RPC_WALLET
      ? `${config.BITCOIN_RPC_URL}/wallet/${encodeURIComponent(config.BITCOIN_RPC_WALLET)}`
      : null;
  }

  private getUrl(useWallet = false): string {
    if (useWallet && this.walletUrl) return this.walletUrl;
    return this.baseUrl;
  }

  async call<T = unknown>(method: string, params: unknown[] = [], useWallet = false): Promise<T> {
    const id = `rpc_${++this.requestId}`;
    const url = this.getUrl(useWallet);

    const body: JsonRpcRequest = {
      jsonrpc: '1.1',
      id,
      method,
      params,
    };

    logger.debug('Bitcoin RPC call', { method, params: params.length });

    let response: Response;
    let attempts = 0;
    const maxAttempts = 3;

    while (true) {
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${this.auth}`,
          },
          body: JSON.stringify(body),
        });
        break;
      } catch (err) {
        attempts++;
        if (attempts >= maxAttempts) {
          throw new ApiError(503, 'BITCOIN_RPC_UNAVAILABLE', `Bitcoin Core RPC unavailable: ${String(err)}`);
        }
        logger.warn('Bitcoin RPC connection failed, retrying', { attempt: attempts, error: String(err) });
        await new Promise((r) => setTimeout(r, 1000 * attempts));
      }
    }

    if (!response.ok && response.status !== 500) {
      throw new ApiError(503, 'BITCOIN_RPC_ERROR', `Bitcoin Core RPC HTTP error: ${response.status}`);
    }

    let data: JsonRpcResponse<T>;
    try {
      data = await response.json() as JsonRpcResponse<T>;
    } catch {
      throw new ApiError(503, 'BITCOIN_RPC_PARSE_ERROR', 'Failed to parse Bitcoin Core RPC response');
    }

    if (data.error) {
      logger.warn('Bitcoin RPC error', { method, code: data.error.code, message: data.error.message });
      // Map common RPC error codes
      if (data.error.code === -5) {
        throw new ApiError(404, 'TX_NOT_FOUND', data.error.message);
      }
      if (data.error.code === -8) {
        throw new ApiError(400, 'INVALID_PARAMETER', data.error.message);
      }
      if (data.error.code === -25) {
        throw new ApiError(422, 'TX_REJECTED', data.error.message);
      }
      throw new ApiError(422, 'BITCOIN_RPC_ERROR', `Bitcoin Core RPC error ${data.error.code}: ${data.error.message}`);
    }

    return data.result as T;
  }

  // ---- Blockchain info ----

  async getBlockchainInfo(): Promise<any> {
    return this.call('getblockchaininfo');
  }

  async getBlockCount(): Promise<number> {
    return this.call<number>('getblockcount');
  }

  async getBlockHash(height: number): Promise<string> {
    return this.call<string>('getblockhash', [height]);
  }

  async getBlock(hashOrHeight: string | number, verbosity = 1): Promise<any> {
    if (typeof hashOrHeight === 'number') {
      const hash = await this.getBlockHash(hashOrHeight);
      return this.call('getblock', [hash, verbosity]);
    }
    return this.call('getblock', [hashOrHeight, verbosity]);
  }

  async getRawTransaction(txHash: string, verbose = true): Promise<any> {
    return this.call('getrawtransaction', [txHash, verbose ? 1 : 0]);
  }

  async getRawMempool(): Promise<string[]> {
    return this.call<string[]>('getrawmempool');
  }

  // ---- Address/wallet operations ----

  /**
   * Scan UTXO set for an address.
   * WARNING: scantxoutset is a blocking, heavy operation in Bitcoin Core.
   * For production, use electrs/mempool.space indexer or a watch-only wallet with listunspent.
   * Only use this when no watch-only wallet is configured.
   */
  async scanTxOutSet(descriptor: string): Promise<any> {
    return this.call('scantxoutset', ['start', [{ desc: descriptor }]]);
  }

  async getReceivedByAddress(address: string, minConf = 0): Promise<number> {
    return this.call<number>('getreceivedbyaddress', [address, minConf], true);
  }

  async listUnspent(
    minConf = 0,
    maxConf = 9999999,
    addresses: string[] = []
  ): Promise<any[]> {
    return this.call<any[]>('listunspent', [minConf, maxConf, addresses], true);
  }

  // ---- Transaction operations ----

  async estimateSmartFee(targetBlocks: number, mode = 'CONSERVATIVE'): Promise<any> {
    return this.call('estimatesmartfee', [targetBlocks, mode]);
  }

  async testMempoolAccept(rawTxs: string[]): Promise<any[]> {
    return this.call<any[]>('testmempoolaccept', [rawTxs]);
  }

  async sendRawTransaction(rawTx: string, maxFeeRate?: number): Promise<string> {
    const params: unknown[] = [rawTx];
    if (maxFeeRate !== undefined) params.push(maxFeeRate);
    return this.call<string>('sendrawtransaction', params);
  }

  async decodeRawTransaction(rawTx: string): Promise<any> {
    return this.call('decoderawtransaction', [rawTx]);
  }

  async decodePsbt(psbt: string): Promise<any> {
    return this.call('decodepsbt', [psbt]);
  }

  async walletCreateFundedPsbt(
    inputs: any[],
    outputs: any[],
    locktime = 0,
    options: any = {},
    bip32Derivs = false
  ): Promise<any> {
    return this.call(
      'walletcreatefundedpsbt',
      [inputs, outputs, locktime, options, bip32Derivs],
      true
    );
  }

  async finalizePsbt(psbt: string, extract = true): Promise<any> {
    return this.call('finalizepsbt', [psbt, extract]);
  }

  async getMempoolEntry(txHash: string): Promise<any> {
    return this.call('getmempoolentry', [txHash]);
  }

  async importAddress(address: string, label = '', rescan = false): Promise<void> {
    await this.call('importaddress', [address, label, rescan], true);
  }
}
