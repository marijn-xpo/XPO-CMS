import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";
import { PagesRepo } from "../pages/pages.repository.js";
import { PostsRepo } from "../posts/posts.routes.js";
import { SettingsRepo } from "../settings/settings.routes.js";
import { analyzeSeo } from "./analyze.js";

export type Redirect = { id: string; from: string; to: string; code: string };

function normPath(s: unknown): string {
  let t = String(s ?? "").trim().slice(0, 400);
  if (t && t[0] !== "/" && !/^https?:\/\//i.test(t)) t = "/" + t;
  return t;
}
function normCode(s: unknown): string {
  return String(s) === "302" ? "302" : "301";
}
function rid(): string {
  return "rd_" + Math.random().toString(36).slice(2, 9);
}

export const RedirectsRepo = {
  list(tenant: string): Redirect[] {
    const rows = getDb()
      .prepare("SELECT id, from_path, to_path, code FROM redirects WHERE tenant_id = ? ORDER BY created_at DESC")
      .all(tenant) as any[];
    return rows.map((r) => ({ id: r.id, from: r.from_path, to: r.to_path, code: r.code }));
  },
  create(tenant: string, from: string, to: string, code: string): Redirect {
    const id = rid();
    getDb()
      .prepare("INSERT INTO redirects (id, tenant_id, from_path, to_path, code, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, tenant, from, to, code, Date.now());
    return { id, from, to, code };
  },
  remove(tenant: string, id: string): boolean {
    const r = getDb().prepare("DELETE FROM redirects WHERE tenant_id = ? AND id = ?").run(tenant, id);
    return r.changes > 0;
  },
  findByFrom(tenant: string, path: string): Redirect | null {
    const row = getDb()
      .prepare("SELECT id, from_path, to_path, code FROM redirects WHERE tenant_id = ? AND from_path = ? LIMIT 1")
      .get(tenant, path) as any;
    return row ? { id: row.id, from: row.from_path, to: row.to_path, code: row.code } : null;
  },
};

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
}

export async function seoRoutes(app: FastifyInstance) {
  // RankMath-achtige content-analyse voor een pagina
  app.post("/api/seo/analyze", { preHandler: authGuard }, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const tenant = tenantOf(req);
    let page: any = null;
    if (b.pageId != null) page = PagesRepo.get(tenant, Number(b.pageId));
    if (!page && b.page) page = b.page; // sta ook een inline (ongesaved) pagina toe
    if (!page) return reply.code(404).send({ error: "Pagina niet gevonden" });
    return reply.send(analyzeSeo(page, b.keyword));
  });
  app.get("/api/redirects", { preHandler: authGuard }, async (req, reply) =>
    reply.send(RedirectsRepo.list(tenantOf(req)))
  );

  app.post("/api/redirects", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const from = normPath(b.from);
    if (!from) return reply.code(400).send({ error: "Bron-URL is verplicht", issues: [{ path: "from", message: "Bron-URL is verplicht" }] });
    return reply.code(201).send(RedirectsRepo.create(tenantOf(req), from, normPath(b.to) || "/", normCode(b.code)));
  });

  app.delete("/api/redirects/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const ok = RedirectsRepo.remove(tenantOf(req), String((req.params as any).id));
    if (!ok) return reply.code(404).send({ error: "Redirect niet gevonden" });
    return reply.send({ ok: true });
  });

  // publieke sitemap van gepubliceerde pagina's
  app.get("/sitemap.xml", async (req, reply) => {
    const tenant = tenantOf(req);
    const base = (req.headers["x-forwarded-proto"] ? String(req.headers["x-forwarded-proto"]) : "https") + "://" + (req.headers.host || "localhost");
    const pages = PagesRepo.list(tenant).filter((p) => p.status === "published" && p.published);
    const urls = pages
      .map((p) => {
        const loc = xmlEscape(base + "/site/" + p.slug);
        const lastmod = new Date(p.updatedAt).toISOString().slice(0, 10);
        return `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`;
      })
      .join("\n");
    reply.type("application/xml");
    return reply.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
  });

  // RSS-feed van gepubliceerde blogposts
  app.get("/feed.xml", async (req, reply) => {
    const tenant = tenantOf(req);
    const base = (req.headers["x-forwarded-proto"] ? String(req.headers["x-forwarded-proto"]) : "https") + "://" + (req.headers.host || "localhost");
    const site = SettingsRepo.get(tenant).site?.title || "XPO Screens";
    const posts = PostsRepo.list(tenant).filter((p) => p.status === "published" && p.published).slice(0, 50);
    const items = posts.map((p) => {
      const link = xmlEscape(base + "/blog/" + p.slug);
      const date = new Date(p.updatedAt || Date.now()).toUTCString();
      return `    <item><title>${xmlEscape(p.title)}</title><link>${link}</link><guid>${link}</guid><pubDate>${date}</pubDate><description>${xmlEscape(p.seo?.description || "")}</description></item>`;
    }).join("\n");
    reply.type("application/rss+xml");
    return reply.send(`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n  <title>${xmlEscape(site)}</title>\n  <link>${xmlEscape(base)}</link>\n  <description>${xmlEscape(site)} — blog</description>\n${items}\n</channel></rss>`);
  });

  // robots.txt met verwijzing naar de sitemap
  app.get("/robots.txt", async (req, reply) => {
    const base = (req.headers["x-forwarded-proto"] ? String(req.headers["x-forwarded-proto"]) : "https") + "://" + (req.headers.host || "localhost");
    reply.type("text/plain");
    return reply.send(`User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\nDisallow: /zoeken\n\nSitemap: ${base}/sitemap.xml`);
  });
}
