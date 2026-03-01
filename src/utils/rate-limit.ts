import { FastifyRequest, FastifyReply } from "fastify";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export function createRateLimiter(maxTokens: number = 10, refillRatePerSec: number = 10 / 60) {
  const buckets = new Map<string, Bucket>();

  return async function rateLimitHook(request: FastifyRequest, reply: FastifyReply) {
    const key = request.headers.authorization ?? request.ip;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: maxTokens, lastRefill: now };
      buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsed * refillRatePerSec);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      const retryAfter = Math.ceil((1 - bucket.tokens) / refillRatePerSec);
      reply
        .code(429)
        .header("Retry-After", String(retryAfter))
        .send({ error: { message: "Rate limit exceeded", type: "rate_limit_error" } });
      return reply;
    }

    bucket.tokens -= 1;
  };
}
