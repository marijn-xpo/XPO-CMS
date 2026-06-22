# XPO CMS — Deploy- en omgevingshandleiding

Deze handleiding beschrijft hoe je het XPO CMS van lokaal naar productie brengt: vereisten, omgevingsvariabelen, draaien achter een reverse proxy, als systemd-service of op Azure App Service, plus de configuratie-haken voor Mollie, SMTP en de onderdelen die nog productiewerk vereisen (Azure Blob, Entra ID).

> Eerlijk kader: de applicatie draait volledig (admin, publieke site, webshop, AI, SEO, e-mail-outbox) en is getest met 270 backend-tests + 10 menutests. De punten die een echte omgeving vereisen — live Mollie-betalingen, echte SMTP-verzending, media op Azure Blob en Entra ID-login — staan onderaan apart, met wat klaar is en wat nog moet.

## 1. Vereisten

- **Node.js 22 of hoger** (de app gebruikt de ingebouwde `node:sqlite` en top-level await). Controleer met `node -v`.
- Een Linux-server (Ubuntu 24 getest) of Azure App Service (Linux, Node 22).
- Schijfruimte voor de SQLite-database en geüploade media.

De standaardopslag is **SQLite** (één bestand). Dat is prima voor één server. Wil je naar **Azure SQL** (zoals Robert opzet), dan is dat een aparte migratie — zie sectie 8.

## 2. Installeren en eerste keer draaien

```bash
unzip xpo-cms-app.zip -d xpo-cms
cd xpo-cms
npm install
npm run seed     # maakt de database + voorbeelddata (admin@xpo.nl / xpo-admin)
npm start        # draait op poort 3000
```

Daarna:

- Admin: `http://SERVER:3000/admin/`
- Publieke site: `http://SERVER:3000/site`
- Health-check: `http://SERVER:3000/api/health`

**Belangrijk:** wijzig direct het seed-wachtwoord van `admin@xpo.nl` via de Gebruikers-tab, of maak een nieuwe superadmin aan en verwijder het seed-account.

## 3. Omgevingsvariabelen

| Variabele | Standaard | Betekenis |
|---|---|---|
| `PORT` | `3000` | Poort waarop de server luistert. |
| `HOST` | `0.0.0.0` | Interface. Achter een proxy kun je `127.0.0.1` gebruiken. |
| `XPO_SECRET` | *(willekeurig per start)* | **Zet dit in productie.** Geheime sleutel voor het ondertekenen van sessietokens. Zonder vaste waarde vervallen alle sessies bij elke herstart. Genereer bv. met `openssl rand -hex 32`. |
| `XPO_DB` | `data/xpo.db` | Pad naar het SQLite-bestand. Zet op een persistent volume. |
| `NODE_NO_WARNINGS` | — | Onderdrukt de experimentele-waarschuwing van `node:sqlite` (al gezet in de npm-scripts). |

Voorbeeld:

```bash
export XPO_SECRET="$(openssl rand -hex 32)"
export XPO_DB="/var/lib/xpo-cms/xpo.db"
export PORT=3000
npm start
```

De server logt bij het starten een waarschuwing als `XPO_SECRET` ontbreekt.

> De ingebouwde Content-Security-Policy staat de admin-afhankelijkheid (Vue via cdnjs.cloudflare.com) en Google Fonts/Maps toe. Host je assets op andere domeinen, pas dan de CSP in `src/app.ts` aan.

## 4. Achter een reverse proxy (aanbevolen)

Draai Node intern op `127.0.0.1:3000` en zet er Nginx of Caddy voor TLS + compressie voor.

**Caddy** (automatisch HTTPS):

```
cms.xposcreens.com {
    reverse_proxy 127.0.0.1:3000
}
```

**Nginx**:

```nginx
server {
    listen 443 ssl;
    server_name cms.xposcreens.com;
    # ssl_certificate ... (Let's Encrypt)
    client_max_body_size 16m;   # i.v.m. media-uploads (bodyLimit is 12 MB)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 5. Als systemd-service

`/etc/systemd/system/xpo-cms.service`:

```ini
[Unit]
Description=XPO CMS
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/xpo-cms
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=XPO_DB=/var/lib/xpo-cms/xpo.db
Environment=XPO_SECRET=zet-hier-je-geheime-sleutel
ExecStart=/usr/bin/npm start
Restart=on-failure
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xpo-cms
sudo systemctl status xpo-cms
```

## 6. Azure App Service (Linux, Node 22)

- Maak een Web App met runtime **Node 22 LTS**.
- Stel de App-instellingen (= omgevingsvariabelen) `XPO_SECRET`, `XPO_DB`, en eventueel `PORT` in (App Service zet `PORT` zelf — de app respecteert die).
- Zet `XPO_DB` op een pad onder `/home` (persistent op App Service), bv. `/home/data/xpo.db`.
- Startup command: `npm start`.
- Schakel **Always On** in zodat de app niet in slaap valt.
- Gebruik de health-probe op `/api/health` voor de Azure-gezondheidscontrole.

## 7. Back-ups

Twee lagen:

1. **Database-bestand.** Kopieer periodiek `XPO_DB` (en de bijbehorende `-wal`/`-shm` bestanden) naar een veilige locatie. Met SQLite kan dat live met `sqlite3 xpo.db ".backup back.db"` of door de service kort te stoppen.
2. **Ingebouwde export.** In de admin onder **Back-up** → *Exporteer* haal je een volledige JSON-export op (pagina's, posts, instellingen, etc.). *Importeer* zet die additief terug. Handig voor migraties tussen omgevingen.

Geüploade media staan als data-URL's in de database (en in `data/uploads/`), dus de database-back-up dekt de inhoud. Voor grote volumes: zie Azure Blob in sectie 9.

## 8. Health-monitoring

`GET /api/health` geeft:

```json
{ "ok": true, "version": "1.0.0", "uptime": 1234, "db": "ok", "ts": 1718800000000 }
```

`ok:false` of `db:"error"` betekent dat de databaseverbinding stuk is. Koppel dit aan je uptime-monitor of de Azure-probe.

## 9. Productie-integraties: wat klaar is en wat nog moet

### Mollie (betalingen) — code klaar, sleutel nodig
De webshop maakt bij het afrekenen een order + betaling aan. **Zonder** Mollie-sleutel gebruikt hij een lokale betaalpagina-stub (handmatig bevestigen). **Met** sleutel opent de echte Mollie-checkout.

Te doen: vul in de admin onder **Commerce** je Mollie API-sleutel (`live_…`) en de valuta in. Stel in het Mollie-dashboard de **webhook** in die na betaling `POST /api/payments/:id/confirm` aanroept zodat orders automatisch op *betaald* komen en de voorraad wordt afgeboekt. (De server moet daarvoor publiek bereikbaar zijn via je domein.)

### SMTP / e-mail — code klaar, server + dependency nodig
Formulier-e-mailacties lopen via een wachtrij en een mailer met twee modi (admin → **Leads** → *E-mailinstellingen*):
- **Outbox (log)** — standaard, logt elke e-mail lokaal. Geen externe verzending.
- **SMTP** — echte verzending. Vereist `npm install nodemailer` op de server en geldige SMTP-gegevens (host/poort/gebruiker/wachtwoord/TLS). De code importeert nodemailer dynamisch; ontbreekt het pakket of de netwerktoegang, dan markeert hij de bezorging netjes als mislukt.

Te doen: `npm install nodemailer`, modus op **SMTP** zetten, servergegevens invullen. Voor Microsoft 365 kun je in plaats van SMTP later de Graph API koppelen (vereist extra code).

### Media-opslag (Azure Blob) — code klaar, account + token nodig
Uploads gaan via een opslag-adapter met twee drivers (admin → **Media** → *Opslag*):
- **Lokaal** — standaard, schrijft naar `data/uploads/` op de server.
- **Azure Blob** — schaalbare cloudopslag. Vereist `npm install @azure/storage-blob` op de server plus een **Account-URL**, **container** en **SAS-token** (met schrijfrechten). De adapter importeert het pakket dynamisch en valt bij een ontbrekend pakket, lege config of uploadfout netjes terug op lokale opslag (de bezorging mislukt dus nooit hard).

Te doen: `npm install @azure/storage-blob`, in de admin de driver op **Azure Blob** zetten en de account-URL/container/SAS invullen. Overweeg een CDN voor de container-URL. Bestaande lokale uploads blijven werken; nieuwe gaan naar Blob.

### Entra ID single sign-on — code klaar, App-registratie nodig
Naast e-mail/wachtwoord is er nu een OIDC-koppeling met Microsoft Entra ID (autorisatiecode-flow), te configureren in de admin → **Gebruikers** → *Single sign-on*. Endpoints:
- `GET /api/auth/sso/login` — bouwt de Entra authorize-URL en leidt door naar Microsoft.
- `GET /api/auth/sso/callback` — wisselt de code in voor tokens, leest de claims (e-mail, naam, groepen), mapt groepen op een rol (hoogste match, anders de standaardrol), maakt/werkt de gebruiker bij en logt in.

Te doen: maak in Entra een **App-registratie** aan met redirect-URI `https://JOUW-DOMEIN/api/auth/sso/callback` en de scopes openid/profile/email; vul tenant-ID, client-ID, client-secret en de redirect-URI in de admin in, plus de groep→rol-koppelingen. De token-uitwisseling en het lezen van de groeps-claims vereisen een productieomgeving met netwerktoegang naar Microsoft. **Beveiligingsnoot:** verifieer in productie de handtekening van het `id_token` tegen de JWKS van Entra (de scaffold decodeert de claims; voeg JWKS-validatie toe voordat dit live gaat). De groep→rol-mapping, de provisioning en de redirect zijn getest; de live token-uitwisseling niet (vereist de IdP).

## 10. Beveiligingschecklist voor productie

- [ ] Vaste `XPO_SECRET` gezet (niet de standaard).
- [ ] Seed-admin-wachtwoord gewijzigd of seed-account vervangen.
- [ ] TLS via reverse proxy (Caddy/Nginx) of App Service.
- [ ] `XPO_DB` op een persistent, geback-upt volume.
- [ ] Back-upschema actief (database + periodieke JSON-export).
- [ ] Health-probe op `/api/health` gekoppeld aan monitoring.
- [ ] Mollie-webhook ingesteld (als de shop live gaat).
- [ ] SMTP getest met een echte inzending (als e-mail live gaat).
- [x] **Rate-limiting** op de inlog-endpoints — in de app (instelbaar via `XPO_RL_MAX` / `XPO_RL_WINDOW_MS`). Voor meerdere instances achter een load balancer: overweeg een gedeelde store (Redis).
- [x] **Content-Security-Policy** + X-Frame-Options, HSTS, Referrer-Policy, Permissions-Policy — in de app gezet.
- [ ] Resterende ISO-27001-punten op infrastructuurniveau: **Key Vault** voor secrets (i.p.v. env-variabelen), **gecentraliseerde logging/monitoring** (bv. Azure Monitor/Sentinel), en een **DR-/herstelplan**. Deze vallen op omgevingsniveau, niet in de applicatiecode.

---

*Run lokaal altijd eerst `npm run seed` en daarna `npm start`. Bij een schone herstart van de data: verwijder de bestanden in `data/` en seed opnieuw.*

## Architectuur & datalaag (productie)

### Database — SQLite → PostgreSQL / Azure SQL
- Standaard draait alles op SQLite (lokaal/CI). Voor productie: zet `DB_DRIVER=postgres` en `DATABASE_URL=postgres://…` (of Azure SQL connection string), `npm i pg`, en draai `npm run migrate:pg`.
- Migraties staan versiegestuurd in `src/db/migrations/*.sql` en draaien elk precies één keer (`_migrations`-tabel). Nieuwe wijziging = nieuw genummerd `.sql`-bestand.
- De SQLite-DDL wordt automatisch naar Postgres vertaald (`toPostgres`); row-level security-policies staan klaar in `0002_tenant_indexes.sql` (worden actief op Postgres).
- **Back-ups:** `npm run backup` maakt een atomaire SQLite-snapshot (`VACUUM INTO`). Op Postgres: `pg_dump` of Azure SQL automated backups + restore-test.
- Let op: de live Postgres-driver vereist nog het async maken van de querylaag (de repos zijn nu synchroon t.b.v. node:sqlite). De migratie-/DDL-/config-laag is volledig klaar.

### Multi-tenant
- Tenant wordt bepaald via (1) het ingelogde token, (2) domein/subdomein, (3) `x-tenant`-header (alleen bekende tenants), (4) standaard. Config via env: `XPO_KNOWN_TENANTS`, `XPO_TENANTS` (JSON host→tenant), `XPO_DEFAULT_TENANT`.
- Ingelogde requests zijn hard aan de tenant van de gebruiker gebonden (niet via header te overschrijven).

### Plugins
- Plugins registreren widgets, hooks (`addFilter`/`applyFilters`, `addAction`/`doAction`) en betaalproviders zonder de kern te wijzigen. Nieuwe plugin: bestand in `src/plugins/` + import in `src/plugins/index.js`.
- Betaalproviders via registry (`stub`, `mollie`). `/api/payment-providers` toont ze.

### Background jobs
- Job-queue met retries + exponentiële backoff (`jobs`-tabel). E-mail, sitemap en imports lopen via `enqueue(...)`. De worker start in `main.ts` (`startWorker`). `/api/system` toont queue-status.
- Voor meerdere instances: vervang de in-proces worker door Redis/BullMQ (zelfde `enqueue`-API).

## Beveiliging (productie)
- **Secrets:** zet `XPO_SECRET` (≥24 tekens) en `XPO_PEPPER` als Key Vault references in App Service; nooit de dev-default gebruiken.
- **Tokens:** access-token TTL via `XPO_ACCESS_TTL` (default 900s), refresh via `XPO_REFRESH_TTL`. Logout-overal bumpt `users.token_version`.
- **CSRF:** zet `XPO_ALLOWED_ORIGINS` (komma-gescheiden) voor toegestane cross-origin clients; overige cross-origin mutaties worden geweigerd.
- **Brute-force:** `XPO_LOGIN_MAXFAILS` / `XPO_LOGIN_WINDOW`. In-memory lockout → vervang door Redis voor meerdere instances.
- **CSP:** publieke pagina's draaien op nonce-CSP (geen unsafe-inline); de admin houdt een eigen first-party CSP. Violations komen binnen op `/api/csp-report`.
- **Uploads:** MIME-allowlist + magic-byte-check + 8MB-limiet; zet de media-driver op Azure Blob (SAS) en voeg een virusscan (ClamAV) toe in productie.
- **Dependency-scanning:** CI draait `npm audit --audit-level=high`; Dependabot staat aan voor npm + actions.

## Snelheid & performance
- **Render-cache:** publieke pagina's worden gecachet (in-memory, `XPO_RENDER_TTL`) met ETag + `Cache-Control` (`s-maxage` voor CDN). Cache wordt automatisch geïnvalideerd bij elke contentmutatie. Voor meerdere instances: swap naar Redis (zelfde API in `core/render-cache.ts`).
- **CDN + assets:** zet `XPO_ASSET_BASE` naar je CDN-URL en `XPO_ASSET_VER` per release; assets krijgen `?v=` en worden `immutable` gecachet (lost stale-cache op zoals bij Kinsta).
- **Fonts:** zelf-gehost via `public/xpo-fonts.css`; plaats de woff2 in `public/fonts/` (zonder bestanden valt het systeem-font in, geen Google-call).
- **Bundeling:** `xpo-*.js` worden bij opstart gebundeld tot `public/xpo-bundle.js` (één deferred script); Lottie/Quinty/popups laden alleen waar nodig.
- **Beeld:** afbeeldingen krijgen `loading="lazy"` + `decoding="async"`. WebP/AVIF/resize/srcset vereist een image-pipeline (sharp of Azure CDN image-processing) — aansluitpunt gedocumenteerd.
- **DB:** extra indexen (migratie 0005) voor hot lookups; de render-paden gebruiken per sectie één query (geen N+1).
- **Lighthouse:** `.lighthouserc.json` bewaakt Core Web Vitals; workflow `lighthouse.yml` draait `@lhci/cli` op PR's.

## Content: revisies, preview, meertaligheid
- **Revisies:** elke pagina-opslag bewaart de vorige versie (`page_versions`, gecapt op 30). Lijst via `GET /api/pages/:id/versions`, terugdraaien via `POST /api/pages/:id/restore-version/:vid`.
- **Preview:** `POST /api/pages/:id/preview-token` (of `/api/posts/:id/preview-token`) geeft een ondertekende URL `/preview/page/:id?token=…` die het concept toont (noindex, `no-store`). TTL via `XPO_PREVIEW_TTL` (sec).
- **Meertaligheid:** `POST /api/pages/:id/translate {locale}` maakt een vertaling in dezelfde `trans_group`; gepubliceerde vertalingen krijgen automatisch `hreflang`-links (+ `x-default`).
- **Geplande publicatie:** zet status `scheduled` + `scheduled_at`; concepten worden bij de eerstvolgende read live gezet.

## Schalen: Redis, Postgres, beeld-pipeline
- **Redis-cache:** `npm i ioredis` + zet `REDIS_URL`; render-cache schakelt automatisch over (anders in-memory). Zelfde voor toekomstige rate-limit/lockout-stores.
- **Postgres/Azure SQL:** `npm i pg`, zet `DB_DRIVER=postgres` + `DATABASE_URL`, draai `npm run migrate:pg`. De querylaag gebruikt `getAsyncDb()`; de analytics-module draait er al volledig op. De overige repos zijn een mechanische await-omzetting naar dezelfde async-API (in uitvoering).
- **Beeld (WebP/AVIF/resize):** `npm i sharp` activeert echte transcodering op `/img?src=…&w=…&f=webp|avif`; zonder sharp wordt het origineel geserveerd (zelfde URL's). Alleen lokale `/uploads` en `/assets` zijn toegestaan (SSRF-veilig).
- **Performance-budget:** `npm run perf` bewaakt payload, render-blocking, caching-headers, fonts en lazy images; draait in CI naast de tests.

## Webshop (productie)
- **Mollie:** zet `shop.mollieKey` in de instellingen (of `MOLLIE_KEY`). Checkout maakt een echte Mollie-betaling; configureer in Mollie de webhook-URL naar `POST /api/webhooks/mollie`. De webhook haalt de status live op en is idempotent. Zonder sleutel draait de lokale betaalstub (`/pay/:id` + `/api/payments/:id/confirm`).
- **Voorraad:** wordt bij checkout gereserveerd (race-veilig, oversell onmogelijk) en bij verlopen/geannuleerd/refund weer vrijgegeven.
- **Varianten:** geef producten `variants: [{ sku, options, priceCents, stock, weightGrams }]` mee voor echte SKU's met eigen prijs/voorraad.
- **BTW/verzending:** `shop.vatRates` (per land, OSS) en `shop.zones` (landen + gewichtstaffels) in de instellingen; anders het vlakke tarief + verzendmethode.
- **Facturen:** `GET /api/orders/:ref/invoice` levert een BTW-factuur-PDF; factuurnummers lopen op per tenant per jaar (`XPO-2026-00001`).
