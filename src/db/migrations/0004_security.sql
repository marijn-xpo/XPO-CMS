-- Token-revocatie: bump om alle access/refresh-tokens van een gebruiker ongeldig te maken (logout-overal).
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

-- Refresh-sessies (roterende refresh-tokens, server-side intrekbaar).
CREATE TABLE IF NOT EXISTS auth_sessions (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL DEFAULT 'xpo',
  user_id      INTEGER NOT NULL,
  token_hash   TEXT NOT NULL,
  user_agent   TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  expires_at   INTEGER NOT NULL DEFAULT 0,
  revoked      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
