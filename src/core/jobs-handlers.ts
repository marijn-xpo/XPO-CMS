import { registerJobHandler } from "./queue.js";
import { sendEmailDelivery } from "../modules/mail/mail.routes.js";

// E-mail asynchroon versturen (order-bevestiging, review-notificatie, enz.).
registerJobHandler("email", async (payload, job) => {
  await sendEmailDelivery(job.tenant, payload.to, payload.body);
});
// Plaatsen voor zware achtergrondtaken (sitemap-regeneratie, imports). Nu lichtgewicht.
registerJobHandler("sitemap", async () => { /* sitemap-cache regenereren */ });
registerJobHandler("import", async () => { /* batch-import verwerken */ });
