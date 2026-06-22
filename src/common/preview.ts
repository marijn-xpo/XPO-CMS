import { createHmac, timingSafeEqual } from "node:crypto";
import { getSecret } from "./secrets.js";

const SECRET = getSecret("XPO_SECRET", "dev-secret-change-me") + ":preview";
const TTL_MS = Number(process.env.XPO_PREVIEW_TTL || 3600) * 1000; // 1 uur
const hmac = (s: string) => createHmac("sha256", SECRET).update(s).digest("base64url");

export function signPreview(type: "page" | "post", id: number, tenant: string): string {
  const body = `${type}:${id}:${tenant}:${Date.now() + TTL_MS}`;
  return Buffer.from(body).toString("base64url") + "." + hmac(body);
}
export function verifyPreview(token: string): { type: string; id: number; tenant: string } | null {
  const [b, sig] = String(token || "").split(".");
  if (!b || !sig) return null;
  const body = Buffer.from(b, "base64url").toString();
  const exp = hmac(body);
  const a = Buffer.from(sig), e = Buffer.from(exp);
  if (a.length !== e.length || !timingSafeEqual(a, e)) return null;
  const [type, id, tenant, expMs] = body.split(":");
  if (Number(expMs) < Date.now()) return null;
  return { type, id: Number(id), tenant };
}
