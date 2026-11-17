/**
 * Testes automatizados de ProcessSupervisor, CacheManager (LRU) e JobQueue (T1.2).
 * Executar com: node --test scripts/test-jobqueue.js
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCacheManager } from "../backend/services/cacheManager.js";
import { createJobQueue } from "../backend/services/jobQueue.js";
import { createProcessSupervisor } from "../backend/services/processSupervisor.js";
import { ROOT_DIR } from "../backend/utils/configLoader.js";

const FAKE_WORKER_PATH = path.join(ROOT_DIR, "scripts", "fake-worker.js");

function createTempCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "karaoke-t12-"));
}

test("Fila FIFO processa 1 job por vez e deduplica prepare do mesmo videoId", async (t) => {
  const tempCache = createTempCacheDir();
  t.after(() => fs.rmSync(tempCache, { recursive: true, force: true }));

  const cacheManager = createCacheManager({ cacheRoot: tempCache, maxSizeGb: 10 });
  const supervisor = createProcessSupervisor({
    command: process.execPath,
    baseArgs: [FAKE_WORKER_PATH],
    env: { FAKE_WORKER_STEP_DELAY_MS: "25" },
  });
  const queue = createJobQueue({ cacheManager, supervisor });

  const first = queue.enqueue("video111111");
  const duplicateFirst = queue.enqueue("video111111");
  const second = queue.enqueue("video222222");

  // Mesmo videoId deve devolver exatamente o mesmo jobId
  assert.equal(duplicateFirst.jobId, first.jobId);

  // Primeiro inicia imediatamente (`running`) e segundo fica aguardando (`queued`)
  assert.equal(first.status, "running");
  assert.equal(second.status, "queued");
  assert.equal(queue.getJobPublicState(second.jobId).position, 1);

  const [res1, res2] = await Promise.all([
    queue.waitForJob(first.jobId),
    queue.waitForJob(second.jobId),
  ]);

  assert.equal(res1.state, "ready");
  assert.equal(res2.state, "ready");
  assert.equal(cacheManager.isSongReady("video111111"), true);
  assert.equal(cacheManager.isSongReady("video222222"), true);

  // Pós-processamento deve ter preenchido manifest.lyrics e manifest.user
  const manifest1 = cacheManager.readManifest("video111111");
  assert.equal(manifest1.lyrics.type, "none");
  assert.deepEqual(manifest1.user.latency_offsets_ms, {});
});

test("Cancelamento interrompe o worker em execução e marca o job como canceled", async (t) => {
  const tempCache = createTempCacheDir();
  t.after(() => fs.rmSync(tempCache, { recursive: true, force: true }));

  const cacheManager = createCacheManager({ cacheRoot: tempCache, maxSizeGb: 10 });
  const supervisor = createProcessSupervisor({
    command: process.execPath,
    baseArgs: [FAKE_WORKER_PATH],
    env: { FAKE_WORKER_HANG_STEP: "separate" },
  });
  const queue = createJobQueue({ cacheManager, supervisor });

  const job = queue.enqueue("videoCancel");
  assert.equal(job.status, "running");

  // Aguarda brevemente o processo filho iniciar e solicita cancelamento
  await new Promise((r) => setTimeout(r, 40));
  const cancelRes = await queue.cancelJob(job.jobId);

  assert.equal(cancelRes.state, "canceled");
  assert.equal(queue.getJobPublicState(job.jobId).state, "canceled");
  assert.equal(queue.hasActiveJob("videoCancel"), false);
});

test("Timeout por etapa encerra worker travado e marca o job como failed", async (t) => {
  const tempCache = createTempCacheDir();
  t.after(() => fs.rmSync(tempCache, { recursive: true, force: true }));

  const cacheManager = createCacheManager({ cacheRoot: tempCache, maxSizeGb: 10 });
  const supervisor = createProcessSupervisor({
    command: process.execPath,
    baseArgs: [FAKE_WORKER_PATH],
    stepTimeoutMs: 80, // timeout curto para teste
    env: { FAKE_WORKER_HANG_STEP: "separate" },
  });
  const queue = createJobQueue({ cacheManager, supervisor });

  const job = queue.enqueue("videoTime01");
  const finalState = await queue.waitForJob(job.jobId);

  assert.equal(finalState.state, "failed");
  assert.equal(finalState.error.code, "STEP_TIMEOUT");
  assert.equal(finalState.error.retryable, true);
});

test("Retomada pula etapas já registradas em steps_done do manifest.json", async (t) => {
  const tempCache = createTempCacheDir();
  t.after(() => fs.rmSync(tempCache, { recursive: true, force: true }));

  const cacheManager = createCacheManager({ cacheRoot: tempCache, maxSizeGb: 10 });
  const supervisor = createProcessSupervisor({
    command: process.execPath,
    baseArgs: [FAKE_WORKER_PATH],
    env: { FAKE_WORKER_STEP_DELAY_MS: "10" },
  });
  const queue = createJobQueue({ cacheManager, supervisor });

  // Simula manifest interrompido logo após `separate`
  const videoId = "videoResume";
  cacheManager.writeManifestAtomic(videoId, {
    schema_version: 1,
    video_id: videoId,
    status: "running",
    steps_done: ["download", "separate"],
    source: { title: "Retomada Teste", channel: "Canal", duration: 120 },
    pipeline: {
      separation_model: "UVR_MDXNET_KARA_2.onnx",
      pitch_extractor: "pyin",
      device_used: "cpu",
      worker_contract_version: 1,
    },
    files: {},
    metrics: {},
  });

  const job = queue.enqueue(videoId);
  const finalState = await queue.waitForJob(job.jobId);

  assert.equal(finalState.state, "ready");
  assert.equal(cacheManager.isSongReady(videoId), true);
});

test("CacheManager aplica limpeza LRU removendo a música menos recente", (t) => {
  const tempCache = createTempCacheDir();
  t.after(() => fs.rmSync(tempCache, { recursive: true, force: true }));

  const cacheManager = createCacheManager({ cacheRoot: tempCache, maxSizeGb: 10 });

  const createDummySong = (videoId, lastPlayedIso) => {
    const dir = cacheManager.ensureSongDir(videoId);
    fs.writeFileSync(path.join(dir, "instrumental.flac"), "X".repeat(1000));
    fs.writeFileSync(path.join(dir, "vocals.flac"), "Y".repeat(1000));
    fs.writeFileSync(path.join(dir, "pitch_map.json"), "{}");
    cacheManager.writeManifestAtomic(videoId, {
      schema_version: 1,
      video_id: videoId,
      status: "ready",
      steps_done: ["download", "separate", "pitch", "analyze", "package"],
      files: {
        instrumental: "instrumental.flac",
        vocals: "vocals.flac",
        pitch_map: "pitch_map.json",
      },
      user: { latency_offsets_ms: {}, last_played: lastPlayedIso },
    });
  };

  createDummySong("songOldest1", "2026-01-01T10:00:00.000Z");
  createDummySong("songNewest2", "2026-11-17T10:00:00.000Z");

  // Define limite menor que o tamanho das 2 músicas juntas, mas suficiente para 1
  const singleSongSize = cacheManager.getSongSizeBytes("songNewest2");
  const lruRes = cacheManager.enforceLru({ maxBytes: singleSongSize + 100 });

  assert.deepEqual(lruRes.removed, ["songOldest1"]);
  assert.equal(cacheManager.isSongReady("songOldest1"), false);
  assert.equal(cacheManager.isSongReady("songNewest2"), true);
});