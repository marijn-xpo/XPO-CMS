import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";

export type Language = { code: string; label: string; flag: string; path: string; default: boolean; enabled: boolean };

function clip(s: unknown, n: number): string {
  return String(s ?? "").trim().slice(0, n);
}
function toDto(r: any): Language {
  return { code: r.code, label: r.label, flag: r.flag, path: r.path, default: !!r.is_default, enabled: !!r.enabled };
}

const LanguagesRepo = {
  list(tenant: string): Language[] {
    return (getDb()
      .prepare("SELECT code, label, flag, path, is_default, enabled FROM languages WHERE tenant_id = ? ORDER BY position ASC, code ASC")
      .all(tenant) as any[]).map(toDto);
  },
  get(tenant: string, code: string): Language | null {
    const r = getDb().prepare("SELECT code, label, flag, path, is_default, enabled FROM languages WHERE tenant_id = ? AND code = ?").get(tenant, code);
    return r ? toDto(r) : null;
  },
  count(tenant: string): number {
    return (getDb().prepare("SELECT COUNT(*) AS c FROM languages WHERE tenant_id = ?").get(tenant) as { c: number }).c;
  },
  create(tenant: string, l: { code: string; label: string; flag: string; path: string }): Language {
    const db = getDb();
    const first = this.count(tenant) === 0;
    const pos = (db.prepare("SELECT MAX(position) AS m FROM languages WHERE tenant_id = ?").get(tenant) as { m: number | null }).m;
    db.prepare("INSERT INTO languages (tenant_id, code, label, flag, path, is_default, enabled, position) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
      .run(tenant, l.code, l.label, l.flag, l.path, first ? 1 : 0, (pos || 0) + 1);
    return this.get(tenant, l.code)!;
  },
  setDefault(tenant: string, code: string): Language | null {
    const db = getDb();
    if (!this.get(tenant, code)) return null;
    db.prepare("UPDATE languages SET is_default = 0 WHERE tenant_id = ?").run(tenant);
    db.prepare("UPDATE languages SET is_default = 1, enabled = 1 WHERE tenant_id = ? AND code = ?").run(tenant, code);
    return this.get(tenant, code);
  },
  setEnabled(tenant: string, code: string, enabled: boolean): Language | null {
    getDb().prepare("UPDATE languages SET enabled = ? WHERE tenant_id = ? AND code = ?").run(enabled ? 1 : 0, tenant, code);
    return this.get(tenant, code);
  },
  remove(tenant: string, code: string): boolean {
    return getDb().prepare("DELETE FROM languages WHERE tenant_id = ? AND code = ?").run(tenant, code).changes > 0;
  },
};

export async function languagesRoutes(app: FastifyInstance) {
  app.get("/api/languages", { preHandler: authGuard }, async (req, reply) => reply.send(LanguagesRepo.list(tenantOf(req))));

  app.post("/api/languages", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const code = clip(b.code, 10).toLowerCase();
    const label = clip(b.label, 60);
    if (!code || !label) return reply.code(400).send({ error: "Code en naam zijn verplicht", issues: [{ path: code ? "label" : "code", message: "Code en naam zijn verplicht" }] });
    const tenant = tenantOf(req);
    if (LanguagesRepo.get(tenant, code)) return reply.code(409).send({ error: "Taalcode bestaat al" });
    let path = clip(b.path, 40) || "/" + code + "/";
    if (path[0] !== "/") path = "/" + path;
    return reply.code(201).send(LanguagesRepo.create(tenant, { code, label, flag: clip(b.flag, 8), path }));
  });

  app.post("/api/languages/:code/default", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const l = LanguagesRepo.setDefault(tenantOf(req), clip((req.params as any).code, 10).toLowerCase());
    if (!l) return reply.code(404).send({ error: "Taal niet gevonden" });
    return reply.send(l);
  });

  app.patch("/api/languages/:code", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const tenant = tenantOf(req);
    const code = clip((req.params as any).code, 10).toLowerCase();
    const cur = LanguagesRepo.get(tenant, code);
    if (!cur) return reply.code(404).send({ error: "Taal niet gevonden" });
    const enabled = !!(req.body as any)?.enabled;
    if (!enabled && cur.default) return reply.code(400).send({ error: "De standaardtaal kan niet worden uitgeschakeld" });
    return reply.send(LanguagesRepo.setEnabled(tenant, code, enabled));
  });

  app.delete("/api/languages/:code", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const tenant = tenantOf(req);
    const code = clip((req.params as any).code, 10).toLowerCase();
    const cur = LanguagesRepo.get(tenant, code);
    if (!cur) return reply.code(404).send({ error: "Taal niet gevonden" });
    if (cur.default) return reply.code(400).send({ error: "De standaardtaal kan niet worden verwijderd" });
    if (LanguagesRepo.count(tenant) <= 1) return reply.code(400).send({ error: "Er moet minstens één taal blijven" });
    LanguagesRepo.remove(tenant, code);
    return reply.send({ ok: true });
  });
}
