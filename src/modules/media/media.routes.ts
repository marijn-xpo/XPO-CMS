import type { FastifyInstance } from "fastify";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";
import { MediaService } from "./media.service.js";
import { ServiceError } from "../pages/pages.service.js";

async function run(reply: any, fn: () => Promise<any> | any) {
  try {
    return reply.send(await fn());
  } catch (e) {
    if (e instanceof ServiceError) return reply.code(e.status).send({ error: e.message, issues: e.issues });
    reply.log.error(e);
    return reply.code(500).send({ error: "Interne fout" });
  }
}

export async function mediaRoutes(app: FastifyInstance) {
  app.get("/api/media", { preHandler: authGuard }, async (req, reply) =>
    run(reply, () => MediaService.list(tenantOf(req)))
  );
  app.post("/api/media", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    run(reply, () => {
      const { name, dataUrl } = (req.body as any) || {};
      return MediaService.createFromDataUrl(tenantOf(req), name, dataUrl);
    })
  );
  app.delete("/api/media/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    run(reply, async () => { await MediaService.remove(tenantOf(req), Number((req.params as any).id)); return { ok: true }; })
  );
}
