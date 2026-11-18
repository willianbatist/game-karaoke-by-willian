/**
 * Rotas de perfis de jogadores (FRONTEND_ARCHITECTURE.md §13 e CONTRACTS.md §5.2):
 * - GET /api/players
 * - POST /api/players
 * - PATCH /api/players/:id
 * - DELETE /api/players/:id?history=keep|delete
 */

import { Router } from "express";

export function createPlayersRouter({ playerService }) {
  const router = Router();

  // Lista todos os jogadores cadastrados
  router.get("/", async (_req, res, next) => {
    try {
      const players = await playerService.listPlayers();
      return res.json({ players });
    } catch (err) {
      return next(err);
    }
  });

  // Cria um novo jogador (201) ou retorna 409 se já existir nome duplicado
  router.post("/", async (req, res, next) => {
    try {
      const player = await playerService.createPlayer(req.body?.name);
      return res.status(201).json(player);
    } catch (err) {
      return next(err);
    }
  });

  // Renomeia um jogador existente
  router.patch("/:id", async (req, res, next) => {
    try {
      const updated = await playerService.renamePlayer(req.params.id, req.body?.name);
      return res.json(updated);
    } catch (err) {
      return next(err);
    }
  });

  // Remove um jogador, mantendo (keep) ou apagando (delete) suas partidas no histórico
  router.delete("/:id", async (req, res, next) => {
    try {
      const historyPolicy =
        typeof req.query.history === "string" ? req.query.history : "keep";
      const result = await playerService.deletePlayer(req.params.id, {
        history: historyPolicy,
      });
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}