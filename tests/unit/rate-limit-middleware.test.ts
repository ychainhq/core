/**
 * Rate-limit middleware unit tests.
 *
 * Config is mocked with small limits (5 general / 10 signer) so tests run quickly
 * without waiting for real 60-second windows.
 *
 * Each test group uses a unique IP suffix so module-level window state doesn't bleed
 * across tests. Fake timers advance past WINDOW_MS to expire the window between groups
 * where necessary.
 */

import type { Request, Response, NextFunction } from 'express';
import type { Socket } from 'net';

jest.mock('../../src/config/index', () => ({
  config: {
    RATE_LIMIT_PER_MIN: 5,
    SIGNER_RATE_LIMIT_PER_MIN: 10,
  },
}));

// Import after mock is set up
import { rateLimitMiddleware } from '../../src/shared/rate-limit/middleware';

// ── Helpers ──────────────────────────────────────────────────────────────────

let ipSuffix = 0;
function makeReq(path: string, opts: { apiKeyId?: string; ip?: string } = {}): Request {
  const ip = opts.ip ?? `10.0.0.${++ipSuffix}`;
  return {
    path,
    ip,
    socket: { remoteAddress: ip } as Socket,
    apiKeyId: opts.apiKeyId,
  } as unknown as Request;
}

function makeRes(): Response {
  return {
    setHeader: jest.fn(),
  } as unknown as Response;
}

function makeNext(): jest.MockedFunction<NextFunction> {
  return jest.fn();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('rateLimitMiddleware', () => {

  describe('path routing — limit tier selection', () => {
    it('applies SIGNER_RATE_LIMIT_PER_MIN (10) to /external-signers/:id/tasks', () => {
      const next = makeNext();
      // Hit the endpoint 10 times — all should pass (limit = 10)
      const req = makeReq('/external-signers/signer_abc/tasks', { ip: '10.1.0.1' });
      for (let i = 0; i < 10; i++) {
        rateLimitMiddleware(req, makeRes(), next);
      }
      expect(next).toHaveBeenCalledTimes(10);
      // 11th should be rejected
      const next11 = makeNext();
      rateLimitMiddleware(req, makeRes(), next11);
      expect(next11).toHaveBeenCalledWith(expect.any(Error));
    });

    it('applies RATE_LIMIT_PER_MIN (5) to /wallets', () => {
      const next = makeNext();
      const req = makeReq('/wallets', { ip: '10.1.0.2' });
      for (let i = 0; i < 5; i++) {
        rateLimitMiddleware(req, makeRes(), next);
      }
      expect(next).toHaveBeenCalledTimes(5);
      // 6th should be rejected
      const next6 = makeNext();
      rateLimitMiddleware(req, makeRes(), next6);
      expect(next6).toHaveBeenCalledWith(expect.any(Error));
    });

    it('applies SIGNER_RATE_LIMIT_PER_MIN to /external-signers/:id/heartbeat', () => {
      const req = makeReq('/external-signers/signer_abc/heartbeat', { ip: '10.1.0.3' });
      const successfulNexts: jest.MockedFunction<NextFunction>[] = [];
      // Up to 10 should pass
      for (let i = 0; i < 10; i++) {
        const next = makeNext();
        successfulNexts.push(next);
        rateLimitMiddleware(req, makeRes(), next);
      }
      successfulNexts.forEach(n => expect(n).toHaveBeenCalledWith(/* no error */));
      // 11th fails
      const next11 = makeNext();
      rateLimitMiddleware(req, makeRes(), next11);
      expect(next11).toHaveBeenCalledWith(expect.any(Error));
    });

    it('applies SIGNER_RATE_LIMIT_PER_MIN to /external-signers/:id/tasks/:tid/claim', () => {
      const req = makeReq('/external-signers/signer_abc/tasks/task_xyz/claim', { ip: '10.1.0.4' });
      for (let i = 0; i < 10; i++) {
        rateLimitMiddleware(req, makeRes(), makeNext());
      }
      const next11 = makeNext();
      rateLimitMiddleware(req, makeRes(), next11);
      expect(next11).toHaveBeenCalledWith(expect.any(Error));
    });

    it('applies RATE_LIMIT_PER_MIN (5) to /external-signers (management list — no signer ID)', () => {
      const req = makeReq('/external-signers', { ip: '10.1.0.5' });
      for (let i = 0; i < 5; i++) {
        rateLimitMiddleware(req, makeRes(), makeNext());
      }
      const next6 = makeNext();
      rateLimitMiddleware(req, makeRes(), next6);
      expect(next6).toHaveBeenCalledWith(expect.any(Error));
    });

    it('applies RATE_LIMIT_PER_MIN to /external-signers/policies', () => {
      const req = makeReq('/external-signers/policies', { ip: '10.1.0.6' });
      for (let i = 0; i < 5; i++) {
        rateLimitMiddleware(req, makeRes(), makeNext());
      }
      const next6 = makeNext();
      rateLimitMiddleware(req, makeRes(), next6);
      expect(next6).toHaveBeenCalledWith(expect.any(Error));
    });

    it('applies RATE_LIMIT_PER_MIN to /external-signers/:id/enable (management action)', () => {
      const req = makeReq('/external-signers/signer_abc/enable', { ip: '10.1.0.7' });
      for (let i = 0; i < 5; i++) {
        rateLimitMiddleware(req, makeRes(), makeNext());
      }
      const next6 = makeNext();
      rateLimitMiddleware(req, makeRes(), next6);
      expect(next6).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('rate limiting behaviour', () => {
    it('sets X-RateLimit headers on every allowed request', () => {
      const req = makeReq('/wallets', { ip: '10.2.0.1' });
      const res = makeRes();
      const next = makeNext();
      rateLimitMiddleware(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 5);
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 4);
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(Number));
    });

    it('decrements X-RateLimit-Remaining on each request', () => {
      const req = makeReq('/wallets', { ip: '10.2.0.2' });
      for (let i = 0; i < 3; i++) {
        const res = makeRes();
        rateLimitMiddleware(req, res, makeNext());
        const setHeaderMock = res.setHeader as jest.Mock;
        const remainingCall = setHeaderMock.mock.calls.find(
          (c: unknown[]) => c[0] === 'X-RateLimit-Remaining',
        );
        expect(remainingCall?.[1]).toBe(5 - i - 1);
      }
    });

    it('passes no argument to next() when within limit', () => {
      const req = makeReq('/wallets', { ip: '10.2.0.3' });
      const next = makeNext();
      rateLimitMiddleware(req, makeRes(), next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0]).toHaveLength(0);
    });

    it('passes an Error to next() when limit is exceeded', () => {
      const req = makeReq('/wallets', { ip: '10.2.0.4' });
      for (let i = 0; i < 5; i++) {
        rateLimitMiddleware(req, makeRes(), makeNext());
      }
      const next = makeNext();
      rateLimitMiddleware(req, makeRes(), next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
      const err = next.mock.calls[0]?.[0] as unknown as Error;
      expect(err.message).toMatch(/rate limit exceeded/i);
    });

    it('uses apiKeyId as the rate limit bucket when present', () => {
      const ip = '10.2.0.5';
      // Two requests from the same API key but different IPs — share a bucket
      const req1 = makeReq('/wallets', { apiKeyId: 'key_shared', ip });
      const req2 = makeReq('/wallets', { apiKeyId: 'key_shared', ip: '10.2.0.50' });

      for (let i = 0; i < 5; i++) {
        rateLimitMiddleware(i % 2 === 0 ? req1 : req2, makeRes(), makeNext());
      }
      // 6th from either IP (same key) should be rejected
      const next6 = makeNext();
      rateLimitMiddleware(req1, makeRes(), next6);
      expect(next6).toHaveBeenCalledWith(expect.any(Error));
    });

    it('gives independent buckets to different apiKeyIds', () => {
      const req1 = makeReq('/wallets', { apiKeyId: 'key_A', ip: '10.2.0.6' });
      const req2 = makeReq('/wallets', { apiKeyId: 'key_B', ip: '10.2.0.6' });

      // Exhaust key_A's budget
      for (let i = 0; i < 5; i++) {
        rateLimitMiddleware(req1, makeRes(), makeNext());
      }
      // key_B still has a full budget
      const next = makeNext();
      rateLimitMiddleware(req2, makeRes(), next);
      expect(next).toHaveBeenCalledWith(/* no error */);
      expect(next.mock.calls[0]).toHaveLength(0);
    });
  });

  describe('health endpoint skip', () => {
    it('skips rate limiting for /health path', () => {
      const req = makeReq('/health', { ip: '10.3.0.1' });
      // Hitting /health 1000 times should never be rejected
      for (let i = 0; i < 1000; i++) {
        const next = makeNext();
        rateLimitMiddleware(req, makeRes(), next);
        expect(next.mock.calls[0]).toHaveLength(0); // no error arg
      }
    });
  });
});
