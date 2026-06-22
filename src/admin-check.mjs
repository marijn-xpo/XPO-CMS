import { readFileSync } from "node:fs";
const s = readFileSync(new URL("../admin/index.html", import.meta.url), "utf8");
let fail = 0;
const ok = (n, pass, d = "") => { console.log((pass ? "  ✓ " : "  ✗ ") + n + (d ? " (" + d + ")" : "")); if (!pass) fail++; };

// 1) geen voortijdige </script> in een bare <script>-blok (breekt de HTML-parser)
let clean = true;
for (const m of s.matchAll(/<script>\n/g)) {
  const start = m.index + m[0].length;
  if (s.slice(start, s.indexOf("</script>", start)).includes("</script>")) clean = false;
}
ok("geen voortijdige </script> in inline-scripts", clean);

// 2) hoofd-app-script is geldige JS (octale escapes e.d. worden hier gevangen)
const lines = s.split("\n");
const open = lines.findIndex((l) => l.trim() === "<script>");
const close = lines.findIndex((l, i) => i > open && l.trim() === "</script>");
let appJsOk = true, appErr = "";
try { new Function(lines.slice(open + 1, close).join("\n")); } catch (e) { appJsOk = false; appErr = e.message; }
ok("hoofd-app-script is geldige JS", appJsOk, appErr);

// 3) de Vue-template (#tpl) compileert naar geldige JS (vangt kapotte bindings/expressies)
const m = s.match(/<script type="text\/html" id="tpl">([\s\S]*?)<\/script>/);
let tplOk = true, tplErr = "";
if (m) {
  try {
    const { compile } = await import("@vue/compiler-dom");
    new Function(compile(m[1], { mode: "function" }).code);
  } catch (e) { tplOk = false; tplErr = e.message; }
} else { tplOk = false; tplErr = "#tpl niet gevonden"; }
ok("Vue-template (#tpl) compileert naar geldige JS", tplOk, tplErr);

console.log(fail === 0 ? "✓ admin-check geslaagd" : "✗ admin-check gefaald (" + fail + ")");
process.exit(fail === 0 ? 0 : 1);
