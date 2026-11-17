/**
 * Rota POST /api/prepare (CONTRACTS.md §5).
 */

import { Router } from "express";
import { AppError } from "../utils/errors.js";
import { validateVideoId } from "../utils/security.js";

export function createPrepareRouter({ jobQueue }) {
  const router = Router();

  router.post("/", (req, res, next) => {
    try {
      const videoId = req.body?.videoId;
      if (!validateVideoId(videoId)) {
        throw new AppError(400, "INVALID_VIDEO_ID", "Identificador de vídeo inválido.");
      }

      const result = jobQueue.enqueue(videoId);
      const statusCode = result.status === "ready" ? 200 : 202;
      return res.status(statusCode).json(result);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}