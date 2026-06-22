import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { getSecret } from "./secrets.js";
import { getDb } from "../db/database.js";

const SECRET = getSecret("XPO_SECRET", "dev-secret-change-me");
const PEPPER = getSecret("XPO_PEPPER", "");
const ACCESS_TTL_SECONDS = Number(process.env.XPO_ACCESS_TTL || 15 * 60); // korte access-token (15 min)

// ---- wachtwoorden: scrypt + per-gebruiker salt + server-pepper ----
const N = 16384, r = 8, p = 1, KEYLEN = 32;
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw + PEPPER, salt, KEYLEN, { N, r, p });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string | null): boolean {
  if (!stored) return false;
  try {
    if (stored.startsWith("scrypt$")) {
      const [, saltHex, hashHex] = stored.split("$");
      const hash = scryptSync(pw + PEPPER, Buffer.from(saltHex, "hex"), KEYLEN, { N, r, p });
      const exp = Buffer.from(hashHex, "hex");
      return hash.length === exp.length && timingSafeEqual(hash, exp);
    }
    // legacy-formaat 'salt:hash' (zonder pepper) — blijft werken, wordt bij login geüpgraded.
    const [saltHex, hashHex] = stored.split(":");
    if (!saltHex || !hashHex) return false;
    const hash = scryptSync(pw, Buffer.from(saltHex, "hex"), KEYLEN);
    const exp = Buffer.from(hashHex, "hex");
    return hash.length === exp.length && timingSafeEqual(hash, exp);
  } catch { return false; }
}
export function needsRehash(stored: string | null): boolean {
  return !stored || !stored.startsWith("scrypt$");
}
// Minimale wachtwoordsterkte (lengte + variatie).
export function passwordIssue(pw: string): string | null {
  if (typeof pw !== "string" || pw.length < 8) return "Wachtwoord moet minstens 8 tekens zijn";
  if (pw.length > 200) return "Wachtwoord te lang";
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 2) return "Gebruik letters én cijfers/symbolen";
  return null;
}

// ---- access-token (compact, HMAC-ondertekend) ----
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
export type TokenPayload = { sub: number; email: string; role: string; tenant: string; tv: number; exp: number };

export function signToken(p2: Omit<TokenPayload, "exp">): string {
  const payload: TokenPayload = { ...p2, exp: Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS };
  const body = b64(JSON.stringify(payload));
  const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
export function verifyToken(token: string): TokenPayload | null {
  const [body, sig] = (token || "").split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ---- rollen & permissies ----
export const ROLE_RANK: Record<string, number> = { viewer: 0, author: 1, editor: 2, shop_manager: 2, seo: 2, admin: 3, superadmin: 4 };
const ROLE_PERMS: Record<string, string[]> = {
  viewer: ["read"],
  author: ["read", "content:draft"],
  editor: ["read", "content:draft", "content:publish", "media"],
  shop_manager: ["read", "shop", "media"],
  seo: ["read", "seo"],
  admin: ["*"],
  superadmin: ["*"],
};
export function hasPermission(role: string, perm: string): boolean {
  const perms = ROLE_PERMS[role] || [];
  return perms.includes("*") || perms.includes(perm);
}

declare module "fastify" {
  interface FastifyRequest { user?: TokenPayload; cspNonce?: string }
}

export function authGuard(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  const payload = verifyToken(token);
  if (!payload) { reply.code(401).send({ error: "Niet ingelogd" }); return; }
  // token-revocatie: tv moet overeenkomen met de huidige versie in de DB (logout-overal).
  try {
    const u = getDb().prepare("SELECT token_version, active FROM users WHERE id = ?").get(payload.sub) as any;
    if (!u || u.active === 0 || (u.token_version ?? 0) !== (payload.tv ?? 0)) { reply.code(401).send({ error: "Sessie verlopen" }); return; }
  } catch { /* tabel kan in edge-cases ontbreken; val terug op tokensignatuur */ }
  req.user = payload;
  done();
}
export function requireRole(min: string) {
  return (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const r2 = req.user?.role || "viewer";
    if ((ROLE_RANK[r2] ?? -1) < (ROLE_RANK[min] ?? 99)) { reply.code(403).send({ error: "Onvoldoende rechten" }); return; }
    done();
  };
}
export function requirePermission(perm: string) {
  return (req: FastifyRequest, reply: FastifyReply, done: () => void) => {
    if (!hasPermission(req.user?.role || "viewer", perm)) { reply.code(403).send({ error: "Onvoldoende rechten" }); return; }
    done();
  };
}
