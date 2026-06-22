// BM25-retrieval — moderne port van class-bm25-search.php.
// Gold-standard ranking (Elasticsearch-defaults), zonder externe afhankelijkheden.

import type { KDoc } from "./knowledge.js";

const K1 = 1.2;
const B = 0.75;

const STOP = new Set(
  ("de het een en van te in op met voor is dat die deze dit aan als bij door naar of om over " +
    "the a an and or of to in on for is that this these with by at as be are was were it its " +
    "ik je jij wij we u uw mijn ons hoe wat wie waar wanneer waarom welke kan kun je").split(/\s+/)
);

export function tokenize(s: string): string[] {
  return (String(s).toLowerCase().match(/[a-z0-9\u00c0-\u017f]+/g) || []).filter((t) => t.length >= 2 && !STOP.has(t));
}

export type Scored = { doc: KDoc; score: number };

export function bm25(query: string, docs: KDoc[], k = 4): Scored[] {
  const qTerms = tokenize(query);
  if (!qTerms.length || !docs.length) return [];
  const N = docs.length;
  const docTokens = docs.map((d) => tokenize(d.title + " " + d.title + " " + d.text)); // titel telt dubbel
  const dls = docTokens.map((t) => t.length);
  const avgdl = dls.reduce((a, b) => a + b, 0) / N || 1;
  const df: Record<string, number> = {};
  docTokens.forEach((toks) => {
    const seen = new Set<string>();
    for (const t of toks) if (!seen.has(t)) { seen.add(t); df[t] = (df[t] || 0) + 1; }
  });
  const idf = (term: string) => Math.log(1 + (N - (df[term] || 0) + 0.5) / ((df[term] || 0) + 0.5));
  const scored: Scored[] = docs.map((doc, i) => {
    const toks = docTokens[i];
    const tf: Record<string, number> = {};
    for (const t of toks) tf[t] = (tf[t] || 0) + 1;
    let score = 0;
    for (const term of qTerms) {
      const f = tf[term] || 0;
      if (!f) continue;
      score += idf(term) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (dls[i] / avgdl)));
    }
    return { doc, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}
