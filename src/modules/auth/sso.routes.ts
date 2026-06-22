import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { getDb } from "../../db/database.js";
import { tenantOf } from "../../common/tenant.js";
import { signToken } from "../../common/auth.js";
import { SettingsRepo } from "../settings/settings.routes.js";
import { ActivityRepo } from "../activity/activity.routes.js";

const ROLE_LEVEL: Record<string, number> = { viewer: 0, editor: 1, admin: 2, superadmin: 3 };

type SsoCfg = { enabled: boolean; tenantId: string; clientId: string; clientSecret: string; redirectUri: string; defaultRole: string; roleMap: Record<string, string> };

// bouw de Microsoft Entra ID authorize-URL (autorisatiecode-flow)
export function buildAuthorizeUrl(cfg: SsoCfg, state: string): string {
  const base = `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/authorize`;
  const q = new URLSearchParams({
    client_id: cfg.clientId, response_type: "code", redirect_uri: cfg.redirectUri,
    response_mode: "query", scope: "openid profile email User.Read", state,
  });
  return `${base}?${q.toString()}`;
}

// map Entra-groepen op de hoogste passende rol (anders de standaardrol)
export function mapGroupsToRole(groups: string[], roleMap: Record<string, string>, fallback: string): string {
  let best = fallback; let bestLvl = ROLE_LEVEL[fallback] ?? 0;
  for (const g of groups || []) {
    const r = roleMap[g];
    if (r && (ROLE_LEVEL[r] ?? -1) > bestLvl) { best = r; bestLvl = ROLE_LEVEL[r]; }
  }
  return best;
}

// maak of werk een gebruiker bij op basis van de SSO-claims (geen wachtwoord)
export function ssoUpsertUser(tenant: string, email: string, name: string, role: string): { id: number; email: string; name: string; role: string } {
  const e = String(email || "").toLowerCase();
  const ex = getDb().prepare("SELECT id, name, email, role FROM users WHERE tenant_id = ? AND email = ?").get(tenant, e) as any;
  if (ex) {
    getDb().prepare("UPDATE users SET role = ?, active = 1 WHERE tenant_id = ? AND id = ?").run(role, tenant, ex.id);
    return { id: ex.id, email: e, name: ex.name, role };
  }
  const info = getDb().prepare("INSERT INTO users (tenant_id, name, email, role, password_hash, active, created_at) VALUES (?, ?, ?, ?, NULL, 1, ?)")
    .run(tenant, String(name || e).slice(0, 120), e, role, new Date().toISOString());
  return { id: Number(info.lastInsertRowid), email: e, name: String(name || e), role };
}

// decodeer een JWT-payload (id_token). NB: in productie hoort de handtekening geverifieerd te worden tegen de JWKS van Entra.
function decodeJwtPayload(jwt: string): any {
  try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")); } catch { return {}; }
}

// wissel de autorisatiecode in voor tokens (vereist netwerk naar Microsoft)
async function exchangeCode(cfg: SsoCfg, code: string): Promise<{ idToken: string } | null> {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
      method: "POST", signal: ctrl.signal, headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, grant_type: "authorization_code", redirect_uri: cfg.redirectUri, scope: "openid profile email" }).toString(),
    });
    clearTimeout(t);
    const j: any = await r.json();
    return j?.id_token ? { idToken: j.id_token } : null;
  } catch { return null; }
}

export async function ssoRoutes(app: FastifyInstance) {
  app.get("/api/auth/sso/login", async (req, reply) => {
    const tenant = tenantOf(req);
    const cfg = SettingsRepo.get(tenant).sso as SsoCfg;
    if (!cfg.enabled || !cfg.tenantId || !cfg.clientId || !cfg.redirectUri) {
      return reply.code(400).send({ error: "Single sign-on is niet (volledig) geconfigureerd" });
    }
    const state = randomBytes(12).toString("hex");
    return reply.redirect(buildAuthorizeUrl(cfg, state));
  });

  app.get("/api/auth/sso/callback", async (req, reply) => {
    const tenant = tenantOf(req);
    const cfg = SettingsRepo.get(tenant).sso as SsoCfg;
    if (!cfg.enabled) return reply.code(400).send({ error: "Single sign-on staat uit" });
    const code = String((req.query as any)?.code || "");
    if (!code) return reply.code(400).send({ error: "Geen autorisatiecode ontvangen" });
    const tok = await exchangeCode(cfg, code);
    if (!tok) return reply.code(502).send({ error: "Token-uitwisseling met Microsoft mislukt (vereist productieomgeving + netwerk)" });
    const claims = decodeJwtPayload(tok.idToken);
    const email = claims.preferred_username || claims.email || claims.upn || "";
    if (!email) return reply.code(400).send({ error: "Geen e-mailadres in de SSO-claims" });
    const role = mapGroupsToRole(claims.groups || [], cfg.roleMap, cfg.defaultRole);
    const user = ssoUpsertUser(tenant, email, claims.name || email, role);
    const token = signToken({ sub: user.id, email: user.email, role: user.role, tenant, tv: (user as any).token_version ?? 0 });
    try { ActivityRepo.record(tenant, { actor: user.email, action: "Ingelogd via SSO", target: "/api/auth/sso/callback", status: 200 }); } catch { /* nooit blokkeren */ }
    return reply.redirect(`/admin/?sso_token=${encodeURIComponent(token)}`);
  });
}
