// Brute-force-bescherming voor logins (store-abstractie: nu in-memory, klaar voor Redis).
type Entry = { fails: number; until: number };
const store = new Map<string, Entry>();
const MAX_FAILS = Number(process.env.XPO_LOGIN_MAXFAILS || 8);
const WINDOW_MS = Number(process.env.XPO_LOGIN_WINDOW || 15 * 60 * 1000);

export function loginGuard(key: string): { ok: boolean; retryAfter: number } {
  const e = store.get(key);
  const now = Date.now();
  if (e && e.until > now) return { ok: false, retryAfter: Math.ceil((e.until - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}
export function recordLoginResult(key: string, success: boolean) {
  if (success) { store.delete(key); return; }
  const now = Date.now();
  const e = store.get(key) || { fails: 0, until: 0 };
  e.fails += 1;
  if (e.fails >= MAX_FAILS) { e.until = now + WINDOW_MS; e.fails = 0; } // lockout-venster
  store.set(key, e);
}
export function resetLockout() { store.clear(); }
