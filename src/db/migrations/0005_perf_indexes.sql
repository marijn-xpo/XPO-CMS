-- Indexen voor hot lookups onder load (voorkomt full-table-scans).
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_orders_ref ON orders(tenant_id, ref);
CREATE INDEX IF NOT EXISTS idx_orders_payment ON orders(payment_id);
CREATE INDEX IF NOT EXISTS idx_pageviews_day ON pageviews(tenant_id, day);
CREATE INDEX IF NOT EXISTS idx_pageviews_session ON pageviews(tenant_id, session);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON product_reviews(product_id, status);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(tenant_id, status, type);
CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(tenant_id, slug);
CREATE INDEX IF NOT EXISTS idx_pages_slug ON pages(tenant_id, slug);
