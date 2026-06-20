import { formatAssetDisplay } from '../../src/shared/money/index';

describe('formatAssetDisplay', () => {
  it('formats BTC with 8 decimals', () => {
    expect(formatAssetDisplay('100000', 8, 'BTC')).toBe('0.00100000 BTC');
  });

  it('formats TRX with 6 decimals', () => {
    expect(formatAssetDisplay('1000000', 6, 'TRX')).toBe('1.000000 TRX');
  });

  it('formats USDT with 6 decimals', () => {
    expect(formatAssetDisplay('5000000', 6, 'USDT')).toBe('5.000000 USDT');
  });

  it('formats zero amount', () => {
    expect(formatAssetDisplay('0', 6, 'TRX')).toBe('0.000000 TRX');
  });

  it('formats zero BTC', () => {
    expect(formatAssetDisplay('0', 8, 'BTC')).toBe('0.00000000 BTC');
  });

  it('formats large USDT amount', () => {
    expect(formatAssetDisplay('1000000000000', 6, 'USDT')).toBe('1000000.000000 USDT');
  });
});
