/**
 * Testes automatizados do AudioEngine (T1.5).
 * Executar com: node --test scripts/test-audio-engine.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createAudioEngine } from "../frontend/src/audio/audioEngine.js";

function createMockAudioEnvironment(trackDuration = 120) {
  const startedNodes = [];
  const createdGains = [];

  class FakeAudioContext {
    constructor() {
      this.currentTime = 10.0; // relógio inicial arbitrário
      this.state = "running";
      this.destination = { kind: "destination" };
    }

    createGain() {
      const gainNode = {
        gain: {
          value: 1,
          setTargetAtTime(val) {
            this.value = val;
          },
        },
        connect() {},
      };
      createdGains.push(gainNode);
      return gainNode;
    }

    createBufferSource() {
      const node = {
        buffer: null,
        onended: null,
        startedAt: null,
        offset: null,
        stopped: false,
        connect() {},
        start(when, offset) {
          this.startedAt = when;
          this.offset = offset;
          startedNodes.push(this);
        },
        stop() {
          this.stopped = true;
          if (typeof this.onended === "function") {
            this.onended();
          }
        },
        disconnect() {},
      };
      return node;
    }

    async decodeAudioData() {
      return { duration: trackDuration };
    }

    async resume() {
      this.state = "running";
    }

    async close() {
      this.state = "closed";
    }
  }

  const fakeFetch = async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(16),
  });

  return { FakeAudioContext, fakeFetch, startedNodes, createdGains };
}

test("AudioEngine inicia instrumental e vocals no mesmo timestamp e calcula getCurrentTime corretamente", async () => {
  const { FakeAudioContext, fakeFetch, startedNodes } = createMockAudioEnvironment(180);

  const engine = createAudioEngine({
    AudioContextClass: FakeAudioContext,
    fetchImpl: fakeFetch,
  });

  await engine.loadSong("z2ZmXRkXREw");
  assert.equal(engine.getState(), "ready");
  assert.equal(engine.getDuration(), 180);

  await engine.play();
  assert.equal(engine.getState(), "playing");

  // Ambos os stems (instrumental e vocals) devem ter sido agendados exatamente juntos
  assert.equal(startedNodes.length, 2);
  assert.equal(startedNodes[0].startedAt, startedNodes[1].startedAt);
  assert.equal(startedNodes[0].offset, 0);
  assert.equal(startedNodes[1].offset, 0);

  // Avança o relógio do AudioContext em 5.015s (0.015s de agendamento + 5.0s de música)
  const ctx = engine.getContext();
  ctx.currentTime += 5.015;
  assert.ok(Math.abs(engine.getCurrentTime() - 5.0) < 0.001);

  await engine.destroy();
});

test("AudioEngine preserva offset_seek ao pausar, retomar e fazer seek sem falso ended", async () => {
  const { FakeAudioContext, fakeFetch, startedNodes } = createMockAudioEnvironment(150);
  let endedCount = 0;

  const engine = createAudioEngine({
    AudioContextClass: FakeAudioContext,
    fetchImpl: fakeFetch,
    onEnded: () => {
      endedCount++;
    },
  });

  await engine.loadSong("z2ZmXRkXREw");
  await engine.play();

  const ctx = engine.getContext();
  ctx.currentTime += 10.015; // avança para 10s
  engine.pause();

  assert.equal(engine.getState(), "paused");
  assert.ok(Math.abs(engine.getCurrentTime() - 10.0) < 0.001);
  assert.equal(endedCount, 0);

  // Seek para 42.5s enquanto pausado e depois retoma
  await engine.seek(42.5);
  assert.equal(engine.getCurrentTime(), 42.5);

  await engine.play();
  const lastTwo = startedNodes.slice(-2);
  assert.equal(lastTwo[0].offset, 42.5);
  assert.equal(lastTwo[1].offset, 42.5);
  assert.equal(endedCount, 0);

  // Seek durante reprodução ativa (de 42.5s para 90s)
  await engine.seek(90);
  assert.equal(engine.getState(), "playing");
  const afterSeekTwo = startedNodes.slice(-2);
  assert.equal(afterSeekTwo[0].offset, 90);
  assert.equal(afterSeekTwo[1].offset, 90);
  assert.equal(endedCount, 0);

  await engine.destroy();
});

test("AudioEngine ajusta volumes de instrumental e voz guia independentemente", async () => {
  const { FakeAudioContext, fakeFetch, createdGains } = createMockAudioEnvironment(100);

  const engine = createAudioEngine({
    AudioContextClass: FakeAudioContext,
    fetchImpl: fakeFetch,
  });

  await engine.loadSong("z2ZmXRkXREw");
  assert.deepEqual(engine.getStemVolumes(), { instrumental: 1.0, vocals: 0.0 });

  engine.setStemVolumes({ instrumental: 0.85, vocals: 0.35 });
  assert.deepEqual(engine.getStemVolumes(), { instrumental: 0.85, vocals: 0.35 });
  assert.equal(createdGains[0].gain.value, 0.85);
  assert.equal(createdGains[1].gain.value, 0.35);

  await engine.destroy();
});