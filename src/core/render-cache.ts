import { createHash } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { getStore } from "./cache-store.js";

const TTL_MS = Number(process.env.XPO_RENDER_TTL || 60 * 1000);
const MAXAGE = Number(process.env.XPO_PAGE_MAXAGE || 0);
const SMAXAGE = Number(process.env.XPO_PAGE_SMAXAGE || 60);

type Entry = { html: string; nonce: string; etag: string };
const keyOf = (tenant: string, path: string) => "rc:" + tenant + "|" + path;
const etagOf = (html: string) => '"' + createHash("sha1").update(html).digest("hex").slice(0, 16) + '"';

export async function invalidateTenant(tenant: string) {
  const store = await getStore();
  await store.delPrefix("rc:" + tenant + "|");
}
export async function cacheStats() { return { driver: (await getStore()).kind }; }

// Levert een publieke pagina met cache + ETag/304 + Cache-Control. De CSP-nonce wordt meegecachet
// en bij een hit hergebruikt, zodat de nonce in de HTML matcht met de CSP-header.
export async function sendCached(req: FastifyRequest, reply: FastifyReply, tenant: string, path: string, produce: () => string): Promise<FastifyReply> {
  const cc = `public, max-age=${MAXAGE}, s-maxage=${SMAXAGE}, must-revalidate`;
  const store = await getStore();
  const raw = await store.get(keyOf(tenant, path));
  if (raw) {
    const hit = JSON.parse(raw) as Entry;
    (req as any).cspNonce = hit.nonce;
    reply.header("X-Cache", "HIT");
    reply.header("Cache-Control", cc);
    reply.header("ETag", hit.etag);
    if (String(req.headers["if-none-match"] || "") === hit.etag) return reply.code(304).send();
    reply.type("text/html");
    return reply.send(hit.html);
  }
  const html = produce();
  const entry: Entry = { html, nonce: (req as any).cspNonce || "", etag: etagOf(html) };
  await store.set(keyOf(tenant, path), JSON.stringify(entry), TTL_MS);
  reply.header("X-Cache", "MISS");
  reply.header("Cache-Control", cc);
  reply.header("ETag", entry.etag);
  if (String(req.headers["if-none-match"] || "") === entry.etag) return reply.code(304).send();
  reply.type("text/html");
  return reply.send(html);
}
