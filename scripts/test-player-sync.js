/**
 * Testes automatizados de LyricSync e YouTubePlayer escravo (T1.6).
 * Executar com: node --test scripts/test-player-sync.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createLyricSync, parseLrc } from "../frontend/src/player/lyricSync.js";
import { createYouTubePlayer } from "../frontend/src/player/youtubePlayer.js";

test("parseLrc interpreta timestamps simples, múltiplos e ignora metadados", () => {
  const sampleLrc = [
    "[ti:Música Exemplo]",
    "[ar:Artista Teste]",
    "[00:05.00] Primeira linha",
    "[00:10.50][00:45.25] Refrão repetido",
    "[00:15.000] Terceira linha",
  ].join("\n");

  const { lines } = parseLrc(sampleLrc);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[0], { time: 5.0, text: "Primeira linha" });
  assert.deepEqual(lines[1], { time: 10.5, text: "Refrão repetido" });
  assert.deepEqual(lines[2], { time: 15.0, text: "Terceira linha" });
  assert.deepEqual(lines[3], { time: 45.25, text: "Refrão repetido" });
});

test("LyricSync seleciona linha ativa, calcula progresso e aplica offset_ms", () => {
  const lyricSync = createLyricSync();
  lyricSync.loadCandidate({
    id: 42,
    syncedLyrics: [
      "[00:10.00] Linha A",
      "[00:14.00] Linha B",
      "[00:20.00] Linha C",
    ].join("\n"),
  });

  // Antes da primeira linha (t = 4s)
  const before = lyricSync.getStateAt(4.0);
  assert.equal(before.mode, "synced");
  assert.equal(before.currentIndex, -1);
  assert.equal(before.nextLine.text, "Linha A");

  // Meio da Linha A (t = 12s -> 50% entre 10s e 14s)
  const midA = lyricSync.getStateAt(12.0);
  assert.equal(midA.currentIndex, 0);
  assert.equal(midA.currentLine.text, "Linha A");
  assert.equal(midA.nextLine.text, "Linha B");
  assert.ok(Math.abs(midA.lineProgress - 0.5) < 0.001);

  // Aplica offset_ms = +2500ms (adianta 2.5s): em t = 12s o tempo efetivo vira 14.5s -> Linha B
  lyricSync.setOffsetMs(2500);
  const shifted = lyricSync.getStateAt(12.0);
  assert.equal(shifted.currentIndex, 1);
  assert.equal(shifted.currentLine.text, "Linha B");
});

test("LyricSync trata fallbacks plain e none corretamente", () => {
  const lyricSync = createLyricSync();

  // Fallback 1: plainLyrics apenas
  const plainMeta = lyricSync.loadCandidate({
    id: 77,
    syncedLyrics: null,
    plainLyrics: "Verso um\nVerso dois\nVerso três",
  });
  assert.equal(plainMeta.mode, "plain");
  assert.equal(plainMeta.lineCount, 3);
  assert.equal(lyricSync.getStateAt(10).currentIndex, -1);

  // Fallback 2: sem letra
  const noneMeta = lyricSync.loadCandidate(null);
  assert.equal(noneMeta.mode, "none");
  assert.equal(noneMeta.lineCount, 0);
  assert.deepEqual(lyricSync.getStateAt(10).lines, []);
});

test("YouTubePlayer permanece mudo e corrige deriva apenas acima do limite e fora do cooldown", async () => {
  let fakeClockMs = 1000;
  let mockYtTime = 10.0;
  let mockYtState = 2; // PAUSED
  let muted = false;
  const seeks = [];

  const mockYtApi = async () => ({
    Player: class MockPlayer {
      constructor(_el, config) {
        this.config = config;
        queueMicrotask(() => config.events?.onReady?.({ target: this }));
      }
      mute() {
        muted = true;
      }
      isMuted() {
        return muted;
      }
      setVolume() {}
      playVideo() {
        mockYtState = 1;
      }
      pauseVideo() {
        mockYtState = 2;
      }
      getPlayerState() {
        return mockYtState;
      }
      getCurrentTime() {
        return mockYtTime;
      }
      seekTo(sec) {
        seeks.push(sec);
        mockYtTime = sec;
      }
      destroy() {}
    },
  });

  const yt = createYouTubePlayer({
    driftThresholdSeconds: 0.45,
    minSeekIntervalMs: 1500,
    nowFn: () => fakeClockMs,
    ytApiProvider: mockYtApi,
  });

  const initRes = await yt.init("yt-container", "z2ZmXRkXREw");
  assert.equal(initRes.ok, true);
  assert.equal(muted, true);

  // Deriva pequena (10.2s vs 10.0s = 0.2s <= 0.45s): inicia play mas NÃO faz seekTo
  yt.syncToMaster(10.2, true);
  assert.equal(mockYtState, 1);
  assert.equal(seeks.length, 0);

  // Deriva grande (12.0s vs 10.0s = 2.0s > 0.45s): dispara seekTo
  yt.syncToMaster(12.0, true);
  assert.deepEqual(seeks, [12.0]);

  // Nova deriva grande 500ms depois (dentro do cooldown de 1500ms): NÃO dispara novo seekTo ainda
  fakeClockMs += 500;
  yt.syncToMaster(15.0, true);
  assert.deepEqual(seeks, [12.0]);

  // Após passar o cooldown (total +1600ms): dispara seekTo normalmente
  fakeClockMs += 1100;
  yt.syncToMaster(15.0, true);
  assert.deepEqual(seeks, [12.0, 15.0]);
});

test("YouTubePlayer degrada graciosamente se embed for bloqueado (erro 150)", async () => {
  const mockYtApi = async () => ({
    Player: class BlockedPlayer {
      constructor(_el, config) {
        queueMicrotask(() => config.events?.onError?.({ data: 150 }));
      }
      destroy() {}
    },
  });

  const yt = createYouTubePlayer({ ytApiProvider: mockYtApi });
  const res = await yt.init("yt-container", "blockedVideo");

  assert.equal(res.ok, false);
  assert.equal(yt.isAvailable(), false);
  assert.match(yt.getStatus().reason, /150/);
});