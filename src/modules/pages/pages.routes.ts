import type { FastifyInstance } from "fastify";
import { authGuard, requireRole } from "../../common/auth.js";
import { signPreview } from "../../common/preview.js";
import { tenantOf } from "../../common/tenant.js";
import { PagesService, ServiceError } from "./pages.service.js";

function handle(reply: any, fn: () => any) {
  try {
    return reply.send(fn());
  } catch (e) {
    if (e instanceof ServiceError) return reply.code(e.status).send({ error: e.message, issues: e.issues });
    reply.log.error(e);
    return reply.code(500).send({ error: "Interne fout" });
  }
}

export async function pagesRoutes(app: FastifyInstance) {
  // lezen
  app.get("/api/pages", { preHandler: authGuard }, async (req, reply) =>
    handle(reply, () => PagesService.list(tenantOf(req), { trashed: (req.query as any)?.trashed === "1" }))
  );
  app.get("/api/pages/:id", { preHandler: authGuard }, async (req, reply) =>
    handle(reply, () => PagesService.get(tenantOf(req), Number((req.params as any).id)))
  );
  app.post("/api/pages/:id/preview-token", { preHandler: authGuard }, async (req, reply) => { const id = Number((req.params as any).id); const t = signPreview("page", id, tenantOf(req)); return reply.send({ token: t, url: "/preview/page/" + id + "?token=" + encodeURIComponent(t) }); });
  app.get("/api/pages/:id/versions", { preHandler: authGuard }, async (req, reply) =>
    handle(reply, () => PagesService.versions(tenantOf(req), Number((req.params as any).id)))
  );

  // schrijven (rol: editor+)
  app.post("/api/pages", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    handle(reply, () => PagesService.create(tenantOf(req), req.body as any))
  );
  app.put("/api/pages/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    handle(reply, () => PagesService.update(tenantOf(req), Number((req.params as any).id), req.body as any))
  );
  app.post("/api/pages/:id/publish", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    handle(reply, () => PagesService.publish(tenantOf(req), Number((req.params as any).id)))
  );
  app.post("/api/pages/:id/schedule", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    handle(reply, () => PagesService.schedule(tenantOf(req), Number((req.params as any).id), Number((req.body as any)?.at)))
  );
  app.post("/api/pages/:id/translate", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    handle(reply, () => PagesService.translate(tenantOf(req), Number((req.params as any).id), String((req.body as any)?.locale || "")))
  );
  app.post("/api/pages/:id/restore-version/:vid", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    handle(reply, () => PagesService.restoreVersion(tenantOf(req), Number((req.params as any).id), Number((req.params as any).vid)))
  );
  app.post("/api/pages/:id/trash", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    handle(reply, () => { PagesService.trash(tenantOf(req), Number((req.params as any).id)); return { ok: true }; })
  );
  app.post("/api/pages/:id/restore", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    handle(reply, () => PagesService.restore(tenantOf(req), Number((req.params as any).id)))
  );
  // DELETE: in prullenbak => definitief; anders => naar prullenbak
  app.delete("/api/pages/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    handle(reply, () => {
      const tenant = tenantOf(req); const id = Number((req.params as any).id);
      if ((req.query as any)?.purge === "1") { PagesService.purge(tenant, id); return { ok: true, purged: true }; }
      PagesService.trash(tenant, id); return { ok: true, trashed: true };
    })
  );
}
