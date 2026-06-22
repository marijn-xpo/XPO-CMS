import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";

export type Ticket = { id: string; subject: string; from: string; channel: string; status: string };
export type KbArticle = { id: string; title: string; body: string };

const STATUSES = ["Open", "In behandeling", "Opgelost"];
const CHANNELS = ["Portal", "Outlook", "Telefoon", "Chat"];

function clip(s: unknown, n: number): string {
  return String(s ?? "").trim().slice(0, n);
}

const TicketsRepo = {
  list(tenant: string): Ticket[] {
    const rows = getDb()
      .prepare("SELECT id, subject, from_addr, channel, status FROM tickets WHERE tenant_id = ? ORDER BY created_at DESC")
      .all(tenant) as any[];
    return rows.map((r) => ({ id: r.id, subject: r.subject, from: r.from_addr, channel: r.channel, status: r.status }));
  },
  nextId(tenant: string): string {
    const row = getDb()
      .prepare("SELECT MAX(CAST(REPLACE(id, '#', '') AS INTEGER)) AS m FROM tickets WHERE tenant_id = ?")
      .get(tenant) as { m: number | null };
    return "#" + ((row.m || 2840) + 1);
  },
  create(tenant: string, t: { subject: string; from: string; channel: string }): Ticket {
    const id = this.nextId(tenant);
    const channel = CHANNELS.includes(t.channel) ? t.channel : "Portal";
    getDb()
      .prepare("INSERT INTO tickets (id, tenant_id, subject, from_addr, channel, status, created_at) VALUES (?, ?, ?, ?, ?, 'Open', ?)")
      .run(id, tenant, t.subject, t.from, channel, Date.now());
    return { id, subject: t.subject, from: t.from, channel, status: "Open" };
  },
  setStatus(tenant: string, id: string, status: string): Ticket | null {
    const r = getDb().prepare("UPDATE tickets SET status = ? WHERE tenant_id = ? AND id = ?").run(status, tenant, id);
    if (r.changes === 0) return null;
    const row = getDb().prepare("SELECT id, subject, from_addr, channel, status FROM tickets WHERE tenant_id = ? AND id = ?").get(tenant, id) as any;
    return { id: row.id, subject: row.subject, from: row.from_addr, channel: row.channel, status: row.status };
  },
  remove(tenant: string, id: string): boolean {
    return getDb().prepare("DELETE FROM tickets WHERE tenant_id = ? AND id = ?").run(tenant, id).changes > 0;
  },
};

const KbRepo = {
  list(tenant: string): KbArticle[] {
    const rows = getDb()
      .prepare("SELECT id, title, body FROM kb_articles WHERE tenant_id = ? ORDER BY created_at DESC")
      .all(tenant) as any[];
    return rows.map((r) => ({ id: r.id, title: r.title, body: r.body }));
  },
  create(tenant: string, a: { title: string; body: string }): KbArticle {
    const id = "kb_" + Math.random().toString(36).slice(2, 9);
    getDb()
      .prepare("INSERT INTO kb_articles (id, tenant_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, tenant, a.title, a.body, Date.now());
    return { id, title: a.title, body: a.body };
  },
  update(tenant: string, id: string, a: { title: string; body: string }): KbArticle | null {
    const r = getDb().prepare("UPDATE kb_articles SET title = ?, body = ? WHERE tenant_id = ? AND id = ?").run(a.title, a.body, tenant, id);
    if (r.changes === 0) return null;
    return { id, title: a.title, body: a.body };
  },
  remove(tenant: string, id: string): boolean {
    return getDb().prepare("DELETE FROM kb_articles WHERE tenant_id = ? AND id = ?").run(tenant, id).changes > 0;
  },
};

export async function helpdeskRoutes(app: FastifyInstance) {
  // ---- tickets ----
  app.get("/api/tickets", { preHandler: authGuard }, async (req, reply) => reply.send(TicketsRepo.list(tenantOf(req))));

  app.post("/api/tickets", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const subject = clip(b.subject, 200);
    if (!subject) return reply.code(400).send({ error: "Onderwerp is verplicht", issues: [{ path: "subject", message: "Onderwerp is verplicht" }] });
    return reply.code(201).send(TicketsRepo.create(tenantOf(req), { subject, from: clip(b.from, 160) || "onbekend", channel: clip(b.channel, 40) }));
  });

  app.patch("/api/tickets/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const status = clip((req.body as any)?.status, 40);
    if (!STATUSES.includes(status)) return reply.code(400).send({ error: "Ongeldige status", issues: [{ path: "status", message: "Status moet zijn: " + STATUSES.join(", ") }] });
    const t = TicketsRepo.setStatus(tenantOf(req), String((req.params as any).id), status);
    if (!t) return reply.code(404).send({ error: "Ticket niet gevonden" });
    return reply.send(t);
  });

  app.delete("/api/tickets/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    if (!TicketsRepo.remove(tenantOf(req), String((req.params as any).id))) return reply.code(404).send({ error: "Ticket niet gevonden" });
    return reply.send({ ok: true });
  });

  // ---- kennisbank ----
  app.get("/api/kb", { preHandler: authGuard }, async (req, reply) => reply.send(KbRepo.list(tenantOf(req))));

  app.post("/api/kb", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const title = clip(b.title, 200);
    if (!title) return reply.code(400).send({ error: "Titel is verplicht", issues: [{ path: "title", message: "Titel is verplicht" }] });
    return reply.code(201).send(KbRepo.create(tenantOf(req), { title, body: clip(b.body, 20000) }));
  });

  app.put("/api/kb/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const title = clip(b.title, 200);
    if (!title) return reply.code(400).send({ error: "Titel is verplicht", issues: [{ path: "title", message: "Titel is verplicht" }] });
    const a = KbRepo.update(tenantOf(req), String((req.params as any).id), { title, body: clip(b.body, 20000) });
    if (!a) return reply.code(404).send({ error: "Artikel niet gevonden" });
    return reply.send(a);
  });

  app.delete("/api/kb/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    if (!KbRepo.remove(tenantOf(req), String((req.params as any).id))) return reply.code(404).send({ error: "Artikel niet gevonden" });
    return reply.send({ ok: true });
  });
}
