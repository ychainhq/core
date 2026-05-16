// Mock the db module before importing anything that uses it
// Note: jest.mock paths use the TypeScript source path (no .js extension)
jest.mock('../src/db/sqlite', () => {
  const rows: Record<string, { tenant_id: string; key: string; operation: string; result: string; status_code: number; created_at: string; expires_at: string }> = {};

  const db = {
    prepare: jest.fn((sql: string) => {
      return {
        get: jest.fn((...args: any[]) => {
          const [tenantId, key, operation, expiresCheck] = args;
          const rowKey = `${tenantId}:${key}:${operation}`;
          const row = rows[rowKey];
          if (!row) return undefined;
          if (expiresCheck && row.expires_at <= expiresCheck) return undefined;
          return row;
        }),
        run: jest.fn((...args: any[]) => {
          if (sql.includes('INSERT OR REPLACE')) {
            const [tenantId, key, operation, result, statusCode, createdAt, expiresAt] = args;
            rows[`${tenantId}:${key}:${operation}`] = { tenant_id: tenantId, key, operation, result, status_code: statusCode, created_at: createdAt, expires_at: expiresAt };
          } else if (sql.includes('DELETE')) {
            const [expiresCutoff] = args;
            for (const k of Object.keys(rows)) {
              if (rows[k].expires_at <= expiresCutoff) {
                delete rows[k];
              }
            }
            return { changes: 0 };
          }
          return { changes: 0 };
        }),
        all: jest.fn(() => []),
      };
    }),
  };
  return { getDb: () => db };
});

// Also mock the setInterval for idempotency cleanup
jest.useFakeTimers();

import { IdempotencyService } from '../src/modules/idempotency/idempotency.service';

describe('IdempotencyService', () => {
  let service: IdempotencyService;

  beforeEach(() => {
    service = new IdempotencyService();
  });

  const TENANT = 'tenant_test';

  describe('get', () => {
    it('returns null for non-existent key', () => {
      const result = service.get(TENANT, 'nonexistent-key', 'payment_request');
      expect(result).toBeNull();
    });

    it('returns stored result for existing key', () => {
      const testResult = { data: { id: 'payreq_123', status: 'pending' } };
      service.save(TENANT, 'key-1', 'payment_request', testResult, 201);

      const result = service.get(TENANT, 'key-1', 'payment_request');
      expect(result).not.toBeNull();
      expect(result!.statusCode).toBe(201);
      expect(result!.result).toEqual(testResult);
    });

    it('returns null for different operation', () => {
      service.save(TENANT, 'key-1', 'payment_request', { data: {} }, 201);
      const result = service.get(TENANT, 'key-1', 'broadcast');
      expect(result).toBeNull();
    });
  });

  describe('save', () => {
    it('saves and retrieves idempotency result', () => {
      const payload = { data: { txHash: 'abc123', status: 'broadcasted' } };
      service.save(TENANT, 'tx-key-1', 'broadcast', payload, 200);

      const result = service.get(TENANT, 'tx-key-1', 'broadcast');
      expect(result).not.toBeNull();
      expect(result!.result).toEqual(payload);
      expect(result!.statusCode).toBe(200);
    });

    it('stores different operations under different keys', () => {
      const payreqResult = { data: { id: 'payreq_1' } };
      const broadcastResult = { data: { txHash: 'hash1' } };

      service.save(TENANT, 'shared-key', 'payment_request', payreqResult, 201);
      service.save(TENANT, 'shared-key', 'broadcast', broadcastResult, 200);

      const pr = service.get(TENANT, 'shared-key', 'payment_request');
      const bc = service.get(TENANT, 'shared-key', 'broadcast');

      expect(pr!.result).toEqual(payreqResult);
      expect(bc!.result).toEqual(broadcastResult);
    });

    it('overwrites existing key with same key+operation', () => {
      const first = { data: { attempt: 1 } };
      const second = { data: { attempt: 2 } };

      service.save(TENANT, 'overwrite-key', 'broadcast', first, 200);
      service.save(TENANT, 'overwrite-key', 'broadcast', second, 200);

      const result = service.get(TENANT, 'overwrite-key', 'broadcast');
      expect(result!.result).toEqual(second);
    });
  });

  describe('cleanup', () => {
    it('can be called without errors', () => {
      expect(() => service.cleanup()).not.toThrow();
    });
  });
});
