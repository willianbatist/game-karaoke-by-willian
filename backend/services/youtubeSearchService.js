/**
 * Serviço de busca no YouTube via yt-dlp local (Fase 4 - T4.1).
 * Executa apenas consulta de metadados (--flat-playlist --dump-single-json), sem download.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../utils/errors.js";
import { validateVideoId } from "../utils/security.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

function resolveYtDlpCommand() {
  if (process.env.YTDLP_BIN && fs.existsSync(process.env.YTDLP_BIN)) {
    return { bin: process.env.YTDLP_BIN, prefixArgs: [] };
  }

  const isWin = process.platform === "win32";
  const venvYtDlp = isWin
    ? path.join(PROJECT_ROOT, "worker", ".venv", "Scripts", "yt-dlp.exe")
    : path.join(PROJECT_ROOT, "worker", ".venv", "bin", "yt-dlp");

  if (fs.existsSync(venvYtDlp)) {
    return { bin: venvYtDlp, prefixArgs: [] };
  }

  const venvPython = isWin
    ? path.join(PROJECT_ROOT, "worker", ".venv", "Scripts", "python.exe")
    : path.join(PROJECT_ROOT, "worker", ".venv", "bin", "python");

  if (fs.existsSync(venvPython)) {
    return { bin: venvPython, prefixArgs: ["-m", "yt_dlp"] };
  }

  return { bin: "yt-dlp", prefixArgs: [] };
}

export function extractYouTubeVideoId(rawInput) {
  const value = String(rawInput || "").trim();
  if (validateVideoId(value)) {
    return value;
  }

  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.replace(/^\//, "").slice(0, 11);
      return validateVideoId(id) ? id : null;
    }
    if (url.hostname.endsWith("youtube.com")) {
      const vParam = url.searchParams.get("v");
      if (vParam && validateVideoId(vParam)) {
        return vParam;
      }
      const match = /^\/(?:embed|shorts|v)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
      if (match && validateVideoId(match[1])) {
        return match[1];
      }
    }
  } catch {
    return null;
  }

  return null;
}

function pickBestThumbnail(entry, videoId) {
  if (Array.isArray(entry?.thumbnails) && entry.thumbnails.length > 0) {
    const sorted = [...entry.thumbnails]
      .filter((t) => typeof t?.url === "string" && t.url.startsWith("http"))
      .sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
    if (sorted.length > 0) {
      return sorted[0].url;
    }
  }
  if (typeof entry?.thumbnail === "string" && entry.thumbnail.startsWith("http")) {
    return entry.thumbnail;
  }
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function defaultExecRunner(bin, args, options) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: options?.timeoutMs ?? 15000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          return reject(error);
        }
        return resolve({ stdout, stderr });
      }
    );
  });
}

function isNetworkFailure(err) {
  const msg = `${err?.message || ""} ${err?.stderr || ""}`.toLowerCase();
  return (
    msg.includes("enotfound") ||
    msg.includes("eai_again") ||
    msg.includes("network is unreachable") ||
    msg.includes("failed to resolve") ||
    msg.includes("name or service not known") ||
    msg.includes("unable to download api page") ||
    msg.includes("connection refused") ||
    msg.includes("timed out")
  );
}

export function createYoutubeSearchService({ cacheManager, execRunner = defaultExecRunner } = {}) {
  const { bin, prefixArgs } = resolveYtDlpCommand();

  async function searchVideos(rawQuery, { limit = 10 } = {}) {
    const query = String(rawQuery || "").trim();
    if (!query) {
      throw new AppError(400, "INVALID_SEARCH_QUERY", "Informe um termo ou link para buscar.");
    }
    if (query.length > 200) {
      throw new AppError(400, "INVALID_SEARCH_QUERY", "O termo de busca é muito longo.");
    }

    const safeLimit = Math.min(20, Math.max(1, Number.parseInt(limit, 10) || 10));
    const directId = extractYouTubeVideoId(query);
    const target = directId
      ? `https://www.youtube.com/watch?v=${directId}`
      : `ytsearch${safeLimit}:${query}`;

    const args = [
      ...prefixArgs,
      "--dump-single-json",
      "--flat-playlist",
      "--no-warnings",
      "--ignore-errors",
      "--skip-download",
      "--",
      target,
    ];

    let stdout = "";
    try {
      const res = await execRunner(bin, args, { timeoutMs: 15000 });
      stdout = res.stdout;
    } catch (err) {
      if (err?.killed || err?.code === "ETIMEDOUT") {
        throw new AppError(
          504,
          "SEARCH_TIMEOUT",
          "A busca no YouTube demorou demais. Tente novamente."
        );
      }
      if (isNetworkFailure(err)) {
        throw new AppError(
          503,
          "SEARCH_OFFLINE",
          "Não foi possível conectar ao YouTube. Verifique sua internet ou use a Biblioteca offline."
        );
      }
      throw new AppError(
        502,
        "SEARCH_FAILED",
        "Não foi possível concluir a busca no YouTube no momento."
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(String(stdout || "{}"));
    } catch {
      throw new AppError(502, "SEARCH_PARSE_ERROR", "Resposta inválida recebida da busca.");
    }

    const rawEntries = Array.isArray(parsed?.entries)
      ? parsed.entries
      : parsed?.id
        ? [parsed]
        : [];

    const results = [];
    const seenIds = new Set();

    for (const entry of rawEntries) {
      if (!entry || typeof entry !== "object") continue;
      const videoId = String(entry.id || "").trim();
      if (!validateVideoId(videoId) || seenIds.has(videoId)) continue;
      seenIds.add(videoId);

      const durationNum = Number(entry.duration);
      const duration = Number.isFinite(durationNum) && durationNum > 0 ? Math.round(durationNum) : null;

      results.push({
        videoId,
        title: String(entry.title || videoId).trim(),
        channel: String(entry.channel || entry.uploader || entry.uploader_id || "").trim(),
        duration,
        isLive: Boolean(entry.is_live || entry.live_status === "is_live"),
        thumbnail: pickBestThumbnail(entry, videoId),
        url: `https://www.youtube.com/watch?v=${videoId}`,
        isCached: cacheManager ? Boolean(cacheManager.isSongReady(videoId)) : false,
      });

      if (results.length >= safeLimit) break;
    }

    return results;
  }

  return {
    searchVideos,
  };
}