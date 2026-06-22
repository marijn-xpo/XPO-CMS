import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";
import { validateTree, type Block } from "../../engine/engine.js";

export type Condition = { type: "all" | "post-type" | "page" | "post"; value?: string };
export type Template = { id: string; name: string; kind: string; conditions: Condition[]; blocks: Block; status: string };

const KINDS = ["header", "footer", "single", "section"];
const STATUSES = ["draft", "live"];
function clip(s: unknown, n: number): string { return String(s ?? "").trim().slice(0, n); }
function normKind(v: unknown): string { const k = String(v ?? "").toLowerCase(); return KINDS.includes(k) ? k : "section"; }
function emptyRoot(): Block { return { id: "root", type: "core/root", settings: {}, children: [] }; }

function sanitizeConditions(input: unknown): Condition[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 20).map((c: any) => {
    const type = ["all", "post-type", "page", "post"].includes(c?.type) ? c.type : "all";
    return type === "all" ? { type } : { type, value: clip(c?.value, 200) };
  });
}

export const TemplatesRepo = {
  toDto(r: any): Template {
    return { id: r.id, name: r.name, kind: normKind(r.type), conditions: r.conditions ? JSON.parse(r.conditions) : [], blocks: r.blocks ? JSON.parse(r.blocks) : emptyRoot(), status: r.status };
  },
  list(tenant: string): Template[] {
    return (getDb().prepare("SELECT * FROM templates WHERE tenant_id = ? ORDER BY created_at ASC").all(tenant) as any[]).map((r) => this.toDto(r));
  },
  get(tenant: string, id: string): Template | null {
    const r = getDb().prepare("SELECT * FROM templates WHERE tenant_id = ? AND id = ?").get(tenant, id) as any;
    return r ? this.toDto(r) : null;
  },
  create(tenant: string, t: { name: string; kind: string; conditions?: Condition[] }): Template {
    const id = "tpl_" + Math.random().toString(36).slice(2, 9);
    const kind = normKind(t.kind);
    const conds = t.conditions && t.conditions.length ? sanitizeConditions(t.conditions) : [{ type: "all" } as Condition];
    getDb().prepare("INSERT INTO templates (id, tenant_id, name, type, condition, blocks, conditions, status, created_at) VALUES (?, ?, ?, ?, '', ?, ?, 'draft', ?)")
      .run(id, tenant, t.name, kind, JSON.stringify(emptyRoot()), JSON.stringify(conds), Date.now());
    return this.get(tenant, id)!;
  },
  setMeta(tenant: string, id: string, b: { name?: string; kind?: string; conditions?: unknown }): Template | null {
    const cur = this.get(tenant, id); if (!cur) return null;
    const name = clip(b.name ?? cur.name, 120) || cur.name;
    const kind = b.kind !== undefined ? normKind(b.kind) : cur.kind;
    const conds = b.conditions !== undefined ? sanitizeConditions(b.conditions) : cur.conditions;
    getDb().prepare("UPDATE templates SET name = ?, type = ?, conditions = ? WHERE tenant_id = ? AND id = ?").run(name, kind, JSON.stringify(conds), tenant, id);
    return this.get(tenant, id);
  },
  saveBlocks(tenant: string, id: string, blocks: Block): Template | null {
    if (!this.get(tenant, id)) return null;
    getDb().prepare("UPDATE templates SET blocks = ? WHERE tenant_id = ? AND id = ?").run(JSON.stringify(blocks), tenant, id);
    return this.get(tenant, id);
  },
  setStatus(tenant: string, id: string, status: string): Template | null {
    if (getDb().prepare("UPDATE templates SET status = ? WHERE tenant_id = ? AND id = ?").run(status, tenant, id).changes === 0) return null;
    return this.get(tenant, id);
  },
  remove(tenant: string, id: string): boolean {
    return getDb().prepare("DELETE FROM templates WHERE tenant_id = ? AND id = ?").run(tenant, id).changes > 0;
  },
  resolveActive(tenant: string, kind: string, ctx: { kind: "page" | "post"; slug: string }): Template | null {
    const matches = (c: Condition): boolean => {
      if (c.type === "all") return true;
      if (c.type === "post-type") return c.value === ctx.kind || (c.value === "pages" && ctx.kind === "page") || (c.value === "posts" && ctx.kind === "post");
      if (c.type === "page") return ctx.kind === "page" && c.value === ctx.slug;
      if (c.type === "post") return ctx.kind === "post" && c.value === ctx.slug;
      return false;
    };
    const live = this.list(tenant).filter((t) => t.kind === kind && t.status === "live" && t.conditions.some(matches));
    if (!live.length) return null;
    const specific = live.find((t) => t.conditions.some((c) => c.type === "page" || c.type === "post"));
    return specific || live[0];
  },
};

export async function templatesRoutes(app: FastifyInstance) {
  app.get("/api/templates", { preHandler: authGuard }, async (req, reply) => reply.send(TemplatesRepo.list(tenantOf(req))));
  app.get("/api/templates/:id", { preHandler: authGuard }, async (req, reply) => {
    const t = TemplatesRepo.get(tenantOf(req), String((req.params as any).id));
    if (!t) return reply.code(404).send({ error: "Template niet gevonden" });
    return reply.send(t);
  });

  app.post("/api/templates", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const name = clip(b.name, 120);
    if (!name) return reply.code(400).send({ error: "Naam is verplicht", issues: [{ path: "name", message: "Naam is verplicht" }] });
    return reply.code(201).send(TemplatesRepo.create(tenantOf(req), { name, kind: b.kind ?? b.type, conditions: sanitizeConditions(b.conditions) }));
  });

  app.put("/api/templates/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const t = TemplatesRepo.setMeta(tenantOf(req), String((req.params as any).id), (req.body ?? {}) as any);
    if (!t) return reply.code(404).send({ error: "Template niet gevonden" });
    return reply.send(t);
  });

  app.post("/api/templates/:id/blocks", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const blocks = (req.body as any)?.blocks;
    if (!blocks || blocks.type !== "core/root") return reply.code(400).send({ error: "Ongeldige structuur" });
    const res = validateTree(blocks as Block);
    if (!res.ok) return reply.code(400).send({ error: "Validatie mislukt", issues: res.issues });
    const t = TemplatesRepo.saveBlocks(tenantOf(req), String((req.params as any).id), blocks as Block);
    if (!t) return reply.code(404).send({ error: "Template niet gevonden" });
    return reply.send(t);
  });

  app.patch("/api/templates/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const status = clip((req.body as any)?.status, 20);
    if (!STATUSES.includes(status)) return reply.code(400).send({ error: "Ongeldige status", issues: [{ path: "status", message: "Status moet 'draft' of 'live' zijn" }] });
    const t = TemplatesRepo.setStatus(tenantOf(req), String((req.params as any).id), status);
    if (!t) return reply.code(404).send({ error: "Template niet gevonden" });
    return reply.send(t);
  });

  app.delete("/api/templates/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    if (!TemplatesRepo.remove(tenantOf(req), String((req.params as any).id))) return reply.code(404).send({ error: "Template niet gevonden" });
    return reply.send({ ok: true });
  });
}
