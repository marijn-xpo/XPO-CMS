// RankMath-achtige content-analyse: focuskeyword, dichtheid, leesbaarheid, lengte, links, alt-teksten.
type Block = { type: string; settings?: any; children?: Block[] };

const TEXT_KEYS = ["text", "body", "title", "subtitle", "label", "heading", "prefix", "quote", "eyebrow", "lead", "intro"];
const ITEM_TEXT_KEYS = ["text", "title", "body", "label", "value", "name", "quote", "w"];

export type SeoAnalysis = {
  score: number;
  checks: { label: string; ok: boolean; info?: string }[];
  stats: { words: number; keyword: string; density: number; readability: number; readabilityLabel: string; images: number; imagesWithAlt: number; internalLinks: number; externalLinks: number };
};

type Collected = { text: string[]; headings: string[]; firstParagraph: string; images: { alt: string }[]; links: { url: string }[] };

function collect(block: Block, acc: Collected) {
  const s = block.settings || {};
  // tekst uit bekende velden
  for (const k of TEXT_KEYS) {
    if (typeof s[k] === "string" && s[k].trim()) {
      acc.text.push(s[k]);
      if (!acc.firstParagraph && (block.type === "xpo/text" || block.type === "xpo/hero")) acc.firstParagraph = s[k];
    }
  }
  // koppen
  if (block.type === "xpo/heading" && typeof s.text === "string") acc.headings.push(s.text);
  if (block.type === "xpo/hero" && typeof s.title === "string") acc.headings.push(s.title);
  if (block.type === "xpo/animated-heading" && typeof s.prefix === "string") acc.headings.push(s.prefix);
  // arrays met item-tekst
  if (Array.isArray(s.items)) for (const it of s.items) {
    if (typeof it === "string") acc.text.push(it);
    else if (it && typeof it === "object") {
      for (const k of ITEM_TEXT_KEYS) if (typeof it[k] === "string" && it[k].trim()) acc.text.push(it[k]);
      if (typeof it.url === "string") acc.links.push({ url: it.url });
      if (typeof it.src === "string") acc.images.push({ alt: String(it.alt || "") });
    }
  }
  // afbeeldingen
  if (block.type === "xpo/image" && typeof s.src === "string" && s.src) acc.images.push({ alt: String(s.alt || "") });
  // links
  for (const k of ["url", "href", "to", "link"]) if (typeof s[k] === "string" && s[k].trim()) acc.links.push({ url: s[k] });
  for (const c of block.children || []) collect(c, acc);
}

const words = (t: string) => t.toLowerCase().replace(/<[^>]+>/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
const sentences = (t: string) => t.replace(/\s+/g, " ").split(/[.!?]+/).map((x) => x.trim()).filter((x) => x.length > 0);
const syllables = (w: string) => Math.max(1, (w.toLowerCase().match(/[aeiouyàáâäèéêëìíîïòóôöùúûü]+/g) || []).length);

// Leesbaarheid via de Douma-formule (NL-variant van Flesch) → 0-100, hoger = makkelijker
function readingEase(text: string): number {
  const ws = words(text); const ss = sentences(text);
  if (ws.length < 5 || ss.length < 1) return 0;
  const asl = ws.length / ss.length; // gemiddelde zinslengte (woorden per zin)
  const syllPer100 = (ws.reduce((a, w) => a + syllables(w), 0) / ws.length) * 100; // lettergrepen per 100 woorden
  const douma = 206.84 - 0.77 * syllPer100 - 0.93 * asl;
  return Math.max(0, Math.min(100, Math.round(douma)));
}
function readabilityLabel(ease: number): string {
  if (ease >= 70) return "Makkelijk";
  if (ease >= 50) return "Gemiddeld";
  if (ease >= 30) return "Vrij moeilijk";
  return "Moeilijk";
}

export function analyzeSeo(page: { slug: string; title: string; seo?: any; blocks?: Block }, keywordArg?: string): SeoAnalysis {
  const acc: Collected = { text: [], headings: [], firstParagraph: "", images: [], links: [] };
  if (page.blocks) collect(page.blocks, acc);
  const seo = page.seo || {};
  const keyword = String(keywordArg ?? seo.keyword ?? "").trim().toLowerCase();
  const bodyText = acc.text.join(" \n ");
  const allWords = words(bodyText);
  const wordCount = allWords.length;

  // keyword-statistieken
  const kwWords = keyword ? words(keyword) : [];
  const kwHits = keyword ? (bodyText.toLowerCase().match(new RegExp(kwWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "g")) || []).length : 0;
  const density = keyword && wordCount ? Math.round((kwHits * kwWords.length / wordCount) * 1000) / 10 : 0;
  const inTitle = !!keyword && String(seo.title || page.title || "").toLowerCase().includes(keyword);
  const inSlug = !!keyword && String(page.slug || "").toLowerCase().replace(/-/g, " ").includes(keyword.replace(/-/g, " "));
  const inFirst = !!keyword && acc.firstParagraph.toLowerCase().includes(keyword);
  const inHeading = !!keyword && acc.headings.some((h) => h.toLowerCase().includes(keyword));
  const inAlt = !!keyword && acc.images.some((i) => i.alt.toLowerCase().includes(keyword));

  const ease = readingEase(bodyText);
  const imagesWithAlt = acc.images.filter((i) => i.alt.trim().length > 0).length;
  const isInternal = (u: string) => u.startsWith("/") || u.startsWith("#") || /^https?:\/\/[^/]*xpo|altermedia/i.test(u);
  const internalLinks = acc.links.filter((l) => isInternal(l.url)).length;
  const externalLinks = acc.links.filter((l) => /^https?:\/\//i.test(l.url) && !isInternal(l.url)).length;

  const t = String(seo.title || page.title || "").length;
  const d = String(seo.description || "").length;
  const checks: { label: string; ok: boolean; info?: string }[] = [];
  const add = (label: string, ok: boolean, info?: string) => checks.push({ label, ok, info });

  add("SEO-titel 15–60 tekens", t >= 15 && t <= 60, `${t} tekens`);
  add("Meta-omschrijving 50–160 tekens", d >= 50 && d <= 160, `${d} tekens`);
  add("Nette URL-slug", /^[a-z0-9-]+$/.test(page.slug || ""));
  if (keyword) {
    add("Focuskeyword in SEO-titel", inTitle);
    add("Focuskeyword in URL", inSlug);
    add("Focuskeyword in eerste alinea", inFirst);
    add("Focuskeyword in een kop", inHeading);
    add("Focuskeyword in tekst", kwHits > 0, `${kwHits}×`);
    add("Keyworddichtheid 0,5–2,5%", density >= 0.5 && density <= 2.5, `${density}%`);
    add("Focuskeyword in afbeelding-alt", inAlt || acc.images.length === 0);
  } else {
    add("Focuskeyword ingesteld", false, "Geen focuskeyword");
  }
  add("Voldoende content (≥ 300 woorden)", wordCount >= 300, `${wordCount} woorden`);
  add("Goede leesbaarheid", ease >= 50, `${readabilityLabel(ease)} (${ease})`);
  add("Alle afbeeldingen hebben alt-tekst", acc.images.length === 0 || imagesWithAlt === acc.images.length, `${imagesWithAlt}/${acc.images.length}`);
  add("Minstens één interne link", internalLinks > 0, `${internalLinks}`);

  const okCount = checks.filter((c) => c.ok).length;
  const score = Math.round((okCount / checks.length) * 100);
  return {
    score, checks,
    stats: { words: wordCount, keyword, density, readability: ease, readabilityLabel: readabilityLabel(ease), images: acc.images.length, imagesWithAlt, internalLinks, externalLinks },
  };
}
