/**
 * Rotas de histórico de partidas, rankings e exportação CSV/TXT
 * (FRONTEND_ARCHITECTURE.md §13 e CONTRACTS.md §5.2):
 * - GET /api/history?player_id=&video_id=&difficulty=&from=&to=&limit=
 * - GET /api/history/rankings?video_id=
 * - GET /api/history/export?format=csv|txt&player_id=&bom=1&sep=;|&decimal=comma|dot
 * - GET /api/history/:id
 * - POST /api/history
 * - DELETE /api/history/:id
 * - DELETE /api/history?player_id=&confirm=all
 */

import { Router } from "express";
import { AppError } from "../utils/errors.js";

export function createHistoryRouter({ historyService }) {
  const router = Router();

  // Lista partidas do histórico com filtros opcionais (mais recentes primeiro)
  router.get("/", async (req, res, next) => {
    try {
      const entries = await historyService.listEntries({
        playerId: typeof req.query.player_id === "string" ? req.query.player_id : "",
        videoId: typeof req.query.video_id === "string" ? req.query.video_id : "",
        difficulty: typeof req.query.difficulty === "string" ? req.query.difficulty : "",
        from: typeof req.query.from === "string" ? req.query.from : "",
        to: typeof req.query.to === "string" ? req.query.to : "",
        limit: req.query.limit ?? null,
      });

      return res.json({ entries });
    } catch (err) {
      return next(err);
    }
  });

  // Ranking local por música (melhor nota concluída por jogador, ordem decrescente)
  router.get("/rankings", async (req, res, next) => {
    try {
      const videoId = typeof req.query.video_id === "string" ? req.query.video_id : "";
      const ranking = await historyService.getRankings(videoId);
      return res.json(ranking);
    } catch (err) {
      return next(err);
    }
  });

  // Exportação do histórico em arquivo CSV ou TXT (CONTRACTS.md §5.2, §9.2 e §9.3)
  router.get("/export", async (req, res, next) => {
    try {
      const format = typeof req.query.format === "string" ? req.query.format : "csv";
      const playerId = typeof req.query.player_id === "string" ? req.query.player_id : "";
      const bom = typeof req.query.bom === "string" ? req.query.bom : "0";
      const sep = typeof req.query.sep === "string" ? req.query.sep : ";";
      const decimal = typeof req.query.decimal === "string" ? req.query.decimal : "comma";

      const exported = await historyService.exportHistory({
        format,
        playerId,
        bom,
        sep,
        decimal,
      });

      res.setHeader("Content-Type", exported.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${exported.filename}"`);
      return res.send(exported.content);
    } catch (err) {
      return next(err);
    }
  });

  // Busca uma entrada específica pelo ID
  router.get("/:id", async (req, res, next) => {
    try {
      const entry = await historyService.getEntryById(req.params.id);
      if (!entry) {
        throw new AppError(404, "ENTRY_NOT_FOUND", "Registro de histórico não encontrado.");
      }
      return res.json(entry);
    } catch (err) {
      return next(err);
    }
  });

  // Grava uma partida concluída (201 se nova, 200 se o UUID já existir - idempotente)
  router.post("/", async (req, res, next) => {
    try {
      const { entry, created } = await historyService.addEntry(req.body);
      return res.status(created ? 201 : 200).json(entry);
    } catch (err) {
      return next(err);
    }
  });

  // Apaga uma entrada específica do histórico pelo ID
  router.delete("/:id", async (req, res, next) => {
    try {
      const result = await historyService.deleteEntryById(req.params.id);
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  // Apaga entradas de um jogador (?player_id=) ou todo o histórico (?confirm=all)
  router.delete("/", async (req, res, next) => {
    try {
      const playerId = typeof req.query.player_id === "string" ? req.query.player_id : "";
      const confirm = typeof req.query.confirm === "string" ? req.query.confirm : "";
      const result = await historyService.deleteEntries({ playerId, confirm });
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}