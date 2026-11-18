/**
 * Bateria de testes do Motor de Pontuação Vocal (T3.5).
 * Cobre os 5 cenários obrigatórios da Seção 14.2 de docs/ARCHITECTURE.md
 * usando gabaritos sintéticos (sem depender de música real ou do worker).
 *
 * Como rodar no terminal do WSL2:
 *   node --test scripts/test-scoring.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createScoringEngine } from "../frontend/src/game/scoringEngine.js";

const TOLERANCES = {
  easy: { full: 1.0, half: 2.0 },
  normal: { full: 0.8, half: 1.8 },
  hard: { full: 0.5, half: 1.2 },
};

/**
 * Gera um gabarito vocal sintético determinístico para os testes:
 * - 20 frames iniciais sem voz (introdução instrumental)
 * - 60 frames com melodia variando entre notas MIDI 60 e 68 (confiança 0.95)
 * - 20 frames finais sem voz (encerramento instrumental)
 */
function createSyntheticPitchMap() {
  const hop = 0.02;
  const totalFrames = 100;
  const midi = [];
  const conf = [];

  for (let i = 0; i < totalFrames; i++) {
    if (i < 20 || i >= 80) {
      midi.push(null);
      conf.push(0.0);
    } else {
      const note = 64 + 4 * Math.sin((i - 20) * 0.25);
      midi.push(Number(note.toFixed(3)));
      conf.push(0.95);
    }
  }

  return {
    schema_version: 1,
    extractor: "pyin",
    hop,
    t0: 0.0,
    midi,
    conf,
    mode: "reference",
  };
}

test("1. Gabarito contra si mesmo resulta em nota 10.0", () => {
  const pitchMap = createSyntheticPitchMap();
  const engine = createScoringEngine({
    pitchMap,
    difficulty: "normal",
    tolerances: TOLERANCES,
    pitchConfThreshold: 0.6,
    latencyOffsetMs: 0,
  });

  for (let i = 0; i < pitchMap.midi.length; i++) {
    engine.pushFrame({
      songTime: i * pitchMap.hop,
      midi: pitchMap.midi[i],
    });
  }

  const result = engine.summary();
  assert.equal(result.score, 10.0);
  assert.equal(result.best_streak, 60);
  assert.equal(result.coverage, 1);
  assert.equal(result.scoring_confidence, "high");
  assert.equal(result.segments.length, 24);
});

test("2. Degradação gradual com ruído e perda parcial de frames", () => {
  const pitchMap = createSyntheticPitchMap();

  function simulateWithNoise(jitterSemitones, dropEveryN) {
    const engine = createScoringEngine({
      pitchMap,
      difficulty: "normal",
      tolerances: TOLERANCES,
      pitchConfThreshold: 0.6,
      latencyOffsetMs: 0,
    });

    for (let i = 0; i < pitchMap.midi.length; i++) {
      const target = pitchMap.midi[i];
      if (target === null) {
        engine.pushFrame({ songTime: i * pitchMap.hop, midi: null });
        continue;
      }

      // Simula perda parcial de detecção do microfone
      if (dropEveryN > 0 && i % dropEveryN === 0) {
        engine.pushFrame({ songTime: i * pitchMap.hop, midi: null });
        continue;
      }

      // Alterna desvio positivo e negativo de afinação de forma determinística
      const sign = i % 2 === 0 ? 1 : -1;
      const noisyMidi = target + sign * jitterSemitones;
      engine.pushFrame({ songTime: i * pitchMap.hop, midi: noisyMidi });
    }

    return engine.summary().score;
  }

  const scoreClean = simulateWithNoise(0.0, 0);      // Perfeito -> 10.0
  const scoreLightNoise = simulateWithNoise(1.1, 10); // Cai na tolerância metade + 10% perda
  const scoreHeavyNoise = simulateWithNoise(1.5, 3);  // Tolerância metade + 33% perda
  const scoreSevereNoise = simulateWithNoise(3.2, 2); // Fora da tolerância + 50% perda

  assert.equal(scoreClean, 10.0);
  assert.ok(
    scoreClean > scoreLightNoise,
    `Esperado ${scoreClean} > ${scoreLightNoise}`
  );
  assert.ok(
    scoreLightNoise > scoreHeavyNoise,
    `Esperado ${scoreLightNoise} > ${scoreHeavyNoise}`
  );
  assert.ok(
    scoreHeavyNoise > scoreSevereNoise,
    `Esperado ${scoreHeavyNoise} > ${scoreSevereNoise}`
  );
  assert.ok(scoreSevereNoise >= 0);
});

test("3. Invariância de oitava (+12 e -12 semitons mantêm exatamente a mesma nota)", () => {
  const pitchMap = createSyntheticPitchMap();

  function runWithOctaveShift(semitoneShift) {
    const engine = createScoringEngine({
      pitchMap,
      difficulty: "hard",
      tolerances: TOLERANCES,
      pitchConfThreshold: 0.6,
      latencyOffsetMs: 0,
    });

    for (let i = 0; i < pitchMap.midi.length; i++) {
      const base = pitchMap.midi[i];
      engine.pushFrame({
        songTime: i * pitchMap.hop,
        midi: base === null ? null : base + semitoneShift,
      });
    }

    return engine.summary();
  }

  const original = runWithOctaveShift(0);
  const oneOctaveUp = runWithOctaveShift(12);
  const oneOctaveDown = runWithOctaveShift(-12);

  assert.equal(oneOctaveUp.score, original.score);
  assert.equal(oneOctaveDown.score, original.score);
  assert.equal(oneOctaveUp.best_streak, original.best_streak);
  assert.equal(oneOctaveDown.best_streak, original.best_streak);
});

test("4. Silêncio total resulta em nota 0.0", () => {
  const pitchMap = createSyntheticPitchMap();
  const engine = createScoringEngine({
    pitchMap,
    difficulty: "easy",
    tolerances: TOLERANCES,
    pitchConfThreshold: 0.6,
    latencyOffsetMs: 0,
  });

  for (let i = 0; i < pitchMap.midi.length; i++) {
    engine.pushFrame({
      songTime: i * pitchMap.hop,
      midi: null,
    });
  }

  const result = engine.summary();
  assert.equal(result.score, 0.0);
  assert.equal(result.coverage, 0);
  assert.equal(result.best_streak, 0);
});

test("5. Compensação de latência (+200 ms) restaura a nota original", () => {
  const pitchMap = createSyntheticPitchMap();
  const delaySeconds = 0.2; // 200 ms de atraso simulado

  // Sem compensação de latência: os frames chegam deslocados e a nota cai
  const uncompensated = createScoringEngine({
    pitchMap,
    difficulty: "hard",
    tolerances: TOLERANCES,
    pitchConfThreshold: 0.6,
    latencyOffsetMs: 0,
  });

  for (let i = 0; i < pitchMap.midi.length; i++) {
    uncompensated.pushFrame({
      songTime: i * pitchMap.hop + delaySeconds,
      midi: pitchMap.midi[i],
    });
  }

  // Com latencyOffsetMs = 200: o atraso é descontado e a nota volta a 10.0
  const compensated = createScoringEngine({
    pitchMap,
    difficulty: "hard",
    tolerances: TOLERANCES,
    pitchConfThreshold: 0.6,
    latencyOffsetMs: 200,
  });

  for (let i = 0; i < pitchMap.midi.length; i++) {
    compensated.pushFrame({
      songTime: i * pitchMap.hop + delaySeconds,
      midi: pitchMap.midi[i],
    });
  }

  assert.ok(
    uncompensated.summary().score < 10.0,
    "Sem compensação, o atraso de 200 ms deveria reduzir a pontuação"
  );
  assert.equal(compensated.summary().score, 10.0);
  assert.equal(compensated.summary().best_streak, 60);
});

test("6. Modo heurístico avalia estabilidade vocal e sinaliza baixa confiança", () => {
  const pitchMap = {
    ...createSyntheticPitchMap(),
    mode: "heuristic",
  };

  const engine = createScoringEngine({
    pitchMap,
    heuristicConfig: {
      stability_window_frames: 5,
      stability_tolerance_semitones: 1.5,
      full_score_coverage: 0.6,
    },
  });

  // Canta nota estável (MIDI 62) por 70 frames
  for (let i = 10; i < 80; i++) {
    engine.pushFrame({
      songTime: i * pitchMap.hop,
      midi: 62.0,
    });
  }

  const result = engine.summary();
  assert.equal(result.scoring_confidence, "low");
  assert.equal(result.score, 10.0);
});