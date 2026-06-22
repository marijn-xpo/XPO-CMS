import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { MediaRepo, type MediaDTO } from "./media.repository.js";
import { ServiceError } from "../pages/pages.service.js";
import { putObject, UPLOAD_DIR, ensureUploadDir } from "./media.storage.js";

export { UPLOAD_DIR, ensureUploadDir };

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
  "image/gif": "gif", "image/webp": "webp",
  "video/mp4": "mp4", "video/webm": "webm",
};
const MAX_IMAGE = 8 * 1024 * 1024;   // 8 MB
const MAX_VIDEO = 20 * 1024 * 1024;  // 20 MB (korte clips; grote video's beter via URL/CDN)

export const MediaService = {
  list(tenant: string): MediaDTO[] {
    return MediaRepo.list(tenant);
  },

  async createFromDataUrl(tenant: string, name: string, dataUrl: string): Promise<MediaDTO> {
    const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(dataUrl || ""));
    if (!m) throw new ServiceError(400, "Ongeldige upload (verwacht een base64 data-URL)");
    const mime = m[1].toLowerCase();
    const ext = EXT[mime];
    if (!ext) throw new ServiceError(400, `Bestandstype niet toegestaan: ${mime} (alleen PNG, JPEG, GIF, WebP, MP4, WebM)`);
    const buf = Buffer.from(m[2], "base64");
    if (buf.length === 0) throw new ServiceError(400, "Leeg bestand");
    const isVideo = ext === "mp4" || ext === "webm";
    const max = isVideo ? MAX_VIDEO : MAX_IMAGE;
    if (buf.length > max) throw new ServiceError(400, `Bestand te groot (max. ${isVideo ? "20" : "8"} MB)`);
    // magic-bytes: de echte inhoud moet kloppen met het opgegeven type (geen vermomde bestanden).
    const sigOk = (
      (ext === "png" && buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ||
      (ext === "jpg" && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
      (ext === "gif" && buf.length >= 3 && buf.toString("ascii", 0, 3) === "GIF") ||
      (ext === "webp" && buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") ||
      (ext === "mp4" && buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") ||
      (ext === "webm" && buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3)
    );
    if (!sigOk) throw new ServiceError(400, "Bestandsinhoud komt niet overeen met het type");

    const fname = `${randomBytes(8).toString("hex")}.${ext}`;
    const url = await putObject(tenant, fname, buf, mime, (msg) => console.warn("[media]", msg));

    const clean = String(name || "bestand").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "bestand";
    return MediaRepo.create(tenant, { name: clean, mime, size: buf.length, url });
  },

  async remove(tenant: string, id: number): Promise<void> {
    const item = MediaRepo.get(tenant, id);
    if (!item) throw new ServiceError(404, "Mediabestand niet gevonden");
    MediaRepo.remove(tenant, id);
    // alleen lokale bestanden opruimen; blob-URL's worden overgeslagen
    const fname = item.url.replace(/^\/uploads\//, "");
    if (item.url.startsWith("/uploads/") && fname && !fname.includes("/") && !fname.includes("..")) {
      await unlink(join(UPLOAD_DIR, fname)).catch(() => {});
    }
  },
};
