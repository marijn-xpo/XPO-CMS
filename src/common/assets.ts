// Asset-URL's met CDN-basis + immutable cache-busting (lost het Kinsta-stale-cache-probleem op:
// versie-constante in productie, alles immutable cachebaar).
export const ASSET_BASE = (process.env.XPO_ASSET_BASE || "/assets").replace(/\/$/, "");
export const ASSET_VER = process.env.XPO_ASSET_VER || "1.0.0";
export function assetUrl(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${ASSET_BASE}${path.startsWith("/") ? path : "/" + path}${sep}v=${ASSET_VER}`;
}
