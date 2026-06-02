// Mock the async DbClient used by idempotency.service
// IdempotencyService now uses getDbClient() from db/client.ts (not getDb() from sqlite.ts)

const rows: Record<string, {
  tenant_id: string; key: string; operation: string;
  result: string; status_code: number;
  created_at: string; expires_at: string;
}> = {};

const mockDb = {
  isPg: false,
  async all(sql: string, params: unknown[] = []) {
    if (sql.includes('SELECT') && sql.includes('idempotency_keys')) {
      const [tenantId, key, operation, expiresCheck] = params as string[];
      const rowKey = `${tenantId}:${key}:${operation}`;
      const row = rows[rowKey];
      if (!row) return [];
      if (expiresCheck && row.expires_at <= expiresCheck) return [];
      return [row];
    }
    return [];
  },
  async get(sql: string, params: unknown[] = []) {
    if (sql.includes('idempotency_keys')) {
      const [tenantId, key, operation, expiresCheck] = params as string[];
      const rowKey = `${tenantId}:${key}:${operation}`;
      const row = rows[rowKey];
      if (!row) return undefined;
      if (expiresCheck && row.expires_at <= expiresCheck) return undefined;
      return row;
    }
    return undefined;
  },
  async run(sql: string, params: unknown[] = []) {
    if (sql.includes('INSERT') && sql.includes('idempotency_keys')) {
      // Handles both INSERT (first time) and ON CONFLICT DO UPDATE (upsert)
      const [tenantId, key, operation, result, statusCode, createdAt, expiresAt] = params as any[];
      rows[`${tenantId}:${key}:${operation}`] = {
        tenant_id: tenantId, key, operation, result,
        status_code: statusCode, created_at: createdAt, expires_at: expiresAt,
      };
    } else if (sql.includes('DELETE')) {
      const [expiresCutoff] = params as string[];
      for (const k of Object.keys(rows)) {
        if (rows[k].expires_at <= expiresCutoff) delete rows[k];
      }
    }
    return { changes: 1, lastInsertRowid: 0n };
  },
  async exec() {},
  async close() {},
  async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> { return fn(mockDb); },
};

jest.mock('../src/db/client', () => ({
  getDbClient: () => mockDb,
  resetDbClient: jest.fn(),
}));

jest.useFakeTimers();

import { IdempotencyService } from '../src/modules/idempotency/idempotency.service';

describe('IdempotencyService', () => {
  let service: IdempotencyService;

  beforeEach(() => {
    // Clear rows between tests
    for (const k of Object.keys(rows)) delete rows[k];
    service = new IdempotencyService();
  });

  const TENANT = 'tenant_test';

  describe('get', () => {
    it('returns null for non-existent key', async () => {
      const result = await service.get(TENANT, 'nonexistent-key', 'payment_request');
      expect(result).toBeNull();
    });

    it('returns stored result for existing key', async () => {
      const testResult = { data: { id: 'payreq_123', status: 'pending' } };
      await service.save(TENANT, 'key-1', 'payment_request', testResult, 201);

      const result = await service.get(TENANT, 'key-1', 'payment_request');
      expect(result).not.toBeNull();
      expect(result!.statusCode).toBe(201);
      expect(result!.result).toEqual(testResult);
    });

    it('returns null for different operation', async () => {
      await service.save(TENANT, 'key-1', 'payment_request', { data: {} }, 201);
      const result = await service.get(TENANT, 'key-1', 'broadcast');
      expect(result).toBeNull();
    });
  });

  describe('save', () => {
    it('saves and retrieves idempotency result', async () => {
      const payload = { data: { txHash: 'abc123', status: 'broadcasted' } };
      await service.save(TENANT, 'tx-key-1', 'broadcast', payload, 200);

      const result = await service.get(TENANT, 'tx-key-1', 'broadcast');
      expect(result).not.toBeNull();
      expect(result!.result).toEqual(payload);
      expect(result!.statusCode).toBe(200);
    });

    it('stores different operations under different keys', async () => {
      const payreqResult = { data: { id: 'payreq_1' } };
      const broadcastResult = { data: { txHash: 'hash1' } };

      await service.save(TENANT, 'shared-key', 'payment_request', payreqResult, 201);
      await service.save(TENANT, 'shared-key', 'broadcast', broadcastResult, 200);

      const pr = await service.get(TENANT, 'shared-key', 'payment_request');
      const bc = await service.get(TENANT, 'shared-key', 'broadcast');

      expect(pr!.result).toEqual(payreqResult);
      expect(bc!.result).toEqual(broadcastResult);
    });

    it('overwrites existing key with same key+operation', async () => {
      const first  = { data: { attempt: 1 } };
      const second = { data: { attempt: 2 } };

      await service.save(TENANT, 'overwrite-key', 'broadcast', first,  200);
      await service.save(TENANT, 'overwrite-key', 'broadcast', second, 200);

      const result = await service.get(TENANT, 'overwrite-key', 'broadcast');
      expect(result!.result).toEqual(second);
    });
  });

  describe('cleanup', () => {
    it('can be called without errors', async () => {
      await expect(service.cleanup()).resolves.not.toThrow();
    });
  });
});
