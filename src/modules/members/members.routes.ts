import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHmac } from "node:crypto";
import { getDb } from "../../db/database.js";
import { tenantOf } from "../../common/tenant.js";
import { hashPassword, verifyPassword, passwordIssue } from "../../common/auth.js";
import { rateLimit } from "../../common/ratelimit.js";
import { NavRepo } from "../navigation/navigation.routes.js";
import { SettingsRepo } from "../settings/settings.routes.js";
import { renderDocument, esc, type Block } from "../../engine/engine.js";
import { setNonce, nonceAttr, getNonce } from "../../common/nonce.js";
import { isHoneypotTripped } from "../../common/security.js";

// leden-tokens worden met een AFWIJKEND geheim ondertekend, zodat ze NOOIT als admin-token werken
const MSECRET = (process.env.XPO_SECRET || "dev-secret-change-me") + ":member";
const b64 = (s: string) => Buffer.from(s).toString("base64url");
function signMember(p: { mid: number; email: string; tenant: string }): string {
  const payload = { ...p, kind: "member", exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14 };
  const body = b64(JSON.stringify(payload));
  return `${body}.${createHmac("sha256", MSECRET).update(body).digest("base64url")}`;
}
function verifyMember(token: string): { mid: number; email: string; tenant: string } | null {
  const [body, sig] = (token || "").split(".");
  if (!body || !sig) return null;
  if (createHmac("sha256", MSECRET).update(body).digest("base64url") !== sig) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); if (p.kind !== "member" || p.exp < Math.floor(Date.now() / 1000)) return null; return p; } catch { return null; }
}
function readCookie(req: FastifyRequest, name: string): string {
  const raw = req.headers.cookie || "";
  const m = raw.split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name);
  return m ? decodeURIComponent(m[1] || "") : "";
}
function currentMember(req: FastifyRequest) {
  const t = readCookie(req, "xpo_member");
  return t ? verifyMember(t) : null;
}
const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const setCookie = (reply: any, token: string) => reply.header("Set-Cookie", `xpo_member=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}`);

const MembersRepo = {
  byEmail(tenant: string, email: string) { return getDb().prepare("SELECT * FROM members WHERE tenant_id = ? AND email = ?").get(tenant, email.toLowerCase()) as any; },
  create(tenant: string, name: string, email: string, pw: string) {
    const info = getDb().prepare("INSERT INTO members (tenant_id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(tenant, name, email.toLowerCase(), hashPassword(pw), new Date().toISOString());
    return Number(info.lastInsertRowid);
  },
};

export async function membersRoutes(app: FastifyInstance) {
  // registreren (klantaccount, rol los van de admin)
  app.post("/api/public/register", async (req, reply) => {
    const tenant = tenantOf(req);
    const rl = rateLimit(`${req.ip}:register`, 10, 60 * 60 * 1000);
    if (!rl.ok) { reply.header("Retry-After", String(rl.retryAfter)); return reply.code(429).send({ error: "Te veel registraties. Probeer het later opnieuw." }); }
    const name = clip((req.body as any)?.name, 120);
    const email = clip((req.body as any)?.email, 160).toLowerCase();
    const pw = String((req.body as any)?.password || "");
    if (isHoneypotTripped(req.body)) return reply.code(400).send({ error: "Verzoek geweigerd" });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: "Ongeldig e-mailadres" });
    const pwIssue = passwordIssue(pw); if (pwIssue) return reply.code(400).send({ error: pwIssue });
    if (MembersRepo.byEmail(tenant, email)) return reply.code(409).send({ error: "Er bestaat al een account met dit e-mailadres" });
    const mid = MembersRepo.create(tenant, name || email, email, pw);
    setCookie(reply, signMember({ mid, email, tenant }));
    return reply.send({ ok: true, member: { email, name: name || email } });
  });

  // inloggen (klantaccount) → cookie
  app.post("/api/public/login", async (req, reply) => {
    const tenant = tenantOf(req);
    const rl = rateLimit(`${req.ip}:member-login`, 20, 10 * 60 * 1000);
    if (!rl.ok) { reply.header("Retry-After", String(rl.retryAfter)); return reply.code(429).send({ error: "Te veel pogingen. Probeer het later opnieuw." }); }
    const email = clip((req.body as any)?.email, 160).toLowerCase();
    const pw = String((req.body as any)?.password || "");
    const m = MembersRepo.byEmail(tenant, email);
    if (!m || !verifyPassword(pw, m.password_hash)) return reply.code(401).send({ error: "Onjuiste inloggegevens" });
    setCookie(reply, signMember({ mid: m.id, email, tenant }));
    return reply.send({ ok: true, member: { email: m.email, name: m.name } });
  });

  app.post("/api/public/logout", async (_req, reply) => { reply.header("Set-Cookie", "xpo_member=; Path=/; HttpOnly; Max-Age=0"); return reply.send({ ok: true }); });

  app.get("/api/public/me", async (req, reply) => {
    const cm = currentMember(req);
    if (!cm) return reply.code(401).send({ error: "Niet ingelogd" });
    const m = MembersRepo.byEmail(tenantOf(req), cm.email);
    if (!m) return reply.code(401).send({ error: "Niet ingelogd" });
    return reply.send({ email: m.email, name: m.name });
  });

  // accountpagina (server-gerenderd, leest de leden-cookie)
  app.get("/account", async (req, reply) => {
    const tenant = tenantOf(req); setNonce((req as any).cspNonce);
    const nav = NavRepo.get(tenant);
    const settings = SettingsRepo.get(tenant);
    const accent = settings.tokens.primary || settings.theme.accent || undefined;
    const cm = currentMember(req);
    reply.type("text/html");
    let children: Block[];
    if (!cm) {
      children = [
        { id: "ah", type: "xpo/heading", settings: { text: "Inloggen of registreren", level: "h2", _style: { pad: 24, maxw: 520 } }, children: [] },
        { id: "al", type: "xpo/text", settings: { body: "Log in op je account of maak een nieuw account aan.", _style: { maxw: 520, pad: 6 } }, children: [] },
      ];
      const root = themedAccount(tenant, children, accountForms());
      return reply.send(renderDocument("Account", root, tenant, nav, accent, { nonce: getNonce() }));
    }
    const m = MembersRepo.byEmail(tenant, cm.email);
    const orders = getDb().prepare("SELECT ref, amount, status, created_at FROM orders WHERE tenant_id = ? AND email = ? ORDER BY created_at DESC LIMIT 50").all(tenant, cm.email) as any[];
    const orderRows = orders.length
      ? orders.map((o) => `<tr><td>${esc(o.ref)}</td><td>${esc(o.amount)}</td><td>${esc(o.status)}</td><td>${esc(String(o.created_at).slice(0, 10))}</td></tr>`).join("")
      : `<tr><td colspan="4" style="opacity:.6">Nog geen bestellingen.</td></tr>`;
    const html = `<div class="xacc"><h2 class="xpo-h">Welkom, ${esc(m?.name || cm.email)}</h2><p style="opacity:.8">${esc(cm.email)}</p>`
      + `<h3 class="xpo-h" style="margin-top:24px">Bestellingen</h3><table class="xacc-t"><thead><tr><th>Order</th><th>Bedrag</th><th>Status</th><th>Datum</th></tr></thead><tbody>${orderRows}</tbody></table>`
      + `<button id="xacc-logout" class="pillbtn" style="margin-top:20px">Uitloggen</button></div>`
      + `<script${nonceAttr()}>document.getElementById("xacc-logout").addEventListener("click",function(){fetch("/api/public/logout",{method:"POST"}).then(function(){location.reload();});});</script>`;
    children = [{ id: "ac", type: "xpo/html", settings: { html }, children: [] }];
    const root = themedAccount(tenant, children);
    return reply.send(renderDocument("Mijn account", root, tenant, nav, accent, { nonce: getNonce() }));
  });
}

// kleine helpers die de account-UI in de site-chrome zetten
function themedAccount(tenant: string, children: Block[], extraHtml = ""): Block {
  const inner: Block[] = [...children];
  if (extraHtml) inner.push({ id: "axf", type: "xpo/html", settings: { html: extraHtml }, children: [] });
  return { id: "root", type: "core/root", settings: {}, children: inner };
}
function accountForms(): string {
  return `<div class="xacc-forms"><form class="xacc-login" style="max-width:340px"><h3 class="xpo-h">Inloggen</h3><input class="xfm-i" type="email" name="email" placeholder="E-mail" required/><input class="xfm-i" type="password" name="password" placeholder="Wachtwoord" required/><button class="pillbtn" type="submit">Inloggen</button><p class="xacc-msg" hidden></p></form>`
    + `<form class="xacc-reg" style="max-width:340px;margin-top:28px"><h3 class="xpo-h">Nieuw account</h3><input class="xfm-i" name="name" placeholder="Naam"/><input class="xfm-i" type="email" name="email" placeholder="E-mail" required/><input class="xfm-i" type="password" name="password" placeholder="Wachtwoord (min. 8 tekens)" required/><button class="pillbtn" type="submit">Account aanmaken</button><p class="xacc-msg" hidden></p></form></div>`
    + `<script${nonceAttr()}>(function(){function h(f,url){f&&f.addEventListener("submit",function(e){e.preventDefault();var d={};new FormData(f).forEach(function(v,k){d[k]=v;});fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(d)}).then(function(r){return r.json();}).then(function(res){var m=f.querySelector(".xacc-msg");if(res&&res.ok){location.reload();}else if(m){m.hidden=false;m.textContent=(res&&res.error)||"Mislukt.";}});});}h(document.querySelector(".xacc-login"),"/api/public/login");h(document.querySelector(".xacc-reg"),"/api/public/register");})();</script>`;
}
