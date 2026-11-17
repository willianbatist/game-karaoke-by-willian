/**
 * Serviço de busca e normalização de letras via LRCLIB (ARCHITECTURE.md §6.A.1 e CONTRACTS.md §4.4).
 * - Limpa ruídos comuns de títulos do YouTube preservando marcadores de versão (live, acoustic, remix).
 * - Busca por artista + faixa e faz fallback para busca livre (`q`).
 * - Seleciona o candidato com menor diferença de duração em relação ao vídeo.
 * - Salva apenas `lyrics.json` de forma atômica (nunca escreve diretamente em `manifest.json`).
 */

import fs from "node:fs";
import path from "node:path";
import { loadDefaultConfig } from "../utils/configLoader.js";

const LRCLIB_SEARCH_URL = "https://lrclib.net/api/search";

/**
 * Extrai marcadores de versão (live, acoustic, remix) antes de limpar o título.
 */
function extractVersionMarkers(rawTitle) {
  const markers = [];
  if (/\b(ao\s+vivo|live)\b/i.test(rawTitle)) markers.push("live");
  if (/\b(ac[uú]stico|acoustic)\b/i.test(rawTitle)) markers.push("acoustic");
  if (/\b(remix)\b/i.test(rawTitle)) markers.push("remix");
  return markers;
}

/**
 * Remove ruídos comuns de nomes de faixa/artista vindos do YouTube.
 */
function stripNoiseTokens(text) {
  let cleaned = String(text || "");

  // Remove conteúdos entre parênteses e colchetes: (Clipe Oficial), [4K], (Ao Vivo), etc.
  cleaned = cleaned.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");

  // Remove trechos finais após separadores de metadados como `|` ou `//`
  cleaned = cleaned.replace(/\s*(?:\||\/\/).*$/g, " ");

  // Remove participações (feat. / ft.) para melhorar a busca exata no LRCLIB
  cleaned = cleaned.replace(/\b(?:feat|ft)\.?\s+[^-–—]+$/i, " ");

  // Remove sufixos comuns de vídeos musicais e gravações
  cleaned = cleaned.replace(
    /(?:\s*[-–—]\s*|\s+)(?:official\s+music\s+video|official\s+video|official\s+audio|clipe\s+oficial|v[ií]deo\s+oficial|[aá]udio\s+oficial|lyric\s+video|lyrics|letra|legendado|dvd\s+ao\s+vivo.*|ao\s+vivo.*|live.*|ac[uú]stico.*|acoustic.*|remastered|remasterizado|full\s+hd|4k|hd)\s*$/gi,
    " "
  );

  return cleaned.replace(/\s+/g, " ").trim();
}

/**
 * Limpa o nome do canal do YouTube para servir como fallback de artista (ex.: "Legião Urbana - Topic").
 */
function cleanChannelName(rawChannel) {
  return String(rawChannel || "")
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/\b(?:VEVO|Oficial|Official)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normaliza o título do YouTube separando `artist_name`, `track_name` e `version_markers`.
 */
export function normalizeYouTubeTitle(rawTitle, rawChannel = "") {
  const original = String(rawTitle || "").trim();
  const versionMarkers = extractVersionMarkers(original);

  // Separa por travessão ou hífen espaçado antes de remover sufixos internos
  const parts = original
    .split(/\s+[-–—]\s+/)
    .map((part) => stripNoiseTokens(part))
    .filter(Boolean);

  let artistName = "";
  let trackName = "";

  if (parts.length >= 2) {
    artistName = parts[0];
    trackName = parts[1];
  } else if (parts.length === 1) {
    trackName = parts[0];
    artistName = cleanChannelName(rawChannel);
  } else {
    trackName = stripNoiseTokens(original);
    artistName = cleanChannelName(rawChannel);
  }

  return {
    track_name: trackName,
    artist_name: artistName,
    version_markers: versionMarkers,
  };
}

/**
 * Escolhe o candidato do LRCLIB com menor diferença absoluta de duração em relação ao vídeo.
 * Em caso de empate na duração, prioriza candidatos com letra sincronizada (`syncedLyrics`).
 */
export function selectBestCandidate(candidates, videoDurationSeconds) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const validCandidates = candidates.filter(
    (item) => item && typeof item === "object" && item.id != null
  );
  if (validCandidates.length === 0) {
    return null;
  }

  const hasTargetDuration =
    typeof videoDurationSeconds === "number" &&
    Number.isFinite(videoDurationSeconds) &&
    videoDurationSeconds > 0;

  const ranked = [...validCandidates].sort((a, b) => {
    if (hasTargetDuration) {
      const durA = typeof a.duration === "number" && Number.isFinite(a.duration) ? a.duration : Infinity;
      const durB = typeof b.duration === "number" && Number.isFinite(b.duration) ? b.duration : Infinity;
      const diffA = Math.abs(durA - videoDurationSeconds);
      const diffB = Math.abs(durB - videoDurationSeconds);

      if (diffA !== diffB) {
        return diffA - diffB;
      }
    }

    // Desempate: prefere letra sincronizada, depois letra simples
    const scoreA = a.syncedLyrics ? 2 : a.plainLyrics ? 1 : 0;
    const scoreB = b.syncedLyrics ? 2 : b.plainLyrics ? 1 : 0;
    return scoreB - scoreA;
  });

  return ranked[0];
}

export function createLyricsService({
  cacheManager,
  config = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const effectiveConfig = config ?? loadDefaultConfig();
  const timeoutMs = Number(effectiveConfig.search?.lyrics_timeout_ms ?? 1500);

  async function queryLrclib(params) {
    const url = new URL(LRCLIB_SEARCH_URL);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
      const res = await fetchImpl(url.toString(), {
        headers: {
          Accept: "application/json",
          "User-Agent": "game-karaoke-by-willian/0.1.0 (localhost)",
        },
        signal: controller.signal,
      });

      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Busca candidatos no LRCLIB (tentando artista + faixa e depois busca livre `q`).
   */
  async function searchCandidates({ title, channel = "" }) {
    const normalized = normalizeYouTubeTitle(title, channel);
    let candidates = [];

    if (normalized.track_name && normalized.artist_name) {
      candidates = await queryLrclib({
        track_name: normalized.track_name,
        artist_name: normalized.artist_name,
      });
    }

    // Fallback: busca livre por `q` se a busca estruturada não trouxer resultados
    if (candidates.length === 0) {
      const freeQuery = [normalized.artist_name, normalized.track_name]
        .filter(Boolean)
        .join(" ")
        .trim();

      if (freeQuery) {
        candidates = await queryLrclib({ q: freeQuery });
      }
    }

    return {
      query: {
        track_name: normalized.track_name,
        artist_name: normalized.artist_name,
      },
      version_markers: normalized.version_markers,
      candidates,
    };
  }

  /**
   * Executa a busca de letra para um videoId, escolhe o melhor candidato por duração
   * e grava `backend/cache/<videoId>/lyrics.json` de forma atômica (CONTRACTS.md §4.4).
   */
  async function fetchAndSaveLyrics(videoId, metadata = {}) {
    const { title = "", channel = "", duration = null } = metadata;

    // Se já existe lyrics.json salvo anteriormente, reaproveita sem refazer requisição
    if (cacheManager) {
      const existing = cacheManager.readLyrics(videoId);
      if (existing && existing.schema_version === 1) {
        return existing;
      }
    }

    const { query, candidates } = await searchCandidates({ title, channel });
    const best = selectBestCandidate(candidates, duration);

    const payload = {
      schema_version: 1,
      query,
      candidates,
      selected_id: best ? best.id : null,
    };

    if (cacheManager) {
      const songDir = cacheManager.ensureSongDir(videoId);
      const targetPath = path.join(songDir, "lyrics.json");
      const tmpPath = path.join(songDir, `lyrics.json.${process.pid}.tmp`);
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
      fs.renameSync(tmpPath, targetPath);
    }

    return payload;
  }

  return {
    normalizeYouTubeTitle,
    selectBestCandidate,
    searchCandidates,
    fetchAndSaveLyrics,
  };
}