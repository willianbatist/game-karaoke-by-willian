/**
 * Rota GET /api/health (CONTRACTS.md §2.1 e §5).
 * Executa `<worker> doctor` e reporta estado do servidor, acelerador, dependências e cache.
 */

import { execFile } from "node:child_process";
import { Router } from "express";
import { getVenvPaths, ROOT_DIR } from "../../scripts/lib/venvPaths.js";

function runWorkerDoctor({ command, baseArgs, cwd, timeoutMs = 15000 }) {
  return new Promise((resolve) => {
    execFile(
      command,
      [...baseArgs, "doctor"],
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          resolve({
            ok: false,
            error: err.message,
            stderr: String(stderr || "").trim(),
          });
          return;
        }

        try {
          const parsed = JSON.parse(String(stdout || "").trim());
          resolve({ ok: true, report: parsed });
        } catch (parseErr) {
          resolve({
            ok: false,
            error: `Saída JSON inválida do doctor: ${parseErr.message}`,
            stderr: String(stderr || "").trim(),
          });
        }
      }
    );
  });
}

export function createHealthRouter({ cacheManager, doctorOptions = {} }) {
  const venvPaths = getVenvPaths();
  const command = doctorOptions.command ?? venvPaths.pythonBin;
  const baseArgs = doctorOptions.baseArgs ?? ["-m", "karaoke_worker"];
  const cwd = doctorOptions.cwd ?? ROOT_DIR;
  const cacheTtlMs = Number(doctorOptions.cacheTtlMs ?? 10000);

  let cachedDoctor = null;
  let cachedAt = 0;

  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const now = Date.now();
      const forceRefresh = req.query.refresh === "1";

      if (forceRefresh || !cachedDoctor || now - cachedAt > cacheTtlMs) {
        cachedDoctor = await runWorkerDoctor({ command, baseArgs, cwd });
        cachedAt = now;
      }

      const doctorOk =
        cachedDoctor.ok &&
        Boolean(cachedDoctor.report?.ffmpeg?.ok) &&
        Boolean(cachedDoctor.report?.yt_dlp?.ok);

      return res.json({
        status: doctorOk ? "ok" : "degraded",
        uptime_seconds: Math.round(process.uptime()),
        cache: {
          root: cacheManager.cacheRoot,
          total_bytes: cacheManager.getTotalCacheBytes(),
        },
        worker: cachedDoctor.ok ? cachedDoctor.report : { error: cachedDoctor.error },
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}