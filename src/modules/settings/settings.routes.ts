import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";

export type Settings = {
  theme: { radius: number; accent: string; mode: string; font: string };
  tokens: { primary: string; text: string; bg: string; fontHeading: string; fontBody: string };
  globals: { css: string; js: string };
  ai: { assistant: boolean; name: string; greeting: string; fallback: string; groqKey: string; anthropicKey: string };
  shop: { mollieKey: string; vatId: string; currency: string; vatRate: number; vatRates: Record<string, number>; zones: { name: string; countries: string[]; tiers: { maxWeight: number; price: number }[] }[]; shipping: { name: string; price: number }[] };
  mail: { mode: string; from: string; host: string; port: number; user: string; pass: string; secure: boolean };
  media: { driver: string; accountUrl: string; container: string; sasToken: string };
  sso: { enabled: boolean; tenantId: string; clientId: string; clientSecret: string; redirectUri: string; defaultRole: string; roleMap: Record<string, string> };
  contentTypes: { key: string; singular: string; plural: string; slugBase: string; archive: boolean }[];
  integrations: { cat: string; items: { n: string; d: string; ic: string; on: boolean }[] }[];
  site: { title: string };
};

const DEFAULTS: Settings = {
  theme: { radius: 14, accent: "", mode: "dark", font: "" },
  tokens: { primary: "", text: "", bg: "", fontHeading: "", fontBody: "" },
  globals: { css: "", js: "" },
  ai: { assistant: false, name: "Quinty", greeting: "Hoi! Ik ben Quinty, de assistent van XPO Screens. Waarmee kan ik je helpen?", fallback: "Daar heb ik nog geen informatie over. Probeer je vraag anders te stellen of neem contact op.", groqKey: "", anthropicKey: "" },
  shop: { mollieKey: "", vatId: "", currency: "EUR", vatRate: 21, vatRates: { NL: 21, BE: 21, DE: 19, FR: 20 }, zones: [{ name: "Nederland", countries: ["NL"], tiers: [{ maxWeight: 30000, price: 695 }, { maxWeight: 999999999, price: 1995 }] }, { name: "EU", countries: ["BE", "DE", "FR"], tiers: [{ maxWeight: 30000, price: 1295 }, { maxWeight: 999999999, price: 2995 }] }], shipping: [{ name: "Standaard verzending", price: 695 }, { name: "Ophalen", price: 0 }] },
  mail: { mode: "log", from: "noreply@xposcreens.com", host: "", port: 587, user: "", pass: "", secure: false },
  media: { driver: "local", accountUrl: "", container: "media", sasToken: "" },
  sso: { enabled: false, tenantId: "", clientId: "", clientSecret: "", redirectUri: "", defaultRole: "viewer", roleMap: {} },
  contentTypes: [{ key: "post", singular: "Post", plural: "Posts", slugBase: "blog", archive: true }],
  integrations: [
    { cat: "Azure & identiteit", items: [
      { n: "Entra ID (SSO)", d: "Single sign-on", ic: "shield", on: true },
      { n: "Key Vault", d: "Secrets", ic: "shield", on: true },
      { n: "Sentinel", d: "Security-logging", ic: "shield", on: true } ] },
    { cat: "Betalingen", items: [ { n: "Mollie", d: "iDEAL, kaarten, Apple Pay, Bancontact", ic: "cart", on: true } ] },
    { cat: "AI & data", items: [
      { n: "XARA AI", d: "Content en support", ic: "spark", on: true },
      { n: "Search Console", d: "SEO-data", ic: "seo", on: true },
      { n: "Google Analytics 4", d: "Verkeer en conversies", ic: "chart", on: false } ] },
    { cat: "Communicatie", items: [
      { n: "Microsoft Graph mail", d: "365 e-mail", ic: "bell", on: true },
      { n: "Outlook helpdesk", d: "Tickets uit mailbox", ic: "help", on: false } ] },
  ],
  site: { title: "XPO Screens" },
};

function clamp(n: any, lo: number, hi: number, dflt: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt;
}
function clip(s: unknown, n: number): string {
  return String(s ?? "").trim().slice(0, n);
}

function sanitize(input: any): Settings {
  const t = input?.theme ?? {};
  const s: Settings = {
    theme: {
      radius: clamp(t.radius, 0, 22, 14),
      accent: clip(t.accent, 32),
      mode: t.mode === "light" ? "light" : "dark",
      font: clip(t.font, 80),
    },
    integrations: Array.isArray(input?.integrations)
      ? input.integrations.slice(0, 20).map((g: any) => ({
          cat: clip(g?.cat, 60),
          items: (Array.isArray(g?.items) ? g.items : []).slice(0, 20).map((it: any) => ({
            n: clip(it?.n, 60), d: clip(it?.d, 120), ic: clip(it?.ic, 24), on: !!it?.on,
          })),
        }))
      : DEFAULTS.integrations,
    tokens: {
      primary: clip(input?.tokens?.primary, 32), text: clip(input?.tokens?.text, 32), bg: clip(input?.tokens?.bg, 32),
      fontHeading: clip(input?.tokens?.fontHeading, 80), fontBody: clip(input?.tokens?.fontBody, 80),
    },
    globals: { css: clip(input?.globals?.css, 40000), js: clip(input?.globals?.js, 40000) },
    ai: {
      assistant: !!input?.ai?.assistant,
      name: clip(input?.ai?.name, 40) || "Quinty",
      greeting: clip(input?.ai?.greeting, 300) || DEFAULTS.ai.greeting,
      fallback: clip(input?.ai?.fallback, 300) || DEFAULTS.ai.fallback,
      groqKey: clip(input?.ai?.groqKey, 200),
      anthropicKey: clip(input?.ai?.anthropicKey, 200),
    },
    shop: { mollieKey: clip(input?.shop?.mollieKey, 200), vatId: clip(input?.shop?.vatId, 40), currency: clip(input?.shop?.currency, 8) || "EUR", vatRate: clamp(input?.shop?.vatRate, 0, 99, 21),
      vatRates: (input?.shop?.vatRates && typeof input.shop.vatRates === "object") ? Object.fromEntries(Object.entries(input.shop.vatRates).slice(0, 50).map(([k, v]: any) => [String(k).toUpperCase().slice(0, 2), clamp(v, 0, 99, 21)])) : DEFAULTS.shop.vatRates,
      zones: Array.isArray(input?.shop?.zones) ? input.shop.zones.slice(0, 20).map((z: any) => ({ name: clip(z?.name, 60) || "Zone", countries: Array.isArray(z?.countries) ? z.countries.slice(0, 60).map((c: any) => String(c).toUpperCase().slice(0, 2)) : [], tiers: Array.isArray(z?.tiers) ? z.tiers.slice(0, 20).map((t: any) => ({ maxWeight: Math.max(0, Math.floor(Number(t?.maxWeight) || 0)), price: Math.max(0, Math.floor(Number(t?.price) || 0)) })) : [] })) : DEFAULTS.shop.zones,
      shipping: Array.isArray(input?.shop?.shipping) ? input.shop.shipping.slice(0, 12).map((m: any) => ({ name: clip(m?.name, 80) || "Verzending", price: Math.max(0, Math.floor(Number(m?.price) || 0)) })) : DEFAULTS.shop.shipping },
    mail: {
      mode: input?.mail?.mode === "smtp" ? "smtp" : "log",
      from: clip(input?.mail?.from, 200) || DEFAULTS.mail.from,
      host: clip(input?.mail?.host, 200), port: clamp(input?.mail?.port, 1, 65535, 587),
      user: clip(input?.mail?.user, 200), pass: clip(input?.mail?.pass, 200), secure: !!input?.mail?.secure,
    },
    media: {
      driver: input?.media?.driver === "blob" ? "blob" : "local",
      accountUrl: clip(input?.media?.accountUrl, 300), container: clip(input?.media?.container, 120) || "media", sasToken: clip(input?.media?.sasToken, 600),
    },
    sso: (() => {
      const ROLES = ["viewer", "editor", "admin", "superadmin"];
      const canon = (r: any) => (ROLES.includes(String(r)) ? String(r) : "viewer");
      const rmIn = input?.sso?.roleMap && typeof input.sso.roleMap === "object" ? input.sso.roleMap : {};
      const roleMap: Record<string, string> = {};
      for (const k of Object.keys(rmIn).slice(0, 50)) roleMap[clip(k, 120)] = canon(rmIn[k]);
      return {
        enabled: !!input?.sso?.enabled, tenantId: clip(input?.sso?.tenantId, 80), clientId: clip(input?.sso?.clientId, 80),
        clientSecret: clip(input?.sso?.clientSecret, 400), redirectUri: clip(input?.sso?.redirectUri, 300),
        defaultRole: canon(input?.sso?.defaultRole), roleMap,
      };
    })(),
    contentTypes: (() => {
      const slug = (v: any) => clip(v, 60).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      const input2 = Array.isArray(input?.contentTypes) ? input.contentTypes : DEFAULTS.contentTypes;
      const out = input2.slice(0, 20).map((t: any) => ({ key: slug(t?.key) || "post", singular: clip(t?.singular, 60) || "Post", plural: clip(t?.plural, 60) || "Posts", slugBase: slug(t?.slugBase) || "blog", archive: t?.archive !== false }));
      if (!out.some((t: any) => t.key === "post")) out.unshift(DEFAULTS.contentTypes[0]);
      return out;
    })(),
    site: { title: clip(input?.site?.title, 80) || DEFAULTS.site.title },
  };
  return s;
}

export const SettingsRepo = {
  get(tenant: string): Settings {
    const row = getDb().prepare("SELECT json FROM settings WHERE tenant_id = ?").get(tenant) as { json: string } | undefined;
    if (!row) return JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const stored = JSON.parse(row.json);
      return { ...DEFAULTS, ...stored, theme: { ...DEFAULTS.theme, ...(stored.theme || {}) }, tokens: { ...DEFAULTS.tokens, ...(stored.tokens || {}) }, globals: { ...DEFAULTS.globals, ...(stored.globals || {}) }, ai: { ...DEFAULTS.ai, ...(stored.ai || {}) }, shop: { ...DEFAULTS.shop, ...(stored.shop || {}), shipping: Array.isArray(stored.shop?.shipping) ? stored.shop.shipping : DEFAULTS.shop.shipping }, mail: { ...DEFAULTS.mail, ...(stored.mail || {}) }, media: { ...DEFAULTS.media, ...(stored.media || {}) }, sso: { ...DEFAULTS.sso, ...(stored.sso || {}) }, contentTypes: Array.isArray(stored.contentTypes) && stored.contentTypes.length ? stored.contentTypes : DEFAULTS.contentTypes, site: { ...DEFAULTS.site, ...(stored.site || {}) } };
    } catch {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  },
  set(tenant: string, input: any): Settings {
    const clean = sanitize(input);
    getDb().prepare(
      "INSERT INTO settings (tenant_id, json) VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET json = excluded.json"
    ).run(tenant, JSON.stringify(clean));
    return clean;
  },
};

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", { preHandler: authGuard }, async (req, reply) => reply.send(SettingsRepo.get(tenantOf(req))));
  app.put("/api/settings", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    reply.send(SettingsRepo.set(tenantOf(req), req.body ?? {}))
  );
}
