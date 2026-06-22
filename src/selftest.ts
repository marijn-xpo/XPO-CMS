import { buildApp } from "./app.js";
import { hashPassword, verifyPassword, needsRehash, passwordIssue, hasPermission } from "./common/auth.js";
import { resetLockout } from "./common/lockout.js";
import { getDb } from "./db/database.js";
import { cacheStats } from "./core/render-cache.js";
import { getAsyncDb } from "./db/async-db.js";

import { existsSync, readFileSync } from "node:fs";

import { randomBytes as _rb, scryptSync as _scrypt } from "node:crypto";

import { appliedMigrations, migrate, toPostgres, dbInfo } from "./db/database.js";
import { resolveTenant, isKnownTenant } from "./common/tenant.js";
import { loadedPlugins, listPaymentProviders, addFilter, applyFilters } from "./core/plugins.js";
import { widgetTypes, collectStyleCss, renderNode } from "./engine/engine.js";
import { enqueue, processJobsNow, registerJobHandler, queueStats } from "./core/queue.js";

import { buildAuthorizeUrl, mapGroupsToRole, ssoUpsertUser } from "./modules/auth/sso.routes.js";
import { resetRateLimit } from "./common/ratelimit.js";
import { postArchive, authorSlug } from "./modules/posts/posts.routes.js";

const app = await buildApp();
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean) => { cond ? pass++ : fail++; console.log((cond ? "  \u2713 " : "  \u2717 ") + label); };

// login
const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@xpo.nl", password: "xpo-admin" } });
ok("login met juiste gegevens => 200", login.statusCode === 200);
const token = (login.json() as any).token as string;
const auth = { authorization: "Bearer " + token };

ok("login fout wachtwoord => 401", (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@xpo.nl", password: "fout" } })).statusCode === 401);
ok("lijst zonder token => 401", (await app.inject({ method: "GET", url: "/api/pages" })).statusCode === 401);

// opruimen van eerdere testpaginas (idempotent)
const pre = (await app.inject({ method: "GET", url: "/api/pages", headers: auth })).json() as any[];
for (const slug of ["arcadia-test", "xss-test"]) {
  const f = pre.find((p) => p.slug === slug);
  if (f) await app.inject({ method: "DELETE", url: "/api/pages/" + f.id, headers: auth });
}

const list = await app.inject({ method: "GET", url: "/api/pages", headers: auth });
ok("lijst met token => 200", list.statusCode === 200);
ok("seed-pagina 'smart-mirrors' aanwezig", (list.json() as any[]).some((p) => p.slug === "smart-mirrors"));

// validatie weigert lege hero-titel
const bad = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "kapot", title: "x", blocks: { id: "root", type: "core/root", settings: {}, children: [{ id: "a", type: "xpo/hero", settings: { title: "" } }] } } });
ok("validatie weigert lege titel => 400 + issues", bad.statusCode === 400 && Array.isArray((bad.json() as any).issues) && (bad.json() as any).issues.length > 0);

// echte aanmaak
const created = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "arcadia-test", title: "ARCADIA", blocks: { id: "root", type: "core/root", settings: {}, children: [{ id: "h", type: "xpo/hero", settings: { title: "ARCADIA", subtitle: "32 inch.", buttons: [{ label: "Bekijk", url: "/a" }], _style: { bg: "dark" } } }] } } });
ok("aanmaken => 200", created.statusCode === 200);
const id = (created.json() as any).id;

// publiceren
const pub = await app.inject({ method: "POST", url: "/api/pages/" + id + "/publish", headers: auth });
ok("publiceren => 200, status=published", pub.statusCode === 200 && (pub.json() as any).status === "published");

// publieke server-side render
const site = await app.inject({ method: "GET", url: "/site/arcadia-test" });
ok("publieke render 200 + bevat titel", site.statusCode === 200 && site.body.includes("ARCADIA"));

// XSS veilig in publieke render
const xss = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "xss-test", title: "XSS", blocks: { id: "root", type: "core/root", settings: {}, children: [{ id: "h", type: "xpo/heading", settings: { text: "<script>alert(1)</script>", level: "h2" } }] } } });
await app.inject({ method: "POST", url: "/api/pages/" + (xss.json() as any).id + "/publish", headers: auth });
const xr = await app.inject({ method: "GET", url: "/site/xss-test" });
ok("XSS: geen rauwe <script>alert in render", !xr.body.includes("<script>alert"));
ok("XSS: ge-escaped als &lt;script&gt;", xr.body.includes("&lt;script&gt;"));

// 404 voor onbekende slug
ok("onbekende slug => 404", (await app.inject({ method: "GET", url: "/site/bestaat-niet" })).statusCode === 404);

// ---- media ----
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const up = await app.inject({ method: "POST", url: "/api/media", headers: auth, payload: { name: "pixel.png", dataUrl: PNG } });
ok("media-upload => 200", up.statusCode === 200);
const mediaItem = up.json() as any;
ok("media: src is /uploads-pad, mime/size gevuld", typeof mediaItem.src === "string" && mediaItem.src.startsWith("/uploads/") && mediaItem.mime === "image/png" && mediaItem.size > 0);
const fileRes = await app.inject({ method: "GET", url: mediaItem.src });
ok("media-bestand wordt geserveerd (200)", fileRes.statusCode === 200);
ok("media-lijst bevat upload", (await app.inject({ method: "GET", url: "/api/media", headers: auth })).json().some((m: any) => m.id === mediaItem.id));
const badMime = await app.inject({ method: "POST", url: "/api/media", headers: auth, payload: { name: "x.svg", dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" } });
ok("media weigert niet-toegestaan type => 400", badMime.statusCode === 400);
ok("media-verwijderen => ok", (await app.inject({ method: "DELETE", url: "/api/media/" + mediaItem.id, headers: auth })).statusCode === 200);
ok("media-bestand weg na verwijderen (404)", (await app.inject({ method: "GET", url: mediaItem.src })).statusCode === 404);

// ---- gebruikers (RBAC) ----
const ulist = await app.inject({ method: "GET", url: "/api/users", headers: auth });
ok("gebruikerslijst => 200", ulist.statusCode === 200);
const users0 = ulist.json() as any[];
ok("seed-team aanwezig (admin + collega's)", users0.some((u) => u.email === "admin@xpo.nl") && users0.some((u) => u.email === "robert@xpo.nl"));
ok("rol wordt als Title-case getoond", users0.find((u) => u.email === "robert@xpo.nl")?.role === "Admin");

// opruimen testgebruiker
const stale = users0.find((u) => u.email === "test.user@xpo.nl");
if (stale) await app.inject({ method: "DELETE", url: "/api/users/" + stale.id, headers: auth });

const uc = await app.inject({ method: "POST", url: "/api/users", headers: auth, payload: { name: "Test User", email: "Test.User@xpo.nl", role: "Editor" } });
ok("gebruiker aanmaken => 200, e-mail genormaliseerd", uc.statusCode === 200 && (uc.json() as any).email === "test.user@xpo.nl" && (uc.json() as any).role === "Editor");
const newUserId = (uc.json() as any).id;
ok("dubbele e-mail => 409", (await app.inject({ method: "POST", url: "/api/users", headers: auth, payload: { name: "X", email: "test.user@xpo.nl", role: "Editor" } })).statusCode === 409);
ok("ongeldige e-mail => 400", (await app.inject({ method: "POST", url: "/api/users", headers: auth, payload: { name: "X", email: "geen-email", role: "Editor" } })).statusCode === 400);

const adminId = users0.find((u) => u.email === "admin@xpo.nl")!.id;
ok("laatste superadmin verwijderen wordt geblokkeerd => 409", (await app.inject({ method: "DELETE", url: "/api/users/" + adminId, headers: auth })).statusCode === 409);
ok("testgebruiker verwijderen => 200", (await app.inject({ method: "DELETE", url: "/api/users/" + newUserId, headers: auth })).statusCode === 200);

// ---- formulieren ----
const flist = await app.inject({ method: "GET", url: "/api/forms", headers: auth });
ok("formulierenlijst => 200", flist.statusCode === 200);
const contact = (flist.json() as any[]).find((f) => f.slug === "contact");
ok("seed-formulier 'Contact' met velden + inzending", !!contact && contact.fields.length === 3 && contact.submissions.length >= 1);

const fc = await app.inject({ method: "POST", url: "/api/forms", headers: auth, payload: { name: "Offerte" } });
ok("formulier aanmaken => 200 + standaardveld", fc.statusCode === 200 && (fc.json() as any).fields.length === 1 && (fc.json() as any).slug === "offerte");
const formId = (fc.json() as any).id;

const dup = await app.inject({ method: "POST", url: "/api/forms", headers: auth, payload: { name: "Offerte" } });
ok("dubbele naam => unieke slug (offerte-2)", (dup.json() as any).slug === "offerte-2");
const dupId = (dup.json() as any).id;

const upd = await app.inject({ method: "PUT", url: "/api/forms/" + formId, headers: auth, payload: { name: "Offerte", fields: [{ id: "a", label: "Bedrijf", type: "text", required: true }, { id: "b", label: "E-mail", type: "email", required: true }] } });
ok("velden bijwerken => 2 velden", (upd.json() as any).fields.length === 2 && (upd.json() as any).fields[1].type === "email");

const sub = await app.inject({ method: "POST", url: "/api/forms/" + formId + "/submissions", headers: auth, payload: { data: { Bedrijf: "Altermedia", "E-mail": "info@altermedia.nl" } } });
ok("inzending toevoegen => 200", sub.statusCode === 200);
const afterSub = (await app.inject({ method: "GET", url: "/api/forms", headers: auth })).json() as any[];
ok("inzending zichtbaar in lijst", afterSub.find((f) => f.id === formId)?.submissions.length === 1);
ok("inzending op onbekend formulier => 404", (await app.inject({ method: "POST", url: "/api/forms/999999/submissions", headers: auth, payload: { data: "x" } })).statusCode === 404);

ok("formulier verwijderen => 200", (await app.inject({ method: "DELETE", url: "/api/forms/" + formId, headers: auth })).statusCode === 200);
await app.inject({ method: "DELETE", url: "/api/forms/" + dupId, headers: auth });

// ---- commerce ----
const plist = await app.inject({ method: "GET", url: "/api/products", headers: auth });
ok("productenlijst => 200", plist.statusCode === 200);
const prods = plist.json() as any[];
ok("3 producten geseed; SPHERIX = uitverkocht (stock 0)", prods.length >= 3 && prods.find((p) => p.name === "SPHERIX")?.status === "uitverkocht");
const pc = await app.inject({ method: "POST", url: "/api/products", headers: auth, payload: { name: "ELYSIUM", price: "€4.200", stock: 3 } });
ok("product aanmaken => 200, status actief uit stock", pc.statusCode === 200 && (pc.json() as any).status === "actief");
const prodId = (pc.json() as any).id;
ok("product verwijderen => 200", (await app.inject({ method: "DELETE", url: "/api/products/" + prodId, headers: auth })).statusCode === 200);

const olist = await app.inject({ method: "GET", url: "/api/orders", headers: auth });
ok("orderslijst => 200, ref als id (#1043)", olist.statusCode === 200 && (olist.json() as any[]).some((o) => o.id === "#1043"));

// ---- navigatie ----
const nav0 = await app.inject({ method: "GET", url: "/api/navigation", headers: auth });
ok("navigatie => 200 met hoofdmenu", nav0.statusCode === 200 && (nav0.json() as any).main.some((i: any) => i.label === "Solutions"));
const navSave = await app.inject({ method: "PUT", url: "/api/navigation", headers: auth, payload: { main: [{ label: "Home", to: "", extra: "weg" }], footer: [] } });
ok("navigatie opslaan => 200, ongewenste velden gestript", navSave.statusCode === 200 && Object.keys((navSave.json() as any).main[0]).join(",") === "label,to");
ok("navigatie blijft bewaard", (await app.inject({ method: "GET", url: "/api/navigation", headers: auth })).json().main[0].label === "Home");
// terugzetten naar seed-waarde
await app.inject({ method: "PUT", url: "/api/navigation", headers: auth, payload: { main: [{ label: "Solutions", to: "smart-mirrors" }, { label: "Contact", to: "" }], footer: [{ label: "Privacy", to: "" }, { label: "Voorwaarden", to: "" }] } });

// ---- publieke header + assets ----
const home = await app.inject({ method: "GET", url: "/site" });
ok("publieke homepage => 200 (smart-mirrors gepubliceerd)", home.statusCode === 200);
ok("render bevat menu-header + assets", home.body.includes('class="xpo-bar"') && home.body.includes("xpo-bundle.js") && home.body.includes("/assets/xpo-menus.css"));
const js = await app.inject({ method: "GET", url: "/assets/xpo-menus.js" });
ok("menu-JS wordt geserveerd", js.statusCode === 200 && js.body.includes("XpoMenus"));
ok("menu-CSS wordt geserveerd", (await app.inject({ method: "GET", url: "/assets/xpo-menus.css" })).statusCode === 200);

// ---- SEO: redirects + sitemap ----
const rlist = await app.inject({ method: "GET", url: "/api/redirects", headers: auth });
ok("redirects => 200 met seed (/oude-product-url)", rlist.statusCode === 200 && (rlist.json() as any[]).some((r) => r.from === "/oude-product-url"));
const rNoFrom = await app.inject({ method: "POST", url: "/api/redirects", headers: auth, payload: { to: "/x" } });
ok("redirect zonder bron => 400", rNoFrom.statusCode === 400);
const rNew = await app.inject({ method: "POST", url: "/api/redirects", headers: auth, payload: { from: "promo", to: "/site/smart-mirrors", code: "302" } });
ok("redirect aanmaken => 201, bron genormaliseerd naar /promo", rNew.statusCode === 201 && rNew.json().from === "/promo" && rNew.json().code === "302");
const hit301 = await app.inject({ method: "GET", url: "/oude-product-url" });
ok("publieke 301 werkt (Location => /site/smart-mirrors)", hit301.statusCode === 301 && hit301.headers.location === "/site/smart-mirrors");
const hit302 = await app.inject({ method: "GET", url: "/promo" });
ok("publieke 302 werkt", hit302.statusCode === 302 && hit302.headers.location === "/site/smart-mirrors");
const delRd = await app.inject({ method: "DELETE", url: "/api/redirects/" + rNew.json().id, headers: auth });
ok("redirect verwijderen => 200", delRd.statusCode === 200);
ok("verwijderde redirect leidt niet meer om (404)", (await app.inject({ method: "GET", url: "/promo" })).statusCode === 404);
const sm = await app.inject({ method: "GET", url: "/sitemap.xml" });
ok("sitemap.xml => 200, XML met gepubliceerde pagina", sm.statusCode === 200 && String(sm.headers["content-type"]).includes("xml") && sm.body.includes("/site/smart-mirrors"));

// ---- helpdesk: tickets + kennisbank ----
const tks = await app.inject({ method: "GET", url: "/api/tickets", headers: auth });
ok("tickets => 200 met seed (#2841)", tks.statusCode === 200 && (tks.json() as any[]).some((t) => t.id === "#2841"));
const tNew = await app.inject({ method: "POST", url: "/api/tickets", headers: auth, payload: { subject: "Scherm flikkert", from: "support@klant.nl", channel: "Chat" } });
ok("ticket aanmaken => 201, nieuw #id, status Open", tNew.statusCode === 201 && /^#\d+$/.test(tNew.json().id) && tNew.json().status === "Open");
ok("ticket zonder onderwerp => 400", (await app.inject({ method: "POST", url: "/api/tickets", headers: auth, payload: { from: "x" } })).statusCode === 400);
const tPatch = await app.inject({ method: "PATCH", url: "/api/tickets/%232841", headers: auth, payload: { status: "Opgelost" } });
ok("ticketstatus wijzigen => 200, Opgelost", tPatch.statusCode === 200 && tPatch.json().status === "Opgelost");
ok("ongeldige status => 400", (await app.inject({ method: "PATCH", url: "/api/tickets/%232841", headers: auth, payload: { status: "Zweeft" } })).statusCode === 400);
ok("status op onbekend ticket => 404", (await app.inject({ method: "PATCH", url: "/api/tickets/%239999", headers: auth, payload: { status: "Open" } })).statusCode === 404);
ok("ticket verwijderen => 200", (await app.inject({ method: "DELETE", url: "/api/tickets/" + encodeURIComponent(tNew.json().id), headers: auth })).statusCode === 200);

const kbs = await app.inject({ method: "GET", url: "/api/kb", headers: auth });
ok("kennisbank => 200 met seed-artikel", kbs.statusCode === 200 && (kbs.json() as any[]).some((a) => a.title === "INVITE opnieuw opstarten"));
const kNew = await app.inject({ method: "POST", url: "/api/kb", headers: auth, payload: { title: "ARCADIA kalibreren", body: "Open instellingen > scherm." } });
ok("KB-artikel aanmaken => 201", kNew.statusCode === 201 && kNew.json().title === "ARCADIA kalibreren");
ok("KB zonder titel => 400", (await app.inject({ method: "POST", url: "/api/kb", headers: auth, payload: { body: "x" } })).statusCode === 400);
const kUpd = await app.inject({ method: "PUT", url: "/api/kb/" + kNew.json().id, headers: auth, payload: { title: "ARCADIA kalibreren (v2)", body: "Bijgewerkt." } });
ok("KB-artikel bijwerken => 200", kUpd.statusCode === 200 && kUpd.json().title === "ARCADIA kalibreren (v2)");
ok("KB-artikel verwijderen => 200", (await app.inject({ method: "DELETE", url: "/api/kb/" + kNew.json().id, headers: auth })).statusCode === 200);
ok("KB nogmaals verwijderen => 404", (await app.inject({ method: "DELETE", url: "/api/kb/" + kNew.json().id, headers: auth })).statusCode === 404);
// ticket #2841 terug op Open voor herhaalbaarheid
await app.inject({ method: "PATCH", url: "/api/tickets/%232841", headers: auth, payload: { status: "Open" } });

// ---- marketing: campagnes ----
const cl = await app.inject({ method: "GET", url: "/api/campaigns", headers: auth });
ok("campagnes => 200 met seed (INVITE lancering)", cl.statusCode === 200 && (cl.json() as any[]).some((c) => c.name === "INVITE lancering"));
const cNew = await app.inject({ method: "POST", url: "/api/campaigns", headers: auth, payload: { name: "Zomeractie", channel: "Social" } });
ok("campagne aanmaken => 201, status concept, sent 0", cNew.statusCode === 201 && cNew.json().status === "concept" && cNew.json().sent === 0 && cNew.json().channel === "Social");
ok("onbekend kanaal valt terug op E-mail", (await app.inject({ method: "POST", url: "/api/campaigns", headers: auth, payload: { name: "X", channel: "Duif" } })).json().channel === "E-mail");
ok("campagne zonder naam => 400", (await app.inject({ method: "POST", url: "/api/campaigns", headers: auth, payload: { channel: "Social" } })).statusCode === 400);
const cTog = await app.inject({ method: "PATCH", url: "/api/campaigns/" + cNew.json().id, headers: auth, payload: { status: "actief" } });
ok("campagnestatus => actief", cTog.statusCode === 200 && cTog.json().status === "actief");
ok("ongeldige campagnestatus => 400", (await app.inject({ method: "PATCH", url: "/api/campaigns/" + cNew.json().id, headers: auth, payload: { status: "live" } })).statusCode === 400);
ok("campagne verwijderen => 200", (await app.inject({ method: "DELETE", url: "/api/campaigns/" + cNew.json().id, headers: auth })).statusCode === 200);
ok("onbekende campagne verwijderen => 404", (await app.inject({ method: "DELETE", url: "/api/campaigns/cmp_x", headers: auth })).statusCode === 404);

// ---- custom velden: veldgroepen ----
const fgl = await app.inject({ method: "GET", url: "/api/field-groups", headers: auth });
ok("veldgroepen => 200 met seed (Productdetails, 3 velden)", fgl.statusCode === 200 && (fgl.json() as any[]).some((g) => g.name === "Productdetails" && g.fields.length === 3));
const fgNew = await app.inject({ method: "POST", url: "/api/field-groups", headers: auth, payload: { name: "SEO-blok", location: "Alle pagina's" } });
ok("veldgroep aanmaken => 201, met 1 standaardveld", fgNew.statusCode === 201 && fgNew.json().fields.length === 1 && fgNew.json().fields[0].type === "text");
ok("veldgroep zonder naam => 400", (await app.inject({ method: "POST", url: "/api/field-groups", headers: auth, payload: { location: "x" } })).statusCode === 400);
const fgUpd = await app.inject({ method: "PUT", url: "/api/field-groups/" + fgNew.json().id, headers: auth, payload: { name: "SEO-blok", location: "Alle pagina's", fields: [{ label: "Canonical", type: "url" }, { label: "Robots", type: "banaan" }] } });
ok("veldgroep opslaan => 200, ongeldig type → text, id toegekend", fgUpd.statusCode === 200 && fgUpd.json().fields.length === 2 && fgUpd.json().fields[0].type === "url" && fgUpd.json().fields[1].type === "text" && !!fgUpd.json().fields[1].id);
ok("onbekende veldgroep opslaan => 404", (await app.inject({ method: "PUT", url: "/api/field-groups/fg_x", headers: auth, payload: { name: "x", fields: [] } })).statusCode === 404);
ok("veldgroep verwijderen => 200", (await app.inject({ method: "DELETE", url: "/api/field-groups/" + fgNew.json().id, headers: auth })).statusCode === 200);
ok("veldgroep nogmaals verwijderen => 404", (await app.inject({ method: "DELETE", url: "/api/field-groups/" + fgNew.json().id, headers: auth })).statusCode === 404);

// ---- talen ----
const lgl = await app.inject({ method: "GET", url: "/api/languages", headers: auth });
ok("talen => 200, nl is standaard + actief", lgl.statusCode === 200 && (lgl.json() as any[]).find((l) => l.code === "nl")?.default === true);
const lNew = await app.inject({ method: "POST", url: "/api/languages", headers: auth, payload: { code: "FR", label: "Français", flag: "🇫🇷" } });
ok("taal aanmaken => 201, code lowercased, pad afgeleid /fr/", lNew.statusCode === 201 && lNew.json().code === "fr" && lNew.json().path === "/fr/" && lNew.json().default === false);
ok("dubbele taalcode => 409", (await app.inject({ method: "POST", url: "/api/languages", headers: auth, payload: { code: "nl", label: "X" } })).statusCode === 409);
ok("taal zonder naam => 400", (await app.inject({ method: "POST", url: "/api/languages", headers: auth, payload: { code: "xx" } })).statusCode === 400);
const setFr = await app.inject({ method: "POST", url: "/api/languages/fr/default", headers: auth });
ok("standaardtaal wisselen => fr standaard", setFr.statusCode === 200 && setFr.json().default === true);
ok("oude standaard (nl) is niet meer standaard", (await app.inject({ method: "GET", url: "/api/languages", headers: auth })).json().find((l: any) => l.code === "nl").default === false);
ok("standaardtaal uitschakelen => 400", (await app.inject({ method: "PATCH", url: "/api/languages/fr", headers: auth, payload: { enabled: false } })).statusCode === 400);
ok("niet-standaard uitschakelen => 200", (await app.inject({ method: "PATCH", url: "/api/languages/en", headers: auth, payload: { enabled: false } })).json().enabled === false);
await app.inject({ method: "PATCH", url: "/api/languages/en", headers: auth, payload: { enabled: true } });
ok("status op onbekende taal => 404", (await app.inject({ method: "PATCH", url: "/api/languages/zz", headers: auth, payload: { enabled: true } })).statusCode === 404);
ok("standaardtaal verwijderen => 400", (await app.inject({ method: "DELETE", url: "/api/languages/fr", headers: auth })).statusCode === 400);
await app.inject({ method: "POST", url: "/api/languages/nl/default", headers: auth }); // nl terug als standaard
ok("niet-standaard taal verwijderen => 200", (await app.inject({ method: "DELETE", url: "/api/languages/fr", headers: auth })).statusCode === 200);

// ---- templates ----
const tpll = await app.inject({ method: "GET", url: "/api/templates", headers: auth });
ok("templates => 200 met seed (Site header)", tpll.statusCode === 200 && (tpll.json() as any[]).some((t) => t.name === "Site header"));
const tplNew = await app.inject({ method: "POST", url: "/api/templates", headers: auth, payload: { name: "Blogpagina", type: "Single", condition: "Sjabloon = Blog" } });
ok("template aanmaken => 201, status draft", tplNew.statusCode === 201 && tplNew.json().status === "draft");
ok("template zonder naam => 400", (await app.inject({ method: "POST", url: "/api/templates", headers: auth, payload: { type: "Single" } })).statusCode === 400);
ok("template live zetten => 200", (await app.inject({ method: "PATCH", url: "/api/templates/" + tplNew.json().id, headers: auth, payload: { status: "live" } })).json().status === "live");
ok("ongeldige templatestatus => 400", (await app.inject({ method: "PATCH", url: "/api/templates/" + tplNew.json().id, headers: auth, payload: { status: "x" } })).statusCode === 400);
ok("template verwijderen => 200", (await app.inject({ method: "DELETE", url: "/api/templates/" + tplNew.json().id, headers: auth })).statusCode === 200);

// ---- instellingen (thema/integraties) ----
const set0 = await app.inject({ method: "GET", url: "/api/settings", headers: auth });
ok("instellingen => 200, standaard radius 14 + integraties", set0.statusCode === 200 && set0.json().theme.radius === 14 && Array.isArray(set0.json().integrations));
const setSave = await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { theme: { radius: 99, accent: "#123456", mode: "light" }, integrations: [{ cat: "Test", items: [{ n: "X", d: "d", ic: "cog", on: false }] }] } });
ok("instellingen opslaan => radius geklemd op 22, modus light", setSave.statusCode === 200 && setSave.json().theme.radius === 22 && setSave.json().theme.mode === "light");
ok("instellingen blijven bewaard", (await app.inject({ method: "GET", url: "/api/settings", headers: auth })).json().theme.accent === "#123456");

// ---- analytics ----
const an = await app.inject({ method: "GET", url: "/api/analytics", headers: auth });
ok("analytics => 200, echte tellingen", an.statusCode === 200 && an.json().pages.total >= 1 && an.json().languages === 3 && an.json().templates >= 4);

// ---- custom velden gerenderd op de publieke site ----
const pagesAll2 = (await app.inject({ method: "GET", url: "/api/pages", headers: auth })).json() as any[];
const smPage = pagesAll2.find((p) => p.slug === "smart-mirrors");
await app.inject({ method: "PUT", url: "/api/pages/" + smPage.id, headers: auth, payload: { slug: smPage.slug, title: smPage.title, template: smPage.template, locale: smPage.locale, seo: smPage.seo, blocks: smPage.blocks, meta: { cf_diag: "21 inch", cf_touch: true } } });
await app.inject({ method: "POST", url: "/api/pages/" + smPage.id + "/publish", headers: auth });
const smHtml = (await app.inject({ method: "GET", url: "/site/smart-mirrors" })).body;
ok("custom velden gerenderd als specificaties", smHtml.includes("Specificaties") && smHtml.includes("Schermdiagonaal") && smHtml.includes("21 inch"));
ok("accent uit instellingen toegepast in render", smHtml.includes("#123456"));
// instellingen terug naar dark/standaard accent
await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { theme: { radius: 14, accent: "", mode: "dark" } } });

// ---- activiteit (audittrail) ----
const act = await app.inject({ method: "GET", url: "/api/activity", headers: auth });
ok("activiteit => 200, login + schrijfacties vastgelegd", act.statusCode === 200 && (act.json() as any[]).length > 0 && (act.json() as any[]).some((a) => /Ingelogd|Template|Pagina/.test(a.text)));

// ---- pagina's: hiërarchie, auteur, linktelling, planning, prullenbak, vertaling, revisies ----
const pgs = (await app.inject({ method: "GET", url: "/api/pages", headers: auth })).json() as any[];
const smP = pgs.find((p) => p.slug === "smart-mirrors");
ok("pagina heeft auteur", smP.author === "admin@xpo.nl");
ok("pagina heeft linktelling", smP.links && typeof smP.links.internal === "number");
const child = pgs.find((p) => p.slug === "invite-21");
ok("kindpagina heeft parentId (hiërarchie)", child && child.parentId === smP.id);
// vertaling
const tr = await app.inject({ method: "POST", url: "/api/pages/" + smP.id + "/translate", headers: auth, payload: { locale: "en" } });
const smAfter = (await app.inject({ method: "GET", url: "/api/pages/" + smP.id, headers: auth })).json() as any;
ok("vertaling aanmaken => 200, locale en, gekoppeld via transGroup", tr.statusCode === 200 && tr.json().locale === "en" && !!tr.json().transGroup && tr.json().transGroup === smAfter.transGroup);
// planning
const sch = await app.inject({ method: "POST", url: "/api/pages/" + child.id + "/schedule", headers: auth, payload: { at: Date.now() + 3600000 } });
ok("planning => 200, status scheduled", sch.statusCode === 200 && sch.json().status === "scheduled");
ok("planning in verleden => 400", (await app.inject({ method: "POST", url: "/api/pages/" + child.id + "/schedule", headers: auth, payload: { at: Date.now() - 1000 } })).statusCode === 400);
// revisies (smart-mirrors is gepubliceerd => heeft een versie)
const vers = await app.inject({ method: "GET", url: "/api/pages/" + smP.id + "/versions", headers: auth });
ok("revisies => 200, minstens 1 versie", vers.statusCode === 200 && (vers.json() as any[]).length >= 1);
ok("revisie herstellen => 200", (await app.inject({ method: "POST", url: "/api/pages/" + smP.id + "/restore-version/" + (vers.json() as any[])[0].id, headers: auth })).statusCode === 200);
// prullenbak
const trashId = tr.json().id;
ok("naar prullenbak => 200", (await app.inject({ method: "POST", url: "/api/pages/" + trashId + "/trash", headers: auth })).statusCode === 200);
ok("getrasht is weg uit gewone lijst", !((await app.inject({ method: "GET", url: "/api/pages", headers: auth })).json() as any[]).some((p) => p.id === trashId));
ok("prullenbak-lijst bevat het item", ((await app.inject({ method: "GET", url: "/api/pages?trashed=1", headers: auth })).json() as any[]).some((p) => p.id === trashId));
ok("herstellen uit prullenbak => 200", (await app.inject({ method: "POST", url: "/api/pages/" + trashId + "/restore", headers: auth })).statusCode === 200);
await app.inject({ method: "POST", url: "/api/pages/" + trashId + "/trash", headers: auth });
ok("definitief verwijderen uit prullenbak => 200", (await app.inject({ method: "DELETE", url: "/api/pages/" + trashId + "?purge=1", headers: auth })).statusCode === 200);

// ---- taxonomie + posts ----
const cats = await app.inject({ method: "GET", url: "/api/terms?taxonomy=category", headers: auth });
ok("categorieën => 200 met tellingen (Solutions heeft posts)", cats.statusCode === 200 && (cats.json() as any[]).find((t) => t.slug === "solutions")?.count >= 2);
const newTerm = await app.inject({ method: "POST", url: "/api/terms", headers: auth, payload: { taxonomy: "tag", name: "smart mirror" } });
ok("term aanmaken => 201, slug afgeleid", newTerm.statusCode === 201 && newTerm.json().slug === "smart-mirror");
const postsList = await app.inject({ method: "GET", url: "/api/posts", headers: auth });
ok("posts => 200 met seed + categorieën", postsList.statusCode === 200 && (postsList.json() as any[]).some((p) => p.title === "Safety & instruction" && p.categories.length >= 1));
const root = { id: "root", type: "core/root", settings: {}, children: [{ id: "h", type: "xpo/heading", settings: { text: "Nieuw artikel" }, children: [] }] };
const newPost = await app.inject({ method: "POST", url: "/api/posts", headers: auth, payload: { title: "Showroom tips", excerpt: "Tips", blocks: root, categories: ["tm_loc"], tags: [newTerm.json().id] } });
ok("post aanmaken => 201, slug + categorie + tag gekoppeld", newPost.statusCode === 201 && newPost.json().slug === "showroom-tips" && newPost.json().categories.some((c: any) => c.id === "tm_loc") && newPost.json().tags.length === 1);
ok("post zonder titel => 400", (await app.inject({ method: "POST", url: "/api/posts", headers: auth, payload: { blocks: root } })).statusCode === 400);
ok("post publiceren => 200", (await app.inject({ method: "POST", url: "/api/posts/" + newPost.json().id + "/publish", headers: auth })).json().status === "published");
ok("post naar prullenbak => 200", (await app.inject({ method: "POST", url: "/api/posts/" + newPost.json().id + "/trash", headers: auth })).statusCode === 200);
ok("post-prullenbak bevat item", ((await app.inject({ method: "GET", url: "/api/posts?trashed=1", headers: auth })).json() as any[]).some((p) => p.id === newPost.json().id));
ok("post definitief verwijderen => 200", (await app.inject({ method: "DELETE", url: "/api/posts/" + newPost.json().id + "?purge=1", headers: auth })).statusCode === 200);

// ---- nieuwe widgets: render + validatie ----
const widRoot = { id: "root", type: "core/root", settings: {}, children: [
  { id: "d", type: "xpo/divider", settings: {}, children: [] },
  { id: "ib", type: "xpo/iconbox", settings: { icon: "★", title: "Snel live", body: "Plug & play." }, children: [] },
  { id: "c", type: "xpo/cta", settings: { title: "Klaar?", label: "Contact", url: "/contact" }, children: [] },
  { id: "st", type: "xpo/stats", settings: { items: [{ value: "500+", label: "Live" }] }, children: [] },
  { id: "lg", type: "xpo/logos", settings: { items: [{ name: "Rituals" }] }, children: [] },
  { id: "q", type: "xpo/testimonial", settings: { quote: "Top resultaat.", author: "Sanne" }, children: [] },
] };
const wCreate = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "widgets-demo", title: "Widgets demo", blocks: widRoot } });
ok("pagina met nieuwe widgets => 200", wCreate.statusCode === 200);
await app.inject({ method: "POST", url: "/api/pages/" + wCreate.json().id + "/publish", headers: auth });
const wHtml = (await app.inject({ method: "GET", url: "/site/widgets-demo" })).body;
ok("nieuwe widgets renderen op publieke site", ["xpo-divider", "xpo-iconbox", "xpo-cta", "xpo-stats", "xpo-logos", "xpo-quote"].every((c) => wHtml.includes(c)));
const wBad = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "widgets-bad", title: "Bad", blocks: { id: "root", type: "core/root", settings: {}, children: [{ id: "c", type: "xpo/cta", settings: { title: "x" }, children: [] }] } } });
ok("CTA zonder knop-label => 400 (validatie)", wBad.statusCode === 400);
await app.inject({ method: "DELETE", url: "/api/pages/" + wCreate.json().id + "?purge=1", headers: auth });
await app.inject({ method: "POST", url: "/api/pages/" + wCreate.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + wCreate.json().id + "?purge=1", headers: auth });

// ---- dynamisch posts-grid + publieke blogpost ----
const gridRoot = { id: "root", type: "core/root", settings: {}, children: [
  { id: "g", type: "xpo/posts", settings: { title: "Solutions", category: "solutions", limit: 6 }, children: [] },
] };
const gCreate = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "blog-index", title: "Blog index", blocks: gridRoot } });
await app.inject({ method: "POST", url: "/api/pages/" + gCreate.json().id + "/publish", headers: auth });
const gHtml = (await app.inject({ method: "GET", url: "/site/blog-index" })).body;
ok("posts-grid toont echte posts uit categorie", gHtml.includes("Visitor information") && gHtml.includes("Safety &amp; instruction") && gHtml.includes("/blog/safety-instruction"));
ok("publieke blogpost => 200", (await app.inject({ method: "GET", url: "/blog/safety-instruction" })).statusCode === 200);
const blogHtml = (await app.inject({ method: "GET", url: "/blog/safety-instruction" })).body;
ok("blogpost rendert titel/inhoud", blogHtml.includes("Veiligheid &amp; instructie"));
ok("onbekende blogpost => 404", (await app.inject({ method: "GET", url: "/blog/bestaat-niet" })).statusCode === 404);
await app.inject({ method: "POST", url: "/api/pages/" + gCreate.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + gCreate.json().id + "?purge=1", headers: auth });

// ---- herbruikbare secties (snippets) ----
const snipBlock = { id: "sec", type: "xpo/cta", settings: { title: "Klaar?", label: "Contact", url: "/contact" }, children: [] };
const snl0 = await app.inject({ method: "GET", url: "/api/snippets", headers: auth });
ok("snippets => 200 (leeg bij start)", snl0.statusCode === 200 && Array.isArray(snl0.json()));
const snNew = await app.inject({ method: "POST", url: "/api/snippets", headers: auth, payload: { name: "Contact-CTA", block: snipBlock } });
ok("snippet opslaan => 201", snNew.statusCode === 201 && snNew.json().name === "Contact-CTA");
ok("snippet zonder naam => 400", (await app.inject({ method: "POST", url: "/api/snippets", headers: auth, payload: { block: snipBlock } })).statusCode === 400);
ok("hele pagina als snippet => 400", (await app.inject({ method: "POST", url: "/api/snippets", headers: auth, payload: { name: "x", block: { id: "r", type: "core/root", settings: {}, children: [] } } })).statusCode === 400);
ok("ongeldig blok als snippet => 400", (await app.inject({ method: "POST", url: "/api/snippets", headers: auth, payload: { name: "x", block: { id: "b", type: "xpo/cta", settings: { title: "x" }, children: [] } } })).statusCode === 400);
ok("snippet in lijst", ((await app.inject({ method: "GET", url: "/api/snippets", headers: auth })).json() as any[]).some((x) => x.id === snNew.json().id));
ok("snippet bijwerken => 200", (await app.inject({ method: "PUT", url: "/api/snippets/" + snNew.json().id, headers: auth, payload: { name: "Contact-CTA v2", block: snipBlock } })).json().name === "Contact-CTA v2");
ok("snippet verwijderen => 200", (await app.inject({ method: "DELETE", url: "/api/snippets/" + snNew.json().id, headers: auth })).statusCode === 200);
ok("onbekende snippet verwijderen => 404", (await app.inject({ method: "DELETE", url: "/api/snippets/sn_x", headers: auth })).statusCode === 404);

// ---- per-breakpoint responsive: binnenruimte + verbergen ----
const respRoot = { id: "root", type: "core/root", settings: {}, children: [
  { id: "sec1", type: "xpo/heading", settings: { text: "Responsive", level: "h2", _style: { pad: 40, padM: 8 }, _adv: { hideOn: ["mobile"] } }, children: [] },
] };
const rCreate = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "responsive-demo", title: "Responsive", blocks: respRoot } });
await app.inject({ method: "POST", url: "/api/pages/" + rCreate.json().id + "/publish", headers: auth });
const rHtml = (await app.inject({ method: "GET", url: "/site/responsive-demo" })).body;
ok("per-breakpoint binnenruimte (mobiel) als media query", rHtml.includes("@media (max-width:640px)") && rHtml.includes(".n-sec1{padding:8px}"));
ok("verberg-op-mobiel: klasse + correcte media query", rHtml.includes("hide-mobile") && rHtml.includes(".hide-mobile{display:none!important}"));
ok("geen verkeerde altijd-verbergen regel meer", !rHtml.includes(".hide-desktop{display:none}\n") && rHtml.includes("@media (min-width:1025px){.hide-desktop{display:none!important}}"));
await app.inject({ method: "POST", url: "/api/pages/" + rCreate.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + rCreate.json().id + "?purge=1", headers: auth });

// ---- stijl-engine v2: achtergronden, overlay, filters, particles, typografie ----
const styleRoot = { id: "root", type: "core/root", settings: {}, children: [
  { id: "grad", type: "xpo/heading", settings: { text: "G", level: "h2", _style: { bg: "gradient", gradFrom: "#112233", gradTo: "#445566", gradAngle: 90 } }, children: [] },
  { id: "aur", type: "xpo/heading", settings: { text: "A", level: "h2", _style: { bg: "aurora", auroraA: "#5F8D7A", auroraB: "#1b232b", auroraC: "#06100e" } }, children: [] },
  { id: "img", type: "xpo/heading", settings: { text: "I", level: "h2", _style: { bg: "image", bgImage: "/x.jpg", overlayColor: "#000000", overlayOpacity: 50, fBlur: 4 } }, children: [] },
  { id: "vid", type: "xpo/heading", settings: { text: "V", level: "h2", _style: { bg: "video", bgVideo: "/v.mp4" } }, children: [] },
  { id: "par", type: "xpo/heading", settings: { text: "P", level: "h2", _style: { particles: true, particleColor: "#5F8D7A" } }, children: [] },
  { id: "typ", type: "xpo/heading", settings: { text: "T", level: "h2", _style: { textColor: "#ff0000", fontFamily: "Georgia, serif", fontWeight: "700", fontSize: 24, textTransform: "uppercase" } }, children: [] },
  { id: "evil", type: "xpo/heading", settings: { text: "E", level: "h2", _style: { bg: "color", bgColor: "javascript:alert(1)" } }, children: [] },
] };
const sCreate = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "style-demo", title: "Style", blocks: styleRoot } });
await app.inject({ method: "POST", url: "/api/pages/" + sCreate.json().id + "/publish", headers: auth });
const sHtml = (await app.inject({ method: "GET", url: "/site/style-demo" })).body;
ok("gradient-achtergrond gerenderd", sHtml.includes("background:linear-gradient(90deg,#112233,#445566)"));
ok("aurora-achtergrond + keyframes", sHtml.includes("animation:xpo-aurora") && sHtml.includes("@keyframes xpo-aurora"));
ok("foto-achtergrond als ::before met overlay + blur", sHtml.includes(".n-img::before") && sHtml.includes('url("/x.jpg")') && sHtml.includes("blur(4px)") && sHtml.includes(".n-img::after") && sHtml.includes("opacity:0.5"));
ok("video-achtergrond element", sHtml.includes('<video class="xpo-bgvid"') && sHtml.includes('src="/v.mp4"'));
ok("particles-laag + fx-script", sHtml.includes('data-particles="1"') && sHtml.includes("xpo-bundle.js"));
ok("typografie (kleur/font/gewicht/transform)", sHtml.includes("color:#ff0000 !important") && sHtml.includes("font-family:Georgia, serif !important") && sHtml.includes("font-weight:700 !important") && sHtml.includes("text-transform:uppercase"));
ok("kleur-injectie geweerd (safeColor)", !sHtml.includes("javascript:alert"));
await app.inject({ method: "POST", url: "/api/pages/" + sCreate.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + sCreate.json().id + "?purge=1", headers: auth });

// ---- custom CSS / JS per pagina ----
const cjsBlocks = { id: "root", type: "core/root", settings: {}, children: [{ id: "h", type: "xpo/heading", settings: { text: "CJS", level: "h2" }, children: [] }] };
const cjs = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "cjs-demo", title: "CJS", blocks: cjsBlocks } });
await app.inject({ method: "PUT", url: "/api/pages/" + cjs.json().id, headers: auth, payload: { slug: "cjs-demo", title: "CJS", blocks: cjsBlocks, meta: { customCss: ".zzz{outline:1px solid red}", customJs: "window.__xpo_test=1" } } });
await app.inject({ method: "POST", url: "/api/pages/" + cjs.json().id + "/publish", headers: auth });
const cHtml = (await app.inject({ method: "GET", url: "/site/cjs-demo" })).body;
ok("custom CSS geïnjecteerd", cHtml.includes("<style>.zzz{outline:1px solid red}</style>"));
ok("custom JS geïnjecteerd", /<script nonce="[^"]+">window.__xpo_test=1<\/script>/.test(cHtml));
await app.inject({ method: "POST", url: "/api/pages/" + cjs.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + cjs.json().id + "?purge=1", headers: auth });

// ---- JSON-LD schema ----
const schemaHtml = (await app.inject({ method: "GET", url: "/site/smart-mirrors" })).body;
ok("JSON-LD schema in <head>", /<script type="application\/ld\+json" nonce="[^"]+">/.test(schemaHtml) && schemaHtml.includes('"@type":"Article"') && schemaHtml.includes('"url":"/site/smart-mirrors"'));

// ---- video-widget ----
const vidRoot = { id: "root", type: "core/root", settings: {}, children: [
  { id: "v1", type: "xpo/video", settings: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", ratio: "16/9" }, children: [] },
  { id: "v2", type: "xpo/video", settings: { url: "/media/clip.mp4" }, children: [] },
] };
const vCreate = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "video-demo", title: "Video", blocks: vidRoot } });
await app.inject({ method: "POST", url: "/api/pages/" + vCreate.json().id + "/publish", headers: auth });
const vHtml = (await app.inject({ method: "GET", url: "/site/video-demo" })).body;
ok("video: YouTube-embed", vHtml.includes('youtube.com/embed/dQw4w9WgXcQ'));
ok("video: mp4 als <video>", vHtml.includes('<video controls src="/media/clip.mp4">'));
await app.inject({ method: "POST", url: "/api/pages/" + vCreate.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + vCreate.json().id + "?purge=1", headers: auth });

// ---- popups ----
ok("popups => 200 (leeg)", (await app.inject({ method: "GET", url: "/api/popups", headers: auth })).statusCode === 200);
const puNew = await app.inject({ method: "POST", url: "/api/popups", headers: auth, payload: { name: "Nieuwsbrief", trigger: "load", delay: 2, condType: "all", title: "Blijf op de hoogte", body: "Schrijf je in.", btnLabel: "Aanmelden", btnUrl: "/contact" } });
ok("popup aanmaken => 201, inactief", puNew.statusCode === 201 && puNew.json().active === false);
ok("popup zonder naam => 400", (await app.inject({ method: "POST", url: "/api/popups", headers: auth, payload: { trigger: "load" } })).statusCode === 400);
ok("popup verschijnt NIET zolang inactief", !(await app.inject({ method: "GET", url: "/site/smart-mirrors" })).body.includes('class="xpo-popup"'));
const puOn = await app.inject({ method: "POST", url: "/api/popups/" + puNew.json().id + "/toggle", headers: auth });
ok("popup activeren => actief", puOn.json().active === true);
const puHtml = (await app.inject({ method: "GET", url: "/site/smart-mirrors" })).body;
ok("actieve popup geïnjecteerd + script + trigger", puHtml.includes('class="xpo-popup"') && puHtml.includes('data-trigger="load"') && puHtml.includes("/assets/xpo-popups.js") && puHtml.includes("Blijf op de hoogte"));
ok("popup bijwerken => 200", (await app.inject({ method: "PUT", url: "/api/popups/" + puNew.json().id, headers: auth, payload: { name: "Nieuwsbrief v2", trigger: "exit" } })).json().name === "Nieuwsbrief v2");
ok("popup verwijderen => 200", (await app.inject({ method: "DELETE", url: "/api/popups/" + puNew.json().id, headers: auth })).statusCode === 200);
ok("na verwijderen geen popup meer op site", !(await app.inject({ method: "GET", url: "/site/smart-mirrors" })).body.includes('class="xpo-popup"'));

// ---- formulier-acties: CRM-leads + bezorgwachtrij ----
const formsAll = (await app.inject({ method: "GET", url: "/api/forms", headers: auth })).json() as any[];
const cform = formsAll.find((f) => f.slug === "contact");
ok("contactformulier heeft CRM-actie (seed)", !!cform && cform.actions.some((a: any) => a.type === "crm" && a.enabled));
ok("seed-lead aanwezig", ((await app.inject({ method: "GET", url: "/api/leads", headers: auth })).json() as any[]).some((l) => l.email === "sanne@hotelzuid.nl"));
const updF = await app.inject({ method: "PUT", url: "/api/forms/" + cform.id, headers: auth, payload: { actions: [{ type: "crm", enabled: true, target: "" }, { type: "webhook", enabled: true, target: "https://example.com/hook" }] } });
ok("acties opgeslagen (CRM + webhook)", (updF.json() as any).actions.length === 2);
const subR = await app.inject({ method: "POST", url: "/api/forms/" + cform.id + "/submissions", headers: auth, payload: { data: { x1: "Jan Jansen", x2: "jan@acme.nl", x3: "Interesse in INVITE" } } });
ok("inzending => 200", subR.statusCode === 200);
const leadsF = (await app.inject({ method: "GET", url: "/api/forms/" + cform.id + "/leads", headers: auth })).json() as any[];
ok("inzending maakt automatisch een CRM-lead (veld-mapping)", leadsF.some((l) => l.email === "jan@acme.nl" && l.name === "Jan Jansen" && l.message === "Interesse in INVITE"));
const dels = (await app.inject({ method: "GET", url: "/api/deliveries", headers: auth })).json() as any[];
const myDel = dels.find((d) => d.type === "webhook" && d.status === "queued");
ok("webhook belandt in de bezorgwachtrij (queued)", !!myDel);
const retry = await app.inject({ method: "POST", url: "/api/deliveries/" + myDel.id + "/retry", headers: auth });
ok("retry verwerkt bezorging (niet meer queued)", retry.statusCode === 200 && retry.json().status !== "queued");

// ---- site-brede globals: design-tokens + globale CSS/JS ----
await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { theme: { radius: 14, accent: "", mode: "dark", font: "" }, tokens: { primary: "#123456", text: "", bg: "", fontHeading: "Georgia, serif", fontBody: "" }, globals: { css: ".gx{color:red}", js: "window.__g=1" } } });
const glHtml = (await app.inject({ method: "GET", url: "/site/smart-mirrors" })).body;
ok("token primary → --accent op site", glHtml.includes("--accent:#123456"));
ok("globale CSS geïnjecteerd op elke pagina", glHtml.includes(".gx{color:red}"));
ok("globale JS geïnjecteerd op elke pagina", glHtml.includes("window.__g=1"));
ok("heading-token toegepast", glHtml.includes(".xpo-h{font-family:Georgia, serif}"));

// ---- zoeken ----
const srch = (await app.inject({ method: "GET", url: "/api/search?q=smart", headers: auth })).json() as any;
ok("zoeken vindt pagina", Array.isArray(srch.results) && srch.results.some((r: any) => r.type === "page" && r.slug === "smart-mirrors"));
const srch2 = (await app.inject({ method: "GET", url: "/api/search?q=safety", headers: auth })).json() as any;
ok("zoeken vindt post", srch2.results.some((r: any) => r.type === "post" && r.slug === "safety-instruction"));
ok("lege zoekterm => leeg", ((await app.inject({ method: "GET", url: "/api/search?q=", headers: auth })).json() as any).results.length === 0);

// ---- back-up: export + import ----
const exp = await app.inject({ method: "GET", url: "/api/export", headers: auth });
ok("export => 200 met content", exp.statusCode === 200 && exp.json().pages.length > 0 && exp.json().posts.length > 0);
const pagesBefore = ((await app.inject({ method: "GET", url: "/api/pages", headers: auth })).json() as any[]).length;
const imp = await app.inject({ method: "POST", url: "/api/import", headers: auth, payload: { data: exp.json() } });
ok("import => 200 met samenvatting", imp.statusCode === 200 && imp.json().imported.pages > 0 && imp.json().imported.posts > 0);
const pagesAfter = ((await app.inject({ method: "GET", url: "/api/pages", headers: auth })).json() as any[]).length;
ok("import voegt content toe (additief)", pagesAfter > pagesBefore);
ok("ongeldige import => 400", (await app.inject({ method: "POST", url: "/api/import", headers: auth, payload: { data: "kapot" } })).statusCode === 400);

// ---- synced components (één bron, werkt overal door) ----
const snSync = await app.inject({ method: "POST", url: "/api/snippets", headers: auth, payload: { name: "Sync-banner", block: { id: "b", type: "xpo/heading", settings: { text: "OrigineleBanner", level: "h2" }, children: [] } } });
const syncRoot = { id: "root", type: "core/root", settings: {}, children: [{ id: "sref", type: "xpo/sync", settings: { ref: snSync.json().id }, children: [] }] };
const syncPage = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "sync-demo", title: "Sync", blocks: syncRoot } });
await app.inject({ method: "POST", url: "/api/pages/" + syncPage.json().id + "/publish", headers: auth });
ok("synced sectie rendert de broninhoud", (await app.inject({ method: "GET", url: "/site/sync-demo" })).body.includes("OrigineleBanner"));
await app.inject({ method: "PUT", url: "/api/snippets/" + snSync.json().id, headers: auth, payload: { name: "Sync-banner", block: { id: "b", type: "xpo/heading", settings: { text: "BijgewerkteBanner", level: "h2" }, children: [] } } });
ok("bron bewerken werkt overal door (live)", (await app.inject({ method: "GET", url: "/site/sync-demo" })).body.includes("BijgewerkteBanner"));
await app.inject({ method: "POST", url: "/api/pages/" + syncPage.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + syncPage.json().id + "?purge=1", headers: auth });
await app.inject({ method: "DELETE", url: "/api/snippets/" + snSync.json().id, headers: auth });

// ---- conditionele zichtbaarheid: datumvenster ----
const visRoot = { id: "root", type: "core/root", settings: {}, children: [
  { id: "vis", type: "xpo/heading", settings: { text: "ZichtbaarBlok", level: "h2" }, children: [] },
  { id: "exp", type: "xpo/heading", settings: { text: "VerlopenBlok", level: "h2", _adv: { showUntil: new Date(Date.now() - 86400000).toISOString() } }, children: [] },
  { id: "fut", type: "xpo/heading", settings: { text: "ToekomstBlok", level: "h2", _adv: { showFrom: new Date(Date.now() + 86400000).toISOString() } }, children: [] },
] };
const visPage = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "vis-demo", title: "Vis", blocks: visRoot } });
await app.inject({ method: "POST", url: "/api/pages/" + visPage.json().id + "/publish", headers: auth });
const visHtml = (await app.inject({ method: "GET", url: "/site/vis-demo" })).body;
ok("zichtbaar blok wordt getoond", visHtml.includes("ZichtbaarBlok"));
ok("verlopen blok (showUntil in verleden) verborgen", !visHtml.includes("VerlopenBlok"));
ok("toekomstig blok (showFrom in toekomst) verborgen", !visHtml.includes("ToekomstBlok"));
await app.inject({ method: "POST", url: "/api/pages/" + visPage.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + visPage.json().id + "?purge=1", headers: auth });

// ---- post-planning ----
const schPostRoot = { id: "root", type: "core/root", settings: {}, children: [{ id: "h", type: "xpo/heading", settings: { text: "Geplande post" }, children: [] }] };
const schPost = await app.inject({ method: "POST", url: "/api/posts", headers: auth, payload: { title: "Planpost", blocks: schPostRoot } });
ok("post inplannen => 200, status scheduled", (await app.inject({ method: "POST", url: "/api/posts/" + schPost.json().id + "/schedule", headers: auth, payload: { at: Date.now() + 3600000 } })).json().status === "scheduled");
ok("post inplannen in verleden => 400", (await app.inject({ method: "POST", url: "/api/posts/" + schPost.json().id + "/schedule", headers: auth, payload: { at: Date.now() - 1000 } })).statusCode === 400);
await app.inject({ method: "DELETE", url: "/api/posts/" + schPost.json().id + "?purge=1", headers: auth });
await app.inject({ method: "POST", url: "/api/posts/" + schPost.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/posts/" + schPost.json().id + "?purge=1", headers: auth });

// ---- layout: kolommen + nesting ----
const colRoot = { id: "root", type: "core/root", settings: {}, children: [
  { id: "cols", type: "xpo/columns", settings: { cols: "3", gap: 24, valign: "stretch" }, children: [
    { id: "c1", type: "xpo/heading", settings: { text: "KolomEen", level: "h3" }, children: [] },
    { id: "c2", type: "xpo/heading", settings: { text: "KolomTwee", level: "h3" }, children: [] },
    { id: "c3", type: "xpo/container", settings: { gap: 8 }, children: [
      { id: "c3a", type: "xpo/heading", settings: { text: "GenestKop", level: "h4" }, children: [] },
      { id: "c3b", type: "xpo/text", settings: { body: "GenesteTekst" }, children: [] },
    ] },
  ] },
] };
const colP = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "col-demo", title: "Kolommen", blocks: colRoot } });
ok("pagina met geneste kolommen => 200 (validatie ok)", colP.statusCode === 200);
await app.inject({ method: "POST", url: "/api/pages/" + colP.json().id + "/publish", headers: auth });
const colHtml = (await app.inject({ method: "GET", url: "/site/col-demo" })).body;
ok("kolommen-grid gerenderd (3 koloms)", colHtml.includes('class="wbg n-cols') && colHtml.includes("grid-template-columns:repeat(3,minmax(0,1fr))"));
ok("geneste inhoud gerenderd", ["KolomEen", "KolomTwee", "GenestKop", "GenesteTekst"].every((t) => colHtml.includes(t)));
ok("container-stack gerenderd", colHtml.includes('class="xpo-stack"'));
ok("kolommen klappen in op mobiel", colHtml.includes("@media (max-width:640px){.xpo-cols{grid-template-columns:1fr!important}}"));
await app.inject({ method: "POST", url: "/api/pages/" + colP.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + colP.json().id + "?purge=1", headers: auth });

// ---- nieuwe widgets: prijstabel, voortgang, social, knoppen, kaart, countdown ----
const wRoot = { id: "root", type: "core/root", settings: {}, children: [
  { id: "pr", type: "xpo/pricing", settings: { plans: [{ name: "ProPlanX", price: "€199", period: "/mnd", features: "FeatureA\nFeatureB", cta: "Kies", url: "/contact", featured: true }] }, children: [] },
  { id: "pg", type: "xpo/progress", settings: { items: [{ label: "InstallatieX", percent: "90" }] }, children: [] },
  { id: "so", type: "xpo/social", settings: { items: [{ network: "LinkedIn", url: "https://linkedin.com" }] }, children: [] },
  { id: "bt", type: "xpo/buttons", settings: { items: [{ label: "OfferteX", url: "/contact", variant: "solid" }] }, children: [] },
  { id: "mp", type: "xpo/map", settings: { query: "Houten, Nederland", ratio: "16/9" }, children: [] },
  { id: "cd", type: "xpo/countdown", settings: { target: "2026-12-31 23:59", label: "LanceringX" }, children: [] },
] };
const wP = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "widgets-demo", title: "Widgets", blocks: wRoot } });
ok("pagina met 6 nieuwe widgets => 200", wP.statusCode === 200);
await app.inject({ method: "POST", url: "/api/pages/" + wP.json().id + "/publish", headers: auth });
const widHtml = (await app.inject({ method: "GET", url: "/site/widgets-demo" })).body;
ok("prijstabel gerenderd (featured + kenmerk)", widHtml.includes('class="xpr feat"') && widHtml.includes("ProPlanX") && widHtml.includes("<li>FeatureA</li>"));
ok("voortgangsbalk gerenderd met breedte", widHtml.includes('class="xpb-t"') && widHtml.includes("width:90%"));
ok("social-links gerenderd", widHtml.includes('class="xpo-social"') && widHtml.includes('href="https://linkedin.com"'));
ok("knoppengroep gerenderd", widHtml.includes('class="xpo-btns"') && widHtml.includes("OfferteX"));
ok("kaart-embed gerenderd", widHtml.includes('class="xpo-map"') && widHtml.includes("maps?q=Houten") && widHtml.includes("output=embed"));
ok("countdown gerenderd met data-countdown", widHtml.includes('class="xpo-count"') && widHtml.includes('data-countdown="2026-12-31 23:59"'));
await app.inject({ method: "POST", url: "/api/pages/" + wP.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + wP.json().id + "?purge=1", headers: auth });
// validatie: kaart zonder locatie + countdown zonder doeldatum => 400
ok("kaart zonder locatie => 400", (await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "map-x", title: "X", blocks: { id: "root", type: "core/root", settings: {}, children: [{ id: "m", type: "xpo/map", settings: {}, children: [] }] } } })).statusCode === 400);
ok("countdown zonder doeldatum => 400", (await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "cd-x", title: "X", blocks: { id: "root", type: "core/root", settings: {}, children: [{ id: "c", type: "xpo/countdown", settings: {}, children: [] }] } } })).statusCode === 400);

// ---- reacties op posts ----
const postsForC = (await app.inject({ method: "GET", url: "/api/posts", headers: auth })).json() as any[];
const safetyPost = postsForC.find((p) => p.slug === "safety-instruction");
const cAll = (await app.inject({ method: "GET", url: "/api/comments", headers: auth })).json() as any;
ok("seed-reacties geteld (approved + pending)", cAll.counts.approved >= 1 && cAll.counts.pending >= 1);
const blog0 = (await app.inject({ method: "GET", url: "/blog/safety-instruction" })).body;
ok("goedgekeurde reactie zichtbaar op blog", blog0.includes("Heldere uitleg"));
ok("reactie in afwachting niet zichtbaar op blog", !blog0.includes("SPHERIX"));
ok("reactieformulier op blog", blog0.includes('class="xcm-form"') && blog0.includes('data-post="' + safetyPost.id + '"'));
const cSub = await app.inject({ method: "POST", url: "/api/posts/" + safetyPost.id + "/comments", payload: { author: "Tester", body: "NieuweReactieX" } });
ok("publieke reactie => pending", cSub.json().ok === true && cSub.json().status === "pending");
ok("te korte reactie => 400", (await app.inject({ method: "POST", url: "/api/posts/" + safetyPost.id + "/comments", payload: { body: "x" } })).statusCode === 400);
ok("nieuwe (pending) reactie nog niet op blog", !(await app.inject({ method: "GET", url: "/blog/safety-instruction" })).body.includes("NieuweReactieX"));
const pend = ((await app.inject({ method: "GET", url: "/api/comments?status=pending", headers: auth })).json() as any).items.find((c: any) => c.body === "NieuweReactieX");
ok("reactie goedkeuren => approved", (await app.inject({ method: "POST", url: "/api/comments/" + pend.id + "/approve", headers: auth })).json().status === "approved");
ok("goedgekeurde reactie nu zichtbaar op blog", (await app.inject({ method: "GET", url: "/blog/safety-instruction" })).body.includes("NieuweReactieX"));
ok("reactie als spam markeren", (await app.inject({ method: "POST", url: "/api/comments/" + pend.id + "/spam", headers: auth })).json().status === "spam");
ok("reactie verwijderen => ok", (await app.inject({ method: "DELETE", url: "/api/comments/" + pend.id, headers: auth })).json().ok === true);

// ---- Alysium AI: assistent, kennisbank, retrieval ----
const aiProd = await app.inject({ method: "POST", url: "/api/ai/chat", payload: { message: "Wat is INVITE?" } });
ok("AI beantwoordt productvraag uit kennisbank", aiProd.statusCode === 200 && /INVITE|lift/i.test(aiProd.json().answer) && aiProd.json().score > 0);
ok("AI geeft bronnen terug", Array.isArray(aiProd.json().sources) && aiProd.json().sources.length > 0);
const aiKbA = (await app.inject({ method: "POST", url: "/api/ai/chat", payload: { message: "Wat is de levertijd van een display?" } })).json();
ok("AI gebruikt geseed kennisitem (levertijd)", /weken|4 tot 6/i.test(aiKbA.answer));
ok("AI te korte vraag => 400", (await app.inject({ method: "POST", url: "/api/ai/chat", payload: { message: "x" } })).statusCode === 400);
const aiNone = (await app.inject({ method: "POST", url: "/api/ai/chat", payload: { message: "zxqwvplmuik" } })).json();
ok("AI valt terug bij onbekende vraag", aiNone.sources.length === 0 && /geen informatie/i.test(aiNone.answer));
const sugg = (await app.inject({ method: "GET", url: "/api/ai/suggest?q=INVITE" })).json();
ok("AI-suggesties werken", sugg.suggestions.length > 0);
const aiStats = (await app.inject({ method: "GET", url: "/api/ai/stats", headers: auth })).json();
ok("AI-corpus bevat productkennis + content", aiStats.total > 7 && aiStats.bySource.product === 7);
// kennisbank CRUD + meteen doorzoekbaar
const kbNew = (await app.inject({ method: "POST", url: "/api/ai/kb", headers: auth, payload: { title: "Garantie", body: "XPO Screens geeft standaard 36 maanden garantie op alle displays.", url: "/site/contact" } })).json();
ok("AI-kennisitem aangemaakt", !!kbNew.id);
ok("nieuw kennisitem meteen doorzoekbaar", /36 maanden|garantie/i.test((await app.inject({ method: "POST", url: "/api/ai/chat", payload: { message: "Hoeveel garantie krijg ik?" } })).json().answer));
ok("AI-kennisitem verwijderen => ok", (await app.inject({ method: "DELETE", url: "/api/ai/kb/" + kbNew.id, headers: auth })).json().ok === true);
// publieke Quinty-widget injectie
await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { theme: { radius: 14, accent: "", mode: "dark", font: "" }, ai: { assistant: true, name: "Quinty", greeting: "Hoi!", fallback: "Geen info." } } });
const siteForAi = (await app.inject({ method: "GET", url: "/site/smart-mirrors" })).body;
ok("Quinty-widget geïnjecteerd op de site", siteForAi.includes("/assets/xpo-quinty.js") && siteForAi.includes("window.__quinty"));

// ---- Theme Builder: header/footer/single + condities ----
const tbPage = (await app.inject({ method: "GET", url: "/site/smart-mirrors" })).body;
ok("live footer-template verschijnt op elke pagina", tbPage.includes("Klaar voor een smart display?") && tbPage.includes("© XPO Screens"));
const tbBlog = (await app.inject({ method: "GET", url: "/blog/safety-instruction" })).body;
ok("single-template wikkelt blogpost (eyebrow + post-content)", tbBlog.includes("Kennisbank") && tbBlog.includes("Veiligheid &amp; instructie"));
ok("footer ook op de blogpost", tbBlog.includes("Klaar voor een smart display?"));
// nieuwe header-template met paginaspecifieke conditie
const tmpl = (await app.inject({ method: "POST", url: "/api/templates", headers: auth, payload: { name: "PromoHeader", kind: "header" } })).json();
ok("template aangemaakt (kind header, default conditie all)", tmpl.kind === "header" && tmpl.conditions[0].type === "all");
await app.inject({ method: "PUT", url: "/api/templates/" + tmpl.id, headers: auth, payload: { conditions: [{ type: "page", value: "smart-mirrors" }] } });
const okBlocks = await app.inject({ method: "POST", url: "/api/templates/" + tmpl.id + "/blocks", headers: auth, payload: { blocks: { id: "root", type: "core/root", settings: {}, children: [{ id: "h", type: "xpo/heading", settings: { text: "PROMOHEADERX", level: "h3" }, children: [] }] } } });
ok("template-blokken opslaan met validatie => 200", okBlocks.statusCode === 200);
ok("ongeldige template-blokken => 400", (await app.inject({ method: "POST", url: "/api/templates/" + tmpl.id + "/blocks", headers: auth, payload: { blocks: { id: "root", type: "core/root", settings: {}, children: [{ id: "x", type: "xpo/nope", settings: {}, children: [] }] } } })).statusCode === 400);
await app.inject({ method: "PATCH", url: "/api/templates/" + tmpl.id, headers: auth, payload: { status: "live" } });
ok("header verschijnt op de doelpagina (conditie page)", (await app.inject({ method: "GET", url: "/site/smart-mirrors" })).body.includes("PROMOHEADERX"));
ok("header verschijnt NIET op een post (conditie matcht niet)", !(await app.inject({ method: "GET", url: "/blog/safety-instruction" })).body.includes("PROMOHEADERX"));
await app.inject({ method: "DELETE", url: "/api/templates/" + tmpl.id, headers: auth });

// ---- Webshop: widget, winkelwagen, checkout, betaling ----
const shopHtml = (await app.inject({ method: "GET", url: "/site/winkel" })).body;
ok("shop-widget rendert producten op de winkelpagina", shopHtml.includes('class="xpo-shop"') && shopHtml.includes("INVITE") && shopHtml.includes("In winkelwagen"));
ok("uitverkocht product zonder knop", shopHtml.includes("Uitverkocht"));
const shopProds = (await app.inject({ method: "GET", url: "/api/products", headers: auth })).json() as any[];
const invite = shopProds.find((p) => p.name === "INVITE");
const cart0 = (await app.inject({ method: "POST", url: "/api/cart" })).json();
ok("lege winkelwagen aangemaakt", !!cart0.id && cart0.total === "€0,00" && cart0.count === 0);
const cart1 = (await app.inject({ method: "POST", url: "/api/cart/" + cart0.id + "/items", payload: { productId: invite.id, qty: 1 } })).json();
ok("product toevoegen aan winkelwagen", cart1.count === 1 && cart1.total === "€2.490,00");
const cart2 = (await app.inject({ method: "PUT", url: "/api/cart/" + cart0.id + "/items/" + invite.id, payload: { qty: 2 } })).json();
ok("aantal bijwerken telt door", cart2.count === 2 && cart2.total === "€4.980,00");
ok("onbekend product weigeren", (await app.inject({ method: "POST", url: "/api/cart/" + cart0.id + "/items", payload: { productId: "999999", qty: 1 } })).statusCode === 400);
ok("checkout zonder klantgegevens => 400", (await app.inject({ method: "POST", url: "/api/checkout", payload: { cartId: cart0.id, customer: {} } })).statusCode === 400);
const emptyCart = (await app.inject({ method: "POST", url: "/api/cart" })).json();
ok("checkout met lege winkelwagen => 400", (await app.inject({ method: "POST", url: "/api/checkout", payload: { cartId: emptyCart.id, customer: { name: "X", email: "x@y.nl" } } })).statusCode === 400);
const checkout = (await app.inject({ method: "POST", url: "/api/checkout", payload: { cartId: cart0.id, customer: { name: "Mall Utrecht", email: "inkoop@mall.nl" } } })).json();
ok("checkout maakt order + betaling (lokale stub)", checkout.orderRef && checkout.paymentId && checkout.checkoutUrl.startsWith("/pay/") && checkout.status === "open" && checkout.total === "€4.980,00");
ok("order verschijnt bij commerce", ((await app.inject({ method: "GET", url: "/api/orders", headers: auth })).json() as any[]).some((o) => o.id === checkout.orderRef));
ok("betaling bevestigen => paid", (await app.inject({ method: "POST", url: "/api/payments/" + checkout.paymentId + "/confirm" })).json().status === "paid");
ok("betaling is paid", (await app.inject({ method: "GET", url: "/api/payments/" + checkout.paymentId })).json().status === "paid");
ok("order is paid na bevestiging", ((await app.inject({ method: "GET", url: "/api/orders", headers: auth })).json() as any[]).find((o) => o.id === checkout.orderRef).status === "paid");
ok("voorraad afgeboekt na betaling (12 → 10)", ((await app.inject({ method: "GET", url: "/api/products", headers: auth })).json() as any[]).find((p) => p.name === "INVITE").stock === 10);
ok("lokale betaalpagina-stub bereikbaar", (await app.inject({ method: "GET", url: "/pay/" + checkout.paymentId })).statusCode === 200);

// ---- WooCommerce: productpagina, categorieën, kortingscodes, BTW, bevestigingsmail ----
const prodPage = (await app.inject({ method: "GET", url: "/product/invite" })).body;
ok("productpagina toont detail (naam, prijs, beschrijving, knop)", prodPage.includes('class="xpo-product"') && prodPage.includes("INVITE") && prodPage.includes("\u20ac2.490") && prodPage.includes("Compacte staande") && prodPage.includes('class="pillbtn xsh-add"'));
ok("productpagina toont gerelateerde producten uit zelfde categorie", prodPage.includes("Vergelijkbare producten") && prodPage.includes("ARCADIA") && !prodPage.includes("SPHERIX"));
ok("onbekende productslug => 404", (await app.inject({ method: "GET", url: "/product/bestaat-niet" })).statusCode === 404);
const cv = (await app.inject({ method: "POST", url: "/api/coupons/validate", payload: { code: "WELKOM10" } })).json();
ok("geldige kortingscode valideert", cv.valid === true && cv.type === "percent" && cv.value === 10);
ok("onbekende kortingscode => valid:false", (await app.inject({ method: "POST", url: "/api/coupons/validate", payload: { code: "NIETBESTAAND" } })).json().valid === false);
const ccart = (await app.inject({ method: "POST", url: "/api/cart" })).json();
await app.inject({ method: "POST", url: "/api/cart/" + ccart.id + "/items", payload: { productId: invite.id, qty: 1 } });
const cco = (await app.inject({ method: "POST", url: "/api/checkout", payload: { cartId: ccart.id, customer: { name: "Klant", email: "koper@vb.nl" }, coupon: "WELKOM10" } })).json();
ok("checkout past kortingscode toe (10% van €2.490)", cco.coupon === "WELKOM10" && cco.discountCents === 24900 && cco.total === "\u20ac2.241,00");
ok("checkout geeft BTW-bedrag + tarief terug", cco.vatRate === 21 && typeof cco.vat === "string" && cco.vat.startsWith("\u20ac"));
await app.inject({ method: "POST", url: "/api/payments/" + cco.paymentId + "/confirm" });
await processJobsNow();
ok("orderbevestiging belandt in de outbox", ((await app.inject({ method: "GET", url: "/api/emails", headers: auth })).json() as any[]).some((m) => m.subject.includes("Bestelbevestiging") && m.to === "koper@vb.nl"));
const newC = await app.inject({ method: "POST", url: "/api/coupons", headers: auth, payload: { code: "TEST5", type: "fixed", value: 5 } });
ok("kortingscode aanmaken (admin) => 201", newC.statusCode === 201 && newC.json().code === "TEST5");
ok("nieuwe kortingscode is valideerbaar", (await app.inject({ method: "POST", url: "/api/coupons/validate", payload: { code: "TEST5" } })).json().type === "fixed");
ok("dubbele kortingscode => 409", (await app.inject({ method: "POST", url: "/api/coupons", headers: auth, payload: { code: "TEST5", type: "percent", value: 1 } })).statusCode === 409);

// ---- WooCommerce wave 2: variaties, reviews, verzending, refund, klanten, orderdetail ----
const vp = (await app.inject({ method: "POST", url: "/api/products", headers: auth, payload: { name: "Test Display", price: "\u20ac999", stock: 5, category: "displays", attributes: [{ name: "Maat", options: ["S", "M", "L"] }] } })).json();
ok("product met variaties aangemaakt", vp.attributes && vp.attributes[0].name === "Maat" && vp.attributes[0].options.length === 3);
const vpPage = (await app.inject({ method: "GET", url: "/product/test-display" })).body;
ok("productpagina toont variatie-selectors", vpPage.includes('class="xpr-attr"') && vpPage.includes("Maat") && vpPage.includes(">M<"));
// reviews
const rvPost = (await app.inject({ method: "POST", url: "/api/products/" + vp.id + "/reviews", payload: { author: "Sanne", rating: 5, body: "Top scherm, scherp beeld!" } })).json();
ok("review plaatsen => pending", rvPost.id && rvPost.status === "pending");
ok("review staat in moderatiewachtrij", ((await app.inject({ method: "GET", url: "/api/reviews", headers: auth })).json() as any[]).some((r) => r.id === rvPost.id));
await app.inject({ method: "POST", url: "/api/reviews/" + rvPost.id + "/approve", headers: auth });
const rvGet = (await app.inject({ method: "GET", url: "/api/products/" + vp.id + "/reviews" })).json();
ok("goedgekeurde review zichtbaar + gemiddelde", rvGet.stats.count === 1 && rvGet.stats.average === 5 && rvGet.list[0].body.includes("Top scherm"));
ok("productpagina toont reviews + gemiddelde", (await app.inject({ method: "GET", url: "/product/test-display" })).body.includes("Top scherm"));
// verzending in checkout
const ship = (await app.inject({ method: "GET", url: "/api/shipping" })).json();
ok("verzendmethoden beschikbaar", Array.isArray(ship) && ship.length > 0 && typeof ship[0].price === "number");
const vcart = (await app.inject({ method: "POST", url: "/api/cart" })).json();
await app.inject({ method: "POST", url: "/api/cart/" + vcart.id + "/items", payload: { productId: vp.id, qty: 1, variant: "Maat: M" } });
const vco = (await app.inject({ method: "POST", url: "/api/checkout", payload: { cartId: vcart.id, customer: { name: "Sanne Jansen", email: "sanne@vb.nl" }, shipping: "Standaard verzending" } })).json();
ok("checkout telt verzendkosten op", vco.shipping.name === "Standaard verzending" && vco.shipping.priceCents === 695 && vco.totalCents === 99900 + 695);
await app.inject({ method: "POST", url: "/api/payments/" + vco.paymentId + "/confirm" });
// orderdetail
const od = (await app.inject({ method: "GET", url: "/api/orders/" + vco.orderRef, headers: auth })).json();
ok("orderdetail toont items + variant", od.email === "sanne@vb.nl" && od.items.length === 1 && od.items[0].variant === "Maat: M");
// klanten
ok("klantenlijst aggregeert uit orders", ((await app.inject({ method: "GET", url: "/api/customers", headers: auth })).json() as any[]).some((c) => c.email === "sanne@vb.nl" && c.orders >= 1));
// refund
await app.inject({ method: "POST", url: "/api/orders/" + vco.orderRef + "/refund", headers: auth, payload: { restock: true } });
ok("order terugbetalen zet status op refunded", (await app.inject({ method: "GET", url: "/api/orders/" + vco.orderRef, headers: auth })).json().status === "refunded");
await app.inject({ method: "DELETE", url: "/api/products/" + vp.id, headers: auth });

// ---- slider / carousel ----
const slRoot = { id: "root", type: "core/root", settings: {}, children: [
  { id: "sl", type: "xpo/slider", settings: { autoplay: true, interval: 4, slides: [
    { image: "https://x/a.jpg", title: "SlideAlpha", text: "Eerste", btn: "Meer", url: "/site/contact" },
    { image: "", title: "SlideBeta", text: "Tweede" },
  ] }, children: [] },
] };
const slP = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "slider-demo", title: "Slider", blocks: slRoot } });
await app.inject({ method: "POST", url: "/api/pages/" + slP.json().id + "/publish", headers: auth });
const slHtml = (await app.inject({ method: "GET", url: "/site/slider-demo" })).body;
ok("slider gerenderd met autoplay + slides", slHtml.includes('class="xpo-slider"') && slHtml.includes('data-autoplay="4"') && slHtml.includes("SlideAlpha") && slHtml.includes("SlideBeta"));
ok("slider heeft navigatie + dots bij meerdere slides", slHtml.includes("xsl-prev") && slHtml.includes("xsl-dot"));
await app.inject({ method: "POST", url: "/api/pages/" + slP.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + slP.json().id + "?purge=1", headers: auth });

// ---- SEO: Open Graph / Twitter / canonical / robots ----
const seoRoot = { id: "root", type: "core/root", settings: {}, children: [{ id: "h", type: "xpo/heading", settings: { text: "SEO test" }, children: [] }] };
const seoP = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "seo-demo", title: "SEO test", blocks: seoRoot, seo: { title: "SEO Titel X", description: "Korte omschrijving Y", ogImage: "https://x/share.jpg", canonical: "https://xposcreens.com/seo-demo", noindex: false } } });
ok("SEO-velden opgeslagen", seoP.json().seo.ogImage === "https://x/share.jpg" && seoP.json().seo.canonical.includes("xposcreens"));
await app.inject({ method: "POST", url: "/api/pages/" + seoP.json().id + "/publish", headers: auth });
const seoHtml = (await app.inject({ method: "GET", url: "/site/seo-demo" })).body;
ok("meta description in kop", seoHtml.includes('<meta name="description" content="Korte omschrijving Y"'));
ok("Open Graph tags in kop", seoHtml.includes('property="og:title" content="SEO Titel X"') && seoHtml.includes('property="og:image" content="https://x/share.jpg"'));
ok("Twitter card (large image)", seoHtml.includes('name="twitter:card" content="summary_large_image"'));
ok("canonical link", seoHtml.includes('<link rel="canonical" href="https://xposcreens.com/seo-demo"'));
ok("robots index,follow standaard", seoHtml.includes('name="robots" content="index,follow"'));
// noindex variant
await app.inject({ method: "PUT", url: "/api/pages/" + seoP.json().id, headers: auth, payload: { slug: "seo-demo", title: "SEO test", blocks: seoRoot, seo: { title: "SEO Titel X", description: "Korte omschrijving Y", noindex: true } } });
await app.inject({ method: "POST", url: "/api/pages/" + seoP.json().id + "/publish", headers: auth });
ok("noindex schakelt robots om", (await app.inject({ method: "GET", url: "/site/seo-demo" })).body.includes('name="robots" content="noindex,nofollow"'));
await app.inject({ method: "POST", url: "/api/pages/" + seoP.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + seoP.json().id + "?purge=1", headers: auth });

// ---- e-mailverzending uit de bezorgwachtrij (log/outbox-modus) ----
await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { theme: { radius: 14, accent: "", mode: "dark", font: "" }, mail: { mode: "log", from: "noreply@xpo.nl" } } });
const mForm = (await app.inject({ method: "POST", url: "/api/forms", headers: auth, payload: { name: "Mailtest" } })).json();
await app.inject({ method: "PUT", url: "/api/forms/" + mForm.id, headers: auth, payload: { actions: [{ type: "email", enabled: true, target: "ops@xpo.nl" }] } });
await app.inject({ method: "POST", url: "/api/forms/" + mForm.id + "/submissions", headers: auth, payload: { data: { fld1: "KlantEmailX" } } });
const mDels = (await app.inject({ method: "GET", url: "/api/deliveries", headers: auth })).json() as any[];
const mDel = mDels.find((d) => d.type === "email" && d.status === "queued");
ok("e-mail-actie belandt in de wachtrij", !!mDel);
const proc = (await app.inject({ method: "POST", url: "/api/deliveries/process", headers: auth })).json();
ok("wachtrij verwerken verstuurt e-mail (log-modus)", proc.sent >= 1);
const outbox = (await app.inject({ method: "GET", url: "/api/emails", headers: auth })).json() as any[];
const mail = outbox.find((m) => m.to === "ops@xpo.nl");
ok("e-mail in outbox met juiste ontvanger + onderwerp", !!mail && mail.subject.includes("Mailtest") && mail.status === "sent");
ok("e-mailtekst bevat de inzending", mail.body.includes("KlantEmailX"));
ok("verwerkte bezorging staat op sent", ((await app.inject({ method: "GET", url: "/api/deliveries", headers: auth })).json() as any[]).find((d) => d.id === mDel.id).status === "sent");
await app.inject({ method: "DELETE", url: "/api/forms/" + mForm.id, headers: auth });

// ---- health / readiness ----
const health = (await app.inject({ method: "GET", url: "/api/health" })).json();
ok("health-endpoint meldt ok + db ok + versie", health.ok === true && health.db === "ok" && typeof health.version === "string");

// ---- media-opslag adapter (lokaal + Azure Blob met terugval) ----
const pngDataUrl = "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
ok("media-driver standaard lokaal", (await app.inject({ method: "GET", url: "/api/settings", headers: auth })).json().media.driver === "local");
await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { theme: { radius: 14, accent: "", mode: "dark", font: "" }, media: { driver: "blob", accountUrl: "", container: "media", sasToken: "" } } });
ok("media-driver op blob opgeslagen", (await app.inject({ method: "GET", url: "/api/settings", headers: auth })).json().media.driver === "blob");
const blobUp = (await app.inject({ method: "POST", url: "/api/media", headers: auth, payload: { name: "blobtest.png", dataUrl: pngDataUrl } })).json();
ok("blob-modus zonder dependency valt netjes terug op lokaal", typeof blobUp.url === "string" && blobUp.url.startsWith("/uploads/"));
await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { theme: { radius: 14, accent: "", mode: "dark", font: "" }, media: { driver: "local" } } });
ok("lokale modus levert /uploads-URL", (await app.inject({ method: "POST", url: "/api/media", headers: auth, payload: { name: "localtest.png", dataUrl: pngDataUrl } })).json().url.startsWith("/uploads/"));

// ---- Entra ID single sign-on (OIDC) ----
ok("authorize-URL bevat tenant, client_id, redirect, scope, state", (() => {
  const u = buildAuthorizeUrl({ enabled: true, tenantId: "contoso", clientId: "abc123", clientSecret: "", redirectUri: "https://cms/cb", defaultRole: "viewer", roleMap: {} }, "st8");
  return u.includes("login.microsoftonline.com/contoso/oauth2/v2.0/authorize") && u.includes("client_id=abc123") && u.includes("response_type=code") && u.includes("state=st8") && u.includes("scope=");
})());
ok("groep→rol-mapping kiest de hoogste rol", mapGroupsToRole(["grp-x", "grp-editors", "grp-admins"], { "grp-editors": "editor", "grp-admins": "admin" }, "viewer") === "admin");
ok("onbekende groepen vallen terug op standaardrol", mapGroupsToRole(["grp-onbekend"], { "grp-admins": "admin" }, "viewer") === "viewer");
const sso1 = ssoUpsertUser("xpo", "sso.user@xpo.nl", "SSO Gebruiker", "editor");
ok("SSO provisioning maakt een nieuwe gebruiker", sso1.email === "sso.user@xpo.nl" && sso1.role === "editor");
const usersAfter = (await app.inject({ method: "GET", url: "/api/users", headers: auth })).json() as any[];
ok("nieuwe SSO-gebruiker verschijnt in de lijst", usersAfter.some((u) => u.email === "sso.user@xpo.nl" && u.role.toLowerCase() === "editor"));
ssoUpsertUser("xpo", "sso.user@xpo.nl", "SSO Gebruiker", "admin");
ok("herhaalde SSO-login werkt de rol bij", ((await app.inject({ method: "GET", url: "/api/users", headers: auth })).json() as any[]).find((u) => u.email === "sso.user@xpo.nl").role.toLowerCase() === "admin");
ok("SSO-login geweigerd als uitgeschakeld", (await app.inject({ method: "GET", url: "/api/auth/sso/login" })).statusCode === 400);
await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { theme: { radius: 14, accent: "", mode: "dark", font: "" }, sso: { enabled: true, tenantId: "contoso", clientId: "abc123", redirectUri: "https://cms/cb", defaultRole: "viewer", roleMap: { "grp-admins": "admin" } } } });
const ssoLogin = await app.inject({ method: "GET", url: "/api/auth/sso/login" });
ok("SSO-login leidt door naar Microsoft (302)", ssoLogin.statusCode === 302 && String(ssoLogin.headers.location || "").includes("login.microsoftonline.com/contoso"));
ok("SSO-callback zonder code => 400", (await app.inject({ method: "GET", url: "/api/auth/sso/callback" })).statusCode === 400);
await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { theme: { radius: 14, accent: "", mode: "dark", font: "" }, sso: { enabled: false } } });

// ---- formulier-widget + publieke verzending ----
const wForm = (await app.inject({ method: "POST", url: "/api/forms", headers: auth, payload: { name: "Contactwidget" } })).json();
const fpRoot = { id: "root", type: "core/root", settings: {}, children: [{ id: "fw", type: "xpo/form", settings: { formId: wForm.id, submitLabel: "Verstuur nu" }, children: [] }] };
const fpP = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "contact-widget", title: "Contact", blocks: fpRoot } });
await app.inject({ method: "POST", url: "/api/pages/" + fpP.json().id + "/publish", headers: auth });
const fpHtml = (await app.inject({ method: "GET", url: "/site/contact-widget" })).body;
ok("formulier-widget rendert het formulier met velden", fpHtml.includes('class="xpo-form"') && fpHtml.includes('data-form="' + wForm.id + '"') && fpHtml.includes("Verstuur nu") && fpHtml.includes("xfm-i"));
const pubSubmit = await app.inject({ method: "POST", url: "/api/public/forms/" + wForm.id + "/submit", payload: { data: { fld1: "PublicTester" } } });
ok("publieke verzending maakt een inzending", pubSubmit.statusCode === 200 && !!pubSubmit.json().id);
ok("inzending is vastgelegd", (((await app.inject({ method: "GET", url: "/api/forms", headers: auth })).json() as any[]).find((f) => f.id === wForm.id)?.submissions || []).some((su: any) => JSON.stringify(su.data).includes("PublicTester")));
await app.inject({ method: "POST", url: "/api/pages/" + fpP.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + fpP.json().id + "?purge=1", headers: auth });
await app.inject({ method: "DELETE", url: "/api/forms/" + wForm.id, headers: auth });

// ---- publieke zoekpagina + zoek-widget ----
const zHtml = (await app.inject({ method: "GET", url: "/zoeken?q=winkel" })).body;
ok("zoekpagina toont resultaten met links", zHtml.includes("Zoekresultaten voor") && zHtml.includes("/site/winkel"));
ok("zoekpagina bevat een zoek-widget", zHtml.includes('class="xpo-search"'));
ok("zoekpagina zonder term toont hint", (await app.inject({ method: "GET", url: "/zoeken" })).body.includes("Typ een zoekterm"));

// ---- blog-index + archieven (categorie/tag/auteur) met paginering ----
const arcBlogHtml = (await app.inject({ method: "GET", url: "/blog" })).body;
ok("blog-index toont posts", arcBlogHtml.includes('class="xpo-posts"') && arcBlogHtml.includes("Visitor information") && arcBlogHtml.includes("/blog/visitor-information"));
const a1 = postArchive("xpo", { perPage: 1, page: 1 });
ok("paginering verdeelt posts over pagina's", a1.pages === 2 && a1.items.length === 1);
const a2 = postArchive("xpo", { perPage: 1, page: 2 });
ok("tweede pagina geeft de volgende post", a2.page === 2 && a2.items.length === 1 && a2.items[0].url !== a1.items[0].url);
const catHtml = (await app.inject({ method: "GET", url: "/categorie/solutions" })).body;
ok("categorie-archief filtert op categorie", catHtml.includes("Categorie: Solutions") && catHtml.includes("/blog/"));
const auteurHtml = (await app.inject({ method: "GET", url: "/auteur/" + authorSlug("admin@xpo.nl") })).body;
ok("auteur-archief toont posts van de auteur", auteurHtml.includes("Auteur:") && auteurHtml.includes("/blog/"));
ok("blog-index met te hoge paginanummer klemt netjes", (await app.inject({ method: "GET", url: "/blog?page=99" })).statusCode === 200);

// ---- reactie-threads + notificatie ----
const cmRoot = { id: "root", type: "core/root", settings: {}, children: [{ id: "h", type: "xpo/heading", settings: { text: "Reactietest" }, children: [] }] };
const cmPost = (await app.inject({ method: "POST", url: "/api/posts", headers: auth, payload: { slug: "reactie-test", title: "Reactietest", blocks: cmRoot } })).json();
await app.inject({ method: "POST", url: "/api/posts/" + cmPost.id + "/publish", headers: auth });
const top = (await app.inject({ method: "POST", url: "/api/posts/" + cmPost.id + "/comments", payload: { author: "Jan", body: "Sterk artikel!" } })).json();
ok("publieke reactie belandt op pending", top.id && top.status === "pending");
await app.inject({ method: "POST", url: "/api/comments/" + top.id + "/approve", headers: auth });
const reply = (await app.inject({ method: "POST", url: "/api/posts/" + cmPost.id + "/comments", payload: { author: "Piet", body: "Helemaal mee eens", parentId: top.id } })).json();
await app.inject({ method: "POST", url: "/api/comments/" + reply.id + "/approve", headers: auth });
const cmList = (await app.inject({ method: "GET", url: "/api/posts/" + cmPost.id + "/comments" })).json() as any[];
ok("antwoord bewaart de parent-koppeling", cmList.some((c) => c.id === reply.id && c.parentId === top.id));
const cmHtml = (await app.inject({ method: "GET", url: "/blog/reactie-test" })).body;
ok("geneste reactie wordt ingesprongen weergegeven", cmHtml.includes("xcm-sub") && cmHtml.includes("Sterk artikel!") && cmHtml.includes("Helemaal mee eens"));
await processJobsNow();
ok("nieuwe reactie stuurt een notificatie naar de outbox", ((await app.inject({ method: "GET", url: "/api/emails", headers: auth })).json() as any[]).some((m) => m.subject.includes("Nieuwe reactie")));
await app.inject({ method: "POST", url: "/api/posts/" + cmPost.id + "/trash", headers: auth });

// ---- front-end klantaccounts (los van admin) ----
ok("registratie met zwak wachtwoord => 400", (await app.inject({ method: "POST", url: "/api/public/register", payload: { email: "klant@vb.nl", password: "kort" } })).statusCode === 400);
const reg = await app.inject({ method: "POST", url: "/api/public/register", payload: { name: "Klant Een", email: "klant@vb.nl", password: "geheim123" } });
ok("registratie maakt een account + cookie", reg.statusCode === 200 && String(reg.headers["set-cookie"] || "").includes("xpo_member="));
ok("dubbele registratie => 409", (await app.inject({ method: "POST", url: "/api/public/register", payload: { email: "klant@vb.nl", password: "geheim123" } })).statusCode === 409);
const memberCookie = String(reg.headers["set-cookie"] || "").split(";")[0];
const memberToken = decodeURIComponent(memberCookie.split("=")[1] || "");
ok("ingelogd lid kan profiel opvragen", (await app.inject({ method: "GET", url: "/api/public/me", headers: { cookie: memberCookie } })).json().email === "klant@vb.nl");
ok("zonder cookie geen profiel => 401", (await app.inject({ method: "GET", url: "/api/public/me" })).statusCode === 401);
ok("verkeerd wachtwoord => 401", (await app.inject({ method: "POST", url: "/api/public/login", payload: { email: "klant@vb.nl", password: "fout" } })).statusCode === 401);
ok("juiste login => 200 + cookie", (await app.inject({ method: "POST", url: "/api/public/login", payload: { email: "klant@vb.nl", password: "geheim123" } })).statusCode === 200);
ok("accountpagina (uitgelogd) toont inlog/registratie", (await app.inject({ method: "GET", url: "/account" })).body.includes("Inloggen") && (await app.inject({ method: "GET", url: "/account" })).body.includes("Account aanmaken"));
ok("accountpagina (ingelogd) toont profiel + bestellingen", (await app.inject({ method: "GET", url: "/account", headers: { cookie: memberCookie } })).body.includes("Welkom") && (await app.inject({ method: "GET", url: "/account", headers: { cookie: memberCookie } })).body.includes("Bestellingen"));
ok("VEILIG: leden-token werkt NIET als admin-token", (await app.inject({ method: "GET", url: "/api/leads", headers: { authorization: "Bearer " + memberToken } })).statusCode === 401);

// ---- custom post types ----
ok("standaard contenttype 'post' aanwezig", ((await app.inject({ method: "GET", url: "/api/content-types" })).json() as any[]).some((t) => t.key === "post" && t.slugBase === "blog"));
await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { theme: { radius: 14, accent: "", mode: "dark", font: "" }, contentTypes: [{ key: "post", singular: "Post", plural: "Posts", slugBase: "blog", archive: true }, { key: "case", singular: "Case", plural: "Cases", slugBase: "cases", archive: true }] } });
ok("nieuw contenttype 'case' geregistreerd", ((await app.inject({ method: "GET", url: "/api/content-types" })).json() as any[]).some((t) => t.key === "case" && t.plural === "Cases"));
const ctRoot = { id: "root", type: "core/root", settings: {}, children: [{ id: "h", type: "xpo/heading", settings: { text: "Case A" }, children: [] }] };
const casePost = (await app.inject({ method: "POST", url: "/api/posts", headers: auth, payload: { slug: "case-alpha", title: "Case Alpha", type: "case", blocks: ctRoot } })).json();
ok("post aangemaakt met type 'case'", casePost.type === "case");
await app.inject({ method: "POST", url: "/api/posts/" + casePost.id + "/publish", headers: auth });
const caseArc = (await app.inject({ method: "GET", url: "/type/case" })).body;
ok("type-archief toont alleen items van dat type", caseArc.includes("Cases") && caseArc.includes("/blog/case-alpha"));
const blogArc = (await app.inject({ method: "GET", url: "/blog" })).body;
ok("blog-index sluit andere contenttypes uit", !blogArc.includes("/blog/case-alpha"));
await app.inject({ method: "POST", url: "/api/posts/" + casePost.id + "/trash", headers: auth });

// ---- RSS-feed + robots.txt ----
const feed = await app.inject({ method: "GET", url: "/feed.xml" });
ok("RSS-feed is geldige RSS met items", feed.statusCode === 200 && feed.body.includes("<rss version=\"2.0\"") && feed.body.includes("<item>"));
const robots = await app.inject({ method: "GET", url: "/robots.txt" });
ok("robots.txt verwijst naar sitemap en sluit /admin uit", robots.body.includes("Sitemap:") && robots.body.includes("Disallow: /admin/"));

// ---- Elementor Pro widgets + dynamic tags + context ----
const year = String(new Date().getFullYear());
const elRoot = { id: "root", type: "core/root", settings: {}, children: [
  { id: "dt", type: "xpo/heading", settings: { text: "{{year}} {{site}}", level: "h2" }, children: [] },
  { id: "dt2", type: "xpo/text", settings: { body: "Welkom op {{title}}." }, children: [] },
  { id: "il", type: "xpo/icon-list", settings: { icon: "\u2713", items: [{ text: "Punt een" }, { text: "Punt twee" }] }, children: [] },
  { id: "bq", type: "xpo/blockquote", settings: { text: "Een mooi citaat", author: "Marijn" }, children: [] },
  { id: "fb", type: "xpo/flipbox", settings: { frontTitle: "Voor", backTitle: "Achter" }, children: [] },
  { id: "sh", type: "xpo/share", settings: { networks: ["twitter", "linkedin"] }, children: [] },
  { id: "ah", type: "xpo/animated-heading", settings: { prefix: "Wij maken", words: [{ w: "impact" }, { w: "beleving" }] }, children: [] },
  { id: "toc", type: "xpo/toc", settings: { title: "Inhoud" }, children: [] },
  { id: "mn", type: "xpo/menu", settings: { items: [] }, children: [] },
  { id: "bc", type: "xpo/breadcrumbs", settings: {}, children: [] },
] };
const elP = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "widgettest", title: "Widgettest", blocks: elRoot } });
await app.inject({ method: "POST", url: "/api/pages/" + elP.json().id + "/publish", headers: auth });
const elHtml = (await app.inject({ method: "GET", url: "/site/widgettest" })).body;
ok("dynamic tag {{year}} ingevuld + geen ruwe token", elHtml.includes(year) && !elHtml.includes("{{year}}") && !elHtml.includes("{{site}}"));
ok("dynamic tag {{title}} = paginatitel", elHtml.includes("Welkom op Widgettest."));
ok("icoonlijst gerenderd", elHtml.includes('class="xpo-iconlist"') && elHtml.includes("Punt een"));
ok("citaat gerenderd met bron", elHtml.includes('class="xpo-quote"') && elHtml.includes("Marijn"));
ok("flip-box gerenderd", elHtml.includes('class="xpo-flip"') && elHtml.includes("Achter"));
ok("deel-knoppen gerenderd", elHtml.includes("data-share") && elHtml.includes('data-net="twitter"'));
ok("animatie-kop met woorden", elHtml.includes("xah-rot") && elHtml.includes("impact"));
ok("inhoudsopgave gerenderd", elHtml.includes("data-toc"));
ok("menu-widget vult zich uit de navigatie", elHtml.includes('class="xpo-menu"') && elHtml.includes("<a"));
ok("kruimelpad uit context (Home + paginatitel)", elHtml.includes('class="xpo-crumbs"') && elHtml.includes("Home") && elHtml.includes("Widgettest"));
await app.inject({ method: "POST", url: "/api/pages/" + elP.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + elP.json().id + "?purge=1", headers: auth });
// context-widgets op een post: auteur-box + post-navigatie
const pnRoot = { id: "root", type: "core/root", settings: {}, children: [
  { id: "ph", type: "xpo/heading", settings: { text: "Post Een" }, children: [] },
  { id: "au", type: "xpo/author", settings: { name: "", bio: "" }, children: [] },
  { id: "pn", type: "xpo/post-nav", settings: {}, children: [] },
] };
const pA = (await app.inject({ method: "POST", url: "/api/posts", headers: auth, payload: { slug: "ctx-alpha", title: "Ctx Alpha", author: "Redactie", blocks: pnRoot } })).json();
const pB = (await app.inject({ method: "POST", url: "/api/posts", headers: auth, payload: { slug: "ctx-bravo", title: "Ctx Bravo", author: "Redactie", blocks: pnRoot } })).json();
await app.inject({ method: "POST", url: "/api/posts/" + pA.id + "/publish", headers: auth });
await app.inject({ method: "POST", url: "/api/posts/" + pB.id + "/publish", headers: auth });
const pnHtml = (await app.inject({ method: "GET", url: "/blog/ctx-alpha" })).body;
ok("auteur-box vult de auteur uit context", pnHtml.includes('class="xpo-author"') && pnHtml.includes("Redactie"));
ok("post-navigatie toont een naburige post", pnHtml.includes('class="xpo-postnav"') && pnHtml.includes("/blog/ctx-"));
await app.inject({ method: "POST", url: "/api/posts/" + pA.id + "/trash", headers: auth });
await app.inject({ method: "POST", url: "/api/posts/" + pB.id + "/trash", headers: auth });

// ---- scroll-entree-animatie (_adv.reveal) ----
const rvRoot = { id: "root", type: "core/root", settings: { _adv: { reveal: "up" } }, children: [{ id: "rh", type: "xpo/heading", settings: { text: "Animatie", _adv: { reveal: "zoom" } }, children: [] }] };
const rvP = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "reveal-test", title: "Reveal", blocks: rvRoot } });
await app.inject({ method: "POST", url: "/api/pages/" + rvP.json().id + "/publish", headers: auth });
const rvHtml = (await app.inject({ method: "GET", url: "/site/reveal-test" })).body;
ok("entree-animatie zet reveal-klasse + data-attribuut", rvHtml.includes('data-reveal="zoom"') && rvHtml.includes("reveal-zoom"));
await app.inject({ method: "POST", url: "/api/pages/" + rvP.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + rvP.json().id + "?purge=1", headers: auth });

// ---- ACF: custom fields invullen, binden via tags, repeater + select ----
const fg = (await app.inject({ method: "POST", url: "/api/field-groups", headers: auth, payload: { name: "Productinfo", location: "Alle pagina's" } })).json();
await app.inject({ method: "PUT", url: "/api/field-groups/" + fg.id, headers: auth, payload: { name: "Productinfo", location: "Alle pagina's", fields: [
  { id: "f_sub", label: "Ondertitel", type: "text" },
  { id: "f_status", label: "Status", type: "select", options: ["Nieuw", "Actie"] },
  { id: "f_rep", label: "Kenmerken", type: "repeater" },
] } });
const acfFg = ((await app.inject({ method: "GET", url: "/api/field-groups", headers: auth })).json() as any[]).find((g) => g.id === fg.id);
ok("veldgroep bewaart select-opties + repeater-type", acfFg.fields.find((f: any) => f.id === "f_status").options.length === 2 && acfFg.fields.some((f: any) => f.type === "repeater"));
const acfRoot = { id: "root", type: "core/root", settings: {}, children: [
  { id: "h", type: "xpo/heading", settings: { text: "Onze display \u2014 {{field:f_sub}}", level: "h2" }, children: [] },
  { id: "t", type: "xpo/text", settings: { body: "Kenmerken: {{field:kenmerken}}." }, children: [] },
] };
const acfPage = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "acf-test", title: "ACF", blocks: acfRoot, meta: { f_sub: "De beste keuze", f_status: "Actie", f_rep: ["Lichtgewicht", "Energiezuinig"] } } });
await app.inject({ method: "POST", url: "/api/pages/" + acfPage.json().id + "/publish", headers: auth });
const acfHtml = (await app.inject({ method: "GET", url: "/site/acf-test" })).body;
ok("field-tag {{field:<id>}} ingevuld in kop", acfHtml.includes("Onze display \u2014 De beste keuze") && !acfHtml.includes("{{field"));
ok("field-tag via label-slug + repeater samengevoegd", acfHtml.includes("Kenmerken: Lichtgewicht, Energiezuinig."));
ok("specs-blok toont select- en repeater-waarden", acfHtml.includes("Actie") && acfHtml.includes('class="xpo-specs"') && acfHtml.includes("Energiezuinig"));
await app.inject({ method: "POST", url: "/api/pages/" + acfPage.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + acfPage.json().id + "?purge=1", headers: auth });
await app.inject({ method: "DELETE", url: "/api/field-groups/" + fg.id, headers: auth });

// ---- nieuwe Elementor-widgets (icoon, counter, sterren, alert, tabel, prijslijst, audio, hotspots, lottie, login, loop) ----
const w2Root = { id: "root", type: "core/root", settings: {}, children: [
  { id: "ic", type: "xpo/icon", settings: { icon: "\u2728", size: 48, color: "#5F8D7A" }, children: [] },
  { id: "co", type: "xpo/counter", settings: { value: 1200, suffix: "+", label: "Klanten" }, children: [] },
  { id: "ra", type: "xpo/rating", settings: { value: 4.5, max: 5 }, children: [] },
  { id: "al", type: "xpo/alert", settings: { type: "success", title: "Gelukt", body: "Opgeslagen", dismissible: true }, children: [] },
  { id: "ta", type: "xpo/table", settings: { headers: "Kenmerk, Waarde", rows: [["Formaat", "55\""], ["Resolutie", "4K"]] }, children: [] },
  { id: "pl", type: "xpo/pricelist", settings: { items: [{ name: "Basis", description: "Instap", price: "\u20ac499" }] }, children: [] },
  { id: "au", type: "xpo/audio", settings: { src: "/uploads/demo.mp3" }, children: [] },
  { id: "ho", type: "xpo/hotspots", settings: { image: "/uploads/plan.jpg", points: [{ x: 30, y: 40, label: "Hier", text: "Detail" }] }, children: [] },
  { id: "lo", type: "xpo/lottie", settings: { src: "https://example.com/a.json" }, children: [] },
  { id: "lg", type: "xpo/login", settings: { title: "Inloggen" }, children: [] },
  { id: "lp", type: "xpo/loop", settings: { source: "products", limit: 3, columns: 3, showButton: true }, children: [] },
] };
const w2P = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "widgets2", title: "Widgets2", blocks: w2Root } });
await app.inject({ method: "POST", url: "/api/pages/" + w2P.json().id + "/publish", headers: auth });
const w2 = (await app.inject({ method: "GET", url: "/site/widgets2" })).body;
ok("icoon-widget gerenderd", w2.includes('class="xpo-icon"') && w2.includes("\u2728"));
ok("counter-widget met data-to", w2.includes('class="xct-num"') && w2.includes('data-to="1200"'));
ok("sterbeoordeling gerenderd", w2.includes('class="xpo-rating"') && w2.includes("xrt-s"));
ok("alert-widget (success, sluitbaar)", w2.includes("xal-success") && w2.includes("xal-x") && w2.includes("Gelukt"));
ok("tabel-widget met koppen + rijen", w2.includes('class="xpo-table"') && w2.includes("<th>Kenmerk</th>") && w2.includes("4K"));
ok("prijslijst gerenderd", w2.includes('class="xpo-pricelist"') && w2.includes("Basis") && w2.includes("\u20ac499"));
ok("audio-widget gerenderd", w2.includes('class="xpo-audio"') && w2.includes("<audio"));
ok("hotspots-widget met punt", w2.includes('class="xpo-hotspots"') && w2.includes("xhs-dot") && w2.includes("Detail"));
ok("lottie-widget met data-lottie", w2.includes('class="xpo-lottie"') && w2.includes("data-lottie="));
ok("login-widget gerenderd", w2.includes("data-login") && w2.includes("xlg-form"));
ok("loop-grid rendert productkaarten", w2.includes('class="xpo-loop"') && w2.includes("xlp-card") && (w2.match(/xlp-card/g) || []).length >= 2);
await app.inject({ method: "POST", url: "/api/pages/" + w2P.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + w2P.json().id + "?purge=1", headers: auth });

// ---- RankMath-achtige SEO-analyse ----
const seoAnRoot = { id: "root", type: "core/root", settings: {}, children: [
  { id: "h", type: "xpo/heading", settings: { text: "Digitale signage voor retail", level: "h2" }, children: [] },
  { id: "t1", type: "xpo/text", settings: { body: "Onze digitale signage displays maken direct indruk in elke ruimte. Met digitale signage bereik je meer bezoekers en stuur je content centraal aan." }, children: [] },
  { id: "img", type: "xpo/image", settings: { src: "/uploads/scherm.jpg", alt: "Digitale signage scherm in een winkel" }, children: [] },
  { id: "b", type: "xpo/button", settings: { label: "Neem contact op", url: "/site/contact" }, children: [] },
] };
const seoAnPg = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "digitale-signage", title: "Digitale signage displays", blocks: seoAnRoot, seo: { title: "Digitale signage displays \u2014 XPO", description: "Ontdek onze digitale signage oplossingen voor retail en horeca met heldere schermen en centraal beheer.", keyword: "digitale signage" } } });
const seoAn = (await app.inject({ method: "POST", url: "/api/seo/analyze", headers: auth, payload: { pageId: seoAnPg.json().id } })).json();
const seoChk = (label: string) => seoAn.checks.find((c: any) => c.label.startsWith(label));
ok("SEO-analyse berekent woorden + dichtheid", seoAn.stats.keyword === "digitale signage" && seoAn.stats.words > 10 && seoAn.stats.density > 0);
ok("SEO-analyse: keyword in titel/URL/kop herkend", seoChk("Focuskeyword in SEO-titel").ok && seoChk("Focuskeyword in URL").ok && seoChk("Focuskeyword in een kop").ok);
ok("SEO-analyse: keyword in eerste alinea + tekst", seoChk("Focuskeyword in eerste alinea").ok && seoChk("Focuskeyword in tekst").ok);
ok("SEO-analyse: alt-tekst + interne link gecontroleerd", seoChk("Alle afbeeldingen hebben alt-tekst").ok && seoChk("Minstens \u00e9\u00e9n interne link").ok);
ok("SEO-analyse geeft leesbaarheidsscore", typeof seoAn.stats.readability === "number" && typeof seoAn.stats.readabilityLabel === "string");
ok("SEO-analyse geeft totaalscore 0-100", typeof seoAn.score === "number" && seoAn.score >= 0 && seoAn.score <= 100);
const seoAnNoKw = (await app.inject({ method: "POST", url: "/api/seo/analyze", headers: auth, payload: { pageId: seoAnPg.json().id, keyword: "" } })).json();
ok("SEO-analyse meldt ontbrekend focuskeyword", seoAnNoKw.checks.some((c: any) => c.label === "Focuskeyword ingesteld" && !c.ok));
await app.inject({ method: "POST", url: "/api/pages/" + seoAnPg.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + seoAnPg.json().id + "?purge=1", headers: auth });

// ---- Analytics: echte pageview-tracking + overzicht ----
const tr1 = await app.inject({ method: "POST", url: "/api/track", payload: { path: "/site" } });
ok("tracking-beacon => 204 + zet sessie-cookie", tr1.statusCode === 204 && String(tr1.headers["set-cookie"] || "").includes("xpo_v="));
const vcookie = String(tr1.headers["set-cookie"] || "").split(";")[0];
await app.inject({ method: "POST", url: "/api/track", headers: { cookie: vcookie }, payload: { path: "/site" } });
await app.inject({ method: "POST", url: "/api/track", headers: { cookie: vcookie }, payload: { path: "/blog" } });
ok("tracking negeert admin-paden", (await app.inject({ method: "POST", url: "/api/track", payload: { path: "/admin/x" } })).statusCode === 204);
const ov = (await app.inject({ method: "GET", url: "/api/analytics/overview", headers: auth })).json();
ok("analytics-overzicht telt weergaven + bezoekers", ov.totals.viewsAll >= 3 && ov.totals.views7 >= 3 && ov.totals.sessions7 >= 1);
ok("analytics-overzicht geeft 8 weekbuckets", Array.isArray(ov.weeks) && ov.weeks.length === 8);
ok("analytics-overzicht toont toppagina's", ov.topPages.some((t: any) => t.path === "/site") && ov.topPages.find((t: any) => t.path === "/site").views >= 2);
ok("publieke pagina bevat tracking-beacon", (await app.inject({ method: "GET", url: "/site" })).body.includes("/api/track"));

// ---- dark/light thema-switch ----
const siteHtml = (await app.inject({ method: "GET", url: "/site" })).body;
ok("front-end heeft 1-klik thema-knop", siteHtml.includes("data-theme-toggle") && siteHtml.includes('class="xpo-theme-toggle"'));
ok("geen-flits thema-script aanwezig", siteHtml.includes('localStorage.getItem("xpo-theme")') && siteHtml.includes("data-default-theme"));
ok("light-mode CSS-variabelen aanwezig", siteHtml.includes("html[data-theme=light]") && siteHtml.includes("--bg:") && siteHtml.includes("--btn-bg"));
ok("standaardthema = donker (instelling)", siteHtml.includes('data-default-theme="dark"'));
await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { theme: { mode: "light", radius: 14, accent: "", font: "" } } });
ok("standaardthema volgt instelling (light)", (await app.inject({ method: "GET", url: "/site" })).body.includes('data-default-theme="light"'));
await app.inject({ method: "PUT", url: "/api/settings", headers: auth, payload: { theme: { mode: "dark", radius: 14, accent: "", font: "" } } });
const ttRoot = { id: "root", type: "core/root", settings: {}, children: [{ id: "tt", type: "xpo/theme-toggle", settings: { labelLight: "Licht", labelDark: "Donker" }, children: [] }] };
const ttP = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "thema", title: "Thema", blocks: ttRoot } });
await app.inject({ method: "POST", url: "/api/pages/" + ttP.json().id + "/publish", headers: auth });
ok("theme-toggle widget rendert in content", (await app.inject({ method: "GET", url: "/site/thema" })).body.includes("xtt-inline") && (await app.inject({ method: "GET", url: "/site/thema" })).body.includes("data-theme-toggle"));
await app.inject({ method: "POST", url: "/api/pages/" + ttP.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + ttP.json().id + "?purge=1", headers: auth });

// ---- STUDIO: per-element stijl-rendering (achtergrond, typografie, rand, responsive) ----
const styRoot: any = { type: "core/root", id: "r", settings: {}, children: [
  { type: "xpo/text", id: "sb1", settings: { body: "x", _style: { borderW: 2, borderColor: "#ffffff", borderStyle: "dashed", bg: "gradient", gradFrom: "#111111", gradTo: "#222222", fontSize: 22, textColor: "#ff0000", padT: 12, padM: 8 } }, children: [] },
] };
const styCss = collectStyleCss(styRoot);
ok("rand-stijl gerenderd in CSS (border)", /border:2px dashed #ffffff/.test(styCss));
ok("gradient-achtergrond gerenderd", /linear-gradient\(135deg,#111111,#222222\)/.test(styCss));
ok("typografie gerenderd (font-size + tekstkleur)", /font-size:22px/.test(styCss) && /color:#ff0000 !important/.test(styCss));
ok("responsive overrides gerenderd (tablet + mobiel media queries)", /max-width:1024px/.test(styCss) && /max-width:640px/.test(styCss) && /padding:12px/.test(styCss) && /padding:8px/.test(styCss));
const padNode: any = { type: "xpo/text", id: "pb", settings: { body: "x", _style: { pad: { t: 10, r: 20, b: 30, l: 40 }, padT: { t: 5, r: 6, b: 7, l: 8 } } }, children: [] };
ok("4-zijdige padding (desktop) gerenderd", /padding:10px 20px 30px 40px/.test(renderNode(padNode)));
ok("4-zijdige padding responsive (tablet) gerenderd", /padding:5px 6px 7px 8px/.test(collectStyleCss({ type: "core/root", id: "r2", settings: {}, children: [padNode] } as any)));
// media-upload: video (mp4) toegestaan met geldige magic-bytes; vermomd bestand geweigerd
const okMp4 = await app.inject({ method: "POST", url: "/api/media", headers: auth, payload: { name: "clip.mp4", dataUrl: "data:video/mp4;base64,AAAAGGZ0eXBpc29t" } });
ok("video-upload (mp4) toegestaan", okMp4.statusCode === 200 && /\.mp4$/.test(okMp4.json().url || ""));
const badMp4 = await app.inject({ method: "POST", url: "/api/media", headers: auth, payload: { name: "nep.mp4", dataUrl: "data:video/mp4;base64,AAAAAAAAAAAAAAAA" } });
ok("vermomd video-bestand geweigerd (magic-bytes)", badMp4.statusCode === 400);
// ---- PAGINA-INSTELLINGEN: zichtbaarheid (privé/wachtwoord), uitgelichte afbeelding, menu-volgorde ----
const blk = (t: string) => ({ id: "root", type: "core/root", settings: {}, children: [{ id: "h", type: "xpo/heading", settings: { text: t, level: "h2" } }] });
const privP = (await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "prive-test", title: "Privé", blocks: blk("Geheim") } })).json();
const privUpd = (await app.inject({ method: "PUT", url: "/api/pages/" + privP.id, headers: auth, payload: { slug: "prive-test", title: "Privé", visibility: "private", featuredImage: "/uploads/x.jpg", menuOrder: 5, excerpt: "Kort", blocks: privP.blocks } })).json();
await app.inject({ method: "POST", url: "/api/pages/" + privP.id + "/publish", headers: auth });
ok("privé-pagina niet publiek bereikbaar (404)", (await app.inject({ method: "GET", url: "/site/prive-test" })).statusCode === 404);
ok("uitgelichte afbeelding + menu-volgorde + excerpt opgeslagen", privUpd.featuredImage === "/uploads/x.jpg" && privUpd.menuOrder === 5 && privUpd.excerpt === "Kort");
const pwP = (await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "pw-test", title: "Beveiligd", blocks: blk("Achter wachtwoord") } })).json();
await app.inject({ method: "PUT", url: "/api/pages/" + pwP.id, headers: auth, payload: { slug: "pw-test", title: "Beveiligd", visibility: "password", password: "geheim123", blocks: pwP.blocks } });
await app.inject({ method: "POST", url: "/api/pages/" + pwP.id + "/publish", headers: auth });
const gate = await app.inject({ method: "GET", url: "/site/pw-test" });
ok("wachtwoord-pagina toont gate, geen inhoud (401)", gate.statusCode === 401 && !gate.body.includes("Achter wachtwoord") && /wachtwoord/i.test(gate.body));
const unlocked = await app.inject({ method: "GET", url: "/site/pw-test?pw=geheim123" });
ok("juist wachtwoord ontgrendelt de inhoud", unlocked.statusCode === 200 && unlocked.body.includes("Achter wachtwoord"));

// ---- WEBSHOP: betalingen, voorraad, varianten, BTW/verzending, factuur ----
const allProds = (await app.inject({ method: "GET", url: "/api/products", headers: auth })).json() as any[];
const inviteP = allProds.find((p) => p.name === "INVITE");
// voorraadreservering + oversell-bescherming
const lp = (await app.inject({ method: "POST", url: "/api/products", headers: auth, payload: { name: "Schaars Display", price: "€1.000", stock: 2, category: "displays" } })).json();
const lc1 = (await app.inject({ method: "POST", url: "/api/cart" })).json();
await app.inject({ method: "POST", url: "/api/cart/" + lc1.id + "/items", payload: { productId: lp.id, qty: 2 } });
const lco1 = await app.inject({ method: "POST", url: "/api/checkout", payload: { cartId: lc1.id, customer: { name: "A", email: "a@x.nl" } } });
ok("checkout slaagt + reserveert voorraad", lco1.statusCode === 200);
ok("voorraad gereserveerd bij checkout (2 → 0)", ((await app.inject({ method: "GET", url: "/api/products", headers: auth })).json() as any[]).find((p) => p.id === lp.id).stock === 0);
const lc2 = (await app.inject({ method: "POST", url: "/api/cart" })).json();
await app.inject({ method: "POST", url: "/api/cart/" + lc2.id + "/items", payload: { productId: lp.id, qty: 1 } });
ok("oversell geweigerd (409)", (await app.inject({ method: "POST", url: "/api/checkout", payload: { cartId: lc2.id, customer: { name: "B", email: "b@x.nl" } } })).statusCode === 409);
// factuurnummering + factuur-PDF
await app.inject({ method: "POST", url: "/api/payments/" + lco1.json().paymentId + "/confirm" });
const lord = (await app.inject({ method: "GET", url: "/api/orders/" + lco1.json().orderRef, headers: auth })).json();
ok("factuurnummer toegekend bij betaling", /^XPO-\d{4}-\d{5}$/.test(lord.invoiceNo));
const invRes = await app.inject({ method: "GET", url: "/api/orders/" + lco1.json().orderRef + "/invoice", headers: auth });
ok("BTW-factuur als PDF gegenereerd", invRes.statusCode === 200 && String(invRes.headers["content-type"] || "").includes("pdf") && invRes.rawPayload.slice(0, 5).toString() === "%PDF-");
// Mollie-webhook idempotentie + statusmachine
const wc = (await app.inject({ method: "POST", url: "/api/cart" })).json();
await app.inject({ method: "POST", url: "/api/cart/" + wc.id + "/items", payload: { productId: inviteP.id, qty: 1 } });
const wco = (await app.inject({ method: "POST", url: "/api/checkout", payload: { cartId: wc.id, customer: { name: "W", email: "w@x.nl" } } })).json();
const wh1 = (await app.inject({ method: "POST", url: "/api/webhooks/mollie", payload: { id: wco.paymentId, status: "paid" } })).json();
ok("Mollie-webhook verwerkt betaling", wh1.status === "paid" && wh1.changed === true);
ok("webhook idempotent (geen dubbele verwerking)", (await app.inject({ method: "POST", url: "/api/webhooks/mollie", payload: { id: wco.paymentId, status: "paid" } })).json().changed === false);
// verlopen betaling geeft voorraad terug
const stockBefore = ((await app.inject({ method: "GET", url: "/api/products", headers: auth })).json() as any[]).find((p) => p.id === inviteP.id).stock;
const ec = (await app.inject({ method: "POST", url: "/api/cart" })).json();
await app.inject({ method: "POST", url: "/api/cart/" + ec.id + "/items", payload: { productId: inviteP.id, qty: 1 } });
const eco = (await app.inject({ method: "POST", url: "/api/checkout", payload: { cartId: ec.id, customer: { name: "E", email: "e@x.nl" } } })).json();
await app.inject({ method: "POST", url: "/api/webhooks/mollie", payload: { id: eco.paymentId, status: "expired" } });
ok("verlopen betaling geeft voorraad terug", ((await app.inject({ method: "GET", url: "/api/products", headers: auth })).json() as any[]).find((p) => p.id === inviteP.id).stock === stockBefore);
// BTW per land (EU-OSS)
const dc = (await app.inject({ method: "POST", url: "/api/cart" })).json();
await app.inject({ method: "POST", url: "/api/cart/" + dc.id + "/items", payload: { productId: inviteP.id, qty: 1 } });
const deCo = (await app.inject({ method: "POST", url: "/api/checkout", payload: { cartId: dc.id, customer: { name: "D", email: "d@x.nl", country: "DE" } } })).json();
ok("BTW-tarief per land (DE = 19%)", deCo.vatRate === 19);
await app.inject({ method: "POST", url: "/api/webhooks/mollie", payload: { id: deCo.paymentId, status: "canceled" } });
// per-variant SKU prijs + voorraad
const vp2 = (await app.inject({ method: "POST", url: "/api/products", headers: auth, payload: { name: "SKU Display", price: "€100", stock: 0, category: "displays", variants: [{ sku: "SKU-M", options: { Maat: "M" }, priceCents: 50000, stock: 1, weightGrams: 1000 }] } })).json();
const vc = (await app.inject({ method: "POST", url: "/api/cart" })).json();
await app.inject({ method: "POST", url: "/api/cart/" + vc.id + "/items", payload: { productId: vp2.id, qty: 1, variant: { sku: "SKU-M" } } });
const vCo = (await app.inject({ method: "POST", url: "/api/checkout", payload: { cartId: vc.id, customer: { name: "V", email: "v@x.nl" } } })).json();
ok("per-variant SKU-prijs gebruikt (€500)", vCo.totalCents >= 50000);
const vc2 = (await app.inject({ method: "POST", url: "/api/cart" })).json();
await app.inject({ method: "POST", url: "/api/cart/" + vc2.id + "/items", payload: { productId: vp2.id, qty: 1, variant: { sku: "SKU-M" } } });
ok("variant-voorraad voorkomt oversell (409)", (await app.inject({ method: "POST", url: "/api/checkout", payload: { cartId: vc2.id, customer: { name: "V2", email: "v2@x.nl" } } })).statusCode === 409);
await app.inject({ method: "DELETE", url: "/api/products/" + lp.id, headers: auth });
await app.inject({ method: "DELETE", url: "/api/products/" + vp2.id, headers: auth });

// ---- CONTENT/CMS: revisies, preview, hreflang ----
const dpg = (await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "concept-x", title: "Concept X", blocks: { id: "root", type: "core/root", settings: {}, children: [{ id: "t", type: "xpo/heading", settings: { text: "GEHEIM_CONCEPT", level: "h1" }, children: [] }] } } })).json();
const ptok = (await app.inject({ method: "POST", url: "/api/pages/" + dpg.id + "/preview-token", headers: auth })).json();
ok("preview-token endpoint geeft url + token", !!ptok.token && ptok.url.includes("/preview/page/" + dpg.id));
const prev = await app.inject({ method: "GET", url: ptok.url });
ok("preview rendert het concept (ongepubliceerd)", prev.statusCode === 200 && prev.body.includes("GEHEIM_CONCEPT") && prev.body.includes('content="noindex'));
ok("preview niet gecachet + noindex-header", String(prev.headers["cache-control"] || "").includes("no-store") && String(prev.headers["x-robots-tag"] || "").includes("noindex"));
ok("ongeldig preview-token => 403", (await app.inject({ method: "GET", url: "/preview/page/" + dpg.id + "?token=nep" })).statusCode === 403);
ok("concept niet publiek zichtbaar (404)", (await app.inject({ method: "GET", url: "/site/concept-x" })).statusCode === 404);
// revisies + terugdraaien
await app.inject({ method: "PUT", url: "/api/pages/" + dpg.id, headers: auth, payload: { slug: "concept-x", title: "Concept X", blocks: { id: "root", type: "core/root", settings: {}, children: [{ id: "t", type: "xpo/heading", settings: { text: "VERSIE_TWEE", level: "h1" }, children: [] }] } } });
const pageVers = (await app.inject({ method: "GET", url: "/api/pages/" + dpg.id + "/versions", headers: auth })).json() as any[];
ok("revisie bewaard bij opslaan", Array.isArray(pageVers) && pageVers.length >= 1);
const restored = await app.inject({ method: "POST", url: "/api/pages/" + dpg.id + "/restore-version/" + pageVers[pageVers.length - 1].id, headers: auth });
ok("terugdraaien naar oude revisie werkt", restored.statusCode < 400 && JSON.stringify(restored.json()).includes("GEHEIM_CONCEPT"));
await app.inject({ method: "DELETE", url: "/api/pages/" + dpg.id + "?purge=1", headers: auth });
// preview voor blogposts
const dpost = (await app.inject({ method: "POST", url: "/api/posts", headers: auth, payload: { title: "Concept Post", blocks: { id: "root", type: "core/root", settings: {}, children: [{ id: "h", type: "xpo/heading", settings: { text: "POST_CONCEPT", level: "h1" }, children: [] }] } } })).json();
const postId = dpost.id || dpost.post?.id;
const ptok2 = (await app.inject({ method: "POST", url: "/api/posts/" + postId + "/preview-token", headers: auth })).json();
ok("post-preview rendert concept", (await app.inject({ method: "GET", url: ptok2.url })).body.includes("POST_CONCEPT"));
await app.inject({ method: "DELETE", url: "/api/posts/" + postId + "?purge=1", headers: auth });
// hreflang voor vertaalde pagina's
const base = (await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "multilang", title: "Multilang", locale: "nl", blocks: { id: "root", type: "core/root", settings: {}, children: [] } } })).json();
await app.inject({ method: "POST", url: "/api/pages/" + base.id + "/publish", headers: auth });
const trEn = (await app.inject({ method: "POST", url: "/api/pages/" + base.id + "/translate", headers: auth, payload: { locale: "en" } })).json();
await app.inject({ method: "POST", url: "/api/pages/" + trEn.id + "/publish", headers: auth });
const mlBody = (await app.inject({ method: "GET", url: "/site/multilang" })).body;
ok("hreflang-links voor vertaalde pagina", mlBody.includes('hreflang="en"') && mlBody.includes('hreflang="x-default"'));
await app.inject({ method: "DELETE", url: "/api/pages/" + base.id + "?purge=1", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + trEn.id + "?purge=1", headers: auth });

// ---- SNELHEID & PERFORMANCE ----
// 1.1 render-cache + ETag + Cache-Control + 304
const pc1 = await app.inject({ method: "GET", url: "/site" });
ok("publieke pagina cachebaar (ETag + Cache-Control)", !!pc1.headers["etag"] && String(pc1.headers["cache-control"] || "").includes("s-maxage"));
ok("eerste hit is MISS", pc1.headers["x-cache"] === "MISS");
const pc2 = await app.inject({ method: "GET", url: "/site" });
ok("tweede hit komt uit cache (HIT)", pc2.headers["x-cache"] === "HIT");
const pc304 = await app.inject({ method: "GET", url: "/site", headers: { "if-none-match": String(pc1.headers["etag"]) } });
ok("If-None-Match levert 304", pc304.statusCode === 304);
// 1.1 invalidatie bij contentmutatie
const invP = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "perf-inval", title: "Perf", blocks: { id: "root", type: "core/root", settings: {}, children: [] } } });
await app.inject({ method: "POST", url: "/api/pages/" + invP.json().id + "/publish", headers: auth });
ok("cache geïnvalideerd na publicatie", (await app.inject({ method: "GET", url: "/site" })).headers["x-cache"] === "MISS");
await app.inject({ method: "DELETE", url: "/api/pages/" + invP.json().id + "?purge=1", headers: auth });

// 1.2 asset-versiebeheer + CDN-basis + immutable
const phtml = (await app.inject({ method: "GET", url: "/site" })).body;
ok("assets hebben immutable versie (cache-busting)", /xpo-bundle\.js\?v=/.test(phtml) && /xpo-fonts\.css\?v=/.test(phtml));
const acss = await app.inject({ method: "GET", url: "/assets/xpo-fonts.css" });
ok("statische assets immutable gecachet", String(acss.headers["cache-control"] || "").includes("immutable"));

// 1.3 zelf-gehoste fonts (geen render-blocking Google-call)
ok("fonts zelf-gehost (geen fonts.googleapis)", !phtml.includes("fonts.googleapis.com") && phtml.includes("xpo-fonts.css"));

// 1.4 front-end gebundeld (één script i.p.v. zes)
ok("front-end gebundeld tot één script", existsSync("public/xpo-bundle.js") && !phtml.includes("/assets/xpo-fx.js") && (phtml.match(/xpo-bundle\.js/g) || []).length === 1);
ok("bundel bevat de losse modules", readFileSync("public/xpo-bundle.js", "utf8").includes("xpo-fx.js") && readFileSync("public/xpo-bundle.js", "utf8").includes("xpo-shop.js"));

// 1.5 beeldoptimalisatie: lazy-loading
const imgP = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "perf-img", title: "Img", blocks: { id: "root", type: "core/root", settings: {}, children: [{ id: "im", type: "xpo/image", settings: { src: "/uploads/x.png", caption: "Test" }, children: [] }] } } });
await app.inject({ method: "POST", url: "/api/pages/" + imgP.json().id + "/publish", headers: auth });
ok("afbeeldingen lazy + async geladen", (await app.inject({ method: "GET", url: "/site/perf-img" })).body.includes('loading="lazy" decoding="async"'));
await app.inject({ method: "DELETE", url: "/api/pages/" + imgP.json().id + "?purge=1", headers: auth });

// 1.5 DB-indexen onder load
ok("perf-indexen toegepast (0005)", appliedMigrations().includes("0005_perf_indexes.sql"));

// 1.x cache Redis-klaar (driver-abstractie)
ok("cache-store actief (memory default, Redis-klaar)", (await cacheStats()).driver === "memory");

// 1.x async datalaag (Postgres/Azure-SQL-klaar)
{
  const adb = await getAsyncDb();
  ok("async-db driver = sqlite (Postgres-klaar)", adb.driver === "sqlite");
  await adb.exec("CREATE TABLE IF NOT EXISTS _perf_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
  const ins = await adb.run("INSERT INTO _perf_probe (v) VALUES (?)", ["async-werkt"]);
  const row = await adb.get<{ v: string }>("SELECT v FROM _perf_probe WHERE id = ?", [ins.lastInsertRowid]);
  ok("async-db round-trip (run/get met params)", !!row && row.v === "async-werkt" && ins.lastInsertRowid > 0);
}
ok("analytics-overzicht draait op de async-laag", (await app.inject({ method: "GET", url: "/api/analytics/overview", headers: auth })).statusCode === 200);

// 1.x image-pipeline (resize/WebP/AVIF endpoint + responsive markup)
const upPng = (await app.inject({ method: "POST", url: "/api/media", headers: auth, payload: { name: "perf.png", dataUrl: PNG } })).json();
const imgRes = await app.inject({ method: "GET", url: "/img?src=" + encodeURIComponent(upPng.src) + "&w=100" });
ok("/img levert beeld + immutable cache (sharp drop-in, fallback nu)", imgRes.statusCode === 200 && String(imgRes.headers["content-type"] || "").startsWith("image/") && String(imgRes.headers["cache-control"] || "").includes("immutable"));
ok("/img weigert niet-lokale bron (SSRF-veilig)", (await app.inject({ method: "GET", url: "/img?src=" + encodeURIComponent("https://evil.example/x.png") })).statusCode === 400);
const rImgPage = (await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "perf-pic", title: "Pic", blocks: { id: "root", type: "core/root", settings: {}, children: [{ id: "im", type: "xpo/image", settings: { src: upPng.src, caption: "x" }, children: [] }] } } })).json();
await app.inject({ method: "POST", url: "/api/pages/" + rImgPage.id + "/publish", headers: auth });
const picBody = (await app.inject({ method: "GET", url: "/site/perf-pic" })).body;
ok("afbeelding rendert responsive <picture> + srcset", picBody.includes("<picture>") && picBody.includes("/img?src=") && picBody.includes("type=\"image/avif\"") && picBody.includes("type=\"image/webp\""));
await app.inject({ method: "DELETE", url: "/api/pages/" + rImgPage.id + "?purge=1", headers: auth });

// ---- ARCHITECTUUR & DATALAAG ----
// A. migratiesysteem + driver
const migs = appliedMigrations();
ok("migratiesysteem: 0001/0002/0003 toegepast", migs.includes("0001_init.sql") && migs.includes("0002_tenant_indexes.sql") && migs.includes("0003_jobs.sql"));
ok("migraties zijn idempotent", migrate().applied.length === 0);
ok("DB-driver gerapporteerd (sqlite default)", dbInfo().driver === "sqlite");
ok("Postgres-DDL-vertaler werkt", toPostgres("id INTEGER PRIMARY KEY AUTOINCREMENT, t DATETIME").includes("SERIAL PRIMARY KEY") && toPostgres("x DATETIME").includes("TIMESTAMPTZ"));

// C. multi-tenant resolutie + isolatie
ok("tenant via domein (altermedia.nl)", resolveTenant({ headers: { host: "altermedia.nl" } } as any) === "altermedia");
ok("tenant via domein (xposcreens.com)", resolveTenant({ headers: { host: "xposcreens.com" } } as any) === "xpo");
ok("onbekende x-tenant geweigerd => default", resolveTenant({ headers: { "x-tenant": "evil-corp" } } as any) === "xpo");
ok("ingelogde tenant overschrijft host (isolatie)", resolveTenant({ user: { tenant: "altermedia" }, headers: { host: "xposcreens.com" } } as any) === "altermedia");
ok("isKnownTenant filtert onbekende", isKnownTenant("xpo") && !isKnownTenant("nope"));

// D. plugin-/hook-systeem
ok("plugins geladen (payments-core + example-badge)", loadedPlugins().includes("payments-core") && loadedPlugins().includes("example-badge"));
ok("betaalproviders geregistreerd (mollie + stub)", listPaymentProviders().some((p) => p.name === "mollie") && listPaymentProviders().some((p) => p.name === "stub"));
addFilter("xpo_test_price", (v: number) => v * 2);
addFilter("xpo_test_price", (v: number) => v + 1, 20);
ok("hook-filters draaien in volgorde", applyFilters<number>("xpo_test_price", 10) === 21);
const badgeRoot = { id: "root", type: "core/root", settings: {}, children: [{ id: "bd", type: "xpo/badge", settings: { text: "Plugin werkt" }, children: [] }] };
const badgeP = await app.inject({ method: "POST", url: "/api/pages", headers: auth, payload: { slug: "plugin-badge", title: "Badge", blocks: badgeRoot } });
await app.inject({ method: "POST", url: "/api/pages/" + badgeP.json().id + "/publish", headers: auth });
ok("plugin-widget rendert zonder kernwijziging", (await app.inject({ method: "GET", url: "/site/plugin-badge" })).body.includes("xpo-badge-ext") && (await app.inject({ method: "GET", url: "/site/plugin-badge" })).body.includes("Plugin werkt"));
await app.inject({ method: "POST", url: "/api/pages/" + badgeP.json().id + "/trash", headers: auth });
await app.inject({ method: "DELETE", url: "/api/pages/" + badgeP.json().id + "?purge=1", headers: auth });
ok("betaalproviders-endpoint", ((await app.inject({ method: "GET", url: "/api/payment-providers", headers: auth })).json() as any[]).length >= 2);

// E. widget-manifest (één bron van waarheid)
const wm = (await app.inject({ method: "GET", url: "/api/widgets" })).json();
ok("widget-manifest endpoint", wm.count >= 55 && wm.all.includes("xpo/hero") && wm.all.includes("xpo/loop") && wm.all.includes("xpo/badge"));
ok("widgetTypes() bevat plugin-widget", widgetTypes().includes("xpo/badge"));

// F. background job-queue
const emailsBefore = ((await app.inject({ method: "GET", url: "/api/emails", headers: auth })).json() as any[]).length;
enqueue("xpo", "email", { to: "queue-test@xpo.nl", body: { form: "Queue-test", data: { x: 1 } } });
const procEmail = await processJobsNow();
ok("job-queue verwerkt e-mail asynchroon", procEmail.done >= 1);
ok("verwerkte e-mail in outbox", ((await app.inject({ method: "GET", url: "/api/emails", headers: auth })).json() as any[]).length > emailsBefore);
registerJobHandler("xpo_test_fail", () => { throw new Error("expres mislukt"); });
enqueue("xpo", "xpo_test_fail", {}, { maxAttempts: 1 });
const procFail = await processJobsNow();
ok("falende job -> status failed na max pogingen", procFail.failed >= 1 && queueStats().failed >= 1);
const qsBefore = queueStats().pending;
const qCart = (await app.inject({ method: "POST", url: "/api/cart" })).json();
const anyProd = ((await app.inject({ method: "GET", url: "/api/products", headers: auth })).json() as any[])[0];
await app.inject({ method: "POST", url: "/api/cart/" + qCart.id + "/items", payload: { productId: anyProd.id, qty: 1 } });
const qCo = (await app.inject({ method: "POST", url: "/api/checkout", payload: { cartId: qCart.id, customer: { name: "Q", email: "q@xpo.nl" } } })).json();
await app.inject({ method: "POST", url: "/api/payments/" + qCo.paymentId + "/confirm" });
ok("order-bevestiging wordt als job in de wachtrij gezet", queueStats().pending > qsBefore);
await processJobsNow();

// ---- VEILIGHEID ----
// wachtwoord-hashing (scrypt + pepper + legacy + sterkte)
ok("wachtwoord-hash gebruikt scrypt-formaat", hashPassword("Geheim123").startsWith("scrypt$"));
{ const h = hashPassword("Geheim123"); ok("verifyPassword klopt", verifyPassword("Geheim123", h) && !verifyPassword("fout", h)); }
ok("legacy salt:hash blijft verifieerbaar", (() => { const salt = _rb(16); const hash = _scrypt("OudWachtwoord", salt, 32); return verifyPassword("OudWachtwoord", salt.toString("hex") + ":" + hash.toString("hex")); })());
ok("needsRehash markeert legacy-formaat", needsRehash("aa:bb") && !needsRehash(hashPassword("x")));
ok("zwak wachtwoord geweigerd", !!passwordIssue("1234567") && !passwordIssue("Sterk1word"));

// refresh-rotatie + intrekking
const lg = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@xpo.nl", password: "xpo-admin" } })).json();
ok("login geeft access + refresh token", !!lg.token && !!lg.refreshToken);
const rf1 = (await app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: lg.refreshToken } })).json();
ok("refresh geeft nieuw tokenpaar", !!rf1.token && !!rf1.refreshToken && rf1.refreshToken !== lg.refreshToken);
ok("oude refresh-token na rotatie ongeldig", (await app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: lg.refreshToken } })).statusCode === 401);

// logout-overal op een aparte gebruiker (laat de hoofd-admin-sessie intact)
getDb().prepare("INSERT INTO users (tenant_id, name, email, role, password_hash, token_version, active, created_at) VALUES ('xpo','Temp','temp-sec@xpo.nl','editor',?,0,1,?)").run(hashPassword("TempPass1"), new Date().toISOString());
const tlg = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "temp-sec@xpo.nl", password: "TempPass1" } })).json();
const tAuth = { authorization: "Bearer " + tlg.token };
ok("temp-token werkt vóór logout-overal", (await app.inject({ method: "GET", url: "/api/auth/me", headers: tAuth })).statusCode === 200);
await app.inject({ method: "POST", url: "/api/auth/logout-all", headers: tAuth });
ok("logout-overal trekt alle tokens in (token-revocatie)", (await app.inject({ method: "GET", url: "/api/auth/me", headers: tAuth })).statusCode === 401);

// CSRF / Origin-guard
ok("cross-origin POST geweigerd (CSRF)", (await app.inject({ method: "POST", url: "/api/track", headers: { origin: "https://evil.example", host: "localhost" }, payload: { path: "/x" } })).statusCode === 403);
ok("same-origin POST toegestaan", (await app.inject({ method: "POST", url: "/api/track", headers: { origin: "http://localhost", host: "localhost" }, payload: { path: "/x" } })).statusCode === 204);

// honeypot
ok("honeypot blokkeert botregistratie", (await app.inject({ method: "POST", url: "/api/public/register", payload: { email: "bot@x.nl", password: "Sterk1word", _hp: "ik-ben-bot" } })).statusCode === 400);

// brute-force lockout
resetLockout();
for (let i = 0; i < 8; i++) await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "lock@xpo.nl", password: "fout" } });
ok("login-lockout na te veel pogingen (429)", (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "lock@xpo.nl", password: "fout" } })).statusCode === 429);
resetLockout();

// upload: magic-bytes-validatie
const fakePng = "data:image/png;base64," + Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00]).toString("base64");
ok("upload met verkeerde magic-bytes geweigerd", (await app.inject({ method: "POST", url: "/api/media", headers: auth, payload: { name: "nep.png", dataUrl: fakePng } })).statusCode >= 400);

// RBAC: granulaire permissies
ok("RBAC: shop_manager mag shop, niet publiceren", hasPermission("shop_manager", "shop") && !hasPermission("shop_manager", "content:publish"));
ok("RBAC: seo-rol mag seo, admin mag alles", hasPermission("seo", "seo") && hasPermission("admin", "wat-dan-ook") && !hasPermission("viewer", "shop"));

// nonce-CSP + security headers
const secHead = await app.inject({ method: "GET", url: "/site" });
const secCsp = String(secHead.headers["content-security-policy"] || "");
ok("CSP gebruikt nonce i.p.v. unsafe-inline voor scripts", /script-src[^;]*'nonce-/.test(secCsp) && !/script-src[^;]*unsafe-inline/.test(secCsp));
ok("HSTS + Permissions-Policy aanwezig", String(secHead.headers["strict-transport-security"] || "").includes("max-age") && String(secHead.headers["permissions-policy"] || "").includes("camera="));
ok("inline scripts dragen de CSP-nonce", (() => { const m = secCsp.match(/nonce-([^' ]+)/); return m ? secHead.body.includes('nonce="' + m[1] + '"') : false; })());

// auditlog legt mutaties vast
const auditList = (await app.inject({ method: "GET", url: "/api/activity", headers: auth })).json() as any[];
ok("auditlog bevat recente acties", Array.isArray(auditList) && auditList.length > 0);

// ---- security headers (CSP e.d.) ----
const hres = await app.inject({ method: "GET", url: "/site" });
const csp = String(hres.headers["content-security-policy"] || "");
ok("CSP-header aanwezig met default-src + frame-ancestors", csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'self'"));
ok("overige security-headers gezet", hres.headers["x-frame-options"] === "SAMEORIGIN" && hres.headers["x-content-type-options"] === "nosniff" && String(hres.headers["strict-transport-security"] || "").includes("max-age"));

// ---- rate-limiting op inloggen (als laatste: verbruikt de teller) ----
resetRateLimit();
let got401 = false, got429 = false, retryAfter = "";
for (let i = 0; i < 25; i++) {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "x@y.nl", password: "fout" } });
  if (r.statusCode === 401) got401 = true;
  if (r.statusCode === 429) { got429 = true; retryAfter = String(r.headers["retry-after"] || ""); break; }
}
ok("rate-limiting blokkeert na te veel inlogpogingen (429)", got401 && got429);
ok("429 geeft een Retry-After header", retryAfter !== "");






// persistentie: nieuwe app-instance leest dezelfde database
await app.close();
const app2 = await buildApp();
const l2 = (await app2.inject({ method: "GET", url: "/api/pages", headers: auth })).json() as any[];
ok("persistentie: pagina overleeft herstart (echte DB)", l2.some((p) => p.slug === "arcadia-test"));
await app2.close();

console.log(`\n=== ${pass} geslaagd, ${fail} gefaald ===`);
process.exit(fail ? 1 : 0);
