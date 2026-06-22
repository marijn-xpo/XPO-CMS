import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";
import { ServiceError } from "../pages/pages.service.js";

export type UserDTO = { id: string; name: string; email: string; role: string; active: boolean };
type Row = { id: number; name: string; email: string; role: string; active: number };

const CANON: Record<string, string> = { superadmin: "superadmin", admin: "admin", editor: "editor", viewer: "viewer" };
const toCanon = (r: unknown) => CANON[String(r || "").toLowerCase()] || "editor";
const DISPLAY: Record<string, string> = { superadmin: "Superadmin", admin: "Admin", editor: "Editor", viewer: "Viewer" };
const toDisplay = (r: string) => DISPLAY[r] || "Editor";

const toDto = (r: Row): UserDTO => ({ id: String(r.id), name: r.name, email: r.email, role: toDisplay(r.role), active: !!r.active });

const SEL = "SELECT id, name, email, role, active FROM users";

export const UsersRepo = {
  list(tenant: string): UserDTO[] {
    return (getDb().prepare(`${SEL} WHERE tenant_id = ? ORDER BY created_at ASC`).all(tenant) as unknown as Row[]).map(toDto);
  },
  get(tenant: string, id: number): UserDTO | null {
    const r = getDb().prepare(`${SEL} WHERE tenant_id = ? AND id = ?`).get(tenant, id) as unknown as Row | undefined;
    return r ? toDto(r) : null;
  },
  emailExists(tenant: string, email: string): boolean {
    return !!getDb().prepare("SELECT id FROM users WHERE tenant_id = ? AND email = ?").get(tenant, email);
  },
  countSuperadmins(tenant: string): number {
    return (getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role = 'superadmin' AND active = 1").get(tenant) as any).n as number;
  },
  create(tenant: string, u: { name: string; email: string; role: string }): UserDTO {
    const info = getDb().prepare(
      "INSERT INTO users (tenant_id, name, email, role, password_hash, active, created_at) VALUES (?, ?, ?, ?, NULL, 1, ?)"
    ).run(tenant, u.name, u.email, u.role, new Date().toISOString());
    return this.get(tenant, Number(info.lastInsertRowid))!;
  },
  update(tenant: string, id: number, u: { name?: string; role?: string; active?: boolean }): UserDTO | null {
    const cur = getDb().prepare(`${SEL} WHERE tenant_id = ? AND id = ?`).get(tenant, id) as unknown as Row | undefined;
    if (!cur) return null;
    getDb().prepare("UPDATE users SET name = ?, role = ?, active = ? WHERE tenant_id = ? AND id = ?").run(
      u.name ?? cur.name, u.role ?? cur.role, u.active === undefined ? cur.active : (u.active ? 1 : 0), tenant, id
    );
    return this.get(tenant, id);
  },
  remove(tenant: string, id: number): boolean {
    return getDb().prepare("DELETE FROM users WHERE tenant_id = ? AND id = ?").run(tenant, id).changes > 0;
  },
};

const UsersService = {
  create(tenant: string, data: { name?: string; email?: string; role?: string }): UserDTO {
    const name = String(data.name || "").trim();
    const email = String(data.email || "").trim().toLowerCase();
    if (!name) throw new ServiceError(400, "Naam is verplicht");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ServiceError(400, "Geldig e-mailadres is verplicht");
    if (UsersRepo.emailExists(tenant, email)) throw new ServiceError(409, "E-mailadres bestaat al");
    return UsersRepo.create(tenant, { name, email, role: toCanon(data.role) });
  },
  update(tenant: string, id: number, data: { name?: string; role?: string; active?: boolean }): UserDTO {
    const cur = UsersRepo.get(tenant, id);
    if (!cur) throw new ServiceError(404, "Gebruiker niet gevonden");
    // voorkom dat de laatste actieve superadmin wordt gedegradeerd/gedeactiveerd
    const wasSuper = cur.role === "Superadmin";
    const losesSuper = (data.role !== undefined && toCanon(data.role) !== "superadmin") || data.active === false;
    if (wasSuper && cur.active && losesSuper && UsersRepo.countSuperadmins(tenant) <= 1) {
      throw new ServiceError(409, "Dit is de laatste superadmin — niet toegestaan");
    }
    const res = UsersRepo.update(tenant, id, { name: data.name, role: data.role !== undefined ? toCanon(data.role) : undefined, active: data.active });
    return res!;
  },
  remove(tenant: string, id: number): void {
    const cur = UsersRepo.get(tenant, id);
    if (!cur) throw new ServiceError(404, "Gebruiker niet gevonden");
    if (cur.role === "Superadmin" && cur.active && UsersRepo.countSuperadmins(tenant) <= 1) {
      throw new ServiceError(409, "Dit is de laatste superadmin — niet toegestaan");
    }
    UsersRepo.remove(tenant, id);
  },
};

function run(reply: any, fn: () => any) {
  try { return reply.send(fn()); }
  catch (e) {
    if (e instanceof ServiceError) return reply.code(e.status).send({ error: e.message, issues: e.issues });
    reply.log.error(e); return reply.code(500).send({ error: "Interne fout" });
  }
}

export async function usersRoutes(app: FastifyInstance) {
  app.get("/api/users", { preHandler: [authGuard, requireRole("admin")] }, async (req, reply) =>
    run(reply, () => UsersRepo.list(tenantOf(req)))
  );
  app.post("/api/users", { preHandler: [authGuard, requireRole("admin")] }, async (req, reply) =>
    run(reply, () => UsersService.create(tenantOf(req), req.body as any))
  );
  app.put("/api/users/:id", { preHandler: [authGuard, requireRole("admin")] }, async (req, reply) =>
    run(reply, () => UsersService.update(tenantOf(req), Number((req.params as any).id), req.body as any))
  );
  app.delete("/api/users/:id", { preHandler: [authGuard, requireRole("admin")] }, async (req, reply) =>
    run(reply, () => { UsersService.remove(tenantOf(req), Number((req.params as any).id)); return { ok: true }; })
  );
}
