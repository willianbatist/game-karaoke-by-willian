/**
 * Testes automatizados da T4.2 — Serviço de Compatibilidade (Pré, Pós-análise e Rotas HTTP).
 * Executar no WSL2: node --test scripts/test-compatibility.js
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createPrepareRouter } from "../backend/routes/prepare.js";
import { createSongsRouter } from "../backend/routes/songs.js";
import { createCacheManager } from "../backend/services/cacheManager.js";
import { createCompatibilityService } from "../backend/services/compatibilityService.js";
import { errorHandler } from "../backend/utils/errors.js";

test("lyrics_sync_quality calcula corretamente synced, plain e none", () => {
  const service = createCompatibilityService();

  // Sem letra -> 0.0
  const noneRes = service.computeLyricsSyncQuality(null, 200);
  assert.equal(noneRes.type, "none");
  assert.equal(noneRes.sync_quality, 0.0);

  // Letra apenas em texto plano -> 0.3
  const plainRes = service.computeLyricsSyncQuality(
    { id: 10, plainLyrics: "Linha 1\nLinha 2", duration: 200 },
    200
  );
  assert.equal(plainRes.type, "plain");
  assert.equal(plainRes.sync_quality, 0.3);

  // Letra sincronizada dentro da tolerância ideal (<= 2s) -> 1.0
  const bestSynced = service.computeLyricsSyncQuality(
    { id: 11, syncedLyrics: "[00:10.00] Linha 1", duration: 201 },
    200
  );
  assert.equal(bestSynced.type, "synced");
  assert.equal(bestSynced.sync_quality, 1.0);

  // Letra sincronizada no limite pior (>= 15s de diferença) -> 0.4
  const worstSynced = service.computeLyricsSyncQuality(
    { id: 12, syncedLyrics: "[00:10.00] Linha 1", duration: 220 },
    200
  );
  assert.equal(worstSynced.type, "synced");
  assert.equal(worstSynced.sync_quality, 0.4);

  // Interpolação intermediária (delta = 8.5s -> metade entre 2s e 15s -> 0.7)
  const midSynced = service.computeLyricsSyncQuality(
    { id: 13, syncedLyrics: "[00:10.00] Linha 1", duration: 208.5 },
    200
  );
  assert.equal(midSynced.type, "synced");
  assert.equal(midSynced.sync_quality, 0.7);
});

test("Pré-análise (Fase 1) aplica penalidades, respeita piso low e roda em < 50 ms", () => {
  const service = createCompatibilityService();

  const start = performance.now();
  const clean = service.evaluatePreAnalysis({
    title: "Marina Sena - Numa Ilha (Clipe Oficial)",
    channel: "Marina Sena",
    duration: 210,
    lyricsCandidate: {
      id: 1,
      duration: 211,
      syncedLyrics: "[00:12.00] Numa ilha",
    },
  });
  const elapsedMs = performance.now() - start;

  assert.ok(elapsedMs < 50, `Pré-análise demorou ${elapsedMs}ms (limite: 50ms)`);
  assert.equal(clean.provisional, true);
  assert.equal(clean.level, "excellent");
  assert.equal(clean.score, 1);
  assert.deepEqual(clean.reasons, []);

  // Versão Ao Vivo sem letra encontrada
  const liveNoLyrics = service.evaluatePreAnalysis({
    title: "Chitãozinho & Xororó - Evidências (Ao Vivo)",
    channel: "CH&X Oficial",
    duration: 280,
    lyricsCandidate: null,
  });
  assert.equal(liveNoLyrics.level, "good"); // 1 - 0.15 (ao vivo) - 0.15 (sem letra) = 0.70
  assert.equal(liveNoLyrics.score, 0.7);
  assert.equal(liveNoLyrics.reasons.length, 2);

  // Instrumental + duração anômala + sem letra -> nunca retorna incompatible, piso é low
  const instrumentalLong = service.evaluatePreAnalysis({
    title: "Relaxing Piano Instrumental Loop",
    channel: "Study Beats",
    duration: 900,
    lyricsCandidate: null,
  });
  assert.equal(instrumentalLong.level, "low");
  assert.equal(instrumentalLong.score, 0);
  assert.equal(instrumentalLong.provisional, true);
});

test("Pós-análise (Fase 2) classifica todos os níveis e regras de incompatibilidade", () => {
  const service = createCompatibilityService();

  const syncedLyrics = {
    selected_id: 50,
    candidates: [{ id: 50, duration: 200, syncedLyrics: "[00:05.00] Verso 1" }],
  };

  // 1. Excellent (>= 0.78)
  const exc = service.evaluatePostAnalysis(
    {
      source: { duration: 200 },
      metrics: {
        voiced_ratio: 0.75,
        mean_confidence: 0.9,
        vocal_energy_ratio: 0.45,
        bleed_estimate: 0.08,
        backing_vocals_estimate: 0.1,
        pitch_stability: 0.92,
      },
    },
    syncedLyrics
  );
  assert.equal(exc.compatibility.level, "excellent");
  assert.equal(exc.compatibility.provisional, false);
  assert.ok(exc.compatibility.score >= 0.78);

  // 2. Good (>= 0.62 e < 0.78)
  const good = service.evaluatePostAnalysis(
    {
      source: { duration: 200 },
      metrics: {
        voiced_ratio: 0.55,
        mean_confidence: 0.72,
        vocal_energy_ratio: 0.35,
        bleed_estimate: 0.25,
        backing_vocals_estimate: 0.3,
        pitch_stability: 0.75,
      },
    },
    syncedLyrics
  );
  assert.equal(good.compatibility.level, "good");
  assert.ok(good.compatibility.score >= 0.62 && good.compatibility.score < 0.78);

  // 3. Regular (>= 0.48 e < 0.62) com motivo de backing vocals e letra sem sincronia
  const regular = service.evaluatePostAnalysis(
    {
      source: { duration: 200 },
      metrics: {
        voiced_ratio: 0.48,
        mean_confidence: 0.6,
        vocal_energy_ratio: 0.3,
        bleed_estimate: 0.35,
        backing_vocals_estimate: 0.65,
        pitch_stability: 0.65,
      },
    },
    { selected_id: 51, candidates: [{ id: 51, plainLyrics: "Texto sem tempo" }] }
  );
  assert.equal(regular.compatibility.level, "regular");
  assert.ok(regular.compatibility.reasons.includes("Muitas vozes de apoio"));
  assert.ok(regular.compatibility.reasons.includes("Letra sem sincronização"));

  // 4. Low (>= 0.30 e < 0.48 -> score = 0.35)
  const low = service.evaluatePostAnalysis(
    {
      source: { duration: 200 },
      metrics: {
        voiced_ratio: 0.32,
        mean_confidence: 0.45,
        vocal_energy_ratio: 0.25,
        bleed_estimate: 0.6,
        backing_vocals_estimate: 0.6,
        pitch_stability: 0.5,
      },
    },
    null
  );
  assert.equal(low.compatibility.level, "low");
  assert.ok(low.compatibility.score >= 0.3 && low.compatibility.score < 0.48);

  // 5. Incompatible por voiced_ratio < 0.05
  const incompVoiced = service.evaluatePostAnalysis(
    {
      source: { duration: 200 },
      metrics: {
        voiced_ratio: 0.02,
        mean_confidence: 0.85,
        vocal_energy_ratio: 0.4,
        bleed_estimate: 0.1,
        backing_vocals_estimate: 0.1,
        pitch_stability: 0.9,
      },
    },
    syncedLyrics
  );
  assert.equal(incompVoiced.compatibility.level, "incompatible");
  assert.ok(incompVoiced.compatibility.reasons.includes("Poucos trechos com voz detectável"));

  // 6. Incompatible por pitch_map.mode === "heuristic" (faixa já instrumental)
  const incompHeuristic = service.evaluatePostAnalysis(
    {
      source: { duration: 200 },
      metrics: {
        voiced_ratio: 0.4,
        mean_confidence: 0.8,
        vocal_energy_ratio: 0.02,
        bleed_estimate: 0.1,
        backing_vocals_estimate: 0.1,
        pitch_stability: 0.85,
      },
    },
    syncedLyrics,
    { pitchMapMode: "heuristic" }
  );
  assert.equal(incompHeuristic.compatibility.level, "incompatible");
  assert.equal(incompHeuristic.compatibility.reasons[0], "Faixa aparentemente já instrumental");
});

test("applyPostAnalysisToSong persiste compatibility e sync_quality no manifest.json", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "karaoke-compat-"));
  try {
    const cacheManager = createCacheManager({ cacheRoot: tmpRoot });
    const compatibilityService = createCompatibilityService({ cacheManager });
    const videoId = "abc123XYZ_0";
    const songDir = cacheManager.ensureSongDir(videoId);

    fs.writeFileSync(
      path.join(songDir, "pitch_map.json"),
      JSON.stringify({ schema_version: 1, mode: "reference", midi: [60], conf: [0.9] })
    );
    fs.writeFileSync(
      path.join(songDir, "lyrics.json"),
      JSON.stringify({
        schema_version: 1,
        selected_id: 99,
        candidates: [{ id: 99, duration: 180, syncedLyrics: "[00:01.00] Oi" }],
      })
    );

    cacheManager.writeManifestAtomic(videoId, {
      schema_version: 1,
      video_id: videoId,
      status: "ready",
      source: { title: "Teste", channel: "Canal", duration: 180 },
      files: {
        instrumental: "instrumental.flac",
        vocals: "vocals.flac",
        pitch_map: "pitch_map.json",
      },
      metrics: {
        voiced_ratio: 0.72,
        mean_confidence: 0.88,
        vocal_energy_ratio: 0.4,
        bleed_estimate: 0.1,
        backing_vocals_estimate: 0.12,
        pitch_stability: 0.9,
      },
    });

    const applied = compatibilityService.applyPostAnalysisToSong(videoId);
    assert.ok(applied);
    assert.equal(applied.compatibility.level, "excellent");

    const updatedManifest = cacheManager.readManifest(videoId);
    assert.equal(updatedManifest.compatibility.level, "excellent");
    assert.equal(updatedManifest.lyrics.sync_quality, 1);
    assert.equal(updatedManifest.lyrics.type, "synced");
    assert.ok(updatedManifest.user);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("Rotas HTTP: POST /api/prepare (pré-análise) e PATCH /api/songs/:id (recalcula compatibilidade)", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "karaoke-compat-http-"));
  const cacheManager = createCacheManager({ cacheRoot: tmpRoot });
  const compatibilityService = createCompatibilityService({ cacheManager });

  const fakeJobQueue = {
    enqueue(videoId) {
      return { status: "queued", jobId: "job-test-1", videoId };
    },
    hasActiveJob() {
      return false;
    },
  };

  const fakeLyricsService = {
    async searchCandidates() {
      return {
        candidates: [{ id: 77, duration: 210, syncedLyrics: "[00:05.00] Letra" }],
      };
    },
    selectBestCandidate(candidates) {
      return candidates[0] ?? null;
    },
  };

  // Prepara uma música já pronta no cache (ID com 11 caracteres) para testar PATCH /api/songs/:id
  const readyId = "readySong01";
  const songDir = cacheManager.ensureSongDir(readyId);
  fs.writeFileSync(path.join(songDir, "instrumental.flac"), "fake");
  fs.writeFileSync(path.join(songDir, "vocals.flac"), "fake");
  fs.writeFileSync(
    path.join(songDir, "pitch_map.json"),
    JSON.stringify({ schema_version: 1, mode: "reference", midi: [60], conf: [0.9] })
  );
  fs.writeFileSync(
    path.join(songDir, "lyrics.json"),
    JSON.stringify({
      schema_version: 1,
      selected_id: 1,
      candidates: [
        { id: 1, duration: 200, syncedLyrics: "[00:02.00] Sincronizada" },
        { id: 2, duration: 200, plainLyrics: "Apenas texto simples" },
      ],
    })
  );
  cacheManager.writeManifestAtomic(readyId, {
    schema_version: 1,
    video_id: readyId,
    status: "ready",
    source: { title: "Música Teste", channel: "Artista", duration: 200 },
    files: {
      instrumental: "instrumental.flac",
      vocals: "vocals.flac",
      pitch_map: "pitch_map.json",
    },
    metrics: {
      voiced_ratio: 0.7,
      mean_confidence: 0.85,
      vocal_energy_ratio: 0.4,
      bleed_estimate: 0.1,
      backing_vocals_estimate: 0.1,
      pitch_stability: 0.88,
    },
    lyrics: { source: "lrclib", type: "synced", selected_id: 1, offset_ms: 0, sync_quality: 1.0 },
  });

  const app = express();
  app.use(express.json());
  app.use(
    "/api/prepare",
    createPrepareRouter({
      jobQueue: fakeJobQueue,
      lyricsService: fakeLyricsService,
      compatibilityService,
      fetchVideoMetadata: async () => null,
    })
  );
  app.use("/api/songs", createSongsRouter({ cacheManager, jobQueue: fakeJobQueue, compatibilityService }));
  app.use(errorHandler);

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. POST /api/prepare com metadados -> retorna compatibility provisória
    const resWithMeta = await fetch(`${baseUrl}/api/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: "newSongId01",
        title: "Artista - Música (Ao Vivo)",
        channel: "Artista",
        duration: 210,
      }),
    });
    assert.equal(resWithMeta.status, 202);
    const bodyWithMeta = await resWithMeta.json();
    assert.equal(bodyWithMeta.compatibility.provisional, true);
    assert.equal(bodyWithMeta.compatibility.level, "excellent"); // 1 - 0.15 = 0.85 >= 0.78

    // 2. POST /api/prepare sem metadados -> retorna compatibility: null
    const resNoMeta = await fetch(`${baseUrl}/api/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: "newSongId02" }),
    });
    assert.equal(resNoMeta.status, 202);
    const bodyNoMeta = await resNoMeta.json();
    assert.equal(bodyNoMeta.compatibility, null);

    // 3. PATCH /api/songs/:id trocando para letra plain (id: 2) -> reduz sync_quality para 0.3
    const resPatch = await fetch(`${baseUrl}/api/songs/${readyId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lyrics: { selected_id: 2, offset_ms: -250 } }),
    });
    assert.equal(resPatch.status, 200);
    const patched = await resPatch.json();
    assert.equal(patched.manifest.lyrics.selected_id, 2);
    assert.equal(patched.manifest.lyrics.type, "plain");
    assert.equal(patched.manifest.lyrics.sync_quality, 0.3);
    assert.equal(patched.manifest.lyrics.offset_ms, -250);
    assert.equal(patched.manifest.compatibility.provisional, false);
    assert.ok(patched.manifest.compatibility.reasons.includes("Letra sem sincronização"));
  } finally {
    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});