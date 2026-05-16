import { validateBitcoinAddress, validateRawTransaction, validatePsbt, detectAddressType } from '../src/shared/validation/bitcoin';

describe('validateBitcoinAddress - mainnet', () => {
  it('validates P2PKH addresses (legacy)', () => {
    // Well-known addresses with valid checksums
    expect(validateBitcoinAddress('1HLoD9E4SDFFPDiYfNYnkBLQ85Y51J3Zb1', 'mainnet')).toBe(true);
    expect(validateBitcoinAddress('12higDjoCCNXSA95xZMWUdPvXNmkAduhWv', 'mainnet')).toBe(true);
  });

  it('validates P2SH addresses', () => {
    expect(validateBitcoinAddress('3EktnHQD7RiAE6uzMj2ZifT9YgRrkSgzQX', 'mainnet')).toBe(true);
    expect(validateBitcoinAddress('3GRdnTq18LyNveWa1gQJcgp8qEnzijv5vR', 'mainnet')).toBe(true);
  });

  it('validates P2WPKH (bech32) addresses', () => {
    expect(validateBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mainnet')).toBe(true);
    expect(validateBitcoinAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'mainnet')).toBe(true);
  });

  it('validates P2TR (taproot bech32m) addresses', () => {
    // Taproot address on mainnet (bech32m)
    expect(validateBitcoinAddress('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'mainnet')).toBe(true);
  });

  it('rejects invalid addresses', () => {
    expect(validateBitcoinAddress('', 'mainnet')).toBe(false);
    expect(validateBitcoinAddress('not-an-address', 'mainnet')).toBe(false);
    expect(validateBitcoinAddress('0x742d35Cc6634C0532925a3b8D4C9a3d5f1b2e14c', 'mainnet')).toBe(false);
    expect(validateBitcoinAddress('invalid123', 'mainnet')).toBe(false);
  });

  it('rejects testnet addresses on mainnet', () => {
    expect(validateBitcoinAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'mainnet')).toBe(false);
    expect(validateBitcoinAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'mainnet')).toBe(false);
  });

  it('rejects addresses with invalid checksums', () => {
    // Tampered checksum
    expect(validateBitcoinAddress('1HLoD9E4SDFFPDiYfNYnkBLQ85Y51J3Zb2', 'mainnet')).toBe(false);
  });
});

describe('validateBitcoinAddress - testnet', () => {
  it('validates P2PKH testnet addresses', () => {
    expect(validateBitcoinAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'testnet')).toBe(true);
  });

  it('validates P2WPKH testnet (bech32) addresses', () => {
    expect(validateBitcoinAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'testnet')).toBe(true);
  });

  it('rejects mainnet addresses on testnet', () => {
    expect(validateBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'testnet')).toBe(false);
    expect(validateBitcoinAddress('1HLoD9E4SDFFPDiYfNYnkBLQ85Y51J3Zb1', 'testnet')).toBe(false);
  });
});

describe('validateBitcoinAddress - regtest', () => {
  it('validates regtest bech32 addresses', () => {
    expect(validateBitcoinAddress('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', 'regtest')).toBe(true);
  });
});

describe('validateBitcoinAddress - edge cases', () => {
  it('handles null/undefined gracefully', () => {
    expect(validateBitcoinAddress(null as any, 'mainnet')).toBe(false);
    expect(validateBitcoinAddress(undefined as any, 'mainnet')).toBe(false);
  });

  it('handles very long strings', () => {
    expect(validateBitcoinAddress('a'.repeat(1000), 'mainnet')).toBe(false);
  });

  it('rejects addresses with extra whitespace', () => {
    expect(validateBitcoinAddress(' bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mainnet')).toBe(false);
    expect(validateBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 ', 'mainnet')).toBe(false);
  });
});

describe('detectAddressType', () => {
  it('detects P2PKH', () => {
    expect(detectAddressType('1HLoD9E4SDFFPDiYfNYnkBLQ85Y51J3Zb1', 'mainnet')).toBe('p2pkh');
  });

  it('detects P2SH', () => {
    expect(detectAddressType('3EktnHQD7RiAE6uzMj2ZifT9YgRrkSgzQX', 'mainnet')).toBe('p2sh');
  });

  it('detects P2WPKH', () => {
    expect(detectAddressType('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mainnet')).toBe('p2wpkh');
  });

  it('detects P2TR', () => {
    expect(detectAddressType('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'mainnet')).toBe('p2tr');
  });

  it('returns null for invalid address', () => {
    expect(detectAddressType('invalid', 'mainnet')).toBeNull();
  });
});

describe('validateRawTransaction', () => {
  it('returns false for empty string', () => {
    expect(validateRawTransaction('')).toBe(false);
  });

  it('returns false for non-hex string', () => {
    expect(validateRawTransaction('not-hex-data')).toBe(false);
  });

  it('returns false for invalid transaction', () => {
    expect(validateRawTransaction('deadbeef')).toBe(false);
  });

  it('returns false for null', () => {
    expect(validateRawTransaction(null as any)).toBe(false);
  });

  it('validates a known raw transaction', () => {
    // Minimal valid transaction: version=1, 1 input, 1 P2PKH output, locktime=0
    // Generated with bitcoinjs-lib with a valid output script
    const validTx = '010000000100000000000000000000000000000000000000000000000000000000000000000000000000ffffffff0150c30000000000001976a914b3407d4b4d1fca87fb930abe3fa6c2baed6e6fd888ac00000000';
    expect(validateRawTransaction(validTx)).toBe(true);
  });
});

describe('validatePsbt', () => {
  it('returns false for empty string', () => {
    expect(validatePsbt('')).toBe(false);
  });

  it('returns false for invalid base64', () => {
    expect(validatePsbt('not-valid-psbt')).toBe(false);
  });

  it('returns false for null', () => {
    expect(validatePsbt(null as any)).toBe(false);
  });
});
