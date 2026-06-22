import { JSDOM } from "/home/claude/out/node_modules/jsdom/lib/api.js";
import { readFileSync } from "node:fs";

const lib = readFileSync(new URL("../public/xpo-menus.js", import.meta.url), "utf8");

const html = `<!DOCTYPE html><html><body>
<header class="xpo-bar" data-xpo-nav>
  <a class="xpo-brand" href="/">XPO</a>
  <button class="xpo-burger" aria-label="Menu"><span></span></button>
  <nav class="xpo-nav"><ul class="xpo-menu">
    <li class="xpo-has-mega">
      <button class="xpo-top">Solutions</button>
      <div class="xpo-mega"><div class="xpo-mega__cols">
        <div class="xpo-col"><p class="xpo-col__h">Smart mirrors</p><ul>
          <li><a href="/invite"><span class="xpo-i__t">INVITE</span><span class="xpo-i__d">21 inch</span></a></li>
          <li><a href="/arcadia"><span class="xpo-i__t">ARCADIA</span></a></li>
        </ul></div>
        <div class="xpo-col"><p class="xpo-col__h">Displays</p><ul>
          <li><a href="/spherix"><span class="xpo-i__t">SPHERIX</span></a></li>
        </ul></div>
      </div><a class="xpo-feat" href="/new"><span class="xpo-feat__t">ELYSIUM</span></a></div>
    </li>
    <li class="xpo-has-sub">
      <button class="xpo-top">Bedrijf</button>
      <ul class="xpo-sub"><li><a href="/over">Over ons</a></li><li><a href="/werk">Werken bij</a></li></ul>
    </li>
    <li><a class="xpo-top" href="/contact">Contact</a></li>
  </ul></nav>
</header>
</body></html>`;

const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
global.window = window; global.document = window.document;
// scrollHeight is 0 in jsdom; geen probleem voor deze gedragstests
window.requestAnimationFrame = (fn) => fn();
window.eval(lib);
window.XpoMenus.initAll(); // expliciet, los van readyState-timing in jsdom

let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log((c ? "  \u2713 " : "  \u2717 ") + l); };

const doc = window.document;
const bar = doc.querySelector(".xpo-bar");
const burger = doc.querySelector(".xpo-burger");

ok("init zet aria op mega-trigger", doc.querySelector(".xpo-has-mega .xpo-top").getAttribute("aria-haspopup") === "true");

// mega openen via klik
const megaTop = doc.querySelector(".xpo-has-mega .xpo-top");
megaTop.dispatchEvent(new window.Event("click", { bubbles: true }));
ok("mega opent (open-class + aria-expanded)", doc.querySelector(".xpo-has-mega").classList.contains("open") && megaTop.getAttribute("aria-expanded") === "true");

// tweede klik sluit
megaTop.dispatchEvent(new window.Event("click", { bubbles: true }));
ok("mega sluit bij nogmaals klikken", !doc.querySelector(".xpo-has-mega").classList.contains("open"));

// offcanvas drawer opgebouwd
const drawer = doc.getElementById("xpo-drawer");
ok("offcanvas-drawer is opgebouwd", !!drawer && !!drawer.querySelector(".xpo-drill__track"));
const rootLevel = drawer.querySelector(".xpo-drill__level");
ok("rootniveau bevat alle 3 topitems", rootLevel.querySelectorAll(".xpo-drill__row").length === 3);
ok("expand-knoppen voor items met kinderen (Solutions, Bedrijf)", rootLevel.querySelectorAll(".xpo-drill__exp").length === 2);

// drawer openen
burger.dispatchEvent(new window.Event("click", { bubbles: true }));
ok("burger opent drawer (open-class, aria-expanded)", drawer.classList.contains("open") && burger.getAttribute("aria-expanded") === "true" && drawer.hidden === false);

// drilldown: Solutions induiken
const solExp = rootLevel.querySelector(".xpo-drill__exp");
solExp.dispatchEvent(new window.Event("click", { bubbles: true }));
let levels = drawer.querySelectorAll(".xpo-drill__level");
ok("drilldown duikt een niveau dieper (2 niveaus, met terug-knop)", levels.length === 2 && !!levels[1].querySelector(".xpo-drill__back"));
ok("dieper niveau toont mega-kolommen als subitems", levels[1].querySelectorAll(".xpo-drill__exp").length >= 2);

// terug
levels[1].querySelector(".xpo-drill__back").dispatchEvent(new window.Event("click", { bubbles: true }));
ok("terug-knop keert terug naar rootniveau", drawer.querySelector(".xpo-drill__track").style.transform.indexOf("0%") !== -1 || drawer.querySelector(".xpo-drill__track").style.transform === "translateX(-0%)");

console.log(`\n=== ${pass} geslaagd, ${fail} gefaald ===`);
process.exit(fail ? 1 : 0);
