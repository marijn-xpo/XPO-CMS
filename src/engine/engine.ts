// XPO CMS engine — validatie + veilige render. Geen externe afhankelijkheden.
import { assetUrl } from "../common/assets.js";
import { responsiveImg } from "../modules/media/img.routes.js";
import { getWidgetRenderer, pluginWidgetTypes } from "../core/plugins.js";
// Dezelfde regels als de admin-UI, zodat client en server identiek valideren/renderen.

export type Block = {
  id: string;
  type: string;
  settings: Record<string, any>;
  children?: Block[];
};

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export function safeUrl(input: unknown): string {
  const raw = String(input ?? "").replace(/[\u0000-\u001F\u007F\s]/g, "");
  if (raw === "") return "#";
  const lower = raw.toLowerCase();
  if (lower.startsWith("//")) return "#";
  if (/^(https?:|mailto:|tel:)/.test(lower)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/.test(lower)) return "#";
  if (/^(\/|#|\?)/.test(raw)) return raw;
  return raw;
}
export function safeImg(input: unknown): string {
  const raw = String(input ?? "").trim();
  if (raw === "") return "";
  if (/^data:image\//i.test(raw)) return raw;
  if (/^(https?:|\/|\.\/)/i.test(raw)) return raw;
  return "";
}

const req = (v: any, n: string) => (v == null || String(v).trim() === "" ? [`${n} is verplicht`] : []);
const max = (v: any, n: number, label: string) =>
  v != null && String(v).length > n ? [`${label} mag max. ${n} tekens zijn`] : [];

type Rule = (s: Record<string, any>) => string[];
export const RULES: Record<string, Rule> = {
  "xpo/hero": (s) => [
    ...req(s.title, "Titel"), ...max(s.title, 120, "Titel"), ...max(s.subtitle, 400, "Subtitel"),
    ...(Array.isArray(s.buttons) && s.buttons.length > 2 ? ["Een hero heeft maximaal 2 knoppen"] : []),
    ...((s.buttons || []) as any[]).flatMap((b) => [...req(b.label, "Knop-label"), ...max(b.url, 2048, "Knop-URL")]),
  ],
  "xpo/heading": (s) => [...req(s.text, "Kop"), ...max(s.text, 160, "Kop")],
  "xpo/text": (s) => [...req(s.body, "Tekst"), ...max(s.body, 5000, "Tekst")],
  "xpo/button": (s) => [...req(s.label, "Label"), ...max(s.url, 2048, "URL")],
  "xpo/features": (s) => ((s.items || []) as any[]).flatMap((i) => [...req(i.t, "Feature-titel"), ...max(i.d, 200, "Feature-tekst")]),
  "xpo/cards": (s) => ((s.items || []) as any[]).flatMap((i) => [...req(i.name, "Productnaam")]),
  "xpo/tabs": (s) => ((s.items || []) as any[]).flatMap((i) => [...req(i.label, "Tab-label")]),
  "xpo/accordion": (s) => ((s.items || []) as any[]).flatMap((i) => [...req(i.q, "Vraag")]),
  "xpo/gallery": () => [],
  "xpo/image": (s) => [...max(s.caption, 160, "Bijschrift")],
  "xpo/spacer": () => [],
  "xpo/specs": () => [],
  "xpo/divider": () => [],
  "xpo/iconbox": (s) => [...req(s.title, "Titel"), ...max(s.body, 300, "Tekst")],
  "xpo/cta": (s) => [...req(s.title, "Titel"), ...req(s.label, "Knop-label"), ...max(s.url, 2048, "Knop-URL")],
  "xpo/stats": (s) => ((s.items || []) as any[]).flatMap((i) => req(i.value, "Waarde")),
  "xpo/logos": () => [],
  "xpo/testimonial": (s) => [...req(s.quote, "Citaat"), ...max(s.quote, 400, "Citaat")],
  "xpo/posts": () => [],
  "xpo/video": () => [],
  "xpo/sync": () => [],
  "xpo/columns": () => [],
  "xpo/container": () => [],
  "xpo/pricing": () => [],
  "xpo/progress": () => [],
  "xpo/social": () => [],
  "xpo/buttons": () => [],
  "xpo/map": (s) => [...req(s.query, "Locatie")],
  "xpo/countdown": (s) => [...req(s.target, "Doeldatum")],
  "xpo/comments": () => [],
  "xpo/post-content": () => [],
  "xpo/shop": () => [],
  "xpo/slider": () => [],
  "xpo/form": () => [],
  "xpo/search": () => [],
  "xpo/html": () => [],
  "xpo/icon-list": () => [],
  "xpo/blockquote": () => [],
  "xpo/flipbox": () => [],
  "xpo/share": () => [],
  "xpo/animated-heading": () => [],
  "xpo/toc": () => [],
  "xpo/menu": () => [],
  "xpo/breadcrumbs": () => [],
  "xpo/post-nav": () => [],
  "xpo/author": () => [],
  "xpo/icon": () => [],
  "xpo/counter": () => [],
  "xpo/rating": () => [],
  "xpo/alert": () => [],
  "xpo/table": () => [],
  "xpo/pricelist": () => [],
  "xpo/audio": () => [],
  "xpo/hotspots": () => [],
  "xpo/lottie": () => [],
  "xpo/login": () => [],
  "xpo/loop": () => [],
  "xpo/theme-toggle": () => [],
};

const LIMITS = { maxDepth: 24, maxNodes: 5000 };
export type ValidationResult = { ok: boolean; issues: { path: string; message: string }[] };

export function validateTree(root: Block): ValidationResult {
  const issues: { path: string; message: string }[] = [];
  let count = 0;
  const walk = (b: Block, path: string, depth: number) => {
    if (depth > LIMITS.maxDepth) { issues.push({ path, message: `Max. nestdiepte (${LIMITS.maxDepth}) overschreden` }); return; }
    if (++count > LIMITS.maxNodes) { issues.push({ path, message: `Max. aantal blocks overschreden` }); return; }
    if (b.type !== "core/root" && !RULES[b.type] && !getWidgetRenderer(b.type)) { issues.push({ path, message: `Onbekend widget-type '${b.type}'` }); return; }
    const rule = RULES[b.type];
    if (rule) for (const m of rule(b.settings || {})) issues.push({ path, message: m });
    (b.children || []).forEach((c, i) => walk(c, `${path}.children[${i}]`, depth + 1));
  };
  walk(root, "root", 0);
  return { ok: issues.length === 0, issues };
}

function renderInner(b: Block): string {
  const s = b.settings || {};
  switch (b.type) {
    case "xpo/hero": {
      const subs = s.subtitle ? `<p class="xpo-hero__sub">${esc(s.subtitle)}</p>` : "";
      const btns = ((s.buttons || []) as any[]).slice(0, 2)
        .map((x, i) => `<a class="pillbtn ${i ? "outline" : ""}" href="${esc(safeUrl(x.url))}">${esc(x.label)}</a>`).join("");
      return `<div class="xpo-hero"><h1>${esc(s.title)}</h1>${subs}${btns ? `<div class="ctas">${btns}</div>` : ""}</div>`;
    }
    case "xpo/heading": { const lvl = ["h2", "h3", "h4"].includes(s.level) ? s.level : "h2"; return `<${lvl} class="xpo-h">${esc(s.text)}</${lvl}>`; }
    case "xpo/text": return `<div class="xpo-text"><p>${esc(s.body)}</p></div>`;
    case "xpo/button": return `<a class="pillbtn ${s.variant === "outline" ? "outline" : ""}" href="${esc(safeUrl(s.url))}">${esc(s.label)}</a>`;
    case "xpo/features": return `<div class="xpo-feat">${((s.items || []) as any[]).map((f) => `<div class="f"><div class="fi">✓</div><h5>${esc(f.t)}</h5><p>${esc(f.d)}</p></div>`).join("")}</div>`;
    case "xpo/cards": return `<div class="xpo-cards">${((s.items || []) as any[]).map((p) => `<div class="pc"><div class="pcimg"></div><div class="pcb"><h5>${esc(p.name)}</h5><div class="pr">${esc(p.price)}</div><span class="tg">${esc(p.tag)}</span></div></div>`).join("")}</div>`;
    case "xpo/tabs": { const it = (s.items || []) as any[]; const a = s.active || 0; return `<div class="xpo-tabs"><div class="tt">${it.map((t, i) => `<span class="${i === a ? "on" : ""}">${esc(t.label)}</span>`).join("")}</div><div class="xpo-text"><p>${esc((it[a] || {}).body)}</p></div></div>`; }
    case "xpo/accordion": return `<div class="xpo-acc">${((s.items || []) as any[]).map((q, i) => `<details ${i === 0 ? "open" : ""}><summary>${esc(q.q)}</summary><div class="aa">${esc(q.a)}</div></details>`).join("")}</div>`;
    case "xpo/gallery": return `<div class="xpo-gal">${Array.from({ length: s.count || 4 }).map(() => `<i></i>`).join("")}</div>`;
    case "xpo/image": { const src = safeImg(s.src); const fig = src ? responsiveImg(src, s.caption || "", "xpo-imgEl") : `<figure class="xpo-img" style="aspect-ratio:${esc(s.ratio || "16/9")}"></figure>`; return fig + (s.caption ? `<figcaption class="cap">${esc(s.caption)}</figcaption>` : ""); }
    case "xpo/spacer": return `<div style="height:${Number(s.height) || 0}px"></div>`;
    case "xpo/sync": return s._resolved ? "" : `<!-- synced: ${esc(s.ref || "")} -->`;
    case "xpo/columns": {
      const cols = numClamp(s.cols, 1, 6, 2), gap = numClamp(s.gap, 0, 80, 24);
      const va = ["start", "center", "stretch", "end"].includes(s.valign) ? s.valign : "stretch";
      return `<div class="xpo-cols" style="grid-template-columns:repeat(${cols},minmax(0,1fr));gap:${gap}px;align-items:${va}">${(b.children || []).map(renderNode).join("")}</div>`;
    }
    case "xpo/container": {
      const gap = numClamp(s.gap, 0, 80, 16);
      return `<div class="xpo-stack" style="gap:${gap}px">${(b.children || []).map(renderNode).join("")}</div>`;
    }
    case "xpo/pricing": {
      return `<div class="xpo-pricing">${((s.plans || []) as any[]).map((p) => `<div class="xpr${p.featured ? " feat" : ""}"><h4>${esc(p.name)}</h4><div class="xpr-price">${esc(p.price)}${p.period ? `<span>${esc(p.period)}</span>` : ""}</div><ul>${String(p.features || "").split("\n").filter(Boolean).map((f) => `<li>${esc(f.trim())}</li>`).join("")}</ul>${p.cta ? `<a class="pillbtn" href="${esc(safeUrl(p.url))}">${esc(p.cta)}</a>` : ""}</div>`).join("")}</div>`;
    }
    case "xpo/progress": {
      return `<div class="xpo-prog">${((s.items || []) as any[]).map((i) => { const pct = numClamp(i.percent, 0, 100, 0); return `<div class="xpb"><div class="xpb-h"><span>${esc(i.label)}</span><span>${pct}%</span></div><div class="xpb-t"><i style="width:${pct}%"></i></div></div>`; }).join("")}</div>`;
    }
    case "xpo/social": {
      return `<div class="xpo-social">${((s.items || []) as any[]).map((i) => `<a class="xsoc" href="${esc(safeUrl(i.url))}" aria-label="${esc(i.network)}" title="${esc(i.network)}">${esc(String(i.network || "?").slice(0, 2))}</a>`).join("")}</div>`;
    }
    case "xpo/buttons": {
      return `<div class="xpo-btns">${((s.items || []) as any[]).map((x) => `<a class="pillbtn ${x.variant === "outline" ? "outline" : ""}" href="${esc(safeUrl(x.url))}">${esc(x.label)}</a>`).join("")}</div>`;
    }
    case "xpo/map": {
      const q = encodeURIComponent(String(s.query || "")).slice(0, 300);
      const ratio = ["16/9", "4/3", "1/1", "21/9"].includes(s.ratio) ? s.ratio : "16/9";
      return `<div class="xpo-map" style="aspect-ratio:${ratio}"><iframe src="https://www.google.com/maps?q=${q}&output=embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe></div>`;
    }
    case "xpo/post-content": return "";
    case "xpo/shop": {
      const items = (s.items || []) as any[];
      const cards = items.map((p) => {
        const img = p.image ? `<div class="xsh-img" style="background-image:url('${safeImg(p.image)}')"></div>` : `<div class="xsh-img xsh-img--ph"></div>`;
        const link = p.slug ? `/product/${esc(String(p.slug))}` : "#";
        return `<div class="xsh-card"><a class="xsh-link" href="${link}">${img}<div class="xsh-name">${esc(p.name)}</div></a><div class="xsh-price">${esc(p.price)}</div>${p.soldOut ? `<span class="xsh-out">Uitverkocht</span>` : `<button class="pillbtn xsh-add" data-product="${esc(String(p.id))}">In winkelwagen</button>`}</div>`;
      }).join("");
      return `<div class="xpo-shop">${cards || `<div class="xpo-shop--empty">Geen producten.</div>`}</div>`;
    }
    case "xpo/slider": {
      const slides = (s.slides || []) as any[];
      const interval = s.autoplay ? numClamp(s.interval, 2, 60, 5) : 0;
      const inner = slides.map((sl) => {
        const bg = sl.image ? `background-image:url('${safeImg(sl.image)}')` : "";
        const body = `<div class="xsl-c"><div>${sl.title ? `<h3>${esc(sl.title)}</h3>` : ""}${sl.text ? `<p>${esc(sl.text)}</p>` : ""}${sl.btn && sl.url ? `<a class="pillbtn" href="${esc(safeUrl(sl.url))}">${esc(sl.btn)}</a>` : ""}</div></div>`;
        return `<div class="xsl-slide" style="${bg}">${body}</div>`;
      }).join("");
      const dots = slides.map((_: any, i: number) => `<button class="xsl-dot" data-i="${i}" aria-label="Slide ${i + 1}"></button>`).join("");
      const nav = slides.length > 1 ? `<button class="xsl-nav xsl-prev" aria-label="Vorige">\u2039</button><button class="xsl-nav xsl-next" aria-label="Volgende">\u203a</button><div class="xsl-dots">${dots}</div>` : "";
      return `<div class="xpo-slider" data-autoplay="${interval}"><div class="xsl-track">${inner}</div>${nav}</div>`;
    }
    case "xpo/form": {
      const fields = (s.fields || []) as any[];
      const fid = s.formId || "";
      if (!fid || !fields.length) return `<div class="xpo-form--empty">Kies een formulier.</div>`;
      const inner = fields.map((f) => {
        const nm = esc(String(f.id || f.key || f.label || ""));
        const req = f.required ? " required" : "";
        if (f.type === "checkbox") return `<div class="xfm-f"><label class="xfm-cb"><input type="checkbox" name="${nm}" value="ja"/> ${esc(f.label || "")}</label></div>`;
        const lbl = `<label class="xfm-l">${esc(f.label || f.id || "")}${f.required ? " *" : ""}</label>`;
        let ctl: string;
        if (f.type === "textarea") ctl = `<textarea name="${nm}" class="xfm-i" rows="4"${req}></textarea>`;
        else if (f.type === "select") ctl = `<select name="${nm}" class="xfm-i"${req}>${(f.options || []).map((o: string) => `<option>${esc(o)}</option>`).join("")}</select>`;
        else { const t = ["email", "tel", "number", "date", "url"].includes(f.type) ? f.type : "text"; ctl = `<input type="${t}" name="${nm}" class="xfm-i"${req}/>`; }
        return `<div class="xfm-f">${lbl}${ctl}</div>`;
      }).join("");
      return `<form class="xpo-form" data-form="${esc(String(fid))}">${inner}<button type="submit" class="pillbtn xfm-submit">${esc(s.submitLabel || "Versturen")}</button><p class="xfm-msg" hidden></p></form>`;
    }
    case "xpo/html": return String(s.html || "");
    case "xpo/icon": {
      const sz = numClamp(s.size, 12, 200, 40); const col = safeColor(s.color) || "var(--accent)";
      const inner = `<span class="xpo-icon" style="font-size:${sz}px;color:${col}">${esc(s.icon || "\u2605")}</span>`;
      return s.url ? `<a href="${esc(safeUrl(s.url))}" class="xpo-icon-link">${inner}</a>` : inner;
    }
    case "xpo/counter": {
      const to = Number(s.value) || 0;
      return `<div class="xpo-counter"><div class="xct-num" data-to="${esc(String(to))}" data-prefix="${esc(s.prefix || "")}" data-suffix="${esc(s.suffix || "")}" data-dur="${numClamp(s.duration, 0, 10000, 1600)}">${esc(s.prefix || "")}0${esc(s.suffix || "")}</div>${s.label ? `<div class="xct-label">${esc(s.label)}</div>` : ""}</div>`;
    }
    case "xpo/rating": {
      const max = numClamp(s.max, 1, 10, 5); const val = Math.max(0, Math.min(max, Number(s.value) || 0));
      let stars = "";
      for (let i = 1; i <= max; i++) stars += `<span class="xrt-s ${i <= Math.round(val) ? "on" : ""}">\u2605</span>`;
      return `<div class="xpo-rating" aria-label="${esc(String(val))} van ${esc(String(max))}">${stars}${s.label ? `<span class="xrt-l">${esc(s.label)}</span>` : `<span class="xrt-l">${esc(String(val))}/${esc(String(max))}</span>`}</div>`;
    }
    case "xpo/alert": {
      const type = ["info", "success", "warning", "error"].includes(s.type) ? s.type : "info";
      const dis = s.dismissible ? `<button class="xal-x" aria-label="Sluiten">\u00d7</button>` : "";
      return `<div class="xpo-alert xal-${type}" role="alert">${dis}${s.title ? `<div class="xal-t">${esc(s.title)}</div>` : ""}${s.body ? `<div class="xal-b">${esc(s.body)}</div>` : ""}</div>`;
    }
    case "xpo/table": {
      const headers = (Array.isArray(s.headers) ? s.headers : String(s.headers || "").split(",").map((x: string) => x.trim()).filter(Boolean)) as any[];
      const rows = (s.rows || []) as any[][];
      const thead = headers.length ? `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>` : "";
      const tbody = `<tbody>${rows.map((r) => `<tr>${(r || []).map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
      return `<div class="xpo-table-wrap"><table class="xpo-table">${thead}${tbody}</table></div>`;
    }
    case "xpo/pricelist": {
      const items = (s.items || []) as any[];
      return `<ul class="xpo-pricelist">${items.map((it) => `<li class="xpl-i"><div class="xpl-l"><span class="xpl-n">${esc(it.name)}</span>${it.description ? `<span class="xpl-d">${esc(it.description)}</span>` : ""}</div><span class="xpl-dots"></span><span class="xpl-p">${esc(it.price)}</span></li>`).join("")}</ul>`;
    }
    case "xpo/audio": {
      const src = String(s.src || "");
      if (/soundcloud\.com/.test(src)) return `<div class="xpo-audio"><iframe width="100%" height="120" scrolling="no" frameborder="no" allow="autoplay" src="https://w.soundcloud.com/player/?url=${encodeURIComponent(src)}&color=%235F8D7A&inverse=false&auto_play=false"></iframe></div>`;
      const safe = safeMedia(src);
      return safe ? `<div class="xpo-audio"><audio controls preload="none" src="${safe}"></audio></div>` : `<div class="xpo-audio xpo-audio--empty">Geen audiobron.</div>`;
    }
    case "xpo/hotspots": {
      const img = safeImg(s.image); const pts = (s.points || []) as any[];
      if (!img) return `<div class="xpo-hotspots xpo-hotspots--empty">Kies een afbeelding.</div>`;
      const dots = pts.map((p, i) => `<button class="xhs-dot" style="left:${numClamp(p.x, 0, 100, 50)}%;top:${numClamp(p.y, 0, 100, 50)}%" aria-label="${esc(p.label || ("Punt " + (i + 1)))}"><span class="xhs-pulse"></span><span class="xhs-tip">${p.label ? `<b>${esc(p.label)}</b>` : ""}${p.text ? `<span>${esc(p.text)}</span>` : ""}</span></button>`).join("");
      return `<div class="xpo-hotspots"><img src="${img}" alt="${esc(s.alt || "")}" loading="lazy"/>${dots}</div>`;
    }
    case "xpo/lottie": {
      const u = safeUrl(s.src || "");
      if (!u) return `<div class="xpo-lottie xpo-lottie--empty">Lottie JSON-URL ontbreekt.</div>`;
      return `<div class="xpo-lottie" data-lottie="${esc(u)}" data-loop="${s.loop === false ? "0" : "1"}" data-autoplay="${s.autoplay === false ? "0" : "1"}" style="max-width:${numClamp(s.maxw, 0, 1200, 480)}px;margin:0 auto"></div>`;
    }
    case "xpo/theme-toggle": {
      return `<button class="xpo-theme-toggle xtt-inline" data-theme-toggle aria-label="Licht/donker wisselen"><span class="xtt-l">\u2600 ${esc(s.labelLight || "Licht")}</span><span class="xtt-d">\u263e ${esc(s.labelDark || "Donker")}</span></button>`;
    }
    case "xpo/login": {
      return `<div class="xpo-login" data-login><form class="xlg-form"><h3 class="xpo-h">${esc(s.title || "Inloggen")}</h3><input class="xfm-i" type="email" name="email" placeholder="E-mail" required/><input class="xfm-i" type="password" name="password" placeholder="Wachtwoord" required/><button class="pillbtn" type="submit">Inloggen</button><p class="xlg-msg" hidden></p></form></div>`;
    }
    case "xpo/loop": {
      const items = (s._items || []) as any[];
      const cols = numClamp(s.columns, 1, 6, 3);
      const cards = items.map((it) => it.__html).join("");
      return `<div class="xpo-loop" style="grid-template-columns:repeat(${cols},1fr)">${cards || `<div class="xpo-loop--empty">Geen items.</div>`}</div>`;
    }
    case "xpo/icon-list": {
      const items = (s.items || []) as any[];
      const ic = esc(s.icon || "\u2713");
      return `<ul class="xpo-iconlist">${items.map((it) => `<li><span class="xil-i">${ic}</span><span>${esc(it.text || it)}</span></li>`).join("")}</ul>`;
    }
    case "xpo/blockquote": return `<blockquote class="xpo-quote"><p>${esc(s.text)}</p>${s.author ? `<cite>\u2014 ${esc(s.author)}</cite>` : ""}</blockquote>`;
    case "xpo/flipbox": return `<div class="xpo-flip"><div class="xfl-inner"><div class="xfl-front" ${s.frontImage ? `style="background-image:url('${safeImg(s.frontImage)}')"` : ""}><div class="xfl-c"><h4>${esc(s.frontTitle)}</h4>${s.frontText ? `<p>${esc(s.frontText)}</p>` : ""}</div></div><div class="xfl-back"><div class="xfl-c"><h4>${esc(s.backTitle)}</h4>${s.backText ? `<p>${esc(s.backText)}</p>` : ""}${s.url && s.btn ? `<a class="pillbtn" href="${esc(safeUrl(s.url))}">${esc(s.btn)}</a>` : ""}</div></div></div></div>`;
    case "xpo/share": {
      const nets = (s.networks && s.networks.length ? s.networks : ["twitter", "linkedin", "facebook", "whatsapp", "mail"]) as string[];
      const lbl: Record<string, string> = { twitter: "X", linkedin: "LinkedIn", facebook: "Facebook", whatsapp: "WhatsApp", mail: "E-mail" };
      return `<div class="xpo-share" data-share>${nets.map((n) => `<a class="xsh-btn" data-net="${esc(n)}" href="#" rel="nofollow">${esc(lbl[n] || n)}</a>`).join("")}</div>`;
    }
    case "xpo/animated-heading": {
      const words = ((s.words || []) as any[]).map((w) => (typeof w === "string" ? w : (w && w.w) || "")).filter(Boolean);
      const lvl = ["h1", "h2", "h3"].includes(s.level) ? s.level : "h2";
      return `<${lvl} class="xpo-h xpo-animhead">${esc(s.prefix || "")} <span class="xah-rot" data-words="${esc(JSON.stringify(words))}">${esc(words[0] || "")}</span></${lvl}>`;
    }
    case "xpo/toc": return `<nav class="xpo-toc" data-toc><div class="xtoc-t">${esc(s.title || "Inhoud")}</div><ul class="xtoc-list"></ul></nav>`;
    case "xpo/menu": {
      const items = (s.items || []) as any[];
      return `<nav class="xpo-menu">${items.map((m) => `<a href="${esc(safeUrl(m.to || m.url || "#"))}">${esc(m.label)}</a>`).join("")}</nav>`;
    }
    case "xpo/breadcrumbs": {
      const items = (s.items || [{ label: "Home", url: "/site" }]) as any[];
      return `<nav class="xpo-crumbs" aria-label="Kruimelpad">${items.map((c, i) => i < items.length - 1 ? `<a href="${esc(safeUrl(c.url || "#"))}">${esc(c.label)}</a><span class="xbc-sep">/</span>` : `<span class="xbc-cur">${esc(c.label)}</span>`).join("")}</nav>`;
    }
    case "xpo/post-nav": {
      const prev = s.prev as any; const next = s.next as any;
      if (!prev && !next) return "";
      return `<nav class="xpo-postnav">${prev ? `<a class="xpn-prev" href="${esc(safeUrl(prev.url))}"><span>\u2039 Vorige</span><b>${esc(prev.title)}</b></a>` : `<span></span>`}${next ? `<a class="xpn-next" href="${esc(safeUrl(next.url))}"><span>Volgende \u203a</span><b>${esc(next.title)}</b></a>` : ""}</nav>`;
    }
    case "xpo/author": {
      if (!s.name) return "";
      return `<div class="xpo-author"><div class="xau-av">${esc(String(s.name).slice(0, 1).toUpperCase())}</div><div><div class="xau-n">${esc(s.name)}</div>${s.bio ? `<div class="xau-b">${esc(s.bio)}</div>` : ""}</div></div>`;
    }
    case "xpo/search": return `<form class="xpo-search" action="/zoeken" method="get"><input type="search" name="q" class="xfm-i" placeholder="${esc(s.placeholder || "Zoeken\u2026")}" value="${esc(s.value || "")}"/><button class="pillbtn" type="submit">${esc(s.label || "Zoek")}</button></form>`;
    case "xpo/comments": {
      const items = (s.items || []) as any[];
      const pid = esc(String(s.postId || ""));
      const byParent: Record<string, any[]> = {};
      for (const c of items) { const k = String(c.parentId || ""); (byParent[k] = byParent[k] || []).push(c); }
      const renderList = (parentId: string, depth: number): string => {
        const kids = byParent[parentId] || [];
        if (!kids.length) return "";
        return `<ul class="xcm-list${depth ? " xcm-sub" : ""}">${kids.map((c) => `<li class="xcm-i"><b>${esc(c.author || "Anoniem")}</b><p>${esc(c.body)}</p><button type="button" class="xcm-reply" data-parent="${esc(String(c.id || ""))}" data-name="${esc(c.author || "")}">Reageer</button>${renderList(String(c.id || ""), depth + 1)}</li>`).join("")}</ul>`;
      };
      const list = items.length ? renderList("", 0) : `<ul class="xcm-list"><li class="xcm-empty">Wees de eerste die reageert.</li></ul>`;
      return `<div class="xpo-comments"><h3 class="xcm-title">Reacties (${items.length})</h3>${list}<form class="xcm-form" data-post="${pid}"><input type="hidden" name="parentId" class="xcm-parent" value=""/><p class="xcm-replyto" hidden>Antwoord op <b class="xcm-replyname"></b> · <button type="button" class="xcm-cancel">annuleren</button></p><div class="xcm-row"><input name="author" placeholder="Naam" class="xcm-in"/><input name="email" type="email" placeholder="E-mail (optioneel)" class="xcm-in"/></div><textarea name="body" placeholder="Schrijf een reactie\u2026" class="xcm-in" required></textarea><button type="submit" class="pillbtn">Plaats reactie</button><p class="xcm-msg" hidden></p></form></div>`;
    }
    case "xpo/countdown": {
      return `<div class="xpo-count" data-countdown="${esc(String(s.target || ""))}"><div class="xc"><div><b data-u="d">--</b><span>dagen</span></div><div><b data-u="h">--</b><span>uur</span></div><div><b data-u="m">--</b><span>min</span></div><div><b data-u="s">--</b><span>sec</span></div></div>${s.label ? `<div class="xc-l">${esc(s.label)}</div>` : ""}</div>`;
    }
    case "xpo/video": {
      const url = String(s.url || "");
      const yt = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([\w-]{11})/);
      const vim = url.match(/vimeo\.com\/(\d+)/);
      const ratio = ["16/9", "4/3", "1/1"].includes(s.ratio) ? s.ratio : "16/9";
      let inner = "";
      if (yt) inner = `<iframe src="https://www.youtube.com/embed/${esc(yt[1])}" allowfullscreen loading="lazy"></iframe>`;
      else if (vim) inner = `<iframe src="https://player.vimeo.com/video/${esc(vim[1])}" allowfullscreen loading="lazy"></iframe>`;
      else { const m = safeMedia(url); if (m) inner = `<video controls src="${esc(m)}"></video>`; }
      return inner ? `<div class="xpo-video" style="aspect-ratio:${ratio}">${inner}</div>` : `<div class="xpo-video xpo-video--empty">Plak een YouTube-, Vimeo- of mp4-URL</div>`;
    }
    case "xpo/divider": return `<hr class="xpo-divider"/>`;
    case "xpo/iconbox": return `<div class="xpo-iconbox"><div class="ib-i">${esc(s.icon || "\u2605")}</div><h4>${esc(s.title)}</h4><p>${esc(s.body)}</p></div>`;
    case "xpo/cta": return `<div class="xpo-cta"><div><h3>${esc(s.title)}</h3>${s.text ? `<p>${esc(s.text)}</p>` : ""}</div><a class="pillbtn" href="${esc(safeUrl(s.url))}">${esc(s.label)}</a></div>`;
    case "xpo/stats": return `<div class="xpo-stats">${((s.items || []) as any[]).map((i) => `<div class="st"><div class="stv">${esc(i.value)}</div><div class="stl">${esc(i.label)}</div></div>`).join("")}</div>`;
    case "xpo/logos": return `<div class="xpo-logos">${((s.items || []) as any[]).map((i) => `<div class="lg">${esc(i.name)}</div>`).join("")}</div>`;
    case "xpo/testimonial": return `<figure class="xpo-quote"><blockquote>${esc(s.quote)}</blockquote><figcaption>${esc(s.author)}${s.role ? ` \u00b7 <span>${esc(s.role)}</span>` : ""}</figcaption></figure>`;
    case "xpo/posts": {
      const items = (s.items || []) as any[];
      const heading = s.title ? `<h3 class="xpo-h" style="margin-bottom:18px">${esc(s.title)}</h3>` : "";
      if (!items.length) return `${heading}<div class="xpo-posts xpo-posts--empty">Nog geen posts.</div>`;
      const cards = items.map((p) => `<a class="xpost" href="${esc(safeUrl(p.url))}">${p.category ? `<span class="xpost__c">${esc(p.category)}</span>` : ""}<h4>${esc(p.title)}</h4>${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ""}<span class="xpost__d">${esc(p.date)}</span></a>`).join("");
      return `${heading}<div class="xpo-posts">${cards}</div>`;
    }
    case "xpo/specs": {
      const items = (s.items || []) as any[];
      if (!items.length) return "";
      const rows = items.map((it) => `<div class="xpo-spec"><dt>${esc(it.label)}</dt><dd>${esc(it.value)}</dd></div>`).join("");
      const title = s.title ? `<h3 class="xpo-h">${esc(s.title)}</h3>` : "";
      return `${title}<dl class="xpo-specs">${rows}</dl>`;
    }
    default: {
      const ext = getWidgetRenderer(b.type);
      return ext ? ext(s) : "";
    }
  }
}

function cssId(id: unknown): string { return String(id).replace(/[^a-zA-Z0-9_-]/g, ""); }

export function safeColor(v: unknown): string {
  const s = String(v ?? "").trim();
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return s;
  if (/^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)$/.test(s)) return s;
  if (/^[a-z]{3,20}$/i.test(s)) return s;
  return "";
}
function safeMedia(v: unknown): string {
  const raw = String(v ?? "").trim();
  if (/^data:(image|video)\//i.test(raw)) return raw;
  if (/^(https?:|\/|\.\/)/i.test(raw)) return raw;
  return "";
}
export function cssFont(f: unknown): string {
  const s = String(f ?? "").replace(/[^a-zA-Z0-9 ,'\-]/g, "").slice(0, 120).trim();
  return s || "inherit";
}
const numClamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function bgDecl(st: any): string {
  switch (st.bg) {
    case "color": { const c = safeColor(st.bgColor); return c ? `background:${c}` : ""; }
    case "gradient": { const a = safeColor(st.gradFrom) || "#11161b"; const b = safeColor(st.gradTo) || "#1b232b"; return `background:linear-gradient(${numClamp(st.gradAngle, 0, 360, 135)}deg,${a},${b})`; }
    case "image": { const u = safeMedia(st.bgImage); return u ? `background:url("${u}") ${/^(center|top|bottom|left|right)/.test(String(st.bgPos)) ? st.bgPos : "center"}/${st.bgSize === "contain" ? "contain" : "cover"} no-repeat` : ""; }
    case "aurora": { const a = safeColor(st.auroraA) || "#5F8D7A"; const b = safeColor(st.auroraB) || "#1b232b"; const c = safeColor(st.auroraC) || "#06100e"; return `background:linear-gradient(130deg,${a},${b},${c},${a});background-size:300% 300%;animation:xpo-aurora 22s ease infinite`; }
    default: return "";
  }
}
function filterDecl(st: any): string {
  const b = numClamp(st.fBright, 0, 200, 100), c = numClamp(st.fContrast, 0, 200, 100), bl = numClamp(st.fBlur, 0, 40, 0);
  if (b === 100 && c === 100 && bl === 0) return "";
  return `filter:brightness(${b}%) contrast(${c}%) blur(${bl}px)`;
}
// 4-zijdige binnenruimte: object {t,r,b,l} of een enkel getal (legacy) -> padding-declaratie
function padCss(v: any): string {
  if (v == null || v === "") return "";
  if (typeof v === "object") { const c = (x: any) => numClamp(x, 0, 200, 0); return `padding:${c(v.t)}px ${c(v.r)}px ${c(v.b)}px ${c(v.l)}px`; }
  return `padding:${numClamp(v, 0, 200, 0)}px`;
}

// volledige per-blok stijl-CSS (achtergrond, aurora, overlay, filters, radius/schaduw, typografie, marges) — met breakpoints
function nodeStyle(b: Block): { base: string[]; tablet: string[]; mobile: string[] } {
  const st: any = b.settings?._style || {};
  const cls = ".n-" + cssId(b.id);
  const base: string[] = [], tablet: string[] = [], mobile: string[] = [];
  const bg = bgDecl(st);
  const flt = filterDecl(st);
  const overlay = safeColor(st.overlayColor);
  const overlayOp = numClamp(st.overlayOpacity, 0, 100, 0);
  const layerBg = st.bg === "image" || st.bg === "aurora" || st.bg === "video";
  const needsLayer = layerBg || (!!overlay && overlayOp > 0) || !!st.particles;

  const el: string[] = [];
  if (st.color) { const tc = safeColor(st.color); if (tc) el.push(`color:${tc}`); }
  if (st.radius != null && st.radius !== "") el.push(`border-radius:${numClamp(st.radius, 0, 80, 0)}px`);
  if (st.shadow) el.push(`box-shadow:0 24px 70px -24px rgba(0,0,0,.6)`);
  { const bw = numClamp(st.borderW, 0, 20, 0); if (bw > 0) { const bc = safeColor(st.borderColor) || "rgba(255,255,255,.14)"; const bsv = ["solid", "dashed", "dotted"].includes(st.borderStyle) ? st.borderStyle : "solid"; el.push(`border:${bw}px ${bsv} ${bc}`); } }
  if (st.margin != null && st.margin !== "") el.push(`margin:${numClamp(st.margin, 0, 200, 0)}px auto`);
  if (!needsLayer && bg) el.push(bg);
  if (!needsLayer && flt) el.push(flt);
  if (needsLayer) el.push("position:relative", "overflow:hidden");
  if (el.length) base.push(`${cls}{${el.join(";")}}`);

  if (needsLayer) {
    if ((st.bg === "image" || st.bg === "aurora") && bg) base.push(`${cls}::before{content:"";position:absolute;inset:0;z-index:0;${bg}${flt ? ";" + flt : ""}}`);
    if (st.bg === "video") base.push(`${cls}>.xpo-bgvid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0${flt ? ";" + flt : ""}}`);
    if (overlay && overlayOp > 0) base.push(`${cls}::after{content:"";position:absolute;inset:0;z-index:1;background:${overlay};opacity:${overlayOp / 100}}`);
    base.push(`${cls}>.winner{position:relative;z-index:2}`);
    if (st.particles) base.push(`${cls}>canvas.xpo-particles{position:absolute;inset:0;z-index:1;pointer-events:none}`);
  }

  const typ: string[] = [];
  const col = safeColor(st.textColor); if (col) typ.push(`color:${col} !important`);
  if (st.fontFamily) typ.push(`font-family:${cssFont(st.fontFamily)} !important`);
  if (st.fontWeight) typ.push(`font-weight:${numClamp(st.fontWeight, 100, 900, 400)} !important`);
  if (Number(st.fontSize) > 0) typ.push(`font-size:${numClamp(st.fontSize, 8, 120, 16)}px`);
  if (st.letterSpacing != null && st.letterSpacing !== "") typ.push(`letter-spacing:${numClamp(st.letterSpacing, -5, 20, 0)}px`);
  if (Number(st.lineHeight) > 0) typ.push(`line-height:${numClamp(st.lineHeight, 0.8, 3, 1.6)}`);
  if (st.textTransform && ["uppercase", "lowercase", "capitalize"].includes(st.textTransform)) typ.push(`text-transform:${st.textTransform}`);
  if (typ.length) base.push(`${cls} .winner,${cls} .winner h1,${cls} .winner h2,${cls} .winner h3,${cls} .winner h4,${cls} .winner p{${typ.join(";")}}`);

  { const p = padCss(st.padT); if (p) tablet.push(`${cls}{${p}}`); }
  if (st.marginT != null && st.marginT !== "") tablet.push(`${cls}{margin:${numClamp(st.marginT, 0, 200, 0)}px auto}`);
  { const p = padCss(st.padM); if (p) mobile.push(`${cls}{${p}}`); }
  if (st.marginM != null && st.marginM !== "") mobile.push(`${cls}{margin:${numClamp(st.marginM, 0, 200, 0)}px auto}`);

  return { base, tablet, mobile };
}

export function collectStyleCss(root: Block): string {
  const base: string[] = [], tablet: string[] = [], mobile: string[] = [];
  const walk = (b: Block) => {
    if (b.type !== "core/root" && RULES[b.type]) { const r = nodeStyle(b); base.push(...r.base); tablet.push(...r.tablet); mobile.push(...r.mobile); }
    (b.children || []).forEach(walk);
  };
  walk(root);
  let css = base.join("");
  if (tablet.length) css += `@media (max-width:1024px){${tablet.join("")}}`;
  if (mobile.length) css += `@media (max-width:640px){${mobile.join("")}}`;
  return css;
}

// Verwijdert nodes die alleen de server zelf veilig mag injecteren (bv. rauwe HTML) uit door-gebruikers-opgeslagen trees -> voorkomt opgeslagen XSS.
const SERVER_ONLY = new Set(["xpo/html"]);
export function sanitizeUserTree<T extends { type: string; children?: any[] }>(root: T): T {
  const walk = (b: any): any => ({ ...b, children: (b.children || []).filter((c: any) => !SERVER_ONLY.has(c.type)).map(walk) });
  return walk(root);
}

export function widgetTypes(): string[] { return Object.keys(RULES).concat(pluginWidgetTypes()).filter((v,i,a)=>a.indexOf(v)===i); }

export function renderNode(b: Block): string {
  if (b.type === "core/root") return `<main class="xpo-page">${(b.children || []).map(renderNode).join("")}</main>`;
  if (!RULES[b.type] && !getWidgetRenderer(b.type)) return `<!-- onbekend: ${esc(b.type)} -->`;
  const st = b.settings._style || {};
  const adv = b.settings._adv || {};
  // conditionele zichtbaarheid: datumvenster (server-side geëvalueerd)
  const parse = (v: any): number | null => (v == null || v === "" ? null : typeof v === "number" ? v : Date.parse(v) || null);
  const now = Date.now();
  const from = parse(adv.showFrom), until = parse(adv.showUntil);
  if ((from && now < from) || (until && now > until)) return "";
  const hideCls = (adv.hideOn || []).map((x: string) => "hide-" + x).join(" ");
  const inner = renderInner(b);
  const padBase = padCss(st.pad);
  const style = `${padBase ? padBase + ";" : ""}text-align:${st.align || "left"};`;
  const innerWrap = `<div class="winner" style="max-width:${st.maxw ? st.maxw + "px" : "none"};margin:${st.align === "center" ? "0 auto" : "0"}">${inner}</div>`;
  const vid = st.bg === "video" && safeMedia(st.bgVideo) ? `<video class="xpo-bgvid" autoplay muted loop playsinline src="${esc(safeMedia(st.bgVideo))}"></video>` : "";
  const parts = st.particles ? ` data-particles="1" data-pcolor="${esc(safeColor(st.particleColor) || "#5F8D7A")}"` : "";
  const revealOn = adv.reveal && adv.reveal !== "none";
  const revealCls = revealOn ? ` reveal reveal-${esc(adv.reveal)}` : "";
  const revealAttr = revealOn ? ` data-reveal="${esc(adv.reveal)}"` : "";
  return `<section class="wbg n-${cssId(b.id)} bg-${esc(st.bg || "none")} ${hideCls}${revealCls}"${parts}${revealAttr} style="${style}">${vid}${innerWrap}</section>`;
}

type NavItem = { label: string; to: string; children?: NavItem[]; mega?: any[]; featured?: any };
type Nav = { main?: NavItem[]; footer?: NavItem[] };

function navHref(to: unknown): string {
  const t = String(to ?? "");
  if (!t) return "#";
  if (t[0] === "/" || t[0] === "#") return safeUrl(t);
  return safeUrl("/site/" + t);
}
const CHEV_DOWN = '<svg class="xpo-top__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

function renderTopItem(item: NavItem): string {
  const hasMega = Array.isArray(item.mega) && item.mega.length > 0;
  const hasChildren = Array.isArray(item.children) && item.children.length > 0;
  if (hasMega) {
    const cols = item.mega!.map((col: any) =>
      `<div class="xpo-col"><p class="xpo-col__h">${esc(col.heading)}</p><ul>${(col.items || []).map((it: any) =>
        `<li><a href="${esc(navHref(it.to))}"><span class="xpo-i__t">${esc(it.label)}</span>${it.desc ? `<span class="xpo-i__d">${esc(it.desc)}</span>` : ""}</a></li>`).join("")}</ul></div>`).join("");
    const f = item.featured;
    const feat = f ? `<a class="xpo-feat" href="${esc(navHref(f.to))}">${f.kicker ? `<span class="xpo-feat__k">${esc(f.kicker)}</span>` : ""}<span class="xpo-feat__t">${esc(f.title)}</span>${f.desc ? `<span class="xpo-feat__d">${esc(f.desc)}</span>` : ""}</a>` : "";
    return `<li class="xpo-has-mega"><button class="xpo-top">${esc(item.label)} ${CHEV_DOWN}</button><div class="xpo-mega"><div class="xpo-mega__cols">${cols}</div>${feat}</div></li>`;
  }
  if (hasChildren) {
    const subs = item.children!.map((c) => `<li><a href="${esc(navHref(c.to))}">${esc(c.label)}</a></li>`).join("");
    return `<li class="xpo-has-sub"><button class="xpo-top">${esc(item.label)} ${CHEV_DOWN}</button><ul class="xpo-sub">${subs}</ul></li>`;
  }
  return `<li><a class="xpo-top" href="${esc(navHref(item.to))}">${esc(item.label)}</a></li>`;
}

function renderHeader(nav: Nav | undefined, tenant: string): string {
  const brand = tenant === "altermedia" ? "Altermedia" : "XPO Screens";
  const mark = tenant === "altermedia" ? "A" : "X";
  const items = (nav?.main || []).map(renderTopItem).join("");
  return `<header class="xpo-bar" data-xpo-nav data-tenant="${esc(tenant)}"><a class="xpo-brand" href="/site"><span class="xpo-brand__mark">${mark}</span> ${esc(brand)}</a><button class="xpo-theme-toggle" data-theme-toggle aria-label="Licht/donker wisselen" title="Licht/donker"><span class="xtt-l">\u2600</span><span class="xtt-d">\u263e</span></button><button class="xpo-burger" aria-label="Menu openen"><span></span></button><nav class="xpo-nav" aria-label="Hoofdmenu"><ul class="xpo-menu">${items}</ul></nav></header>`;
}

function renderFooter(nav: Nav | undefined, tenant: string): string {
  const brand = tenant === "altermedia" ? "Altermedia" : "XPO Screens";
  const links = (nav?.footer || []).map((i) => `<a href="${esc(navHref(i.to))}">${esc(i.label)}</a>`).join("");
  return `<footer class="xpo-foot"><div class="xpo-foot__in"><span>\u00a9 ${new Date().getFullYear()} ${esc(brand)}</span><nav class="xpo-foot__nav">${links}</nav></div></footer>`;
}

export function renderDocument(title: string, root: Block, tenant: string, nav?: Nav, accentOverride?: string, opts?: { extraHead?: string; extraBody?: string; defaultTheme?: string; nonce?: string }): string {
  const accent = accentOverride || (tenant === "altermedia" ? "#E72B2B" : "#5F8D7A");
  const defTheme = opts?.defaultTheme === "light" ? "light" : "dark";
  const nonce = opts?.nonce || "";
  const na = nonce ? ` nonce="${nonce}"` : "";
  return `<!DOCTYPE html><html lang="nl" data-default-theme="${defTheme}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(title)}</title>
<script${na}>(function(){try{var t=localStorage.getItem("xpo-theme")||document.documentElement.getAttribute("data-default-theme")||"dark";document.documentElement.setAttribute("data-theme",t);}catch(e){document.documentElement.setAttribute("data-theme","${defTheme}");}})();</script>
<link rel="icon" href="data:,"/>
<link rel="stylesheet" href="${assetUrl('/xpo-fonts.css')}"/>
<link rel="stylesheet" href="${assetUrl('/xpo-menus.css')}"/>
<style>
:root{--accent:${accent};--bg:#0B0E11;--fg:var(--fg);--surface:var(--surface);--surface-2:var(--surface-2);--line:rgba(255,255,255,.1);--card:#11161b;--btn-bg:#fff;--btn-fg:#0b0e11}
html[data-theme=light]{--bg:#f4f6f8;--fg:#0b0e11;--surface:rgba(10,14,18,.035);--surface-2:rgba(10,14,18,.06);--line:rgba(10,14,18,.12);--card:#ffffff;--btn-bg:#0b0e11;--btn-fg:#ffffff}
html{color-scheme:dark}html[data-theme=light]{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:Inter,system-ui,sans-serif;line-height:1.6;transition:background .25s,color .25s}
.xpo-theme-toggle{background:var(--surface-2);border:1px solid var(--line);color:var(--fg);width:38px;height:38px;border-radius:999px;cursor:pointer;display:inline-grid;place-items:center;font-size:16px;line-height:1;flex:none}
.xpo-theme-toggle.xtt-inline{width:auto;padding:8px 16px;gap:8px;display:inline-flex;align-items:center}
html:not([data-theme=light]) .xtt-d{display:none}html[data-theme=light] .xtt-l{display:none}
html[data-theme=light] .xpo-bar{background:rgba(255,255,255,.82);color:#0b0e11;border-bottom-color:rgba(10,14,18,.1)}
html[data-theme=light] .xpo-bar a,html[data-theme=light] .xpo-menu a{color:#0b0e11}
html[data-theme=light] .xpo-foot{background:var(--surface);color:var(--fg)}
.xpo-page{max-width:1100px;margin:0 auto}
@keyframes xpo-aurora{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
.wbg.bg-dark{background:radial-gradient(120% 120% at 82% 0,rgba(255,255,255,.05),transparent 55%),#0a0d10}
.wbg.bg-accent{background:linear-gradient(120deg,#06100e 25%,var(--accent) 240%)}
.wbg.bg-light{background:#f3f5f7;color:#0b0e11}
.xpo-popup{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(4,6,8,.7);backdrop-filter:blur(4px);padding:20px}
.xpo-popup[hidden]{display:none}
.xpo-popup__box{position:relative;max-width:460px;width:100%;background:var(--card);border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:34px;text-align:center;box-shadow:0 40px 120px -30px rgba(0,0,0,.8)}
.xpo-popup__x{position:absolute;top:12px;right:14px;background:none;border:0;color:rgba(234,238,242,.6);font-size:24px;cursor:pointer;line-height:1}
.xpo-popup__img{width:100%;border-radius:12px;margin-bottom:16px}
.xpo-popup__box h3{font-family:'Saira Semi Condensed';font-size:24px;margin:0 0 8px}
.xpo-popup__box p{opacity:.8;margin:0 0 18px}
.xpo-hero h1{font-size:52px;font-weight:800;letter-spacing:1px;margin:0}
.xpo-hero__sub{max-width:460px;opacity:.84;font-size:17px;margin:16px 0 26px}
.xpo-hero .ctas{display:flex;gap:12px;flex-wrap:wrap}
.pillbtn{padding:12px 22px;border-radius:999px;font-weight:600;text-decoration:none;display:inline-block;background:var(--btn-bg);color:var(--btn-fg)}
.pillbtn.outline{background:transparent;border:1px solid currentColor;color:inherit}
.xpo-h{font-family:'Saira Semi Condensed',sans-serif;font-size:30px;margin:0}
.xpo-text{font-size:16px;opacity:.9}.xpo-text p{margin:0}
.xpo-feat{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.xpo-feat .fi{width:36px;height:36px;border-radius:10px;background:rgba(95,141,122,.18);color:var(--accent);display:grid;place-items:center;margin-bottom:10px;font-weight:700}
.xpo-feat h5{margin:0 0 4px;font-family:'Saira Semi Condensed'}.xpo-feat p{margin:0;opacity:.7;font-size:13px}
.xpo-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.xpo-cards .pc{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.xpo-cards .pcimg{height:96px;background:linear-gradient(160deg,#11161b,#1b232b)}
.xpo-cards .pcb{padding:12px 14px}.xpo-cards h5{margin:0}.xpo-cards .pr{font-family:'Saira Semi Condensed';font-weight:600}
.xpo-cards .tg{font-size:11px;opacity:.6}
.xpo-tabs .tt{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.xpo-tabs .tt span{padding:7px 14px;border-radius:99px;background:var(--surface-2);opacity:.7}
.xpo-tabs .tt span.on{background:var(--accent);color:#06100e;opacity:1}
.xpo-acc details{border:1px solid var(--line);border-radius:10px;margin-bottom:8px;padding:6px 14px}
.xpo-acc summary{cursor:pointer;font-weight:600;padding:8px 0}.xpo-acc .aa{opacity:.75;padding:0 0 10px}
.xpo-gal{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.xpo-gal i{aspect-ratio:1;border-radius:10px;background:linear-gradient(160deg,#11161b,#1b232b);display:block}
.xpo-img,.xpo-imgEl{margin:0;border-radius:12px;width:100%;display:block;background:linear-gradient(160deg,#11161b,#1b232b)}
.cap{opacity:.6;font-size:13px;text-align:center;margin-top:8px}
@media (min-width:1025px){.hide-desktop{display:none!important}}
@media (min-width:641px) and (max-width:1024px){.hide-tablet{display:none!important}}
@media (max-width:640px){.hide-mobile{display:none!important}}
.xpo-divider{border:0;border-top:1px solid rgba(255,255,255,.12);margin:0}
.xpo-iconbox .ib-i{width:46px;height:46px;border-radius:12px;background:rgba(95,141,122,.18);color:var(--accent);display:grid;place-items:center;font-size:22px;margin-bottom:12px}
.xpo-iconbox h4{margin:0 0 6px;font-family:'Saira Semi Condensed';font-size:18px}.xpo-iconbox p{margin:0;opacity:.7;font-size:14px}
.xpo-cta{display:flex;align-items:center;gap:24px;flex-wrap:wrap;justify-content:space-between;padding:30px;border-radius:18px;background:linear-gradient(120deg,#0a0d10 30%,var(--accent) 300%);border:1px solid var(--line)}
.xpo-cta h3{margin:0;font-family:'Saira Semi Condensed';font-size:24px}.xpo-cta p{margin:6px 0 0;opacity:.78}
.xpo-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:18px;text-align:center}
.xpo-stats .stv{font-family:'Saira Semi Condensed';font-weight:700;font-size:38px;color:var(--accent)}
.xpo-stats .stl{opacity:.7;font-size:13px;margin-top:2px}
.xpo-logos{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:center}
.xpo-logos .lg{padding:12px 20px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid var(--line);font-family:'Saira Semi Condensed';font-weight:600;opacity:.8}
.xpo-quote{margin:0}.xpo-quote blockquote{margin:0;font-size:20px;line-height:1.5;font-family:'Saira Semi Condensed'}
.xpo-quote figcaption{margin-top:12px;opacity:.7;font-size:14px}.xpo-quote figcaption span{opacity:.7}
.xpo-posts{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.xpo-posts--empty{opacity:.6}
.xpo-cols{display:grid}
.xpo-stack{display:flex;flex-direction:column}
@media (max-width:640px){.xpo-cols{grid-template-columns:1fr!important}}
.xpo-pricing{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.xpr{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:24px;text-align:center}
.xpr.feat{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.xpr h4{margin:0 0 8px;font-family:'Saira Semi Condensed';font-size:18px}
.xpr-price{font-family:'Saira Semi Condensed';font-weight:700;font-size:34px;color:var(--accent)}
.xpr-price span{font-size:13px;opacity:.6;color:inherit;font-weight:400}
.xpr ul{list-style:none;padding:0;margin:16px 0;text-align:left;display:grid;gap:8px}
.xpr li{opacity:.82;font-size:14px;padding-left:20px;position:relative}
.xpr li::before{content:"\\2713";position:absolute;left:0;color:var(--accent)}
.xpo-prog{display:grid;gap:14px}
.xpb-h{display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px;opacity:.85}
.xpb-t{height:8px;border-radius:99px;background:var(--line);overflow:hidden}
.xpb-t i{display:block;height:100%;background:var(--accent);border-radius:99px}
.xpo-social{display:flex;gap:10px;flex-wrap:wrap}
.xsoc{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:inherit;text-decoration:none;text-transform:uppercase;font-weight:600;font-size:13px}
.xsoc:hover{border-color:var(--accent);color:var(--accent)}
.xpo-btns{display:flex;gap:12px;flex-wrap:wrap}
.xpo-map{border-radius:12px;overflow:hidden;background:#0a0d10}
.xpo-map iframe{width:100%;height:100%;border:0;display:block}
.xpo-count .xc{display:flex;gap:14px;flex-wrap:wrap}
.xpo-count .xc>div{background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:12px;padding:14px 18px;text-align:center;min-width:70px}
.xpo-count b{display:block;font-family:'Saira Semi Condensed';font-size:30px;color:var(--accent)}
.xpo-count span{font-size:11px;opacity:.6;text-transform:uppercase;letter-spacing:1px}
.xpo-count .xc-l{margin-top:10px;opacity:.7}
.xpo-comments{margin-top:24px}
.xcm-title{font-family:'Saira Semi Condensed';font-size:22px;margin:0 0 14px}
.xcm-list{list-style:none;padding:0;margin:0 0 20px;display:grid;gap:12px}
.xcm-i{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.xcm-i b{color:var(--accent)}.xcm-i p{margin:6px 0 0;opacity:.85}
.xcm-empty{opacity:.5;list-style:none}
.xcm-form{display:grid;gap:10px;max-width:560px}
.xcm-row{display:flex;gap:10px;flex-wrap:wrap}
.xcm-in{flex:1;min-width:140px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px 12px;color:inherit;font:inherit}
.xcm-form textarea{min-height:90px;resize:vertical}
.xcm-msg{color:var(--accent);margin:0}
.xcm-sub{margin-left:28px;border-left:2px solid var(--line);padding-left:14px;margin-top:10px}
.xcm-reply{background:none;border:0;color:var(--accent);cursor:pointer;font:inherit;font-size:12px;padding:2px 0;opacity:.85}
.xcm-replyto{font-size:13px;opacity:.8;margin:0 0 4px}
.xcm-cancel{background:none;border:0;color:var(--accent);cursor:pointer;font:inherit;text-decoration:underline}
.xpo-shop{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
.xsh-card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.xsh-name{font-family:'Saira Semi Condensed';font-size:18px}
.xsh-price{color:var(--accent);font-weight:600;font-size:20px;flex:1}
.xsh-out{opacity:.5;font-size:13px}
.xsh-cartbtn{position:fixed;left:20px;bottom:20px;background:var(--accent);color:#fff;border:0;border-radius:99px;padding:12px 18px;cursor:pointer;z-index:99997;box-shadow:0 8px 24px rgba(0,0,0,.3);font:inherit}
.xsh-drawer{position:fixed;top:0;right:0;height:100%;width:360px;max-width:100vw;background:#0e1216;border-left:1px solid rgba(255,255,255,.1);transform:translateX(100%);transition:transform .25s;z-index:99999;display:flex;flex-direction:column;color:var(--fg)}
.xsh-drawer.open{transform:none}
.xsh-drawer h3{margin:0;padding:16px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}
.xsh-items{flex:1;overflow-y:auto;padding:12px}
.xsh-row{display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--surface-2)}
.xsh-foot{padding:16px;border-top:1px solid var(--line);display:grid;gap:8px}
.xsh-foot input{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:9px 11px;color:#fff;font:inherit}
.xsh-link{text-decoration:none;color:inherit;display:block}
.xsh-img{aspect-ratio:4/3;border-radius:10px;background:rgba(255,255,255,.05);background-size:cover;background-position:center;margin-bottom:10px}
.xsh-img--ph{background:linear-gradient(135deg,rgba(95,141,122,.25),rgba(255,255,255,.04))}
.xpo-product{display:grid;grid-template-columns:1fr 1fr;gap:32px;max-width:1000px;align-items:start}
.xpr-img{aspect-ratio:1;border-radius:16px;background:rgba(255,255,255,.05);background-size:cover;background-position:center}
.xpr-img--ph{background:linear-gradient(135deg,rgba(95,141,122,.25),rgba(255,255,255,.04))}
.xpr-name{font-family:'Saira Semi Condensed';font-size:30px;margin:0 0 6px}
.xpr-cat{font-size:12px;text-transform:uppercase;letter-spacing:.08em;opacity:.6}
.xpr-price{color:var(--accent);font-size:26px;font-weight:600;margin:10px 0}
.xpr-desc{opacity:.85;line-height:1.6;margin:14px 0}
.xpr-stock{font-size:13px;opacity:.7;margin-bottom:14px}
@media(max-width:760px){.xpo-product{grid-template-columns:1fr}}
.xpr-rating{display:flex;align-items:center;gap:8px;margin:6px 0}.xpr-attrs{display:flex;flex-direction:column;gap:10px;margin:14px 0}.xpr-attr-row{display:flex;align-items:center;gap:10px;font-size:14px}.xpr-attr-row span{min-width:80px;opacity:.8}.xpr-attr{flex:1;max-width:220px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:8px 10px;color:#fff;font:inherit}
.xpo-reviews{margin-top:8px}.xrv-i{border-top:1px solid var(--line);padding:12px 0}.xrv-h{display:flex;align-items:center;gap:10px;margin-bottom:4px}.xrv-empty{opacity:.6}.xrv-form{margin-top:16px;display:flex;flex-direction:column;gap:8px;max-width:480px}.xrv-stars{display:flex;gap:4px;font-size:24px;cursor:pointer}.xrv-stars span{color:rgba(255,255,255,.25)}.xrv-stars span.on{color:#f5b301}.xrv-msg{color:var(--accent);margin:0;font-size:14px}
.xpo-slider{position:relative;overflow:hidden;border-radius:14px}
.xsl-track{display:flex;transition:transform .5s ease}
.xsl-slide{min-width:100%;min-height:340px;background-size:cover;background-position:center;display:flex;align-items:flex-end;padding:28px;box-sizing:border-box;position:relative;background-color:#11161b}
.xsl-slide::after{content:"";position:absolute;inset:0;background:linear-gradient(transparent,rgba(0,0,0,.65))}
.xsl-c{position:relative;z-index:1;color:#fff;max-width:600px}
.xsl-c h3{font-family:'Saira Semi Condensed';font-size:28px;margin:0 0 6px}
.xsl-c p{margin:0 0 12px;opacity:.9}
.xsl-nav{position:absolute;top:50%;transform:translateY(-50%);background:rgba(0,0,0,.4);color:#fff;border:0;width:42px;height:42px;border-radius:50%;cursor:pointer;font-size:22px;z-index:2}
.xsl-prev{left:12px}.xsl-next{right:12px}
.xsl-dots{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:2}
.xsl-dot{width:9px;height:9px;border-radius:50%;border:0;background:rgba(255,255,255,.4);cursor:pointer}
.xsl-dot.on{background:#fff}
.xpo-form{display:flex;flex-direction:column;gap:14px;max-width:560px}
.xfm-f{display:flex;flex-direction:column;gap:6px}
.xfm-l{font-size:13px;opacity:.85}
.xfm-i{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);border-radius:9px;padding:11px 13px;color:inherit;font:inherit;width:100%;box-sizing:border-box}
.xfm-i:focus{outline:none;border-color:var(--accent)}
.xfm-cb{display:flex;gap:8px;align-items:center;font-size:14px}
.xfm-submit{align-self:flex-start;cursor:pointer}
.xfm-msg{margin:0;color:var(--accent)}
.xpo-form--empty{opacity:.5;padding:14px;border:1px dashed rgba(255,255,255,.2);border-radius:10px;text-align:center}
.xacc{max-width:760px}.xacc-t{width:100%;border-collapse:collapse;margin-top:10px}.xacc-t th,.xacc-t td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:14px}.xacc-forms{display:flex;flex-direction:column;gap:8px}.xacc-forms .xfm-i{display:block;width:100%;box-sizing:border-box;margin-bottom:8px}.xacc-forms h3{margin:0 0 10px}
.xpo-iconlist{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px}
.xpo-iconlist li{display:flex;gap:10px;align-items:flex-start}
.xil-i{color:var(--accent);font-weight:700;flex:0 0 auto}
.xpo-quote{border-left:3px solid var(--accent);margin:0;padding:8px 0 8px 20px;font-size:20px;font-style:italic}
.xpo-quote cite{display:block;margin-top:10px;font-size:14px;font-style:normal;opacity:.7}
.xpo-flip{perspective:1200px;min-height:240px}
.xfl-inner{position:relative;width:100%;height:100%;min-height:240px;transition:transform .6s;transform-style:preserve-3d}
.xpo-flip:hover .xfl-inner{transform:rotateY(180deg)}
.xfl-front,.xfl-back{position:absolute;inset:0;backface-visibility:hidden;border-radius:14px;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box;background-size:cover;background-position:center}
.xfl-front{background-color:rgba(255,255,255,.04);border:1px solid var(--line)}
.xfl-back{background:var(--accent);color:#fff;transform:rotateY(180deg)}
.xfl-c h4{font-family:'Saira Semi Condensed';font-size:22px;margin:0 0 8px}
.xpo-share{display:flex;gap:10px;flex-wrap:wrap}
.xsh-btn{padding:8px 14px;border:1px solid rgba(255,255,255,.16);border-radius:99px;font-size:13px;cursor:pointer;text-decoration:none;color:inherit}
.xsh-btn:hover{border-color:var(--accent);color:var(--accent)}
.xah-rot{color:var(--accent);display:inline-block;transition:opacity .3s}
.xpo-toc{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 20px}
.xtoc-t{font-family:'Saira Semi Condensed';font-size:15px;text-transform:uppercase;letter-spacing:.08em;opacity:.7;margin-bottom:8px}
.xtoc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.xtoc-list a{opacity:.85;text-decoration:none;color:inherit}.xtoc-list a:hover{color:var(--accent)}.xtoc-list .lvl3{padding-left:16px;font-size:14px;opacity:.7}
.xpo-menu{display:flex;gap:20px;flex-wrap:wrap}.xpo-menu a{text-decoration:none;color:inherit;opacity:.85}.xpo-menu a:hover{color:var(--accent)}
.xpo-crumbs{display:flex;gap:8px;align-items:center;font-size:13px;opacity:.8;flex-wrap:wrap}.xpo-crumbs a{color:inherit;text-decoration:none}.xpo-crumbs a:hover{color:var(--accent)}.xbc-sep{opacity:.4}.xbc-cur{opacity:.7}
.xpo-postnav{display:flex;justify-content:space-between;gap:16px;border-top:1px solid var(--line);padding-top:18px;margin-top:24px}
.xpo-postnav a{text-decoration:none;color:inherit;display:flex;flex-direction:column;gap:3px}.xpo-postnav span{font-size:12px;opacity:.6}.xpo-postnav b{font-family:'Saira Semi Condensed'}.xpn-next{text-align:right;margin-left:auto}
.xpo-author{display:flex;gap:14px;align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.xau-av{width:48px;height:48px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-family:'Saira Semi Condensed';font-size:20px;flex:0 0 auto}
.xau-n{font-family:'Saira Semi Condensed';font-size:17px}.xau-b{opacity:.7;font-size:14px}
.reveal{opacity:0;transition:opacity .7s ease,transform .7s ease;will-change:opacity,transform}
.reveal-up{transform:translateY(30px)}.reveal-zoom{transform:scale(.94)}.reveal-left{transform:translateX(-30px)}.reveal-right{transform:translateX(30px)}
.reveal.in{opacity:1;transform:none}
@media (prefers-reduced-motion:reduce){.reveal{opacity:1;transform:none;transition:none}}
.xpo-icon{display:inline-flex;line-height:1}.xpo-icon-link{text-decoration:none}
.xpo-counter{text-align:center}.xct-num{font-family:'Saira Semi Condensed';font-size:46px;font-weight:700;color:var(--accent);line-height:1}.xct-label{opacity:.75;margin-top:6px}
.xpo-rating{display:inline-flex;align-items:center;gap:3px}.xrt-s{color:rgba(255,255,255,.25);font-size:20px}.xrt-s.on{color:#f5b301}.xrt-l{margin-left:8px;opacity:.7;font-size:14px}
.xpo-alert{position:relative;border-radius:12px;padding:14px 18px;border:1px solid;margin:0}.xpo-alert .xal-t{font-family:'Saira Semi Condensed';font-size:16px;margin-bottom:2px}.xpo-alert .xal-b{opacity:.9;font-size:14px}
.xal-info{background:rgba(95,141,122,.12);border-color:rgba(95,141,122,.5)}.xal-success{background:rgba(46,160,67,.12);border-color:rgba(46,160,67,.5)}.xal-warning{background:rgba(210,153,34,.12);border-color:rgba(210,153,34,.5)}.xal-error{background:rgba(231,43,43,.12);border-color:rgba(231,43,43,.5)}
.xal-x{position:absolute;top:8px;right:10px;background:none;border:0;color:inherit;font-size:20px;cursor:pointer;opacity:.6}.xal-x:hover{opacity:1}
.xpo-table-wrap{overflow-x:auto}.xpo-table{width:100%;border-collapse:collapse}.xpo-table th,.xpo-table td{text-align:left;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.1);font-size:14px}.xpo-table th{font-family:'Saira Semi Condensed';text-transform:uppercase;letter-spacing:.05em;font-size:12px;opacity:.8}
.xpo-pricelist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}.xpl-i{display:flex;align-items:baseline;gap:10px}.xpl-n{font-family:'Saira Semi Condensed';font-size:17px}.xpl-d{display:block;opacity:.65;font-size:13px}.xpl-dots{flex:1;border-bottom:1px dotted rgba(255,255,255,.25);transform:translateY(-4px)}.xpl-p{color:var(--accent);font-weight:600;white-space:nowrap}
.xpo-audio audio{width:100%}.xpo-audio--empty{opacity:.5}
.xpo-hotspots{position:relative;display:inline-block;max-width:100%}.xpo-hotspots img{display:block;max-width:100%;border-radius:14px}.xhs-dot{position:absolute;transform:translate(-50%,-50%);width:26px;height:26px;border-radius:50%;border:2px solid #fff;background:var(--accent);cursor:pointer;padding:0}.xhs-pulse{position:absolute;inset:-6px;border-radius:50%;border:2px solid var(--accent);animation:xhsP 2s infinite}@keyframes xhsP{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.8);opacity:0}}.xhs-tip{position:absolute;bottom:130%;left:50%;transform:translateX(-50%);background:#0b0e11;border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:8px 12px;width:max-content;max-width:220px;opacity:0;pointer-events:none;transition:opacity .2s;text-align:left;font-size:13px;z-index:3}.xhs-tip b{display:block;font-family:'Saira Semi Condensed'}.xhs-dot:hover .xhs-tip{opacity:1}
.xpo-lottie--empty{opacity:.5}
.xpo-login{max-width:340px}.xlg-form{display:flex;flex-direction:column;gap:8px}.xlg-msg{margin:0;font-size:13px;color:var(--accent)}
.xpo-loop{display:grid;gap:18px}.xlp-card{display:flex;flex-direction:column;text-decoration:none;color:inherit;background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;transition:transform .2s,border-color .2s}.xlp-card:hover{transform:translateY(-3px);border-color:var(--accent)}.xlp-img{aspect-ratio:16/10;background:rgba(255,255,255,.05);background-size:cover;background-position:center}.xlp-img--ph{background:linear-gradient(135deg,rgba(95,141,122,.25),rgba(255,255,255,.04))}.xlp-body{padding:16px}.xlp-meta{font-size:11px;text-transform:uppercase;letter-spacing:.07em;opacity:.6;margin-bottom:6px}.xlp-title{font-family:'Saira Semi Condensed';font-size:18px;margin:0 0 6px}.xlp-text{opacity:.8;font-size:14px;margin:0}.xlp-btn{color:var(--accent);font-size:14px;display:inline-block;margin-top:10px}@media(max-width:760px){.xpo-loop{grid-template-columns:1fr !important}}
.xpo-search{display:flex;gap:10px;max-width:520px}.xpo-search .xfm-i{flex:1}
.xpo-video{position:relative;border-radius:12px;overflow:hidden;background:#0a0d10}
.xpo-video iframe,.xpo-video video{position:absolute;inset:0;width:100%;height:100%;border:0}
.xpo-video--empty{aspect-ratio:16/9;display:grid;place-items:center;opacity:.5}
.xpost{display:flex;flex-direction:column;gap:6px;padding:18px;border-radius:14px;background:var(--surface);border:1px solid var(--line);text-decoration:none;color:inherit;transition:border-color .15s}
.xpost:hover{border-color:var(--accent)}
.xpost__c{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--accent)}
.xpost h4{margin:0;font-family:'Saira Semi Condensed';font-size:18px}
.xpost p{margin:0;opacity:.7;font-size:14px}
.xpost__d{margin-top:auto;opacity:.5;font-size:12px}
.xpo-foot{border-top:1px solid var(--line);margin-top:60px;padding:30px 0}
.xpo-foot__in{max-width:1100px;margin:0 auto;padding:0 24px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;color:rgba(234,238,242,.5);font-size:13px}
.xpo-foot__nav{display:flex;gap:16px}
.xpo-foot__nav a{color:rgba(234,238,242,.6);text-decoration:none}
.xpo-foot__nav a:hover{color:var(--fg)}
.xpo-specs{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0;margin:0;border-top:1px solid var(--line)}
.xpo-spec{display:flex;justify-content:space-between;gap:16px;padding:12px 2px;border-bottom:1px solid var(--line)}
.xpo-spec dt{margin:0;color:rgba(234,238,242,.6);font-size:14px}
.xpo-spec dd{margin:0;font-weight:500}${collectStyleCss(root)}
</style>${opts?.extraHead || ""}</head><body>${renderHeader(nav, tenant)}${renderNode(root)}${renderFooter(nav, tenant)}<script src="${assetUrl('/xpo-bundle.js')}" defer></script><script${na}>(function(){try{var d=JSON.stringify({path:location.pathname,ref:document.referrer||""});if(navigator.sendBeacon){navigator.sendBeacon("/api/track",new Blob([d],{type:"application/json"}));}else{fetch("/api/track",{method:"POST",headers:{"content-type":"application/json"},body:d,keepalive:true});}}catch(e){}})();</script>${opts?.extraBody || ""}</body></html>`;
}

export function countLinks(root: Block): { internal: number; external: number; image: number } {
  let internal = 0, external = 0, image = 0;
  const isUrl = (u: unknown): u is string => typeof u === "string" && u.length > 0;
  const tally = (u: string) => { if (/^https?:\/\//i.test(u)) external++; else if (u[0] === "/" || (!u.includes("://") && u !== "#")) internal++; };
  const walk = (b: Block) => {
    const s: any = b.settings || {};
    if (b.type === "xpo/button" && isUrl(s.url)) tally(s.url);
    if (b.type === "xpo/hero") ((s.buttons || []) as any[]).forEach((x) => { if (isUrl(x?.url)) tally(x.url); });
    if (b.type === "xpo/image" && isUrl(s.src)) image++;
    if (b.type === "xpo/gallery") image += Number(s.count) || 0;
    (b.children || []).forEach(walk);
  };
  walk(root);
  return { internal, external, image };
}
