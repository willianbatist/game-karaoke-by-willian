/**
 * Rota de busca no YouTube (Fase 4 - T4.1):
 * - GET /api/search?q=<termo ou url>&limit=<1..20>
 */

import { Router } from "express";

export function createSearchRouter({ youtubeSearchService }) {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q : "";
      const limit = req.query.limit;
      const results = await youtubeSearchService.searchVideos(q, { limit });

      return res.json({
        query: q.trim(),
        results,
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}