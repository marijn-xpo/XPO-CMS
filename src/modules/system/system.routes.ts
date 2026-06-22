import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.js";
import { dbInfo } from "../../db/database.js";
import { getAsyncDb } from "../../db/async-db.js";
import { cacheStats } from "../../core/render-cache.js";
import { loadedPlugins, listPaymentProviders } from "../../core/plugins.js";
import { widgetTypes } from "../../engine/engine.js";
import { queueStats } from "../../core/queue.js";

export async function systemRoutes(app: FastifyInstance) {
  app.get("/api/system", { preHandler: authGuard }, async (_req, reply) => reply.send({
    version: "1.0.0",
    db: dbInfo(),
    asyncDriver: (await getAsyncDb()).driver,
    cache: await cacheStats(),
    plugins: loadedPlugins(),
    paymentProviders: listPaymentProviders(),
    widgets: widgetTypes().length,
    queue: queueStats(),
  }));
  app.get("/api/payment-providers", { preHandler: authGuard }, async (_req, reply) => reply.send(listPaymentProviders()));
  app.get("/api/widgets", async (_req, reply) => reply.send({ all: widgetTypes(), count: widgetTypes().length }));
}
