import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SettingsRepo } from "../settings/settings.routes.js";

const here = dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = process.env.XPO_UPLOADS || join(here, "../../../data/uploads");

export async function ensureUploadDir() {
  await mkdir(UPLOAD_DIR, { recursive: true });
}

// schrijf naar de lokale schijf en geef een /uploads/-URL terug
async function putLocal(fname: string, buf: Buffer): Promise<string> {
  await ensureUploadDir();
  await writeFile(join(UPLOAD_DIR, fname), buf);
  return `/uploads/${fname}`;
}

// upload naar Azure Blob (vereist @azure/storage-blob + netwerk); valt terug op lokaal
async function putBlob(fname: string, buf: Buffer, mime: string, cfg: { accountUrl: string; container: string; sasToken: string }, log?: (m: string) => void): Promise<string> {
  try {
    const spec = "@azure/storage-blob";
    const az: any = await import(spec).catch(() => null);
    if (!az || !cfg.accountUrl) { log?.("Azure Blob niet beschikbaar — terugval naar lokale opslag"); return putLocal(fname, buf); }
    const base = cfg.accountUrl.replace(/\/+$/, "");
    const svc = new az.BlobServiceClient(cfg.sasToken ? `${base}?${cfg.sasToken.replace(/^\?/, "")}` : base);
    const container = svc.getContainerClient(cfg.container || "media");
    const block = container.getBlockBlobClient(fname);
    await block.uploadData(buf, { blobHTTPHeaders: { blobContentType: mime } });
    return block.url;
  } catch (e: any) {
    log?.("Azure Blob-upload mislukt — terugval naar lokale opslag: " + String(e?.message || e).slice(0, 120));
    return putLocal(fname, buf);
  }
}

// kies de opslagdriver op basis van de instellingen
export async function putObject(tenant: string, fname: string, buf: Buffer, mime: string, log?: (m: string) => void): Promise<string> {
  const media = SettingsRepo.get(tenant).media;
  if (media.driver === "blob") return putBlob(fname, buf, mime, media, log);
  return putLocal(fname, buf);
}
