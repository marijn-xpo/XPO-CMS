import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../../db/database.js";
import { tenantOf } from "../../common/tenant.js";
import { authGuard, signToken, verifyPassword, hashPassword, needsRehash } from "../../common/auth.js";
import { ActivityRepo } from "../activity/activity.routes.js";
import { loginGuard, recordLoginResult } from "../../common/lockout.js";

type UserRow = { id: number; name: string; email: string; role: string; password_hash: string | null; token_version: number };

const REFRESH_TTL_MS = Number(process.env.XPO_REFRESH_TTL || 30 * 24 * 60 * 60 * 1000); // 30 dagen
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function issueRefresh(tenant: string, userId: number, req: FastifyRequest): string {
  const raw = randomBytes(32).toString("hex");
  const id = "s_" + randomBytes(8).toString("hex");
  const now = Date.now();
  getDb().prepare("INSERT INTO auth_sessions (id, tenant_id, user_id, token_hash, user_agent, ip, expires_at, revoked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)")
    .run(id, tenant, userId, sha(raw), String(req.headers["user-agent"] || "").slice(0, 200), req.ip || "", now + REFRESH_TTL_MS, now);
  return id + "." + raw;
}
function rotateRefresh(token: string, req: FastifyRequest): { userId: number; tenant: string; role: string; email: string; name: string; refresh: string } | null {
  const [id, raw] = (token || "").split(".");
  if (!id || !raw) return null;
  const db = getDb();
  const s = db.prepare("SELECT * FROM auth_sessions WHERE id = ?").get(id) as any;
  if (!s || s.revoked || s.expires_at < Date.now() || s.token_hash !== sha(raw)) return null;
  const u = db.prepare("SELECT id, name, email, role, tenant_id, token_version FROM users WHERE id = ? AND active = 1").get(s.user_id) as any;
  if (!u) return null;
  db.prepare("UPDATE auth_sessions SET revoked = 1 WHERE id = ?").run(id); // rotatie: oude sessie intrekken
  const refresh = issueRefresh(u.tenant_id, u.id, req);
  return { userId: u.id, tenant: u.tenant_id, role: u.role, email: u.email, name: u.name, refresh };
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", async (req, reply) => {
    const { email, password } = (req.body as any) || {};
    const tenant = tenantOf(req);
    const key = String(email || "").toLowerCase() + "|" + (req.ip || "");
    const lock = loginGuard(key);
    if (!lock.ok) { reply.header("Retry-After", String(lock.retryAfter)); return reply.code(429).send({ error: "Te veel mislukte pogingen. Probeer later opnieuw." }); }

    const user = getDb().prepare("SELECT id, name, email, role, password_hash, token_version FROM users WHERE tenant_id = ? AND email = ?")
      .get(tenant, String(email || "").toLowerCase()) as UserRow | undefined;

    if (!user || !verifyPassword(String(password || ""), user.password_hash)) {
      recordLoginResult(key, false);
      try { ActivityRepo.record(tenant, { actor: String(email || "onbekend"), action: "Mislukte login", target: "/api/auth/login", status: 401 }); } catch { /* */ }
      return reply.code(401).send({ error: "Onjuiste inloggegevens" });
    }
    recordLoginResult(key, true);
    // wachtwoord stilletjes upgraden naar het sterkere formaat
    if (needsRehash(user.password_hash)) { try { getDb().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(String(password)), user.id); } catch { /* */ } }

    const token = signToken({ sub: user.id, email: user.email, role: user.role, tenant, tv: user.token_version ?? 0 });
    const refreshToken = issueRefresh(tenant, user.id, req);
    try { ActivityRepo.record(tenant, { actor: user.email, action: "Ingelogd", target: "/api/auth/login", status: 200 }); } catch { /* */ }
    return reply.send({ token, refreshToken, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  });

  app.post("/api/auth/refresh", async (req, reply) => {
    const rt = rotateRefresh(String((req.body as any)?.refreshToken || ""), req);
    if (!rt) return reply.code(401).send({ error: "Refresh-token ongeldig" });
    const u = getDb().prepare("SELECT token_version FROM users WHERE id = ?").get(rt.userId) as any;
    const token = signToken({ sub: rt.userId, email: rt.email, role: rt.role, tenant: rt.tenant, tv: u?.token_version ?? 0 });
    return reply.send({ token, refreshToken: rt.refresh, user: { id: rt.userId, name: rt.name, email: rt.email, role: rt.role } });
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const [id, raw] = String((req.body as any)?.refreshToken || "").split(".");
    if (id && raw) { const s = getDb().prepare("SELECT token_hash FROM auth_sessions WHERE id = ?").get(id) as any; if (s && s.token_hash === sha(raw)) getDb().prepare("UPDATE auth_sessions SET revoked = 1 WHERE id = ?").run(id); }
    return reply.send({ ok: true });
  });

  // logout-overal: alle access- én refresh-tokens van de gebruiker ongeldig maken.
  app.post("/api/auth/logout-all", { preHandler: authGuard }, async (req, reply) => {
    const uid = req.user!.sub;
    getDb().prepare("UPDATE users SET token_version = token_version + 1 WHERE id = ?").run(uid);
    getDb().prepare("UPDATE auth_sessions SET revoked = 1 WHERE user_id = ?").run(uid);
    try { ActivityRepo.record(tenantOf(req), { actor: req.user!.email, action: "Uitgelogd (alle apparaten)", target: "/api/auth/logout-all", status: 200 }); } catch { /* */ }
    return reply.send({ ok: true });
  });

  app.get("/api/auth/me", { preHandler: authGuard }, async (req, reply) => reply.send({ user: req.user }));
}
