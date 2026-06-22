import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole, requirePermission } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";
import { ServiceError } from "../pages/pages.service.js";
import { parsePrice } from "../shop/shop.routes.js";

export type ProductDTO = { id: string; name: string; price: string; stock: number; status: string; slug: string; image: string; description: string; category: string; attributes: { name: string; options: string[] }[]; variants: any[]; weightGrams: number };
export type OrderDTO = { id: string; customer: string; amount: string; method: string; status: string };

type ProductRow = { id: number; name: string; price: string; stock: number; slug: string; image: string; description: string; category: string; attributes: string; variants: string; weight_grams: number };
type OrderRow = { id: number; ref: string; customer: string; amount: string; method: string; status: string };

const statusOf = (stock: number) => (stock > 0 ? "actief" : "uitverkocht");
const productDto = (r: ProductRow): ProductDTO => ({ id: String(r.id), name: r.name, price: r.price, stock: r.stock, status: statusOf(r.stock), slug: r.slug || "", image: r.image || "", description: r.description || "", category: r.category || "", attributes: parseAttrs(r.attributes), variants: (() => { try { return JSON.parse(r.variants || "[]"); } catch { return []; } })(), weightGrams: r.weight_grams || 0 });
const orderDto = (r: OrderRow): OrderDTO => ({ id: r.ref, customer: r.customer, amount: r.amount, method: r.method, status: r.status });
const slugify = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "product";

function parseAttrs(j: string): { name: string; options: string[] }[] { try { const a = JSON.parse(j || "[]"); return Array.isArray(a) ? a.filter((x) => x && x.name).map((x) => ({ name: String(x.name).slice(0, 60), options: Array.isArray(x.options) ? x.options.slice(0, 30).map((o: any) => String(o).slice(0, 60)) : [] })) : []; } catch { return []; } }
const PSEL = "SELECT id, name, price, stock, slug, image, description, category, attributes, variants, weight_grams FROM products";
const ProductsRepo = {
  list(tenant: string): ProductDTO[] {
    return (getDb().prepare(`${PSEL} WHERE tenant_id = ? ORDER BY created_at DESC`).all(tenant) as unknown as ProductRow[]).map(productDto);
  },
  get(tenant: string, id: number): ProductDTO | null {
    const r = getDb().prepare(`${PSEL} WHERE tenant_id = ? AND id = ?`).get(tenant, id) as unknown as ProductRow | undefined;
    return r ? productDto(r) : null;
  },
  create(tenant: string, d: { name: string; price: string; stock: number; image?: string; description?: string; category?: string; slug?: string; attributes?: any; variants?: any; weightGrams?: number }): ProductDTO {
    const slug = slugify(d.slug || d.name);
    const cents = parsePrice(d.price);
    const info = getDb().prepare("INSERT INTO products (tenant_id, name, price, price_cents, slug, stock, image, description, category, attributes, variants, weight_grams, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(tenant, d.name, d.price, cents, slug, d.stock, d.image || "", d.description || "", d.category || "", JSON.stringify(d.attributes || []), JSON.stringify(d.variants || []), Math.max(0, Math.floor(Number(d.weightGrams) || 0)), new Date().toISOString());
    return this.get(tenant, Number(info.lastInsertRowid))!;
  },
  update(tenant: string, id: number, d: { name: string; price: string; stock: number; image?: string; description?: string; category?: string; slug?: string; attributes?: any; variants?: any; weightGrams?: number }): ProductDTO | null {
    const cents = parsePrice(d.price);
    const slug = slugify(d.slug || d.name);
    getDb().prepare("UPDATE products SET name = ?, price = ?, price_cents = ?, slug = ?, stock = ?, image = ?, description = ?, category = ?, attributes = ?, variants = ?, weight_grams = ? WHERE tenant_id = ? AND id = ?")
      .run(d.name, d.price, cents, slug, d.stock, d.image || "", d.description || "", d.category || "", JSON.stringify(d.attributes || []), JSON.stringify(d.variants || []), Math.max(0, Math.floor(Number(d.weightGrams) || 0)), tenant, id);
    return this.get(tenant, id);
  },
  remove(tenant: string, id: number): boolean {
    return getDb().prepare("DELETE FROM products WHERE tenant_id = ? AND id = ?").run(tenant, id).changes > 0;
  },
};

const OrdersRepo = {
  list(tenant: string): OrderDTO[] {
    return (getDb().prepare("SELECT id, ref, customer, amount, method, status FROM orders WHERE tenant_id = ? ORDER BY created_at DESC").all(tenant) as unknown as OrderRow[]).map(orderDto);
  },
};

const CommerceService = {
  listProducts: (t: string) => ProductsRepo.list(t),
  listOrders: (t: string) => OrdersRepo.list(t),
  createProduct(tenant: string, body: any): ProductDTO {
    const name = String(body.name || "").trim();
    if (!name) throw new ServiceError(400, "Naam is verplicht");
    const stock = Math.max(0, Math.floor(Number(body.stock) || 0));
    return ProductsRepo.create(tenant, { name, price: String(body.price || "€0"), stock, image: body.image, description: body.description, category: body.category, slug: body.slug, attributes: body.attributes, variants: body.variants, weightGrams: body.weightGrams });
  },
  updateProduct(tenant: string, id: number, body: any): ProductDTO {
    const cur = ProductsRepo.get(tenant, id);
    if (!cur) throw new ServiceError(404, "Product niet gevonden");
    const stock = body.stock === undefined ? cur.stock : Math.max(0, Math.floor(Number(body.stock) || 0));
    return ProductsRepo.update(tenant, id, { name: String(body.name ?? cur.name), price: String(body.price ?? cur.price), stock, image: body.image ?? cur.image, description: body.description ?? cur.description, category: body.category ?? cur.category, slug: body.slug ?? cur.slug, attributes: body.attributes ?? cur.attributes, variants: body.variants ?? (cur as any).variants, weightGrams: body.weightGrams ?? (cur as any).weightGrams })!;
  },
  removeProduct(tenant: string, id: number): void {
    if (!ProductsRepo.remove(tenant, id)) throw new ServiceError(404, "Product niet gevonden");
  },
};

function run(reply: any, fn: () => any) {
  try { return reply.send(fn()); }
  catch (e) {
    if (e instanceof ServiceError) return reply.code(e.status).send({ error: e.message, issues: e.issues });
    reply.log.error(e); return reply.code(500).send({ error: "Interne fout" });
  }
}

export async function commerceRoutes(app: FastifyInstance) {
  app.get("/api/products", { preHandler: authGuard }, async (req, reply) =>
    run(reply, () => CommerceService.listProducts(tenantOf(req)))
  );
  app.post("/api/products", { preHandler: [authGuard, requirePermission("shop")] }, async (req, reply) =>
    run(reply, () => CommerceService.createProduct(tenantOf(req), req.body as any))
  );
  app.put("/api/products/:id", { preHandler: [authGuard, requirePermission("shop")] }, async (req, reply) =>
    run(reply, () => CommerceService.updateProduct(tenantOf(req), Number((req.params as any).id), req.body as any))
  );
  app.delete("/api/products/:id", { preHandler: [authGuard, requirePermission("shop")] }, async (req, reply) =>
    run(reply, () => { CommerceService.removeProduct(tenantOf(req), Number((req.params as any).id)); return { ok: true }; })
  );
  app.get("/api/orders", { preHandler: authGuard }, async (req, reply) =>
    run(reply, () => CommerceService.listOrders(tenantOf(req)))
  );
}
