import type { FastifyInstance } from "fastify";
import { renderInvoicePdf } from "./pdf-invoice.js";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";
import { SettingsRepo } from "../settings/settings.routes.js";
import { sendEmailDelivery } from "../mail/mail.routes.js";
import { rateLimit } from "../../common/ratelimit.js";
import { enqueue } from "../../core/queue.js";
import { isHoneypotTripped } from "../../common/security.js";

const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);

// "€1.500" / "1500" / "€1.299,95" → centen
export function parsePrice(str: string): number {
  let s = String(str || "").replace(/[^\d.,]/g, "");
  if (!s) return 0;
  if (s.includes(".") && s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  else if (s.includes(".")) { const parts = s.split("."); if (parts[parts.length - 1].length === 3) s = s.replace(/\./g, ""); }
  const v = parseFloat(s);
  return Number.isFinite(v) ? Math.round(v * 100) : 0;
}
export function fmtCents(cents: number, currency = "EUR"): string {
  const sym = currency === "EUR" ? "€" : currency + " ";
  return sym + (cents / 100).toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type ShopProduct = { id: string; name: string; slug: string; priceCents: number; price: string; stock: number; image: string; description: string; category: string; attributes: { name: string; options: string[] }[] };
function shopProducts(tenant: string): ShopProduct[] {
  return (getDb().prepare("SELECT id, name, price, price_cents, slug, stock, image, description, category, attributes FROM products WHERE tenant_id = ? ORDER BY created_at DESC").all(tenant) as any[])
    .map((r) => { const cents = r.price_cents || parsePrice(r.price); let attrs = []; try { attrs = JSON.parse(r.attributes || "[]"); } catch {} return { id: String(r.id), name: r.name, slug: r.slug || "", priceCents: cents, price: r.price || fmtCents(cents), stock: r.stock, image: r.image || "", description: r.description || "", category: r.category || "", attributes: Array.isArray(attrs) ? attrs : [] }; });
}
function productById(tenant: string, id: string): ShopProduct | undefined {
  return shopProducts(tenant).find((p) => p.id === String(id));
}
export function productBySlug(tenant: string, slug: string): ShopProduct | undefined {
  return shopProducts(tenant).find((p) => p.slug === slug);
}
export function shopCategories(tenant: string): string[] {
  return Array.from(new Set(shopProducts(tenant).map((p) => p.category).filter(Boolean)));
}

// kaarten voor de xpo/shop-widget (gevuld in de render-laag), optioneel gefilterd op categorie
export function shopCards(tenant: string, opts: { limit?: number; category?: string } = {}) {
  const lim = Math.max(1, Math.min(48, Number(opts.limit) || 12));
  let list = shopProducts(tenant);
  if (opts.category) list = list.filter((p) => p.category === opts.category);
  return list.slice(0, lim).map((p) => ({ id: p.id, name: p.name, slug: p.slug, price: p.price, stock: p.stock, soldOut: p.stock <= 0, image: p.image, category: p.category }));
}

type CartItem = { productId: string; qty: number; variant?: any };
const CartRepo = {
  create(tenant: string): string {
    const id = "cart_" + Math.random().toString(36).slice(2, 12); const now = Date.now();
    getDb().prepare("INSERT INTO carts (id, tenant_id, items, created_at, updated_at) VALUES (?, ?, '[]', ?, ?)").run(id, tenant, now, now);
    return id;
  },
  raw(tenant: string, id: string): CartItem[] | null {
    const r = getDb().prepare("SELECT items FROM carts WHERE tenant_id = ? AND id = ?").get(tenant, id) as any;
    return r ? JSON.parse(r.items) : null;
  },
  save(tenant: string, id: string, items: CartItem[]) {
    getDb().prepare("UPDATE carts SET items = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").run(JSON.stringify(items), Date.now(), tenant, id);
  },
  resolve(tenant: string, id: string) {
    const items = this.raw(tenant, id);
    if (items == null) return null;
    const cur = SettingsRepo.get(tenant).shop.currency;
    const lines = items.map((it) => {
      const p = productById(tenant, it.productId);
      const priceCents = p ? p.priceCents : 0;
      return { productId: it.productId, name: p ? p.name : "Onbekend", variant: it.variant || "", qty: it.qty, priceCents, lineCents: priceCents * it.qty, price: fmtCents(priceCents, cur), line: fmtCents(priceCents * it.qty, cur) };
    });
    const totalCents = lines.reduce((a, l) => a + l.lineCents, 0);
    return { id, items: lines, count: lines.reduce((a, l) => a + l.qty, 0), totalCents, total: fmtCents(totalCents, cur) };
  },
};

const PaymentsRepo = {
  create(tenant: string, orderRef: string, amountCents: number, provider: string, checkoutUrl: string, currency: string) {
    const id = "pay_" + Math.random().toString(36).slice(2, 12); const now = Date.now();
    getDb().prepare("INSERT INTO payments (id, tenant_id, order_ref, amount_cents, currency, status, provider, checkout_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)")
      .run(id, tenant, orderRef, amountCents, currency, provider, checkoutUrl, now, now);
    return id;
  },
  get(tenant: string, id: string) { return getDb().prepare("SELECT * FROM payments WHERE tenant_id = ? AND id = ?").get(tenant, id) as any; },
  setStatus(tenant: string, id: string, status: string) { getDb().prepare("UPDATE payments SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?").run(status, Date.now(), tenant, id); },
  list(tenant: string) {
    return (getDb().prepare("SELECT id, order_ref, amount_cents, currency, status, provider, created_at FROM payments WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200").all(tenant) as any[])
      .map((r) => ({ id: r.id, orderRef: r.order_ref, amount: fmtCents(r.amount_cents, r.currency), status: r.status, provider: r.provider, when: r.created_at }));
  },
};

// Mollie-betaling aanmaken (valt terug op lokale checkout als er geen sleutel/netwerk is)
async function createMollie(amountCents: number, description: string, key: string, currency: string, redirect: string): Promise<{ url: string } | null> {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch("https://api.mollie.com/v2/payments", {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({ amount: { currency, value: (amountCents / 100).toFixed(2) }, description, redirectUrl: redirect }),
    });
    clearTimeout(t);
    const j: any = await r.json();
    const url = j?._links?.checkout?.href;
    return url ? { url } : null;
  } catch { return null; }
}

const CouponsRepo = {
  byCode(tenant: string, code: string) { return getDb().prepare("SELECT * FROM coupons WHERE tenant_id = ? AND code = ? AND active = 1").get(tenant, String(code || "").toUpperCase()) as any; },
  list(tenant: string) { return (getDb().prepare("SELECT id, code, type, value, active FROM coupons WHERE tenant_id = ? ORDER BY created_at DESC").all(tenant) as any[]).map((r) => ({ id: String(r.id), code: r.code, type: r.type, value: r.value, active: !!r.active })); },
  create(tenant: string, code: string, type: string, value: number) {
    const info = getDb().prepare("INSERT INTO coupons (tenant_id, code, type, value, active, created_at) VALUES (?, ?, ?, ?, 1, ?)")
      .run(tenant, String(code).toUpperCase().slice(0, 40), type === "fixed" ? "fixed" : "percent", Math.max(0, Math.floor(value)), new Date().toISOString());
    return Number(info.lastInsertRowid);
  },
  setActive(tenant: string, id: number, active: boolean) { getDb().prepare("UPDATE coupons SET active = ? WHERE tenant_id = ? AND id = ?").run(active ? 1 : 0, tenant, id); },
  remove(tenant: string, id: number) { getDb().prepare("DELETE FROM coupons WHERE tenant_id = ? AND id = ?").run(tenant, id); },
};
function applyCoupon(totalCents: number, coupon: any): number {
  if (!coupon) return 0;
  let d = coupon.type === "fixed" ? coupon.value * 100 : Math.round(totalCents * coupon.value / 100);
  return Math.min(Math.max(0, d), totalCents);
}
function vatPart(totalCents: number, rate: number): number {
  if (!rate) return 0;
  return Math.round(totalCents - totalCents / (1 + rate / 100));
}
const ReviewsRepo = {
  approvedFor(tenant: string, productId: number) {
    return (getDb().prepare("SELECT id, author, rating, body, created_at FROM product_reviews WHERE tenant_id = ? AND product_id = ? AND status = 'approved' ORDER BY created_at DESC").all(tenant, productId) as any[])
      .map((r) => ({ id: String(r.id), author: r.author, rating: r.rating, body: r.body, when: r.created_at }));
  },
  statsFor(tenant: string, productId: number) {
    const r = getDb().prepare("SELECT COUNT(*) n, AVG(rating) a FROM product_reviews WHERE tenant_id = ? AND product_id = ? AND status = 'approved'").get(tenant, productId) as any;
    return { count: r.n || 0, average: r.a ? Math.round(r.a * 10) / 10 : 0 };
  },
  add(tenant: string, productId: number, c: { author?: string; rating: number; body: string }) {
    const info = getDb().prepare("INSERT INTO product_reviews (tenant_id, product_id, author, rating, body, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
      .run(tenant, productId, String(c.author || "Anoniem").slice(0, 80), Math.max(1, Math.min(5, Math.floor(c.rating) || 5)), String(c.body || "").slice(0, 3000), Date.now());
    return String(info.lastInsertRowid);
  },
  pending(tenant: string) {
    return (getDb().prepare("SELECT pr.id, pr.product_id, pr.author, pr.rating, pr.body, pr.status, p.name pname FROM product_reviews pr LEFT JOIN products p ON p.id = pr.product_id WHERE pr.tenant_id = ? ORDER BY pr.created_at DESC LIMIT 200").all(tenant) as any[])
      .map((r) => ({ id: String(r.id), productId: String(r.product_id), product: r.pname || "", author: r.author, rating: r.rating, body: r.body, status: r.status }));
  },
  setStatus(tenant: string, id: string, status: string) { getDb().prepare("UPDATE product_reviews SET status = ? WHERE tenant_id = ? AND id = ?").run(status, tenant, id); },
  remove(tenant: string, id: string) { getDb().prepare("DELETE FROM product_reviews WHERE tenant_id = ? AND id = ?").run(tenant, id); },
};
export function productReviews(tenant: string, productId: number) { return { list: ReviewsRepo.approvedFor(tenant, productId), stats: ReviewsRepo.statsFor(tenant, productId) }; }
function shipCost(settings: any, method: string): { name: string; price: number } {
  if (!method) return { name: "", price: 0 };
  const list = (settings.shop.shipping || []) as { name: string; price: number }[];
  return list.find((m) => m.name === method) || { name: "", price: 0 };
}

// ── Webshop-kern: factuurnummering, SKU's, voorraadreservering, BTW/verzending, betaalstatus ──

// Oplopend factuurnummer per tenant per jaar (atomair).
function nextInvoiceNo(tenant: string): string {
  const db = getDb();
  const year = new Date().getFullYear();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT seq FROM order_seq WHERE tenant_id = ? AND year = ?").get(tenant, year) as any;
    const seq = (row?.seq || 0) + 1;
    if (row) db.prepare("UPDATE order_seq SET seq = ? WHERE tenant_id = ? AND year = ?").run(seq, tenant, year);
    else db.prepare("INSERT INTO order_seq (tenant_id, year, seq) VALUES (?, ?, ?)").run(tenant, year, seq);
    db.exec("COMMIT");
    return `${tenant.toUpperCase()}-${year}-${String(seq).padStart(5, "0")}`;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

function matchVariant(variants: any[], sel: any): number {
  if (!Array.isArray(variants) || !variants.length || sel == null) return -1;
  const selSku = typeof sel === "string" ? sel : sel?.sku;
  if (selSku) { const i = variants.findIndex((v) => v.sku === selSku); if (i >= 0) return i; }
  if (sel && typeof sel === "object" && sel.options) {
    return variants.findIndex((v) => v.options && Object.keys(sel.options).every((k) => String(v.options[k]) === String(sel.options[k])));
  }
  return -1;
}
// Prijs/voorraad/gewicht voor een (eventuele) variant, anders productniveau.
function resolveSku(tenant: string, productId: string, sel: any): { priceCents: number; stock: number; weight: number; sku: string; isVariant: boolean } | null {
  const p = getDb().prepare("SELECT price_cents, stock, weight_grams, variants FROM products WHERE tenant_id = ? AND id = ?").get(tenant, productId) as any;
  if (!p) return null;
  const variants = JSON.parse(p.variants || "[]");
  const vi = matchVariant(variants, sel);
  if (vi >= 0) { const v = variants[vi]; return { priceCents: Number(v.priceCents) || p.price_cents, stock: Number(v.stock) || 0, weight: Number(v.weightGrams) || p.weight_grams || 0, sku: v.sku || "", isVariant: true }; }
  return { priceCents: p.price_cents, stock: p.stock, weight: p.weight_grams || 0, sku: "", isVariant: false };
}

// Voorraad reserveren bij checkout — atomair, alles-of-niets, voorkomt oversell (race-safe via BEGIN IMMEDIATE).
function reserveStock(tenant: string, items: any[]): { ok: boolean; error?: string } {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const it of items) {
      const p = db.prepare("SELECT stock, variants FROM products WHERE tenant_id = ? AND id = ?").get(tenant, it.productId) as any;
      if (!p) throw new Error("Product niet gevonden");
      const variants = JSON.parse(p.variants || "[]");
      const vi = matchVariant(variants, it.variant);
      if (vi >= 0) {
        if ((Number(variants[vi].stock) || 0) < it.qty) throw new Error("Onvoldoende voorraad (" + (variants[vi].sku || "variant") + ")");
        variants[vi].stock = Number(variants[vi].stock) - it.qty;
        db.prepare("UPDATE products SET variants = ? WHERE tenant_id = ? AND id = ?").run(JSON.stringify(variants), tenant, it.productId);
      } else {
        const r = db.prepare("UPDATE products SET stock = stock - ? WHERE tenant_id = ? AND id = ? AND stock >= ?").run(it.qty, tenant, it.productId, it.qty);
        if (r.changes !== 1) throw new Error("Onvoldoende voorraad");
      }
    }
    db.exec("COMMIT");
    return { ok: true };
  } catch (e) { db.exec("ROLLBACK"); return { ok: false, error: (e as Error).message }; }
}
// Voorraad vrijgeven (bij annulering/verlopen/refund).
function releaseStock(tenant: string, items: any[]): void {
  const db = getDb();
  for (const it of items) {
    const p = db.prepare("SELECT variants FROM products WHERE tenant_id = ? AND id = ?").get(tenant, it.productId) as any;
    if (!p) continue;
    const variants = JSON.parse(p.variants || "[]");
    const vi = matchVariant(variants, it.variant);
    if (vi >= 0) { variants[vi].stock = (Number(variants[vi].stock) || 0) + it.qty; db.prepare("UPDATE products SET variants = ? WHERE tenant_id = ? AND id = ?").run(JSON.stringify(variants), tenant, it.productId); }
    else db.prepare("UPDATE products SET stock = stock + ? WHERE tenant_id = ? AND id = ?").run(it.qty, tenant, it.productId);
  }
}

// BTW per land (EU-OSS): vatRates-map overschrijft het vlakke tarief.
function vatRateFor(settings: any, country: string): number {
  const rates = settings.shop.vatRates || {};
  if (country && rates[country] != null) return Number(rates[country]);
  return settings.shop.vatRate || 0;
}
// Verzendkosten: zone op land + gewichtstaffel; anders de vlakke methode.
function shipCostFor(settings: any, country: string, weightGrams: number, method: string): { name: string; price: number } {
  const zones = settings.shop.zones || [];
  for (const z of zones) {
    if (Array.isArray(z.countries) && z.countries.includes(country)) {
      const tiers = (z.tiers || []).slice().sort((a: any, b: any) => a.maxWeight - b.maxWeight);
      const tier = tiers.find((t: any) => weightGrams <= t.maxWeight) || tiers[tiers.length - 1];
      if (tier) return { name: z.name || ("Zone " + country), price: Math.max(0, Math.floor(tier.price)) };
    }
  }
  return shipCost(settings, method);
}

// Idempotente betaalstatus-overgang (Mollie-webhook + lokale confirm gebruiken dit).
function applyPaymentStatus(tenant: string, payId: string, status: string): { changed: boolean; status: string } {
  const db = getDb();
  const pay = PaymentsRepo.get(tenant, payId);
  if (!pay) return { changed: false, status: "unknown" };
  const order = db.prepare("SELECT * FROM orders WHERE tenant_id = ? AND payment_id = ?").get(tenant, payId) as any;
  const terminal = new Set(["paid", "failed", "expired", "canceled", "refunded"]);
  if (terminal.has(pay.status)) return { changed: false, status: pay.status }; // idempotent: al afgehandeld
  if (status === "paid") {
    PaymentsRepo.setStatus(tenant, payId, "paid");
    if (order) {
      const inv = order.invoice_no || nextInvoiceNo(tenant);
      db.prepare("UPDATE orders SET status = 'paid', invoice_no = ?, paid_at = ? WHERE tenant_id = ? AND payment_id = ?").run(inv, Date.now(), tenant, payId);
      if (order.email) enqueue(tenant, "email", { to: order.email, body: { form: "Bestelbevestiging " + order.ref, data: { factuur: inv, bestelling: order.ref, bedrag: order.amount, status: "betaald" } } });
    }
    return { changed: true, status: "paid" };
  }
  if (status === "failed" || status === "expired" || status === "canceled") {
    PaymentsRepo.setStatus(tenant, payId, status);
    if (order) { db.prepare("UPDATE orders SET status = ? WHERE tenant_id = ? AND payment_id = ?").run(status, tenant, payId); try { releaseStock(tenant, JSON.parse(order.items || "[]")); } catch { /* */ } }
    return { changed: true, status };
  }
  return { changed: false, status: pay.status };
}

// Mollie-betaalstatus ophalen (live; drop-in zodra de sleutel gezet is).
async function fetchMollieStatus(payId: string, key: string): Promise<string | null> {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch("https://api.mollie.com/v2/payments/" + encodeURIComponent(payId), { headers: { authorization: "Bearer " + key }, signal: ctrl.signal });
    clearTimeout(t);
    const j: any = await r.json();
    return j?.status || null;
  } catch { return null; }
}

export async function shopRoutes(app: FastifyInstance) {
  // ── winkelwagen ──
  app.post("/api/cart", async (req, reply) => reply.send(CartRepo.resolve(tenantOf(req), CartRepo.create(tenantOf(req)))));
  app.get("/api/cart/:id", async (req, reply) => {
    const c = CartRepo.resolve(tenantOf(req), String((req.params as any).id));
    if (!c) return reply.code(404).send({ error: "Winkelwagen niet gevonden" });
    return reply.send(c);
  });
  app.post("/api/cart/:id/items", async (req, reply) => {
    const tenant = tenantOf(req); const id = String((req.params as any).id);
    const items = CartRepo.raw(tenant, id); if (items == null) return reply.code(404).send({ error: "Winkelwagen niet gevonden" });
    const productId = clip((req.body as any)?.productId, 40);
    const qty = Math.max(1, Math.min(99, Math.floor(Number((req.body as any)?.qty) || 1)));
    if (!productById(tenant, productId)) return reply.code(400).send({ error: "Onbekend product" });
    const rawVar = (req.body as any)?.variant;
    const variant: any = (rawVar && typeof rawVar === "object")
      ? { sku: clip(rawVar.sku, 60), options: (rawVar.options && typeof rawVar.options === "object") ? rawVar.options : undefined }
      : clip(rawVar, 120);
    const ex = items.find((x) => x.productId === productId);
    if (ex) { ex.qty = Math.min(99, ex.qty + qty); if (variant) ex.variant = variant; } else items.push({ productId, qty, variant });
    CartRepo.save(tenant, id, items);
    return reply.send(CartRepo.resolve(tenant, id));
  });
  app.put("/api/cart/:id/items/:pid", async (req, reply) => {
    const tenant = tenantOf(req); const id = String((req.params as any).id);
    const items = CartRepo.raw(tenant, id); if (items == null) return reply.code(404).send({ error: "Winkelwagen niet gevonden" });
    const pid = String((req.params as any).pid);
    const qty = Math.max(0, Math.min(99, Math.floor(Number((req.body as any)?.qty) || 0)));
    const next = qty === 0 ? items.filter((x) => x.productId !== pid) : items.map((x) => (x.productId === pid ? { ...x, qty } : x));
    CartRepo.save(tenant, id, next);
    return reply.send(CartRepo.resolve(tenant, id));
  });
  app.delete("/api/cart/:id/items/:pid", async (req, reply) => {
    const tenant = tenantOf(req); const id = String((req.params as any).id);
    const items = CartRepo.raw(tenant, id); if (items == null) return reply.code(404).send({ error: "Winkelwagen niet gevonden" });
    CartRepo.save(tenant, id, items.filter((x) => x.productId !== String((req.params as any).pid)));
    return reply.send(CartRepo.resolve(tenant, id));
  });

  // ── checkout → order + betaling ──
  app.post("/api/checkout", async (req, reply) => {
    const tenant = tenantOf(req);
    const cartId = clip((req.body as any)?.cartId, 40);
    const cust = (req.body as any)?.customer || {};
    const name = clip(cust.name, 120); const email = clip(cust.email, 160);
    const cart = CartRepo.resolve(tenant, cartId);
    if (!cart) return reply.code(404).send({ error: "Winkelwagen niet gevonden" });
    if (!cart.items.length) return reply.code(400).send({ error: "Winkelwagen is leeg" });
    if (!name || !email) return reply.code(400).send({ error: "Naam en e-mail zijn verplicht", issues: [{ path: "customer", message: "Naam en e-mail verplicht" }] });
    const settings = SettingsRepo.get(tenant);
    const currency = settings.shop.currency;
    const country = clip(cust.country || (req.body as any)?.country, 2).toUpperCase();
    const vatRate = vatRateFor(settings, country);
    // variant-bewuste subtotaal + totaalgewicht
    let subtotalCents = 0; let weightGrams = 0;
    for (const it of cart.items) { const sku = resolveSku(tenant, it.productId, it.variant); if (sku) { subtotalCents += sku.priceCents * it.qty; weightGrams += sku.weight * it.qty; } }
    if (!subtotalCents) subtotalCents = cart.totalCents;
    // kortingscode toepassen
    const couponCode = clip((req.body as any)?.coupon, 40);
    const coupon = couponCode ? CouponsRepo.byCode(tenant, couponCode) : null;
    const discount = applyCoupon(subtotalCents, coupon);
    const ship = shipCostFor(settings, country, weightGrams, clip((req.body as any)?.shipping, 80));
    const finalCents = subtotalCents - discount + ship.price;
    const vat = vatPart(finalCents, vatRate);
    const ref = "ORD-" + Date.now().toString(36).toUpperCase();
    // voorraad reserveren (oversell-bescherming) — vóór het aanmaken van de betaling
    const rsv = reserveStock(tenant, cart.items);
    if (!rsv.ok) return reply.code(409).send({ error: rsv.error || "Onvoldoende voorraad", code: "out_of_stock" });
    // betaling: Mollie indien sleutel, anders lokale (gesimuleerde) checkout
    let provider = "local"; let url = "";
    const payId = PaymentsRepo.create(tenant, ref, finalCents, provider, "", currency);
    if (settings.shop.mollieKey) {
      const m = await createMollie(finalCents, "Bestelling " + ref, settings.shop.mollieKey, currency, "/pay/return/" + payId);
      if (m) { provider = "mollie"; url = m.url; getDb().prepare("UPDATE payments SET provider='mollie', checkout_url=? WHERE id=?").run(url, payId); }
    }
    if (!url) url = "/pay/" + payId; // lokale betaalpagina-stub
    getDb().prepare("INSERT INTO orders (tenant_id, ref, customer, email, amount, amount_cents, items, method, payment_id, status, country, vat_cents, ship_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)")
      .run(tenant, ref, name, email, fmtCents(finalCents, currency), finalCents, JSON.stringify(cart.items), provider, payId, country, vat, ship.price, new Date().toISOString());
    return reply.send({ orderRef: ref, paymentId: payId, provider, checkoutUrl: url, subtotal: fmtCents(subtotalCents, currency), discount: fmtCents(discount, currency), discountCents: discount, coupon: coupon ? coupon.code : null, shipping: { name: ship.name, price: fmtCents(ship.price, currency), priceCents: ship.price }, vat: fmtCents(vat, currency), vatRate, total: fmtCents(finalCents, currency), totalCents: finalCents, status: "open" });
  });

  // betaling bevestigen (lokale stub; in productie loopt dit via de Mollie-webhook)
  app.post("/api/payments/:id/confirm", async (req, reply) => {
    const tenant = tenantOf(req);
    const pay = PaymentsRepo.get(tenant, String((req.params as any).id));
    if (!pay) return reply.code(404).send({ error: "Betaling niet gevonden" });
    const r = applyPaymentStatus(tenant, pay.id, "paid");
    return reply.send({ ok: true, status: r.status });
  });

  // Mollie-webhook: idempotent, haalt de echte status op (live) of accepteert een status (lokaal/test).
  app.post("/api/webhooks/mollie", async (req, reply) => {
    const tenant = tenantOf(req);
    const payId = clip((req.body as any)?.id, 60);
    if (!payId) return reply.code(400).send({ error: "id ontbreekt" });
    const pay = PaymentsRepo.get(tenant, payId);
    if (!pay) return reply.code(404).send({ error: "Betaling niet gevonden" });
    const settings = SettingsRepo.get(tenant);
    let status = settings.shop.mollieKey ? (await fetchMollieStatus(payId, settings.shop.mollieKey)) : clip((req.body as any)?.status, 20);
    if (!status) status = clip((req.body as any)?.status, 20);
    const r = applyPaymentStatus(tenant, payId, String(status || ""));
    return reply.send({ ok: true, status: r.status, changed: r.changed });
  });
  // kortingscode valideren (publiek)
  app.post("/api/coupons/validate", async (req, reply) => {
    const c = CouponsRepo.byCode(tenantOf(req), clip((req.body as any)?.code, 40));
    if (!c) return reply.send({ valid: false });
    return reply.send({ valid: true, code: c.code, type: c.type, value: c.value });
  });
  // kortingscodes beheren
  app.get("/api/coupons", { preHandler: authGuard }, async (req, reply) => reply.send(CouponsRepo.list(tenantOf(req))));
  app.post("/api/coupons", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const code = clip(b.code, 40);
    if (!code) return reply.code(400).send({ error: "Code is verplicht", issues: [{ path: "code", message: "Code is verplicht" }] });
    if (CouponsRepo.byCode(tenantOf(req), code)) return reply.code(409).send({ error: "Code bestaat al" });
    const id = CouponsRepo.create(tenantOf(req), code, b.type === "fixed" ? "fixed" : "percent", Number(b.value) || 0);
    return reply.code(201).send({ id: String(id), code: code.toUpperCase(), type: b.type === "fixed" ? "fixed" : "percent", value: Math.max(0, Math.floor(Number(b.value) || 0)), active: true });
  });
  app.patch("/api/coupons/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    CouponsRepo.setActive(tenantOf(req), Number((req.params as any).id), !!(req.body as any)?.active);
    return reply.send({ ok: true });
  });
  app.delete("/api/coupons/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    CouponsRepo.remove(tenantOf(req), Number((req.params as any).id));
    return reply.send({ ok: true });
  });

  // verzendmethoden (publiek leesbaar voor de checkout)
  app.get("/api/shipping", async (req, reply) => reply.send(SettingsRepo.get(tenantOf(req)).shop.shipping || []));

  // productreviews — publiek plaatsen + ophalen
  app.post("/api/products/:id/reviews", async (req, reply) => {
    if (isHoneypotTripped(req.body)) return reply.code(400).send({ error: "Verzoek geweigerd" });
    const rl = rateLimit(`${req.ip}:review`, 5, 60 * 1000);
    if (!rl.ok) { reply.header("Retry-After", String(rl.retryAfter)); return reply.code(429).send({ error: "Te veel reviews. Probeer het later opnieuw." }); }
    const body = clip((req.body as any)?.body, 3000);
    const rating = Math.max(1, Math.min(5, Math.floor(Number((req.body as any)?.rating) || 0)));
    if (body.length < 2) return reply.code(400).send({ error: "Review is te kort" });
    if (!rating) return reply.code(400).send({ error: "Geef een beoordeling (1-5)" });
    const tenant = tenantOf(req);
    const id = ReviewsRepo.add(tenant, Number((req.params as any).id), { author: (req.body as any)?.author, rating, body });
    enqueue(tenant, "email", { to: SettingsRepo.get(tenant).mail.from || "admin@xpo.nl", body: { form: "Nieuwe productreview (moderatie vereist)", data: { rating, review: body } } });
    return reply.send({ ok: true, id, status: "pending" });
  });
  app.get("/api/products/:id/reviews", async (req, reply) => reply.send(productReviews(tenantOf(req), Number((req.params as any).id))));
  // reviewmoderatie
  app.get("/api/reviews", { preHandler: authGuard }, async (req, reply) => reply.send(ReviewsRepo.pending(tenantOf(req))));
  app.post("/api/reviews/:id/:action", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const { id, action } = req.params as any;
    if (action === "approve") ReviewsRepo.setStatus(tenantOf(req), id, "approved");
    else if (action === "reject") ReviewsRepo.setStatus(tenantOf(req), id, "rejected");
    else if (action === "delete") ReviewsRepo.remove(tenantOf(req), id);
    return reply.send({ ok: true });
  });

  // orderdetail (uitklapbaar in de admin)
  app.get("/api/orders/:ref", { preHandler: authGuard }, async (req, reply) => {
    const o = getDb().prepare("SELECT ref, customer, email, amount, items, method, status, invoice_no, country, vat_cents, ship_cents, created_at FROM orders WHERE tenant_id = ? AND ref = ?").get(tenantOf(req), (req.params as any).ref) as any;
    if (!o) return reply.code(404).send({ error: "Order niet gevonden" });
    let items: any[] = []; try { items = JSON.parse(o.items || "[]"); } catch {}
    return reply.send({ ref: o.ref, customer: o.customer, email: o.email, amount: o.amount, method: o.method, status: o.status, invoiceNo: o.invoice_no, country: o.country, vatCents: o.vat_cents, shipCents: o.ship_cents, createdAt: o.created_at, items });
  });
  // terugbetaling
  app.post("/api/orders/:ref/refund", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const tenant = tenantOf(req);
    const o = getDb().prepare("SELECT items, status FROM orders WHERE tenant_id = ? AND ref = ?").get(tenant, (req.params as any).ref) as any;
    if (!o) return reply.code(404).send({ error: "Order niet gevonden" });
    if (o.status === "refunded") return reply.send({ ok: true, status: "refunded" }); // idempotent
    getDb().prepare("UPDATE orders SET status = 'refunded' WHERE tenant_id = ? AND ref = ?").run(tenant, (req.params as any).ref);
    if ((req.body as any)?.restock) { try { releaseStock(tenant, JSON.parse(o.items || "[]")); } catch { /* */ } }
    return reply.send({ ok: true, status: "refunded" });
  });

  // BTW-conforme factuur-PDF voor een betaalde order
  app.get("/api/orders/:ref/invoice", { preHandler: authGuard }, async (req, reply) => {
    const tenant = tenantOf(req);
    const o = getDb().prepare("SELECT * FROM orders WHERE tenant_id = ? AND ref = ?").get(tenant, (req.params as any).ref) as any;
    if (!o) return reply.code(404).send({ error: "Order niet gevonden" });
    const settings = SettingsRepo.get(tenant);
    const cur = o.currency || settings.shop.currency;
    const invoiceNo = o.invoice_no || ("CONCEPT-" + o.ref);
    const lines = JSON.parse(o.items || "[]").map((it: any) => {
      const sku = resolveSku(tenant, it.productId, it.variant);
      const unit = sku ? sku.priceCents : 0;
      const prod = getDb().prepare("SELECT name FROM products WHERE tenant_id = ? AND id = ?").get(tenant, it.productId) as any;
      const label = (prod?.name || "Product") + (it.variant ? " — " + (typeof it.variant === "string" ? it.variant : (sku?.sku || JSON.stringify(it.variant))) : "");
      return { desc: label, qty: it.qty, unit: fmtCents(unit, cur), total: fmtCents(unit * it.qty, cur) };
    });
    const subtotalCents = Math.max(0, o.amount_cents - (o.ship_cents || 0));
    const data = {
      invoiceNo, orderRef: o.ref, date: String(o.created_at).slice(0, 10),
      seller: { name: settings.site?.title || "XPO Screens", line2: "Houten, Nederland", vatId: settings.shop?.vatId || "" },
      customer: { name: o.customer, email: o.email, country: o.country },
      currency: cur, lines,
      subtotal: fmtCents(subtotalCents, cur), shipping: fmtCents(o.ship_cents || 0, cur),
      vat: fmtCents(o.vat_cents || 0, cur), vatRate: vatRateFor(settings, o.country), total: fmtCents(o.amount_cents, cur),
    };
    const pdf = renderInvoicePdf(data);
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `inline; filename="factuur-${invoiceNo}.pdf"`);
    return reply.send(pdf);
  });
  // klantenlijst (geaggregeerd uit orders)
  app.get("/api/customers", { preHandler: authGuard }, async (req, reply) => {
    const rows = getDb().prepare("SELECT email, MAX(customer) name, COUNT(*) orders, SUM(amount_cents) total_cents, MAX(created_at) last FROM orders WHERE tenant_id = ? AND email != '' GROUP BY email ORDER BY total_cents DESC").all(tenantOf(req)) as any[];
    const cur = SettingsRepo.get(tenantOf(req)).shop.currency;
    return reply.send(rows.map((r) => ({ email: r.email, name: r.name || r.email, orders: r.orders, total: fmtCents(r.total_cents || 0, cur), lastOrder: r.last })));
  });
  app.get("/api/payments/:id", async (req, reply) => {
    const pay = PaymentsRepo.get(tenantOf(req), String((req.params as any).id));
    if (!pay) return reply.code(404).send({ error: "Betaling niet gevonden" });
    return reply.send({ id: pay.id, orderRef: pay.order_ref, amount: fmtCents(pay.amount_cents, pay.currency), status: pay.status, provider: pay.provider, checkoutUrl: pay.checkout_url });
  });
  app.get("/api/payments", { preHandler: authGuard }, async (req, reply) => reply.send(PaymentsRepo.list(tenantOf(req))));

  // lokale betaalpagina-stub (vervangt Mollie als er geen sleutel is)
  app.get("/pay/:id", async (req, reply) => {
    const tenant = tenantOf(req);
    const pay = PaymentsRepo.get(tenant, String((req.params as any).id));
    reply.type("text/html");
    if (!pay) return reply.code(404).send("<h1>Betaling niet gevonden</h1>");
    const acc = "#5F8D7A";
    return reply.send(`<!doctype html><meta charset="utf-8"><title>Betalen</title><body style="font-family:system-ui;background:#0B0E11;color:#EAEEF2;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:380px"><h1 style="font-weight:600">Betaling ${pay.status === "paid" ? "voltooid" : "gesimuleerd"}</h1><p style="opacity:.7">Bestelling ${pay.order_ref} · ${fmtCents(pay.amount_cents, pay.currency)}</p><p style="opacity:.5;font-size:13px">Dit is een lokale teststub. Met een Mollie-sleutel wordt hier de echte betaalpagina geopend.</p>${pay.status === "paid" ? "" : `<button onclick="fetch('/api/payments/${pay.id}/confirm',{method:'POST'}).then(()=>location.reload())" style="background:${acc};color:#fff;border:0;border-radius:10px;padding:12px 20px;font-size:15px;cursor:pointer">Betaling bevestigen</button>`}</div></body>`);
  });
}
