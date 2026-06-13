/**
 * Unit tests — BitcoinAdapter.importSolvableAddressForTenant (Bug 1 regression)
 *
 * Verifies that the treasury hot wallet address is imported with a wpkh(<pubkey>)
 * descriptor (solvable) rather than addr(<address>) (watch-only, not solvable).
 *
 * Bitcoin Core needs `solvable: true` to build PSBTs with pre-selected inputs.
 * addr() imports set solvable=false → walletcreatefundedpsbt fails with error -4.
 */

import { BitcoinAdapter } from '../../src/chain-adapters/bitcoin/adapter';
import { BitcoinRpcClient } from '../../src/chain-adapters/bitcoin/rpc-client';
import { NodeSelector } from '../../src/chain-adapters/node-selector';

jest.mock('../../src/chain-adapters/bitcoin/rpc-client');
jest.mock('../../src/chain-adapters/node-selector', () => ({
  NodeSelector: jest.fn().mockImplementation(() => ({ chainId: 'bitcoin', getNodes: jest.fn() })),
}));

const MockedRpcClient = BitcoinRpcClient as jest.MockedClass<typeof BitcoinRpcClient>;

describe('BitcoinAdapter.importSolvableAddressForTenant — wpkh descriptor', () => {
  let adapter: BitcoinAdapter;
  let mockImportDescriptors: jest.Mock;

  beforeEach(() => {
    mockImportDescriptors = jest.fn().mockResolvedValue(undefined);

    MockedRpcClient.mockImplementation(() => ({
      importDescriptors: mockImportDescriptors,
      getDescriptorInfo: jest.fn().mockImplementation(async (desc: string) => ({
        descriptor: `${desc}#fakechecksum`,
        checksum: 'fakechecksum',
        isrange: false,
        issolvable: true,
        hasprivatekeys: false,
      })),
      loadOrCreateWallet: jest.fn().mockResolvedValue(undefined),
      call: jest.fn().mockResolvedValue(undefined),
    } as any));

    adapter = new BitcoinAdapter(new NodeSelector('bitcoin', null));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('calls importDescriptors with wpkh(<pubkey>) descriptor', async () => {
    const pubkey = '0287b08517c99760341d53f6e058878914d22b9a3e8b6a0378edb66eb627da1cdf';
    await adapter.importSolvableAddressForTenant(pubkey, 'tenant_default', 'tenant_hot');

    expect(mockImportDescriptors).toHaveBeenCalledTimes(1);
    const [descriptors] = mockImportDescriptors.mock.calls[0] as [Array<{ desc: string }>];
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]!.desc).toMatch(/^wpkh\(/);
    expect(descriptors[0]!.desc).toContain(pubkey);
  });

  test('does NOT use addr() descriptor (which gives solvable=false)', async () => {
    const pubkey = '0287b08517c99760341d53f6e058878914d22b9a3e8b6a0378edb66eb627da1cdf';
    await adapter.importSolvableAddressForTenant(pubkey, 'tenant_default', 'tenant_hot');

    const [descriptors] = mockImportDescriptors.mock.calls[0] as [Array<{ desc: string }>];
    expect(descriptors[0]!.desc).not.toMatch(/^addr\(/);
  });

  test('uses timestamp=now for fresh address (no historical rescan)', async () => {
    const pubkey = '0287b08517c99760341d53f6e058878914d22b9a3e8b6a0378edb66eb627da1cdf';
    await adapter.importSolvableAddressForTenant(pubkey, 'tenant_default', 'tenant_hot');

    const [descriptors] = mockImportDescriptors.mock.calls[0] as [any[]];
    expect(descriptors[0].timestamp).toBe('now');
  });

  test('passes the label to the descriptor entry', async () => {
    const pubkey = '0287b08517c99760341d53f6e058878914d22b9a3e8b6a0378edb66eb627da1cdf';
    await adapter.importSolvableAddressForTenant(pubkey, 'tenant_default', 'tenant_hot');

    const [descriptors] = mockImportDescriptors.mock.calls[0] as [any[]];
    expect(descriptors[0].label).toBe('tenant_hot');
  });
});

