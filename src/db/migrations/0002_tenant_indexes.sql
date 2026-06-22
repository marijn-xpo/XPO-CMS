-- Snellere tenant-gescopete queries (geldt in SQLite en Postgres).
CREATE INDEX IF NOT EXISTS idx_pages_tenant ON pages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_posts_tenant ON posts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_media_tenant ON media(tenant_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_tenant ON form_submissions(tenant_id);

-- PostgreSQL row-level security (harde isolatie op DB-niveau). Wordt door de SQLite-runner
-- als commentaar genegeerd; toPostgres() laat dit staan zodat het op Azure SQL/Postgres actief wordt.
-- Voorbeeld voor de pages-tabel (herhaal per tenant-gescopete tabel):
--   ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY tenant_isolation ON pages
--     USING (tenant_id = current_setting('app.tenant', true));
-- De applicatie zet per request: SET app.tenant = '<tenant>';
