import { validateTree, sanitizeUserTree, type Block } from "../../engine/engine.js";
import { PagesRepo, type PageDTO, type PageInput } from "./pages.repository.js";

export class ServiceError extends Error {
  status: number;
  issues?: { path: string; message: string }[];
  constructor(status: number, message: string, issues?: { path: string; message: string }[]) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

function slugify(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function assertValidBlocks(blocks: Block) {
  if (!blocks || blocks.type !== "core/root") throw new ServiceError(400, "Ongeldige paginastructuur");
  const res = validateTree(blocks);
  if (!res.ok) throw new ServiceError(400, "Validatie mislukt", res.issues);
}

export const PagesService = {
  list(tenant: string, opts: { trashed?: boolean } = {}): PageDTO[] {
    return PagesRepo.list(tenant, opts);
  },
  get(tenant: string, id: number): PageDTO {
    const p = PagesRepo.get(tenant, id);
    if (!p) throw new ServiceError(404, "Pagina niet gevonden");
    return p;
  },
  create(tenant: string, data: PageInput): PageDTO {
    const slug = slugify(data.slug || data.title) || "pagina";
    if (PagesRepo.slugExists(tenant, slug)) throw new ServiceError(409, `Slug '${slug}' bestaat al`);
    assertValidBlocks(data.blocks);
    return PagesRepo.create(tenant, { ...data, slug, blocks: sanitizeUserTree(data.blocks) });
  },
  update(tenant: string, id: number, data: PageInput): PageDTO {
    const existing = PagesRepo.get(tenant, id);
    if (!existing) throw new ServiceError(404, "Pagina niet gevonden");
    const slug = slugify(data.slug || existing.slug) || existing.slug;
    if (PagesRepo.slugExists(tenant, slug, id)) throw new ServiceError(409, `Slug '${slug}' bestaat al`);
    assertValidBlocks(data.blocks);
    return PagesRepo.update(tenant, id, { ...data, slug, blocks: sanitizeUserTree(data.blocks) })!;
  },
  publish(tenant: string, id: number): PageDTO {
    const existing = PagesRepo.get(tenant, id);
    if (!existing) throw new ServiceError(404, "Pagina niet gevonden");
    assertValidBlocks(existing.blocks);
    return PagesRepo.publish(tenant, id)!;
  },
  schedule(tenant: string, id: number, at: number): PageDTO {
    if (!existsOr404(tenant, id)) {}
    if (!Number.isFinite(at) || at <= Date.now()) throw new ServiceError(400, "Kies een tijdstip in de toekomst", [{ path: "at", message: "Tijdstip moet in de toekomst liggen" }]);
    const p = PagesRepo.schedule(tenant, id, at);
    if (!p) throw new ServiceError(404, "Pagina niet gevonden");
    return p;
  },
  trash(tenant: string, id: number): void {
    if (!PagesRepo.setTrashed(tenant, id, true)) throw new ServiceError(404, "Pagina niet gevonden");
  },
  restore(tenant: string, id: number): PageDTO {
    if (!PagesRepo.setTrashed(tenant, id, false)) throw new ServiceError(404, "Pagina niet gevonden");
    return PagesRepo.get(tenant, id)!;
  },
  purge(tenant: string, id: number): void {
    if (!PagesRepo.purge(tenant, id)) throw new ServiceError(404, "Niet in prullenbak");
  },
  translate(tenant: string, id: number, locale: string): PageDTO {
    if (!/^[a-z]{2}$/.test(locale)) throw new ServiceError(400, "Ongeldige taalcode");
    const p = PagesRepo.createTranslation(tenant, id, locale);
    if (!p) throw new ServiceError(404, "Pagina niet gevonden");
    return p;
  },
  versions(tenant: string, id: number) {
    if (!PagesRepo.get(tenant, id)) throw new ServiceError(404, "Pagina niet gevonden");
    return PagesRepo.versions(tenant, id);
  },
  restoreVersion(tenant: string, id: number, versionId: number): PageDTO {
    const p = PagesRepo.restoreVersion(tenant, id, versionId);
    if (!p) throw new ServiceError(404, "Versie niet gevonden");
    return p;
  },
  remove(tenant: string, id: number): void {
    if (!PagesRepo.remove(tenant, id)) throw new ServiceError(404, "Pagina niet gevonden");
  },
};

function existsOr404(tenant: string, id: number): boolean {
  if (!PagesRepo.get(tenant, id)) throw new ServiceError(404, "Pagina niet gevonden");
  return true;
}
