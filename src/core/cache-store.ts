// Cache-store-abstractie: standaard in-memory, met een Redis-driver die aanslaat zodra REDIS_URL
// gezet is (en 'ioredis' geïnstalleerd). Zelfde API, dus horizontaal schalen is een config-stap.
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, val: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
  delPrefix(prefix: string): Promise<void>;
  kind: string;
}

class MemoryStore implements CacheStore {
  kind = "memory";
  private m = new Map<string, { v: string; exp: number }>();
  async get(k: string) { const e = this.m.get(k); if (!e) return null; if (e.exp < Date.now()) { this.m.delete(k); return null; } return e.v; }
  async set(k: string, v: string, ttlMs: number) { this.m.set(k, { v, exp: Date.now() + ttlMs }); }
  async del(k: string) { this.m.delete(k); }
  async delPrefix(p: string) { for (const k of this.m.keys()) if (k.startsWith(p)) this.m.delete(k); }
}

class RedisStore implements CacheStore {
  kind = "redis";
  private r: any;
  constructor(client: any) { this.r = client; }
  async get(k: string) { return await this.r.get(k); }
  async set(k: string, v: string, ttlMs: number) { await this.r.set(k, v, "PX", ttlMs); }
  async del(k: string) { await this.r.del(k); }
  async delPrefix(p: string) { const keys = await this.r.keys(p + "*"); if (keys.length) await this.r.del(...keys); }
}

let store: CacheStore | null = null;
export async function getStore(): Promise<CacheStore> {
  if (store) return store;
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const mod = "ioredis";
      const IORedis = (await import(mod)).default;
      store = new RedisStore(new IORedis(url));
      return store;
    } catch { /* val terug op memory als ioredis ontbreekt */ }
  }
  store = new MemoryStore();
  return store;
}
