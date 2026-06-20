// Unit tests for tronBalancesService — SQL cache path + live RPC fallback.

jest.mock('../../src/db/client', () => ({ getDbClient: jest.fn() }));
jest.mock('../../src/chain-adapters/registry', () => ({ adapterRegistry: { get: jest.fn() } }));
jest.mock('../../src/config/index', () => ({ config: { TRON_USDT_CONTRACT_ADDRESS: 'TUSDT_CONTRACT' } }));
jest.mock('../../src/shared/logging/index', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { getDbClient } from '../../src/db/client';
import { adapterRegistry } from '../../src/chain-adapters/registry';
import { tronBalancesService } from '../../src/modules/tron/tron-balances.service';

const mockGetAccountBalance = jest.fn();
const mockAdapter = { getAccountBalance: mockGetAccountBalance };
const mockDb = { all: jest.fn(), run: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  (getDbClient as jest.Mock).mockReturnValue(mockDb);
  (adapterRegistry.get as jest.Mock).mockReturnValue(mockAdapter);
});

describe('tronBalancesService.getWalletBalances — SQL cache path', () => {
  it('returns summed balances from cache when cache is populated', async () => {
    const now = Date.now();
    mockDb.all.mockResolvedValue([
      { asset_id: 'tron:TRX',  balance_raw: '3000000', updated_at: now },
      { asset_id: 'tron:TRX',  balance_raw: '2000000', updated_at: now },
      { asset_id: 'tron:USDT', balance_raw: '7000000', updated_at: now },
      { asset_id: 'tron:USDT', balance_raw: '3000000', updated_at: now },
    ]);
    const result = await tronBalancesService.getWalletBalances('wallet_1');
    expect(result.trxSun).toBe('5000000');
    expect(result.usdtSun).toBe('10000000');
    expect(mockGetAccountBalance).not.toHaveBeenCalled();
  });

  it('returns stale=false when cache is fresh (< 10 min old)', async () => {
    const now = Date.now();
    mockDb.all.mockResolvedValue([
      { asset_id: 'tron:TRX', balance_raw: '1000000', updated_at: now - 60_000 },
    ]);
    const result = await tronBalancesService.getWalletBalances('wallet_1');
    expect(result.stale).toBe(false);
    expect(result.cacheUpdatedAt).toBe(now - 60_000);
  });

  it('returns stale=true when cache is old (> 10 min)', async () => {
    const now = Date.now();
    const oldTs = now - 11 * 60 * 1000;
    mockDb.all.mockResolvedValue([
      { asset_id: 'tron:TRX', balance_raw: '1000000', updated_at: oldTs },
    ]);
    const result = await tronBalancesService.getWalletBalances('wallet_1');
    expect(result.stale).toBe(true);
    expect(result.cacheUpdatedAt).toBe(oldTs);
  });

  it('SQL query includes chain_id=tron and status=active JOIN', async () => {
    const now = Date.now();
    mockDb.all.mockResolvedValue([{ asset_id: 'tron:TRX', balance_raw: '0', updated_at: now }]);
    await tronBalancesService.getWalletBalances('wallet_abc');
    const call = mockDb.all.mock.calls[0] as [string, unknown[]];
    expect(call[0]).toContain("chain_id = 'tron'");
    expect(call[0]).toContain("status = 'active'");
    expect(call[0]).toContain('tron_account_balances');
  });
});

describe('tronBalancesService.getWalletBalances — cache miss / live RPC fallback', () => {
  it('returns zeros with stale=false when wallet has no TRON addresses', async () => {
    mockDb.all
      .mockResolvedValueOnce([])   // cache query — empty
      .mockResolvedValueOnce([]);  // address count query — empty
    const result = await tronBalancesService.getWalletBalances('wallet_empty');
    expect(result).toEqual({ trxSun: '0', usdtSun: '0', stale: false, cacheUpdatedAt: null });
    expect(mockGetAccountBalance).not.toHaveBeenCalled();
  });

  it('falls back to live RPC when cache missing and wallet has ≤10 addresses', async () => {
    mockDb.all
      .mockResolvedValueOnce([])  // cache query — empty
      .mockResolvedValueOnce([{ address: 'TAddr1' }, { address: 'TAddr2' }]); // 2 addresses
    mockGetAccountBalance.mockResolvedValue({ trxSun: '1000000', usdtSun: '500000' });

    const result = await tronBalancesService.getWalletBalances('wallet_small');
    expect(mockGetAccountBalance).toHaveBeenCalledTimes(2);
    expect(result.trxSun).toBe('2000000');
    expect(result.usdtSun).toBe('1000000');
    expect(result.stale).toBe(false);
    expect(result.cacheUpdatedAt).toBeNull();
  });

  it('returns zeros with stale=true when cache missing and wallet has >10 addresses', async () => {
    const addresses = Array.from({ length: 11 }, (_, i) => ({ address: `TAddr${i}` }));
    mockDb.all
      .mockResolvedValueOnce([])        // cache query — empty
      .mockResolvedValueOnce(addresses); // 11 addresses

    const result = await tronBalancesService.getWalletBalances('wallet_large');
    expect(result).toEqual({ trxSun: '0', usdtSun: '0', stale: true, cacheUpdatedAt: null });
    expect(mockGetAccountBalance).not.toHaveBeenCalled();
  });

  it('live RPC fallback skips failed addresses', async () => {
    mockDb.all
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ address: 'TBad' }, { address: 'TGood' }]);
    mockGetAccountBalance
      .mockRejectedValueOnce(new Error('rpc error'))
      .mockResolvedValueOnce({ trxSun: '1000000', usdtSun: '2000000' });

    const result = await tronBalancesService.getWalletBalances('wallet_mixed');
    expect(result.trxSun).toBe('1000000');
    expect(result.usdtSun).toBe('2000000');
  });

  it('passes correct USDT contract address to live RPC getAccountBalance', async () => {
    mockDb.all
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ address: 'TAddr1' }]);
    mockGetAccountBalance.mockResolvedValue({ trxSun: '0', usdtSun: '0' });

    await tronBalancesService.getWalletBalances('wallet_1');
    expect(mockGetAccountBalance).toHaveBeenCalledWith('TAddr1', 'TUSDT_CONTRACT');
  });
});
