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
  private requestId = 0;

  constructor() {
    this.baseUrl = config.BITCOIN_RPC_URL;
    this.auth = Buffer.from(
      `${config.BITCOIN_RPC_USER}:${config.BITCOIN_RPC_PASSWORD}`
    ).toString('base64');
  }

  private getUrl(walletName?: string): string {
    if (walletName) {
      return `${this.baseUrl}/wallet/${encodeURIComponent(walletName)}`;
    }
    return this.baseUrl;
  }

  async call<T = unknown>(method: string, params: unknown[] = [], walletName?: string): Promise<T> {
    const id = `rpc_${++this.requestId}`;
    const url = this.getUrl(walletName);

    const body: JsonRpcRequest = {
      jsonrpc: '1.1',
      id,
      method,
      params,
    };

    logger.debug('Bitcoin RPC call', { method, params: params.length, wallet: walletName });

    let response: Response;
    let attempts = 0;
    const maxAttempts = config.BITCOIN_RPC_MAX_ATTEMPTS;

    while (true) {
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${this.auth}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.BITCOIN_RPC_TIMEOUT_MS),
        });
        break;
      } catch (err) {
        attempts++;
        if (attempts >= maxAttempts) {
          throw new ApiError(503, 'BITCOIN_RPC_UNAVAILABLE', `Bitcoin Core RPC unavailable: ${String(err)}`);
        }
        logger.warn('Bitcoin RPC connection failed, retrying', { attempt: attempts, error: String(err) });
        const delayMs = config.BITCOIN_RPC_RETRY_DELAY_MS * attempts;
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
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

  // ---- Wallet management ----

  /**
   * Create a watch-only wallet for a tenant.
   * disablePrivateKeys=true means no private keys are stored in this wallet.
   */
  async createWatchOnlyWallet(walletName: string): Promise<void> {
    await this.call('createwallet', [
      walletName,
      true,  // disablePrivateKeys
      false, // blank
      '',    // passphrase
      false, // avoidReuse
      true,  // descriptors — required for importdescriptors + timestamp support
      false, // loadOnStartup (managed manually)
    ]);
  }

  /**
   * Load an existing wallet by name.
   */
  async loadWallet(walletName: string): Promise<void> {
    await this.call('loadwallet', [walletName]);
  }

  /**
   * List currently loaded wallets.
   */
  async listWallets(): Promise<string[]> {
    return this.call<string[]>('listwallets');
  }

  // ---- Address/wallet operations ----

  async scanTxOutSet(descriptor: string): Promise<any> {
    return this.call('scantxoutset', ['start', [{ desc: descriptor }]]);
  }

  async getReceivedByAddress(address: string, minConf = 0, walletName?: string): Promise<number> {
    return this.call<number>('getreceivedbyaddress', [address, minConf], walletName);
  }

  async listUnspent(
    minConf = 0,
    maxConf = 9999999,
    addresses: string[] = [],
    walletName?: string,
  ): Promise<any[]> {
    return this.call<any[]>('listunspent', [minConf, maxConf, addresses], walletName);
  }

  async importAddress(address: string, label = '', rescan = false, walletName?: string): Promise<void> {
    await this.call('importaddress', [address, label, rescan], walletName);
  }

  async getDescriptorInfo(desc: string): Promise<{ descriptor: string; checksum: string }> {
    return this.call('getdescriptorinfo', [desc]);
  }

  async importDescriptors(
    descriptors: Array<{ desc: string; timestamp: number | 'now'; label?: string; internal?: boolean }>,
    walletName?: string
  ): Promise<void> {
    // Resolve checksums for all descriptors that don't already have one
    const withChecksums = await Promise.all(
      descriptors.map(async (d) => {
        if (d.desc.includes('#')) return d;
        const info = await this.getDescriptorInfo(d.desc);
        return { ...d, desc: info.descriptor };
      })
    );
    const results: Array<{ success: boolean; error?: { code: number; message: string } }> =
      await this.call('importdescriptors', [withChecksums], walletName);
    const failed = results.find((r) => !r.success);
    if (failed) throw new Error(`importdescriptors failed: ${JSON.stringify(failed.error)}`);
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
    bip32Derivs = false,
    walletName?: string,
  ): Promise<any> {
    return this.call(
      'walletcreatefundedpsbt',
      [inputs, outputs, locktime, options, bip32Derivs],
      walletName,
    );
  }

  async finalizePsbt(psbt: string, extract = true): Promise<any> {
    return this.call('finalizepsbt', [psbt, extract]);
  }

  async createPsbt(inputs: any[], outputs: any[], locktime = 0): Promise<string> {
    return this.call<string>('createpsbt', [inputs, outputs, locktime]);
  }

  async utxoUpdatePsbt(psbt: string): Promise<string> {
    return this.call<string>('utxoupdatepsbt', [psbt]);
  }

  async getMempoolEntry(txHash: string): Promise<any> {
    return this.call('getmempoolentry', [txHash]);
  }
}
