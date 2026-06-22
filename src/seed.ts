import { migrate, getDb } from "./db/database.js";
import { hashPassword } from "./common/auth.js";

migrate();
const db = getDb();
const tenant = "xpo";
const now = new Date().toISOString();

const u = db.prepare("SELECT id FROM users WHERE email = ?").get("admin@xpo.nl");
if (!u) {
  db.prepare(
    "INSERT INTO users (tenant_id, name, email, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(tenant, "Marijn Bos", "admin@xpo.nl", "superadmin", hashPassword("xpo-admin"), now);
  console.log("✓ gebruiker  admin@xpo.nl  /  xpo-admin  (rol: superadmin)");
} else {
  console.log("• gebruiker admin@xpo.nl bestaat al");
}


const team = [
  ["Robert", "robert@xpo.nl", "admin"],
  ["Dennis", "dennis@xpo.nl", "editor"],
  ["Oskar", "oskar@altermedia.nl", "editor"],
];
for (const [name, email, role] of team) {
  const ex = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!ex) {
    db.prepare("INSERT INTO users (tenant_id, name, email, role, password_hash, active, created_at) VALUES (?, ?, ?, ?, NULL, 1, ?)")
      .run(tenant, name, email, role, now);
    console.log(`✓ gebruiker  ${email}  (rol: ${role}, uitgenodigd)`);
  }
}

const p = db.prepare("SELECT id FROM pages WHERE tenant_id = ? AND slug = ?").get(tenant, "smart-mirrors");
if (!p) {
  const blocks = {
    id: "root", type: "core/root", settings: {},
    children: [
      { id: "n1", type: "xpo/hero", settings: { title: "INVITE", subtitle: "Premium smart mirror voor publieke ruimtes.", buttons: [{ label: "Discuss your project", url: "/contact" }, { label: "Explore", url: "/config" }], _style: { bg: "dark", align: "left", pad: 54, maxw: 0 }, _adv: { hideOn: [] } } },
      { id: "n2", type: "xpo/features", settings: { items: [{ t: "Touch & gesture", d: "Volledig interactief oppervlak." }, { t: "Cloud-beheer", d: "Centrale aansturing." }, { t: "Robuust", d: "24/7 publieke ruimtes." }], _style: { bg: "none", align: "left", pad: 28 }, _adv: { hideOn: [] } } },
    ],
  };
  const blocksJson = JSON.stringify(blocks);
  db.prepare(
    "INSERT INTO pages (tenant_id, slug, title, template, locale, status, seo_title, seo_description, blocks, published, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?)"
  ).run(tenant, "smart-mirrors", "Smart mirrors", "Landing", "nl", "Smart mirrors — XPO Screens", "Premium smart mirror displays voor publieke ruimtes.", blocksJson, blocksJson, "admin@xpo.nl", now, now);
  const smId = (db.prepare("SELECT id FROM pages WHERE tenant_id = ? AND slug = 'smart-mirrors'").get(tenant) as { id: number }).id;
  db.prepare(
    "INSERT INTO pages (tenant_id, slug, title, template, locale, status, blocks, parent_id, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)"
  ).run(tenant, "invite-21", "INVITE 21\"", "Landing", "nl", JSON.stringify({ id: "root", type: "core/root", settings: {}, children: [] }), smId, "admin@xpo.nl", now, now);
  console.log("✓ voorbeeldpagina 'smart-mirrors' aangemaakt");
} else {
  console.log("• voorbeeldpagina bestaat al");
}

const shopPg = db.prepare("SELECT id FROM pages WHERE tenant_id = ? AND slug = ?").get(tenant, "winkel");
if (!shopPg) {
  const sb = JSON.stringify({ id: "root", type: "core/root", settings: {}, children: [
    { id: "sh1", type: "xpo/heading", settings: { text: "Webshop", level: "h2", _style: { align: "center", pad: 32 } }, children: [] },
    { id: "sh2", type: "xpo/shop", settings: { limit: 12, _style: { pad: 16, maxw: 1100 } }, children: [] },
  ] });
  db.prepare("INSERT INTO pages (tenant_id, slug, title, template, locale, status, seo_title, seo_description, blocks, published, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?)")
    .run(tenant, "winkel", "Winkel", "Landing", "nl", "Winkel — XPO Screens", "Onze displays online bestellen.", sb, sb, "admin@xpo.nl", now, now);
  console.log("✓ winkelpagina 'winkel' met shop-widget");
}

const cf = db.prepare("SELECT id FROM forms WHERE tenant_id = ? AND slug = ?").get(tenant, "contact");
if (!cf) {
  const fields = [
    { id: "x1", label: "Naam", type: "text", required: true },
    { id: "x2", label: "E-mail", type: "email", required: true },
    { id: "x3", label: "Bericht", type: "textarea", required: false },
  ];
  const info = db.prepare("INSERT INTO forms (tenant_id, name, slug, fields, actions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(tenant, "Contact", "contact", JSON.stringify(fields), JSON.stringify([{ type: "crm", enabled: true, target: "" }]), now, now);
  db.prepare("INSERT INTO form_submissions (form_id, tenant_id, data, created_at) VALUES (?, ?, ?, ?)")
    .run(Number(info.lastInsertRowid), tenant, JSON.stringify("Hotel Zuid — demo aanvraag"), now);
  db.prepare("INSERT INTO crm_leads (id, tenant_id, form_id, name, email, phone, company, message, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("ld_demo", tenant, Number(info.lastInsertRowid), "Sanne de Vries", "sanne@hotelzuid.nl", "", "Hotel Zuid", "Graag een demo van de smart mirror.", "Contact", Date.now());
  console.log("\u2713 formulier 'Contact' (CRM-actie) + 1 inzending + 1 lead");
}


const hasProducts = db.prepare("SELECT COUNT(*) AS n FROM products WHERE tenant_id = ?").get(tenant);
if (!hasProducts || hasProducts.n === 0) {
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const cents = (p: string) => Math.round(parseFloat(p.replace(/[^0-9,.]/g, "").replace(/\./g, "").replace(",", ".")) * 100) || 0;
  const prods: [string, string, number, string, string][] = [
    ["INVITE", "\u20ac2.490", 12, "displays", "Compacte staande display voor entrees en lobby's. Full-HD, 43 inch, met ingebouwde mediaspeler."],
    ["ARCADIA", "\u20ac3.150", 5, "displays", "Dubbelzijdige totem voor drukke passages. 55 inch, hoge helderheid, geschikt voor binnen."],
    ["SPHERIX", "\u20ac1.890", 0, "accessoires", "Modulaire wandmontage-set met kabelmanagement. Past op alle XPO-displays."],
  ];
  for (const [name, price, stock, category, description] of prods)
    db.prepare("INSERT INTO products (tenant_id, name, price, price_cents, slug, stock, image, description, category, attributes, created_at) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)")
      .run(tenant, name, price, cents(price), slugify(name), stock, description, category, name === "INVITE" ? JSON.stringify([{ name: "Formaat", options: ["43 inch", "49 inch", "55 inch"] }, { name: "Montage", options: ["Vloer", "Wand"] }]) : "[]", now);
  const inviteId = (db.prepare("SELECT id FROM products WHERE tenant_id = ? AND slug = 'invite'").get(tenant) as any).id;
  const rvs: [string, number, string][] = [["Mall Utrecht", 5, "Strakke display, plaatsing was zo gebeurd. Beeld is messcherp."], ["Hotel Zuid", 4, "Mooi product, levering duurde iets langer dan verwacht."]];
  for (const [author, rating, body] of rvs)
    db.prepare("INSERT INTO product_reviews (tenant_id, product_id, author, rating, body, status, created_at) VALUES (?, ?, ?, ?, ?, 'approved', ?)").run(tenant, inviteId, author, rating, body, Date.now());
  db.prepare("INSERT INTO coupons (tenant_id, code, type, value, active, created_at) VALUES (?, 'WELKOM10', 'percent', 10, 1, ?)").run(tenant, now);
  const orders = [["#1043", "Mall Utrecht", "\u20ac2.490", "iDEAL", "Betaald"], ["#1042", "Hotel Zuid", "\u20ac6.300", "Visa", "Verzonden"]];
  for (const [ref, customer, amount, method, status] of orders)
    db.prepare("INSERT INTO orders (tenant_id, ref, customer, amount, method, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(tenant, ref, customer, amount, method, status, now);
  console.log("\u2713 3 producten + 2 orders");
}


const hasNav = db.prepare("SELECT tenant_id FROM navigation WHERE tenant_id = ?").get(tenant);
if (!hasNav) {
  const nav = {
    main: [
      { label: "Solutions", to: "", mega: [
        { heading: "Smart mirrors", items: [
          { label: "INVITE", to: "smart-mirrors", desc: "21\" wand" },
          { label: "ARCADIA", to: "arcadia", desc: "32\" vrijstaand" },
          { label: "SPHERIX", to: "spherix", desc: "Rond, 27\"" },
        ] },
        { heading: "Displays", items: [
          { label: "ELYSIUM", to: "elysium", desc: "OLED-totem" },
          { label: "Video walls", to: "video-walls", desc: "Modulair" },
        ] },
        { heading: "Software", items: [
          { label: "XARA", to: "xara", desc: "Content-AI" },
          { label: "Beheerportaal", to: "portaal", desc: "Vloot op afstand" },
        ] },
      ], featured: { kicker: "Nieuw", title: "ELYSIUM 55\"", desc: "OLED-totem met gebaarbediening.", to: "elysium" } },
      { label: "Bedrijf", to: "", children: [
        { label: "Over XPO", to: "over" },
        { label: "Werken bij", to: "werken-bij" },
        { label: "Partners", to: "partners" },
        { label: "Nieuws", to: "nieuws" },
      ] },
      { label: "Cases", to: "cases" },
      { label: "Contact", to: "contact" },
    ],
    footer: [{ label: "Privacy", to: "privacy" }, { label: "Voorwaarden", to: "voorwaarden" }],
  };
  db.prepare("INSERT INTO navigation (tenant_id, json) VALUES (?, ?)").run(tenant, JSON.stringify(nav));
  console.log("\u2713 navigatie (hoofd- en footermenu)");
}


const hasRd = db.prepare("SELECT id FROM redirects WHERE tenant_id = ?").get(tenant);
if (!hasRd) {
  db.prepare("INSERT INTO redirects (id, tenant_id, from_path, to_path, code, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("rd_seed01", tenant, "/oude-product-url", "/site/smart-mirrors", "301", Date.now());
  console.log("\u2713 redirect (/oude-product-url \u2192 /site/smart-mirrors)");
}


const hasTk = db.prepare("SELECT id FROM tickets WHERE tenant_id = ?").get(tenant);
if (!hasTk) {
  const ins = db.prepare("INSERT INTO tickets (id, tenant_id, subject, from_addr, channel, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  ins.run("#2841", tenant, "INVITE start niet op na update", "klant@hotel.nl", "Outlook", "Open", Date.now());
  ins.run("#2840", tenant, "Factuur ARCADIA opnieuw sturen", "inkoop@retail.be", "Portal", "Open", Date.now() - 3600000);
  const ik = db.prepare("INSERT INTO kb_articles (id, tenant_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)");
  ik.run("kb_seed1", tenant, "INVITE opnieuw opstarten", "Houd de aan/uit-knop 10 seconden ingedrukt tot het scherm herstart.", Date.now());
  ik.run("kb_seed2", tenant, "Content beheren op afstand", "Log in op het dashboard, kies de pagina en publiceer je wijziging.", Date.now() - 1000);
  console.log("\u2713 2 tickets + 2 KB-artikelen");
}


const hasCmp = db.prepare("SELECT id FROM campaigns WHERE tenant_id = ?").get(tenant);
if (!hasCmp) {
  const ic = db.prepare("INSERT INTO campaigns (id, tenant_id, name, channel, status, sent, open_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  ic.run("cmp_seed1", tenant, "INVITE lancering", "E-mail", "actief", 2400, 38, Date.now());
  ic.run("cmp_seed2", tenant, "Retargeting Q2", "Automation", "actief", 0, 0, Date.now() - 1000);
  console.log("\u2713 2 campagnes");
}


const hasFg = db.prepare("SELECT id FROM field_groups WHERE tenant_id = ?").get(tenant);
if (!hasFg) {
  const fields = [
    { id: "cf_diag", label: "Schermdiagonaal", type: "text" },
    { id: "cf_res", label: "Resolutie", type: "text" },
    { id: "cf_touch", label: "Touch", type: "toggle" },
  ];
  db.prepare("INSERT INTO field_groups (id, tenant_id, name, location, fields, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("fg_seed1", tenant, "Productdetails", "Sjabloon = Product", JSON.stringify(fields), Date.now());
  console.log("\u2713 veldgroep 'Productdetails' (3 velden)");
}


const hasLang = db.prepare("SELECT code FROM languages WHERE tenant_id = ?").get(tenant);
if (!hasLang) {
  const il = db.prepare("INSERT INTO languages (tenant_id, code, label, flag, path, is_default, enabled, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  il.run(tenant, "nl", "Nederlands", "\uD83C\uDDF3\uD83C\uDDF1", "/", 1, 1, 1);
  il.run(tenant, "en", "English", "\uD83C\uDDEC\uD83C\uDDE7", "/en/", 0, 1, 2);
  il.run(tenant, "de", "Deutsch", "\uD83C\uDDE9\uD83C\uDDEA", "/de/", 0, 0, 3);
  console.log("\u2713 3 talen (nl standaard, en, de)");
}


const hasTpl = db.prepare("SELECT id FROM templates WHERE tenant_id = ?").get(tenant);
if (!hasTpl) {
  const it = db.prepare("INSERT INTO templates (id, tenant_id, name, type, condition, blocks, conditions, status, created_at) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)");
  const now = Date.now();
  const root = (children: any[]) => JSON.stringify({ id: "root", type: "core/root", settings: {}, children });
  const footerBlocks = root([
    { id: "fcta", type: "xpo/cta", settings: { title: "Klaar voor een smart display?", text: "Bespreek je project met XPO Screens.", btn: "Neem contact op", url: "/site/contact", _style: { bg: "accent", align: "center", pad: 48 } }, children: [] },
    { id: "fbar", type: "xpo/text", settings: { body: "© XPO Screens — Houten", _style: { align: "center", pad: 16 } }, children: [] },
  ]);
  const singleBlocks = root([
    { id: "seyebrow", type: "xpo/heading", settings: { text: "Kennisbank", level: "h4", _style: { align: "left", pad: 8, textColor: "#5F8D7A" } }, children: [] },
    { id: "scontent", type: "xpo/post-content", settings: {}, children: [] },
  ]);
  it.run("tpl_header", tenant, "Site header", "header", root([]), JSON.stringify([{ type: "all" }]), "draft", now);
  it.run("tpl_footer", tenant, "Site footer (CTA)", "footer", footerBlocks, JSON.stringify([{ type: "all" }]), "live", now + 1);
  it.run("tpl_single", tenant, "Blog single", "single", singleBlocks, JSON.stringify([{ type: "post-type", value: "post" }]), "live", now + 2);
  it.run("tpl_404", tenant, "404 — niet gevonden", "section", root([]), JSON.stringify([]), "draft", now + 3);
  console.log("\u2713 4 templates (Theme Builder: live footer + single)");
}


const hasTerm = db.prepare("SELECT id FROM terms WHERE tenant_id = ?").get(tenant);
if (!hasTerm) {
  const itm = db.prepare("INSERT INTO terms (id, tenant_id, taxonomy, name, slug, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  itm.run("tm_sol", tenant, "category", "Solutions", "solutions", Date.now());
  itm.run("tm_loc", tenant, "category", "Locations", "locations", Date.now());
  itm.run("tm_img", tenant, "category", "Image database", "image-database", Date.now());
  itm.run("tm_tag1", tenant, "tag", "interactive display", "interactive-display", Date.now());
  const root = JSON.stringify({ id: "root", type: "core/root", settings: {}, children: [
    { id: "h", type: "xpo/heading", settings: { text: "Veiligheid & instructie", level: "h2" }, children: [] },
    { id: "t", type: "xpo/text", settings: { body: "Zo houd je je smart mirror veilig en up-to-date." }, children: [] },
  ] });
  const now2 = new Date().toISOString();
  const ip = db.prepare("INSERT INTO posts (tenant_id, slug, title, excerpt, status, author, locale, blocks, published, seo_schema, created_at, updated_at) VALUES (?, ?, ?, ?, 'published', ?, 'nl', ?, ?, 'BlogPosting', ?, ?)");
  const r1 = ip.run(tenant, "safety-instruction", "Safety & instruction", "Veilig gebruik van je display.", "admin@xpo.nl", root, root, now2, now2);
  const r2 = ip.run(tenant, "visitor-information", "Visitor information", "Wat bezoekers zien op de schermen.", "admin@xpo.nl", root, root, now2, now2);
  const pt = db.prepare("INSERT INTO post_terms (post_id, term_id, tenant_id) VALUES (?, ?, ?)");
  pt.run(Number(r1.lastInsertRowid), "tm_sol", tenant);
  pt.run(Number(r2.lastInsertRowid), "tm_sol", tenant);
  const ic = db.prepare("INSERT INTO comments (id, tenant_id, post_id, author, email, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  ic.run("cm_demo1", tenant, Number(r1.lastInsertRowid), "Robert", "robert@xpo.nl", "Heldere uitleg, dankjewel!", "approved", Date.now());
  ic.run("cm_demo2", tenant, Number(r1.lastInsertRowid), "Bezoeker", "", "Werkt dit ook op de SPHERIX?", "pending", Date.now());
  console.log("\u2713 taxonomie (3 categorieen, 1 tag) + 2 posts + 2 reacties");
}

// ── Alysium AI: kennisitem + assistent aan ──
const aiKb = db.prepare("SELECT id FROM ai_kb WHERE tenant_id = ?").get(tenant);
if (!aiKb) {
  const tnow = Date.now();
  db.prepare("INSERT INTO ai_kb (id, tenant_id, title, body, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("k_levertijd", tenant, "Levertijd en installatie", "Standaard INVITE- en ZENITH-displays leveren we doorgaans binnen 4 tot 6 weken. Maatwerk zoals SERENITY vergt 8 tot 12 weken. Installatie wordt door XPO Screens verzorgd of begeleid.", "/site/contact", tnow, tnow);
  const aiCfg = { assistant: true, name: "Quinty", greeting: "Hoi! Ik ben Quinty, de assistent van XPO Screens. Vraag me over onze displays, levertijden of oplossingen.", fallback: "Daar heb ik nog geen informatie over. Probeer je vraag anders te stellen of neem contact op.", groqKey: "", anthropicKey: "" };
  const row = db.prepare("SELECT json FROM settings WHERE tenant_id = ?").get(tenant) as { json: string } | undefined;
  const cur = row ? JSON.parse(row.json) : {};
  cur.ai = aiCfg;
  db.prepare("INSERT INTO settings (tenant_id, json) VALUES (?, ?) ON CONFLICT(tenant_id) DO UPDATE SET json = excluded.json").run(tenant, JSON.stringify(cur));
  console.log("\u2713 Alysium AI kennisitem + assistent ingeschakeld");
}

console.log("Seed klaar.");