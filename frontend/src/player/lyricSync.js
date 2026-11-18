/**
 * Sincronizador de letras (.lrc) e modos de fallback (ARCHITECTURE.md §6.A e §7).
 * Suporta:
 * - "synced": linhas com timestamps [mm:ss.xx] / [mm:ss.xxx] e ajuste fino `offset_ms`.
 * - "plain": letra corrida sem timestamps (exibição estática/rolagem manual).
 * - "none": sem letra disponível (modo instrumental).
 */

const TIMESTAMP_REGEX = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const LRC_OFFSET_TAG_REGEX = /^\[offset:\s*([+-]?\d+)\s*\]$/i;
const INSTRUMENTAL_ONLY_LINE_REGEX = /^[♪♫♩♬\s-]*$/;

/**
 * Converte texto no formato LRC em uma lista ordenada de linhas `{ time, text }`.
 */
export function parseLrc(lrcText) {
  if (typeof lrcText !== "string" || lrcText.trim() === "") {
    return { lines: [], embeddedOffsetMs: 0 };
  }

  const lines = [];
  let embeddedOffsetMs = 0;

  for (const rawLine of lrcText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Lê tag opcional [offset:+/-ms] dentro do próprio LRC
    const offsetMatch = LRC_OFFSET_TAG_REGEX.exec(trimmed);
    if (offsetMatch) {
      embeddedOffsetMs = Number.parseInt(offsetMatch[1], 10) || 0;
      continue;
    }

    const timestamps = [];
    TIMESTAMP_REGEX.lastIndex = 0;
    let match;
    while ((match = TIMESTAMP_REGEX.exec(trimmed)) !== null) {
      const minutes = Number.parseInt(match[1], 10);
      const seconds = Number.parseInt(match[2], 10);
      const fracRaw = match[3] || "0";
      const fracSeconds =
        fracRaw.length === 3
          ? Number.parseInt(fracRaw, 10) / 1000
          : fracRaw.length === 2
            ? Number.parseInt(fracRaw, 10) / 100
            : Number.parseInt(fracRaw, 10) / 10;

      timestamps.push(minutes * 60 + seconds + fracSeconds);
    }

    // Ignora tags de metadados como [ar:Artista], [ti:Título], [al:Álbum]
    if (timestamps.length === 0) continue;

    const cleanText = trimmed.replace(TIMESTAMP_REGEX, "").trim();
    for (const time of timestamps) {
      lines.push({
        time,
        text: cleanText || "♪",
      });
    }
  }

  lines.sort((a, b) => a.time - b.time);
  return { lines, embeddedOffsetMs };
}

/**
 * Converte letra corrida (`plainLyrics`) em lista de linhas sem timestamp.
 */
export function parsePlainLyrics(plainText) {
  if (typeof plainText !== "string" || plainText.trim() === "") {
    return [];
  }
  return plainText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => ({ time: null, text }));
}

export function createLyricSync(options = {}) {
  let mode = "none"; // "synced" | "plain" | "none"
  let lines = [];
  let offsetMs = Number(options.offsetMs ?? 0) || 0;
  let embeddedOffsetMs = 0;
  let activeCandidateId = null;

  /**
   * Carrega um candidato específico do LRCLIB (com `syncedLyrics` e/ou `plainLyrics`).
   */
  function loadCandidate(candidate, { customOffsetMs } = {}) {
    if (customOffsetMs !== undefined) {
      offsetMs = Number(customOffsetMs) || 0;
    }

    if (!candidate || typeof candidate !== "object") {
      mode = "none";
      lines = [];
      embeddedOffsetMs = 0;
      activeCandidateId = null;
      return getMetadata();
    }

    activeCandidateId = candidate.id ?? null;

    if (typeof candidate.syncedLyrics === "string" && candidate.syncedLyrics.trim() !== "") {
      const parsed = parseLrc(candidate.syncedLyrics);
      if (parsed.lines.length > 0) {
        mode = "synced";
        lines = parsed.lines;
        embeddedOffsetMs = parsed.embeddedOffsetMs;
        return getMetadata();
      }
    }

    if (typeof candidate.plainLyrics === "string" && candidate.plainLyrics.trim() !== "") {
      const plainLines = parsePlainLyrics(candidate.plainLyrics);
      if (plainLines.length > 0) {
        mode = "plain";
        lines = plainLines;
        embeddedOffsetMs = 0;
        return getMetadata();
      }
    }

    mode = "none";
    lines = [];
    embeddedOffsetMs = 0;
    return getMetadata();
  }

  /**
   * Carrega diretamente a partir dos objetos `lyrics` e `manifest` retornados por `GET /api/songs/:id`.
   */
  function loadFromSongData(lyricsData, manifestLyrics = {}) {
    const savedOffset = Number(manifestLyrics?.offset_ms ?? 0) || 0;
    if (!lyricsData || !Array.isArray(lyricsData.candidates)) {
      return loadCandidate(null, { customOffsetMs: savedOffset });
    }

    const selectedId = manifestLyrics?.selected_id ?? lyricsData.selected_id;
    const chosen =
      lyricsData.candidates.find((c) => c.id === selectedId) ??
      lyricsData.candidates[0] ??
      null;

    return loadCandidate(chosen, { customOffsetMs: savedOffset });
  }

  function setOffsetMs(nextOffsetMs) {
    offsetMs = Math.round(Number(nextOffsetMs) || 0);
    return offsetMs;
  }

  function getOffsetMs() {
    return offsetMs;
  }

  function getMetadata() {
    return {
      mode,
      lineCount: lines.length,
      offsetMs,
      activeCandidateId,
    };
  }

  function getAllLines() {
    return lines;
  }

  /**
   * Gera as janelas temporais ativas de canto a partir da letra sincronizada (.lrc).
   * Fora dessas janelas (introduções, solos e pausas), o motor não cobra afinação.
   */
  function getLyricWindows({
    paddingSeconds = 0.5,
    maxLineDurationSeconds = 8.0,
    songDurationSeconds = null,
  } = {}) {
    if (mode !== "synced" || lines.length === 0) {
      return [];
    }

    const totalOffsetSec = (offsetMs + embeddedOffsetMs) / 1000;
    const pad = Math.max(0, Number(paddingSeconds) || 0);
    const maxDur = Math.max(1, Number(maxLineDurationSeconds) || 8.0);
    const songDur =
      Number.isFinite(Number(songDurationSeconds)) && Number(songDurationSeconds) > 0
        ? Number(songDurationSeconds)
        : null;

    const windows = [];

    for (let i = 0; i < lines.length; i += 1) {
      const current = lines[i];
      // Ignora linhas marcadas apenas como pausa instrumental ("♪")
      if (INSTRUMENTAL_ONLY_LINE_REGEX.test(current.text)) {
        continue;
      }

      const rawStart = current.time - totalOffsetSec;
      const next = lines[i + 1] || null;
      const nextRawStart = next
        ? next.time - totalOffsetSec
        : songDur !== null
          ? Math.min(songDur, rawStart + maxDur)
          : rawStart + maxDur;

      const rawEnd = Math.max(rawStart + 0.4, Math.min(nextRawStart, rawStart + maxDur));
      const start = Math.max(0, rawStart - pad);
      const end = songDur !== null ? Math.min(songDur, rawEnd + pad) : rawEnd + pad;

      if (end > start) {
        windows.push({
          lineIndex: i,
          text: current.text,
          start: Number(start.toFixed(3)),
          end: Number(end.toFixed(3)),
        });
      }
    }

    return windows;
  }

  /**
   * Calcula a linha ativa, a próxima linha e o progresso da linha atual para `audioTimeSeconds`.
   */
  function getStateAt(audioTimeSeconds) {
    if (mode !== "synced" || lines.length === 0) {
      return {
        mode,
        currentIndex: -1,
        currentLine: null,
        nextLine: null,
        lineProgress: 0,
        lines,
      };
    }

    // Offset positivo adianta a letra; negativo atrasa
    const totalOffsetSec = (offsetMs + embeddedOffsetMs) / 1000;
    const effectiveTime = (Number(audioTimeSeconds) || 0) + totalOffsetSec;

    // Busca binária pela última linha com `time <= effectiveTime`
    let low = 0;
    let high = lines.length - 1;
    let foundIndex = -1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (lines[mid].time <= effectiveTime) {
        foundIndex = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (foundIndex < 0) {
      return {
        mode,
        currentIndex: -1,
        currentLine: null,
        nextLine: lines[0] || null,
        lineProgress: 0,
        lines,
      };
    }

    const currentLine = lines[foundIndex];
    const nextLine = lines[foundIndex + 1] || null;

    let lineProgress = 1;
    if (nextLine && nextLine.time > currentLine.time) {
      const span = nextLine.time - currentLine.time;
      lineProgress = Math.min(1, Math.max(0, (effectiveTime - currentLine.time) / span));
    }

    return {
      mode,
      currentIndex: foundIndex,
      currentLine,
      nextLine,
      lineProgress,
      lines,
    };
  }

  return {
    loadCandidate,
    loadFromSongData,
    setOffsetMs,
    getOffsetMs,
    getMetadata,
    getAllLines,
    getLyricWindows,
    getStateAt,
  };
}