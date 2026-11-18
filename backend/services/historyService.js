/**
 * Serviço de histórico de partidas, rankings locais e exportação CSV/TXT
 * (FRONTEND_ARCHITECTURE.md §4.3-4.5 e CONTRACTS.md §5.2, §9).
 */

import path from "node:path";
import { createAtomicJsonStore } from "../utils/atomicJsonStore.js";
import { DATA_DIR } from "../utils/configLoader.js";
import { AppError } from "../utils/errors.js";
import { validateVideoId } from "../utils/security.js";
import { sanitizePlayerName } from "./playerService.js";

const SCHEMA_VERSION = 1;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_DIFFICULTIES = new Set(["easy", "normal", "hard"]);
const VALID_COMPAT_LEVELS = new Set(["excellent", "good", "regular", "low", "incompatible"]);
const VALID_CONFIDENCES = new Set(["high", "low"]);
const VALID_MIC_QUALITIES = new Set(["good", "acceptable", "poor"]);

const DIFFICULTY_LABELS_PT = {
  easy: "fácil",
  normal: "normal",
  hard: "difícil",
};

const DIFFICULTY_TITLE_PT = {
  easy: "Fácil",
  normal: "Normal",
  hard: "Difícil",
};

const COMPAT_LABELS_PT = {
  excellent: "Excelente",
  good: "Boa",
  regular: "Regular",
  low: "Baixa",
  incompatible: "Incompatível",
};

const DIFFICULTY_RANK_WEIGHT = {
  hard: 3,
  normal: 2,
  easy: 1,
};

/**
 * Valida e normaliza uma entrada de histórico conforme CONTRACTS.md §9.1.
 */
export function validateHistoryEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Payload de histórico inválido.");
  }

  // id: UUID gerado no cliente
  if (typeof raw.id !== "string" || !UUID_REGEX.test(raw.id.trim())) {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'id' deve ser um UUID válido.");
  }
  const id = raw.id.trim();

  // player_id: string ou null
  const playerId = raw.player_id === undefined ? null : raw.player_id;
  if (playerId !== null && (typeof playerId !== "string" || !playerId.trim() || playerId.length > 64)) {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'player_id' inválido.");
  }

  // player_name: 1..30 caracteres
  const playerName = sanitizePlayerName(raw.player_name);

  // mode: "standard"
  if (raw.mode !== "standard") {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'mode' deve ser 'standard'.");
  }

  // session_id: null
  const sessionId = raw.session_id === undefined ? null : raw.session_id;
  if (sessionId !== null) {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'session_id' deve ser null.");
  }

  // video_id
  if (!validateVideoId(raw.video_id)) {
    throw new AppError(400, "INVALID_VIDEO_ID", "Identificador de vídeo inválido.");
  }

  // song_title e artist
  if (
    typeof raw.song_title !== "string" ||
    raw.song_title.trim().length < 1 ||
    raw.song_title.length > 200
  ) {
    throw new AppError(
      400,
      "INVALID_HISTORY_ENTRY",
      "Campo 'song_title' deve ter entre 1 e 200 caracteres."
    );
  }
  const songTitle = raw.song_title.trim();

  const artistRaw = raw.artist === undefined ? "" : raw.artist;
  if (typeof artistRaw !== "string" || artistRaw.length > 200) {
    throw new AppError(
      400,
      "INVALID_HISTORY_ENTRY",
      "Campo 'artist' deve ser um texto de até 200 caracteres."
    );
  }
  const artist = artistRaw.trim();

  // played_at: ISO 8601
  if (typeof raw.played_at !== "string" || Number.isNaN(Date.parse(raw.played_at))) {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'played_at' deve ser uma data ISO 8601.");
  }

  // duration_s >= 0
  if (typeof raw.duration_s !== "number" || !Number.isFinite(raw.duration_s) || raw.duration_s < 0) {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'duration_s' deve ser >= 0.");
  }

  // score: 0.0 .. 10.0
  if (
    typeof raw.score !== "number" ||
    !Number.isFinite(raw.score) ||
    raw.score < 0 ||
    raw.score > 10
  ) {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'score' deve estar entre 0.0 e 10.0.");
  }
  const score = Math.round(raw.score * 10) / 10;

  // completed: boolean
  if (typeof raw.completed !== "boolean") {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'completed' deve ser booleano.");
  }

  // difficulty
  if (!VALID_DIFFICULTIES.has(raw.difficulty)) {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'difficulty' inválido.");
  }

  // compatibility_level
  if (!VALID_COMPAT_LEVELS.has(raw.compatibility_level)) {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'compatibility_level' inválido.");
  }

  // scoring_confidence
  if (!VALID_CONFIDENCES.has(raw.scoring_confidence)) {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'scoring_confidence' inválido.");
  }

  // mic_quality: 'good' | 'acceptable' | 'poor' | null
  const micQuality = raw.mic_quality === undefined ? null : raw.mic_quality;
  if (micQuality !== null && !VALID_MIC_QUALITIES.has(micQuality)) {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'mic_quality' inválido.");
  }

  // assists: { auto_transpose: boolean, guide_volume: 0..1 }
  if (!raw.assists || typeof raw.assists !== "object") {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'assists' obrigatório.");
  }
  if (
    typeof raw.assists.auto_transpose !== "boolean" ||
    typeof raw.assists.guide_volume !== "number" ||
    !Number.isFinite(raw.assists.guide_volume) ||
    raw.assists.guide_volume < 0 ||
    raw.assists.guide_volume > 1
  ) {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Valores de 'assists' inválidos.");
  }

  // details: { best_streak: int >= 0, coverage: 0..1, segments?: number[] }
  if (!raw.details || typeof raw.details !== "object") {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'details' obrigatório.");
  }
  const { best_streak: bestStreak, coverage, segments } = raw.details;
  if (
    !Number.isInteger(bestStreak) ||
    bestStreak < 0 ||
    typeof coverage !== "number" ||
    !Number.isFinite(coverage) ||
    coverage < 0 ||
    coverage > 1
  ) {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Valores de 'details' inválidos.");
  }
  if (segments !== undefined) {
    if (
      !Array.isArray(segments) ||
      segments.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)
    ) {
      throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'details.segments' inválido.");
    }
  }

  // scoring_version e app_version
  if (!Number.isInteger(raw.scoring_version) || raw.scoring_version < 1) {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'scoring_version' inválido.");
  }
  if (
    typeof raw.app_version !== "string" ||
    raw.app_version.trim().length < 1 ||
    raw.app_version.length > 50
  ) {
    throw new AppError(400, "INVALID_HISTORY_ENTRY", "Campo 'app_version' inválido.");
  }

  const normalizedDetails = {
    best_streak: bestStreak,
    coverage,
  };
  if (segments !== undefined) {
    normalizedDetails.segments = segments;
  }

  return {
    id,
    player_id: playerId,
    player_name: playerName,
    mode: "standard",
    session_id: null,
    video_id: raw.video_id,
    song_title: songTitle,
    artist,
    played_at: raw.played_at,
    duration_s: raw.duration_s,
    score,
    completed: raw.completed,
    difficulty: raw.difficulty,
    compatibility_level: raw.compatibility_level,
    scoring_confidence: raw.scoring_confidence,
    mic_quality: micQuality,
    assists: {
      auto_transpose: raw.assists.auto_transpose,
      guide_volume: raw.assists.guide_volume,
    },
    details: normalizedDetails,
    scoring_version: raw.scoring_version,
    app_version: raw.app_version.trim(),
  };
}

/**
 * Escapa um campo CSV conforme RFC 4180 (aspas duplas quando contém separador, aspas ou quebra de linha).
 */
function escapeCsvCell(value, separator) {
  const str = String(value ?? "");
  if (
    str.includes(separator) ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r")
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Formata data ISO para exibição curta no relatório TXT (YYYY-MM-DD HH:MM).
 */
function formatShortDateTime(isoString) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(isoString || ""));
  if (match) {
    return `${match[1]} ${match[2]}`;
  }
  return String(isoString || "");
}

export function createHistoryService(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? DATA_DIR);
  const filePath = path.join(dataDir, "history.json");

  const store = createAtomicJsonStore({
    filePath,
    createInitialData: () => ({
      schema_version: SCHEMA_VERSION,
      entries: [],
    }),
    validateData: (parsed) =>
      parsed.schema_version === SCHEMA_VERSION && Array.isArray(parsed.entries),
    onCorruption: options.onCorruption,
  });

  /**
   * Grava uma entrada no histórico de forma idempotente pelo campo `id`.
   * Retorna `{ entry, created: true }` para novo registro (201) ou `{ entry, created: false }` se já existir (200).
   */
  async function addEntry(rawEntry) {
    const validated = validateHistoryEntry(rawEntry);

    return store.update((data) => {
      const existing = data.entries.find((item) => item.id === validated.id);
      if (existing) {
        return {
          data,
          result: { entry: existing, created: false },
        };
      }

      data.entries.push(validated);
      return {
        data,
        result: { entry: validated, created: true },
      };
    });
  }

  /**
   * Consulta entradas do histórico com filtros opcionais e ordenação decrescente por `played_at`.
   */
  async function listEntries({
    playerId = "",
    videoId = "",
    difficulty = "",
    from = "",
    to = "",
    limit = null,
  } = {}) {
    const data = await store.read();
    let list = [...data.entries];

    if (playerId) {
      if (playerId === "guest") {
        list = list.filter((e) => e.player_id === null);
      } else {
        list = list.filter((e) => e.player_id === playerId);
      }
    }

    if (videoId) {
      if (!validateVideoId(videoId)) {
        throw new AppError(400, "INVALID_VIDEO_ID", "Identificador de vídeo inválido.");
      }
      list = list.filter((e) => e.video_id === videoId);
    }

    if (difficulty) {
      if (!VALID_DIFFICULTIES.has(difficulty)) {
        throw new AppError(400, "INVALID_FILTER", "Filtro de dificuldade inválido.");
      }
      list = list.filter((e) => e.difficulty === difficulty);
    }

    if (from) {
      const fromMs = Date.parse(from);
      if (Number.isNaN(fromMs)) {
        throw new AppError(400, "INVALID_DATE", "Parâmetro 'from' inválido.");
      }
      list = list.filter((e) => Date.parse(e.played_at) >= fromMs);
    }

    if (to) {
      const normalizedTo = /^\d{4}-\d{2}-\d{2}$/.test(to.trim())
        ? `${to.trim()}T23:59:59.999Z`
        : to;
      const toMs = Date.parse(normalizedTo);
      if (Number.isNaN(toMs)) {
        throw new AppError(400, "INVALID_DATE", "Parâmetro 'to' inválido.");
      }
      list = list.filter((e) => Date.parse(e.played_at) <= toMs);
    }

    // Mais recentes primeiro
    list.sort((a, b) => Date.parse(b.played_at) - Date.parse(a.played_at));

    if (limit !== null && limit !== undefined && limit !== "") {
      const parsedLimit = Number.parseInt(limit, 10);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
        throw new AppError(400, "INVALID_LIMIT", "Parâmetro 'limit' deve ser um inteiro positivo.");
      }
      list = list.slice(0, parsedLimit);
    }

    return list;
  }

  async function getEntryById(entryId) {
    const data = await store.read();
    return data.entries.find((item) => item.id === entryId) ?? null;
  }

  async function deleteEntryById(entryId) {
    return store.update((data) => {
      const index = data.entries.findIndex((item) => item.id === entryId);
      if (index === -1) {
        throw new AppError(404, "ENTRY_NOT_FOUND", "Registro de histórico não encontrado.");
      }
      data.entries.splice(index, 1);
      return { deleted: true };
    });
  }

  /**
   * Apaga entradas de um jogador específico ou todo o histórico (exigindo `confirm === "all"`).
   */
  async function deleteEntries({ playerId = "", confirm = "" } = {}) {
    if (!playerId && confirm !== "all") {
      throw new AppError(
        400,
        "CONFIRMATION_REQUIRED",
        "Para apagar todo o histórico, informe confirm=all."
      );
    }

    return store.update((data) => {
      const before = data.entries.length;
      if (playerId) {
        data.entries = data.entries.filter((item) => item.player_id !== playerId);
      } else {
        data.entries = [];
      }
      const deletedCount = before - data.entries.length;
      return { deleted: true, deletedCount };
    });
  }

  /**
   * Atualiza ou remove registros quando um perfil de jogador é excluído (`keep` ou `delete`).
   */
  async function onPlayerDeleted(playerId, mode = "keep") {
    return store.update((data) => {
      if (mode === "delete") {
        data.entries = data.entries.filter((item) => item.player_id !== playerId);
      } else {
        for (const item of data.entries) {
          if (item.player_id === playerId) {
            item.player_id = null;
          }
        }
      }
    });
  }

  /**
   * Calcula o ranking local por música (melhor nota concluída por jogador, ordem decrescente).
   */
  async function getRankings(videoId) {
    if (!validateVideoId(videoId)) {
      throw new AppError(400, "INVALID_VIDEO_ID", "Identificador de vídeo inválido.");
    }

    const data = await store.read();
    const songEntries = data.entries.filter(
      (item) => item.video_id === videoId && item.completed === true
    );

    const bestByPlayer = new Map();
    for (const entry of songEntries) {
      const key = entry.player_id ?? `guest:${entry.player_name.toLocaleLowerCase("pt-BR")}`;
      const currentBest = bestByPlayer.get(key);

      if (!currentBest) {
        bestByPlayer.set(key, entry);
        continue;
      }

      const isHigherScore = entry.score > currentBest.score;
      const isSameScoreHarder =
        entry.score === currentBest.score &&
        (DIFFICULTY_RANK_WEIGHT[entry.difficulty] ?? 0) >
          (DIFFICULTY_RANK_WEIGHT[currentBest.difficulty] ?? 0);

      if (isHigherScore || isSameScoreHarder) {
        bestByPlayer.set(key, entry);
      }
    }

    const entries = [...bestByPlayer.values()]
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const diffWeightA = DIFFICULTY_RANK_WEIGHT[a.difficulty] ?? 0;
        const diffWeightB = DIFFICULTY_RANK_WEIGHT[b.difficulty] ?? 0;
        if (diffWeightB !== diffWeightA) return diffWeightB - diffWeightA;
        return Date.parse(b.played_at) - Date.parse(a.played_at);
      })
      .map((item) => ({
        player_id: item.player_id,
        player_name: item.player_name,
        best_score: item.score,
        difficulty: item.difficulty,
        played_at: item.played_at,
      }));

    return {
      video_id: videoId,
      entries,
    };
  }

  /**
   * Gera exportação do histórico em CSV (CONTRACTS.md §9.2) ou TXT (CONTRACTS.md §9.3).
   */
  async function exportHistory({
    format = "csv",
    playerId = "",
    bom = "0",
    sep = ";",
    decimal = "comma",
  } = {}) {
    if (format !== "csv" && format !== "txt") {
      throw new AppError(400, "INVALID_EXPORT_FORMAT", "Formato deve ser 'csv' ou 'txt'.");
    }

    const entries = await listEntries({ playerId });

    if (format === "csv") {
      if (sep !== ";" && sep !== ",") {
        throw new AppError(400, "INVALID_CSV_SEPARATOR", "Separador CSV deve ser ';' ou ','.");
      }
      if (decimal !== "comma" && decimal !== "dot") {
        throw new AppError(400, "INVALID_DECIMAL_FORMAT", "Formato decimal deve ser 'comma' ou 'dot'.");
      }

      const header = [
        "data_hora",
        "jogador",
        "modo",
        "musica",
        "artista",
        "nota",
        "dificuldade",
        "compatibilidade",
        "concluida",
      ].join(sep);

      const lines = [header];
      for (const item of entries) {
        const formattedScore =
          decimal === "comma"
            ? item.score.toFixed(1).replace(".", ",")
            : item.score.toFixed(1);

        const row = [
          item.played_at,
          item.player_name,
          item.mode,
          item.song_title,
          item.artist,
          formattedScore,
          DIFFICULTY_LABELS_PT[item.difficulty] ?? item.difficulty,
          COMPAT_LABELS_PT[item.compatibility_level] ?? item.compatibility_level,
          item.completed ? "sim" : "não",
        ].map((cell) => escapeCsvCell(cell, sep));

        lines.push(row.join(sep));
      }

      const includeBom = bom === "1" || bom === "true" || bom === true;
      const body = `${includeBom ? "\uFEFF" : ""}${lines.join("\r\n")}\r\n`;

      return {
        contentType: "text/csv; charset=utf-8",
        filename: "historico-karaoke.csv",
        content: body,
      };
    }

    // Formato TXT: relatório legível agrupado por jogador (CONTRACTS.md §9.3)
    const grouped = new Map();
    for (const item of entries) {
      const groupKey = item.player_name;
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, []);
      }
      grouped.get(groupKey).push(item);
    }

    const sections = [];
    if (grouped.size === 0) {
      sections.push("Nenhuma partida registrada no histórico.");
    } else {
      for (const [playerName, playerEntries] of grouped.entries()) {
        const block = [`=== ${playerName} ===`];
        for (const item of playerEntries) {
          const songLabel = item.artist
            ? `${item.song_title} — ${item.artist}`
            : item.song_title;
          const scoreLabel = item.score.toFixed(1).replace(".", ",");
          const diffLabel = DIFFICULTY_TITLE_PT[item.difficulty] ?? item.difficulty;
          const compatLabel = COMPAT_LABELS_PT[item.compatibility_level] ?? item.compatibility_level;
          const statusLabel = item.completed ? "concluída" : "não concluída";

          block.push(
            `${formatShortDateTime(item.played_at)} | ${songLabel} | ${scoreLabel} | ${diffLabel} | Compat.: ${compatLabel} | ${statusLabel}`
          );
        }
        sections.push(block.join("\n"));
      }
    }

    return {
      contentType: "text/plain; charset=utf-8",
      filename: "historico-karaoke.txt",
      content: `${sections.join("\n\n")}\n`,
    };
  }

  return {
    store,
    addEntry,
    listEntries,
    getEntryById,
    deleteEntryById,
    deleteEntries,
    onPlayerDeleted,
    getRankings,
    exportHistory,
  };
}