'use strict';

/**
 * Sliding-window rate limiter: at most `limit` hits per `windowMs` per key.
 * The clock is injected so tests can control time.
 */
class RateLimiter {
  constructor({ limit, windowMs, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map(); // key -> timestamps, oldest first
  }

  /** Record a hit for `key`. Returns false (and records nothing) if over the limit. */
  take(key) {
    const now = this.now();
    const recent = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  forget(key) {
    this.hits.delete(key);
  }
}

module.exports = { RateLimiter };
