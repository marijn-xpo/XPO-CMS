import { getDb } from "../db/database.js";

export type Job = { id: number; tenant: string; type: string; payload: any; attempts: number; maxAttempts: number };
type Handler = (payload: any, job: Job) => Promise<void> | void;
const handlers = new Map<string, Handler>();
export function registerJobHandler(type: string, fn: Handler) { handlers.set(type, fn); }

export function enqueue(tenant: string, type: string, payload: any = {}, opts: { maxAttempts?: number; delayMs?: number } = {}): number {
  const now = Date.now();
  const info = getDb().prepare("INSERT INTO jobs (tenant_id, type, payload, status, attempts, max_attempts, run_at, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)")
    .run(tenant, type, JSON.stringify(payload ?? {}), opts.maxAttempts ?? 5, now + (opts.delayMs ?? 0), now, now);
  return Number(info.lastInsertRowid);
}

// Verwerkt één batch verschuldigde jobs. Tests roepen dit expliciet aan voor determinisme.
export async function processJobsNow(limit = 25): Promise<{ processed: number; done: number; failed: number; retried: number }> {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare("SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY id LIMIT ?").all(now, limit) as any[];
  let done = 0, failed = 0, retried = 0;
  for (const r of rows) {
    const job: Job = { id: r.id, tenant: r.tenant_id, type: r.type, payload: JSON.parse(r.payload || "{}"), attempts: r.attempts, maxAttempts: r.max_attempts };
    const h = handlers.get(r.type);
    if (!h) { db.prepare("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?").run("Geen handler voor type " + r.type, Date.now(), r.id); failed++; continue; }
    try {
      await h(job.payload, job);
      db.prepare("UPDATE jobs SET status='done', updated_at=? WHERE id=?").run(Date.now(), r.id);
      done++;
    } catch (e) {
      const attempts = r.attempts + 1;
      if (attempts >= r.max_attempts) {
        db.prepare("UPDATE jobs SET status='failed', attempts=?, error=?, updated_at=? WHERE id=?").run(attempts, String((e as Error).message).slice(0, 500), Date.now(), r.id);
        failed++;
      } else {
        const backoff = Math.min(60000, 1000 * Math.pow(2, attempts)); // exponentiële backoff
        db.prepare("UPDATE jobs SET attempts=?, run_at=?, error=?, updated_at=? WHERE id=?").run(attempts, Date.now() + backoff, String((e as Error).message).slice(0, 500), Date.now(), r.id);
        retried++;
      }
    }
  }
  return { processed: rows.length, done, failed, retried };
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startWorker(intervalMs = 3000) {
  if (timer) return;
  timer = setInterval(() => { processJobsNow().catch(() => { /* */ }); }, intervalMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
}
export function stopWorker() { if (timer) { clearInterval(timer); timer = null; } }

export function queueStats() {
  const db = getDb();
  const by = (s: string) => (db.prepare("SELECT COUNT(*) n FROM jobs WHERE status=?").get(s) as any).n as number;
  return { pending: by("pending"), done: by("done"), failed: by("failed") };
}
