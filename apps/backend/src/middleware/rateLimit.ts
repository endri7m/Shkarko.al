import { Request, Response, NextFunction } from 'express';
import { redisConnection } from '../queue'; // share connection

interface RateLimitOptions {
  windowSeconds: number;
  maxRequests: number;
  message: string;
}

/**
 * Creates a Redis-backed rate limiting middleware.
 */
export function createRateLimiter(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Fail-open immediately if Redis is offline/connecting to prevent API hangs
    if (!redisConnection || redisConnection.status !== 'ready') {
      return next();
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `ratelimit:${req.path}:${ip}`;

    try {
      // Use Redis transaction to increment and set expiration atomically
      const multi = redisConnection.multi();
      multi.incr(key);
      multi.ttl(key);
      
      const results = await multi.exec();
      if (!results) {
        return next();
      }

      const count = results[0][1] as number;
      const ttl = results[1][1] as number;

      // If it's a new key, set the expiration window
      if (count === 1 || ttl === -1) {
        await redisConnection.expire(key, options.windowSeconds);
      }

      // Add rate limit headers to response
      res.setHeader('X-RateLimit-Limit', options.maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, options.maxRequests - count));

      if (count > options.maxRequests) {
        return res.status(429).json({
          error: options.message,
          retryAfterSeconds: ttl > 0 ? ttl : options.windowSeconds,
        });
      }

      next();
    } catch (error) {
      console.error('Rate limit middleware error:', error);
      // Fail open in case of Redis failure to maintain service availability, but log it
      next();
    }
  };
}

// Pre-defined rate limit profiles
export const uploadRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxRequests: 10,
  message: 'Too many conversion uploads from this IP. Please try again after a minute.',
});

export const apiRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxRequests: 60,
  message: 'Too many requests. Rate limit exceeded.',
});
