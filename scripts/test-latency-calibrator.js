/**
 * Testes automatizados do calibrador de latência acústica (T2.2).
 * Executar com: node --test scripts/test-latency-calibrator.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  computeMedianLatency,
  createCalibrationSession,
} from "../frontend/src/audio/latencyCalibrator.js";

test("computeMedianLatency calcula corretamente mediana ímpar e par", () => {
  assert.equal(computeMedianLatency([]), null);
  assert.equal(computeMedianLatency([110, 85, 90]), 90);
  assert.equal(computeMedianLatency([80, 100, 120, 200]), 110);
});

test("createCalibrationSession detecta picos de RMS após cada bip e ignora ruído de fundo", () => {
  const session = createCalibrationSession({
    minDelayMs: 15,
    maxDelayMs: 400,
    spikeRatio: 3.0,
    minRmsFloor: 0.02,
  });

  // Ruído de fundo antes do primeiro bip (RMS ~0.004)
  session.processFrame({ rms: 0.004, timestampMs: 100 });
  session.processFrame({ rms: 0.005, timestampMs: 120 });

  // Bip 1 emitido em t = 500ms; pico chega 85ms depois (t = 585ms)
  session.registerBeep(500);
  assert.equal(session.processFrame({ rms: 0.005, timestampMs: 510 }).detected, false); // dentro de minDelayMs
  const hit1 = session.processFrame({ rms: 0.09, timestampMs: 585 });
  assert.equal(hit1.detected, true);
  assert.equal(hit1.delayMs, 85);

  // Leituras seguintes do mesmo bip não geram detecção duplicada
  assert.equal(session.processFrame({ rms: 0.08, timestampMs: 605 }).detected, false);

  // Bip 2 emitido em t = 1200ms; pico chega 95ms depois (t = 1295ms)
  session.registerBeep(1200);
  const hit2 = session.processFrame({ rms: 0.11, timestampMs: 1295 });
  assert.equal(hit2.detected, true);
  assert.equal(hit2.delayMs, 95);

  // Bip 3 emitido em t = 1900ms sem retorno (silêncio)
  session.registerBeep(1900);
  assert.equal(session.processFrame({ rms: 0.004, timestampMs: 2000 }).detected, false);

  const summary = session.getSummary();
  assert.equal(summary.totalBeeps, 3);
  assert.equal(summary.validCount, 2);
  assert.deepEqual(summary.delaysMs, [85, 95]);
  assert.equal(summary.medianMs, 90);
});