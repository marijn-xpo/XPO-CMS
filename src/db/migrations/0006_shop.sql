-- Per-variant SKU's + gewicht voor verzendberekening.
ALTER TABLE products ADD COLUMN variants TEXT NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN weight_grams INTEGER NOT NULL DEFAULT 0;

-- Order-velden: factuurnummer, land (BTW/OSS), BTW- en verzendbedrag, betaalstatus-tijd.
ALTER TABLE orders ADD COLUMN invoice_no TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN country TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN vat_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN ship_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN paid_at INTEGER NOT NULL DEFAULT 0;

-- Oplopende factuurnummering per tenant per jaar.
CREATE TABLE IF NOT EXISTS order_seq (
  tenant_id TEXT NOT NULL,
  year      INTEGER NOT NULL,
  seq       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, year)
);
