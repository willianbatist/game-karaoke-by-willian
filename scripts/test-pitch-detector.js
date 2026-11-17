/**
 * Testes automatizados do detector de pitch YIN (T2.1).
 * Executar com: node --test scripts/test-pitch-detector.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import { detectPitchYin, freqToMidi, midiToNoteName } from "../frontend/src/audio/yinDetector.js";

function generateSineWave(freq, sampleRate, length, amplitude = 0.5) {
  const buf = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    buf[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return buf;
}

test("detectPitchYin identifica A4 (440 Hz -> MIDI 69) com precisão sub-semitom", () => {
  const sampleRate = 48000;
  const samples = generateSineWave(440, sampleRate, 2048, 0.5);

  const result = detectPitchYin(samples, sampleRate);
  assert.equal(result.voiced, true);
  assert.ok(Math.abs(result.freq - 440) < 0.5, `Esperado ~440 Hz, obtido ${result.freq}`);
  assert.ok(Math.abs(result.midi - 69.0) < 0.05);
  assert.equal(midiToNoteName(result.midi), "A4");
  assert.ok(result.clarity > 0.95);
});

test("detectPitchYin identifica notas graves e agudas da voz humana (C3 e E5)", () => {
  const sampleRate = 44100;

  // C3 = 130.8128 Hz -> MIDI 48
  const c3Samples = generateSineWave(130.8128, sampleRate, 2048, 0.4);
  const resC3 = detectPitchYin(c3Samples, sampleRate);
  assert.equal(resC3.voiced, true);
  assert.ok(Math.abs(resC3.midi - 48.0) < 0.05);
  assert.equal(midiToNoteName(resC3.midi), "C3");

  // E5 = 659.255 Hz -> MIDI 76
  const e5Samples = generateSineWave(659.255, sampleRate, 2048, 0.4);
  const resE5 = detectPitchYin(e5Samples, sampleRate);
  assert.equal(resE5.voiced, true);
  assert.ok(Math.abs(resE5.midi - 76.0) < 0.05);
  assert.equal(midiToNoteName(resE5.midi), "E5");
});

test("detectPitchYin descarta silêncio e ruído branco aperiódico", () => {
  const sampleRate = 48000;

  // Silêncio / ruído muito baixo
  const quiet = generateSineWave(440, sampleRate, 2048, 0.001);
  const resQuiet = detectPitchYin(quiet, sampleRate, { rmsThreshold: 0.01 });
  assert.equal(resQuiet.voiced, false);
  assert.equal(resQuiet.midi, null);

  // Ruído pseudo-aleatório determinístico (sem periodicidade)
  const noise = new Float32Array(2048);
  let seed = 123456;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    noise[i] = ((seed / 0xffffffff) * 2 - 1) * 0.3;
  }
  const resNoise = detectPitchYin(noise, sampleRate);
  assert.equal(resNoise.voiced, false);
  assert.equal(freqToMidi(0), null);
});