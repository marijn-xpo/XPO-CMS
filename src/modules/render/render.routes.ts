import type { FastifyInstance } from "fastify";
import { tenantOf } from "../../common/tenant.js";
import { PagesRepo, type PageDTO } from "../pages/pages.repository.js";
import { NavRepo } from "../navigation/navigation.routes.js";
import { SettingsRepo } from "../settings/settings.routes.js";
import { FieldGroupsRepo } from "../fields/fields.routes.js";
import { PostsRepo, postCards, postArchive } from "../posts/posts.routes.js";
import { popupsMarkup } from "../popups/popups.routes.js";
import { SnippetsRepo } from "../snippets/snippets.routes.js";
import { CommentsRepo } from "../comments/comments.routes.js";
import { TemplatesRepo } from "../templates/templates.routes.js";
import { shopCards, productBySlug, productReviews } from "../shop/shop.routes.js";
import { FormsRepo } from "../forms/forms.routes.js";
import { setNonce, nonceAttr, getNonce } from "../../common/nonce.js";
import { verifyPreview } from "../../common/preview.js";
import { sendCached, invalidateTenant } from "../../core/render-cache.js";
import { renderDocument, safeColor, cssFont, esc, safeUrl, type Block } from "../../engine/engine.js";

// vul dynamische blokken (xpo/posts) met echte data + los synced secties op
type RCtx = { kind?: "page" | "post"; slug?: string; title?: string; site?: string; author?: string; bio?: string; date?: string; breadcrumbs?: { label: string; url: string }[]; prev?: { title: string; url: string }; next?: { title: string; url: string }; fields?: Record<string, string> };

const fieldSlug = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// bouwt één kaart voor de Loop-widget (eigen template per item via veld-toggles)
function loopCard(source: string, it: any, st: any): string {
  const url = source === "products" ? (it.slug ? "/product/" + it.slug : "#") : it.url;
  const img = source === "products" ? it.image : "";
  const title = source === "products" ? it.name : it.title;
  const sub = source === "products" ? it.price : it.excerpt;
  const meta = source === "products" ? (it.category || "") : (it.category || it.date || "");
  let inner = "";
  if (st.showImage !== false) inner += img ? `<div class="xlp-img" style="background-image:url('${esc(safeUrl(img))}')"></div>` : `<div class="xlp-img xlp-img--ph"></div>`;
  inner += `<div class="xlp-body">`;
  if (st.showMeta !== false && meta) inner += `<div class="xlp-meta">${esc(meta)}</div>`;
  inner += `<h3 class="xlp-title">${esc(title)}</h3>`;
  if (st.showText !== false && sub) inner += `<p class="xlp-text">${esc(sub)}</p>`;
  if (st.showButton) inner += `<span class="xlp-btn">${esc(st.buttonLabel || (source === "products" ? "Bekijk" : "Lees meer"))} \u2192</span>`;
  inner += `</div>`;
  return `<a class="xlp-card" href="${esc(safeUrl(url))}">${inner}</a>`;
}
function fieldDisplay(f: any, v: any): string {
  if (v === undefined || v === null || v === "") return "";
  if (f.type === "toggle") return v ? "Ja" : "Nee";
  if (f.type === "repeater") return Array.isArray(v) ? v.filter((x) => x !== "" && x != null).join(", ") : String(v);
  return String(v);
}
// bouwt een lookup van veldwaarden voor de huidige pagina (op veld-id én op label-slug)
function buildFieldMap(tenant: string, meta: Record<string, any> | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!meta) return map;
  for (const g of FieldGroupsRepo.list(tenant)) {
    for (const f of g.fields) {
      const disp = fieldDisplay(f, (meta as any)[f.id]);
      if (!disp) continue;
      map[f.id] = disp;
      map[fieldSlug(f.label)] = disp;
    }
  }
  return map;
}

function applyTags(str: string, ctx: RCtx): string {
  if (typeof str !== "string" || str.indexOf("{{") < 0) return str;
  // veld-tags: {{field:KEY}} (KEY = veld-id of label-slug)
  str = str.replace(/\{\{\s*field:([a-z0-9_\-]+)\s*\}\}/gi, (_m, k) => {
    const key = String(k); const f = ctx.fields || {};
    return f[key] ?? f[fieldSlug(key)] ?? "";
  });
  const map: Record<string, string> = {
    site: ctx.site || "", title: ctx.title || "", author: ctx.author || "",
    date: ctx.date || "", year: String(new Date().getFullYear()),
  };
  return str.replace(/\{\{\s*([a-z]+)\s*\}\}/gi, (m, k) => (k.toLowerCase() in map ? map[k.toLowerCase()] : m));
}

function resolveDynamic(tenant: string, b: Block, ctx: RCtx = {}): Block {
  if (b.type === "xpo/sync") {
    const snip = SnippetsRepo.get(tenant, String(b.settings?.ref || ""));
    if (snip && snip.block) {
      const resolved = resolveDynamic(tenant, JSON.parse(JSON.stringify(snip.block)), ctx);
      if (b.settings?._adv) (resolved.settings as any)._adv = b.settings._adv;
      return resolved;
    }
    return { ...b, settings: { ...b.settings, _resolved: true } };
  }
  const out: Block = { ...b, settings: { ...(b.settings || {}) }, children: (b.children || []).map((c) => resolveDynamic(tenant, c, ctx)) };
  if (b.type === "xpo/posts") {
    out.settings.items = postCards(tenant, { category: out.settings.category, limit: out.settings.limit });
  }
  if (b.type === "xpo/shop") {
    out.settings.items = shopCards(tenant, { limit: out.settings.limit, category: out.settings.category });
  }
  if (b.type === "xpo/loop") {
    const source = out.settings.source === "products" ? "products" : "posts";
    const limit = Math.max(1, Math.min(24, Number(out.settings.limit) || 6));
    const items = source === "products" ? shopCards(tenant, { limit, category: out.settings.category }) : postCards(tenant, { limit, category: out.settings.category });
    out.settings._items = items.map((it: any) => ({ __html: loopCard(source, it, out.settings) }));
  }
  if (b.type === "xpo/form" && out.settings.formId) {
    const form = FormsRepo.get(tenant, Number(out.settings.formId));
    out.settings.fields = form ? form.fields : [];
    out.settings.formName = form ? form.name : "";
  }
  // dynamische tags in tekst/koppen/knoppen
  if (b.type === "xpo/text" && out.settings.body) out.settings.body = applyTags(out.settings.body, ctx);
  if (b.type === "xpo/heading" && out.settings.text) out.settings.text = applyTags(out.settings.text, ctx);
  if (b.type === "xpo/animated-heading" && out.settings.prefix) out.settings.prefix = applyTags(out.settings.prefix, ctx);
  if (b.type === "xpo/button" && out.settings.label) out.settings.label = applyTags(out.settings.label, ctx);
  // context-widgets
  if (b.type === "xpo/menu" && !(out.settings.items && out.settings.items.length)) out.settings.items = NavRepo.get(tenant).main || [];
  if (b.type === "xpo/breadcrumbs" && ctx.breadcrumbs) out.settings.items = ctx.breadcrumbs;
  if (b.type === "xpo/post-nav") { out.settings.prev = ctx.prev || null; out.settings.next = ctx.next || null; }
  if (b.type === "xpo/author") { if (!out.settings.name) out.settings.name = ctx.author || ""; if (!out.settings.bio) out.settings.bio = ctx.bio || ""; }
  return out;
}

function specsBlock(tenant: string, page: PageDTO): Block | null {
  const meta = page.meta || {};
  const items: { label: string; value: string }[] = [];
  for (const g of FieldGroupsRepo.list(tenant)) {
    for (const f of g.fields) {
      const disp = fieldDisplay(f, (meta as any)[f.id]);
      if (!disp) continue;
      items.push({ label: f.label, value: disp });
    }
  }
  if (!items.length) return null;
  return { id: "specs", type: "xpo/specs", settings: { title: "Specificaties", items, _style: { pad: 28, maxw: 760, align: "center" } }, children: [] };
}
function compose(tenant: string, root: Block, specs: Block | null, ctx: RCtx = {}): Block {
  const resolved = resolveDynamic(tenant, root, ctx);
  if (specs) resolved.children = [...(resolved.children || []), specs];
  return resolved;
}

// Theme Builder: header/footer rond de content, 'single' rond posts
function tplChildren(tenant: string, kind: string, ctx: RCtx & { kind: "page" | "post"; slug: string }): Block[] {
  const t = TemplatesRepo.resolveActive(tenant, kind, ctx);
  if (!t) return [];
  return resolveDynamic(tenant, t.blocks, ctx).children || [];
}
function themed(tenant: string, contentChildren: Block[], ctx: RCtx & { kind: "page" | "post"; slug: string }, extra: Block[] = []): Block {
  const header = tplChildren(tenant, "header", ctx);
  const footer = tplChildren(tenant, "footer", ctx);
  return { id: "root", type: "core/root", settings: {}, children: [...header, ...contentChildren, ...extra, ...footer] };
}
function postBody(tenant: string, post: any, ctx: RCtx & { kind: "page" | "post"; slug: string }): Block[] {
  const single = TemplatesRepo.resolveActive(tenant, "single", ctx);
  const content = resolveDynamic(tenant, post.published, ctx);
  if (!single) return content.children || [];
  const sroot = resolveDynamic(tenant, JSON.parse(JSON.stringify(single.blocks)), ctx);
  let replaced = false;
  const walk = (arr: Block[]): Block[] => (arr || []).flatMap((n) => {
    if (n.type === "xpo/post-content") { replaced = true; return content.children || []; }
    if (n.children) n.children = walk(n.children);
    return [n];
  });
  let kids = walk(sroot.children || []);
  if (!replaced) kids = [...kids, ...(content.children || [])];
  return kids;
}

function siteGlobals(settings: any): { head: string; body: string } {
  const tk = settings.tokens || {}; const gl = settings.globals || {};
  const vars: string[] = [];
  const prim = safeColor(tk.primary); if (prim) vars.push(`--accent:${prim}`);
  const txt = safeColor(tk.text); const bg = safeColor(tk.bg);
  let css = vars.length ? `:root{${vars.join(";")}}` : "";
  if (txt) css += `body{color:${txt}}`;
  if (bg) css += `body{background:${bg}}`;
  if (tk.fontBody) css += `body{font-family:${cssFont(tk.fontBody)},system-ui,sans-serif}`;
  if (tk.fontHeading) css += `h1,h2,h3,h4,.xpo-h{font-family:${cssFont(tk.fontHeading)}}`;
  const globalCss = String(gl.css || "").slice(0, 40000);
  const head = (css || globalCss) ? `<style>${css}${globalCss}</style>` : "";
  let body = gl.js ? `<script${nonceAttr()}>${String(gl.js).slice(0, 40000)}</script>` : "";
  const ai = settings.ai || {};
  if (ai.assistant) {
    body += `<script${nonceAttr()}>window.__quinty=${JSON.stringify({ name: String(ai.name || "Quinty").slice(0, 40), greeting: String(ai.greeting || "").slice(0, 300) })}</script><script src="/assets/xpo-quinty.js"></script>`;
  }
  return { head, body };
}
function jsonLd(entity: { title: string; seo: { description: string; schema: string } }, path: string): string {
  const type = /^[A-Za-z]+$/.test(entity.seo.schema) ? entity.seo.schema : "WebPage";
  const data: Record<string, any> = { "@context": "https://schema.org", "@type": type, name: entity.title, url: path };
  if (entity.seo.description) data.description = entity.seo.description;
  return `<script type="application/ld+json"${nonceAttr()}>${JSON.stringify(data)}</script>`;
}
function seoHead(entity: { title: string; seo: any }, path: string): string {
  const s = entity.seo || {};
  const title = esc(s.title || entity.title);
  const desc = esc(s.description || "");
  const img = s.ogImage ? esc(safeUrl(s.ogImage)) : "";
  let out = "";
  if (desc) out += `<meta name="description" content="${desc}"/>`;
  out += `<meta name="robots" content="${s.noindex ? "noindex,nofollow" : "index,follow"}"/>`;
  out += `<link rel="canonical" href="${esc(s.canonical || path)}"/>`;
  out += `<meta property="og:type" content="website"/><meta property="og:title" content="${title}"/>`;
  if (desc) out += `<meta property="og:description" content="${desc}"/>`;
  if (img) out += `<meta property="og:image" content="${img}"/>`;
  out += `<meta property="og:url" content="${esc(s.canonical || path)}"/>`;
  out += `<meta name="twitter:card" content="${img ? "summary_large_image" : "summary"}"/><meta name="twitter:title" content="${title}"/>`;
  if (desc) out += `<meta name="twitter:description" content="${desc}"/>`;
  if (img) out += `<meta name="twitter:image" content="${img}"/>`;
  return out;
}
function pageOpts(entity: { title: string; seo: { description: string; schema: string }; meta?: Record<string, any> }, path: string, popupsHtml = "", globals: { head: string; body: string } = { head: "", body: "" }, defaultTheme?: string): { extraHead?: string; extraBody?: string; defaultTheme?: string; nonce?: string } {
  const meta = entity.meta || {};
  const css = String(meta.customCss || "").slice(0, 20000);
  const js = String(meta.customJs || "").slice(0, 20000);
  return { extraHead: globals.head + seoHead(entity as any, path) + jsonLd(entity, path) + (css ? `<style>${css}</style>` : ""), extraBody: globals.body + (popupsHtml || "") + (js ? `<script${nonceAttr()}>${js}</script>` : ""), defaultTheme, nonce: nonceAttr() ? nonceAttr().slice(8, -1) : "" };
}
function notFoundDoc(tenant: string, nav: any, accent?: string): string {
  const root: Block = {
    id: "root", type: "core/root", settings: {},
    children: [
      { id: "h", type: "xpo/heading", settings: { text: "404 — pagina niet gevonden", level: "h2", _style: { bg: "dark", align: "center", pad: 80 } } },
      { id: "t", type: "xpo/text", settings: { body: "Deze pagina bestaat niet of is nog niet gepubliceerd.", _style: { align: "center", pad: 8 } } },
    ],
  };
  return renderDocument("Niet gevonden", root, tenant, nav, accent, { nonce: getNonce() });
}

// Wachtwoord-gate voor beveiligde paginas (zachte content-gate, geen sterke beveiliging).
function pageCookiePw(req: any, page: any): boolean {
  const cookie = String(req.headers?.cookie || ""); const want = "xpo_pw_" + page.id + "=";
  for (const c of cookie.split(/;\s*/)) if (c.startsWith(want) && decodeURIComponent(c.slice(want.length)) === page.password) return true;
  return false;
}
function passwordGateDoc(page: any, accent?: string, wrong = false): string {
  const a = safeColor(accent) || "#5F8D7A";
  return `<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/><title>${esc(page.title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e11;color:#fff;font-family:system-ui,sans-serif}form{background:#12171c;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:30px;width:320px;max-width:90vw;display:flex;flex-direction:column;gap:12px}h1{font-size:20px;margin:0}p{opacity:.7;font-size:14px;margin:0}input{padding:11px 13px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#0b0e11;color:#fff}button{padding:11px;border:0;border-radius:999px;background:${a};color:#06120e;font-weight:700;cursor:pointer}.err{color:#ff6b6b;font-size:13px}</style></head><body><form method="get"><h1>${esc(page.title)}</h1><p>Deze pagina is met een wachtwoord beveiligd.</p><input type="password" name="pw" placeholder="Wachtwoord" autofocus/><button type="submit">Ontgrendelen</button>${wrong ? '<div class="err">Onjuist wachtwoord</div>' : ""}</form></body></html>`;
}

function hreflangLinks(tenant: string, page: any): string {
  if (!page.transGroup) return "";
  const trans = PagesRepo.translations(tenant, page.transGroup).filter((t: any) => t.status === "published");
  if (trans.length < 2) return "";
  let out = "";
  for (const t of trans) out += `<link rel="alternate" hreflang="${esc(t.locale)}" href="/site/${esc(t.slug)}"/>`;
  const def = trans.find((t: any) => t.locale === "nl") || trans[0];
  out += `<link rel="alternate" hreflang="x-default" href="/site/${esc(def.slug)}"/>`;
  return out;
}
function siteTitle(tenant: string): string { return SettingsRepo.get(tenant).site?.title || "XPO Screens"; }
function pageCrumbs(tenant: string, page: any): { label: string; url: string }[] {
  const trail = [{ label: "Home", url: "/site" }];
  if (page.parentId) { const par = PagesRepo.list(tenant).find((p) => String(p.id) === String(page.parentId)); if (par) trail.push({ label: par.title, url: "/site/" + par.slug }); }
  trail.push({ label: page.title, url: "/site/" + page.slug });
  return trail;
}

export async function renderRoutes(app: FastifyInstance) {
  app.get("/site", async (req, reply) => {
    const tenant = tenantOf(req); setNonce((req as any).cspNonce);
    const nav = NavRepo.get(tenant);
    const settings = SettingsRepo.get(tenant);
    const accent = settings.tokens.primary || settings.theme.accent || undefined;
    const gl = siteGlobals(settings);
    const first = PagesRepo.list(tenant).find((p) => p.status === "published" && p.published);
    reply.type("text/html");
    if (!first) return reply.send(notFoundDoc(tenant, nav, accent));
    const fCtx = { kind: "page" as const, slug: first.slug, title: first.title, site: siteTitle(tenant), breadcrumbs: pageCrumbs(tenant, first), fields: buildFieldMap(tenant, first.meta) };
    const fContent = compose(tenant, first.published!, specsBlock(tenant, first), fCtx);
    const fRoot = themed(tenant, fContent.children || [], fCtx);
    const fOpts = pageOpts(first, "/site/" + first.slug, popupsMarkup(tenant, first.slug), gl, settings.theme.mode); fOpts.extraHead = (fOpts.extraHead || "") + hreflangLinks(tenant, first);
    return sendCached(req, reply, tenant, "/site", () => renderDocument(first.seo.title || first.title, fRoot, tenant, nav, accent, fOpts));
  });

  app.get("/site/:slug", async (req, reply) => {
    const tenant = tenantOf(req); setNonce((req as any).cspNonce);
    const nav = NavRepo.get(tenant);
    const settings = SettingsRepo.get(tenant);
    const accent = settings.tokens.primary || settings.theme.accent || undefined;
    const gl = siteGlobals(settings);
    const page = PagesRepo.getBySlug(tenant, String((req.params as any).slug || ""));
    reply.type("text/html");
    if (!page || page.status !== "published" || !page.published) return reply.code(404).send(notFoundDoc(tenant, nav, accent));
    if (page.visibility === "private") return reply.code(404).send(notFoundDoc(tenant, nav, accent));
    const isPw = page.visibility === "password" && !!page.password;
    if (isPw) {
      const qpw = (req.query as any)?.pw; const provided = qpw != null;
      const ok = (provided && String(qpw) === page.password) || pageCookiePw(req, page);
      if (!ok) { reply.header("cache-control", "no-store"); return reply.code(401).send(passwordGateDoc(page, accent, provided)); }
      if (provided) reply.header("set-cookie", `xpo_pw_${page.id}=${encodeURIComponent(page.password)}; Path=/; Max-Age=86400; SameSite=Lax`);
    }
    const pCtx = { kind: "page" as const, slug: page.slug, title: page.title, site: siteTitle(tenant), breadcrumbs: pageCrumbs(tenant, page), fields: buildFieldMap(tenant, page.meta) };
    const pContent = compose(tenant, page.published, specsBlock(tenant, page), pCtx);
    const pRoot = themed(tenant, pContent.children || [], pCtx);
    const pOpts = pageOpts(page, "/site/" + page.slug, popupsMarkup(tenant, page.slug), gl, settings.theme.mode); pOpts.extraHead = (pOpts.extraHead || "") + hreflangLinks(tenant, page);
    if (isPw) { reply.header("cache-control", "no-store"); return reply.send(renderDocument(page.seo.title || page.title, pRoot, tenant, nav, accent, pOpts)); }
    return sendCached(req, reply, tenant, "/site/" + page.slug, () => renderDocument(page.seo.title || page.title, pRoot, tenant, nav, accent, pOpts));
  });

  // concept-preview via ondertekend token (rendert het concept, noindex, geen cache)
  app.get("/preview/:type/:id", async (req, reply) => {
    const tenant = tenantOf(req); setNonce((req as any).cspNonce);
    const type = String((req.params as any).type || ""); const id = Number((req.params as any).id);
    const v = verifyPreview(String((req.query as any).token || ""));
    if (!v || v.type !== type || v.id !== id || v.tenant !== tenant) return reply.code(403).type("text/html").send("<h1>Preview-link ongeldig of verlopen</h1>");
    const nav = NavRepo.get(tenant); const settings = SettingsRepo.get(tenant);
    const accent = settings.tokens.primary || settings.theme.accent || undefined;
    const gl = siteGlobals(settings);
    reply.header("X-Robots-Tag", "noindex, nofollow");
    reply.header("Cache-Control", "no-store");
    reply.type("text/html");
    const head = gl.head + `<meta name="robots" content="noindex,nofollow"/><meta name="xpo-preview" content="1"/>`;
    if (type === "page") {
      const page = PagesRepo.get(tenant, id);
      if (!page) return reply.code(404).send(notFoundDoc(tenant, nav, accent));
      const ctx = { kind: "page" as const, slug: page.slug, title: page.title, site: siteTitle(tenant), breadcrumbs: pageCrumbs(tenant, page), fields: buildFieldMap(tenant, page.meta) };
      const content = compose(tenant, page.blocks, specsBlock(tenant, page), ctx);
      const root = themed(tenant, content.children || [], ctx);
      return reply.send(renderDocument("Preview · " + (page.seo.title || page.title), root, tenant, nav, accent, { extraHead: head, extraBody: gl.body, defaultTheme: settings.theme.mode, nonce: getNonce() }));
    }
    const post = PostsRepo.get(tenant, id);
    if (!post) return reply.code(404).send(notFoundDoc(tenant, nav, accent));
    const draft = { ...post, published: post.blocks };
    const ctx = { kind: "post" as const, slug: post.slug, title: post.title, site: siteTitle(tenant), author: post.author, date: new Date().toISOString().slice(0, 10), breadcrumbs: [{ label: "Home", url: "/site" }, { label: "Blog", url: "/blog" }, { label: post.title, url: "/blog/" + post.slug }] };
    const root = themed(tenant, postBody(tenant, draft, ctx), ctx);
    return reply.send(renderDocument("Preview · " + (post.seo?.title || post.title), root, tenant, nav, accent, { extraHead: head, extraBody: gl.body, defaultTheme: settings.theme.mode, nonce: getNonce() }));
  });

  // publieke blogpost
  app.get("/blog/:slug", async (req, reply) => {
    const tenant = tenantOf(req); setNonce((req as any).cspNonce);
    const nav = NavRepo.get(tenant);
    const accent = SettingsRepo.get(tenant).theme.accent || undefined;
    const post = PostsRepo.getBySlug(tenant, String((req.params as any).slug || ""));
    reply.type("text/html");
    if (!post || post.status !== "published" || !post.published) return reply.code(404).send(notFoundDoc(tenant, nav, accent));
    const settings = SettingsRepo.get(tenant);
    const gl = siteGlobals(settings);
    const pubPosts = PostsRepo.list(tenant).filter((p) => p.status === "published" && p.published && (p.type || "post") === (post.type || "post"));
    const ix = pubPosts.findIndex((p) => p.id === post.id);
    const prev = ix > 0 ? { title: pubPosts[ix - 1].title, url: "/blog/" + pubPosts[ix - 1].slug } : undefined;
    const next = ix >= 0 && ix < pubPosts.length - 1 ? { title: pubPosts[ix + 1].title, url: "/blog/" + pubPosts[ix + 1].slug } : undefined;
    const ctx = { kind: "post" as const, slug: post.slug, title: post.title, site: siteTitle(tenant), author: post.author, date: new Date(post.updatedAt || Date.now()).toISOString().slice(0, 10), breadcrumbs: [{ label: "Home", url: "/site" }, { label: "Blog", url: "/blog" }, { label: post.title, url: "/blog/" + post.slug }], prev, next };
    const bodyKids = postBody(tenant, post, ctx);
    const approved = CommentsRepo.approvedFor(tenant, Number(post.id));
    const commentsNode: Block = { id: "comments", type: "xpo/comments", settings: { _style: { pad: 32, maxw: 760 }, postId: post.id, items: approved.map((c) => ({ id: c.id, parentId: c.parentId, author: c.author, body: c.body })) }, children: [] };
    const bRoot = themed(tenant, bodyKids, ctx, [commentsNode]);
    return sendCached(req, reply, tenant, "/blog/" + post.slug, () => renderDocument(post.seo.title || post.title, bRoot, tenant, nav, accent, pageOpts(post as any, "/blog/" + post.slug, "", gl, settings.theme.mode)));
  });

  // publieke productpagina
  app.get("/product/:slug", async (req, reply) => {
    const tenant = tenantOf(req); setNonce((req as any).cspNonce);
    const nav = NavRepo.get(tenant);
    const settings = SettingsRepo.get(tenant);
    const accent = settings.tokens.primary || settings.theme.accent || undefined;
    const gl = siteGlobals(settings);
    const p = productBySlug(tenant, String((req.params as any).slug || ""));
    reply.type("text/html");
    if (!p) return reply.code(404).send(notFoundDoc(tenant, nav, accent));
    const img = p.image ? `background-image:url('${esc(safeUrl(p.image))}')` : "";
    const rev = productReviews(tenant, Number(p.id));
    const stars = (n: number) => { let o = ""; for (let i = 1; i <= 5; i++) o += `<span class="xrt-s ${i <= Math.round(n) ? "on" : ""}">\u2605</span>`; return o; };
    const ratingLine = rev.stats.count ? `<div class="xpr-rating"><span class="xpo-rating">${stars(rev.stats.average)}</span><span class="xrt-l">${rev.stats.average} · ${rev.stats.count} review(s)</span></div>` : "";
    const attrSel = (p.attributes || []).filter((a: any) => a.options && a.options.length).map((a: any) =>
      `<label class="xpr-attr-row"><span>${esc(a.name)}</span><select class="xpr-attr" data-attr="${esc(a.name)}">${a.options.map((o: string) => `<option>${esc(o)}</option>`).join("")}</select></label>`).join("");
    const detail = `<div class="xpo-product"><div class="xpr-img ${p.image ? "" : "xpr-img--ph"}" style="${img}"></div><div>${p.category ? `<div class="xpr-cat">${esc(p.category)}</div>` : ""}<h1 class="xpr-name">${esc(p.name)}</h1>${ratingLine}<div class="xpr-price">${esc(p.price)}</div><div class="xpr-stock">${p.stock > 0 ? `Op voorraad (${p.stock})` : "Uitverkocht"}</div>${p.description ? `<div class="xpr-desc">${esc(p.description)}</div>` : ""}${attrSel ? `<div class="xpr-attrs">${attrSel}</div>` : ""}${p.stock > 0 ? `<button class="pillbtn xsh-add" data-product="${esc(p.id)}">In winkelwagen</button>` : ""}</div></div>`;
    // reviews-sectie
    const revList = rev.list.length ? rev.list.map((r: any) => `<div class="xrv-i"><div class="xrv-h"><b>${esc(r.author)}</b><span class="xpo-rating">${stars(r.rating)}</span></div><p>${esc(r.body)}</p></div>`).join("") : `<p class="xrv-empty">Nog geen reviews. Wees de eerste!</p>`;
    const reviewsHtml = `<div class="xpo-reviews" data-reviews="${esc(p.id)}"><h3 class="xpo-h">Reviews</h3>${revList}<form class="xrv-form"><div class="xrv-stars" data-rating="5"><span data-v="1">\u2605</span><span data-v="2">\u2605</span><span data-v="3">\u2605</span><span data-v="4">\u2605</span><span data-v="5">\u2605</span></div><input class="xfm-i" name="author" placeholder="Naam"/><textarea class="xfm-i" name="body" placeholder="Schrijf een review\u2026" required></textarea><button class="pillbtn" type="submit">Plaats review</button><p class="xrv-msg" hidden></p></form></div>`;
    const children: Block[] = [{ id: "pd", type: "xpo/html", settings: { html: detail, _style: { maxw: 1000, pad: 16 } }, children: [] }, { id: "rv", type: "xpo/html", settings: { html: reviewsHtml, _style: { maxw: 1000, pad: 16 } }, children: [] }];
    const related = shopCards(tenant, { category: p.category, limit: 4 }).filter((r: any) => r.id !== p.id).slice(0, 3);
    if (related.length) {
      children.push({ id: "rh", type: "xpo/heading", settings: { text: "Vergelijkbare producten", level: "h3", _style: { maxw: 1000, pad: 16 } }, children: [] });
      children.push({ id: "rs", type: "xpo/shop", settings: { items: related, _style: { maxw: 1000, pad: 8 } }, children: [] });
    }
    const ctx = { kind: "page" as const, slug: "product", title: p.name, site: siteTitle(tenant), breadcrumbs: [{ label: "Home", url: "/site" }, { label: "Winkel", url: "/site/winkel" }, { label: p.name, url: "/product/" + p.slug }] };
    const root = themed(tenant, children, ctx);
    return sendCached(req, reply, tenant, "/product/" + p.slug, () => renderDocument(p.name, root, tenant, nav, accent, { extraHead: gl.head + `<meta name="description" content="${esc((p.description || p.name).slice(0, 160))}"/>`, extraBody: gl.body, defaultTheme: settings.theme.mode, nonce: getNonce() }));
  });

  // publieke blog-index + archieven (categorie/tag/auteur) met paginering
  function renderArchive(req: any, reply: any, opts: { category?: string; tag?: string; author?: string; type?: string }) {
    const tenant = tenantOf(req); setNonce((req as any).cspNonce);
    const nav = NavRepo.get(tenant);
    const settings = SettingsRepo.get(tenant);
    const accent = settings.tokens.primary || settings.theme.accent || undefined;
    const gl = siteGlobals(settings);
    const page = Math.max(1, parseInt(String((req.query as any)?.page || "1"), 10) || 1);
    const arc = postArchive(tenant, { ...opts, page });
    const heading: Block = { id: "ah", type: "xpo/heading", settings: { text: arc.title, level: "h2", _style: { pad: 28, maxw: 1100 } }, children: [] };
    const grid: Block = { id: "ag", type: "xpo/posts", settings: { items: arc.items, _style: { maxw: 1100, pad: 8 } }, children: [] };
    const baseUrl = opts.category ? "/categorie/" + opts.category : opts.tag ? "/tag/" + opts.tag : opts.author ? "/auteur/" + opts.author : opts.type ? "/type/" + opts.type : "/blog";
    const pager: Block[] = [];
    if (arc.pages > 1) {
      if (arc.page > 1) pager.push({ id: "ap", type: "xpo/button", settings: { label: "\u2039 Vorige", url: `${baseUrl}?page=${arc.page - 1}`, variant: "outline", _style: { margin: 6 } }, children: [] });
      pager.push({ id: "apn", type: "xpo/text", settings: { body: `Pagina ${arc.page} van ${arc.pages}`, _style: { pad: 6 } }, children: [] });
      if (arc.page < arc.pages) pager.push({ id: "an", type: "xpo/button", settings: { label: "Volgende \u203a", url: `${baseUrl}?page=${arc.page + 1}`, variant: "outline", _style: { margin: 6 } }, children: [] });
    }
    const empty: Block[] = arc.items.length ? [] : [{ id: "ae", type: "xpo/text", settings: { body: "Nog geen artikelen.", _style: { maxw: 1100, pad: 8 } }, children: [] }];
    const root = themed(tenant, [heading, grid, ...empty, ...pager], { kind: "page", slug: "blog" });
    reply.type("text/html");
    return sendCached(req, reply, tenant, String(req.url).split("?")[0], () => renderDocument(arc.title, root, tenant, nav, accent, { extraHead: gl.head, extraBody: gl.body, defaultTheme: settings.theme.mode, nonce: getNonce() }));
  }
  app.get("/blog", async (req, reply) => renderArchive(req, reply, {}));
  app.get("/categorie/:slug", async (req, reply) => renderArchive(req, reply, { category: String((req.params as any).slug || "") }));
  app.get("/tag/:slug", async (req, reply) => renderArchive(req, reply, { tag: String((req.params as any).slug || "") }));
  app.get("/auteur/:slug", async (req, reply) => renderArchive(req, reply, { author: String((req.params as any).slug || "") }));
  app.get("/type/:key", async (req, reply) => renderArchive(req, reply, { type: String((req.params as any).key || "") } as any));

  // publieke zoekpagina
  app.get("/zoeken", async (req, reply) => {
    const tenant = tenantOf(req); setNonce((req as any).cspNonce);
    const nav = NavRepo.get(tenant);
    const settings = SettingsRepo.get(tenant);
    const accent = settings.tokens.primary || settings.theme.accent || undefined;
    const gl = siteGlobals(settings);
    const q = String((req.query as any)?.q || "").trim();
    const ql = q.toLowerCase();
    const hits: { title: string; url: string }[] = [];
    if (q) {
      for (const p of PagesRepo.list(tenant)) {
        if (p.status !== "published" || !p.published) continue;
        if (p.title.toLowerCase().includes(ql) || (p.seo?.description || "").toLowerCase().includes(ql) || p.slug.includes(ql)) hits.push({ title: p.title, url: "/site/" + p.slug });
      }
      for (const po of PostsRepo.list(tenant)) {
        if (po.status !== "published" || !po.published) continue;
        if (po.title.toLowerCase().includes(ql) || (po.seo?.description || "").toLowerCase().includes(ql) || po.slug.includes(ql)) hits.push({ title: po.title, url: "/blog/" + po.slug });
      }
    }
    const heading: Block = { id: "zh", type: "xpo/heading", settings: { text: q ? `Zoekresultaten voor "${q}"` : "Zoeken", level: "h2", _style: { pad: 28, maxw: 860 } }, children: [] };
    const search: Block = { id: "zs", type: "xpo/search", settings: { placeholder: "Zoeken…", label: "Zoek", value: q, _style: { maxw: 860, pad: 8 } }, children: [] };
    const intro: Block = { id: "zi", type: "xpo/text", settings: { body: q ? (hits.length ? `${hits.length} resultaat${hits.length === 1 ? "" : "en"} gevonden.` : "Geen resultaten gevonden.") : "Typ een zoekterm hierboven.", _style: { maxw: 860, pad: 6 } }, children: [] };
    const items: Block[] = hits.map((h, i) => ({ id: "zr" + i, type: "xpo/button", settings: { label: h.title, url: h.url, variant: "outline", _style: { margin: 6 } }, children: [] }));
    const root = themed(tenant, [heading, search, intro, ...items], { kind: "page", slug: "zoeken" });
    reply.type("text/html");
    return reply.send(renderDocument(q ? `Zoeken: ${q}` : "Zoeken", root, tenant, nav, accent, { extraHead: gl.head + `<meta name="robots" content="noindex,follow"/>`, extraBody: gl.body, defaultTheme: settings.theme.mode, nonce: getNonce() }));
  });
}
