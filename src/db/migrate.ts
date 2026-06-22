import { migrate, dbInfo } from "./database.js";
const r = migrate();
console.log("Driver:", dbInfo().driver);
console.log("\u2713 Migraties toegepast:", r.applied.length ? r.applied.join(", ") : "(geen nieuwe)", "| overgeslagen:", r.skipped.length);
