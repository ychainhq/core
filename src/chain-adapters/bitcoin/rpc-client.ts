import { logger } from '../../shared/logging/index';
import { ApiError } from '../../shared/errors/index';
import { NodeSelector, SelectedNode } from '../node-selector';

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

// Error codes that indicate a node-level failure (vs. a valid Bitcoin Core RPC response error).
// Only these codes trigger failover to the next healthy node.
const NODE_FAILURE_CODES = new Set(['BITCOIN_RPC_UNAVAILABLE', 'BITCOIN_NODE_HTTP_ERROR', 'BITCOIN_RPC_PARSE_ERROR']);

export class BitcoinRpcClient {
  private requestId = 0;

  constructor(private readonly nodeSelector: NodeSelector) {}

  async call<T = unknown>(method: string, params: unknown[] = [], walletName?: string): Promise<T> {
    const nodes = await this.nodeSelector.getNodes();
    if (nodes.length === 0) {
      throw new ApiError(503, 'BITCOIN_RPC_UNAVAILABLE', 'No Bitcoin nodes configured');
    }

    let lastError: unknown;
    for (const node of nodes) {
      try {
        return await this.callOnNode<T>(node, method, params, walletName);
      } catch (err) {
        const isNodeFailure = !(err instanceof ApiError) || NODE_FAILURE_CODES.has(err.code);
        if (isNodeFailure) {
          lastError = err;
          logger.warn('Bitcoin node unavailable, trying next', {
            url: node.url,
            method,
            err: String(err),
          });
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new ApiError(503, 'BITCOIN_RPC_UNAVAILABLE', 'All Bitcoin nodes failed');
  }

  private async callOnNode<T>(
    node: SelectedNode,
    method: string,
    params: unknown[],
    walletName?: string,
  ): Promise<T> {
    const id = `rpc_${++this.requestId}`;
    const baseUrl = walletName
      ? `${node.url}/wallet/${encodeURIComponent(walletName)}`
      : node.url;

    const body: JsonRpcRequest = { jsonrpc: '1.1', id, method, params };
    const auth =
      node.user != null && node.password != null
        ? Buffer.from(`${node.user}:${node.password}`).toString('base64')
        : null;

    logger.debug('Bitcoin RPC call', { method, params: params.length, wallet: walletName, url: node.url });

    let response: Response;
    let attempts = 0;

    while (true) {
      try {
        response = await fetch(baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(auth ? { Authorization: `Basic ${auth}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(node.timeoutMs),
        });
        break;
      } catch (err) {
        attempts++;
        if (attempts >= node.maxAttempts) {
          throw new ApiError(503, 'BITCOIN_RPC_UNAVAILABLE', `Bitcoin Core RPC unavailable: ${String(err)}`);
        }
        logger.warn('Bitcoin RPC connection failed, retrying', { attempt: attempts, url: node.url, error: String(err) });
        const delayMs = node.retryDelayMs * attempts;
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }

    if (!response.ok && response.status !== 500) {
      throw new ApiError(503, 'BITCOIN_NODE_HTTP_ERROR', `Bitcoin Core RPC HTTP error: ${response.status}`);
    }

    let data: JsonRpcResponse<T>;
    try {
      data = (await response.json()) as JsonRpcResponse<T>;
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

  async getDescriptorInfo(desc: string): Promise<{ descriptor: string; checksum: string }> {
    return this.call('getdescriptorinfo', [desc]);
  }

  async importDescriptors(
    descriptors: Array<{ desc: string; timestamp: number | 'now'; label?: string; internal?: boolean }>,
    walletName?: string,
  ): Promise<void> {
    const withChecksums = await Promise.all(
      descriptors.map(async (d) => {
        if (d.desc.includes('#')) return d;
        const info = await this.getDescriptorInfo(d.desc);
        return { ...d, desc: info.descriptor };
      }),
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
    return this.call('walletcreatefundedpsbt', [inputs, outputs, locktime, options, bip32Derivs], walletName);
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

  async loadOrCreateWallet(walletName: string): Promise<void> {
    try {
      await this.call('loadwallet', [walletName]);
    } catch (err) {
      // Wallet might already be loaded (-35) or not exist yet (-18)
      const code = (err as any)?.response?.error?.code ?? (err as any)?.code;
      if (code === -35) return; // already loaded
      if (code !== -18) throw err; // unexpected error
      await this.call('createwallet', [walletName, false, false, '', false, true]);
    }
  }
}
