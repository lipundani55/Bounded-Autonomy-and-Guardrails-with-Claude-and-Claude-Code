import { describe, expect, it } from 'vitest';

import {
  ReviewError,
  withRetry,
  withTimeout
} from '../src/utils/error-handler.js';
import { RateLimiter, withRateLimit } from '../src/utils/rate-limiter.js';

describe('Error handling', () => {
  it('should retry and return a successful result', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary failure');
      return 'ok';
    }, 1, 0);

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('should throw a ReviewError after retry exhaustion', async () => {
    await expect(withRetry(async () => {
      throw new Error('persistent failure');
    }, 1, 0)).rejects.toBeInstanceOf(ReviewError);
  });

  it('should reject with AGENT_TIMEOUT when a timeout expires', async () => {
    await expect(withTimeout(
      () => new Promise(resolve => setTimeout(resolve, 50)),
      1,
      'test timeout'
    )).rejects.toMatchObject({ code: 'AGENT_TIMEOUT' });
  });
});

describe('RateLimiter', () => {
  it('should enforce custom concurrency and token limits', async () => {
    const limiter = new RateLimiter({
      maxRequestsPerMinute: 2,
      maxTokensPerMinute: 1500,
      maxConcurrent: 1
    });

    await limiter.acquire(1000);
    expect(limiter.canProceed(501)).toBe(false);
    limiter.release(1000);

    const status = limiter.getStatus();
    expect(status.activeRequests).toBe(0);
    expect(status.requestsInWindow).toBe(1);
  });

  it('should prune records outside the sliding window', () => {
    const limiter = new RateLimiter();
    const status = limiter.getStatus();
    expect(status.requestsInWindow).toBe(0);
  });

  it('should never exceed the configured concurrency during simultaneous acquisitions', async () => {
    const limiter = new RateLimiter({
      maxRequestsPerMinute: 10,
      maxTokensPerMinute: 10000,
      maxConcurrent: 2
    });
    let active = 0;
    let maxActive = 0;

    await Promise.all(Array.from({ length: 8 }, () => withRateLimit(limiter, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 0));
      active -= 1;
    }, 100)));

    expect(maxActive).toBe(2);
    expect(limiter.getStatus().activeRequests).toBe(0);
  });

  it('should reject impossible token estimates without reserving a request slot', async () => {
    const limiter = new RateLimiter({
      maxRequestsPerMinute: 10,
      maxTokensPerMinute: 100,
      maxConcurrent: 1
    });

    await expect(limiter.acquire(101)).rejects.toMatchObject({
      code: 'INVALID_CONFIG'
    });
    expect(limiter.getStatus().activeRequests).toBe(0);
  });

  it('should release a request slot when the limited operation fails', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });

    await expect(withRateLimit(limiter, async () => {
      throw new Error('operation failed');
    })).rejects.toThrow('operation failed');
    expect(limiter.getStatus().activeRequests).toBe(0);
  });
});
