import { ErrorCodes, ReviewError } from './error-handler.js';

/**
 * Rate Limiter for API requests and token usage
 * Prevents exceeding Anthropic API rate limits
 *
 * This implements a token bucket algorithm with sliding window.
 *
 * Concepts:
 * - Tracks requests and tokens used in the last 60 seconds (sliding window)
 * - Limits concurrent requests to prevent overwhelming the API
 * - Uses token estimation to prevent exceeding token-per-minute limits
 */

export interface RateLimiterConfig {
  /** Maximum requests per minute */
  maxRequestsPerMinute: number;
  /** Maximum tokens per minute */
  maxTokensPerMinute: number;
  /** Maximum concurrent requests */
  maxConcurrent: number;
}

export const DEFAULT_RATE_LIMITS: RateLimiterConfig = {
  maxRequestsPerMinute: 50,      // Conservative default
  maxTokensPerMinute: 100000,    // ~100k tokens/min
  maxConcurrent: 5               // Max parallel requests
};

interface RequestRecord {
  timestamp: number;
  tokens: number;
}

/**
 * Token bucket rate limiter with sliding window
 */
export class RateLimiter {
  private readonly config: RateLimiterConfig;
  private requestHistory: RequestRecord[] = [];
  private activeRequests: number = 0;
  private waitQueue: Array<() => void> = [];

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMITS, ...config };

    if (
      !Number.isFinite(this.config.maxRequestsPerMinute) ||
      this.config.maxRequestsPerMinute <= 0 ||
      !Number.isFinite(this.config.maxTokensPerMinute) ||
      this.config.maxTokensPerMinute <= 0 ||
      !Number.isInteger(this.config.maxConcurrent) ||
      this.config.maxConcurrent <= 0
    ) {
      throw new ReviewError(
        'Rate limiter limits must be positive finite values and maxConcurrent must be an integer',
        ErrorCodes.INVALID_CONFIG,
        { config: this.config }
      );
    }
  }

  /**
   * Wait until a request can be made within rate limits
   *
   * This is the main entry point for rate limiting.
   * It ensures:
   * 1. Concurrent request limit is not exceeded
   * 2. Request and token rate limits are respected
   * 3. The request is recorded for future rate limit calculations
   *
   * @param estimatedTokens - Estimated tokens for this request
   */
  async acquire(estimatedTokens: number = 1000): Promise<void> {
    if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
      throw new ReviewError(
        'Estimated tokens must be a non-negative finite number',
        ErrorCodes.INVALID_CONFIG,
        { estimatedTokens }
      );
    }

    if (estimatedTokens > this.config.maxTokensPerMinute) {
      throw new ReviewError(
        'Estimated tokens exceed the configured per-minute token limit',
        ErrorCodes.INVALID_CONFIG,
        { estimatedTokens, maxTokensPerMinute: this.config.maxTokensPerMinute }
      );
    }

    while (true) {
      await this.waitForRateLimit(estimatedTokens);
      await this.waitForSlot();

      if (this.hasRateCapacity(estimatedTokens)) {
        this.requestHistory.push({
          timestamp: Date.now(),
          tokens: estimatedTokens
        });
        return;
      }

      this.release();
    }
  }

  /**
   * Release a request slot after completion
   * @param actualTokens - Actual tokens used (updates estimate)
   */
  release(actualTokens?: number): void {
    if (this.activeRequests === 0) return;
    this.activeRequests -= 1;

    // Update last request with actual token count if provided
    if (actualTokens !== undefined && this.requestHistory.length > 0) {
      const lastRequest = this.requestHistory[this.requestHistory.length - 1];
      if (lastRequest) {
        lastRequest.tokens = actualTokens;
      }
    }

    // Wake up next waiting request
    const next = this.waitQueue.shift();
    if (next) next();
  }

  /**
   * Get current rate limit status
   */
  getStatus(): {
    activeRequests: number;
    requestsInWindow: number;
    tokensInWindow: number;
    availableRequests: number;
    availableTokens: number;
  } {
    this.pruneOldRecords();

    const requestsInWindow = this.requestHistory.length;
    const tokensInWindow = this.requestHistory.reduce((sum, r) => sum + r.tokens, 0);

    return {
      activeRequests: this.activeRequests,
      requestsInWindow,
      tokensInWindow,
      availableRequests: Math.max(0, this.config.maxRequestsPerMinute - requestsInWindow),
      availableTokens: Math.max(0, this.config.maxTokensPerMinute - tokensInWindow)
    };
  }

  /**
   * Check if request can proceed immediately
   *
   * @param estimatedTokens - Estimated tokens for the request
   * @returns true if the request can proceed without waiting
   */
  canProceed(estimatedTokens: number = 1000): boolean {
    return this.activeRequests < this.config.maxConcurrent &&
      this.hasRateCapacity(estimatedTokens);
  }

  /**
   * Wait for a concurrent request slot to become available
   *
   * This creates a Promise that resolves when release() is called
   * and there's a queued waiter.
   */
  private async waitForSlot(): Promise<void> {
    if (this.activeRequests < this.config.maxConcurrent) {
      this.activeRequests += 1;
      return;
    }

    await new Promise<void>(resolve => {
      this.waitQueue.push(() => {
        this.activeRequests += 1;
        resolve();
      });
    });
  }

  /**
   * Wait until rate limits allow the request to proceed
   *
   * This implements the sliding window algorithm.
   * If we can't proceed immediately, we calculate how long to wait
   * until the oldest request expires (falls out of the 60-second window).
   *
   * @param estimatedTokens - Estimated tokens for the request
   */
  private async waitForRateLimit(estimatedTokens: number): Promise<void> {
    while (!this.hasRateCapacity(estimatedTokens)) {
      if (this.requestHistory.length === 0) return;

      const oldestTimestamp = this.requestHistory[0]?.timestamp;
      if (oldestTimestamp === undefined) break;

      const expirationWait = oldestTimestamp + 60000 - Date.now() + 100;
      const waitTime = Math.min(Math.max(100, expirationWait), 5000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  private hasRateCapacity(estimatedTokens: number): boolean {
    this.pruneOldRecords();
    const tokensInWindow = this.requestHistory.reduce((sum, record) => sum + record.tokens, 0);

    return (
      this.requestHistory.length < this.config.maxRequestsPerMinute &&
      tokensInWindow + estimatedTokens <= this.config.maxTokensPerMinute
    );
  }

  /**
   * Remove request records older than 60 seconds (sliding window)
   *
   * This is called before checking rate limits to ensure we only
   * count requests in the current 60-second window.
   */
  private pruneOldRecords(): void {
    const cutoff = Date.now() - 60000;
    this.requestHistory = this.requestHistory.filter(record => record.timestamp > cutoff);
  }
}

/**
 * Wrap an async function with rate limiting
 *
 * This is a convenience function for applying rate limiting to any async operation.
 */
export async function withRateLimit<T>(
  rateLimiter: RateLimiter,
  fn: () => Promise<T>,
  estimatedTokens: number = 1000
): Promise<T> {
  await rateLimiter.acquire(estimatedTokens);
  try {
    return await fn();
  } finally {
    rateLimiter.release();
  }
}

// Global rate limiter instance
export const globalRateLimiter = new RateLimiter();