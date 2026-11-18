/**
 * Modo Karaokê Padrão (`standard`) — FRONTEND_ARCHITECTURE.md §3.1, §3.3 e T4.4.
 * Gerencia o ciclo da partida individual e grava o resultado no histórico local.
 */

import { historyClient } from "../../history/historyClient.js";

const VALID_DIFFICULTIES = new Set(["easy", "normal", "hard"]);
const VALID_COMPAT_LEVELS = new Set(["excellent", "good", "regular", "low", "incompatible"]);
const VALID_MIC_QUALITIES = new Set(["good", "acceptable", "poor"]);
const MIC_PROFILES_STORAGE_KEY = "karaoke.micProfiles.v1";

function generateEntryId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback RFC 4122 v4
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function clampNumber(value, min, max, fallback = min) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function readStoredMicQuality(micDeviceId = "") {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(MIC_PROFILES_STORAGE_KEY);
    if (!raw) return null;
    const profiles = JSON.parse(raw);
    if (!profiles || typeof profiles !== "object") return null;
    const key = micDeviceId || "default";
    const profile = profiles[key] || profiles.default || null;
    const verdict = profile?.verdict || profile?.quality || null;
    return VALID_MIC_QUALITIES.has(verdict) ? verdict : null;
  } catch {
    return null;
  }
}

export function buildStandardHistoryEntry(session, rawResult = {}) {
  const player = session?.player || { id: null, name: "Convidado", isGuest: true };
  const song = session?.song || {};
  const scoring = rawResult.summary || rawResult;

  const difficulty = VALID_DIFFICULTIES.has(session?.difficulty)
    ? session.difficulty
    : "normal";

  const compatLevel = VALID_COMPAT_LEVELS.has(song.compatibilityLevel)
    ? song.compatibilityLevel
    : "regular";

  const scoringConfidence = scoring.scoring_confidence === "high" ? "high" : "low";
  const micQuality = VALID_MIC_QUALITIES.has(rawResult.micQuality)
    ? rawResult.micQuality
    : readStoredMicQuality(rawResult.micDeviceId);

  const playerName =
    typeof player.name === "string" && player.name.trim().length > 0
      ? player.name.trim().slice(0, 30)
      : "Convidado";

  const finalScore = Number(clampNumber(scoring.score, 0, 10, 0).toFixed(1));
  const pitchScore = Number(clampNumber(scoring.pitch_score ?? finalScore, 0, 10, finalScore).toFixed(1));
  const lyricScore = Number(clampNumber(scoring.lyric_score ?? finalScore, 0, 10, finalScore).toFixed(1));

  return {
    id: rawResult.id || generateEntryId(),
    player_id: player.id ?? null,
    player_name: playerName,
    mode: "standard",
    session_id: null,
    video_id: String(song.videoId || ""),
    song_title: String(song.title || song.videoId || "Música").slice(0, 200),
    artist: String(song.artist || song.channel || "").slice(0, 200),
    played_at: rawResult.playedAt || new Date().toISOString(),
    duration_s: Math.max(0, Math.round(Number(rawResult.durationSeconds ?? song.duration ?? 0) || 0)),
    score: finalScore,
    completed: rawResult.completed !== false,
    difficulty,
    compatibility_level: compatLevel,
    scoring_confidence: scoringConfidence,
    mic_quality: micQuality,
    assists: {
      auto_transpose: Boolean(session?.assists?.autoTranspose),
      guide_volume: clampNumber(session?.assists?.guideVolume, 0, 1, 0),
    },
    details: {
      best_streak: Math.max(0, Math.round(Number(scoring.best_streak) || 0)),
      coverage: Number(clampNumber(scoring.coverage, 0, 1, 0).toFixed(4)),
      pitch_score: pitchScore,
      lyric_score: lyricScore,
      has_synced_lyrics: Boolean(scoring.has_synced_lyrics),
      transposition_semitones: Math.round(Number(scoring.transposition_semitones) || 0),
      ...(scoring.weights && typeof scoring.weights === "object"
        ? {
            weights: {
              pitch: Number(clampNumber(scoring.weights.pitch, 0, 1, 0.4).toFixed(2)),
              lyrics: Number(clampNumber(scoring.weights.lyrics, 0, 1, 0.6).toFixed(2)),
            },
          }
        : {}),
      ...(Array.isArray(scoring.segments) ? { segments: [...scoring.segments] } : {}),
    },
    scoring_version: 2,
    app_version: "0.1.0",
  };
}

export const standardMode = Object.freeze({
  id: "standard",
  enabled: true,
  badgeKey: null,
  labelKey: "mode.standard.title",
  descriptionKey: "mode.standard.description",

  setup(context = {}) {
    const player = context.player || { id: null, name: "Convidado", isGuest: true };
    const song = context.song || {};
    const difficulty = VALID_DIFFICULTIES.has(context.difficulty) ? context.difficulty : "normal";

    return {
      mode: "standard",
      session_id: null,
      status: "ready",
      startedAt: null,
      endedAt: null,
      player: {
        id: player.id ?? null,
        name: player.name || "Convidado",
        isGuest: Boolean(player.isGuest ?? !player.id),
      },
      song: {
        videoId: String(song.videoId || ""),
        title: String(song.title || song.videoId || ""),
        artist: String(song.artist || song.channel || ""),
        duration: Number(song.duration) || 0,
        compatibilityLevel: VALID_COMPAT_LEVELS.has(song.compatibilityLevel)
          ? song.compatibilityLevel
          : "regular",
      },
      difficulty,
      assists: {
        autoTranspose: Boolean(context.assists?.autoTranspose),
        guideVolume: clampNumber(context.assists?.guideVolume, 0, 1, 0),
      },
      prefs: {
        recordGuest: context.prefs?.recordGuest !== false,
        recordAbandoned: Boolean(context.prefs?.recordAbandoned),
      },
      live: {
        framesCounted: 0,
        currentStreak: 0,
        bestStreak: 0,
        lastHit: null,
      },
    };
  },

  onStart(session) {
    if (!session) return null;
    session.status = "running";
    session.startedAt = new Date().toISOString();
    session.live = {
      framesCounted: 0,
      currentStreak: 0,
      bestStreak: 0,
      lastHit: null,
    };
    return session;
  },

  onFrame(session, frameEval = {}) {
    if (!session || !session.live) return frameEval;
    if (frameEval.counted) {
      session.live.framesCounted += 1;
      if (frameEval.hit && frameEval.hit !== "miss") {
        session.live.currentStreak += 1;
        if (session.live.currentStreak > session.live.bestStreak) {
          session.live.bestStreak = session.live.currentStreak;
        }
      } else {
        session.live.currentStreak = 0;
      }
    }
    session.live.lastHit = frameEval.hit ?? null;
    return {
      ...frameEval,
      streak: session.live.currentStreak,
      bestStreak: session.live.bestStreak,
    };
  },

  async onEnd(session, rawResult = {}, { client = historyClient } = {}) {
    if (session) {
      session.status = "finished";
      session.endedAt = new Date().toISOString();
    }

    const entry = buildStandardHistoryEntry(session, rawResult);
    const isGuest = Boolean(session?.player?.isGuest ?? !entry.player_id);
    const allowGuest = session?.prefs?.recordGuest !== false;
    const allowAbandoned = Boolean(session?.prefs?.recordAbandoned);

    const shouldPersist =
      (entry.completed || allowAbandoned) && (!isGuest || allowGuest);

    if (!shouldPersist) {
      return {
        entry,
        persistence: {
          skipped: true,
          synced: false,
          pending: false,
          reason: !entry.completed ? "abandoned_disabled" : "guest_disabled",
        },
      };
    }

    const persistence = await client.recordMatch(entry);
    return {
      entry,
      persistence: {
        skipped: false,
        ...persistence,
      },
    };
  },

  summary(result = {}) {
    const entry = result.entry || result;
    const score = clampNumber(entry.score, 0, 10, 0);
    const details = entry.details || {};
    const pitchScore = clampNumber(details.pitch_score ?? score, 0, 10, score);
    const lyricScore = clampNumber(details.lyric_score ?? score, 0, 10, score);

    let tier = "starter";
    let verdict = "Continue praticando!";

    if (score >= 8.5) {
      tier = "excellent";
      verdict = "Performance brilhante!";
    } else if (score >= 6.5) {
      tier = "good";
      verdict = "Ótima interpretação!";
    } else if (score >= 4.0) {
      tier = "fair";
      verdict = "Bom aquecimento!";
    }

    return {
      mode: "standard",
      score,
      scoreFormatted: score.toFixed(1),
      pitchScore,
      lyricScore,
      hasSyncedLyrics: Boolean(details.has_synced_lyrics),
      weights: details.weights || null,
      transpositionSemitones: Math.round(Number(details.transposition_semitones) || 0),
      tier,
      verdict,
      bestStreak: Math.max(0, Math.round(Number(details.best_streak) || 0)),
      coverage: clampNumber(details.coverage, 0, 1, 0),
      completed: entry.completed !== false,
      persistence: result.persistence || null,
    };
  },
});