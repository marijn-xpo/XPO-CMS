import type { FastifyInstance, FastifyRequest } from "fastify";
import { getAsyncDb } from "../../db/async-db.js";
import { authGuard } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";
import { rateLimit } from "../../common/ratelimit.js";

const DAY = 86400000;
const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const dayStr = (ts: number) => new Date(ts).toISOString().slice(0, 10);
function readCookie(req: FastifyRequest, name: string): string {
  const raw = req.headers.cookie || "";
  const m = raw.split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name);
  return m ? decodeURIComponent(m[1] || "") : "";
}

export async function analyticsRoutes(app: FastifyInstance) {
  app.get("/api/analytics", { preHandler: authGuard }, async (req, reply) => {
    const t = tenantOf(req);
    const db = await getAsyncDb();
    const c = async (sql: string, ...p: any[]) => Number(((await db.get<{ c: number }>(sql, p)) || { c: 0 }).c);
    const pagesTotal = await c("SELECT COUNT(*) AS c FROM pages WHERE tenant_id = ?", t);
    const pagesPublished = await c("SELECT COUNT(*) AS c FROM pages WHERE tenant_id = ? AND status = 'published'", t);
    reply.send({
      pages: { total: pagesTotal, published: pagesPublished, draft: pagesTotal - pagesPublished },
      media: await c("SELECT COUNT(*) AS c FROM media WHERE tenant_id = ?", t),
      forms: await c("SELECT COUNT(*) AS c FROM forms WHERE tenant_id = ?", t),
      submissions: await c("SELECT COUNT(*) AS c FROM form_submissions WHERE tenant_id = ?", t),
      products: await c("SELECT COUNT(*) AS c FROM products WHERE tenant_id = ?", t),
      orders: await c("SELECT COUNT(*) AS c FROM orders WHERE tenant_id = ?", t),
      tickets: { total: await c("SELECT COUNT(*) AS c FROM tickets WHERE tenant_id = ?", t), open: await c("SELECT COUNT(*) AS c FROM tickets WHERE tenant_id = ? AND status = 'Open'", t) },
      kb: await c("SELECT COUNT(*) AS c FROM kb_articles WHERE tenant_id = ?", t),
      campaigns: await c("SELECT COUNT(*) AS c FROM campaigns WHERE tenant_id = ?", t),
      languages: await c("SELECT COUNT(*) AS c FROM languages WHERE tenant_id = ?", t),
      redirects: await c("SELECT COUNT(*) AS c FROM redirects WHERE tenant_id = ?", t),
      fieldGroups: await c("SELECT COUNT(*) AS c FROM field_groups WHERE tenant_id = ?", t),
      templates: await c("SELECT COUNT(*) AS c FROM templates WHERE tenant_id = ?", t),
    });
  });

  app.post("/api/track", async (req, reply) => {
    const rl = rateLimit(`${req.ip}:track`, 600, 60 * 1000);
    if (!rl.ok) return reply.code(204).send();
    const tenant = tenantOf(req);
    const path = clip((req.body as any)?.path, 300) || "/";
    if (/^\/(admin|api|assets|uploads)(\/|$)/.test(path)) return reply.code(204).send();
    let session = readCookie(req, "xpo_v");
    if (!session) {
      session = "v_" + Math.random().toString(36).slice(2, 12);
      reply.header("Set-Cookie", `xpo_v=${session}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`);
    }
    const ref = clip((req.body as any)?.ref, 300);
    const now = Date.now();
    const db = await getAsyncDb();
    await db.run("INSERT INTO pageviews (tenant_id, path, session, ref, day, ts) VALUES (?, ?, ?, ?, ?, ?)", [tenant, path, session, ref, dayStr(now), now]);
    return reply.code(204).send();
  });

  app.get("/api/analytics/overview", { preHandler: authGuard }, async (req, reply) => {
    const tenant = tenantOf(req);
    const db = await getAsyncDb();
    const now = Date.now();
    const n = async (sql: string, ...p: any[]) => Number(((await db.get<{ n: number }>(sql, p)) || { n: 0 }).n);
    const views = (since: number) => n("SELECT COUNT(*) n FROM pageviews WHERE tenant_id = ? AND ts >= ?", tenant, since);
    const sess = (since: number) => n("SELECT COUNT(DISTINCT session) n FROM pageviews WHERE tenant_id = ? AND ts >= ?", tenant, since);
    const totalViews = await n("SELECT COUNT(*) n FROM pageviews WHERE tenant_id = ?", tenant);

    const weeks: { label: string; views: number; sessions: number }[] = [];
    for (let i = 7; i >= 0; i--) {
      const start = now - (i + 1) * 7 * DAY, end = now - i * 7 * DAY;
      const v = await n("SELECT COUNT(*) n FROM pageviews WHERE tenant_id = ? AND ts >= ? AND ts < ?", tenant, start, end);
      const s = await n("SELECT COUNT(DISTINCT session) n FROM pageviews WHERE tenant_id = ? AND ts >= ? AND ts < ?", tenant, start, end);
      const dt = new Date(start);
      weeks.push({ label: `${dt.getDate()}/${dt.getMonth() + 1}`, views: v, sessions: s });
    }
    const topPages = (await db.all<any>("SELECT path, COUNT(*) views, COUNT(DISTINCT session) sessions FROM pageviews WHERE tenant_id = ? AND ts >= ? GROUP BY path ORDER BY views DESC LIMIT 8", [tenant, now - 30 * DAY]))
      .map((r) => ({ path: r.path, views: Number(r.views), sessions: Number(r.sessions) }));

    return reply.send({
      totals: { viewsAll: totalViews, views7: await views(now - 7 * DAY), views30: await views(now - 30 * DAY), sessions7: await sess(now - 7 * DAY), sessions30: await sess(now - 30 * DAY) },
      weeks, topPages,
    });
  });
}
