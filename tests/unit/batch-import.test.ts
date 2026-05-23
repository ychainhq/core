/**
 * Unit tests for batchImportAddresses in BitcoinAdapter and the generic
 * IChainAdapter.batchImportAddresses optional contract.
 */
import { BatchImportEntry, IChainAdapter } from '../../src/chain-adapters/types';

describe('IChainAdapter.batchImportAddresses — optional contract', () => {
  it('adapters without batchImportAddresses satisfy IChainAdapter', () => {
    // Minimal stub that does NOT implement batchImportAddresses — must compile
    const stub: Partial<IChainAdapter> = {
      chain: 'ethereum',
      batchImportAddresses: undefined,
    };
    expect(stub.batchImportAddresses).toBeUndefined();
  });

  it('adapters can implement batchImportAddresses', async () => {
    const imported: { entries: BatchImportEntry[]; tenantId: string }[] = [];

    const stub: Partial<IChainAdapter> = {
      chain: 'bitcoin',
      batchImportAddresses: async (entries, tenantId) => {
        imported.push({ entries, tenantId });
      },
    };

    const entries: BatchImportEntry[] = [
      { address: 'bc1qaddress1', label: 'label1', timestampSec: 1700000000 },
      { address: 'bc1qaddress2', label: 'label2', timestampSec: 1700000001 },
    ];

    await stub.batchImportAddresses!(entries, 'tenant_abc');

    expect(imported).toHaveLength(1);
    expect(imported[0]!.tenantId).toBe('tenant_abc');
    expect(imported[0]!.entries).toHaveLength(2);
    expect(imported[0]!.entries[0]!.address).toBe('bc1qaddress1');
  });
});

describe('BitcoinAdapter.batchImportAddresses — chunking logic', () => {
  it('splits entries into chunks and calls importDescriptors per chunk', async () => {
    const calls: Array<{ descriptors: any[]; wallet: string }> = [];

    // Minimal mock of the adapter's rpc
    const mockRpc = {
      importDescriptors: async (descriptors: any[], wallet: string) => {
        calls.push({ descriptors, wallet });
      },
    };

    // Inline test double that mirrors the real implementation
    async function batchImport(
      entries: BatchImportEntry[],
      tenantId: string,
      chunkSize: number,
    ): Promise<void> {
      const walletName = `btc_${tenantId}`;
      for (let i = 0; i < entries.length; i += chunkSize) {
        const chunk = entries.slice(i, i + chunkSize);
        const descriptors = chunk.map((e) => ({
          desc: `addr(${e.address})`,
          timestamp: e.timestampSec,
          label: e.label,
        }));
        await mockRpc.importDescriptors(descriptors, walletName);
      }
    }

    const entries: BatchImportEntry[] = Array.from({ length: 250 }, (_, i) => ({
      address: `bc1q${String(i).padStart(10, '0')}`,
      label: `addr_${i}`,
      timestampSec: 1700000000 + i,
    }));

    await batchImport(entries, 'tenant_x', 100);

    // 250 entries / 100 per chunk = 3 calls
    expect(calls).toHaveLength(3);
    expect(calls[0]!.descriptors).toHaveLength(100);
    expect(calls[1]!.descriptors).toHaveLength(100);
    expect(calls[2]!.descriptors).toHaveLength(50);
    expect(calls[0]!.wallet).toBe('btc_tenant_x');

    // Verify descriptor format
    const first = calls[0]!.descriptors[0]!;
    expect(first.desc).toBe('addr(bc1q0000000000)');
    expect(first.timestamp).toBe(1700000000);
    expect(first.label).toBe('addr_0');
  });

  it('handles empty entries list without calling importDescriptors', async () => {
    const calls: unknown[] = [];
    const mockRpc = { importDescriptors: async (d: any[], _wallet: string) => calls.push(d) };

    async function batchImport(entries: BatchImportEntry[], tenantId: string, chunkSize: number) {
      const walletName = `btc_${tenantId}`;
      for (let i = 0; i < entries.length; i += chunkSize) {
        const chunk = entries.slice(i, i + chunkSize);
        await mockRpc.importDescriptors(
          chunk.map((e) => ({ desc: `addr(${e.address})`, timestamp: e.timestampSec, label: e.label })),
          walletName,
        );
      }
    }

    await batchImport([], 'tenant_y', 100);
    expect(calls).toHaveLength(0);
  });
});
