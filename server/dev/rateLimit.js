'use strict';

/**
 * Rate limiter for developer panel authentication.
 * Rule: 5 failed attempts per 10 minutes per IP, then block that IP for 1 hour.
 */
class DevAuthRateLimiter {
  #attempts = new Map(); // ip -> [timestamp, ...]
  #blocked = new Map(); // ip -> unblockTimestamp
  #windowMs = 10 * 60 * 1000; // 10 minutes
  #maxAttempts = 5;
  #blockDurationMs = 60 * 60 * 1000; // 1 hour
  #now;

  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }

  isBlocked(ip) {
    const unblock = this.#blocked.get(ip);
    if (!unblock) return false;
    const now = this.#now();
    if (now >= unblock) {
      this.#blocked.delete(ip);
      return false;
    }
    return true;
  }

  recordFailure(ip) {
    const now = this.#now();
    if (this.isBlocked(ip)) {
      return { blocked: true, blockedUntil: this.#blocked.get(ip) };
    }
    let list = this.#attempts.get(ip) || [];
    const cutoff = now - this.#windowMs;
    list = list.filter((t) => t > cutoff);
    list.push(now);
    this.#attempts.set(ip, list);

    if (list.length >= this.#maxAttempts) {
      const blockedUntil = now + this.#blockDurationMs;
      this.#blocked.set(ip, blockedUntil);
      this.#attempts.delete(ip);
      return { blocked: true, blockedUntil, firstBlock: true };
    }
    return { blocked: false, attempts: list.length, remaining: this.#maxAttempts - list.length };
  }

  recordSuccess(ip) {
    this.#attempts.delete(ip);
  }

  reset() {
    this.#attempts.clear();
    this.#blocked.clear();
  }
}

module.exports = { DevAuthRateLimiter };
