import { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// In-memory rate limiter — no Redis dependency
// ---------------------------------------------------------------------------
interface WindowEntry {
  count: number;
  resetAt: number; // epoch ms
}

const store = new Map<string, WindowEntry>();

// Clean up expired entries every 5 minutes to avoid memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}, 5 * 60_000).unref();

interface RateLimitOptions {
  windowSeconds: number;
  maxRequests: number;
  message: string;
}

export function createRateLimiter(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip  = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${req.path}:${ip}`;
    const now = Date.now();

    let entry = store.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 1, resetAt: now + options.windowSeconds * 1000 };
      store.set(key, entry);
    } else {
      entry.count++;
    }

    const remaining = Math.max(0, options.maxRequests - entry.count);
    res.setHeader('X-RateLimit-Limit', options.maxRequests);
    res.setHeader('X-RateLimit-Remaining', remaining);

    if (entry.count > options.maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.status(429).json({ error: options.message, retryAfterSeconds: retryAfter });
      return;
    }

    next();
  };
}

export const uploadRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxRequests: 10,
  message: 'Too many conversion requests from this IP. Please try again in a minute.',
});

export const apiRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxRequests: 60,
  message: 'Too many requests. Rate limit exceeded.',
});
