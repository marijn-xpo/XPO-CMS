import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";
import { esc, safeUrl, safeImg } from "../../engine/engine.js";

export type Popup = {
  id: string; name: string; active: boolean; trigger: string; delay: number;
  condType: string; condValue: string; title: string; body: string;
  btnLabel: string; btnUrl: string; image: string; updatedAt: number;
};

const TRIGGERS = ["load", "scroll", "exit", "click"];
function clip(s: unknown, n: number): string { return String(s ?? "").trim().slice(0, n); }
function toDto(r: any): Popup {
  return {
    id: r.id, name: r.name, active: !!r.active, trigger: r.trigger, delay: r.delay,
    condType: r.cond_type, condValue: r.cond_value, title: r.title, body: r.body,
    btnLabel: r.btn_label, btnUrl: r.btn_url, image: r.image, updatedAt: r.updated_at,
  };
}

export const PopupsRepo = {
  list(tenant: string): Popup[] {
    return (getDb().prepare("SELECT * FROM popups WHERE tenant_id = ? ORDER BY updated_at DESC").all(tenant) as any[]).map(toDto);
  },
  get(tenant: string, id: string): Popup | null {
    const r = getDb().prepare("SELECT * FROM popups WHERE tenant_id = ? AND id = ?").get(tenant, id) as any;
    return r ? toDto(r) : null;
  },
  activeFor(tenant: string, slug: string): Popup[] {
    return (getDb().prepare(
      "SELECT * FROM popups WHERE tenant_id = ? AND active = 1 AND (cond_type = 'all' OR (cond_type = 'page' AND cond_value = ?)) ORDER BY updated_at DESC"
    ).all(tenant, slug) as any[]).map(toDto);
  },
  create(tenant: string, d: any): Popup {
    const id = "pu_" + Math.random().toString(36).slice(2, 9);
    const now = Date.now();
    const trigger = TRIGGERS.includes(d.trigger) ? d.trigger : "load";
    getDb().prepare(
      `INSERT INTO popups (id, tenant_id, name, active, trigger, delay, cond_type, cond_value, title, body, btn_label, btn_url, image, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, tenant, clip(d.name, 120) || "Popup", trigger, Number(d.delay) || 0,
      d.condType === "page" ? "page" : "all", clip(d.condValue, 200),
      clip(d.title, 200), clip(d.body, 1000), clip(d.btnLabel, 80), clip(d.btnUrl, 2048), clip(d.image, 2048), now, now);
    return this.get(tenant, id)!;
  },
  update(tenant: string, id: string, d: any): Popup | null {
    const cur = this.get(tenant, id);
    if (!cur) return null;
    const trigger = TRIGGERS.includes(d.trigger) ? d.trigger : cur.trigger;
    getDb().prepare(
      `UPDATE popups SET name=?, trigger=?, delay=?, cond_type=?, cond_value=?, title=?, body=?, btn_label=?, btn_url=?, image=?, updated_at=? WHERE tenant_id=? AND id=?`
    ).run(clip(d.name, 120) || cur.name, trigger, Number(d.delay) || 0,
      d.condType === "page" ? "page" : "all", clip(d.condValue, 200),
      clip(d.title, 200), clip(d.body, 1000), clip(d.btnLabel, 80), clip(d.btnUrl, 2048), clip(d.image, 2048), Date.now(), tenant, id);
    return this.get(tenant, id);
  },
  setActive(tenant: string, id: string, active: boolean): Popup | null {
    if (getDb().prepare("UPDATE popups SET active=?, updated_at=? WHERE tenant_id=? AND id=?").run(active ? 1 : 0, Date.now(), tenant, id).changes === 0) return null;
    return this.get(tenant, id);
  },
  remove(tenant: string, id: string): boolean {
    return getDb().prepare("DELETE FROM popups WHERE tenant_id=? AND id=?").run(tenant, id).changes > 0;
  },
};

// publieke markup (verborgen tot de trigger 'm toont) + scripttag
export function popupsMarkup(tenant: string, slug: string): string {
  const popups = PopupsRepo.activeFor(tenant, slug);
  if (!popups.length) return "";
  const html = popups.map((p) => {
    const img = safeImg(p.image) ? `<img class="xpo-popup__img" src="${esc(safeImg(p.image))}" alt=""/>` : "";
    const btn = p.btnLabel ? `<a class="pillbtn" href="${esc(safeUrl(p.btnUrl))}">${esc(p.btnLabel)}</a>` : "";
    return `<div class="xpo-popup" id="pop-${esc(p.id)}" data-trigger="${esc(p.trigger)}" data-delay="${Number(p.delay) || 0}" hidden>
<div class="xpo-popup__box"><button class="xpo-popup__x" aria-label="Sluiten">&times;</button>${img}${p.title ? `<h3>${esc(p.title)}</h3>` : ""}${p.body ? `<p>${esc(p.body)}</p>` : ""}${btn}</div></div>`;
  }).join("");
  return html + `<script src="/assets/xpo-popups.js"></script>`;
}

export async function popupsRoutes(app: FastifyInstance) {
  app.get("/api/popups", { preHandler: authGuard }, async (req, reply) => reply.send(PopupsRepo.list(tenantOf(req))));
  const w = { preHandler: [authGuard, requireRole("editor")] };
  app.post("/api/popups", w, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    if (!clip(b.name, 120)) return reply.code(400).send({ error: "Naam is verplicht", issues: [{ path: "name", message: "Naam is verplicht" }] });
    return reply.code(201).send(PopupsRepo.create(tenantOf(req), b));
  });
  app.put("/api/popups/:id", w, async (req, reply) => {
    const p = PopupsRepo.update(tenantOf(req), String((req.params as any).id), (req.body ?? {}) as any);
    if (!p) return reply.code(404).send({ error: "Popup niet gevonden" });
    return reply.send(p);
  });
  app.post("/api/popups/:id/toggle", w, async (req, reply) => {
    const cur = PopupsRepo.get(tenantOf(req), String((req.params as any).id));
    if (!cur) return reply.code(404).send({ error: "Popup niet gevonden" });
    return reply.send(PopupsRepo.setActive(tenantOf(req), cur.id, !cur.active));
  });
  app.delete("/api/popups/:id", w, async (req, reply) => {
    if (!PopupsRepo.remove(tenantOf(req), String((req.params as any).id))) return reply.code(404).send({ error: "Popup niet gevonden" });
    return reply.send({ ok: true });
  });
}
