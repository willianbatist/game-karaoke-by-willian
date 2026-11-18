/**
 * Rotas de catálogo local, streaming de artefatos, ajustes e exclusão (CONTRACTS.md §4/§5 e T4.1/T4.2):
 * - GET /api/songs
 * - GET /api/songs/:id
 * - GET /api/songs/:id/files/:filename (com suporte a HTTP Range e guarda de path traversal)
 * - PATCH /api/songs/:id (atualiza letra, offsets e recalcula compatibilidade)
 * - DELETE /api/songs/:id
 */

import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { AppError } from "../utils/errors.js";
import { safeResolveCachePath, validateVideoId } from "../utils/security.js";

const ALLOWED_CACHE_FILES = new Set([
  "instrumental.flac",
  "vocals.flac",
  "pitch_map.json",
  "lyrics.json",
  "manifest.json",
]);

function getMimeType(filename) {
  if (filename.endsWith(".flac")) return "audio/flac";
  if (filename.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function getDirectorySizeBytes(dirPath) {
  try {
    let total = 0;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        total += fs.statSync(fullPath).size;
      } else if (entry.isDirectory()) {
        total += getDirectorySizeBytes(fullPath);
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export function createSongsRouter({ cacheManager, jobQueue, compatibilityService = null }) {
  const router = Router();

  // Lista todas as músicas prontas no cache local (com suporte a filtro ?q= e ordenação ?sort=)
  router.get("/", (req, res, next) => {
    try {
      const filterQuery = typeof req.query.q === "string" ? normalizeText(req.query.q.trim()) : "";
      const sortMode = typeof req.query.sort === "string" ? req.query.sort : "recent";
      const songs = [];

      if (fs.existsSync(cacheManager.cacheRoot)) {
        for (const entry of fs.readdirSync(cacheManager.cacheRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const videoId = entry.name;
          if (!validateVideoId(videoId) || !cacheManager.isSongReady(videoId)) continue;

          const manifest = cacheManager.readManifest(videoId);
          if (!manifest) continue;

          const title = manifest.source?.title ?? videoId;
          const channel = manifest.source?.channel ?? "";

          if (filterQuery) {
            const haystack = `${normalizeText(title)} ${normalizeText(channel)} ${videoId.toLowerCase()}`;
            if (!haystack.includes(filterQuery)) continue;
          }

          const songDir = cacheManager.getSongDir(videoId);
          const sizeBytes = getDirectorySizeBytes(songDir);

          songs.push({
            videoId,
            title,
            channel,
            duration: manifest.source?.duration ?? 0,
            lyrics: manifest.lyrics ?? null,
            compatibility: manifest.compatibility ?? null,
            lastPlayed: manifest.user?.last_played ?? null,
            createdAt: manifest.created_at ?? null,
            sizeBytes,
          });
        }
      }

      if (sortMode === "title") {
        songs.sort((a, b) => a.title.localeCompare(b.title, "pt-BR", { sensitivity: "base" }));
      } else if (sortMode === "size") {
        songs.sort((a, b) => b.sizeBytes - a.sizeBytes);
      } else {
        // Padrão: tocadas mais recentemente primeiro (com fallback para data de criação)
        songs.sort((a, b) => {
          const ta = a.lastPlayed
            ? Date.parse(a.lastPlayed)
            : a.createdAt
              ? Date.parse(a.createdAt)
              : 0;
          const tb = b.lastPlayed
            ? Date.parse(b.lastPlayed)
            : b.createdAt
              ? Date.parse(b.createdAt)
              : 0;
          return tb - ta;
        });
      }

      const totalSizeBytes = songs.reduce((acc, item) => acc + (item.sizeBytes || 0), 0);

      return res.json({
        songs,
        totalCount: songs.length,
        totalSizeBytes,
      });
    } catch (err) {
      return next(err);
    }
  });

  // Retorna manifest.json + lyrics.json da música e atualiza last_played
  router.get("/:id", (req, res, next) => {
    try {
      const videoId = req.params.id;
      if (!validateVideoId(videoId)) {
        throw new AppError(400, "INVALID_VIDEO_ID", "Identificador de vídeo inválido.");
      }

      if (!cacheManager.isSongReady(videoId)) {
        throw new AppError(404, "SONG_NOT_FOUND", "Música não encontrada no cache.");
      }

      const isJobActive = jobQueue.hasActiveJob(videoId);
      const updatedManifest =
        req.query.preview === "1"
          ? cacheManager.readManifest(videoId)
          : (cacheManager.touchLastPlayed(videoId, { isJobActive }) ??
            cacheManager.readManifest(videoId));

      const lyrics = cacheManager.readLyrics(videoId);

      return res.json({
        manifest: updatedManifest,
        lyrics,
      });
    } catch (err) {
      return next(err);
    }
  });

  // Entrega arquivos do cache (instrumental.flac, vocals.flac, pitch_map.json, etc.) com HTTP Range
  router.get("/:id/files/:filename", (req, res, next) => {
    try {
      const { id: videoId, filename } = req.params;
      const resolvedPath = safeResolveCachePath(cacheManager.cacheRoot, videoId, filename);

      if (!ALLOWED_CACHE_FILES.has(filename)) {
        throw new AppError(403, "FILE_NOT_ALLOWED", "Arquivo não permitido.");
      }

      if (!fs.existsSync(resolvedPath)) {
        throw new AppError(404, "FILE_NOT_FOUND", "Arquivo não encontrado.");
      }

      const stat = fs.statSync(resolvedPath);
      const totalSize = stat.size;
      const contentType = getMimeType(filename);
      const rangeHeader = req.headers.range;

      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", contentType);

      if (!rangeHeader) {
        res.setHeader("Content-Length", totalSize);
        return fs.createReadStream(resolvedPath).pipe(res);
      }

      // Interpreta cabeçalho HTTP Range: bytes=start-end
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (!match) {
        res.setHeader("Content-Range", `bytes */${totalSize}`);
        return res.status(416).end();
      }

      let start = match[1] ? Number.parseInt(match[1], 10) : 0;
      let end = match[2] ? Number.parseInt(match[2], 10) : totalSize - 1;

      if (!match[1] && match[2]) {
        // Sufixo: bytes=-500 (últimos 500 bytes)
        const suffixLen = Number.parseInt(match[2], 10);
        start = Math.max(0, totalSize - suffixLen);
        end = totalSize - 1;
      }

      if (
        Number.isNaN(start) ||
        Number.isNaN(end) ||
        start < 0 ||
        end >= totalSize ||
        start > end
      ) {
        res.setHeader("Content-Range", `bytes */${totalSize}`);
        return res.status(416).end();
      }

      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
      res.setHeader("Content-Length", chunkSize);

      return fs.createReadStream(resolvedPath, { start, end }).pipe(res);
    } catch (err) {
      return next(err);
    }
  });

  // Atualiza preferências da música (letra escolhida, offset_ms de letra e offset de latência)
  router.patch("/:id", (req, res, next) => {
    try {
      const videoId = req.params.id;
      if (!validateVideoId(videoId)) {
        throw new AppError(400, "INVALID_VIDEO_ID", "Identificador de vídeo inválido.");
      }

      if (jobQueue.hasActiveJob(videoId)) {
        throw new AppError(
          409,
          "JOB_ACTIVE",
          "Não é possível alterar a música enquanto ela está sendo processada."
        );
      }

      if (!cacheManager.isSongReady(videoId)) {
        throw new AppError(404, "SONG_NOT_FOUND", "Música não encontrada no cache.");
      }

      const manifest = cacheManager.readManifest(videoId);
      let lyricsData = cacheManager.readLyrics(videoId);
      const body = req.body ?? {};

      // Aceita tanto o formato aninhado (CONTRACTS.md §5) quanto o plano
      const rawOffsetMs = body.lyrics?.offset_ms !== undefined ? body.lyrics.offset_ms : body.offset_ms;
      const rawSelectedId =
        body.lyrics?.selected_id !== undefined ? body.lyrics.selected_id : body.selected_id;
      const rawLatencyOffsets =
        body.user?.latency_offsets_ms !== undefined
          ? body.user.latency_offsets_ms
          : body.latency_offsets_ms;

      // 1. Atualização de offset de sincronia da letra (offset_ms)
      if (rawOffsetMs !== undefined) {
        const offsetMs = Number(rawOffsetMs);
        if (!Number.isFinite(offsetMs)) {
          throw new AppError(400, "INVALID_OFFSET", "offset_ms deve ser um número válido.");
        }
        manifest.lyrics = {
          source: "lrclib",
          type: "none",
          selected_id: null,
          sync_quality: 0.0,
          ...(manifest.lyrics || {}),
          offset_ms: Math.round(offsetMs),
        };
      }

      // 2. Atualização da letra escolhida (selected_id) em lyrics.json + recálculo de compatibilidade
      if (rawSelectedId !== undefined) {
        if (!lyricsData || !Array.isArray(lyricsData.candidates)) {
          throw new AppError(400, "NO_LYRICS_CANDIDATES", "Não há candidatos de letra salvos.");
        }

        if (rawSelectedId === null) {
          lyricsData.selected_id = null;
          manifest.lyrics = {
            ...(manifest.lyrics || {}),
            source: "lrclib",
            type: "none",
            selected_id: null,
            sync_quality: 0.0,
          };
        } else {
          const selected = lyricsData.candidates.find((c) => c.id === rawSelectedId);
          if (!selected) {
            throw new AppError(
              400,
              "INVALID_LYRICS_ID",
              "Candidato de letra não encontrado para esta música."
            );
          }

          lyricsData.selected_id = selected.id;
          const type = selected.syncedLyrics
            ? "synced"
            : selected.plainLyrics
              ? "plain"
              : "none";

          manifest.lyrics = {
            ...(manifest.lyrics || {}),
            source: "lrclib",
            type,
            selected_id: selected.id,
          };
        }

        const songDir = cacheManager.getSongDir(videoId);
        const lyricsTarget = path.join(songDir, "lyrics.json");
        const lyricsTmp = path.join(songDir, `lyrics.json.${process.pid}.tmp`);
        fs.writeFileSync(lyricsTmp, JSON.stringify(lyricsData, null, 2) + "\n", "utf-8");
        fs.renameSync(lyricsTmp, lyricsTarget);

        // Recalcula lyrics.sync_quality e manifest.compatibility (CONTRACTS.md §5 / T4.2)
        if (compatibilityService) {
          let pitchMapMode = "reference";
          try {
            const pitchMapFile = manifest.files?.pitch_map || "pitch_map.json";
            const pitchMapPath = path.join(songDir, pitchMapFile);
            if (fs.existsSync(pitchMapPath)) {
              const parsedPm = JSON.parse(fs.readFileSync(pitchMapPath, "utf-8"));
              if (parsedPm?.mode === "heuristic") {
                pitchMapMode = "heuristic";
              }
            }
          } catch {
            // Mantém "reference" se não conseguir ler pitch_map.json
          }

          const { compatibility, lyricsSummary } = compatibilityService.evaluatePostAnalysis(
            manifest,
            lyricsData,
            { pitchMapMode }
          );

          manifest.compatibility = compatibility;
          manifest.lyrics = {
            ...(manifest.lyrics || {}),
            ...lyricsSummary,
          };
        }
      }

      // 3. Atualização de offset de latência de microfone por dispositivo (latency_offsets_ms)
      if (rawLatencyOffsets && typeof rawLatencyOffsets === "object") {
        manifest.user = {
          latency_offsets_ms: {},
          last_played: null,
          ...(manifest.user || {}),
          latency_offsets_ms: {
            ...(manifest.user?.latency_offsets_ms || {}),
            ...rawLatencyOffsets,
          },
        };
      }

      const savedManifest = cacheManager.writeManifestAtomic(videoId, manifest, {
        isJobActive: false,
      });

      return res.json({
        manifest: savedManifest,
        lyrics: lyricsData,
      });
    } catch (err) {
      return next(err);
    }
  });

  // Remove uma música do cache local (Biblioteca - T4.1)
  router.delete("/:id", (req, res, next) => {
    try {
      const videoId = req.params.id;
      if (!validateVideoId(videoId)) {
        throw new AppError(400, "INVALID_VIDEO_ID", "Identificador de vídeo inválido.");
      }

      if (jobQueue.hasActiveJob(videoId)) {
        throw new AppError(
          409,
          "JOB_ACTIVE",
          "Não é possível excluir a música enquanto ela está sendo processada."
        );
      }

      const manifestPath = safeResolveCachePath(cacheManager.cacheRoot, videoId, "manifest.json");
      const songDir = path.dirname(manifestPath);

      if (!fs.existsSync(songDir)) {
        throw new AppError(404, "SONG_NOT_FOUND", "Música não encontrada no cache.");
      }

      fs.rmSync(songDir, { recursive: true, force: true });

      return res.json({
        deleted: true,
        videoId,
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}