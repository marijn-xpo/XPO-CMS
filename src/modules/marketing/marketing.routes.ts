import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";

export type Campaign = { id: string; name: string; channel: string; status: string; sent: number; open: number };

const CHANNELS = ["E-mail", "Automation", "Social", "Display"];
const STATUSES = ["concept", "actief"];

function clip(s: unknown, n: number): string {
  return String(s ?? "").trim().slice(0, n);
}
function toDto(r: any): Campaign {
  return { id: r.id, name: r.name, channel: r.channel, status: r.status, sent: r.sent, open: r.open_rate };
}

const CampaignsRepo = {
  list(tenant: string): Campaign[] {
    return (getDb()
      .prepare("SELECT id, name, channel, status, sent, open_rate FROM campaigns WHERE tenant_id = ? ORDER BY created_at DESC")
      .all(tenant) as any[]).map(toDto);
  },
  create(tenant: string, c: { name: string; channel: string }): Campaign {
    const id = "cmp_" + Math.random().toString(36).slice(2, 9);
    const channel = CHANNELS.includes(c.channel) ? c.channel : "E-mail";
    getDb()
      .prepare("INSERT INTO campaigns (id, tenant_id, name, channel, status, sent, open_rate, created_at) VALUES (?, ?, ?, ?, 'concept', 0, 0, ?)")
      .run(id, tenant, c.name, channel, Date.now());
    return { id, name: c.name, channel, status: "concept", sent: 0, open: 0 };
  },
  setStatus(tenant: string, id: string, status: string): Campaign | null {
    const r = getDb().prepare("UPDATE campaigns SET status = ? WHERE tenant_id = ? AND id = ?").run(status, tenant, id);
    if (r.changes === 0) return null;
    const row = getDb().prepare("SELECT id, name, channel, status, sent, open_rate FROM campaigns WHERE tenant_id = ? AND id = ?").get(tenant, id);
    return toDto(row);
  },
  remove(tenant: string, id: string): boolean {
    return getDb().prepare("DELETE FROM campaigns WHERE tenant_id = ? AND id = ?").run(tenant, id).changes > 0;
  },
};

export async function marketingRoutes(app: FastifyInstance) {
  app.get("/api/campaigns", { preHandler: authGuard }, async (req, reply) => reply.send(CampaignsRepo.list(tenantOf(req))));

  app.post("/api/campaigns", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const name = clip(b.name, 160);
    if (!name) return reply.code(400).send({ error: "Naam is verplicht", issues: [{ path: "name", message: "Naam is verplicht" }] });
    return reply.code(201).send(CampaignsRepo.create(tenantOf(req), { name, channel: clip(b.channel, 40) }));
  });

  app.patch("/api/campaigns/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const status = clip((req.body as any)?.status, 40);
    if (!STATUSES.includes(status)) return reply.code(400).send({ error: "Ongeldige status", issues: [{ path: "status", message: "Status moet 'concept' of 'actief' zijn" }] });
    const c = CampaignsRepo.setStatus(tenantOf(req), String((req.params as any).id), status);
    if (!c) return reply.code(404).send({ error: "Campagne niet gevonden" });
    return reply.send(c);
  });

  app.delete("/api/campaigns/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    if (!CampaignsRepo.remove(tenantOf(req), String((req.params as any).id))) return reply.code(404).send({ error: "Campagne niet gevonden" });
    return reply.send({ ok: true });
  });
}
