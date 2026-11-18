/**
 * Serviço de Compatibilidade da Música (ARCHITECTURE.md §10 e CONTRACTS.md §8).
 *
 * Responsabilidades:
 * - Fase 1 (Pré-análise): estima a adequação da faixa apenas pelos metadados
 *   (título, canal, duração e candidato de letra), executando em < 50 ms.
 * - Fase 2 (Pós-análise): combina as métricas acústicas extraídas pelo Worker
 *   Python (manifest.metrics) com a qualidade da letra (lyrics_sync_quality)
 *   e grava o bloco `compatibility` no manifest.json.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEIGHTS_PATH = path.resolve(__dirname, "../../config/compatibility-weights.json");

const KEYWORD_REASON_MAP = {
  "ao vivo": "Versão ao vivo: a letra pode estar desalinhada",
  live: "Versão ao vivo: a letra pode estar desalinhada",
  "acústico": "Versão acústica: o arranjo pode diferir da gravação padrão",
  acoustic: "Versão acústica: o arranjo pode diferir da gravação padrão",
  remix: "Versão remix: estrutura e andamento podem divergir da letra",
  cover: "Versão cover: interpretação vocal diferente da original",
  karaoke: "Faixa já parece ser karaokê: pode não ter voz guia para pontuação",
  instrumental: "Faixa aparentemente já instrumental",
  mashup: "Mashup de músicas: letra e melodia podem não corresponder",
  playlist: "Vídeo parece ser uma compilação ou playlist",
  loop: "Vídeo em loop: estrutura repetitiva",
};

/**
 * Remove acentos, converte para minúsculas e normaliza espaços para comparação segura.
 */
function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Garante que um número fique dentro do intervalo [0, 1].
 */
function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num <= 0) return 0;
  if (num >= 1) return 1;
  return num;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * Resolve o candidato ativo a partir de um objeto lyrics.json ou de um candidato direto.
 */
function resolveLyricsCandidate(lyricsInput) {
  if (!lyricsInput || typeof lyricsInput !== "object") return null;

  if (Array.isArray(lyricsInput.candidates)) {
    if (lyricsInput.selected_id == null) return null;
    return (
      lyricsInput.candidates.find((item) => item && item.id === lyricsInput.selected_id) ?? null
    );
  }

  return lyricsInput;
}

/**
 * Carrega os pesos e limiares de config/compatibility-weights.json.
 */
export function loadCompatibilityWeights(weightsPath = DEFAULT_WEIGHTS_PATH) {
  const raw = fs.readFileSync(weightsPath, "utf-8");
  return JSON.parse(raw);
}

export function createCompatibilityService(options = {}) {
  const cacheManager = options.cacheManager ?? null;
  const weightsCfg = options.weightsConfig ?? loadCompatibilityWeights(options.weightsPath);

  /**
   * Calcula `lyrics_sync_quality` (0.0 a 1.0) e identifica o tipo da letra (`synced|plain|none`)
   * conforme CONTRACTS.md §8.2.
   */
  function computeLyricsSyncQuality(lyricsInput, videoDurationS) {
    const syncCfg = weightsCfg.lyrics_sync_quality;
    const candidate = resolveLyricsCandidate(lyricsInput);

    if (!candidate) {
      return {
        type: "none",
        selected_id: null,
        sync_quality: round4(syncCfg.none),
      };
    }

    const syncedText =
      typeof candidate.syncedLyrics === "string" ? candidate.syncedLyrics.trim() : "";
    const plainText =
      typeof candidate.plainLyrics === "string" ? candidate.plainLyrics.trim() : "";
    const selectedId = candidate.id ?? null;

    if (!syncedText && !plainText) {
      return {
        type: "none",
        selected_id: selectedId,
        sync_quality: round4(syncCfg.none),
      };
    }

    if (!syncedText) {
      return {
        type: "plain",
        selected_id: selectedId,
        sync_quality: round4(syncCfg.plain),
      };
    }

    const candDuration = Number(candidate.duration);
    const vidDuration = Number(videoDurationS);

    let deltaS = 0;
    if (
      Number.isFinite(candDuration) &&
      candDuration > 0 &&
      Number.isFinite(vidDuration) &&
      vidDuration > 0
    ) {
      deltaS = Math.abs(candDuration - vidDuration);
    }

    let quality;
    if (deltaS <= syncCfg.best_delta_s) {
      quality = syncCfg.synced_best;
    } else if (deltaS >= syncCfg.worst_delta_s) {
      quality = syncCfg.synced_worst;
    } else {
      const ratio =
        (deltaS - syncCfg.best_delta_s) / (syncCfg.worst_delta_s - syncCfg.best_delta_s);
      quality = syncCfg.synced_best - ratio * (syncCfg.synced_best - syncCfg.synced_worst);
    }

    return {
      type: "synced",
      selected_id: selectedId,
      sync_quality: round4(clamp01(quality)),
    };
  }

  /**
   * Fase 1 — Pré-análise instantânea (CONTRACTS.md §8.3).
   * Função pura baseada em metadados do vídeo e candidato de letra.
   * Nunca retorna `incompatible` (o piso da pré-análise é `low`).
   */
  function evaluatePreAnalysis({
    title = "",
    channel = "",
    duration = null,
    lyricsCandidate = null,
    hasLyrics = undefined,
  } = {}) {
    const preCfg = weightsCfg.pre_analysis;
    const thresholds = weightsCfg.thresholds;

    let totalPenalty = 0;
    const reasons = [];

    const addReason = (text) => {
      if (text && !reasons.includes(text)) {
        reasons.push(text);
      }
    };

    // 1. Penalidades por palavras-chave inteiras no título ou canal (sem acentos/case)
    const haystack = ` ${normalizeText(`${title} ${channel}`)} `;
    for (const [rawKeyword, penalty] of Object.entries(preCfg.keyword_penalties || {})) {
      const normalizedKeyword = normalizeText(rawKeyword);
      if (!normalizedKeyword) continue;

      if (haystack.includes(` ${normalizedKeyword} `)) {
        totalPenalty += Number(penalty) || 0;
        addReason(
          KEYWORD_REASON_MAP[rawKeyword] ??
            `Versão "${rawKeyword}" pode reduzir a precisão da pontuação`
        );
      }
    }

    // 2. Penalidade por duração muito curta ou muito longa
    const vidDuration = Number(duration);
    const hasValidVideoDuration = Number.isFinite(vidDuration) && vidDuration > 0;
    if (hasValidVideoDuration) {
      if (vidDuration < preCfg.duration_min_s) {
        totalPenalty += Number(preCfg.duration_penalty) || 0;
        addReason("Duração muito curta para uma música completa");
      } else if (vidDuration > preCfg.duration_max_s) {
        totalPenalty += Number(preCfg.duration_penalty) || 0;
        addReason("Duração muito longa (possível compilação ou show completo)");
      }
    }

    // 3. Penalidades relacionadas à letra e diferença de duração vídeo x letra
    const candidate = resolveLyricsCandidate(lyricsCandidate);
    const candidateHasText = Boolean(
      candidate &&
        ((typeof candidate.syncedLyrics === "string" && candidate.syncedLyrics.trim()) ||
          (typeof candidate.plainLyrics === "string" && candidate.plainLyrics.trim()))
    );

    const lyricsAvailable =
      typeof hasLyrics === "boolean" ? hasLyrics || candidateHasText : candidateHasText;

    if (!lyricsAvailable) {
      totalPenalty += Number(preCfg.lyrics_missing_penalty) || 0;
      addReason("Letra não encontrada automaticamente");
    } else if (candidate && hasValidVideoDuration) {
      const candDuration = Number(candidate.duration);
      if (Number.isFinite(candDuration) && candDuration > 0) {
        const diffS = Math.abs(vidDuration - candDuration);
        if (diffS > preCfg.duration_mismatch.tolerance_s) {
          totalPenalty += Number(preCfg.duration_mismatch.penalty) || 0;
          addReason("Duração do vídeo difere da letra encontrada (pode ser outra versão)");
        }
      }
    }

    const score = round4(clamp01(1 - totalPenalty));

    let level;
    if (score >= thresholds.excellent) {
      level = "excellent";
    } else if (score >= thresholds.good) {
      level = "good";
    } else if (score >= thresholds.regular) {
      level = "regular";
    } else {
      level = "low";
    }

    return {
      level,
      score,
      reasons,
      provisional: true,
    };
  }

  /**
   * Fase 2 — Pós-análise acústica (CONTRACTS.md §8.2).
   * Combina `manifest.metrics` com `lyrics_sync_quality` usando os pesos configurados.
   */
  function evaluatePostAnalysis(manifest, lyricsData = null, extra = {}) {
    const weights = weightsCfg.weights;
    const thresholds = weightsCfg.thresholds;
    const reasonThreshold = Number(weightsCfg.reason_threshold ?? 0.45);
    const minVoicedRatio = Number(weightsCfg.incompatible_rules?.min_voiced_ratio ?? 0.05);

    const metrics = manifest?.metrics || {};
    const videoDurationS = manifest?.source?.duration ?? null;
    const syncResult = computeLyricsSyncQuality(lyricsData, videoDurationS);

    // Normaliza todas as métricas para o sentido "maior = melhor"
    const normalized = {
      voiced_ratio: clamp01(metrics.voiced_ratio),
      mean_confidence: clamp01(metrics.mean_confidence),
      vocal_energy_ratio: clamp01(metrics.vocal_energy_ratio),
      bleed_estimate: clamp01(1 - clamp01(metrics.bleed_estimate)),
      backing_vocals_estimate: clamp01(1 - clamp01(metrics.backing_vocals_estimate)),
      pitch_stability: clamp01(metrics.pitch_stability),
      lyrics_sync_quality: clamp01(syncResult.sync_quality),
    };

    let weightedSum = 0;
    let totalWeight = 0;
    for (const [key, weight] of Object.entries(weights)) {
      const w = Number(weight) || 0;
      if (w <= 0) continue;
      weightedSum += w * (normalized[key] ?? 0);
      totalWeight += w;
    }

    const score = totalWeight > 0 ? round4(clamp01(weightedSum / totalWeight)) : 0;

    // Coleta motivos em linguagem simples para cada métrica abaixo de reason_threshold
    const reasons = [];
    const addReason = (text) => {
      if (text && !reasons.includes(text)) {
        reasons.push(text);
      }
    };

    if (normalized.voiced_ratio < reasonThreshold) {
      addReason("Poucos trechos com voz detectável");
    }
    if (normalized.mean_confidence < reasonThreshold) {
      addReason("Afinação da voz original difícil de isolar");
    }
    if (normalized.vocal_energy_ratio < reasonThreshold) {
      addReason("Volume da voz muito baixo em relação ao instrumental");
    }
    if (normalized.bleed_estimate < reasonThreshold) {
      addReason("Resíduo de instrumentos na faixa vocal");
    }
    if (normalized.backing_vocals_estimate < reasonThreshold) {
      addReason("Muitas vozes de apoio");
    }
    if (normalized.pitch_stability < reasonThreshold) {
      addReason("Contorno vocal instável (muitos saltos de tom)");
    }
    if (normalized.lyrics_sync_quality < reasonThreshold) {
      if (syncResult.type === "none") {
        addReason("Letra não encontrada");
      } else if (syncResult.type === "plain") {
        addReason("Letra sem sincronização");
      } else {
        addReason("Letra pode estar desalinhada com a duração do vídeo");
      }
    }

    const pitchMapMode = extra.pitchMapMode ?? manifest?.pitch_map_mode ?? "reference";
    const isHeuristic = pitchMapMode === "heuristic";
    const isBelowMinVoiced = normalized.voiced_ratio < minVoicedRatio;

    let level;
    if (isHeuristic || isBelowMinVoiced) {
      level = "incompatible";
      if (isHeuristic) {
        reasons.unshift("Faixa aparentemente já instrumental");
      }
      if (isBelowMinVoiced) {
        addReason("Poucos trechos com voz detectável");
      }
    } else if (score >= thresholds.excellent) {
      level = "excellent";
    } else if (score >= thresholds.good) {
      level = "good";
    } else if (score >= thresholds.regular) {
      level = "regular";
    } else if (score >= thresholds.low) {
      level = "low";
    } else {
      level = "incompatible";
    }

    return {
      compatibility: {
        level,
        score,
        reasons: [...new Set(reasons)],
        provisional: false,
      },
      lyricsSummary: {
        type: syncResult.type,
        selected_id: syncResult.selected_id,
        sync_quality: syncResult.sync_quality,
      },
    };
  }

  /**
   * Lê manifest.json, lyrics.json e pitch_map.json da música no cache,
   * executa a pós-análise e persiste `manifest.compatibility` e `manifest.lyrics.sync_quality`.
   */
  function applyPostAnalysisToSong(videoId, { isJobActive = false } = {}) {
    if (!cacheManager) {
      throw new Error("cacheManager não configurado no compatibilityService.");
    }

    const manifest = cacheManager.readManifest(videoId);
    if (!manifest) return null;

    const lyricsData = cacheManager.readLyrics(videoId);

    // Lê o modo do pitch_map.json para detectar modo heurístico (CONTRACTS.md §8.2)
    let pitchMapMode = "reference";
    try {
      const pitchMapFile = manifest.files?.pitch_map || "pitch_map.json";
      const pitchMapPath = path.join(cacheManager.getSongDir(videoId), pitchMapFile);
      if (fs.existsSync(pitchMapPath)) {
        const parsedPitchMap = JSON.parse(fs.readFileSync(pitchMapPath, "utf-8"));
        if (parsedPitchMap?.mode === "heuristic") {
          pitchMapMode = "heuristic";
        }
      }
    } catch {
      // Se falhar a leitura do pitch_map.json, mantém o padrão "reference"
    }

    const { compatibility, lyricsSummary } = evaluatePostAnalysis(manifest, lyricsData, {
      pitchMapMode,
    });

    manifest.compatibility = compatibility;
    manifest.lyrics = {
      source: "lrclib",
      offset_ms: 0,
      ...(manifest.lyrics || {}),
      ...lyricsSummary,
    };
    manifest.user = {
      latency_offsets_ms: {},
      last_played: null,
      ...(manifest.user || {}),
    };

    cacheManager.writeManifestAtomic(videoId, manifest, { isJobActive });
    return { manifest, compatibility };
  }

  return {
    weightsConfig: weightsCfg,
    computeLyricsSyncQuality,
    evaluatePreAnalysis,
    evaluatePostAnalysis,
    applyPostAnalysisToSong,
  };
}