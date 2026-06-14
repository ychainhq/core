import { ApiError } from '../../shared/errors/index';
import { logger } from '../../shared/logging/index';
import { NodeSelector, SelectedNode } from '../node-selector';
import { TronChainParams, TronAccountResource } from './tron-types';

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

  /**
   * Fetch current TRON chain parameters.
   * Relevant keys: getEnergyFee (sun/energy unit), getTransactionFee (sun/byte for bandwidth).
   */
  async getChainParameters(): Promise<TronChainParams> {
    const result = await this.post<{ chainParameter?: Array<{ key: string; value: number }> }>(
      '/wallet/getchainparameters',
      {},
    );
    const params = result.chainParameter ?? [];
    const energyFeeEntry = params.find((p) => p.key === 'getEnergyFee');
    const bandwidthFeeEntry = params.find((p) => p.key === 'getTransactionFee');
    return {
      energyPriceSun: energyFeeEntry?.value ?? 420,
      bandwidthPriceSun: bandwidthFeeEntry?.value ?? 1000,
    };
  }

  /**
   * Fetch resource state for an account: bandwidth (free + staked) and energy (staked).
   */
  async getAccountResource(address: string): Promise<TronAccountResource> {
    const result = await this.post<{
      freeNetLimit?: number;
      freeNetUsed?: number;
      NetLimit?: number;
      NetUsed?: number;
      EnergyLimit?: number;
      EnergyUsed?: number;
    }>('/wallet/getaccountresource', { address, visible: true });
    return {
      freeNetLimit: result.freeNetLimit ?? 1500,
      freeNetUsed: result.freeNetUsed ?? 0,
      netLimit: result.NetLimit ?? 0,
      netUsed: result.NetUsed ?? 0,
      energyLimit: result.EnergyLimit ?? 0,
      energyUsed: result.EnergyUsed ?? 0,
    };
  }

  /**
   * Simulate a TRC-20 transfer without broadcasting (triggerconstantcontract).
   * Returns energy_used for accurate fee estimation and raw tx size in bytes.
   * The returned transaction object is identical to triggersmartcontract output —
   * callers may pass it directly to the signer to avoid a second RPC round-trip.
   */
  async simulateTrc20Transfer(params: {
    ownerAddress: string;
    contractAddress: string;
    toAddress: string;
    amount: bigint;
    feeLimit: number;
  }): Promise<{ energyUsed: number; txSizeBytes: number; transaction: TronUnsignedTransaction }> {
    const { ownerAddress, contractAddress, toAddress, amount, feeLimit } = params;
    const toHex20 = tronBase58ToHex20(toAddress);
    const amountHex = amount.toString(16).padStart(64, '0');
    const parameter = toHex20.padStart(64, '0') + amountHex;

    const result = await this.post<{
      transaction?: TronUnsignedTransaction;
      energy_used?: number;
      result?: { result: boolean; message?: string };
    }>('/wallet/triggerconstantcontract', {
      owner_address: ownerAddress,
      contract_address: contractAddress,
      function_selector: 'transfer(address,uint256)',
      parameter,
      fee_limit: feeLimit,
      call_value: 0,
      visible: true,
    });

    if (!result.transaction?.txID) {
      throw new Error('TRON triggerconstantcontract: missing transaction in simulation response');
    }

    const raw_data_hex = result.transaction.raw_data_hex ?? '';
    const txSizeBytes = raw_data_hex.length > 0 ? Math.ceil(raw_data_hex.length / 2) : 285;

    return {
      energyUsed: result.energy_used ?? 65000,
      txSizeBytes,
      transaction: result.transaction,
    };
  }

  /**
   * Build an unsigned TRX (native) transfer transaction via /wallet/createtransaction.
   */
  async createUnsignedTrxTransfer(params: {
    fromAddress: string;
    toAddress: string;
    amountSun: string;
  }): Promise<TronUnsignedTransaction> {
    const { fromAddress, toAddress, amountSun } = params;

    const result = await this.post<TronUnsignedTransaction & { Error?: string }>('/wallet/createtransaction', {
      owner_address: fromAddress,
      to_address: toAddress,
      amount: Number(amountSun),
      visible: true,
    });

    if (result.Error) {
      throw new Error(`TRON createtransaction failed: ${result.Error}`);
    }
    if (!result.txID) {
      throw new Error('TRON createtransaction: missing txID in response');
    }

    return result;
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
