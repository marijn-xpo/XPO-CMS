import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";
import { PagesRepo } from "../pages/pages.repository.js";
import { PostsRepo, TermsRepo } from "../posts/posts.routes.js";
import { NavRepo } from "../navigation/navigation.routes.js";
import { SettingsRepo } from "../settings/settings.routes.js";
import { PopupsRepo } from "../popups/popups.routes.js";

function buildExport(tenant: string) {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    tenant,
    pages: PagesRepo.list(tenant).map((p) => ({ slug: p.slug, title: p.title, template: p.template, locale: p.locale, status: p.status, seo: p.seo, blocks: p.blocks, meta: p.meta })),
    posts: PostsRepo.list(tenant).map((p) => ({ slug: p.slug, title: p.title, excerpt: p.excerpt, status: p.status, blocks: p.blocks, seo: p.seo, categories: p.categories.map((c) => c.name), tags: p.tags.map((t) => t.name) })),
    terms: TermsRepo.list(tenant).map((t) => ({ taxonomy: t.taxonomy, name: t.name })),
    snippets: (getDb().prepare("SELECT name, block FROM snippets WHERE tenant_id = ?").all(tenant) as any[]).map((r) => ({ name: r.name, block: JSON.parse(r.block) })),
    popups: PopupsRepo.list(tenant).map((p) => ({ name: p.name, trigger: p.trigger, delay: p.delay, condType: p.condType, condValue: p.condValue, title: p.title, body: p.body, btnLabel: p.btnLabel, btnUrl: p.btnUrl, image: p.image, active: p.active })),
    navigation: NavRepo.get(tenant),
    settings: SettingsRepo.get(tenant),
  };
}

function runImport(tenant: string, data: any) {
  const summary = { pages: 0, posts: 0, terms: 0, snippets: 0, popups: 0, navigation: false, settings: false };
  // termen eerst (naam→id map per taxonomie)
  const termId: Record<string, string> = {};
  for (const t of (data.terms || [])) {
    const tax = t.taxonomy === "tag" ? "tag" : "category";
    const existing = TermsRepo.list(tenant, tax).find((x) => x.name === t.name);
    const created = existing || TermsRepo.create(tenant, tax, String(t.name || "Term"));
    termId[tax + ":" + t.name] = created.id;
    if (!existing) summary.terms++;
  }
  for (const p of (data.pages || [])) {
    let slug = String(p.slug || "pagina"); let n = 2;
    while (PagesRepo.slugExists(tenant, slug)) slug = `${p.slug}-${n++}`;
    PagesRepo.create(tenant, { slug, title: p.title || "Pagina", template: p.template, locale: p.locale, seo: p.seo, blocks: p.blocks, meta: p.meta });
    summary.pages++;
  }
  for (const p of (data.posts || [])) {
    let slug = String(p.slug || "post"); let n = 2;
    while (PostsRepo.slugExists(tenant, slug)) slug = `${p.slug}-${n++}`;
    const cats = (p.categories || []).map((nm: string) => termId["category:" + nm]).filter(Boolean);
    const tags = (p.tags || []).map((nm: string) => termId["tag:" + nm]).filter(Boolean);
    PostsRepo.create(tenant, { slug, title: p.title || "Post", excerpt: p.excerpt, blocks: p.blocks, seo: p.seo, categories: cats, tags });
    summary.posts++;
  }
  for (const sn of (data.snippets || [])) {
    const id = "sn_" + Math.random().toString(36).slice(2, 9); const now = Date.now();
    getDb().prepare("INSERT INTO snippets (id, tenant_id, name, block, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, tenant, String(sn.name || "Sectie"), JSON.stringify(sn.block), now, now);
    summary.snippets++;
  }
  for (const pu of (data.popups || [])) { PopupsRepo.create(tenant, pu); summary.popups++; }
  if (data.navigation && typeof data.navigation === "object") { NavRepo.set(tenant, data.navigation); summary.navigation = true; }
  if (data.settings && typeof data.settings === "object") { SettingsRepo.set(tenant, data.settings); summary.settings = true; }
  return summary;
}

export async function backupRoutes(app: FastifyInstance) {
  app.get("/api/export", { preHandler: [authGuard, requireRole("admin")] }, async (req, reply) => reply.send(buildExport(tenantOf(req))));
  app.post("/api/import", { preHandler: [authGuard, requireRole("admin")] }, async (req, reply) => {
    const data = (req.body as any)?.data ?? req.body;
    if (!data || typeof data !== "object") return reply.code(400).send({ error: "Ongeldige back-up" });
    try { return reply.send({ ok: true, imported: runImport(tenantOf(req), data) }); }
    catch (e: any) { return reply.code(400).send({ error: "Import mislukt", detail: String(e?.message || e).slice(0, 200) }); }
  });
}
