import { Request, Response, NextFunction } from 'express';
import { config } from '../../config/index';
import { TooManyRequestsError } from '../errors/index';

interface WindowEntry {
  count: number;
  windowStart: number;
}

// In-memory sliding window rate limiter
// Key: IP address or API key ID
const windows = new Map<string, WindowEntry>();
const WINDOW_MS = 60_000; // 1 minute

// Cleanup old windows every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows.entries()) {
    if (now - entry.windowStart > WINDOW_MS * 2) {
      windows.delete(key);
    }
  }
}, 5 * 60_000);

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip rate limiting for health endpoint
  if (req.path === '/health') {
    next();
    return;
  }

  const limit = config.RATE_LIMIT_PER_MIN;
  const now = Date.now();

  // Use API key ID if available, otherwise fall back to IP
  const apiKeyId = (req as any).apiKeyId as string | undefined;
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const key = apiKeyId ? `key:${apiKeyId}` : `ip:${ip}`;

  const existing = windows.get(key);

  if (!existing || now - existing.windowStart > WINDOW_MS) {
    // New window
    windows.set(key, { count: 1, windowStart: now });
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', limit - 1);
    res.setHeader('X-RateLimit-Reset', Math.ceil((now + WINDOW_MS) / 1000));
    next();
    return;
  }

  existing.count++;
  const remaining = Math.max(0, limit - existing.count);

  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil((existing.windowStart + WINDOW_MS) / 1000));

  if (existing.count > limit) {
    next(new TooManyRequestsError(`Rate limit exceeded: ${limit} requests per minute`));
    return;
  }

  next();
}
