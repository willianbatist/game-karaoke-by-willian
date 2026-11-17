/**
 * Detector de frequência fundamental (F0) baseado no algoritmo YIN
 * com interpolação parabólica e gate RMS.
 */

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/**
 * Converte frequência em Hz para número de nota MIDI contínuo (A4 = 440 Hz -> 69.0).
 */
export function freqToMidi(freq) {
  if (!Number.isFinite(freq) || freq <= 0) return null;
  return 69 + 12 * Math.log2(freq / 440);
}

/**
 * Converte número MIDI contínuo em nome legível da nota (ex.: 69 -> "A4", 60 -> "C4").
 */
export function midiToNoteName(midi) {
  if (!Number.isFinite(midi)) return "--";
  const rounded = Math.round(midi);
  const note = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${note}${octave}`;
}

/**
 * Analisa um bloco de amostras PCM (`Float32Array`) e retorna `{ freq, midi, clarity, rms, voiced }`.
 */
export function detectPitchYin(samples, sampleRate, options = {}) {
  const minFreq = Number(options.minFreq ?? 65); // ~C2 (baixo profundo)
  const maxFreq = Number(options.maxFreq ?? 1100); // ~C6 (soprano agudo)
  const threshold = Number(options.threshold ?? 0.15);
  const rmsThreshold = Number(options.rmsThreshold ?? 0.01);

  const length = samples?.length || 0;
  if (length < 64 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { freq: 0, midi: null, clarity: 0, rms: 0, voiced: false };
  }

  // 1. Calcula o volume RMS do quadro para descartar silêncio/ruído de fundo
  let sumSq = 0;
  for (let i = 0; i < length; i++) {
    const s = samples[i];
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / length);

  if (rms < rmsThreshold) {
    return { freq: 0, midi: null, clarity: 0, rms, voiced: false };
  }

  const halfLen = Math.floor(length / 2);
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
  const tauMax = Math.min(halfLen - 1, Math.floor(sampleRate / minFreq));

  if (tauMax <= tauMin) {
    return { freq: 0, midi: null, clarity: 0, rms, voiced: false };
  }

  // 2. Função de diferença quadrática d(tau)
  const yinBuffer = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < halfLen; j++) {
      const delta = samples[j] - samples[j + tau];
      sum += delta * delta;
    }
    yinBuffer[tau] = sum;
  }

  // 3. Normalização pela média acumulada d'(tau)
  yinBuffer[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    runningSum += yinBuffer[tau];
    yinBuffer[tau] = runningSum > 0 ? (yinBuffer[tau] * tau) / runningSum : 1;
  }

  // 4. Busca o primeiro vale abaixo do limiar de periodicidade
  let tauEstimate = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (yinBuffer[tau] < threshold) {
      while (tau + 1 <= tauMax && yinBuffer[tau + 1] < yinBuffer[tau]) {
        tau++;
      }
      tauEstimate = tau;
      break;
    }
  }

  if (tauEstimate === -1) {
    return { freq: 0, midi: null, clarity: 0, rms, voiced: false };
  }

  // 5. Interpolação parabólica para precisão sub-amostra (< 1 cent)
  let betterTau = tauEstimate;
  if (tauEstimate > 1 && tauEstimate < tauMax) {
    const s0 = yinBuffer[tauEstimate - 1];
    const s1 = yinBuffer[tauEstimate];
    const s2 = yinBuffer[tauEstimate + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (Math.abs(denom) > 1e-12) {
      betterTau = tauEstimate + (s2 - s0) / denom;
    }
  }

  const freq = sampleRate / betterTau;
  const clarity = Math.max(0, Math.min(1, 1 - yinBuffer[tauEstimate]));
  const midi = freqToMidi(freq);

  return {
    freq,
    midi,
    clarity,
    rms,
    voiced: true,
  };
}