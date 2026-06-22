import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/database.js";
import { authGuard, requireRole } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";
import { PagesRepo } from "../pages/pages.repository.js";
import { PostsRepo } from "../posts/posts.routes.js";
import { SettingsRepo } from "../settings/settings.routes.js";
import { productDocs, type KDoc } from "./knowledge.js";
import { bm25 } from "./retrieval.js";

const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const TEXT_KEYS = ["text", "body", "title", "heading", "eyebrow", "label", "quote", "name", "subtitle", "caption", "value"];
const ARR_KEYS = ["items", "cards", "features", "plans", "specs", "slides", "logos", "tabs"];

function blockText(node: any): string {
  if (!node || typeof node !== "object") return "";
  const s = node.settings || {};
  const out: string[] = [];
  for (const k of TEXT_KEYS) if (typeof s[k] === "string") out.push(s[k]);
  for (const ak of ARR_KEYS) if (Array.isArray(s[ak])) for (const it of s[ak]) {
    if (it && typeof it === "object") for (const k of TEXT_KEYS) if (typeof it[k] === "string") out.push(it[k]);
  }
  for (const c of (node.children || [])) out.push(blockText(c));
  return out.join(" ");
}

function stripHtml(s: string): string { return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }

// Bouw het zoekcorpus uit productkennis + eigen content.
export function buildCorpus(tenant: string): KDoc[] {
  const docs: KDoc[] = [...productDocs()];
  for (const p of PagesRepo.list(tenant)) {
    const txt = blockText(p.blocks).slice(0, 4000);
    docs.push({ id: "page:" + p.id, title: p.title, text: `${p.title}. ${p.seo?.description || ""} ${txt}`.trim(), source: "page", url: "/site/" + p.slug });
  }
  for (const p of PostsRepo.list(tenant)) {
    const txt = blockText(p.blocks).slice(0, 4000);
    docs.push({ id: "post:" + p.id, title: p.title, text: `${p.title}. ${p.excerpt || ""} ${txt}`.trim(), source: "post", url: "/blog/" + p.slug });
  }
  for (const r of (getDb().prepare("SELECT id, title, body FROM kb_articles WHERE tenant_id = ?").all(tenant) as any[])) {
    docs.push({ id: "kb:" + r.id, title: r.title, text: `${r.title}. ${stripHtml(r.body)}`, source: "helpdesk", url: "" });
  }
  for (const r of (getDb().prepare("SELECT id, title, body, url FROM ai_kb WHERE tenant_id = ?").all(tenant) as any[])) {
    docs.push({ id: "ai:" + r.id, title: r.title, text: `${r.title}. ${stripHtml(r.body)}`, source: "kennisbank", url: r.url || "" });
  }
  return docs;
}

const AiKbRepo = {
  list(tenant: string) {
    return (getDb().prepare("SELECT id, title, body, url, updated_at FROM ai_kb WHERE tenant_id = ? ORDER BY updated_at DESC").all(tenant) as any[])
      .map((r) => ({ id: r.id, title: r.title, body: r.body, url: r.url, when: r.updated_at }));
  },
  create(tenant: string, b: any) {
    const id = "k_" + Math.random().toString(36).slice(2, 9); const now = Date.now();
    getDb().prepare("INSERT INTO ai_kb (id, tenant_id, title, body, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, tenant, clip(b?.title, 200) || "Kennisitem", clip(b?.body, 20000), clip(b?.url, 400), now, now);
    return getDb().prepare("SELECT id, title, body, url, updated_at FROM ai_kb WHERE id = ?").get(id);
  },
  update(tenant: string, id: string, b: any) {
    const cur = getDb().prepare("SELECT * FROM ai_kb WHERE tenant_id = ? AND id = ?").get(tenant, id) as any;
    if (!cur) return null;
    getDb().prepare("UPDATE ai_kb SET title = ?, body = ?, url = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
      .run(clip(b?.title ?? cur.title, 200), clip(b?.body ?? cur.body, 20000), clip(b?.url ?? cur.url, 400), Date.now(), tenant, id);
    return getDb().prepare("SELECT id, title, body, url, updated_at FROM ai_kb WHERE id = ?").get(id);
  },
  remove(tenant: string, id: string) { return getDb().prepare("DELETE FROM ai_kb WHERE tenant_id = ? AND id = ?").run(tenant, id).changes > 0; },
};

const LogsRepo = {
  add(tenant: string, q: string, a: string, provider: string, score: number) {
    getDb().prepare("INSERT INTO ai_logs (id, tenant_id, question, answer, provider, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("lg_" + Math.random().toString(36).slice(2, 9), tenant, clip(q, 1000), clip(a, 4000), provider, score, Date.now());
  },
  list(tenant: string) {
    return (getDb().prepare("SELECT question, answer, provider, score, created_at FROM ai_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100").all(tenant) as any[])
      .map((r) => ({ question: r.question, answer: r.answer, provider: r.provider, score: r.score, when: r.created_at }));
  },
};

function composeAnswer(hits: ReturnType<typeof bm25>): string {
  const top = hits[0].doc;
  let text = top.text.length > 600 ? top.text.slice(0, 600).replace(/\s+\S*$/, "") + "\u2026" : top.text;
  return text;
}

// Optionele LLM-laag (Groq → Anthropic). Zonder sleutel valt alles terug op lokaal extractief.
async function askLLM(message: string, hits: ReturnType<typeof bm25>, ai: any): Promise<{ answer: string; provider: string } | null> {
  const ctx = hits.map((h) => `- ${h.doc.title}: ${h.doc.text}`).join("\n").slice(0, 3000);
  const system = `Je bent ${ai.name || "Quinty"}, de assistent van XPO Screens. Antwoord kort en in het Nederlands, uitsluitend op basis van deze context:\n${ctx}`;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    if (ai.groqKey) {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", signal: ctrl.signal,
        headers: { "content-type": "application/json", authorization: "Bearer " + ai.groqKey },
        body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: system }, { role: "user", content: message }], temperature: 0.3 }),
      });
      const j: any = await r.json();
      const a = j?.choices?.[0]?.message?.content;
      if (a) return { answer: String(a).trim(), provider: "groq" };
    }
    if (ai.anthropicKey) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: ctrl.signal,
        headers: { "content-type": "application/json", "x-api-key": ai.anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 512, system, messages: [{ role: "user", content: message }] }),
      });
      const j: any = await r.json();
      const a = j?.content?.[0]?.text;
      if (a) return { answer: String(a).trim(), provider: "anthropic" };
    }
  } catch { /* netwerk niet beschikbaar → lokaal */ } finally { clearTimeout(t); }
  return null;
}

export async function aiRoutes(app: FastifyInstance) {
  // publiek: chat met de assistent (Quinty)
  app.post("/api/ai/chat", async (req, reply) => {
    const tenant = tenantOf(req);
    const message = clip((req.body as any)?.message, 1000);
    if (message.length < 2) return reply.code(400).send({ error: "Stel een vraag", issues: [{ path: "message", message: "Stel een vraag" }] });
    const settings = SettingsRepo.get(tenant);
    const ai = settings.ai;
    const hits = bm25(message, buildCorpus(tenant), 4);
    const top = hits[0];
    let answer = ""; let provider = "local"; const score = top ? top.score : 0;
    if (!top || top.score < 1.0) {
      answer = ai.fallback;
    } else {
      const llm = await askLLM(message, hits, ai);
      if (llm) { answer = llm.answer; provider = llm.provider; }
      else { answer = composeAnswer(hits); provider = "local"; }
    }
    LogsRepo.add(tenant, message, answer, provider, score);
    return reply.send({
      answer, provider, score,
      sources: hits.slice(0, 3).map((h) => ({ title: h.doc.title, url: h.doc.url, source: h.doc.source })),
    });
  });

  // publiek: zoeksuggesties uit het corpus
  app.get("/api/ai/suggest", async (req, reply) => {
    const tenant = tenantOf(req);
    const q = clip((req.query as any)?.q, 200);
    const hits = q ? bm25(q, buildCorpus(tenant), 6) : [];
    return reply.send({ suggestions: hits.map((h) => ({ title: h.doc.title, url: h.doc.url, source: h.doc.source })) });
  });

  // statistieken over het corpus (admin)
  app.get("/api/ai/stats", { preHandler: authGuard }, async (req, reply) => {
    const docs = buildCorpus(tenantOf(req));
    const by: Record<string, number> = {};
    for (const d of docs) by[d.source] = (by[d.source] || 0) + 1;
    return reply.send({ total: docs.length, bySource: by, logs: LogsRepo.list(tenantOf(req)).length });
  });
  app.post("/api/ai/reindex", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    return reply.send({ ok: true, indexed: buildCorpus(tenantOf(req)).length });
  });
  app.get("/api/ai/logs", { preHandler: authGuard }, async (req, reply) => reply.send(LogsRepo.list(tenantOf(req))));

  // kennisbank-beheer (admin)
  app.get("/api/ai/kb", { preHandler: authGuard }, async (req, reply) => reply.send(AiKbRepo.list(tenantOf(req))));
  app.post("/api/ai/kb", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => reply.send(AiKbRepo.create(tenantOf(req), req.body)));
  app.put("/api/ai/kb/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    const r = AiKbRepo.update(tenantOf(req), String((req.params as any).id), req.body);
    if (!r) return reply.code(404).send({ error: "Kennisitem niet gevonden" });
    return reply.send(r);
  });
  app.delete("/api/ai/kb/:id", { preHandler: [authGuard, requireRole("editor")] }, async (req, reply) => {
    if (!AiKbRepo.remove(tenantOf(req), String((req.params as any).id))) return reply.code(404).send({ error: "Niet gevonden" });
    return reply.send({ ok: true });
  });
}
