import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";

export type MenuItem = { label: string; to: string; children?: MenuItem[]; mega?: MegaCol[]; featured?: Featured };
export type MegaCol = { heading: string; items: { label: string; to: string; desc: string }[] };
export type Featured = { kicker: string; title: string; desc: string; to: string };
export type Navigation = { main: MenuItem[]; footer: MenuItem[] };

const EMPTY: Navigation = { main: [], footer: [] };

function sanitizeItem(i: any, depth: number): MenuItem {
  const o: MenuItem = { label: String(i?.label ?? "").slice(0, 80), to: String(i?.to ?? "").slice(0, 200) };
  if (depth < 4 && Array.isArray(i?.children) && i.children.length) {
    o.children = i.children.slice(0, 50).map((c: any) => sanitizeItem(c, depth + 1));
  }
  if (Array.isArray(i?.mega)) {
    o.mega = i.mega.slice(0, 6).map((col: any) => ({
      heading: String(col?.heading ?? "").slice(0, 60),
      items: (Array.isArray(col?.items) ? col.items : []).slice(0, 12).map((it: any) => ({
        label: String(it?.label ?? "").slice(0, 80),
        to: String(it?.to ?? "").slice(0, 200),
        desc: String(it?.desc ?? "").slice(0, 120),
      })),
    }));
  }
  if (i?.featured && typeof i.featured === "object") {
    o.featured = {
      kicker: String(i.featured.kicker ?? "").slice(0, 40),
      title: String(i.featured.title ?? "").slice(0, 80),
      desc: String(i.featured.desc ?? "").slice(0, 160),
      to: String(i.featured.to ?? "").slice(0, 200),
    };
  }
  return o;
}
function sanitizeList(input: unknown): MenuItem[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 50).map((i) => sanitizeItem(i, 0));
}
function sanitize(input: any): Navigation {
  return { main: sanitizeList(input?.main), footer: sanitizeList(input?.footer) };
}

export const NavRepo = {
  get(tenant: string): Navigation {
    const row = getDb().prepare("SELECT json FROM navigation WHERE tenant_id = ?").get(tenant) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Navigation) : { ...EMPTY };
  },
  set(tenant: string, nav: Navigation): Navigation {
    getDb().prepare(
      "INSERT INTO navigation (tenant_id, json) VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET json = excluded.json"
    ).run(tenant, JSON.stringify(nav));
    return nav;
  },
};

export async function navigationRoutes(app: FastifyInstance) {
  app.get("/api/navigation", { preHandler: authGuard }, async (req, reply) =>
    reply.send(NavRepo.get(tenantOf(req)))
  );
  app.put("/api/navigation", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) =>
    reply.send(NavRepo.set(tenantOf(req), sanitize(req.body)))
  );
}
