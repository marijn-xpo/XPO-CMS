import { getDb } from "../../db/database.js";
import { countLinks, type Block } from "../../engine/engine.js";

export type PageDTO = {
  id: string;
  slug: string;
  title: string;
  template: string;
  locale: string;
  status: "draft" | "published" | "scheduled";
  seo: { title: string; description: string; keyword: string; schema: string; ogImage: string; noindex: boolean; canonical: string };
  blocks: Block;
  published: Block | null;
  meta: Record<string, any>;
  parentId: string | null;
  author: string;
  excerpt: string;
  featuredImage: string;
  menuOrder: number;
  visibility: "public" | "private" | "password";
  password: string;
  commentsOpen: boolean;
  scheduledAt: number | null;
  transGroup: string;
  links: { internal: number; external: number; image: number };
  updatedAt: number;
};

type Row = {
  id: number; slug: string; title: string; template: string; locale: string;
  status: string; seo_title: string; seo_description: string; seo_keyword: string; seo_schema: string; seo_og_image: string; seo_noindex: number; seo_canonical: string;
  blocks: string; meta: string; parent_id: number | null; author: string;
  scheduled_at: string | null; deleted: number; trans_group: string;
  excerpt: string; featured_image: string; menu_order: number; visibility: string; password: string; comments_open: number;
  published: string | null; created_at: string; updated_at: string;
};

function toDto(r: Row): PageDTO {
  const blocks = JSON.parse(r.blocks);
  return {
    id: String(r.id), slug: r.slug, title: r.title, template: r.template, locale: r.locale,
    status: (r.status === "published" ? "published" : r.status === "scheduled" ? "scheduled" : "draft"),
    seo: { title: r.seo_title || "", description: r.seo_description || "", keyword: r.seo_keyword || "", schema: r.seo_schema || "Article", ogImage: r.seo_og_image || "", noindex: !!r.seo_noindex, canonical: r.seo_canonical || "" },
    blocks,
    published: r.published ? JSON.parse(r.published) : null,
    meta: r.meta ? JSON.parse(r.meta) : {},
    parentId: r.parent_id != null ? String(r.parent_id) : null,
    author: r.author || "",
    excerpt: r.excerpt || "",
    featuredImage: r.featured_image || "",
    menuOrder: r.menu_order || 0,
    visibility: (r.visibility === "private" ? "private" : r.visibility === "password" ? "password" : "public"),
    password: r.password || "",
    commentsOpen: !!r.comments_open,
    scheduledAt: r.scheduled_at ? Date.parse(r.scheduled_at) : null,
    transGroup: r.trans_group || "",
    links: countLinks(blocks),
    updatedAt: Date.parse(r.updated_at) || Date.now(),
  };
}

export type PageInput = {
  slug: string; title: string; template?: string; locale?: string;
  seo?: { title?: string; description?: string; keyword?: string; schema?: string; ogImage?: string; noindex?: boolean; canonical?: string };
  blocks: Block; meta?: Record<string, any>;
  parentId?: string | null; author?: string;
  excerpt?: string; featuredImage?: string; menuOrder?: number; visibility?: string; password?: string; commentsOpen?: boolean;
};

function newGroup(): string { return "tg_" + Math.random().toString(36).slice(2, 9); }

export const PagesRepo = {
  materializeScheduled(tenant: string): void {
    getDb().prepare(
      "UPDATE pages SET status = 'published', published = blocks, scheduled_at = NULL WHERE tenant_id = ? AND status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?"
    ).run(tenant, new Date().toISOString());
  },

  list(tenant: string, opts: { trashed?: boolean } = {}): PageDTO[] {
    this.materializeScheduled(tenant);
    const rows = getDb().prepare(
      "SELECT * FROM pages WHERE tenant_id = ? AND deleted = ? ORDER BY updated_at DESC"
    ).all(tenant, opts.trashed ? 1 : 0) as unknown as Row[];
    return rows.map(toDto);
  },

  get(tenant: string, id: number): PageDTO | null {
    const r = getDb().prepare("SELECT * FROM pages WHERE tenant_id = ? AND id = ?").get(tenant, id) as unknown as Row | undefined;
    return r ? toDto(r) : null;
  },

  getBySlug(tenant: string, slug: string): PageDTO | null {
    this.materializeScheduled(tenant);
    const r = getDb().prepare("SELECT * FROM pages WHERE tenant_id = ? AND slug = ? AND deleted = 0").get(tenant, slug) as unknown as Row | undefined;
    return r ? toDto(r) : null;
  },

  create(tenant: string, data: PageInput & { transGroup?: string }): PageDTO {
    const now = new Date().toISOString();
    const info = getDb().prepare(
      `INSERT INTO pages (tenant_id, slug, title, template, locale, status, seo_title, seo_description, seo_keyword, seo_schema, seo_og_image, seo_noindex, seo_canonical, blocks, meta, parent_id, author, excerpt, featured_image, menu_order, visibility, password, comments_open, scheduled_at, deleted, trans_group, published, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, NULL, ?, ?)`
    ).run(
      tenant, data.slug, data.title, data.template || "Landing", data.locale || "nl",
      data.seo?.title || "", data.seo?.description || "", data.seo?.keyword || "", data.seo?.schema || "Article",
      data.seo?.ogImage || "", data.seo?.noindex ? 1 : 0, data.seo?.canonical || "",
      JSON.stringify(data.blocks), JSON.stringify(data.meta || {}),
      data.parentId ? Number(data.parentId) : null, data.author || "",
      data.excerpt || "", data.featuredImage || "", Number(data.menuOrder) || 0, (["private", "password"].includes(String(data.visibility)) ? String(data.visibility) : "public"), data.password || "", data.commentsOpen ? 1 : 0,
      data.transGroup || newGroup(), now, now
    );
    return this.get(tenant, Number(info.lastInsertRowid))!;
  },

  update(tenant: string, id: number, data: PageInput): PageDTO | null {
    const ex = this.get(tenant, id);
    if (!ex) return null;
    const author = data.author !== undefined ? data.author : ex.author;
    const parentId = data.parentId !== undefined ? (data.parentId ? Number(data.parentId) : null) : (ex.parentId ? Number(ex.parentId) : null);
    const seo = data.seo || {};
    const ogImage = seo.ogImage !== undefined ? seo.ogImage : ex.seo.ogImage;
    const noindex = seo.noindex !== undefined ? (seo.noindex ? 1 : 0) : (ex.seo.noindex ? 1 : 0);
    const canonical = seo.canonical !== undefined ? seo.canonical : ex.seo.canonical;
    const excerpt = data.excerpt !== undefined ? data.excerpt : ex.excerpt;
    const featuredImage = data.featuredImage !== undefined ? data.featuredImage : ex.featuredImage;
    const menuOrder = data.menuOrder !== undefined ? Number(data.menuOrder) || 0 : ex.menuOrder;
    const visibility = data.visibility !== undefined ? (["private","password"].includes(String(data.visibility)) ? data.visibility : "public") : ex.visibility;
    const password = data.password !== undefined ? data.password : ex.password;
    const commentsOpen = data.commentsOpen !== undefined ? (data.commentsOpen ? 1 : 0) : (ex.commentsOpen ? 1 : 0);
    const now = new Date().toISOString();
    const db0 = getDb();
    // revisie: vorige versie bewaren vóór overschrijven (terugdraaien mogelijk), gecapt op 30
    db0.prepare("INSERT INTO page_versions (page_id, tenant_id, blocks, label, created_at) VALUES (?, ?, ?, ?, ?)").run(id, tenant, JSON.stringify(ex.blocks), "edit", now);
    db0.prepare("DELETE FROM page_versions WHERE page_id = ? AND tenant_id = ? AND id NOT IN (SELECT id FROM page_versions WHERE page_id = ? AND tenant_id = ? ORDER BY id DESC LIMIT 30)").run(id, tenant, id, tenant);
    getDb().prepare(
      `UPDATE pages SET slug = ?, title = ?, template = ?, locale = ?, seo_title = ?, seo_description = ?, seo_keyword = ?, seo_schema = ?, seo_og_image = ?, seo_noindex = ?, seo_canonical = ?, blocks = ?, meta = ?, parent_id = ?, author = ?, excerpt = ?, featured_image = ?, menu_order = ?, visibility = ?, password = ?, comments_open = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`
    ).run(
      data.slug, data.title, data.template || "Landing", data.locale || ex.locale || "nl",
      data.seo?.title || "", data.seo?.description || "", data.seo?.keyword || "", data.seo?.schema || "Article",
      ogImage || "", noindex, canonical || "",
      JSON.stringify(data.blocks), JSON.stringify(data.meta || {}),
      parentId, author, excerpt, featuredImage, menuOrder, visibility, password, commentsOpen, now, tenant, id
    );
    return this.get(tenant, id);
  },

  publish(tenant: string, id: number): PageDTO | null {
    const page = this.get(tenant, id);
    if (!page) return null;
    const now = new Date().toISOString();
    const blocksJson = JSON.stringify(page.blocks);
    const db = getDb();
    db.prepare("UPDATE pages SET published = ?, status = 'published', scheduled_at = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?")
      .run(blocksJson, now, tenant, id);
    db.prepare("INSERT INTO page_versions (page_id, tenant_id, blocks, label, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, tenant, blocksJson, "publish", now);
    return this.get(tenant, id);
  },

  schedule(tenant: string, id: number, at: number): PageDTO | null {
    const page = this.get(tenant, id);
    if (!page) return null;
    const now = new Date().toISOString();
    getDb().prepare("UPDATE pages SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
      .run(new Date(at).toISOString(), now, tenant, id);
    return this.get(tenant, id);
  },

  setTrashed(tenant: string, id: number, deleted: boolean): boolean {
    return getDb().prepare("UPDATE pages SET deleted = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
      .run(deleted ? 1 : 0, new Date().toISOString(), tenant, id).changes > 0;
  },

  purge(tenant: string, id: number): boolean {
    getDb().prepare("DELETE FROM page_versions WHERE tenant_id = ? AND page_id = ?").run(tenant, id);
    return getDb().prepare("DELETE FROM pages WHERE tenant_id = ? AND id = ? AND deleted = 1").run(tenant, id).changes > 0;
  },

  createTranslation(tenant: string, id: number, locale: string): PageDTO | null {
    const src = this.get(tenant, id);
    if (!src) return null;
    const group = src.transGroup || newGroup();
    if (!src.transGroup) getDb().prepare("UPDATE pages SET trans_group = ? WHERE tenant_id = ? AND id = ?").run(group, tenant, id);
    let slug = `${src.slug}-${locale}`;
    let n = 2;
    while (this.slugExists(tenant, slug)) slug = `${src.slug}-${locale}-${n++}`;
    return this.create(tenant, {
      slug, title: src.title, template: src.template, locale,
      seo: src.seo, blocks: src.blocks, meta: src.meta, parentId: src.parentId, author: src.author, transGroup: group,
    });
  },
  translations(tenant: string, group: string): { id: string; locale: string; slug: string; status: string }[] {
    if (!group) return [];
    const rows = getDb().prepare("SELECT id, locale, slug, status FROM pages WHERE tenant_id = ? AND trans_group = ? AND deleted = 0").all(tenant, group) as any[];
    return rows.map((r) => ({ id: String(r.id), locale: r.locale, slug: r.slug, status: r.status }));
  },

  versions(tenant: string, id: number): { id: number; label: string; when: number }[] {
    const rows = getDb().prepare("SELECT id, label, created_at FROM page_versions WHERE tenant_id = ? AND page_id = ? ORDER BY id DESC").all(tenant, id) as any[];
    return rows.map((r) => ({ id: r.id, label: r.label, when: Date.parse(r.created_at) || 0 }));
  },
  restoreVersion(tenant: string, id: number, versionId: number): PageDTO | null {
    const v = getDb().prepare("SELECT blocks FROM page_versions WHERE tenant_id = ? AND page_id = ? AND id = ?").get(tenant, id, versionId) as { blocks: string } | undefined;
    if (!v) return null;
    getDb().prepare("UPDATE pages SET blocks = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").run(v.blocks, new Date().toISOString(), tenant, id);
    return this.get(tenant, id);
  },

  remove(tenant: string, id: number): boolean {
    return getDb().prepare("DELETE FROM pages WHERE tenant_id = ? AND id = ?").run(tenant, id).changes > 0;
  },

  slugExists(tenant: string, slug: string, exceptId?: number): boolean {
    const r = getDb().prepare("SELECT id FROM pages WHERE tenant_id = ? AND slug = ? AND id != ?").get(tenant, slug, exceptId ?? -1) as { id: number } | undefined;
    return !!r;
  },
};
