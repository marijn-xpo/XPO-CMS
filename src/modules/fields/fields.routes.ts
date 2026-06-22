import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";

export type CustomField = { id: string; label: string; type: string; options?: string[] };
export type FieldGroup = { id: string; name: string; location: string; fields: CustomField[] };

const TYPES = ["text", "textarea", "number", "toggle", "image", "select", "date", "url", "repeater", "email", "color"];
const DEFAULT_LOCATION = "Alle pagina's";

function clip(s: unknown, n: number): string {
  return String(s ?? "").trim().slice(0, n);
}
function fid(p: string): string {
  return p + "_" + Math.random().toString(36).slice(2, 9);
}
function sanitizeFields(input: unknown): CustomField[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 60).map((f: any) => ({
    id: clip(f?.id, 40) || fid("cf"),
    label: clip(f?.label, 120) || "Veld",
    type: TYPES.includes(f?.type) ? f.type : "text",
    options: Array.isArray(f?.options) ? f.options.slice(0, 40).map((o: any) => clip(o, 80)).filter(Boolean) : undefined,
  }));
}
function toDto(r: any): FieldGroup {
  return { id: r.id, name: r.name, location: r.location, fields: JSON.parse(r.fields) };
}

export const FieldGroupsRepo = {
  list(tenant: string): FieldGroup[] {
    return (getDb()
      .prepare("SELECT id, name, location, fields FROM field_groups WHERE tenant_id = ? ORDER BY created_at DESC")
      .all(tenant) as any[]).map(toDto);
  },
  create(tenant: string, name: string, location: string): FieldGroup {
    const id = fid("fg");
    const fields: CustomField[] = [{ id: fid("cf"), label: "Tekstveld", type: "text" }];
    getDb()
      .prepare("INSERT INTO field_groups (id, tenant_id, name, location, fields, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, tenant, name, location || DEFAULT_LOCATION, JSON.stringify(fields), Date.now());
    return { id, name, location: location || DEFAULT_LOCATION, fields };
  },
  update(tenant: string, id: string, g: { name: string; location: string; fields: CustomField[] }): FieldGroup | null {
    const r = getDb()
      .prepare("UPDATE field_groups SET name = ?, location = ?, fields = ? WHERE tenant_id = ? AND id = ?")
      .run(g.name, g.location, JSON.stringify(g.fields), tenant, id);
    if (r.changes === 0) return null;
    return { id, name: g.name, location: g.location, fields: g.fields };
  },
  remove(tenant: string, id: string): boolean {
    return getDb().prepare("DELETE FROM field_groups WHERE tenant_id = ? AND id = ?").run(tenant, id).changes > 0;
  },
};

export async function fieldsRoutes(app: FastifyInstance) {
  app.get("/api/field-groups", { preHandler: authGuard }, async (req, reply) => reply.send(FieldGroupsRepo.list(tenantOf(req))));

  app.post("/api/field-groups", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const name = clip(b.name, 120);
    if (!name) return reply.code(400).send({ error: "Naam is verplicht", issues: [{ path: "name", message: "Naam is verplicht" }] });
    return reply.code(201).send(FieldGroupsRepo.create(tenantOf(req), name, clip(b.location, 120)));
  });

  app.put("/api/field-groups/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const name = clip(b.name, 120);
    if (!name) return reply.code(400).send({ error: "Naam is verplicht", issues: [{ path: "name", message: "Naam is verplicht" }] });
    const g = FieldGroupsRepo.update(tenantOf(req), String((req.params as any).id), {
      name,
      location: clip(b.location, 120) || DEFAULT_LOCATION,
      fields: sanitizeFields(b.fields),
    });
    if (!g) return reply.code(404).send({ error: "Veldgroep niet gevonden" });
    return reply.send(g);
  });

  app.delete("/api/field-groups/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    if (!FieldGroupsRepo.remove(tenantOf(req), String((req.params as any).id))) return reply.code(404).send({ error: "Veldgroep niet gevonden" });
    return reply.send({ ok: true });
  });
}
