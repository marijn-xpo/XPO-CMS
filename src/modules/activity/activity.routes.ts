import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";

const NOUN: Record<string, string> = {
  pages: "Pagina", media: "Media", users: "Gebruiker", forms: "Formulier",
  products: "Product", orders: "Order", navigation: "Navigatie", redirects: "Redirect",
  tickets: "Ticket", kb: "KB-artikel", "field-groups": "Veldgroep", languages: "Taal",
  templates: "Template", campaigns: "Campagne", settings: "Instellingen", activity: "Activiteit",
};

export function describeRequest(method: string, url: string): string {
  const segs = url.split("?")[0].split("/").filter(Boolean); // api / <res> / <id?> / <sub?>
  const res = segs[1] || "";
  const sub = segs[3] || "";
  if (res === "pages" && sub === "publish") return "Pagina gepubliceerd";
  if (res === "forms" && sub === "submissions") return "Formulierinzending ontvangen";
  if (res === "languages" && sub === "default") return "Standaardtaal gewijzigd";
  if (res === "navigation") return "Navigatie bijgewerkt";
  if (res === "settings") return "Instellingen opgeslagen";
  const noun = NOUN[res] || res || "Actie";
  const verb = method === "POST" ? "aangemaakt" : method === "DELETE" ? "verwijderd" : "bijgewerkt";
  return `${noun} ${verb}`;
}

function kindFor(status: number): string {
  return status < 400 ? "ok" : status < 500 ? "warn" : "danger";
}

export const ActivityRepo = {
  record(tenant: string, e: { actor: string; action: string; target?: string; status?: number; kind?: string }): void {
    const status = e.status ?? 200;
    getDb()
      .prepare("INSERT INTO activity (tenant_id, ts, actor, action, target, status, kind) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(tenant, Date.now(), e.actor || "systeem", e.action, e.target || "", status, e.kind || kindFor(status));
    getDb().prepare(
      "DELETE FROM activity WHERE tenant_id = ? AND id NOT IN (SELECT id FROM activity WHERE tenant_id = ? ORDER BY ts DESC LIMIT 500)"
    ).run(tenant, tenant);
  },
  recordRequest(tenant: string, method: string, url: string, actor: string, status: number): void {
    this.record(tenant, { actor, action: describeRequest(method, url), target: url.split("?")[0], status });
  },
  list(tenant: string, limit = 100): { id: number; when: number; text: string; kind: string }[] {
    const rows = getDb()
      .prepare("SELECT id, ts, actor, action, kind FROM activity WHERE tenant_id = ? ORDER BY ts DESC LIMIT ?")
      .all(tenant, Math.min(limit, 200)) as any[];
    return rows.map((r) => ({ id: r.id, when: r.ts, text: `${r.actor} · ${r.action}`, kind: r.kind }));
  },
};

export async function activityRoutes(app: FastifyInstance) {
  app.get("/api/activity", { preHandler: authGuard }, async (req, reply) => reply.send(ActivityRepo.list(tenantOf(req))));
}
