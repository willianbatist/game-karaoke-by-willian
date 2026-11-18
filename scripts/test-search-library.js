/**
 * Teste de integração da T4.1 (Busca no YouTube e Biblioteca / Exclusão).
 * Roda em cache temporário isolado e sem depender de rede externa.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../backend/server.js";
import { createCacheManager } from "../backend/services/cacheManager.js";
import { createYoutubeSearchService } from "../backend/services/youtubeSearchService.js";

function seedReadySong(cacheDir, videoId, title, channel, lastPlayed = null) {
  const dir = path.join(cacheDir, videoId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "instrumental.flac"), "FAKE_FLAC_INST");
  fs.writeFileSync(path.join(dir, "vocals.flac"), "FAKE_FLAC_VOC");
  fs.writeFileSync(path.join(dir, "pitch_map.json"), JSON.stringify({ frames: [] }));
  fs.writeFileSync(
    path.join(dir, "lyrics.json"),
    JSON.stringify({ selected_id: 1, candidates: [] })
  );
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      video_id: videoId,
      status: "ready",
      created_at: "2026-11-18T00:00:00.000Z",
      source: { title, channel, duration: 215 },
      lyrics: { source: "lrclib", type: "synced", selected_id: 1, offset_ms: 0 },
      user: { latency_offsets_ms: {}, last_played: lastPlayed },
    })
  );
}

async function run() {
  const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), "karaoke-t41-"));
  let server;

  try {
    seedReadySong(
      tmpCache,
      "dQw4w9WgXcQ",
      "Never Gonna Give You Up",
      "Rick Astley",
      "2026-11-18T02:00:00.000Z"
    );
    seedReadySong(
      tmpCache,
      "9bZkp7q19f0",
      "Gangnam Style",
      "officialpsy",
      "2026-11-18T01:00:00.000Z"
    );

    const cacheManager = createCacheManager({ cacheRoot: tmpCache, maxSizeGb: 5 });

    const mockSearchService = createYoutubeSearchService({
      cacheManager,
      execRunner: async (_bin, args) => {
        const target = args[args.length - 1];
        assert.ok(target.includes("Rick Astley"), "Deve repassar o termo de busca");
        return {
          stdout: JSON.stringify({
            entries: [
              {
                id: "dQw4w9WgXcQ",
                title: "Rick Astley - Never Gonna Give You Up",
                channel: "Rick Astley",
                duration: 213,
              },
              {
                id: "kJQP7kiw5Fk",
                title: "Luis Fonsi - Despacito",
                channel: "LuisFonsiVEVO",
                duration: 282,
              },
            ],
          }),
          stderr: "",
        };
      },
    });

    const app = createApp({
      cacheRoot: tmpCache,
      cacheManager,
      youtubeSearchService: mockSearchService,
      jobQueue: {
        hasActiveJob: () => false,
        registerOnJobDone: () => {},
        runPostProcess: async () => {},
      },
    });

    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    // 1. Busca válida retorna isCached corretamente
    const searchRes = await fetch(`${baseUrl}/api/search?q=Rick%20Astley`);
    assert.equal(searchRes.status, 200);
    const searchJson = await searchRes.json();
    assert.equal(searchJson.results.length, 2);
    assert.equal(searchJson.results[0].isCached, true);
    assert.equal(searchJson.results[1].isCached, false);

    // 2. Busca vazia retorna 400
    const badSearch = await fetch(`${baseUrl}/api/search?q=`);
    assert.equal(badSearch.status, 400);

    // 3. Biblioteca lista músicas com sizeBytes e filtro ?q=
    const libRes = await fetch(`${baseUrl}/api/songs`);
    assert.equal(libRes.status, 200);
    const libJson = await libRes.json();
    assert.equal(libJson.totalCount, 2);
    assert.ok(libJson.totalSizeBytes > 0);

    const filteredRes = await fetch(`${baseUrl}/api/songs?q=gangnam`);
    const filteredJson = await filteredRes.json();
    assert.equal(filteredJson.totalCount, 1);
    assert.equal(filteredJson.songs[0].videoId, "9bZkp7q19f0");

    // 4. Exclusão de música (DELETE /api/songs/:id)
    const delRes = await fetch(`${baseUrl}/api/songs/9bZkp7q19f0`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    const delJson = await delRes.json();
    assert.equal(delJson.deleted, true);
    assert.equal(fs.existsSync(path.join(tmpCache, "9bZkp7q19f0")), false);

    // 5. Excluir novamente retorna 404
    const delAgain = await fetch(`${baseUrl}/api/songs/9bZkp7q19f0`, { method: "DELETE" });
    assert.equal(delAgain.status, 404);

    console.log("OK: Todos os testes da T4.1 (Busca e Biblioteca) passaram!");
  } finally {
    if (server) server.close();
    fs.rmSync(tmpCache, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error("FALHA nos testes T4.1:", err);
  process.exit(1);
});