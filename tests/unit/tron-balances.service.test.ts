// Unit tests for tronBalancesService — mocks adapterRegistry and DB client.
// TronRpcClient is NOT called; only TronAdapter methods are mocked.

jest.mock('../../src/db/client', () => ({ getDbClient: jest.fn() }));
jest.mock('../../src/chain-adapters/registry', () => ({ adapterRegistry: { get: jest.fn() } }));
jest.mock('../../src/config/index', () => ({ config: { TRON_USDT_CONTRACT_ADDRESS: 'TUSDT_CONTRACT' } }));

import { getDbClient } from '../../src/db/client';
import { adapterRegistry } from '../../src/chain-adapters/registry';
import { tronBalancesService } from '../../src/modules/tron/tron-balances.service';

const mockGetAccountBalance = jest.fn();
const mockAdapter = { getAccountBalance: mockGetAccountBalance };

const mockDb = { all: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  (getDbClient as jest.Mock).mockReturnValue(mockDb);
  (adapterRegistry.get as jest.Mock).mockReturnValue(mockAdapter);
});

describe('tronBalancesService.getWalletBalances', () => {
  it('returns zero balances when wallet has no TRON addresses', async () => {
    mockDb.all.mockResolvedValue([]);
    const result = await tronBalancesService.getWalletBalances('wallet_1');
    expect(result).toEqual({ trxSun: '0', usdtSun: '0' });
    expect(mockGetAccountBalance).not.toHaveBeenCalled();
  });

  it('returns summed balances for single address', async () => {
    mockDb.all.mockResolvedValue([{ address: 'TAddr1' }]);
    mockGetAccountBalance.mockResolvedValue({ trxSun: '5000000', usdtSun: '10000000' });

    const result = await tronBalancesService.getWalletBalances('wallet_1');

    expect(result).toEqual({ trxSun: '5000000', usdtSun: '10000000' });
    expect(mockGetAccountBalance).toHaveBeenCalledWith('TAddr1', 'TUSDT_CONTRACT');
  });

  it('sums balances across multiple addresses', async () => {
    mockDb.all.mockResolvedValue([{ address: 'TAddr1' }, { address: 'TAddr2' }]);
    mockGetAccountBalance
      .mockResolvedValueOnce({ trxSun: '3000000', usdtSun: '7000000' })
      .mockResolvedValueOnce({ trxSun: '2000000', usdtSun: '3000000' });

    const result = await tronBalancesService.getWalletBalances('wallet_1');

    expect(result).toEqual({ trxSun: '5000000', usdtSun: '10000000' });
  });

  it('skips addresses that throw and accumulates the rest', async () => {
    mockDb.all.mockResolvedValue([{ address: 'TBad' }, { address: 'TGood' }]);
    mockGetAccountBalance
      .mockRejectedValueOnce(new Error('node unreachable'))
      .mockResolvedValueOnce({ trxSun: '1000000', usdtSun: '2000000' });

    const result = await tronBalancesService.getWalletBalances('wallet_1');

    expect(result).toEqual({ trxSun: '1000000', usdtSun: '2000000' });
  });

  it('returns zero if all addresses fail', async () => {
    mockDb.all.mockResolvedValue([{ address: 'TBad1' }, { address: 'TBad2' }]);
    mockGetAccountBalance.mockRejectedValue(new Error('node unreachable'));

    const result = await tronBalancesService.getWalletBalances('wallet_1');

    expect(result).toEqual({ trxSun: '0', usdtSun: '0' });
  });

  it('passes correct contract address to getAccountBalance', async () => {
    mockDb.all.mockResolvedValue([{ address: 'TAddr1' }]);
    mockGetAccountBalance.mockResolvedValue({ trxSun: '0', usdtSun: '0' });

    await tronBalancesService.getWalletBalances('wallet_xyz');

    expect(mockGetAccountBalance).toHaveBeenCalledWith('TAddr1', 'TUSDT_CONTRACT');
  });

  it('queries only active tron addresses for the wallet', async () => {
    mockDb.all.mockResolvedValue([]);
    await tronBalancesService.getWalletBalances('wallet_abc');

    expect(mockDb.all).toHaveBeenCalledWith(
      expect.stringContaining("chain_id = 'tron'"),
      ['wallet_abc'],
    );
    expect(mockDb.all).toHaveBeenCalledWith(
      expect.stringContaining("status = 'active'"),
      ['wallet_abc'],
    );
  });
});
