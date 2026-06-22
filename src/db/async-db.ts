import { getDb, dbDriver } from "./database.js";

// Async data-access-laag. SQLite draait synchroon onder de motorkap maar levert promises,
// zodat dezelfde repo-code straks tegen Postgres/Azure SQL kan draaien (pg-driver, echt async).
export interface AsyncDb {
  get<T = any>(sql: string, params?: any[]): Promise<T | undefined>;
  all<T = any>(sql: string, params?: any[]): Promise<T[]>;
  run(sql: string, params?: any[]): Promise<{ changes: number; lastInsertRowid: number }>;
  exec(sql: string): Promise<void>;
  driver: string;
}

class SqliteAsync implements AsyncDb {
  driver = "sqlite";
  async get<T>(sql: string, params: any[] = []) { return getDb().prepare(sql).get(...params) as T | undefined; }
  async all<T>(sql: string, params: any[] = []) { return getDb().prepare(sql).all(...params) as T[]; }
  async run(sql: string, params: any[] = []) { const i = getDb().prepare(sql).run(...params); return { changes: Number(i.changes), lastInsertRowid: Number(i.lastInsertRowid) }; }
  async exec(sql: string) { getDb().exec(sql); }
}

// ?-placeholders -> $1, $2, ... voor PostgreSQL.
function toPgParams(sql: string): string { let i = 0; return sql.replace(/\?/g, () => "$" + (++i)); }
class PostgresAsync implements AsyncDb {
  driver = "postgres";
  constructor(private pool: any) {}
  async get<T>(sql: string, params: any[] = []) { const r = await this.pool.query(toPgParams(sql), params); return r.rows[0] as T | undefined; }
  async all<T>(sql: string, params: any[] = []) { const r = await this.pool.query(toPgParams(sql), params); return r.rows as T[]; }
  async run(sql: string, params: any[] = []) { const r = await this.pool.query(toPgParams(sql), params); return { changes: r.rowCount || 0, lastInsertRowid: r.rows?.[0]?.id ?? 0 }; }
  async exec(sql: string) { await this.pool.query(sql); }
}

let inst: AsyncDb | null = null;
export async function getAsyncDb(): Promise<AsyncDb> {
  if (inst) return inst;
  if (dbDriver() === "postgres" && process.env.DATABASE_URL) {
    try { const mod = "pg"; const pg: any = await import(mod); inst = new PostgresAsync(new pg.Pool({ connectionString: process.env.DATABASE_URL })); return inst; } catch { /* val terug op sqlite */ }
  }
  inst = new SqliteAsync();
  return inst;
}
