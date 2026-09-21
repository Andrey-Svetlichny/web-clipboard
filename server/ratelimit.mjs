// Token buckets, in memory. No Redis; a single process is the whole deployment.

export class RateLimiter {
  constructor(capacity, perSeconds, maxKeys = 20_000) {
    this.capacity = capacity;
    this.refill = capacity / perSeconds;   // tokens per second
    this.maxKeys = maxKeys;
    this.buckets = new Map();              // key -> { tokens, last }
  }

  allow(key, at = Date.now() / 1000) {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, last: at };
    const tokens = Math.min(this.capacity, bucket.tokens + (at - bucket.last) * this.refill);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, last: at });
      return false;
    }
    this.buckets.set(key, { tokens: tokens - 1, last: at });
    if (this.buckets.size > this.maxKeys) this.prune(at);
    return true;
  }

  // Buckets that have refilled completely are indistinguishable from new ones.
  prune(at) {
    const fullAfter = this.capacity / this.refill;
    for (const [key, bucket] of this.buckets) {
      if (at - bucket.last > fullAfter) this.buckets.delete(key);
    }
    if (this.buckets.size > this.maxKeys) this.buckets.clear();
  }
}
