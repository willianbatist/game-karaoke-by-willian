/**
 * Motor de Pontuação Vocal (T3.1)
 * Implementa o contrato definido em docs/CONTRACTS.md (§7 e §11) e docs/ARCHITECTURE.md (§9 e §11).
 * Módulo puro (sem DOM e sem fetch), compatível com navegador e Node.js.
 */

const DEFAULT_TOLERANCES = Object.freeze({
  easy: { full: 1.0, half: 2.0 },
  normal: { full: 0.8, half: 1.8 },
  hard: { full: 0.5, half: 1.2 },
});

const DEFAULT_HEURISTIC_CONFIG = Object.freeze({
  stability_window_frames: 5,
  stability_tolerance_semitones: 1.5,
  full_score_coverage: 0.6,
});

/**
 * Calcula a distância circular mínima em semitons (módulo 12) entre duas notas MIDI.
 * Ignora diferenças de oitava (ex.: Dó3 e Dó4 têm distância 0).
 */
export function circularSemitoneDistance(userMidi, targetMidi) {
  const diff = Math.abs(userMidi - targetMidi) % 12;
  return Math.min(diff, 12 - diff);
}

/**
 * Calcula a diferença circular com sinal no intervalo [-6, +6).
 * Usada para estimar o deslocamento dominante na transposição automática.
 */
export function signedCircularSemitoneDiff(userMidi, targetMidi) {
  let diff = (userMidi - targetMidi) % 12;
  if (diff >= 6) diff -= 12;
  if (diff < -6) diff += 12;
  return diff;
}

function computeMedian(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Cria uma instância do motor de pontuação para uma partida.
 */
export function createScoringEngine(options = {}) {
  const pitchMap = options.pitchMap || {
    t0: 0,
    hop: 0.02,
    midi: [],
    conf: [],
    mode: "reference",
  };

  const difficulty = ["easy", "normal", "hard"].includes(options.difficulty)
    ? options.difficulty
    : "normal";

  const allTolerances = options.tolerances || DEFAULT_TOLERANCES;
  const activeTolerance = allTolerances[difficulty] || DEFAULT_TOLERANCES.normal;
  const fullTolerance = Number(activeTolerance.full ?? 0.8);
  const halfTolerance = Number(activeTolerance.half ?? 1.8);

  const pitchConfThreshold = Number(options.pitchConfThreshold ?? 0.6);
  const latencyOffsetMs = Number(options.latencyOffsetMs ?? 0);
  const autoTranspose = Boolean(options.autoTranspose ?? false);

  const heuristicCfg = {
    ...DEFAULT_HEURISTIC_CONFIG,
    ...(options.heuristicConfig || {}),
  };

  const segmentCount = Math.max(1, Number(options.segmentCount ?? 24));
  const refMidiArray = Array.isArray(pitchMap.midi) ? pitchMap.midi : [];
  const refConfArray = Array.isArray(pitchMap.conf) ? pitchMap.conf : [];
  const totalFrames = refMidiArray.length;
  const hop = Number(pitchMap.hop) > 0 ? Number(pitchMap.hop) : 0.02;
  const t0 = Number(pitchMap.t0 ?? 0);
  const isHeuristic = pitchMap.mode === "heuristic";

  // Evita contabilizar o mesmo índice do gabarito mais de uma vez
  const evaluatedIndices = new Set();

  // Contadores do modo referência
  let countedFrames = 0;
  let sungCountedFrames = 0;
  let pointsSum = 0;
  let currentStreak = 0;
  let bestStreak = 0;

  const segmentPointsSum = new Array(segmentCount).fill(0);
  const segmentCountedFrames = new Array(segmentCount).fill(0);

  // Estado da transposição automática opcional (Seção 9.7)
  const shiftSamples = [];
  let transpositionSemitones = 0;
  let transpositionLocked = false;

  // Estado do modo heurístico (Seção 11 e CONTRACTS.md §7)
  const recentVoicedMidis = [];
  let stableHeuristicFrames = 0;
  let voicedUserFrames = 0;

  function resolveTransposition(userMidi, targetMidi) {
    if (!autoTranspose) return 0;

    if (!transpositionLocked) {
      const signed = signedCircularSemitoneDiff(userMidi, targetMidi);
      const roundedShift = Math.round(signed);
      shiftSamples.push(roundedShift);

      if (shiftSamples.length >= 15) {
        const counts = new Map();
        for (const s of shiftSamples) {
          counts.set(s, (counts.get(s) || 0) + 1);
        }
        let dominantShift = 0;
        let maxFreq = 0;
        for (const [shift, freq] of counts.entries()) {
          if (freq > maxFreq) {
            maxFreq = freq;
            dominantShift = shift;
          }
        }
        if (maxFreq / shiftSamples.length >= 0.4) {
          transpositionSemitones = dominantShift;
        }
        if (shiftSamples.length >= 30) {
          transpositionLocked = true;
        }
      }
    }

    return transpositionSemitones;
  }

  function pushHeuristicFrame(idx, midi) {
    const hasUserVoice = midi !== null && midi !== undefined && Number.isFinite(midi);
    if (!hasUserVoice) {
      currentStreak = 0;
      return { counted: false, points: 0, hit: null };
    }

    voicedUserFrames += 1;

    // Alinha o valor MIDI à oitava da primeira amostra da janela antes de tirar a mediana
    let alignedMidi = midi;
    if (recentVoicedMidis.length > 0) {
      const anchor = recentVoicedMidis[0];
      alignedMidi = anchor + signedCircularSemitoneDiff(midi, anchor);
    }

    recentVoicedMidis.push(alignedMidi);
    const maxWindow = Math.max(1, Number(heuristicCfg.stability_window_frames));
    if (recentVoicedMidis.length > maxWindow) {
      recentVoicedMidis.shift();
    }

    const medianMidi = computeMedian(recentVoicedMidis);
    const delta = circularSemitoneDistance(alignedMidi, medianMidi);
    const isStable = delta <= Number(heuristicCfg.stability_tolerance_semitones);

    const segIdx = totalFrames > 0
      ? Math.min(segmentCount - 1, Math.floor((idx / totalFrames) * segmentCount))
      : 0;
    segmentCountedFrames[segIdx] += 1;

    if (isStable) {
      stableHeuristicFrames += 1;
      currentStreak += 1;
      if (currentStreak > bestStreak) bestStreak = currentStreak;
      segmentPointsSum[segIdx] += 1.0;
      return { counted: true, points: 1.0, hit: "perfect" };
    }

    currentStreak = 0;
    return { counted: true, points: 0.0, hit: "miss" };
  }

  /**
   * Processa um frame capturado do microfone no instante `songTime`.
   */
  function pushFrame(frame = {}) {
    const songTime = Number(frame.songTime);
    if (!Number.isFinite(songTime) || totalFrames === 0) {
      return { counted: false, points: 0, hit: null };
    }

    const effectiveTime = songTime - latencyOffsetMs / 1000;
    const idx = Math.round((effectiveTime - t0) / hop);

    if (idx < 0 || idx >= totalFrames || evaluatedIndices.has(idx)) {
      return { counted: false, points: 0, hit: null };
    }
    evaluatedIndices.add(idx);

    const userMidi = frame.midi;
    if (isHeuristic) {
      return pushHeuristicFrame(idx, userMidi);
    }

    const refMidi = refMidiArray[idx];
    const refConf = Number(refConfArray[idx] ?? 0);

    // Ignora frames onde o gabarito não tem voz confiável (Seção 9.5)
    if (
      refMidi === null ||
      refMidi === undefined ||
      !Number.isFinite(refMidi) ||
      refConf < pitchConfThreshold
    ) {
      return { counted: false, points: 0, hit: null };
    }

    countedFrames += 1;
    const segIdx = Math.min(segmentCount - 1, Math.floor((idx / totalFrames) * segmentCount));
    segmentCountedFrames[segIdx] += 1;

    const hasUserVoice =
      userMidi !== null && userMidi !== undefined && Number.isFinite(userMidi);

    // Frame com gabarito ativo e usuário em silêncio: 0 pontos (Seção 9.5)
    if (!hasUserVoice) {
      currentStreak = 0;
      return { counted: true, points: 0, hit: "miss" };
    }

    sungCountedFrames += 1;

    const shift = resolveTransposition(userMidi, refMidi);
    const correctedUserMidi = userMidi - shift;
    const delta = circularSemitoneDistance(correctedUserMidi, refMidi);

    let points = 0;
    let hit = "miss";

    if (delta <= fullTolerance) {
      points = 1.0;
      hit = "perfect";
      currentStreak += 1;
      if (currentStreak > bestStreak) bestStreak = currentStreak;
    } else if (delta <= halfTolerance) {
      points = 0.5;
      hit = "good";
      currentStreak += 1;
      if (currentStreak > bestStreak) bestStreak = currentStreak;
    } else {
      points = 0.0;
      hit = "miss";
      currentStreak = 0;
    }

    pointsSum += points;
    segmentPointsSum[segIdx] += points;

    return { counted: true, points, hit };
  }

  /**
   * Retorna o resumo consolidado da partida (CONTRACTS.md §7).
   */
  function summary() {
    const segments = segmentPointsSum.map((sum, i) => {
      const count = segmentCountedFrames[i];
      if (count <= 0) return 0;
      return Number((sum / count).toFixed(3));
    });

    if (isHeuristic) {
      const fullCoverage = Math.max(0.05, Number(heuristicCfg.full_score_coverage));
      const targetFrames = Math.max(1, fullCoverage * totalFrames);
      const rawScore = 10 * Math.min(1, stableHeuristicFrames / targetFrames);
      const score = Number(rawScore.toFixed(1));
      const coverage =
        totalFrames > 0 ? Number(Math.min(1, voicedUserFrames / totalFrames).toFixed(3)) : 0;

      return {
        score,
        best_streak: bestStreak,
        coverage,
        scoring_confidence: "low",
        segments,
        transposition_semitones: 0,
      };
    }

    const rawScore = countedFrames > 0 ? 10 * (pointsSum / countedFrames) : 0;
    const score = Number(rawScore.toFixed(1));
    const coverage =
      countedFrames > 0 ? Number((sungCountedFrames / countedFrames).toFixed(3)) : 0;

    return {
      score,
      best_streak: bestStreak,
      coverage,
      scoring_confidence: "high",
      segments,
      transposition_semitones: autoTranspose ? transpositionSemitones : 0,
    };
  }

  return {
    pushFrame,
    summary,
  };
}