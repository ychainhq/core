import { satoshiToBtc, btcToSatoshi, formatAmount, addSatoshi, subtractSatoshi, compareSatoshi } from '../src/shared/money/index';

describe('satoshiToBtc', () => {
  it('converts 1 BTC correctly', () => {
    expect(satoshiToBtc(BigInt(100_000_000))).toBe('1.00000000');
  });

  it('converts 0 satoshi', () => {
    expect(satoshiToBtc(BigInt(0))).toBe('0.00000000');
  });

  it('converts 1 satoshi', () => {
    expect(satoshiToBtc(BigInt(1))).toBe('0.00000001');
  });

  it('converts 0.001 BTC', () => {
    expect(satoshiToBtc(BigInt(100_000))).toBe('0.00100000');
  });

  it('handles large amounts (21 million BTC)', () => {
    const maxBtc = BigInt(21_000_000) * BigInt(100_000_000);
    expect(satoshiToBtc(maxBtc)).toBe('21000000.00000000');
  });

  it('handles string input', () => {
    expect(satoshiToBtc('100000000')).toBe('1.00000000');
  });

  it('handles negative values', () => {
    expect(satoshiToBtc(BigInt(-100_000_000))).toBe('-1.00000000');
  });

  it('converts fractional BTC correctly', () => {
    expect(satoshiToBtc(BigInt(50_000_000))).toBe('0.50000000');
    expect(satoshiToBtc(BigInt(12_345_678))).toBe('0.12345678');
  });
});

describe('btcToSatoshi', () => {
  it('converts 1 BTC to satoshi', () => {
    expect(btcToSatoshi('1')).toBe(BigInt(100_000_000));
  });

  it('converts 0 BTC', () => {
    expect(btcToSatoshi('0')).toBe(BigInt(0));
  });

  it('converts 0.00000001 BTC (1 satoshi)', () => {
    expect(btcToSatoshi('0.00000001')).toBe(BigInt(1));
  });

  it('converts 0.001 BTC', () => {
    expect(btcToSatoshi('0.001')).toBe(BigInt(100_000));
  });

  it('converts 21 million BTC', () => {
    const expected = BigInt(21_000_000) * BigInt(100_000_000);
    expect(btcToSatoshi('21000000')).toBe(expected);
  });

  it('handles trailing zeros', () => {
    expect(btcToSatoshi('1.00000000')).toBe(BigInt(100_000_000));
    expect(btcToSatoshi('0.10000000')).toBe(BigInt(10_000_000));
  });

  it('handles fractional amounts with fewer than 8 decimals', () => {
    expect(btcToSatoshi('0.1')).toBe(BigInt(10_000_000));
    expect(btcToSatoshi('1.5')).toBe(BigInt(150_000_000));
  });

  it('throws on invalid input', () => {
    expect(() => btcToSatoshi('abc')).toThrow();
    expect(() => btcToSatoshi('1.2.3')).toThrow();
    expect(() => btcToSatoshi('')).toThrow();
  });

  it('is inverse of satoshiToBtc', () => {
    const original = BigInt(12_345_678);
    const btc = satoshiToBtc(original);
    const back = btcToSatoshi(btc);
    expect(back).toBe(original);
  });
});

describe('formatAmount', () => {
  it('formats with 8 decimals', () => {
    expect(formatAmount('100000000', 8)).toBe('1.00000000');
  });

  it('formats with 6 decimals (USDC)', () => {
    expect(formatAmount('1000000', 6)).toBe('1.000000');
  });

  it('formats with 0 decimals', () => {
    expect(formatAmount('42', 0)).toBe('42');
  });

  it('handles zero', () => {
    expect(formatAmount('0', 8)).toBe('0.00000000');
  });
});

describe('addSatoshi', () => {
  it('adds two amounts', () => {
    expect(addSatoshi('100000000', '50000000')).toBe('150000000');
  });

  it('adds with zero', () => {
    expect(addSatoshi('100000000', '0')).toBe('100000000');
  });
});

describe('subtractSatoshi', () => {
  it('subtracts amounts', () => {
    expect(subtractSatoshi('100000000', '50000000')).toBe('50000000');
  });

  it('returns negative when b > a', () => {
    expect(subtractSatoshi('50000000', '100000000')).toBe('-50000000');
  });
});

describe('compareSatoshi', () => {
  it('returns 0 for equal amounts', () => {
    expect(compareSatoshi('100', '100')).toBe(0);
  });

  it('returns -1 when a < b', () => {
    expect(compareSatoshi('50', '100')).toBe(-1);
  });

  it('returns 1 when a > b', () => {
    expect(compareSatoshi('100', '50')).toBe(1);
  });
});
