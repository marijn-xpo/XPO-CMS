CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     TEXT NOT NULL DEFAULT 'xpo',
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL DEFAULT 'editor',
  password_hash TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL DEFAULT 'xpo',
  slug            TEXT NOT NULL,
  title           TEXT NOT NULL,
  template        TEXT NOT NULL DEFAULT 'Landing',
  locale          TEXT NOT NULL DEFAULT 'nl',
  status          TEXT NOT NULL DEFAULT 'draft',
  seo_title       TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  blocks          TEXT NOT NULL,
  meta            TEXT NOT NULL DEFAULT '{}',
  parent_id       INTEGER,
  author          TEXT NOT NULL DEFAULT '',
  scheduled_at    TEXT,
  deleted         INTEGER NOT NULL DEFAULT 0,
  seo_keyword     TEXT NOT NULL DEFAULT '',
  seo_schema      TEXT NOT NULL DEFAULT 'Article',
  seo_og_image    TEXT NOT NULL DEFAULT '',
  seo_noindex     INTEGER NOT NULL DEFAULT 0,
  seo_canonical   TEXT NOT NULL DEFAULT '',
  trans_group     TEXT NOT NULL DEFAULT '',
  published       TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (tenant_id, slug)
);
CREATE TABLE IF NOT EXISTS page_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id    INTEGER NOT NULL,
  tenant_id  TEXT NOT NULL,
  blocks     TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_page ON page_versions(page_id);
CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL DEFAULT 'xpo',
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  url        TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  tenant_id TEXT PRIMARY KEY,
  json      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS forms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL DEFAULT 'xpo',
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL,
  fields     TEXT NOT NULL,
  actions    TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, slug)
);
CREATE TABLE IF NOT EXISTS form_submissions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id    INTEGER NOT NULL,
  tenant_id  TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_form ON form_submissions(form_id);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL DEFAULT 'xpo',
  name        TEXT NOT NULL,
  price       TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  slug        TEXT NOT NULL DEFAULT '',
  stock       INTEGER NOT NULL DEFAULT 0,
  image       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  attributes  TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL DEFAULT 'xpo',
  product_id INTEGER NOT NULL,
  author     TEXT NOT NULL DEFAULT 'Anoniem',
  rating     INTEGER NOT NULL DEFAULT 5,
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS coupons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL DEFAULT 'xpo',
  code       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'percent',
  value      INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);
CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL DEFAULT 'xpo',
  ref         TEXT NOT NULL,
  customer    TEXT NOT NULL,
  email       TEXT NOT NULL DEFAULT '',
  amount      TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  items       TEXT NOT NULL DEFAULT '[]',
  method      TEXT NOT NULL DEFAULT '',
  payment_id  TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'Nieuw',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS navigation (
  tenant_id TEXT PRIMARY KEY,
  json      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS redirects (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  from_path  TEXT NOT NULL,
  to_path    TEXT NOT NULL,
  code       TEXT NOT NULL DEFAULT '301',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_redirects_from ON redirects (tenant_id, from_path);

CREATE TABLE IF NOT EXISTS tickets (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  subject    TEXT NOT NULL,
  from_addr  TEXT NOT NULL,
  channel    TEXT NOT NULL DEFAULT 'Portal',
  status     TEXT NOT NULL DEFAULT 'Open',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_articles (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  channel    TEXT NOT NULL DEFAULT 'E-mail',
  status     TEXT NOT NULL DEFAULT 'concept',
  sent       INTEGER NOT NULL DEFAULT 0,
  open_rate  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS field_groups (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  location   TEXT NOT NULL DEFAULT '',
  fields     TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS languages (
  tenant_id  TEXT NOT NULL,
  code       TEXT NOT NULL,
  label      TEXT NOT NULL,
  flag       TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL DEFAULT '/',
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS templates (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'Single',
  condition  TEXT NOT NULL DEFAULT '',
  blocks     TEXT NOT NULL DEFAULT '{}',
  conditions TEXT NOT NULL DEFAULT '[]',
  status     TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  actor      TEXT NOT NULL DEFAULT 'systeem',
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  status     INTEGER NOT NULL DEFAULT 200,
  kind       TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity (tenant_id, ts DESC);

CREATE TABLE IF NOT EXISTS posts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL DEFAULT 'xpo',
  slug            TEXT NOT NULL,
  title           TEXT NOT NULL,
  excerpt         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft',
  author          TEXT NOT NULL DEFAULT '',
  locale          TEXT NOT NULL DEFAULT 'nl',
  type            TEXT NOT NULL DEFAULT 'post',
  blocks          TEXT NOT NULL,
  published       TEXT,
  seo_title       TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  seo_keyword     TEXT NOT NULL DEFAULT '',
  seo_schema      TEXT NOT NULL DEFAULT 'BlogPosting',
  scheduled_at    TEXT,
  deleted         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS terms (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  taxonomy   TEXT NOT NULL,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_terms_tax ON terms (tenant_id, taxonomy);

CREATE TABLE IF NOT EXISTS post_terms (
  post_id   INTEGER NOT NULL,
  term_id   TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  PRIMARY KEY (post_id, term_id)
);

CREATE TABLE IF NOT EXISTS snippets (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  block      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS popups (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 0,
  trigger    TEXT NOT NULL DEFAULT 'load',
  delay      INTEGER NOT NULL DEFAULT 2,
  cond_type  TEXT NOT NULL DEFAULT 'all',
  cond_value TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  btn_label  TEXT NOT NULL DEFAULT '',
  btn_url    TEXT NOT NULL DEFAULT '',
  image      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crm_leads (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  form_id    INTEGER,
  name       TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  company    TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS form_deliveries (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  form_id       INTEGER,
  submission_id INTEGER,
  type          TEXT NOT NULL,
  target        TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'queued',
  payload       TEXT NOT NULL DEFAULT '{}',
  error         TEXT NOT NULL DEFAULT '',
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  post_id    INTEGER NOT NULL,
  author     TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending',
  parent_id  TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_kb (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_logs (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  question   TEXT NOT NULL DEFAULT '',
  answer     TEXT NOT NULL DEFAULT '',
  provider   TEXT NOT NULL DEFAULT 'local',
  score      REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS carts (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  items      TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  order_ref    TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'EUR',
  status       TEXT NOT NULL DEFAULT 'open',
  provider     TEXT NOT NULL DEFAULT 'local',
  checkout_url TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  to_addr    TEXT NOT NULL DEFAULT '',
  subject    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'sent',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     TEXT NOT NULL DEFAULT 'xpo',
  name          TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS pageviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL DEFAULT 'xpo',
  path       TEXT NOT NULL DEFAULT '/',
  session    TEXT NOT NULL DEFAULT '',
  ref        TEXT NOT NULL DEFAULT '',
  day        TEXT NOT NULL DEFAULT '',
  ts         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pageviews_tenant_ts ON pageviews(tenant_id, ts);
