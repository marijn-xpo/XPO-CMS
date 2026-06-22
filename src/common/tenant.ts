import type { FastifyRequest } from "fastify";

export const DEFAULT_TENANT = process.env.XPO_DEFAULT_TENANT || "xpo";

// Bekende tenants (config via env). Onbekende waarden worden nooit geaccepteerd -> geen phantom-tenants.
export const KNOWN_TENANTS: Set<string> = new Set(
  (process.env.XPO_KNOWN_TENANTS || "xpo,altermedia").split(",").map((s) => s.trim()).filter(Boolean),
);

// Domein -> tenant. Config via env XPO_TENANTS (JSON), met nette defaults voor XPO + Altermedia.
function hostMap(): Record<string, string> {
  try { if (process.env.XPO_TENANTS) return JSON.parse(process.env.XPO_TENANTS); } catch { /* */ }
  return {
    "xposcreens.com": "xpo", "www.xposcreens.com": "xpo", "xpo.local": "xpo",
    "altermedia.nl": "altermedia", "www.altermedia.nl": "altermedia", "altermedia.local": "altermedia",
  };
}

export function isKnownTenant(t: string | undefined | null): t is string {
  return !!t && KNOWN_TENANTS.has(t);
}

// Resolutievolgorde:
// 1) Ingelogde gebruiker -> tenant uit het geverifieerde token (kan NIET via header worden overschreven).
// 2) Publiek verkeer -> exacte host, dan subdomein.
// 3) Dev/test -> x-tenant header, maar alleen als die bij een bekende tenant hoort.
// 4) Standaard-tenant.
export function resolveTenant(req: FastifyRequest): string {
  if (isKnownTenant(req.user?.tenant)) return req.user!.tenant;

  const host = String(req.headers["host"] || "").split(":")[0].toLowerCase();
  const map = hostMap();
  if (host && map[host] && isKnownTenant(map[host])) return map[host];
  const sub = host.split(".")[0];
  if (isKnownTenant(sub)) return sub;

  const h = req.headers["x-tenant"];
  if (typeof h === "string" && isKnownTenant(h)) return h;

  return DEFAULT_TENANT;
}

// Backwards-compatibele naam die overal in de modules wordt gebruikt.
export function tenantOf(req: FastifyRequest): string {
  return resolveTenant(req);
}
