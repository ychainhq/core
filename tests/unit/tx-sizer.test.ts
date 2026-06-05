/**
 * Unit tests for tx-sizer — pure Bitcoin transaction vsize estimation.
 *
 * All values verified against the segwit weight formula:
 *   weight = 4 * (non-witness bytes) + 1 * (witness bytes)
 *   vsize  = ceil(weight / 4)
 *
 * Reference: https://bitcoinops.org/en/tools/calc-size/
 */

import {
  detectAddressType,
  estimateTxVsize,
  OUTPUT_VBYTES,
  P2WPKH_INPUT_VBYTES,
  TX_OVERHEAD_VBYTES,
} from '../../src/chain-adapters/bitcoin/tx-sizer';

// ─── detectAddressType ─────────────────────────────────────────────────────────

describe('detectAddressType', () => {
  const cases: [string, string, ReturnType<typeof detectAddressType>][] = [
    // ── mainnet ──────────────────────────────────────────────────────────────
    ['mainnet P2PKH',
      '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      'p2pkh'],
    ['mainnet P2SH',
      '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
      'p2sh'],
    ['mainnet P2WPKH (42 chars)',
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      'p2wpkh'],
    ['mainnet P2WSH (62 chars)',
      'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3',
      'p2wsh'],
    ['mainnet P2TR',
      'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297',
      'p2tr'],

    // ── testnet ───────────────────────────────────────────────────────────────
    ['testnet P2PKH',
      'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
      'p2pkh'],
    ['testnet P2SH',
      '2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc',
      'p2sh'],
    ['testnet P2WPKH (42 chars)',
      'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      'p2wpkh'],
    ['testnet P2TR',
      'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c',
      'p2tr'],

    // ── regtest ───────────────────────────────────────────────────────────────
    ['regtest P2WPKH (44 chars)',
      'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
      'p2wpkh'],
  ];

  test.each(cases)('%s → %s', (_label, address, expected) => {
    expect(detectAddressType(address)).toBe(expected);
  });
});

// ─── Output size constants ─────────────────────────────────────────────────────

describe('OUTPUT_VBYTES', () => {
  test('p2pkh = 34 (8 value + 1 scriptLen + 25 script)', () => {
    expect(OUTPUT_VBYTES.p2pkh).toBe(34);
  });
  test('p2sh = 32 (8 + 1 + 23)', () => {
    expect(OUTPUT_VBYTES.p2sh).toBe(32);
  });
  test('p2wpkh = 31 (8 + 1 + 22)', () => {
    expect(OUTPUT_VBYTES.p2wpkh).toBe(31);
  });
  test('p2wsh = 43 (8 + 1 + 34)', () => {
    expect(OUTPUT_VBYTES.p2wsh).toBe(43);
  });
  test('p2tr = 43 (8 + 1 + 34)', () => {
    expect(OUTPUT_VBYTES.p2tr).toBe(43);
  });
});

test('P2WPKH_INPUT_VBYTES = 68', () => {
  expect(P2WPKH_INPUT_VBYTES).toBe(68);
});

test('TX_OVERHEAD_VBYTES = 10.5', () => {
  expect(TX_OVERHEAD_VBYTES).toBe(10.5);
});

// ─── estimateTxVsize ──────────────────────────────────────────────────────────

const WPKH  = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'; // P2WPKH 42 chars
const WPKH2 = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'; // second P2WPKH address
const PKH   = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';          // P2PKH
const PSH   = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';           // P2SH
const P2WSH = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3'; // P2WSH
const PTR   = 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297';  // P2TR

describe('estimateTxVsize', () => {
  test('1 input → 1 P2WPKH payment + 1 P2WPKH change = 141 vbytes', () => {
    // weight = 4*(10+41+31+31) + (2+108) = 4*113 + 110 = 452+110 = 562 → ceil(562/4) = 141
    expect(estimateTxVsize({
      inputCount: 1,
      outputs: [{ address: WPKH }, { address: WPKH2 }],
    })).toBe(141);
  });

  test('1 input → 1 P2PKH payment + 1 P2WPKH change = 144 vbytes', () => {
    // weight = 4*(10+41+34+31) + (2+108) = 4*116 + 110 = 464+110 = 574 → ceil(574/4) = 144
    expect(estimateTxVsize({
      inputCount: 1,
      outputs: [{ address: PKH }, { address: WPKH }],
    })).toBe(144);
  });

  test('1 input → 1 P2SH payment + 1 P2WPKH change = 142 vbytes', () => {
    // weight = 4*(10+41+32+31) + (2+108) = 4*114 + 110 = 456+110 = 566 → ceil(566/4) = 142
    expect(estimateTxVsize({
      inputCount: 1,
      outputs: [{ address: PSH }, { address: WPKH }],
    })).toBe(142);
  });

  test('1 input → 1 P2TR payment + 1 P2WPKH change = 153 vbytes', () => {
    // weight = 4*(10+41+43+31) + (2+108) = 4*125 + 110 = 500+110 = 610 → ceil(610/4) = 153
    expect(estimateTxVsize({
      inputCount: 1,
      outputs: [{ address: PTR }, { address: WPKH }],
    })).toBe(153);
  });

  test('1 input → 1 P2WSH payment + 1 P2WPKH change = 153 vbytes', () => {
    // weight = 4*(10+41+43+31) + (2+108) = 610 → 153
    expect(estimateTxVsize({
      inputCount: 1,
      outputs: [{ address: P2WSH }, { address: WPKH }],
    })).toBe(153);
  });

  test('2 inputs → 1 P2WPKH output (no change) = 178 vbytes', () => {
    // weight = 4*(10+41*2+31) + (2+108*2) = 4*123 + 218 = 492+218 = 710 → ceil(710/4) = 178
    expect(estimateTxVsize({
      inputCount: 2,
      outputs: [{ address: WPKH }],
    })).toBe(178);
  });

  test('2 inputs → 5 P2WPKH outputs + 1 P2WPKH change (batch, 6 outputs) = 333 vbytes', () => {
    // weight = 4*(10+82+186) + (2+216) = 4*278 + 218 = 1112+218 = 1330 → ceil(1330/4) = 333
    expect(estimateTxVsize({
      inputCount: 2,
      outputs: Array(6).fill({ address: WPKH }),
    })).toBe(333);
  });

  test('mixed outputs: P2WPKH + P2TR + P2PKH = correct per-type sizes summed', () => {
    // 1 input, 3 outputs: P2WPKH(31) + P2TR(43) + P2PKH(34) = 108 output bytes
    // weight = 4*(10+41+108) + (2+108) = 4*159 + 110 = 636+110 = 746 → ceil(746/4) = 187
    expect(estimateTxVsize({
      inputCount: 1,
      outputs: [{ address: WPKH }, { address: PTR }, { address: PKH }],
    })).toBe(187);
  });

  test('larger batch: 5 inputs, 20 P2WPKH outputs = 964 vbytes', () => {
    // weight = 4*(10+41*5+31*20) + (2+108*5) = 4*(10+205+620) + 542 = 4*835 + 542 = 3340+542 = 3882
    // → ceil(3882/4) = ceil(970.5) = 971
    expect(estimateTxVsize({
      inputCount: 5,
      outputs: Array(20).fill({ address: WPKH }),
    })).toBe(971);
  });
});
