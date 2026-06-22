import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { UPLOAD_DIR } from "./media.storage.js";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, "../../../public");
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" };
const WIDTHS = [400, 800, 1200, 1600];

// Lost een veilige lokale bron op (alleen /uploads of /assets, geen path-traversal -> geen SSRF/LFI).
function resolveLocal(src: string): { file: string; ext: string } | null {
  if (!src || src.includes("..")) return null;
  let file = "";
  if (src.startsWith("/uploads/")) file = join(UPLOAD_DIR, src.slice("/uploads/".length));
  else if (src.startsWith("/assets/")) file = join(PUBLIC_DIR, src.slice("/assets/".length));
  else return null;
  file = normalize(file);
  if (!file.startsWith(normalize(UPLOAD_DIR)) && !file.startsWith(normalize(PUBLIC_DIR))) return null;
  if (!existsSync(file)) return null;
  const ext = (file.split(".").pop() || "").toLowerCase();
  return { file, ext };
}

export async function imgRoutes(app: FastifyInstance) {
  // On-the-fly resize + WebP/AVIF. Met 'sharp' (npm i sharp) wordt echt getranscodeerd;
  // zonder sharp wordt het origineel netjes geserveerd (zelfde URL's, transcoder is drop-in).
  app.get("/img", async (req, reply) => {
    const q = req.query as any;
    const loc = resolveLocal(String(q.src || ""));
    if (!loc) return reply.code(400).send({ error: "Ongeldige of niet-toegestane bron" });
    const w = Math.min(4000, Math.max(0, Number(q.w) || 0));
    const fmt = ["webp", "avif", "jpeg", "png"].includes(String(q.f)) ? String(q.f) : "";
    const buf = await readFile(loc.file);
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    if (loc.ext === "svg" || (!w && !fmt)) { reply.type(MIME[loc.ext] || "application/octet-stream"); return reply.send(buf); }
    try {
      const mod = "sharp";
      const sharp = (await import(mod)).default;
      let s = sharp(buf);
      if (w) s = s.resize({ width: w, withoutEnlargement: true });
      const outFmt = fmt || (loc.ext === "png" ? "png" : "jpeg");
      const out = await s.toFormat(outFmt as any, { quality: 78 }).toBuffer();
      reply.type(MIME[outFmt] || "application/octet-stream");
      return reply.send(out);
    } catch {
      // sharp niet beschikbaar -> origineel (fallback)
      reply.header("X-Img", "passthrough");
      reply.type(MIME[loc.ext] || "application/octet-stream");
      return reply.send(buf);
    }
  });
}

// Bouwt responsive <picture>-markup (AVIF/WebP + fallback) voor lokale uploads/assets.
export function responsiveImg(src: string, alt: string, cls = "", extraAttr = ""): string {
  const esc = (x: string) => String(x).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const isLocal = /^\/(uploads|assets)\//.test(src) && !/\.svg$/i.test(src);
  if (!isLocal) return `<img class="${esc(cls)}" src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async"${extraAttr}/>`;
  const set = (f: string) => WIDTHS.map((w) => `/img?src=${encodeURIComponent(src)}&w=${w}${f ? "&f=" + f : ""} ${w}w`).join(", ");
  const sizes = "(max-width: 768px) 100vw, 1200px";
  return `<picture>`
    + `<source type="image/avif" srcset="${esc(set("avif"))}" sizes="${sizes}"/>`
    + `<source type="image/webp" srcset="${esc(set("webp"))}" sizes="${sizes}"/>`
    + `<img class="${esc(cls)}" src="/img?src=${encodeURIComponent(src)}&w=1200" srcset="${esc(set(""))}" sizes="${sizes}" alt="${esc(alt)}" loading="lazy" decoding="async"${extraAttr}/>`
    + `</picture>`;
}
