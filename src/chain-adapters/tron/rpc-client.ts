import { ApiError } from '../../shared/errors/index';
import { logger } from '../../shared/logging/index';
import { NodeSelector, SelectedNode } from '../node-selector';

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

export interface TronUnsignedTransaction {
  txID: string;
  raw_data: Record<string, unknown>;
  raw_data_hex: string;
  [key: string]: unknown;
}

// ABI function selectors (keccak256 of signature, first 4 bytes)
const SELECTOR_BALANCE_OF = '70a08231'; // balanceOf(address)
const SELECTOR_TRANSFER = 'a9059cbb'; // transfer(address,uint256)

export class TronRpcClient {
  constructor(private readonly nodeSelector: NodeSelector) {}

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const nodes = await this.nodeSelector.getNodes();
    if (nodes.length === 0) {
      throw new ApiError(503, 'TRON_NO_NODES', 'No TRON nodes configured');
    }

    let lastError: unknown;
    for (const node of nodes) {
      try {
        return await this.postOnNode<T>(node, path, body);
      } catch (err) {
        lastError = err;
        logger.warn('TRON node failed, trying next', {
          url: node.url,
          path,
          err: String(err),
        });
      }
    }

    throw lastError ?? new ApiError(503, 'TRON_RPC_UNAVAILABLE', 'All TRON nodes failed');
  }

  private async postOnNode<T>(node: SelectedNode, path: string, body: Record<string, unknown>): Promise<T> {
    const url = `${node.url.replace(/\/$/, '')}${path}`;
    let attempts = 0;

    while (true) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(node.timeoutMs),
        });

        if (!res.ok) {
          throw new Error(`TRON node HTTP ${res.status} for ${path}`);
        }

        return res.json() as Promise<T>;
      } catch (err) {
        attempts++;
        if (attempts >= node.maxAttempts) throw err;
        logger.warn('TRON node connection failed, retrying', {
          attempt: attempts,
          url: node.url,
          error: String(err),
        });
        const delayMs = node.retryDelayMs * attempts;
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
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

  broadcastTransaction(
    transaction: unknown,
  ): Promise<{ result?: boolean; txid?: string; code?: string; message?: string }> {
    return this.post('/wallet/broadcasttransaction', transaction as Record<string, unknown>);
  }

  /**
   * Query TRC-20 token balance for `address` via triggerconstantcontract.
   * Returns balance as a decimal string (sun units, 6 decimals for USDT).
   */
  async getTrc20Balance(address: string, contractAddress: string): Promise<string> {
    const addrHex20 = tronBase58ToHex20(address);
    const parameter = addrHex20.padStart(64, '0');
    const result = await this.post<{ constant_result?: string[] }>(
      '/wallet/triggerconstantcontract',
      {
        owner_address: address,
        contract_address: contractAddress,
        function_selector: 'balanceOf(address)',
        parameter,
        visible: true,
      },
    );
    const raw = result.constant_result?.[0];
    if (!raw || raw.length < 64) return '0';
    return BigInt('0x' + raw.slice(-64)).toString();
  }

  /**
   * Build an unsigned TRC-20 transfer transaction via triggersmartcontract.
   * Returns the raw unsigned transaction object (contains txID, raw_data, raw_data_hex).
   * feeLimitSun: maximum TRX energy fee (default 40 TRX = 40_000_000 sun).
   */
  async createUnsignedTrc20Transfer(params: {
    fromAddress: string;
    toAddress: string;
    contractAddress: string;
    amountSun: string;
    feeLimitSun: number;
  }): Promise<TronUnsignedTransaction> {
    const { fromAddress, toAddress, contractAddress, amountSun, feeLimitSun } = params;
    const toHex20 = tronBase58ToHex20(toAddress);
    const amountHex = BigInt(amountSun).toString(16).padStart(64, '0');
    const parameter = toHex20.padStart(64, '0') + amountHex;

    const result = await this.post<{
      transaction?: TronUnsignedTransaction;
      result?: { result: boolean; message?: string };
    }>('/wallet/triggersmartcontract', {
      owner_address: fromAddress,
      contract_address: contractAddress,
      function_selector: 'transfer(address,uint256)',
      parameter,
      fee_limit: feeLimitSun,
      call_value: 0,
      visible: true,
    });

    if (!result.result?.result) {
      throw new Error(`TRON triggersmartcontract failed: ${result.result?.message ?? 'unknown error'}`);
    }

    if (!result.transaction?.txID) {
      throw new Error('TRON triggersmartcontract: missing transaction in response');
    }

    return result.transaction;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function tronBase58ToHex20(address: string): string {
  let num = 0n;
  for (const char of address) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = Buffer.from(hex, 'hex');
  // 25 bytes: version(1) + address(20) + checksum(4)
  if (bytes.length < 21) throw new Error(`Cannot decode TRON address: ${address}`);
  return bytes.subarray(1, 21).toString('hex');
}

// Suppress unused-variable lint for selectors exported for testing
void SELECTOR_BALANCE_OF;
void SELECTOR_TRANSFER;
