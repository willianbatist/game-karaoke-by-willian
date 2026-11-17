/**
 * Calibrador acústico de latência de entrada do microfone (T2.2).
 * Mede o intervalo entre a emissão de bips de referência e o pico de RMS captado.
 */

export function computeMedianLatency(delaysMs) {
  if (!Array.isArray(delaysMs) || delaysMs.length === 0) {
    return null;
  }
  const valid = delaysMs
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);

  if (valid.length === 0) return null;

  const mid = Math.floor(valid.length / 2);
  if (valid.length % 2 === 1) {
    return Math.round(valid[mid]);
  }
  return Math.round((valid[mid - 1] + valid[mid]) / 2);
}

export function createCalibrationSession(options = {}) {
  const minDelayMs = Number(options.minDelayMs ?? 10);
  const maxDelayMs = Number(options.maxDelayMs ?? 450);
  const spikeRatio = Number(options.spikeRatio ?? 2.8);
  const minRmsFloor = Number(options.minRmsFloor ?? 0.025);

  const beeps = []; // { index, emittedAtMs, detectedDelayMs }
  let baselineRms = 0.005;
  let baselineSamples = 0;

  function registerBeep(emittedAtMs) {
    const entry = {
      index: beeps.length,
      emittedAtMs: Number(emittedAtMs),
      detectedDelayMs: null,
    };
    beeps.push(entry);
    return entry.index;
  }

  /**
   * Processa cada leitura de RMS vinda do microfone durante o teste.
   * Retorna `{ detected: true, beepIndex, delayMs }` quando captura o retorno de um bip.
   */
  function processFrame({ rms, timestampMs }) {
    const level = Math.max(0, Number(rms) || 0);
    const now = Number(timestampMs) || 0;

    // Procura o bip mais recente que ainda está dentro da janela válida de detecção
    let activeBeep = null;
    for (let i = beeps.length - 1; i >= 0; i--) {
      const b = beeps[i];
      const elapsed = now - b.emittedAtMs;
      if (elapsed >= 0 && elapsed <= maxDelayMs) {
        activeBeep = b;
        break;
      }
    }

    // Fora da janela de detecção, atualiza a média móvel do ruído ambiente
    if (!activeBeep) {
      if (baselineSamples === 0) {
        baselineRms = level;
      } else {
        baselineRms = baselineRms * 0.85 + level * 0.15;
      }
      baselineSamples++;
      return { detected: false };
    }

    if (activeBeep.detectedDelayMs !== null) {
      return { detected: false };
    }

    const elapsed = now - activeBeep.emittedAtMs;
    if (elapsed < minDelayMs) {
      return { detected: false };
    }

    const triggerThreshold = Math.max(minRmsFloor, baselineRms * spikeRatio);
    if (level >= triggerThreshold) {
      activeBeep.detectedDelayMs = Math.round(elapsed);
      return {
        detected: true,
        beepIndex: activeBeep.index,
        delayMs: activeBeep.detectedDelayMs,
      };
    }

    return { detected: false };
  }

  function getSummary() {
    const delaysMs = beeps
      .map((b) => b.detectedDelayMs)
      .filter((d) => d !== null);

    return {
      totalBeeps: beeps.length,
      validCount: delaysMs.length,
      delaysMs,
      medianMs: computeMedianLatency(delaysMs),
    };
  }

  return {
    registerBeep,
    processFrame,
    getSummary,
  };
}