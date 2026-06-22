// eenvoudige in-memory rate-limiter (per sleutel, vast tijdvenster)
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, max: number, windowMs: number): { ok: boolean; retryAfter: number; remaining: number } {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b); }
  b.count++;
  if (b.count > max) return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000), remaining: 0 };
  return { ok: true, retryAfter: 0, remaining: Math.max(0, max - b.count) };
}

// alleen voor tests: maak de teller leeg
export function resetRateLimit(key?: string) { if (key) buckets.delete(key); else buckets.clear(); }
