import type { FastifyInstance } from "fastify";
import { signPreview } from "../../common/preview.js";
import { getDb } from "../../db/database.js";
import { SettingsRepo } from "../settings/settings.routes.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";
import { validateTree, type Block } from "../../engine/engine.js";

function clip(s: unknown, n: number): string { return String(s ?? "").trim().slice(0, n); }
function slugify(s: string): string { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

/* ----------------------- taxonomie ----------------------- */
export type Term = { id: string; taxonomy: string; name: string; slug: string; count: number };

export const TermsRepo = {
  list(tenant: string, taxonomy?: string): Term[] {
    const db = getDb();
    const rows = (taxonomy
      ? db.prepare("SELECT id, taxonomy, name, slug FROM terms WHERE tenant_id = ? AND taxonomy = ? ORDER BY name ASC").all(tenant, taxonomy)
      : db.prepare("SELECT id, taxonomy, name, slug FROM terms WHERE tenant_id = ? ORDER BY taxonomy, name").all(tenant)) as any[];
    return rows.map((r) => ({
      ...r,
      count: (db.prepare("SELECT COUNT(*) AS c FROM post_terms WHERE tenant_id = ? AND term_id = ?").get(tenant, r.id) as { c: number }).c,
    }));
  },
  get(tenant: string, id: string): Term | null {
    const r = getDb().prepare("SELECT id, taxonomy, name, slug FROM terms WHERE tenant_id = ? AND id = ?").get(tenant, id) as any;
    return r ? { ...r, count: 0 } : null;
  },
  bySlug(tenant: string, taxonomy: string, slug: string): any {
    return getDb().prepare("SELECT id FROM terms WHERE tenant_id = ? AND taxonomy = ? AND slug = ?").get(tenant, taxonomy, slug);
  },
  create(tenant: string, taxonomy: string, name: string): Term {
    const id = "tm_" + Math.random().toString(36).slice(2, 9);
    let slug = slugify(name) || "term"; let n = 2;
    while (this.bySlug(tenant, taxonomy, slug)) slug = `${slugify(name)}-${n++}`;
    getDb().prepare("INSERT INTO terms (id, tenant_id, taxonomy, name, slug, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, tenant, taxonomy, name, slug, Date.now());
    return { id, taxonomy, name, slug, count: 0 };
  },
  remove(tenant: string, id: string): boolean {
    getDb().prepare("DELETE FROM post_terms WHERE tenant_id = ? AND term_id = ?").run(tenant, id);
    return getDb().prepare("DELETE FROM terms WHERE tenant_id = ? AND id = ?").run(tenant, id).changes > 0;
  },
};

/* ----------------------- posts ----------------------- */
export type PostDTO = {
  id: string; slug: string; title: string; excerpt: string; status: string; author: string; locale: string; type: string;
  blocks: Block; published: Block | null;
  seo: { title: string; description: string; keyword: string; schema: string };
  categories: Term[]; tags: Term[]; scheduledAt: number | null; updatedAt: number;
};

function termsFor(tenant: string, postId: number, taxonomy: string): Term[] {
  const rows = getDb().prepare(
    "SELECT t.id, t.taxonomy, t.name, t.slug FROM terms t JOIN post_terms pt ON pt.term_id = t.id WHERE pt.tenant_id = ? AND pt.post_id = ? AND t.taxonomy = ?"
  ).all(tenant, postId, taxonomy) as any[];
  return rows.map((r) => ({ ...r, count: 0 }));
}
function postToDto(tenant: string, r: any): PostDTO {
  return {
    id: String(r.id), slug: r.slug, title: r.title, excerpt: r.excerpt, status: r.status, author: r.author, locale: r.locale, type: r.type || "post",
    blocks: JSON.parse(r.blocks), published: r.published ? JSON.parse(r.published) : null,
    seo: { title: r.seo_title || "", description: r.seo_description || "", keyword: r.seo_keyword || "", schema: r.seo_schema || "BlogPosting" },
    categories: termsFor(tenant, r.id, "category"), tags: termsFor(tenant, r.id, "tag"),
    scheduledAt: r.scheduled_at ? Date.parse(r.scheduled_at) : null,
    updatedAt: Date.parse(r.updated_at) || Date.now(),
  };
}

export const PostsRepo = {
  materialize(tenant: string) {
    getDb().prepare("UPDATE posts SET status='published', published=blocks, scheduled_at=NULL WHERE tenant_id=? AND status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at<=?").run(tenant, new Date().toISOString());
  },
  list(tenant: string, trashed = false): PostDTO[] {
    this.materialize(tenant);
    const rows = getDb().prepare("SELECT * FROM posts WHERE tenant_id = ? AND deleted = ? ORDER BY updated_at DESC").all(tenant, trashed ? 1 : 0) as any[];
    return rows.map((r) => postToDto(tenant, r));
  },
  get(tenant: string, id: number): PostDTO | null {
    const r = getDb().prepare("SELECT * FROM posts WHERE tenant_id = ? AND id = ?").get(tenant, id) as any;
    return r ? postToDto(tenant, r) : null;
  },
  getBySlug(tenant: string, slug: string): PostDTO | null {
    this.materialize(tenant);
    const r = getDb().prepare("SELECT * FROM posts WHERE tenant_id = ? AND slug = ? AND deleted = 0").get(tenant, slug) as any;
    return r ? postToDto(tenant, r) : null;
  },
  slugExists(tenant: string, slug: string, exceptId?: number): boolean {
    return !!getDb().prepare("SELECT id FROM posts WHERE tenant_id = ? AND slug = ? AND id != ?").get(tenant, slug, exceptId ?? -1);
  },
  setTerms(tenant: string, postId: number, ids: string[]) {
    const db = getDb();
    for (const id of ids) {
      if (db.prepare("SELECT id FROM terms WHERE tenant_id = ? AND id = ?").get(tenant, id)) {
        db.prepare("INSERT OR IGNORE INTO post_terms (post_id, term_id, tenant_id) VALUES (?, ?, ?)").run(postId, id, tenant);
      }
    }
  },
  syncTerms(tenant: string, postId: number, categoryIds: string[], tagIds: string[]) {
    getDb().prepare("DELETE FROM post_terms WHERE tenant_id = ? AND post_id = ?").run(tenant, postId);
    this.setTerms(tenant, postId, [...(categoryIds || []), ...(tagIds || [])]);
  },
  create(tenant: string, d: any): PostDTO {
    const now = new Date().toISOString();
    const info = getDb().prepare(
      `INSERT INTO posts (tenant_id, slug, title, excerpt, status, author, locale, type, blocks, published, seo_title, seo_description, seo_keyword, seo_schema, scheduled_at, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 0, ?, ?)`
    ).run(tenant, d.slug, d.title, clip(d.excerpt, 400), clip(d.author, 120), d.locale || "nl", clip(d.type, 60) || "post",
      JSON.stringify(d.blocks), d.seo?.title || "", d.seo?.description || "", d.seo?.keyword || "", d.seo?.schema || "BlogPosting", now, now);
    const id = Number(info.lastInsertRowid);
    this.syncTerms(tenant, id, d.categories || [], d.tags || []);
    return this.get(tenant, id)!;
  },
  update(tenant: string, id: number, d: any): PostDTO | null {
    const now = new Date().toISOString();
    const r = getDb().prepare(
      `UPDATE posts SET slug=?, title=?, excerpt=?, author=?, locale=?, type=COALESCE(?,type), blocks=?, seo_title=?, seo_description=?, seo_keyword=?, seo_schema=?, updated_at=? WHERE tenant_id=? AND id=?`
    ).run(d.slug, d.title, clip(d.excerpt, 400), clip(d.author, 120), d.locale || "nl", d.type ? clip(d.type, 60) : null,
      JSON.stringify(d.blocks), d.seo?.title || "", d.seo?.description || "", d.seo?.keyword || "", d.seo?.schema || "BlogPosting", now, tenant, id);
    if (r.changes === 0) return null;
    this.syncTerms(tenant, id, d.categories || [], d.tags || []);
    return this.get(tenant, id);
  },
  publish(tenant: string, id: number): PostDTO | null {
    const p = this.get(tenant, id); if (!p) return null;
    getDb().prepare("UPDATE posts SET published=?, status='published', scheduled_at=NULL, updated_at=? WHERE tenant_id=? AND id=?").run(JSON.stringify(p.blocks), new Date().toISOString(), tenant, id);
    return this.get(tenant, id);
  },
  schedule(tenant: string, id: number, at: number): PostDTO | null {
    const p = this.get(tenant, id); if (!p) return null;
    getDb().prepare("UPDATE posts SET status='scheduled', scheduled_at=?, updated_at=? WHERE tenant_id=? AND id=?").run(new Date(at).toISOString(), new Date().toISOString(), tenant, id);
    return this.get(tenant, id);
  },
  setTrashed(tenant: string, id: number, deleted: boolean): boolean {
    return getDb().prepare("UPDATE posts SET deleted=?, updated_at=? WHERE tenant_id=? AND id=?").run(deleted ? 1 : 0, new Date().toISOString(), tenant, id).changes > 0;
  },
  purge(tenant: string, id: number): boolean {
    getDb().prepare("DELETE FROM post_terms WHERE tenant_id=? AND post_id=?").run(tenant, id);
    return getDb().prepare("DELETE FROM posts WHERE tenant_id=? AND id=? AND deleted=1").run(tenant, id).changes > 0;
  },
};

export type PostCard = { title: string; excerpt: string; url: string; category: string; date: string };
export function postCards(tenant: string, opts: { category?: string; limit?: number }): PostCard[] {
  const limit = Math.max(1, Math.min(12, Number(opts.limit) || 6));
  let catId = "";
  if (opts.category) {
    const t = getDb().prepare("SELECT id FROM terms WHERE tenant_id = ? AND taxonomy = 'category' AND (slug = ? OR id = ?)").get(tenant, opts.category, opts.category) as { id: string } | undefined;
    catId = t ? t.id : "__none__";
  }
  let list = PostsRepo.list(tenant).filter((p) => p.status === "published");
  if (catId) list = list.filter((p) => p.categories.some((c) => c.id === catId));
  return list.slice(0, limit).map((p) => ({
    title: p.title,
    excerpt: p.excerpt,
    url: "/blog/" + p.slug,
    category: p.categories[0]?.name || "",
    date: new Date(p.updatedAt).toISOString().slice(0, 10),
  }));
}

export const authorSlug = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// gepagineerd archief van gepubliceerde posts, optioneel gefilterd op categorie/tag/auteur
export function postArchive(tenant: string, opts: { category?: string; tag?: string; author?: string; type?: string; page?: number; perPage?: number }) {
  const perPage = Math.max(1, Math.min(24, Number(opts.perPage) || 9));
  const wantType = opts.type || "post";
  let list = PostsRepo.list(tenant).filter((p) => p.status === "published" && p.published && (p.type || "post") === wantType);
  let title = "Blog";
  if (wantType !== "post") { const ct = SettingsRepo.get(tenant).contentTypes.find((t) => t.key === wantType); title = ct ? ct.plural : wantType; }
  if (opts.category) {
    const t = list.flatMap((p) => p.categories).find((c) => c.slug === opts.category || c.id === opts.category);
    list = list.filter((p) => p.categories.some((c) => c.slug === opts.category || c.id === opts.category));
    title = "Categorie: " + (t ? t.name : opts.category);
  }
  if (opts.tag) {
    const t = list.flatMap((p) => p.tags).find((c) => c.slug === opts.tag || c.id === opts.tag);
    list = list.filter((p) => p.tags.some((c) => c.slug === opts.tag || c.id === opts.tag));
    title = "Tag: " + (t ? t.name : opts.tag);
  }
  if (opts.author) {
    list = list.filter((p) => authorSlug(p.author) === opts.author || p.author === opts.author);
    title = "Auteur: " + (list[0]?.author || opts.author);
  }
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.max(1, Math.min(pages, Number(opts.page) || 1));
  const items = list.slice((page - 1) * perPage, page * perPage).map((p) => ({
    title: p.title, excerpt: p.excerpt, url: "/blog/" + p.slug,
    category: p.categories[0]?.name || "", date: new Date(p.updatedAt).toISOString().slice(0, 10),
  }));
  return { items, total, page, pages, perPage, title };
}

function assertBlocks(blocks: Block) {
  if (!blocks || blocks.type !== "core/root") throw { status: 400, msg: "Ongeldige structuur" };
  const v = validateTree(blocks);
  if (!v.ok) throw { status: 400, msg: "Validatie mislukt", issues: v.issues };
}

export async function postsRoutes(app: FastifyInstance) {
  // ---- taxonomie ----
  app.get("/api/terms", { preHandler: authGuard }, async (req, reply) =>
    reply.send(TermsRepo.list(tenantOf(req), (req.query as any)?.taxonomy)));
  app.get("/api/content-types", async (req, reply) => reply.send(SettingsRepo.get(tenantOf(req)).contentTypes));
  app.post("/api/terms", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const taxonomy = b.taxonomy === "tag" ? "tag" : "category";
    const name = clip(b.name, 80);
    if (!name) return reply.code(400).send({ error: "Naam is verplicht", issues: [{ path: "name", message: "Naam is verplicht" }] });
    return reply.code(201).send(TermsRepo.create(tenantOf(req), taxonomy, name));
  });
  app.delete("/api/terms/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    if (!TermsRepo.remove(tenantOf(req), String((req.params as any).id))) return reply.code(404).send({ error: "Term niet gevonden" });
    return reply.send({ ok: true });
  });

  // ---- posts ----
  app.get("/api/posts", { preHandler: authGuard }, async (req, reply) =>
    reply.send(PostsRepo.list(tenantOf(req), (req.query as any)?.trashed === "1")));
  app.get("/api/posts/:id", { preHandler: authGuard }, async (req, reply) => {
    const p = PostsRepo.get(tenantOf(req), Number((req.params as any).id));
    if (!p) return reply.code(404).send({ error: "Post niet gevonden" });
    return reply.send(p);
  });

  const writeGuard = { preHandler: [authGuard, requireRole("editor")] };
  app.post("/api/posts", writeGuard, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const title = clip(b.title, 200);
    if (!title) return reply.code(400).send({ error: "Titel is verplicht", issues: [{ path: "title", message: "Titel is verplicht" }] });
    let slug = slugify(b.slug || title) || "post"; let n = 2;
    while (PostsRepo.slugExists(tenantOf(req), slug)) slug = `${slugify(b.slug || title)}-${n++}`;
    try { assertBlocks(b.blocks); } catch (e: any) { return reply.code(e.status || 400).send({ error: e.msg, issues: e.issues }); }
    return reply.code(201).send(PostsRepo.create(tenantOf(req), { ...b, slug }));
  });
  app.put("/api/posts/:id", writeGuard, async (req, reply) => {
    const tenant = tenantOf(req); const id = Number((req.params as any).id);
    const b = (req.body ?? {}) as any;
    const cur = PostsRepo.get(tenant, id);
    if (!cur) return reply.code(404).send({ error: "Post niet gevonden" });
    const title = clip(b.title, 200) || cur.title;
    let slug = slugify(b.slug || title); if (PostsRepo.slugExists(tenant, slug, id)) slug = `${slug}-${id}`;
    try { assertBlocks(b.blocks); } catch (e: any) { return reply.code(e.status || 400).send({ error: e.msg, issues: e.issues }); }
    return reply.send(PostsRepo.update(tenant, id, { ...b, title, slug }));
  });
  app.post("/api/posts/:id/publish", writeGuard, async (req, reply) => {
    const p = PostsRepo.publish(tenantOf(req), Number((req.params as any).id));
    if (!p) return reply.code(404).send({ error: "Post niet gevonden" });
    return reply.send(p);
  });
  app.post("/api/posts/:id/preview-token", { preHandler: authGuard }, async (req, reply) => { const id = Number((req.params as any).id); const t = signPreview("post", id, tenantOf(req)); return reply.send({ token: t, url: "/preview/post/" + id + "?token=" + encodeURIComponent(t) }); });
  app.post("/api/posts/:id/schedule", writeGuard, async (req, reply) => {
    const at = Number((req.body as any)?.at);
    if (!Number.isFinite(at) || at <= Date.now()) return reply.code(400).send({ error: "Kies een tijdstip in de toekomst", issues: [{ path: "at", message: "Tijdstip moet in de toekomst liggen" }] });
    const p = PostsRepo.schedule(tenantOf(req), Number((req.params as any).id), at);
    if (!p) return reply.code(404).send({ error: "Post niet gevonden" });
    return reply.send(p);
  });
  app.post("/api/posts/:id/trash", writeGuard, async (req, reply) => {
    if (!PostsRepo.setTrashed(tenantOf(req), Number((req.params as any).id), true)) return reply.code(404).send({ error: "Post niet gevonden" });
    return reply.send({ ok: true });
  });
  app.post("/api/posts/:id/restore", writeGuard, async (req, reply) => {
    if (!PostsRepo.setTrashed(tenantOf(req), Number((req.params as any).id), false)) return reply.code(404).send({ error: "Post niet gevonden" });
    return reply.send(PostsRepo.get(tenantOf(req), Number((req.params as any).id)));
  });
  app.delete("/api/posts/:id", writeGuard, async (req, reply) => {
    const tenant = tenantOf(req); const id = Number((req.params as any).id);
    if ((req.query as any)?.purge === "1") { if (!PostsRepo.purge(tenant, id)) return reply.code(404).send({ error: "Niet in prullenbak" }); return reply.send({ ok: true, purged: true }); }
    if (!PostsRepo.setTrashed(tenant, id, true)) return reply.code(404).send({ error: "Post niet gevonden" });
    return reply.send({ ok: true, trashed: true });
  });
}
