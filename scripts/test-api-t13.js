/**
 * Testes automatizados de integração das rotas REST e SSE da T1.3.
 * Executar com: node --test scripts/test-api-t13.js
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../backend/server.js";
import { createCacheManager } from "../backend/services/cacheManager.js";
import { createLyricsService } from "../backend/services/lyricsService.js";
import { createProcessSupervisor } from "../backend/services/processSupervisor.js";
import { ROOT_DIR } from "../backend/utils/configLoader.js";

const FAKE_WORKER_PATH = path.join(ROOT_DIR, "scripts", "fake-worker.js");

test("Fluxo completo REST + SSE + Range + PATCH + Health funciona de ponta a ponta", async (t) => {
  const tempCache = fs.mkdtempSync(path.join(os.tmpdir(), "karaoke-api-t13-"));
  t.after(() => fs.rmSync(tempCache, { recursive: true, force: true }));

  const cacheManager = createCacheManager({ cacheRoot: tempCache });
  const supervisor = createProcessSupervisor({
    command: process.execPath,
    baseArgs: [FAKE_WORKER_PATH],
    env: { FAKE_WORKER_STEP_DELAY_MS: "15" },
  });

  // Simula LRCLIB devolvendo 2 candidatos de letra
  const lyricsService = createLyricsService({
    cacheManager,
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        {
          id: 101,
          trackName: "Música Teste",
          artistName: "Canal Teste",
          duration: 180,
          plainLyrics: "Linha 1\nLinha 2",
          syncedLyrics: "[00:05.00] Linha 1\n[00:10.00] Linha 2",
        },
        {
          id: 202,
          trackName: "Música Teste (Acústico)",
          artistName: "Canal Teste",
          duration: 195,
          plainLyrics: "Linha 1 acústica",
          syncedLyrics: null,
        },
      ],
    }),
  });

  const app = createApp({
    cacheManager,
    supervisor,
    lyricsService,
    doctorOptions: {
      command: process.execPath,
      baseArgs: [FAKE_WORKER_PATH],
    },
  });

  // Sobe o servidor em uma porta livre temporária (0)
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  // 1. POST /api/prepare com videoId inválido deve devolver 400
  const badPrep = await fetch(`${baseUrl}/api/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId: "../hack" }),
  });
  assert.equal(badPrep.status, 400);

  // 2. POST /api/prepare válido enfileira o job (202)
  const videoId = "abc123XYZ_0";
  const prepRes = await fetch(`${baseUrl}/api/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId }),
  });
  assert.equal(prepRes.status, 202);
  const prepJson = await prepRes.json();
  assert.equal(prepJson.videoId, videoId);
  assert.ok(prepJson.jobId);

  // 3. Acompanha o fluxo SSE em GET /api/jobs/:id/events até chegar em `ready`
  const sseRes = await fetch(`${baseUrl}/api/jobs/${prepJson.jobId}/events`);
  assert.equal(sseRes.status, 200);
  const sseText = await sseRes.text();
  assert.match(sseText, /"state":"ready"/);

  // 4. Novo POST /api/prepare para música já pronta retorna 200 `{ status: "ready" }`
  const readyAgain = await fetch(`${baseUrl}/api/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId }),
  });
  assert.equal(readyAgain.status, 200);
  assert.equal((await readyAgain.json()).status, "ready");

  // 5. GET /api/songs/:id retorna manifest com letra sincronizada selecionada e last_played preenchido
  const songRes = await fetch(`${baseUrl}/api/songs/${videoId}`);
  assert.equal(songRes.status, 200);
  const songData = await songRes.json();
  assert.equal(songData.manifest.lyrics.type, "synced");
  assert.equal(songData.manifest.lyrics.selected_id, 101);
  assert.ok(songData.manifest.user.last_played);

  // 6. GET /api/songs/:id/files/instrumental.flac com HTTP Range retorna 206 Partial Content
  const rangeRes = await fetch(`${baseUrl}/api/songs/${videoId}/files/instrumental.flac`, {
    headers: { Range: "bytes=0-3" },
  });
  assert.equal(rangeRes.status, 206);
  assert.equal(rangeRes.headers.get("content-range"), "bytes 0-3/14");
  assert.equal(await rangeRes.text(), "FAKE");

  // 7. Tentativa de escapar do diretório de cache devolve 400/404
  const traversalRes = await fetch(
    `${baseUrl}/api/songs/${videoId}/files/${encodeURIComponent("../manifest.json")}`
  );
  assert.equal(traversalRes.status, 400);

  // 8. PATCH /api/songs/:id atualiza offset_ms, selected_id e latency_offsets_ms
  const patchRes = await fetch(`${baseUrl}/api/songs/${videoId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      offset_ms: -250,
      selected_id: 202,
      latency_offsets_ms: { "mic-usb-1": 45 },
    }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.equal(patched.manifest.lyrics.offset_ms, -250);
  assert.equal(patched.manifest.lyrics.selected_id, 202);
  assert.equal(patched.manifest.lyrics.type, "plain");
  assert.equal(patched.manifest.user.latency_offsets_ms["mic-usb-1"], 45);

  // 9. GET /api/health executa o doctor e retorna status ok
  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.equal(healthData.status, "ok");
  assert.equal(healthData.worker.accelerator_detected, "cpu");
});