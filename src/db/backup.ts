import { dbDriver, backupSqlite } from "./database.js";
if (dbDriver() === "postgres") {
  console.log("Postgres-modus: gebruik 'pg_dump \"$DATABASE_URL\" > backup.sql' (of Azure SQL automated backups).");
} else {
  const f = backupSqlite();
  console.log("\u2713 Back-up gemaakt: " + f);
}
