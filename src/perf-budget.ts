import { buildApp } from "./app.js";

// Draaibaar performance-budget (proxy voor Core Web Vitals zonder headless browser).
// Bewaakt de bekende LCP/CLS/render-blocking-risico's in de gegenereerde HTML + headers.
const app = await buildApp();
let fail = 0;
const check = (name: string, pass: boolean, detail = "") => { console.log((pass ? "  \u2713 " : "  \u2717 ") + name + (detail ? "  (" + detail + ")" : "")); if (!pass) fail++; };

const res = await app.inject({ method: "GET", url: "/site" });
const html = res.body;
const headInner = (html.match(/<head[\s\S]*?<\/head>/i) || [""])[0];
const sizeKb = Buffer.byteLength(html) / 1024;
const blockingHeadScripts = (headInner.match(/<script\s+src=(?![^>]*\b(defer|async)\b)[^>]*>/gi) || []).length;
const bundleCount = (html.match(/xpo-bundle\.js/g) || []).length;
const imgs = html.match(/<img\b[^>]*>/gi) || [];
const lazyImgs = imgs.filter((t) => /loading="lazy"/.test(t)).length;

console.log("Performance-budget — GET /site");
check("HTML-payload < 150 KB", sizeKb < 150, sizeKb.toFixed(1) + " KB");
check("geen render-blocking scripts in <head>", blockingHeadScripts === 0, blockingHeadScripts + " gevonden");
check("front-end gebundeld (1 script)", bundleCount === 1, bundleCount + "x");
check("JS-bundle is deferred", /xpo-bundle\.js[^"]*"\s+defer/.test(html));
check("geen render-blocking Google Fonts", !html.includes("fonts.googleapis.com"));
check("ETag + Cache-Control aanwezig", !!res.headers["etag"] && String(res.headers["cache-control"] || "").includes("max-age"));
check("CSP via nonce (geen unsafe-inline scripts)", /script-src[^;]*'nonce-/.test(String(res.headers["content-security-policy"] || "")));
check("alle afbeeldingen lazy-loaded", imgs.length === 0 || lazyImgs === imgs.length, lazyImgs + "/" + imgs.length);

await app.close();
console.log(fail === 0 ? "\u2713 Budget gehaald" : "\u2717 Budget overschreden (" + fail + ")");
process.exit(fail === 0 ? 0 : 1);
