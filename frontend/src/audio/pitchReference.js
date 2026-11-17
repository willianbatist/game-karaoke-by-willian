/**
 * Leitura de `pitch_reference.json`, compensação de latência e comparação de afinação (T2.3).
 */

import { freqToMidi } from "./yinDetector.js";

function midiToFreq(midi) {
  if (!Number.isFinite(midi) || midi <= 0) return 0;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Normaliza um quadro individual vindo de `pitch_reference.json`
 * (aceita formatos objeto `{ t|time, midi, f0|freq, voiced }` ou array `[t, midi, voiced]`).
 */
function normalizeFrame(raw, index, defaultStepSec) {
  if (Array.isArray(raw)) {
    const time = Number(raw[0] ?? index * defaultStepSec);
    const val = Number(raw[1]);
    const voicedFlag = raw[2] !== undefined ? Boolean(raw[2]) : Number.isFinite(val) && val > 0;
    // Se valor > 135 assume Hz e converte para MIDI; caso contrário assume MIDI
    const midi = voicedFlag && val > 0 ? (val > 135 ? freqToMidi(val) : val) : null;
    return {
      time,
      midi,
      freq: midi !== null ? midiToFreq(midi) : 0,
      voiced: midi !== null,
      confidence: midi !== null ? 1 : 0,
    };
  }

  if (!raw || typeof raw !== "object") {
    return {
      time: index * defaultStepSec,
      midi: null,
      freq: 0,
      voiced: false,
      confidence: 0,
    };
  }

  const time = Number(raw.time ?? raw.t ?? raw.timestamp ?? index * defaultStepSec);
  const rawFreq = Number(raw.freq ?? raw.f0 ?? 0);
  const rawMidi = raw.midi !== undefined && raw.midi !== null ? Number(raw.midi) : null;

  let midi = null;
  if (rawMidi !== null && Number.isFinite(rawMidi) && rawMidi > 0) {
    midi = rawMidi;
  } else if (Number.isFinite(rawFreq) && rawFreq > 0) {
    midi = freqToMidi(rawFreq);
  }

  const voiced =
    raw.voiced !== undefined
      ? Boolean(raw.voiced) && midi !== null
      : midi !== null;

  return {
    time: Number.isFinite(time) ? time : index * defaultStepSec,
    midi: voiced ? midi : null,
    freq: voiced ? (rawFreq > 0 ? rawFreq : midiToFreq(midi)) : 0,
    voiced,
    confidence: voiced ? Number(raw.confidence ?? raw.voiced_prob ?? 1) : 0,
  };
}

/**
 * Agrupa quadros contínuos de mesma nota em barras melódicas para exibição no Rolo de Notas.
 */
export function buildNoteSegments(frames, options = {}) {
  const maxGapSec = Number(options.maxGapSec ?? 0.12);
  const semitoneJumpThreshold = Number(options.semitoneJumpThreshold ?? 0.85);
  const minSegmentDurationSec = Number(options.minSegmentDurationSec ?? 0.05);

  const segments = [];
  let current = null;

  function flushSegment() {
    if (!current) return;
    const duration = current.endTime - current.startTime;
    if (duration >= minSegmentDurationSec || current.count >= 2) {
      segments.push({
        startTime: current.startTime,
        endTime: current.endTime,
        midi: current.midiSum / current.count,
        minMidi: current.minMidi,
        maxMidi: current.maxMidi,
      });
    }
    current = null;
  }

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f.voiced || f.midi === null) {
      flushSegment();
      continue;
    }

    const nextFrameTime = frames[i + 1]?.time ?? f.time + 0.02;
    const frameEnd = Math.max(f.time + 0.01, Math.min(nextFrameTime, f.time + 0.08));

    if (!current) {
      current = {
        startTime: f.time,
        endTime: frameEnd,
        midiSum: f.midi,
        count: 1,
        minMidi: f.midi,
        maxMidi: f.midi,
      };
      continue;
    }

    const avgMidi = current.midiSum / current.count;
    const gap = f.time - current.endTime;
    const jump = Math.abs(f.midi - avgMidi);

    if (gap <= maxGapSec && jump <= semitoneJumpThreshold) {
      current.endTime = frameEnd;
      current.midiSum += f.midi;
      current.count += 1;
      current.minMidi = Math.min(current.minMidi, f.midi);
      current.maxMidi = Math.max(current.maxMidi, f.midi);
    } else {
      flushSegment();
      current = {
        startTime: f.time,
        endTime: frameEnd,
        midiSum: f.midi,
        count: 1,
        minMidi: f.midi,
        maxMidi: f.midi,
      };
    }
  }

  flushSegment();
  return segments;
}

/**
 * Reduz a diferença em semitons para o intervalo [-6, +6], tornando a comparação
 * justa mesmo se o cantor estiver uma oitava acima ou abaixo da gravação original.
 */
export function foldOctaveDiff(diffSemitones) {
  return (((diffSemitones + 6) % 12) + 12) % 12 - 6;
}

/**
 * Compara a nota MIDI cantada (`userMidi`) com a nota de referência (`refMidi`).
 */
export function comparePitch(userMidi, refMidi, options = {}) {
  const octaveTolerant = options.octaveTolerant !== false;
  const perfectThreshold = Number(options.perfectThreshold ?? 0.5);
  const greatThreshold = Number(options.greatThreshold ?? 1.0);
  const goodThreshold = Number(options.goodThreshold ?? 1.75);

  if (!Number.isFinite(refMidi) || refMidi <= 0) {
    return {
      status: "rest",
      accuracy: 0,
      rawDiffSemitones: 0,
      effectiveDiffSemitones: 0,
      cents: 0,
      displayUserMidi: Number.isFinite(userMidi) ? userMidi : null,
    };
  }

  if (!Number.isFinite(userMidi) || userMidi <= 0) {
    return {
      status: "silent",
      accuracy: 0,
      rawDiffSemitones: 0,
      effectiveDiffSemitones: 0,
      cents: 0,
      displayUserMidi: null,
    };
  }

  const rawDiff = userMidi - refMidi;
  const effectiveDiff = octaveTolerant ? foldOctaveDiff(rawDiff) : rawDiff;
  const absDiff = Math.abs(effectiveDiff);
  const cents = Math.round(effectiveDiff * 100);

  // Projeta o cursor visual do cantor na mesma oitava da barra de referência
  const octaveShift = Math.round((refMidi - userMidi) / 12) * 12;
  const displayUserMidi = octaveTolerant ? userMidi + octaveShift : userMidi;

  let status = "miss";
  let accuracy = 0;

  if (absDiff <= perfectThreshold) {
    status = "perfect";
    accuracy = 1.0;
  } else if (absDiff <= greatThreshold) {
    status = "great";
    const ratio = (absDiff - perfectThreshold) / Math.max(0.001, greatThreshold - perfectThreshold);
    accuracy = 0.99 - ratio * 0.24; // 0.99 -> 0.75
  } else if (absDiff <= goodThreshold) {
    status = "good";
    const ratio = (absDiff - greatThreshold) / Math.max(0.001, goodThreshold - greatThreshold);
    accuracy = 0.74 - ratio * 0.34; // 0.74 -> 0.40
  }

  return {
    status, // "perfect" | "great" | "good" | "miss" | "rest" | "silent"
    accuracy: Math.max(0, Math.min(1, accuracy)),
    rawDiffSemitones: rawDiff,
    effectiveDiffSemitones: effectiveDiff,
    cents,
    displayUserMidi,
  };
}

export function createPitchReference(rawJson = {}) {
  const defaultStepSec = Number(
    rawJson?.frame_step_seconds ??
      (rawJson?.hop_length && rawJson?.sample_rate
        ? rawJson.hop_length / rawJson.sample_rate
        : 0.01)
  );

  const rawList = Array.isArray(rawJson)
    ? rawJson
    : Array.isArray(rawJson?.frames)
      ? rawJson.frames
      : Array.isArray(rawJson?.pitch)
        ? rawJson.pitch
        : Array.isArray(rawJson?.points)
          ? rawJson.points
          : [];

  const frames = rawList
    .map((item, idx) => normalizeFrame(item, idx, defaultStepSec))
    .sort((a, b) => a.time - b.time);

  let midiMin = Infinity;
  let midiMax = -Infinity;
  let voicedCount = 0;

  for (const f of frames) {
    if (f.voiced && f.midi !== null) {
      voicedCount++;
      if (f.midi < midiMin) midiMin = f.midi;
      if (f.midi > midiMax) midiMax = f.midi;
    }
  }

  if (!Number.isFinite(midiMin) || !Number.isFinite(midiMax)) {
    midiMin = 48; // C3
    midiMax = 72; // C5
  } else {
    // Garante pelo menos 1 oitava de amplitude visual no rolo de notas
    if (midiMax - midiMin < 12) {
      const center = (midiMin + midiMax) / 2;
      midiMin = Math.floor(center - 6);
      midiMax = Math.ceil(center + 6);
    }
  }

  const segments = buildNoteSegments(frames);
  const duration = frames.length > 0 ? frames[frames.length - 1].time : 0;

  /**
   * Busca o quadro de referência correspondente a `songTimeSeconds`,
   * descontando `micLatencyMs` (atraso da cadeia de entrada do microfone).
   */
  function getReferenceAt(songTimeSeconds, micLatencyMs = 0) {
    if (frames.length === 0) {
      return { effectiveTime: 0, frame: null };
    }

    const latencySec = (Number(micLatencyMs) || 0) / 1000;
    const effectiveTime = Math.max(0, (Number(songTimeSeconds) || 0) - latencySec);

    if (effectiveTime < frames[0].time) {
      return { effectiveTime, frame: null };
    }

    // Busca binária pelo quadro mais próximo de `effectiveTime`
    let low = 0;
    let high = frames.length - 1;
    let bestIdx = 0;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (frames[mid].time <= effectiveTime) {
        bestIdx = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const curr = frames[bestIdx];
    const next = frames[bestIdx + 1];
    const chosen =
      next && Math.abs(next.time - effectiveTime) < Math.abs(curr.time - effectiveTime)
        ? next
        : curr;

    // Se estiver muito distante de qualquer quadro registrado (> 0.15s), considera silêncio
    if (Math.abs(chosen.time - effectiveTime) > 0.15) {
      return { effectiveTime, frame: null };
    }

    return { effectiveTime, frame: chosen };
  }

  /**
   * Avalia em um único passo a nota cantada no momento `songTimeSeconds` com compensação de latência.
   */
  function evaluateSungPitch({ songTimeSeconds, userMidi, micLatencyMs = 0, octaveTolerant = true }) {
    const { effectiveTime, frame } = getReferenceAt(songTimeSeconds, micLatencyMs);
    const refMidi = frame && frame.voiced ? frame.midi : null;
    const comparison = comparePitch(userMidi, refMidi, { octaveTolerant });

    return {
      effectiveTime,
      refMidi,
      ...comparison,
    };
  }

  /**
   * Retorna todas as barras de notas visíveis dentro da janela `[startTime, endTime]`
   * para desenho no Canvas do Rolo de Notas.
   */
  function getSegmentsInWindow(startTime, endTime) {
    return segments.filter((seg) => seg.endTime >= startTime && seg.startTime <= endTime);
  }

  function getStats() {
    return {
      frameCount: frames.length,
      voicedCount,
      segmentCount: segments.length,
      midiMin,
      midiMax,
      duration,
      hasPitchData: voicedCount > 0,
    };
  }

  return {
    getReferenceAt,
    evaluateSungPitch,
    getSegmentsInWindow,
    getStats,
  };
}

/**
 * Baixa e inicializa o `pitch_reference.json` de uma música pronta no cache.
 */
export async function loadPitchReference(videoId, options = {}) {
  const fetchImpl =
    options.fetchImpl ??
    (typeof window !== "undefined" && typeof window.fetch === "function"
      ? window.fetch.bind(window)
      : globalThis.fetch);

  const url = `/api/songs/${encodeURIComponent(videoId)}/files/pitch_reference.json`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Falha ao carregar pitch_reference.json (HTTP ${res.status}).`);
  }
  const data = await res.json();
  return createPitchReference(data);
}