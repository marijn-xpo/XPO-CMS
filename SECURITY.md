# Beveiligingsbeleid

## Kwetsbaarheid melden
Meld beveiligingsproblemen vertrouwelijk via security@xposcreens.com. Geef geen publieke issue aan.
We reageren binnen 5 werkdagen en houden je op de hoogte van de afhandeling.

## Geïmplementeerde maatregelen
- **Wachtwoorden:** scrypt (N=16384) met per-gebruiker salt + server-pepper (`XPO_PEPPER`); automatische rehash bij login; sterkte-eis.
- **Sessies:** korte access-tokens (15 min) + roterende refresh-tokens (server-side intrekbaar) + token-revocatie (logout-overal via `token_version`).
- **Secrets:** via `getSecret()` (env nu, Azure Key Vault in productie). Nooit hardcoded.
- **CSRF:** Origin/Referer-controle op alle muterende endpoints + `SameSite`-cookies.
- **CSP:** nonce-gebaseerd voor scripts (geen `unsafe-inline`), plus HSTS, Permissions-Policy, X-Content-Type-Options, frame-ancestors en CSP-reporting.
- **Invoer/uitvoer:** server-side escaping in de render-engine; rauwe-HTML-nodes worden uit door-gebruikers-opgeslagen content gestript (geen opgeslagen XSS).
- **Brute-force:** login-lockout per e-mail+IP; rate-limiting per endpoint; honeypot op publieke formulieren.
- **Uploads:** MIME-allowlist + magic-byte-validatie + groottelimiet + veilige bestandsnamen; SVG geweigerd.
- **RBAC + audit:** rolgebaseerde permissies (viewer/author/editor/shop_manager/seo/admin) en een auditlog van alle muterende acties.

## Aanbevolen in productie (infra)
- Redis-backed rate-limiting/lockout over meerdere instances.
- ClamAV/virusscan op uploads + Azure Blob met SAS (buiten de webroot).
- Azure Key Vault voor `XPO_SECRET`/`XPO_PEPPER`/`DATABASE_URL`.
- WAF + DDoS-bescherming (Azure Front Door) en periodieke pen-tests.
