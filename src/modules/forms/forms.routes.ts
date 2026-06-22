import type { FastifyInstance } from "fastify";
import { isHoneypotTripped } from "../../common/security.js";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { rateLimit } from "../../common/ratelimit.js";
import { tenantOf } from "../../common/tenant.js";
import { ServiceError } from "../pages/pages.service.js";
import { sendEmailDelivery } from "../mail/mail.routes.js";

// verwerk één bezorging: e-mail via mailer, webhook via HTTP POST
async function processDelivery(tenant: string, d: any): Promise<{ status: string; error: string }> {
  if (d.type === "email") {
    return sendEmailDelivery(tenant, d.target, JSON.parse(d.payload || "{}"));
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(d.target, { method: "POST", headers: { "content-type": "application/json" }, body: d.payload, signal: ctrl.signal });
    clearTimeout(t);
    return { status: res.ok ? "sent" : "failed", error: res.ok ? "" : "HTTP " + res.status };
  } catch (e: any) {
    return { status: "failed", error: String(e?.message || "verzenden mislukt").slice(0, 200) };
  }
}

export type Field = { id: string; label: string; type: string; required: boolean };
export type FormAction = { type: "crm" | "webhook" | "email"; enabled: boolean; target: string; mapping?: Record<string, string> };
export type Submission = { id: string; when: number; data: unknown };
export type FormDTO = { id: string; name: string; slug: string; fields: Field[]; actions: FormAction[]; submissions: Submission[] };

type FormRow = { id: number; name: string; slug: string; fields: string; actions: string; updated_at: string };
type SubRow = { id: number; form_id: number; data: string; created_at: string };

const ALLOWED_TYPES = ["text", "email", "textarea", "tel", "number", "select", "checkbox", "date", "url"];
const ACTION_TYPES = ["crm", "webhook", "email"];

function sanitizeActions(input: unknown): FormAction[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 10).filter((a: any) => ACTION_TYPES.includes(a?.type)).map((a: any) => ({
    type: a.type, enabled: !!a.enabled, target: String(a.target || "").slice(0, 2048),
    mapping: a.mapping && typeof a.mapping === "object" ? a.mapping : undefined,
  }));
}

// leid CRM-veldwaarden af uit een inzending (expliciete mapping of heuristiek op label/type)
function deriveLead(fields: Field[], data: any, mapping?: Record<string, string>): { name: string; email: string; phone: string; company: string; message: string } {
  const val = (id: string) => (data && id in data ? String(data[id] ?? "") : "");
  const out = { name: "", email: "", phone: "", company: "", message: "" };
  if (mapping) {
    for (const k of Object.keys(out)) if (mapping[k]) (out as any)[k] = val(mapping[k]);
  }
  for (const f of fields) {
    const l = f.label.toLowerCase(); const v = val(f.id);
    if (!v) continue;
    if (!out.email && (f.type === "email" || /mail/.test(l))) out.email = v;
    else if (!out.phone && (f.type === "tel" || /tel|phone|gsm/.test(l))) out.phone = v;
    else if (!out.company && /bedrijf|company|organisat/.test(l)) out.company = v;
    else if (!out.message && (f.type === "textarea" || /bericht|message|vraag|opmerking/.test(l))) out.message = v;
    else if (!out.name && /naam|name/.test(l)) out.name = v;
  }
  return out;
}

const CrmRepo = {
  add(tenant: string, formId: number | null, lead: any, source: string) {
    const id = "ld_" + Math.random().toString(36).slice(2, 9);
    getDb().prepare("INSERT INTO crm_leads (id, tenant_id, form_id, name, email, phone, company, message, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, tenant, formId, lead.name || "", lead.email || "", lead.phone || "", lead.company || "", lead.message || "", source, Date.now());
    return id;
  },
  list(tenant: string, formId?: number) {
    const rows = (formId != null
      ? getDb().prepare("SELECT * FROM crm_leads WHERE tenant_id = ? AND form_id = ? ORDER BY created_at DESC").all(tenant, formId)
      : getDb().prepare("SELECT * FROM crm_leads WHERE tenant_id = ? ORDER BY created_at DESC").all(tenant)) as any[];
    return rows.map((r) => ({ id: r.id, formId: r.form_id != null ? String(r.form_id) : null, name: r.name, email: r.email, phone: r.phone, company: r.company, message: r.message, source: r.source, when: r.created_at }));
  },
};

const DeliveriesRepo = {
  enqueue(tenant: string, formId: number, submissionId: number, type: string, target: string, payload: unknown) {
    const id = "dl_" + Math.random().toString(36).slice(2, 9);
    const now = Date.now();
    getDb().prepare("INSERT INTO form_deliveries (id, tenant_id, form_id, submission_id, type, target, status, payload, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?)")
      .run(id, tenant, formId, submissionId, type, target, JSON.stringify(payload ?? {}), now, now);
    return id;
  },
  list(tenant: string) {
    return (getDb().prepare("SELECT id, form_id, submission_id, type, target, status, attempts, error, created_at FROM form_deliveries WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200").all(tenant) as any[])
      .map((r) => ({ id: r.id, formId: String(r.form_id), submissionId: String(r.submission_id), type: r.type, target: r.target, status: r.status, attempts: r.attempts, error: r.error, when: r.created_at }));
  },
  get(tenant: string, id: string) { return getDb().prepare("SELECT * FROM form_deliveries WHERE tenant_id = ? AND id = ?").get(tenant, id) as any; },
  mark(tenant: string, id: string, status: string, error = "") {
    getDb().prepare("UPDATE form_deliveries SET status = ?, error = ?, attempts = attempts + 1, updated_at = ? WHERE tenant_id = ? AND id = ?").run(status, error, Date.now(), tenant, id);
  },
};

function slugify(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function sanitizeFields(input: unknown): Field[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 50).map((f: any, i) => ({
    id: String(f?.id || `fld${i}`),
    label: String(f?.label || "Veld").slice(0, 120),
    type: ALLOWED_TYPES.includes(String(f?.type)) ? String(f.type) : "text",
    required: !!f?.required,
  }));
}

export const FormsRepo = {
  uniqueSlug(tenant: string, base: string, exceptId?: number): string {
    let slug = base || "formulier";
    let n = 1;
    while (true) {
      const row = getDb().prepare("SELECT id FROM forms WHERE tenant_id = ? AND slug = ? AND id != ?")
        .get(tenant, slug, exceptId ?? -1) as { id: number } | undefined;
      if (!row) return slug;
      n += 1; slug = `${base}-${n}`;
    }
  },
  submissionsFor(tenant: string, formId: number): Submission[] {
    const rows = getDb().prepare("SELECT id, form_id, data, created_at FROM form_submissions WHERE tenant_id = ? AND form_id = ? ORDER BY created_at DESC")
      .all(tenant, formId) as unknown as SubRow[];
    return rows.map((s) => ({ id: String(s.id), when: Date.parse(s.created_at) || Date.now(), data: JSON.parse(s.data) }));
  },
  toDto(tenant: string, r: FormRow): FormDTO {
    return { id: String(r.id), name: r.name, slug: r.slug, fields: JSON.parse(r.fields), actions: r.actions ? JSON.parse(r.actions) : [], submissions: this.submissionsFor(tenant, r.id) };
  },
  list(tenant: string): FormDTO[] {
    const rows = getDb().prepare("SELECT id, name, slug, fields, actions, updated_at FROM forms WHERE tenant_id = ? ORDER BY created_at ASC")
      .all(tenant) as unknown as FormRow[];
    return rows.map((r) => this.toDto(tenant, r));
  },
  get(tenant: string, id: number): FormDTO | null {
    const r = getDb().prepare("SELECT id, name, slug, fields, actions, updated_at FROM forms WHERE tenant_id = ? AND id = ?")
      .get(tenant, id) as unknown as FormRow | undefined;
    return r ? this.toDto(tenant, r) : null;
  },
  create(tenant: string, name: string, fields: Field[]): FormDTO {
    const now = new Date().toISOString();
    const slug = this.uniqueSlug(tenant, slugify(name));
    const info = getDb().prepare("INSERT INTO forms (tenant_id, name, slug, fields, actions, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', ?, ?)")
      .run(tenant, name, slug, JSON.stringify(fields), now, now);
    return this.get(tenant, Number(info.lastInsertRowid))!;
  },
  update(tenant: string, id: number, name: string, slug: string, fields: Field[], actions: FormAction[]): FormDTO | null {
    const now = new Date().toISOString();
    getDb().prepare("UPDATE forms SET name = ?, slug = ?, fields = ?, actions = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
      .run(name, slug, JSON.stringify(fields), JSON.stringify(actions), now, tenant, id);
    return this.get(tenant, id);
  },
  remove(tenant: string, id: number): boolean {
    getDb().prepare("DELETE FROM form_submissions WHERE tenant_id = ? AND form_id = ?").run(tenant, id);
    return getDb().prepare("DELETE FROM forms WHERE tenant_id = ? AND id = ?").run(tenant, id).changes > 0;
  },
  addSubmission(tenant: string, formId: number, data: unknown): Submission {
    const now = new Date().toISOString();
    const info = getDb().prepare("INSERT INTO form_submissions (form_id, tenant_id, data, created_at) VALUES (?, ?, ?, ?)")
      .run(formId, tenant, JSON.stringify(data ?? null), now);
    return { id: String(info.lastInsertRowid), when: Date.parse(now), data };
  },
};

const FormsService = {
  list: (tenant: string) => FormsRepo.list(tenant),
  create(tenant: string, name: string): FormDTO {
    if (!String(name || "").trim()) throw new ServiceError(400, "Naam is verplicht");
    return FormsRepo.create(tenant, name.trim(), [{ id: "fld1", label: "Naam", type: "text", required: true }]);
  },
  update(tenant: string, id: number, body: { name?: string; slug?: string; fields?: unknown; actions?: unknown }): FormDTO {
    const cur = FormsRepo.get(tenant, id);
    if (!cur) throw new ServiceError(404, "Formulier niet gevonden");
    const name = String(body.name ?? cur.name).trim() || cur.name;
    const slug = FormsRepo.uniqueSlug(tenant, slugify(body.slug ?? cur.slug) || cur.slug, id);
    const fields = body.fields !== undefined ? sanitizeFields(body.fields) : cur.fields;
    const actions = body.actions !== undefined ? sanitizeActions(body.actions) : cur.actions;
    return FormsRepo.update(tenant, id, name, slug, fields, actions)!;
  },
  remove(tenant: string, id: number): void {
    if (!FormsRepo.remove(tenant, id)) throw new ServiceError(404, "Formulier niet gevonden");
  },
  submit(tenant: string, id: number, data: unknown): Submission {
    const form = FormsRepo.get(tenant, id);
    if (!form) throw new ServiceError(404, "Formulier niet gevonden");
    const sub = FormsRepo.addSubmission(tenant, id, data);
    // acties verwerken: CRM-lead lokaal opslaan, webhook/e-mail in de wachtrij
    for (const a of form.actions) {
      if (!a.enabled) continue;
      if (a.type === "crm") {
        CrmRepo.add(tenant, id, deriveLead(form.fields, data, a.mapping), form.name);
      } else if (a.type === "webhook" || a.type === "email") {
        DeliveriesRepo.enqueue(tenant, id, Number(sub.id), a.type, a.target, { form: form.name, data });
      }
    }
    return sub;
  },
};

function run(reply: any, fn: () => any) {
  try { return reply.send(fn()); }
  catch (e) {
    if (e instanceof ServiceError) return reply.code(e.status).send({ error: e.message, issues: e.issues });
    reply.log.error(e); return reply.code(500).send({ error: "Interne fout" });
  }
}

export async function formsRoutes(app: FastifyInstance) {
  app.get("/api/forms", { preHandler: authGuard }, async (req, reply) =>
    run(reply, () => FormsService.list(tenantOf(req)))
  );
  app.post("/api/forms", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    run(reply, () => FormsService.create(tenantOf(req), (req.body as any)?.name))
  );
  app.put("/api/forms/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    run(reply, () => FormsService.update(tenantOf(req), Number((req.params as any).id), req.body as any))
  );
  app.delete("/api/forms/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    run(reply, () => { FormsService.remove(tenantOf(req), Number((req.params as any).id)); return { ok: true }; })
  );
  // inzending toevoegen (admin demo nu met auth; publieke site-submit komt met de Nuxt-renderapp)
  app.post("/api/forms/:id/submissions", { preHandler: authGuard }, async (req, reply) =>
    run(reply, () => FormsService.submit(tenantOf(req), Number((req.params as any).id), (req.body as any)?.data))
  );

  // publieke verzending (formulier-widget op de site) — licht rate-limited per IP
  app.post("/api/public/forms/:id/submit", async (req, reply) => {
    if (isHoneypotTripped(req.body)) return reply.code(400).send({ error: "Verzoek geweigerd" });
    const rl = rateLimit(`${req.ip}:form-submit`, 10, 60 * 1000);
    if (!rl.ok) { reply.header("Retry-After", String(rl.retryAfter)); return reply.code(429).send({ error: "Te veel inzendingen. Probeer het zo opnieuw." }); }
    return run(reply, () => FormsService.submit(tenantOf(req), Number((req.params as any).id), (req.body as any)?.data));
  });

  // CRM-leads (lokaal vastgelegd door de 'crm'-actie)
  app.get("/api/leads", { preHandler: authGuard }, async (req, reply) => reply.send(CrmRepo.list(tenantOf(req))));
  app.get("/api/forms/:id/leads", { preHandler: authGuard }, async (req, reply) => reply.send(CrmRepo.list(tenantOf(req), Number((req.params as any).id))));

  // bezorgwachtrij (webhook/e-mail) — versturen gebeurt in productie
  app.get("/api/deliveries", { preHandler: authGuard }, async (req, reply) => reply.send(DeliveriesRepo.list(tenantOf(req))));
  app.post("/api/deliveries/:id/retry", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const tenant = tenantOf(req);
    const d = DeliveriesRepo.get(tenant, String((req.params as any).id));
    if (!d) return reply.code(404).send({ error: "Bezorging niet gevonden" });
    const res = await processDelivery(tenant, d);
    DeliveriesRepo.mark(tenant, d.id, res.status, res.error);
    return reply.send(DeliveriesRepo.get(tenant, d.id));
  });
  // verwerk alle openstaande bezorgingen in de wachtrij
  app.post("/api/deliveries/process", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const tenant = tenantOf(req);
    const pending = (getDb().prepare("SELECT * FROM form_deliveries WHERE tenant_id = ? AND status = 'queued'").all(tenant) as any[]);
    let sent = 0, failed = 0;
    for (const d of pending) { const res = await processDelivery(tenant, d); DeliveriesRepo.mark(tenant, d.id, res.status, res.error); res.status === "sent" ? sent++ : failed++; }
    return reply.send({ ok: true, processed: pending.length, sent, failed });
  });
}
