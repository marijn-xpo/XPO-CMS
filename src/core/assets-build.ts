import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PUB = join(here, "../../public");
const PARTS = ["xpo-menus.js", "xpo-fx.js", "xpo-comments.js", "xpo-shop.js", "xpo-forms.js", "xpo-product.js"];
const OUT = join(PUB, "xpo-bundle.js");

// Bundelt de losse front-end scripts tot één bestand (minder requests). Lichte, veilige minify
// (alleen volledige-regel-comments en lege regels strippen; geen risicovolle token-herschrijving).
function lightMinify(js: string): string {
  return js.split("\n").map((l) => l.replace(/^\s+/, "")).filter((l) => l && !l.startsWith("//")).join("\n");
}
export function ensureBundle(): void {
  try {
    const parts = PARTS.filter((f) => existsSync(join(PUB, f)));
    if (!parts.length) return;
    const newest = Math.max(...parts.map((f) => statSync(join(PUB, f)).mtimeMs));
    if (existsSync(OUT) && statSync(OUT).mtimeMs >= newest) return; // up-to-date
    const body = parts.map((f) => "/* " + f + " */\n" + lightMinify(readFileSync(join(PUB, f), "utf8"))).join("\n;\n");
    writeFileSync(OUT, "/* xpo-bundle — autogen */\n" + body);
  } catch { /* bundelen mag het opstarten nooit breken */ }
}
