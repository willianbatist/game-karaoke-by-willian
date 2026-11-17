/**
 * Gerenciador do cache local de músicas (ARCHITECTURE.md §13.6 e CONTRACTS.md §4).
 * Responsável por validação de manifest.json, escritas atômicas do Node,
 * reidratação na inicialização e limpeza LRU.
 */

import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "../utils/configLoader.js";
import { AppError } from "../utils/errors.js";
import { validateVideoId } from "../utils/security.js";

const EXPECTED_SCHEMA_VERSION = 1;

/**
 * Soma recursivamente o tamanho em bytes de um diretório.
 */
function computeDirectorySizeBytes(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;

  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += computeDirectorySizeBytes(fullPath);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(fullPath).size;
      } catch {
        // Ignora arquivo removido concorrentemente
      }
    }
  }
  return total;
}

export function createCacheManager(options = {}) {
  const cacheRoot = path.resolve(options.cacheRoot ?? CACHE_DIR);
  const maxSizeGb = Number(options.maxSizeGb ?? 10);

  fs.mkdirSync(cacheRoot, { recursive: true });

  function getSongDir(videoId) {
    if (!validateVideoId(videoId)) {
      throw new AppError(400, "INVALID_VIDEO_ID", "Identificador de vídeo inválido.");
    }
    return path.join(cacheRoot, videoId);
  }

  function ensureSongDir(videoId) {
    const dir = getSongDir(videoId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function readManifest(videoId) {
    const manifestPath = path.join(getSongDir(videoId), "manifest.json");
    if (!fs.existsSync(manifestPath)) return null;

    try {
      const raw = fs.readFileSync(manifestPath, "utf-8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Grava manifest.json de forma atômica (.tmp + rename), respeitando a regra de
   * nunca escrever enquanto houver job ativo para o videoId (CONTRACTS.md §4.2).
   */
  function writeManifestAtomic(videoId, manifest, { isJobActive = false } = {}) {
    if (isJobActive) {
      throw new AppError(
        409,
        "JOB_ACTIVE",
        "Não é permitido alterar o manifest enquanto há um job ativo."
      );
    }

    const dir = ensureSongDir(videoId);
    const targetPath = path.join(dir, "manifest.json");
    const tmpPath = path.join(dir, `manifest.json.${process.pid}.tmp`);

    fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    fs.renameSync(tmpPath, targetPath);
    return manifest;
  }

  /**
   * Verifica se uma música está íntegra e pronta no cache.
   */
  function isSongReady(videoId) {
    const manifest = readManifest(videoId);
    if (!manifest) return false;
    if (manifest.schema_version !== EXPECTED_SCHEMA_VERSION) return false;
    if (manifest.status !== "ready") return false;

    const dir = getSongDir(videoId);
    const files = manifest.files || {};
    const requiredNames = [
      files.instrumental || "instrumental.flac",
      files.vocals || "vocals.flac",
      files.pitch_map || "pitch_map.json",
    ];

    for (const fileName of requiredNames) {
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) return false;
      try {
        if (fs.statSync(filePath).size <= 0) return false;
      } catch {
        return false;
      }
    }

    return true;
  }

  function readLyrics(videoId) {
    const lyricsPath = path.join(getSongDir(videoId), "lyrics.json");
    if (!fs.existsSync(lyricsPath)) return null;

    try {
      return JSON.parse(fs.readFileSync(lyricsPath, "utf-8"));
    } catch {
      return null;
    }
  }

  /**
   * Atualiza user.last_played quando o jogador abre a música (CONTRACTS.md §4.2).
   */
  function touchLastPlayed(videoId, { isJobActive = false } = {}) {
    if (isJobActive || !isSongReady(videoId)) return null;

    const manifest = readManifest(videoId);
    if (!manifest) return null;

    manifest.user = {
      latency_offsets_ms: {},
      ...(manifest.user || {}),
      last_played: new Date().toISOString(),
    };

    return writeManifestAtomic(videoId, manifest, { isJobActive: false });
  }

  /**
   * Reidrata músicas prontas ao iniciar o servidor e executa pós-processamento
   * idempotente se faltar algum bloco de responsabilidade do Node (CONTRACTS.md §4.2 item 4).
   */
  async function rehydrate({ hasActiveJob = () => false, onNeedsPostProcess = null } = {}) {
    if (!fs.existsSync(cacheRoot)) return [];

    const readyIds = [];
    for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const videoId = entry.name;
      if (!validateVideoId(videoId)) continue;

      if (!isSongReady(videoId)) continue;

      const manifest = readManifest(videoId);
      const missingNodeBlocks =
        !manifest.lyrics || !manifest.user || !manifest.compatibility;

      if (
        missingNodeBlocks &&
        typeof onNeedsPostProcess === "function" &&
        !hasActiveJob(videoId)
      ) {
        await onNeedsPostProcess(videoId);
      }

      readyIds.push(videoId);
    }

    return readyIds;
  }

  function getTotalCacheBytes() {
    return computeDirectorySizeBytes(cacheRoot);
  }

  function getSongSizeBytes(videoId) {
    return computeDirectorySizeBytes(getSongDir(videoId));
  }

  /**
   * Política LRU (ARCHITECTURE.md §13.6): remove pastas mais antigas se ultrapassar o limite.
   */
  function enforceLru({
    hasActiveJob = () => false,
    maxBytes = maxSizeGb * 1024 * 1024 * 1024,
  } = {}) {
    let totalBytes = getTotalCacheBytes();
    const removed = [];

    if (totalBytes <= maxBytes || !fs.existsSync(cacheRoot)) {
      return { removed, totalBytes };
    }

    const candidates = [];
    for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const videoId = entry.name;
      if (!validateVideoId(videoId)) continue;
      if (hasActiveJob(videoId)) continue;

      const dir = path.join(cacheRoot, videoId);
      const manifest = readManifest(videoId);
      const lastPlayedRaw = manifest?.user?.last_played;
      const parsedLastPlayed = lastPlayedRaw ? Date.parse(lastPlayedRaw) : NaN;

      let timestampMs = parsedLastPlayed;
      if (!Number.isFinite(timestampMs)) {
        try {
          timestampMs = fs.statSync(dir).mtimeMs;
        } catch {
          timestampMs = 0;
        }
      }

      candidates.push({
        videoId,
        dir,
        timestampMs,
        sizeBytes: computeDirectorySizeBytes(dir),
      });
    }

    // Ordena do mais antigo para o mais recente
    candidates.sort((a, b) => a.timestampMs - b.timestampMs);

    for (const item of candidates) {
      if (totalBytes <= maxBytes) break;
      fs.rmSync(item.dir, { recursive: true, force: true });
      totalBytes = Math.max(0, totalBytes - item.sizeBytes);
      removed.push(item.videoId);
    }

    return { removed, totalBytes };
  }

  return {
    cacheRoot,
    getSongDir,
    ensureSongDir,
    readManifest,
    writeManifestAtomic,
    isSongReady,
    readLyrics,
    touchLastPlayed,
    rehydrate,
    getTotalCacheBytes,
    getSongSizeBytes,
    enforceLru,
  };
}