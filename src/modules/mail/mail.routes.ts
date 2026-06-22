import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";
import { SettingsRepo } from "../settings/settings.routes.js";

const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);

export const EmailsRepo = {
  add(tenant: string, to: string, subject: string, body: string, status: string) {
    const id = "em_" + Math.random().toString(36).slice(2, 10);
    getDb().prepare("INSERT INTO emails (id, tenant_id, to_addr, subject, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, tenant, clip(to, 200), clip(subject, 300), clip(body, 8000), status, Date.now());
    return id;
  },
  list(tenant: string) {
    return (getDb().prepare("SELECT id, to_addr, subject, body, status, created_at FROM emails WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200").all(tenant) as any[])
      .map((r) => ({ id: r.id, to: r.to_addr, subject: r.subject, body: r.body, status: r.status, when: r.created_at }));
  },
};

// stel een nette e-mail samen uit een wachtrij-bezorging (form-inzending)
export function composeFromDelivery(payload: any): { subject: string; body: string } {
  const form = payload?.form || "Formulier";
  const data = payload?.data || {};
  const lines = Object.keys(data).map((k) => `${k}: ${String(data[k] ?? "")}`);
  return { subject: `Nieuwe inzending: ${form}`, body: `Er is een nieuwe inzending binnengekomen via "${form}".\n\n${lines.join("\n")}` };
}

// verstuur een e-mail-bezorging. mode 'log' = outbox (altijd ok), 'smtp' = echte verzending (nodemailer indien aanwezig)
export async function sendEmailDelivery(tenant: string, to: string, payload: any): Promise<{ status: string; error: string }> {
  const mail = SettingsRepo.get(tenant).mail;
  const { subject, body } = composeFromDelivery(payload);
  if (mail.mode !== "smtp") {
    EmailsRepo.add(tenant, to, subject, body, "sent");
    return { status: "sent", error: "" };
  }
  // SMTP-modus: probeer nodemailer (vereist productieomgeving + netwerk)
  try {
    const spec = "nodemailer";
    const nodemailer: any = await import(spec).catch(() => null);
    if (!nodemailer) { EmailsRepo.add(tenant, to, subject, body, "queued"); return { status: "failed", error: "nodemailer niet beschikbaar" }; }
    const tx = nodemailer.createTransport({ host: mail.host, port: mail.port, secure: mail.secure, auth: mail.user ? { user: mail.user, pass: mail.pass } : undefined });
    await tx.sendMail({ from: mail.from, to, subject, text: body });
    EmailsRepo.add(tenant, to, subject, body, "sent");
    return { status: "sent", error: "" };
  } catch (e: any) {
    EmailsRepo.add(tenant, to, subject, body, "failed");
    return { status: "failed", error: String(e?.message || "SMTP-verzending mislukt").slice(0, 200) };
  }
}

export async function mailRoutes(app: FastifyInstance) {
  app.get("/api/emails", { preHandler: authGuard }, async (req, reply) => reply.send(EmailsRepo.list(tenantOf(req))));
}
