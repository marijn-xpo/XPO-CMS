import type { FastifyRequest, FastifyReply } from "fastify";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
function allowedOrigins(): string[] {
  return (process.env.XPO_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// CSRF-bescherming: bij muterende requests met een Origin/Referer moet die same-origin of toegestaan zijn.
// Requests zonder Origin (server-to-server, native apps, tests) worden doorgelaten.
export function originGuard(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  if (!MUTATING.has(req.method)) return done();
  const origin = (req.headers["origin"] as string) || "";
  const referer = (req.headers["referer"] as string) || "";
  const src = origin || referer;
  if (!src) return done();
  const host = String(req.headers["host"] || "").toLowerCase();
  let srcHost = "";
  try { srcHost = new URL(src).host.toLowerCase(); } catch { /* */ }
  if (srcHost === host) return done();
  if (allowedOrigins().some((o) => { try { return new URL(o).host.toLowerCase() === srcHost; } catch { return false; } })) return done();
  reply.code(403).send({ error: "Cross-origin verzoek geweigerd (CSRF)" });
}

// Honeypot tegen botspam op publieke formulieren: een verborgen veld dat mensen leeg laten.
export function isHoneypotTripped(body: any): boolean {
  return !!(body && typeof body === "object" && String(body._hp || "").trim().length > 0);
}
