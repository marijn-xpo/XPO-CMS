import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.js";
import { tenantOf } from "../../common/tenant.js";
import { PagesRepo } from "../pages/pages.repository.js";
import { PostsRepo } from "../posts/posts.routes.js";

export type SearchHit = { type: "page" | "post"; id: string; title: string; slug: string; status: string };

export async function searchRoutes(app: FastifyInstance) {
  app.get("/api/search", { preHandler: authGuard }, async (req, reply) => {
    const tenant = tenantOf(req);
    const q = String((req.query as any)?.q || "").trim().toLowerCase();
    if (!q) return reply.send({ q, results: [] as SearchHit[] });
    const results: SearchHit[] = [];
    for (const p of PagesRepo.list(tenant)) {
      if (p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q) || (p.seo.description || "").toLowerCase().includes(q)) {
        results.push({ type: "page", id: p.id, title: p.title, slug: p.slug, status: p.status });
      }
    }
    for (const p of PostsRepo.list(tenant)) {
      if (p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q) || (p.excerpt || "").toLowerCase().includes(q)) {
        results.push({ type: "post", id: p.id, title: p.title, slug: p.slug, status: p.status });
      }
    }
    return reply.send({ q, results: results.slice(0, 30) });
  });
}
