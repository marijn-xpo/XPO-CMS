import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";
import { validateTree, type Block } from "../../engine/engine.js";

export type Snippet = { id: string; name: string; block: Block; updatedAt: number };

function clip(s: unknown, n: number): string { return String(s ?? "").trim().slice(0, n); }

// een snippet is een widget-subtree (geen hele pagina). Valideer door 'm in een root te wikkelen.
function validateSnippet(block: any): { ok: boolean; issues?: any[] } {
  if (!block || typeof block !== "object" || !block.type) return { ok: false, issues: [{ path: "block", message: "Ongeldig blok" }] };
  if (block.type === "core/root") return { ok: false, issues: [{ path: "block", message: "Een snippet is een sectie/widget, geen hele pagina" }] };
  const wrapped: Block = { id: "root", type: "core/root", settings: {}, children: [block] };
  const res = validateTree(wrapped);
  return { ok: res.ok, issues: res.issues };
}

function toDto(r: any): Snippet {
  return { id: r.id, name: r.name, block: JSON.parse(r.block), updatedAt: r.updated_at };
}

export const SnippetsRepo = {
  list(tenant: string): Snippet[] {
    return (getDb().prepare("SELECT id, name, block, updated_at FROM snippets WHERE tenant_id = ? ORDER BY updated_at DESC").all(tenant) as any[]).map(toDto);
  },
  get(tenant: string, id: string): Snippet | null {
    const r = getDb().prepare("SELECT id, name, block, updated_at FROM snippets WHERE tenant_id = ? AND id = ?").get(tenant, id) as any;
    return r ? toDto(r) : null;
  },
  create(tenant: string, name: string, block: Block): Snippet {
    const id = "sn_" + Math.random().toString(36).slice(2, 9);
    const now = Date.now();
    getDb().prepare("INSERT INTO snippets (id, tenant_id, name, block, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, tenant, name, JSON.stringify(block), now, now);
    return { id, name, block, updatedAt: now };
  },
  update(tenant: string, id: string, name: string, block: Block): Snippet | null {
    const r = getDb().prepare("UPDATE snippets SET name = ?, block = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").run(name, JSON.stringify(block), Date.now(), tenant, id);
    if (r.changes === 0) return null;
    return { id, name, block, updatedAt: Date.now() };
  },
  remove(tenant: string, id: string): boolean {
    return getDb().prepare("DELETE FROM snippets WHERE tenant_id = ? AND id = ?").run(tenant, id).changes > 0;
  },
};

export async function snippetsRoutes(app: FastifyInstance) {
  app.get("/api/snippets", { preHandler: authGuard }, async (req, reply) => reply.send(SnippetsRepo.list(tenantOf(req))));

  app.post("/api/snippets", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const name = clip(b.name, 120);
    if (!name) return reply.code(400).send({ error: "Naam is verplicht", issues: [{ path: "name", message: "Naam is verplicht" }] });
    const v = validateSnippet(b.block);
    if (!v.ok) return reply.code(400).send({ error: "Ongeldige sectie", issues: v.issues });
    return reply.code(201).send(SnippetsRepo.create(tenantOf(req), name, b.block));
  });

  app.put("/api/snippets/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const name = clip(b.name, 120);
    if (!name) return reply.code(400).send({ error: "Naam is verplicht", issues: [{ path: "name", message: "Naam is verplicht" }] });
    const v = validateSnippet(b.block);
    if (!v.ok) return reply.code(400).send({ error: "Ongeldige sectie", issues: v.issues });
    const snip = SnippetsRepo.update(tenantOf(req), String((req.params as any).id), name, b.block);
    if (!snip) return reply.code(404).send({ error: "Snippet niet gevonden" });
    return reply.send(snip);
  });

  app.delete("/api/snippets/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    if (!SnippetsRepo.remove(tenantOf(req), String((req.params as any).id))) return reply.code(404).send({ error: "Snippet niet gevonden" });
    return reply.send({ ok: true });
  });
}
