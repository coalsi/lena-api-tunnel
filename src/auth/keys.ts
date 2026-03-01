import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const KEY_PREFIX = "at_sk_";

/** Generate a new API key. Returns the plaintext key (show once) and its hash (store). */
export function generateApiKey(): { plaintext: string; hash: string } {
  const bytes = randomBytes(32); // 256 bits
  const plaintext = KEY_PREFIX + bytes.toString("hex");
  const hash = hashKey(plaintext);
  return { plaintext, hash };
}

/** Hash a key for storage. */
export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Constant-time comparison of a plaintext key against a stored hash. */
export function validateKey(plaintext: string, storedHash: string): boolean {
  const incomingHash = hashKey(plaintext);
  const a = Buffer.from(incomingHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
