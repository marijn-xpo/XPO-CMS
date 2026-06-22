import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.XPO_DB || join(here, "../../data/xpo.db");
const MIGRATIONS_DIR = join(here, "migrations");

export type DbDriver = "sqlite" | "postgres";
export function dbDriver(): DbDriver {
  return process.env.DB_DRIVER === "postgres" ? "postgres" : "sqlite";
}
export function dbInfo() {
  return { driver: dbDriver(), url: dbDriver() === "postgres" ? (process.env.DATABASE_URL ? "(geconfigureerd)" : "(ontbreekt)") : DB_PATH, migrationsDir: MIGRATIONS_DIR };
}

let db: DatabaseSync | null = null;
export function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  }
  return db;
}

function listMigrations(): { name: string; sql: string; hash: string }[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
      return { name, sql, hash: createHash("sha256").update(sql).digest("hex").slice(0, 16) };
    });
}

export function appliedMigrations(): string[] {
  const d = getDb();
  d.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at TEXT NOT NULL)");
  return (d.prepare("SELECT name FROM _migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

// Versiegestuurde migraties: elke .sql in migrations/ draait precies een keer, in volgorde, in een transactie.
export function migrate(): { applied: string[]; skipped: string[] } {
  const d = getDb();
  const done = new Set(appliedMigrations());
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const m of listMigrations()) {
    if (done.has(m.name)) { skipped.push(m.name); continue; }
    d.exec("BEGIN");
    try {
      d.exec(m.sql);
      d.prepare("INSERT INTO _migrations (name, hash, applied_at) VALUES (?, ?, ?)").run(m.name, m.hash, new Date().toISOString());
      d.exec("COMMIT");
      applied.push(m.name);
    } catch (e) {
      d.exec("ROLLBACK");
      throw new Error("Migratie " + m.name + " mislukt: " + (e as Error).message);
    }
  }
  return { applied, skipped };
}

// Vertaalt de SQLite-DDL naar PostgreSQL/Azure SQL zodat dezelfde migraties daar kunnen draaien.
export function toPostgres(sql: string): string {
  return sql
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, "SERIAL PRIMARY KEY")
    .replace(/\bDATETIME\b/gi, "TIMESTAMPTZ")
    .replace(/PRAGMA[^;]+;/gi, "");
}
// De Postgres-driver wordt dynamisch geladen zodat 'pg' geen build-dependency is voor de SQLite-modus.
export async function migratePostgres(): Promise<{ applied: string[] }> {
  if (dbDriver() !== "postgres") throw new Error("DB_DRIVER is geen 'postgres'");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL ontbreekt");
  const mod = "pg";
  const pg = await import(mod) as any;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const done = new Set(((await client.query("SELECT name FROM _migrations")).rows as any[]).map((r) => r.name));
  const applied: string[] = [];
  for (const m of listMigrations()) {
    if (done.has(m.name)) continue;
    await client.query("BEGIN");
    try {
      await client.query(toPostgres(m.sql));
      await client.query("INSERT INTO _migrations (name, hash) VALUES ($1, $2)", [m.name, m.hash]);
      await client.query("COMMIT");
      applied.push(m.name);
    } catch (e) {
      await client.query("ROLLBACK");
      await client.end();
      throw e;
    }
  }
  await client.end();
  return { applied };
}

// Consistente back-up van de SQLite-database (VACUUM INTO maakt een atomaire snapshot).
export function backupSqlite(): string {
  const dir = join(here, "../../data/backups");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out = join(dir, "xpo-" + new Date().toISOString().replace(/[:.]/g, "-") + ".db");
  getDb().exec("VACUUM INTO '" + out.replace(/'/g, "''") + "'");
  return out;
}
