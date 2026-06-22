import type { FastifyInstance } from "fastify";
import { isHoneypotTripped } from "../../common/security.js";
import { enqueue } from "../../core/queue.js";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";
import { rateLimit } from "../../common/ratelimit.js";
import { SettingsRepo } from "../settings/settings.routes.js";
import { sendEmailDelivery } from "../mail/mail.routes.js";

export type Comment = { id: string; postId: string; parentId: string; author: string; email: string; body: string; status: string; when: number };

const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);

export const CommentsRepo = {
  toDto(r: any): Comment {
    return { id: r.id, postId: String(r.post_id), parentId: r.parent_id || "", author: r.author, email: r.email, body: r.body, status: r.status, when: r.created_at };
  },
  add(tenant: string, postId: number, c: { author?: string; email?: string; body: string; parentId?: string }): Comment {
    const id = "cm_" + Math.random().toString(36).slice(2, 10);
    getDb().prepare("INSERT INTO comments (id, tenant_id, post_id, author, email, body, status, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
      .run(id, tenant, postId, clip(c.author, 80) || "Anoniem", clip(c.email, 160), clip(c.body, 4000), clip(c.parentId, 20), Date.now());
    return this.toDto(getDb().prepare("SELECT * FROM comments WHERE id = ?").get(id));
  },
  list(tenant: string, opts: { status?: string; postId?: number } = {}): Comment[] {
    let sql = "SELECT * FROM comments WHERE tenant_id = ?"; const args: any[] = [tenant];
    if (opts.status) { sql += " AND status = ?"; args.push(opts.status); }
    if (opts.postId != null) { sql += " AND post_id = ?"; args.push(opts.postId); }
    sql += " ORDER BY created_at DESC";
    return (getDb().prepare(sql).all(...args) as any[]).map((r) => this.toDto(r));
  },
  approvedFor(tenant: string, postId: number): Comment[] {
    return (getDb().prepare("SELECT * FROM comments WHERE tenant_id = ? AND post_id = ? AND status = 'approved' ORDER BY created_at ASC").all(tenant, postId) as any[]).map((r) => this.toDto(r));
  },
  counts(tenant: string): Record<string, number> {
    const rows = getDb().prepare("SELECT status, COUNT(*) n FROM comments WHERE tenant_id = ? GROUP BY status").all(tenant) as any[];
    const out: Record<string, number> = { pending: 0, approved: 0, spam: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  },
  setStatus(tenant: string, id: string, status: string): boolean {
    return getDb().prepare("UPDATE comments SET status = ? WHERE tenant_id = ? AND id = ?").run(status, tenant, id).changes > 0;
  },
  remove(tenant: string, id: string): boolean {
    return getDb().prepare("DELETE FROM comments WHERE tenant_id = ? AND id = ?").run(tenant, id).changes > 0;
  },
};

export async function commentsRoutes(app: FastifyInstance) {
  // publiek: reactie plaatsen (belandt op 'pending')
  app.post("/api/posts/:id/comments", async (req, reply) => {
    if (isHoneypotTripped(req.body)) return reply.code(400).send({ error: "Verzoek geweigerd" });
    const body = clip((req.body as any)?.body, 4000);
    if (body.length < 2) return reply.code(400).send({ error: "Reactie is te kort", issues: [{ path: "body", message: "Schrijf een reactie" }] });
    const tenant = tenantOf(req);
    const rl = rateLimit(`${req.ip}:comment`, 8, 60 * 1000);
    if (!rl.ok) { reply.header("Retry-After", String(rl.retryAfter)); return reply.code(429).send({ error: "Te veel reacties. Probeer het zo opnieuw." }); }
    const c = CommentsRepo.add(tenant, Number((req.params as any).id), { author: (req.body as any)?.author, email: (req.body as any)?.email, body, parentId: (req.body as any)?.parentId });
    try {
      const adminMail = SettingsRepo.get(tenant).mail.from || "admin@xpo.nl";
      enqueue(tenant, "email", { to: adminMail, body: { form: "Nieuwe reactie (moderatie vereist)", data: { auteur: c.author, reactie: c.body } } });
    } catch { /* notificatie mag nooit blokkeren */ }
    return reply.send({ ok: true, status: c.status, id: c.id });
  });
  // publiek: goedgekeurde reacties ophalen
  app.get("/api/posts/:id/comments", async (req, reply) =>
    reply.send(CommentsRepo.approvedFor(tenantOf(req), Number((req.params as any).id)))
  );
  // moderatie
  app.get("/api/comments", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    reply.send({ items: CommentsRepo.list(tenantOf(req), { status: (req.query as any)?.status }), counts: CommentsRepo.counts(tenantOf(req)) })
  );
  app.post("/api/comments/:id/:action", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const action = String((req.params as any).action);
    const map: Record<string, string> = { approve: "approved", spam: "spam", pending: "pending" };
    if (!map[action]) return reply.code(400).send({ error: "Onbekende actie" });
    if (!CommentsRepo.setStatus(tenantOf(req), String((req.params as any).id), map[action])) return reply.code(404).send({ error: "Reactie niet gevonden" });
    return reply.send({ ok: true, status: map[action] });
  });
  app.delete("/api/comments/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    if (!CommentsRepo.remove(tenantOf(req), String((req.params as any).id))) return reply.code(404).send({ error: "Reactie niet gevonden" });
    return reply.send({ ok: true });
  });
}
