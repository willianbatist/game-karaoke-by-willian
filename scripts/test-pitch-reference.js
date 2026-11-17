/**
 * Testes automatizados de PitchReference, compensação de latência e comparação de afinação (T2.3).
 * Executar com: node --test scripts/test-pitch-reference.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  comparePitch,
  createPitchReference,
  foldOctaveDiff,
} from "../frontend/src/audio/pitchReference.js";

test("createPitchReference normaliza quadros, calcula range vocal e agrupa barras de notas", () => {
  const sampleJson = {
    frame_step_seconds: 0.05,
    frames: [
      { t: 0.0, midi: 0, voiced: false },
      { t: 0.05, midi: 60.0, voiced: true },
      { t: 0.10, midi: 60.1, voiced: true },
      { t: 0.15, midi: 60.0, voiced: true },
      { t: 0.20, midi: 0, voiced: false },
      // Formato compacto em array: [tempo, Hz (A4 = 440Hz -> MIDI 69), voiced]
      [0.30, 440, 1],
      [0.35, 440, 1],
    ],
  };

  const ref = createPitchReference(sampleJson);
  const stats = ref.getStats();

  assert.equal(stats.hasPitchData, true);
  assert.equal(stats.frameCount, 7);
  assert.equal(stats.voicedCount, 5);
  assert.equal(stats.segmentCount, 2);
  assert.ok(stats.midiMin <= 60);
  assert.ok(stats.midiMax >= 69);

  const visible = ref.getSegmentsInWindow(0.0, 0.25);
  assert.equal(visible.length, 1);
  assert.ok(Math.abs(visible[0].midi - 60.03) < 0.05);
});

test("evaluateSungPitch compensa latência do microfone (micLatencyMs) corretamente", () => {
  const ref = createPitchReference({
    frames: [
      { t: 1.0, midi: 64.0, voiced: true }, // E4 em 1.0s
      { t: 1.1, midi: 67.0, voiced: true }, // G4 em 1.1s
    ],
  });

  // Em songTime = 1.10s, o microfone tem 100ms de atraso e entrega a nota E4 (64) cantada em 1.00s
  const compensated = ref.evaluateSungPitch({
    songTimeSeconds: 1.10,
    userMidi: 64.0,
    micLatencyMs: 100,
  });

  assert.equal(compensated.effectiveTime, 1.0);
  assert.equal(compensated.refMidi, 64.0);
  assert.equal(compensated.status, "perfect");
  assert.equal(compensated.accuracy, 1.0);
});

test("comparePitch classifica acertos, oitavas equivalentes e erros de afinação", () => {
  // Acerto exato
  const exact = comparePitch(69.1, 69.0);
  assert.equal(exact.status, "perfect");
  assert.equal(exact.accuracy, 1.0);

  // Uma oitava abaixo (C3 = 48 vs C4 = 60) -> aceito com tolerância de oitava
  assert.equal(foldOctaveDiff(48 - 60), 0);
  const octaveDown = comparePitch(48.0, 60.0, { octaveTolerant: true });
  assert.equal(octaveDown.status, "perfect");
  assert.equal(octaveDown.displayUserMidi, 60.0);

  // Leve desvio (~0.8 semitom) -> "great"
  const great = comparePitch(60.8, 60.0);
  assert.equal(great.status, "great");
  assert.ok(great.accuracy >= 0.75 && great.accuracy < 1.0);

  // Nota bem fora (3 semitons acima) -> "miss"
  const miss = comparePitch(63.0, 60.0);
  assert.equal(miss.status, "miss");
  assert.equal(miss.accuracy, 0);

  // Trecho instrumental sem voz de referência -> "rest"
  assert.equal(comparePitch(60.0, null).status, "rest");
});