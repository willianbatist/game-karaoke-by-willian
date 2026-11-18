/**
 * Rota POST /api/prepare (CONTRACTS.md §5 e Fase 4 - T4.2).
 * - Valida videoId e enfileira o preparo (ou retorna status "ready" em cache hit).
 * - Quando não está em cache, calcula a pré-análise de compatibilidade (Fase 1)
 *   usando os metadados enviados (ou obtidos via yt-dlp) e o melhor candidato de letra.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Router } from "express";
import { AppError } from "../utils/errors.js";
import { validateVideoId } from "../utils/security.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

/**
 * Localiza o executável yt-dlp do ambiente virtual do worker (ou do sistema como fallback).
 */
function resolveYtDlpBinary() {
  const candidates = [
    path.join(PROJECT_ROOT, "worker", ".venv", "bin", "yt-dlp"),
    path.join(PROJECT_ROOT, "worker", ".venv", "Scripts", "yt-dlp.exe"),
  ];
  for (const binPath of candidates) {
    if (fs.existsSync(binPath)) return binPath;
  }
  return "yt-dlp";
}

/**
 * Busca metadados básicos de um vídeo específico via yt-dlp quando o cliente
 * não os enviou no corpo de POST /api/prepare (CONTRACTS.md §5).
 */
async function defaultFetchVideoMetadata(videoId) {
  try {
    const ytDlpBin = resolveYtDlpBinary();
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const { stdout } = await execFileAsync(
      ytDlpBin,
      ["--dump-single-json", "--no-playlist", "--no-warnings", "--skip-download", "--", url],
      { timeout: 6000, maxBuffer: 2 * 1024 * 1024 }
    );

    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object") return null;

    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      channel:
        typeof parsed.channel === "string"
          ? parsed.channel
          : typeof parsed.uploader === "string"
            ? parsed.uploader
            : "",
      duration:
        typeof parsed.duration === "number" && Number.isFinite(parsed.duration)
          ? parsed.duration
          : null,
    };
  } catch {
    return null;
  }
}

export function createPrepareRouter({
  jobQueue,
  lyricsService = null,
  compatibilityService = null,
  fetchVideoMetadata = defaultFetchVideoMetadata,
}) {
  const router = Router();

  router.post("/", async (req, res, next) => {
    try {
      const videoId = req.body?.videoId;
      if (!validateVideoId(videoId)) {
        throw new AppError(400, "INVALID_VIDEO_ID", "Identificador de vídeo inválido.");
      }

      const result = jobQueue.enqueue(videoId);
      if (result.status === "ready") {
        return res.status(200).json(result);
      }

      // Se não há serviço de compatibilidade injetado, mantém resposta compatível
      if (!compatibilityService) {
        return res.status(202).json(result);
      }

      let title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      let channel = typeof req.body?.channel === "string" ? req.body.channel.trim() : "";
      const rawDuration = Number(req.body?.duration);
      let duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null;

      // Fallback de metadados caso o cliente tenha chamado apenas com { videoId }
      if (!title && typeof fetchVideoMetadata === "function") {
        const fetched = await fetchVideoMetadata(videoId);
        if (fetched) {
          title = fetched.title || title;
          channel = fetched.channel || channel;
          if (duration === null && Number.isFinite(fetched.duration) && fetched.duration > 0) {
            duration = fetched.duration;
          }
        }
      }

      // Sem metadados utilizáveis, compatibility deve ser null (CONTRACTS.md §5)
      if (!title && !channel && duration === null) {
        return res.status(202).json({
          ...result,
          compatibility: null,
        });
      }

      // Busca candidato de letra no LRCLIB para enriquecer a pré-análise
      let lyricsCandidate = null;
      if (lyricsService && title) {
        try {
          const { candidates } = await lyricsService.searchCandidates({ title, channel });
          lyricsCandidate = lyricsService.selectBestCandidate(candidates, duration);
        } catch {
          lyricsCandidate = null;
        }
      }

      const compatibility = compatibilityService.evaluatePreAnalysis({
        title,
        channel,
        duration,
        lyricsCandidate,
      });

      return res.status(202).json({
        ...result,
        compatibility,
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}