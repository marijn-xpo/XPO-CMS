import Fastify, { type FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { originGuard } from "./common/security.js";
import cors from "@fastify/cors";
import fstatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migrate } from "./db/database.js";
import { getDb } from "./db/database.js";
import { rateLimit } from "./common/ratelimit.js";

export const APP_VERSION = "1.0.0";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { ssoRoutes } from "./modules/auth/sso.routes.js";
import { membersRoutes } from "./modules/members/members.routes.js";
import { pagesRoutes } from "./modules/pages/pages.routes.js";
import { renderRoutes } from "./modules/render/render.routes.js";
import { mediaRoutes } from "./modules/media/media.routes.js";
import { usersRoutes } from "./modules/users/users.routes.js";
import { formsRoutes } from "./modules/forms/forms.routes.js";
import { commerceRoutes } from "./modules/commerce/commerce.routes.js";
import { navigationRoutes } from "./modules/navigation/navigation.routes.js";
import { seoRoutes, RedirectsRepo } from "./modules/seo/seo.routes.js";
import { helpdeskRoutes } from "./modules/helpdesk/helpdesk.routes.js";
import { marketingRoutes } from "./modules/marketing/marketing.routes.js";
import { fieldsRoutes } from "./modules/fields/fields.routes.js";
import { languagesRoutes } from "./modules/languages/languages.routes.js";
import { templatesRoutes } from "./modules/templates/templates.routes.js";
import { settingsRoutes } from "./modules/settings/settings.routes.js";
import { analyticsRoutes } from "./modules/analytics/analytics.routes.js";
import { systemRoutes } from "./modules/system/system.routes.js";
import { imgRoutes } from "./modules/media/img.routes.js";
import { activityRoutes, ActivityRepo } from "./modules/activity/activity.routes.js";
import { invalidateTenant } from "./core/render-cache.js";
import { postsRoutes } from "./modules/posts/posts.routes.js";
import { snippetsRoutes } from "./modules/snippets/snippets.routes.js";
import { popupsRoutes } from "./modules/popups/popups.routes.js";
import { searchRoutes } from "./modules/search/search.routes.js";
import { backupRoutes } from "./modules/backup/backup.routes.js";
import { commentsRoutes } from "./modules/comments/comments.routes.js";
import { aiRoutes } from "./modules/ai/ai.routes.js";
import { shopRoutes } from "./modules/shop/shop.routes.js";
import { mailRoutes } from "./modules/mail/mail.routes.js";
import { tenantOf } from "./common/tenant.js";
import { ensureUploadDir, UPLOAD_DIR } from "./modules/media/media.service.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  migrate();
  await import("./plugins/index.js"); // laad geregistreerde plugins (widgets, betaalproviders, hooks)
  await import("./core/jobs-handlers.js"); // registreer job-handlers (e-mail, sitemap, import)
  (await import("./core/assets-build.js")).ensureBundle(); // front-end scripts bundelen
  await ensureUploadDir();
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 28 * 1024 * 1024 });

  await app.register(cors, { origin: true });

  // CSRF/Origin-bescherming + per-request CSP-nonce
  app.addHook("onRequest", async (req, reply) => {
    req.cspNonce = randomBytes(16).toString("base64");
    await new Promise<void>((resolve) => originGuard(req, reply as any, () => resolve()));
  });

  const cspFor = (nonce: string) => [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://cdnjs.cloudflare.com`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "frame-src 'self' https://www.google.com https://www.youtube.com https://player.vimeo.com https://w.soundcloud.com",
    "connect-src 'self' https:",
    "media-src 'self' https:",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'",
    "report-uri /api/csp-report",
  ].join("; ");
  const cspAdmin = [
    "default-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https: blob:", "connect-src 'self' https:", "object-src 'none'", "base-uri 'self'",
  ].join("; ");
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    reply.header("Permissions-Policy", "geolocation=(), microphone=(), camera=(), interest-cohort=()");
    const isAdmin = String(req.url || "").startsWith("/admin");
    reply.header("Content-Security-Policy", isAdmin ? cspAdmin : cspFor(req.cspNonce || ""));
    return payload;
  });
  // CSP-violations verzamelen (lichtgewicht logging).
  app.post("/api/csp-report", async (_req, reply) => reply.code(204).send());

  // rate-limiting op inlog-endpoints (brute-force-bescherming)
  const RL_MAX = Number(process.env.XPO_RL_MAX || 20);
  const RL_WINDOW = Number(process.env.XPO_RL_WINDOW_MS || 10 * 60 * 1000);
  app.addHook("onRequest", async (req, reply) => {
    const path = (req.url || "").split("?")[0];
    const isLogin = req.method === "POST" && path === "/api/auth/login";
    const isCallback = req.method === "GET" && path === "/api/auth/sso/callback";
    if (!isLogin && !isCallback) return;
    const rl = rateLimit(`${req.ip}:${path}`, RL_MAX, RL_WINDOW);
    if (!rl.ok) { reply.header("Retry-After", String(rl.retryAfter)); return reply.code(429).send({ error: "Te veel pogingen. Probeer het later opnieuw." }); }
  });

  // publieke 301/302-redirects (vóór de routes)
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD") return;
    const path = (req.url || "/").split("?")[0];
    if (path === "/" || /^\/(api|admin|assets|uploads|health|site|blog|categorie|tag|auteur|type|product|winkel|account|sitemap\.xml|feed\.xml|robots\.txt|zoeken)(\/|$)/.test(path)) return;
    const r = RedirectsRepo.findByFrom(tenantOf(req), path);
    if (r) return reply.redirect(r.to, Number(r.code) || 301);
  });

  // audittrail: leg elke schrijfactie naar de API vast
  app.addHook("onResponse", async (req, reply) => {
    const m = req.method;
    if (m !== "POST" && m !== "PUT" && m !== "PATCH" && m !== "DELETE") return;
    const url = req.url || "";
    if (!url.startsWith("/api/") || url.startsWith("/api/activity") || url.startsWith("/api/auth/login")) return;
    const actor = (req as any).user?.email || "anoniem";
    try { ActivityRepo.recordRequest(tenantOf(req), m, url, actor, reply.statusCode); } catch { /* log mag nooit een request breken */ }
      if (reply.statusCode < 400 && !/\/api\/(track|csp-report|auth|cart|checkout|payments|public\/(login|register|logout))/.test(url)) { try { await invalidateTenant(tenantOf(req)); } catch { /* */ } }
  });

  await app.register(authRoutes);
  await app.register(pagesRoutes);
  await app.register(renderRoutes);
  await app.register(mediaRoutes);
  await app.register(usersRoutes);
  await app.register(formsRoutes);
  await app.register(commerceRoutes);
  await app.register(navigationRoutes);
  await app.register(seoRoutes);
  await app.register(helpdeskRoutes);
  await app.register(marketingRoutes);
  await app.register(fieldsRoutes);
  await app.register(languagesRoutes);
  await app.register(templatesRoutes);
  await app.register(settingsRoutes);
  await app.register(analyticsRoutes);
  await app.register(systemRoutes);
  await app.register(imgRoutes);
  await app.register(activityRoutes);
  await app.register(postsRoutes);
  await app.register(snippetsRoutes);
  await app.register(popupsRoutes);
  await app.register(searchRoutes);
  await app.register(backupRoutes);
  await app.register(commentsRoutes);
  await app.register(aiRoutes);
  await app.register(shopRoutes);
  await app.register(mailRoutes);
  await app.register(ssoRoutes);
  await app.register(membersRoutes);

  await app.register(fstatic, { root: join(here, "../admin"), prefix: "/admin/" });
  await app.register(fstatic, { root: UPLOAD_DIR, prefix: "/uploads/", decorateReply: false });
  await app.register(fstatic, { root: join(here, "../public"), prefix: "/assets/", decorateReply: false, cacheControl: true, maxAge: "365d", immutable: true });
  app.get("/", async (_req, reply) => reply.redirect("/admin/"));
  app.get("/health", async () => ({ ok: true, ts: Date.now() }));
  app.get("/api/health", async () => {
    let db = "ok";
    try { getDb().prepare("SELECT 1 AS n").get(); } catch { db = "error"; }
    return { ok: db === "ok", version: APP_VERSION, uptime: Math.round(process.uptime()), db, ts: Date.now() };
  });

  await app.ready();
  return app;
}
