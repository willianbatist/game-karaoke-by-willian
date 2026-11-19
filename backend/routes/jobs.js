/**
 * Rotas de acompanhamento e cancelamento de jobs (CONTRACTS.md §5, §5.1 e Aba Preparando):
 * - GET /api/jobs
 * - GET /api/jobs/:id
 * - GET /api/jobs/:id/events (SSE)
 * - DELETE /api/jobs/:id
 */

import { Router } from "express";
import { AppError } from "../utils/errors.js";

export function createJobsRouter({ jobQueue }) {
  const router = Router();

  router.get("/", (req, res, next) => {
    try {
      const jobs = typeof jobQueue.listJobs === "function" ? jobQueue.listJobs() : [];
      const activeCount = jobs.filter(
        (j) => j.status === "queued" || j.status === "running"
      ).length;

      return res.json({
        jobs,
        activeCount,
      });
    } catch (err) {
      return next(err);
    }
  });

  router.get("/:id", (req, res, next) => {
    try {
      const state = jobQueue.getJobPublicState(req.params.id);
      if (!state) {
        throw new AppError(404, "JOB_NOT_FOUND", "Job não encontrado.");
      }
      return res.json(state);
    } catch (err) {
      return next(err);
    }
  });

  router.get("/:id/events", (req, res, next) => {
    try {
      jobQueue.subscribeSse(req.params.id, req, res);
    } catch (err) {
      return next(err);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      const result = await jobQueue.cancelJob(req.params.id);
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}