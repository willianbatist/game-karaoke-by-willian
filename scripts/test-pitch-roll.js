/**
 * Testes automatizados das funções de geometria e rastro do PitchRollCanvas (T2.4).
 * Executar com: node --test scripts/test-pitch-roll.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  mapMidiToY,
  mapTimeToX,
  prunePitchTrail,
} from "../frontend/src/player/pitchRollCanvas.js";

test("mapTimeToX posiciona o playhead e projeta passado e futuro proporcionalmente", () => {
  const width = 1000;
  const opts = { playheadRatio: 0.25, windowDurationSec: 4.0 }; // 250 px/s, playhead em x=250

  assert.equal(mapTimeToX(10.0, 10.0, width, opts), 250);
  assert.equal(mapTimeToX(12.0, 10.0, width, opts), 750); // +2s -> +500px
  assert.equal(mapTimeToX(9.0, 10.0, width, opts), 0); // -1s -> 0px
});

test("mapMidiToY coloca notas agudas no topo e graves na base respeitando margem", () => {
  const height = 200;
  const pad = 20;

  // Nota máxima (72) -> topo (y = 20)
  assert.equal(mapMidiToY(72, 48, 72, height, pad), 20);
  // Nota mínima (48) -> base (y = 180)
  assert.equal(mapMidiToY(48, 48, 72, height, pad), 180);
  // Nota central (60) -> meio (y = 100)
  assert.equal(mapMidiToY(60, 48, 72, height, pad), 100);
});

test("prunePitchTrail remove apenas pontos antigos fora da janela visível", () => {
  const trail = [
    { time: 1.0, midi: 60, status: "perfect" },
    { time: 2.0, midi: 62, status: "great" },
    { time: 3.5, midi: 64, status: "perfect" },
    { time: 4.0, midi: 65, status: "good" },
  ];

  prunePitchTrail(trail, 2.5);
  assert.equal(trail.length, 2);
  assert.equal(trail[0].time, 3.5);
  assert.equal(trail[1].time, 4.0);
});