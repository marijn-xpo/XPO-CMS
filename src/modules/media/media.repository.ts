import { getDb } from "../../db/database.js";

export type MediaDTO = { id: string; name: string; mime: string; size: number; src: string; added: number };
type Row = { id: number; name: string; mime: string; size: number; url: string; created_at: string };

const toDto = (r: Row): MediaDTO => ({
  id: String(r.id), name: r.name, mime: r.mime, size: r.size, src: r.url, added: Date.parse(r.created_at) || Date.now(),
});

export const MediaRepo = {
  list(tenant: string): MediaDTO[] {
    const rows = getDb().prepare(
      "SELECT * FROM media WHERE tenant_id = ? ORDER BY created_at DESC"
    ).all(tenant) as unknown as Row[];
    return rows.map(toDto);
  },
  get(tenant: string, id: number): (MediaDTO & { url: string }) | null {
    const r = getDb().prepare("SELECT * FROM media WHERE tenant_id = ? AND id = ?").get(tenant, id) as unknown as Row | undefined;
    return r ? { ...toDto(r), url: r.url } : null;
  },
  create(tenant: string, m: { name: string; mime: string; size: number; url: string }): MediaDTO {
    const now = new Date().toISOString();
    const info = getDb().prepare(
      "INSERT INTO media (tenant_id, name, mime, size, url, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(tenant, m.name, m.mime, m.size, m.url, now);
    return this.get(tenant, Number(info.lastInsertRowid))!;
  },
  remove(tenant: string, id: number): boolean {
    return getDb().prepare("DELETE FROM media WHERE tenant_id = ? AND id = ?").run(tenant, id).changes > 0;
  },
};
