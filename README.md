# XPO CMS — werkende backend (increments 1–31)

Een **echt draaiende** CMS-kern: Node + Fastify + SQLite, met echte authenticatie,
paginabeheer, versiebeheer en server-side rendering. De rijke admin-UI (Studio,
19 modules) is meegeleverd en de **module Pagina's praat live met deze API en database**.

Dit is de echte bouw (increments 1–31 gereed) — geen browser-demo meer. De pagina's die je
aanmaakt, bewerkt en publiceert staan in een echte database en overleven een herstart.

---

## Starten (lokaal)

Vereist: Node.js 22+ (voor de ingebouwde `node:sqlite`).

```bash
npm install
npm run seed      # maakt de database + admin-gebruiker + voorbeeldpagina
npm run dev       # start de server (herstart automatisch bij wijzigingen)
```

Daarna:

- Admin:        http://localhost:3000/admin/
- Publieke site: http://localhost:3000/site   (en /site/:slug per pagina)
- Health:        http://localhost:3000/health

Inloggen (de admin doet dit automatisch in dev):

```
e-mail:     admin@xpo.nl
wachtwoord: xpo-admin
```

---

## Wat er echt werkt (increment 1)

- **Auth** — login met scrypt-gehasht wachtwoord, HMAC-ondertekend token (8u), rol-guards
  (viewer / editor / admin / superadmin). Schrijfacties vereisen rol `editor` of hoger.
- **Pagina's** — volledige CRUD tegen SQLite, tenant-scoped, met slug-uniciteit.
- **Validatie** — dezelfde regels als de UI draaien óók server-side; ongeldige content
  wordt geweigerd (HTTP 400 met concrete `issues`).
- **Publiceren + versiebeheer** — publiceren kopieert het concept naar de live-versie en
  legt een snapshot vast in `page_versions`.
- **Server-side rendering** — `/site/:slug` rendert gepubliceerde pagina's als veilige HTML.
  Alle gebruikersinvoer wordt ge-escaped; URLs/afbeeldingen worden gesanitized (geen XSS).
- **Media** — upload (PNG/JPEG/GIF/WebP, max 8 MB) wordt als bestand op schijf opgeslagen
  in `data/uploads/` en geserveerd via `/uploads/...`; lijst en verwijderen inbegrepen.
  Afbeeldingen die je in de Studio kiest, verwijzen naar deze URL (klein in DB en pagina's).
- **Gebruikers / RBAC** — gebruikersbeheer (lijst, aanmaken, verwijderen) met rollen;
  beheer vereist rol `admin`+. De laatste superadmin kan niet worden verwijderd.
- **Formulieren** — formulieren met velden beheren en inzendingen opslaan in de database;
  velden worden gesanitized, slugs zijn uniek. Een inzend-endpoint staat klaar voor de
  publieke site (`POST /api/forms/:id/submissions`).
- **Commerce** — producten (CRUD, voorraad → status) en orders (lijst). Mollie-betalingen
  en orderafhandeling volgen; prijzen staan nu als tekst en worden later cents + valuta.
- **Navigatie** — hoofd- en footermenu beheren (toevoegen, ordenen, verwijderen),
  opgeslagen per tenant; items worden gesanitized.
- **SEO / Redirects** — redirects beheren (CRUD) die de publieke laag echt als 301/302
  uitvoert; plus een live `/sitemap.xml` van gepubliceerde pagina's. Per-pagina SEO-titel
  en meta-omschrijving lopen al via de pagina's-API.
- **Helpdesk** — supporttickets (lijst, aanmaken, statuswissel Open / In behandeling /
  Opgelost, verwijderen) en een kennisbank (CRUD). Vervangt de Freshdesk-stap; tickets
  krijgen automatisch een oplopend #-nummer per tenant.
- **Marketing** — campagnes (CRUD) met een statuswissel concept ↔ actief en
  verstuurd-/open-cijfers per campagne.
- **E-mailverzending voor de bezorgwachtrij** — formulier-e-mailacties belanden in een wachtrij en worden verstuurd via een mailer met twee modi: een outbox/log-modus (standaard, logt elke e-mail lokaal — ideaal voor test) en een SMTP-modus voor echte verzending in productie. Met een "Verwerk wachtrij"-knop, een outbox-overzicht en mailinstellingen in de admin.
- **Schaalbaar & Postgres-klaar** — render-/rate-cache achter een store-abstractie die op Redis overschakelt zodra `REDIS_URL` gezet is; een async data-access-laag (`getAsyncDb`) waarmee dezelfde queries op Postgres/Azure SQL draaien (analytics-module al volledig async); een on-the-fly image-pipeline (`/img`, resize + WebP/AVIF via sharp als drop-in, veilige fallback) met responsive `<picture>`/srcset; en een draaibaar performance-budget (`npm run perf`) in CI.
- **Volwaardige webshop** — voorraadreservering bij checkout met race-veilige oversell-bescherming; per-variant SKU's met eigen prijs/voorraad/gewicht; echte Mollie-koppeling met idempotente webhook + betaalstatus-machine (betaald/verlopen/geannuleerd → voorraad terug); BTW per land (EU-OSS) + verzendzones met gewichtstaffels; oplopende factuurnummering en BTW-factuur als PDF.
- **Revisies, preview & meertaligheid** — elke opslag bewaart een revisie (terugdraaien mogelijk); ondertekende preview-tokens tonen concepten (noindex, geen cache, 403 bij ongeldig token) zonder te publiceren; vertaalde pagina's krijgen automatisch `hreflang`-links. Geplande publicatie werkt (concepten gaan live op het ingestelde tijdstip).
- **Snelheid & performance** — render-cache met ETag/304 + `Cache-Control` en automatische invalidatie bij publicatie; CDN-asset-versiebeheer met immutable cache-busting; zelf-gehoste fonts (geen render-blocking Google-call); gebundelde + deferred front-end scripts met conditioneel laden van zware libs; lazy/async afbeeldingen; extra DB-indexen; en een Lighthouse-budget in CI.
- **Beveiliging (productie-hardening)** — scrypt-wachtwoorden met pepper + auto-rehash + sterkte-eis; korte access-tokens met roterende refresh-tokens, token-revocatie en logout-overal; secrets via secret-store (Key Vault-klaar); CSRF/Origin-bescherming; nonce-gebaseerde CSP (geen unsafe-inline) + HSTS + Permissions-Policy + CSP-reporting; rauwe-HTML-stripping tegen opgeslagen XSS; login-lockout + honeypot tegen brute-force/spam; upload-hardening (MIME + magic-bytes + groottelimiet); granulaire RBAC-rollen + auditlog; en CI met dependency-audit + Dependabot. Zie SECURITY.md.
- **Productie-architectuur (datalaag)** — versiegestuurd migratiesysteem (`_migrations`), driver-config voor PostgreSQL/Azure SQL met automatische DDL-vertaling, atomaire back-ups (`VACUUM INTO`), echte multi-tenant-resolutie (domein/subdomein + token-gebonden isolatie + RLS-policies voor Postgres), een plugin-/hook-systeem (widgets, hooks, betaalproviders modulair) en een background-job-queue met retries voor e-mail/sitemap/imports. Systeemstatus via `/api/system`.
- **1-klik licht/donker-thema (front-end)** — themaschakelaar in de sitebalk én als plaatsbare widget; voorkeur blijft bewaard (localStorage), zonder flits bij paginalading, en het standaardthema volgt de CMS-instelling. Volledig opgebouwd met CSS-variabelen zodat oppervlakken, randen, tekst en knoppen meekleuren. Per-widget tekstkleur instelbaar in de stijl-tab.
- **11 nieuwe Elementor-widgets** — los Icoon, Counter (meetellende cijfer-animatie), Sterbeoordeling, Melding/Alert-box (sluitbaar), Datatabel, Prijslijst (menukaart-stijl), Audio/SoundCloud, Afbeelding-hotspots, Lottie-animatie, Login-formulier en **Loop Grid** (eigen kaart per post/product met veld-toggles en kolommen).
- **WooCommerce-tab compleet** — productvariaties/attributen (maat/kleur als selectors op de productpagina, variant gaat mee in de winkelwagen), verzendmethoden (beheerbaar, meegerekend in de checkout), productreviews (plaatsen, modereren, gemiddelde + lijst op de productpagina), refunds (met optioneel terugboeken voorraad), klantenlijst (geaggregeerd uit orders) en uitklapbaar orderdetail.
- **RankMath-achtige SEO-analyse** — echte content-analyse per pagina: focuskeyword in titel/URL/eerste alinea/koppen/tekst/afbeelding-alt, keyworddichtheid, leesbaarheidsscore (Douma/NL), woordenaantal, alt-tekstdekking en interne/externe links — met score en checklist in de SEO-tab (`POST /api/seo/analyze`).
- **Echte Analytics** — anonieme pageview-tracking via een beacon op de publieke site (sessie-cookie, geen PII); dashboard met weergaven/bezoekers (7d/30d/totaal), weergaven per week en populairste pagina's (`/api/track`, `/api/analytics/overview`).
- **ACF-vervanger compleet** — veldgroepen met rijke veldtypes (tekst, tekstvak, getal, schakelaar, afbeelding, keuze met opties, repeater, datum, URL, e-mail, kleur); waarden per pagina invullen in de editor (met de juiste invoer per type: keuzelijst, repeater-rijen, kleurkiezer); automatische specificatie-weergave; en **dynamic field tags** `{{field:<veld-id of label>}}` om elke veldwaarde overal in koppen/tekst te plaatsen.
- **WooCommerce-uitbreiding** — productpagina's op `/product/<slug>` met afbeelding, categorie, prijs, beschrijving, voorraadstatus en in-winkelwagen-knop; **gerelateerde producten** uit dezelfde categorie; productvelden (afbeelding/beschrijving/categorie) in de admin; **categorie-filtering** in de webshop-widget; **kortingscodes** (percentage of vast bedrag, valideren + toepassen bij checkout, beheer in de Commerce-tab); **BTW** (instelbaar tarief, btw-bedrag in de checkout-respons); en een **orderbevestigings-mail** naar de klant bij betaling.
- **Elementor Pro-widgets compleet** — naast de bestaande set nu ook: icoonlijst, citaat, flip-box, deel-knoppen, animatie-kop (roterende woorden), inhoudsopgave (auto uit koppen), menu-widget, kruimelpad, post-navigatie en auteur-box. Plus **dynamic tags** ({{title}}, {{site}}, {{author}}, {{date}}, {{year}}) in koppen/tekst/knoppen, en **scroll-entree-animaties** (up/fade/zoom/left/right) per sectie via het Geavanceerd-tabblad.
- **WordPress-core compleet** — blog-overzicht met paginering, archiefpagina's voor categorie/tag/auteur (`/categorie/…`, `/tag/…`, `/auteur/…`), **custom post types** (eigen contenttypes met archief op `/type/…`), **reactie-threads** (geneste antwoorden) met **moderatie-notificatie** naar de outbox, en **front-end klantaccounts** (registratie/login via aparte, veilige leden-cookie + accountpagina met bestelhistorie — strikt los van de admin-gebruikers).
- **Formulier-widget (formulieren in pagina's)** — embed een bestaand formulier in elke pagina; de site rendert de velden en verstuurt via een publiek, rate-limited endpoint. Inzendingen lopen door dezelfde acties (CRM-lead, webhook, e-mailwachtrij).
- **Publieke zoekpagina + zoek-widget** — `/zoeken?q=` doorzoekt gepubliceerde pagina's en posts en toont resultaten met links; een zoekbalk-widget plaats je overal op de site.
- **RSS-feed + robots.txt** — `/feed.xml` (laatste 50 gepubliceerde posts) en een `/robots.txt` met sitemap-verwijzing die /admin, /api en /zoeken uitsluit.
- **Rate-limiting + security-headers (CSP)** — brute-force-bescherming op de inlog-endpoints (configureerbaar venster, 429 + Retry-After) en een set strenge HTTP-headers: Content-Security-Policy, X-Frame-Options, HSTS, Referrer-Policy en Permissions-Policy. Dekt twee P0-punten uit het ISO-27001-audit.
- **Entra ID single sign-on (OIDC)** — autorisatiecode-flow met Microsoft Entra ID: een login-redirect naar Microsoft, een callback die claims leest, groepen op rollen mapt (hoogste match, anders standaardrol) en gebruikers automatisch aanmaakt/bijwerkt. Config + groep→rol-koppelingen in de Gebruikers-tab. (De live token-uitwisseling vereist een echte IdP; authorize-URL, rol-mapping, provisioning en redirect zijn getest.)
- **Media-opslag-adapter (lokaal + Azure Blob)** — uploads via een opslag-abstractie met twee drivers: lokale schijf (standaard) en Azure Blob voor productie (dynamische import van @azure/storage-blob, met nette terugval naar lokaal bij ontbrekende dependency/config). Driver + Azure-config in de Media-tab.
- **Health-endpoint + productie-config** — `GET /api/health` (status, db-check, versie, uptime) voor monitoring, env-variabelen (`PORT`, `HOST`, `XPO_SECRET`, `XPO_DB`) en een complete deploy-handleiding (`DEPLOY.md`): reverse proxy, systemd, Azure App Service, back-ups, en de configuratie-haken voor Mollie/SMTP plus wat nog productiewerk vereist (Azure Blob, Entra ID).
- **Multi-select** — meerdere blokken tegelijk selecteren met Ctrl/⌘- of Shift-klik (in de lagenboom én op het canvas), met een bulk-paneel om de selectie in één keer te kopiëren, dupliceren of verwijderen. Werkt samen met het klembord (meerdere blokken plakken, in documentvolgorde) en de Delete-toets.
- **Blokken kopiëren/plakken tussen pagina's** — een sessie-klembord: kopieer een (genest) blok en plak het in dezelfde of een andere pagina (nieuwe ids, in de geselecteerde container of na de selectie). Met ⌘/Ctrl-C en ⌘/Ctrl-V in de Studio en knoppen in de werkbalk.
- **SEO-meta (Open Graph, Twitter, canonical, robots)** — per pagina OG-afbeelding, canonical-URL en noindex naast titel/omschrijving; de render zet automatisch meta description, Open Graph- en Twitter-card-tags, canonical-link en robots in de paginakop (RankMath-vervanging, naast de bestaande JSON-LD en sitemap).
- **Slepen om te herordenen (drag & drop)** — blokken verslepen in de lagenboom én op het canvas, met drop-indicatoren; nesten door op een kolommen/container-blok te droppen, en er weer uithalen. Ook widgets vanuit het palet naar een exacte plek tussen blokken of in een container slepen. Beveiligd tegen in-zichzelf-slepen.
- **Slider / carousel** — een slider-widget met meerdere slides (afbeelding, titel, tekst, knop), navigatieknoppen, dots en optionele autoplay met instelbaar interval.
- **Commandobalk (⌘/Ctrl-K)** — snelzoeken in de admin over pagina's en posts via de zoek-API; direct doorklikken naar bewerken.
- **Webshop met winkelwagen, checkout en Mollie** — een Webshop-widget met productenraster, een server-side winkelwagen (toevoegen/aantal/verwijderen), checkout die een order + betaling aanmaakt, voorraad-afboeking bij betaling, en een publieke winkelwagen-lade met afrekenen. Mollie-koppeling (iDEAL/kaarten/Apple Pay/Bancontact) via een sleutel in Commerce; zonder sleutel een lokale betaalpagina-stub. Betalingen-overzicht in de admin.
- **Theme Builder met condities** — templates met een eigen blok-ontwerp (bewerkbaar in de Studio) en soort (header/footer/single/section) plus voorwaarden (hele site / type / specifieke pagina of post). Header- en footer-templates worden rond elke passende pagina geplaatst; een single-template wikkelt blogposts met een Post-inhoud-placeholder. Specifieke voorwaarden winnen van algemene.
- **Alysium AI-assistent** — omgebouwde Alysium-plugin: een lokale AI-assistent (Quinty) met BM25-retrieval over je eigen content (productkennis, pagina's, posts, helpdesk-KB en een eigen AI-kennisbank). Publieke chat-widget op de site, een admin-tab met config, testconsole, corpus-statistieken en kennisbeheer. Antwoordt standaard volledig lokaal (geen externe API nodig) en is optioneel koppelbaar aan Groq of Anthropic, die dan op dezelfde context antwoorden.
- **Reacties op posts** — bezoekers reageren onder blogposts (belandt op 'in afwachting'); een Reacties-tab met moderatie (goedkeuren/spam/verwijderen) en filters per status. Alleen goedgekeurde reacties verschijnen op de site.
- **Uitgebreide widget-set** — naast de kernset nu ook prijstabel, voortgangsbalken, social-links, knoppengroep, kaart (Google Maps-embed) en een live countdown.
- **Kolommen & nesting** — een Kolommen-blok (2/3/4 koloms, tussenruimte, verticale uitlijning) en een Container-blok (gestapelde inhoud) die andere blokken bevatten. Blokken slepen/voegen in een geselecteerde container, geneste lagenboom, en automatisch inklappen naar één kolom op mobiel.
- **Synced components** — een herbruikbare sectie "synced" invoegen: er ontstaat een live-koppeling, dus de bron één keer bewerken werkt op alle plekken door (de render lost de koppeling op het moment van weergeven op).
- **Conditionele zichtbaarheid** — per blok een zichtbaarheidsvenster (vanaf/tot datum-tijd), server-side geëvalueerd, naast verbergen-per-breakpoint.
- **Post-planning** — posts inplannen op een toekomstig tijdstip; ze gaan vanzelf live (zoals pagina's).
- **Site-brede globals** — design-tokens (primaire/tekst/achtergrondkleur, heading-/body-font) en globale CSS/JS die op élke publieke pagina worden toegepast (tokens als CSS-variabelen).
- **Zoeken** — `/api/search` doorzoekt pagina's en posts op titel/slug/omschrijving.
- **Back-up (import/export)** — volledige content-export naar JSON (pagina's, posts, taxonomie, secties, popups, navigatie, instellingen) en additieve import/herstel.
- **Formulier-acties + CRM** — per formulier in te schakelen acties: een **lead aanmaken in het ingebouwde CRM** (veld-mapping op naam/e-mail/telefoon/bedrijf/bericht, volledig lokaal — geen externe koppeling nodig), plus webhook en e-mailnotificatie die in een **bezorgwachtrij** belanden en in productie worden verstuurd (met opnieuw-versturen). Aparte Leads-tab toont leads + wachtrij.
- **Popup-builder** — popups met triggers (laden/scroll/exit-intent/klik), condities (hele site of specifieke pagina), inhoud (titel/tekst/knop/afbeelding), actief/uit-schakelaar en publieke injectie met een lichte trigger-engine (sessie-onthoud van sluiten).
- **JSON-LD schema** — per pagina/post wordt het schema-type als `application/ld+json` in de head uitgevoerd (naam, beschrijving, URL).
- **Video-widget** — YouTube, Vimeo en mp4 via één URL-veld, veilig als embed/`<video>`.
- **Stijl-engine v2 (per blok)** — kleurkiezers overal; achtergronden: kleur, gradient (met hoek), foto-URL, eigen video (mp4) en een rustig fadende **aurora**, plus een **particles**-laag. Daarnaast overlay (kleur + dekking), filters (helderheid/contrast/blur), hoekradius, slagschaduw, buitenmarge, en volledige typografie (lettertype, -dikte, -grootte, kleur, letterafstand, regelhoogte, hoofdletters). Alles als scoped CSS per `.n-{id}`, met breakpoints. Kleuren/URL's worden gevalideerd (geen CSS-injectie).
- **Custom CSS & JS per pagina** — vrije CSS en JS die in de render worden meegegeven (auteur-vertrouwd, met lengtelimiet).
- **Per-breakpoint responsive** — per blok een eigen binnenruimte voor tablet en mobiel (als scoped media-query CSS) en verbergen op desktop/tablet/mobiel (nu met correcte media queries i.p.v. altijd verborgen). De Studio toont het per breakpoint via de desktop/tablet/mobiel-schakelaar.
- **Custom velden** — veldgroepen (CRUD) met een eigen veldenlijst (tekst, tekstvak, getal,
  schakelaar, afbeelding, keuze, datum, url); inline bewerken slaat per wijziging op en types
  worden gevalideerd. Binding aan widgets/pagina's volgt in de Studio.
- **Talen** — locales beheren (toevoegen, standaard instellen, in-/uitschakelen, verwijderen)
  met de invariant van precies één standaardtaal die niet uit te schakelen of te verwijderen is.
  Vervangt de Polylang-stap.
- **Posts (blog) + taxonomie** — apart contenttype met categorieën en tags (eigen termenbeheer
  met tellingen), publiceren en prullenbak.
- **Pagina's pro** — hiërarchie (ouder/kind), auteur, geplande publicatie (gaat vanzelf live),
  prullenbak met herstel + definitief verwijderen, vertaalkoppeling (één klik → variant in andere
  taal, gekoppeld via transGroup) en revisies (lijst + herstellen). De lijst heeft zoeken, status-
  filters met tellingen en een prullenbakweergave.
- **SEO-diepte** — per pagina ook focus-keyword en schema-type; interne/afbeeldingslinks worden
  automatisch geteld en getoond.
- **Widgetbibliotheek uitgebreid** — naast hero/kop/tekst/knop/features/cards/tabs/accordion/
  gallery/afbeelding/witruimte/specs nu ook: scheiding, icon-box, CTA-banner, statistieken,
  logowand, quote en een **dynamisch posts-grid**. Allemaal gevalideerd, in de builder, de preview én de publieke render.
- **Templates** — theme-builder-templates (CRUD) met statuswissel concept ↔ live; pagina's
  verwijzen ernaar via hun template-naam.
- **Instellingen / Thema / Integraties** — één instellingen-store per tenant: hoekradius,
  modus (donker/licht), aangepaste accentkleur en de integratie-schakelaars. De accentkleur
  wordt echt toegepast in de publieke render.
- **Analytics** — echte tellingen uit de database (pagina's, gepubliceerd, inzendingen,
  producten, orders, tickets, campagnes, media, talen, templates).
- **Activiteit** — audittrail: elke schrijfactie naar de API (POST/PUT/PATCH/DELETE) en elke
  login worden automatisch vastgelegd via een onResponse-hook, met leesbare omschrijving.
- **Posts (blog) + taxonomie** — apart contenttype met categorieën en tags (termenbeheer met tellingen), publiceren en prullenbak.
- **Pagina's pro** — hiërarchie, auteur, geplande publicatie, prullenbak met herstel, vertaalkoppeling en revisies; lijst met zoeken/statusfilters/prullenbak.
- **SEO-diepte** — focus-keyword + schema-type per pagina, en automatische interne/afbeeldingslinktelling.
- **Widgetbibliotheek uitgebreid** — extra blokken: scheiding, icon-box, CTA-banner, statistieken, logowand en quote (builder + preview + publieke render).
- **Custom velden in de Studio** — per pagina invulbaar (in het SEO/overzicht-paneel) en
  opgeslagen in `pages.meta`; gevulde velden worden als specificatie-blok op de publieke pagina gerenderd.

### Menu-widgets (frontend)

Framework-vrije, toegankelijke navigatie-kit in `public/xpo-menus.css` + `public/xpo-menus.js`:

- **Mega menu** — vol paneel met kolommen + uitgelichte tegel (hover, klik, Esc, pijltjestoetsen).
- **Dropdown** — compacte flyout voor kortere lijsten.
- **Offcanvas** — schuiflade vanaf rechts op mobiel: overlay, focus-trap, Esc, focus keert terug.
- **Drilldown** — geneste niveaus mét terug-knop, opgebouwd uit hetzelfde menu.

Je schrijft de navigatie één keer (semantische `<ul class="xpo-menu">`); JS verzorgt op desktop
mega/dropdown en bouwt op mobiel automatisch de offcanvas-drilldown. De engine rendert deze header
(en een footer) op elke publieke pagina, gevoed door de navigatie uit de database. Demo:
`public/menu-widgets.html` (los te openen) of via de server op `/assets/menu-widgets.html`.
`prefers-reduced-motion` wordt gerespecteerd; accent volgt `data-tenant` (XPO grijsgroen / Altermedia rood).
- **Echte persistentie** — alles staat in `data/xpo.db` (SQLite, WAL-mode); media op schijf.

De admin toont alle 19 modules. **Alle inhouds- en configuratietabs** (Pagina's, Media, Gebruikers, Formulieren, Commerce, Navigatie, SEO/redirects, Helpdesk, Marketing, Custom velden, Talen, Templates, Thema, Integraties, Instellingen, Analytics en Activiteit) zijn server-backed
(echte database). De overige modules tonen hun UI maar draaien nog op lokale demo-data;
die krijgen hun eigen backend in de volgende increments (zie roadmap).

---

## Validatie

```bash
npm run typecheck                  # TypeScript types
NODE_NO_WARNINGS=1 npx tsx src/selftest.ts   # 13 in-proces API-tests
```

De self-test dekt: login (goed/fout), auth-guard (401), validatie (400 + issues),
aanmaken, publiceren, publieke render, XSS-escaping, 404, en persistentie over herstart.

---

## Structuur

```
src/
  app.ts                 Fastify-instance (routes, CORS, security headers, static admin)
  main.ts                start (listen)
  selftest.ts            in-proces end-to-end test (Fastify inject)
  seed.ts                admin-gebruiker + voorbeeldpagina
  db/
    schema.sql           tabellen (users, pages, page_versions, media, settings)
    database.ts          node:sqlite verbinding + migratie
    migrate.ts
  common/
    auth.ts              wachtwoord-hash, token, guards
    tenant.ts            tenant-context (nu 1 tenant; DB is al tenant-scoped)
  engine/
    engine.ts            validatie + veilige render (gedeeld door API en site)
  modules/
    auth/                login + me
    pages/               repository (SQLite) → service (regels) → routes (REST)
    media/               upload (data-URL → schijf), lijst, verwijderen
    users/               gebruikersbeheer + rollen (admin-only)
    forms/               formulieren + velden + inzendingen
    commerce/            producten (CRUD) + orders (lijst)
    navigation/          hoofd- en footermenu (per tenant)
    seo/                 redirects (301/302) + sitemap.xml
    helpdesk/            tickets + kennisbank
    marketing/           campagnes
    fields/              custom velden (veldgroepen)
    languages/           talen / locales
    posts/               posts (blog) + taxonomie + publieke /blog/:slug + dynamisch grid
    snippets/            herbruikbare secties (saved sections)
    popups/              popup-builder (triggers + condities + injectie)
    forms/               formulieren + acties (CRM-leads, webhook/e-mail-wachtrij)
    search/              zoeken over pagina's + posts
    backup/              content import/export
    comments/            reacties op posts + moderatie
    ai/                  Alysium AI: kennisbank + BM25-retrieval + chat
    shop/                webshop: winkelwagen + checkout + betalingen (Mollie)
    templates/           theme-builder-templates
    settings/            thema + integraties + site (per tenant)
    analytics/           tellingen uit de database
    activity/            audittrail (onResponse-hook)
    render/              publieke SSR-routes
admin/index.html         de admin-UI; Pagina's, Media en Gebruikers gekoppeld aan de API
data/uploads/            geüploade mediabestanden (geserveerd op /uploads/)
```

---

## Naar Azure SQL (productie)

De code is bewust zo opgezet dat de overstap één laag raakt: de **repository**.

1. Vervang `src/modules/pages/pages.repository.ts` door een variant op `mssql`
   (of Prisma/TypeORM richting Azure SQL). De service- en route-laag blijven identiek.
2. Zet secrets (DB-connectie, `XPO_SECRET`) in **Azure Key Vault** i.p.v. env.
3. Vervang de dev-login door **Entra ID (OIDC)**; `verifyToken` wordt dan JWT-validatie
   tegen de Entra-JWKS. De rol-guards blijven werken.

Conventies (tenant-scoping, prepared statements, DTO-vorm) komen al overeen met de
XPO CRM en de eerdere platform-slice, dus de modellen sluiten op elkaar aan.

---

## Volgende increments

Server-backed: **alle 17 inhouds- en configuratietabs**. Resterend werk is platformbreed (Mollie, Entra, Graph-mail, Azure Blob, hardening, Nuxt-site).

4. **Notificaties** → e-mail bij nieuwe inzending via Microsoft Graph.
5. **Mollie** → betalingen + orderafhandeling op de commerce-basis.
6. **Custom velden** → binding van velden aan widgets in de Studio + in de render.
7. **Media naar Azure Blob** + Entra-login (productie i.p.v. lokale schijf/dev-login).
8. **Publieke site** → aparte Nuxt-renderapp met caching/CDN en meertalige routing.
9. **Hardening** → CSP, rate-limiting, audit → Sentinel, DR/back-up (P0 uit de audit).
