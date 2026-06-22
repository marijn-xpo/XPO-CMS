import { buildApp } from "./app.js";
import { startWorker } from "./core/queue.js";

const app = await buildApp({ logger: true });
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
if (!process.env.XPO_SECRET) app.log.warn("XPO_SECRET niet gezet — gebruik een vaste, geheime waarde in productie (sessies vervallen anders bij herstart).");
startWorker(); // achtergrond-jobs verwerken (e-mail, sitemap, imports)
await app.listen({ port, host });
app.log.info(`XPO CMS — admin: http://localhost:${port}/admin/  |  publiek: http://localhost:${port}/site`);
