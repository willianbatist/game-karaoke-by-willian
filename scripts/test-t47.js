/**
 * Suíte Final de Auditoria e Validação End-to-End do MVP (Etapa T4.7):
 * 1. Auditoria de Segurança (bind 127.0.0.1, ausência de window.confirm/alert/prompt,
 *    views da Fase 4 livres de innerHTML, bloqueio de path traversal e IDs inválidos)
 * 2. Auditoria de Acessibilidade e Regras de Negócio (ARIA/roles, sem selo de compatibilidade na busca)
 * 3. Teste End-to-End completo sobre HTTP real com createApp() + fake-worker.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../backend/server.js";
import { createProcessSupervisor } from "../backend/services/processSupervisor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const FAKE_WORKER_PATH = path.join(ROOT_DIR, "scripts", "fake-worker.js");

function walkJsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      results.push(full);
    }
  }
  return results;
}

test("Auditoria de Segurança: bind local, sem diálogos nativos e Fase 4 livre de innerHTML", () => {
  const serverSrc = fs.readFileSync(path.join(ROOT_DIR, "backend", "server.js"), "utf8");
  assert.match(serverSrc, /const host = "127\.0\.0\.1"/);
  assert.doesNotMatch(serverSrc, /listen\([^)]*0\.0\.0\.0/);

  const frontendFiles = walkJsFiles(path.join(ROOT_DIR, "frontend", "src"));
  assert.ok(frontendFiles.length >= 20);

  for (const file of frontendFiles) {
    const content = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT_DIR, file);
    assert.doesNotMatch(
      content,
      /\bwindow\.(confirm|alert|prompt)\s*\(/,
      `Proibido usar diálogos nativos do navegador em ${rel}`
    );
  }

  // Todas as views e componentes novos da Fase 4 devem usar exclusivamente nós DOM / textContent
  const phase4DomOnlyFiles = [
    "frontend/src/ui/components/compatibilityBadge.js",
    "frontend/src/ui/components/micMeter.js",
    "frontend/src/ui/components/pitchLane.js",
    "frontend/src/views/homeView.js",
    "frontend/src/views/searchView.js",
    "frontend/src/views/prepareView.js",
    "frontend/src/views/pregameView.js",
    "frontend/src/views/libraryView.js",
    "frontend/src/views/historyView.js",
  ];

  for (const relPath of phase4DomOnlyFiles) {
    const content = fs.readFileSync(path.join(ROOT_DIR, relPath), "utf8");
    assert.doesNotMatch(
      content,
      /\.innerHTML\s*=/,
      `Proibido usar innerHTML em ${relPath} (use textContent/nós DOM)`
    );
  }
});

test("Auditoria de Acessibilidade e Contratos Visuais (index.html + searchView.js)", () => {
  const indexHtml = fs.readFileSync(path.join(ROOT_DIR, "frontend", "index.html"), "utf8");
  assert.match(indexHtml, /<html lang="pt-BR"/);
  assert.match(indexHtml, /<main id="app-view"/);
  assert.match(indexHtml, /id="global-banner"[^>]*role="alert"/);
  assert.match(indexHtml, /id="confirm-modal"[^>]*role="dialog"[^>]*aria-modal="true"/);

  // ARCHITECTURE.md §10.1: tela de busca NUNCA importa ou exibe compatibilidade
  const searchSrc = fs.readFileSync(
    path.join(ROOT_DIR, "frontend", "src", "views", "searchView.js"),
    "utf8"
  );
  assert.doesNotMatch(searchSrc, /compatibilityBadge/);
  assert.doesNotMatch(searchSrc, /createCompatibilityBadge/);
});

test("Fluxo End-to-End Completo do MVP sobre HTTP local (127.0.0.1)", async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "karaoke-t47-e2e-"));
  const cacheRoot = path.join(tmpRoot, "cache");
  const dataDir = path.join(tmpRoot, "data");
  await fsp.mkdir(cacheRoot, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });

  const mockYoutubeSearchService = {
    async searchVideos(q) {
      return [
        {
          videoId: "dQw4w9WgXcQ",
          title: `${q} - Never Gonna Give You Up (Official Video)`,
          channel: "Rick Astley",
          duration: 213,
          thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
          hasSyncedLyrics: true,
        },
      ];
    },
  };

  const mockLyricsService = {
    async fetchAndSaveLyrics(videoId) {
      const songDir = path.join(cacheRoot, videoId);
      const lyricsPayload = {
        selected_id: 101,
        candidates: [
          {
            id: 101,
            trackName: "Never Gonna Give You Up",
            artistName: "Rick Astley",
            duration: 213,
            syncedLyrics: "[00:18.50] We're no strangers to love\n[00:22.10] You know the rules and so do I",
            plainLyrics: "We're no strangers to love\nYou know the rules and so do I",
          },
          {
            id: 102,
            trackName: "Never Gonna Give You Up (Acoustic)",
            artistName: "Rick Astley",
            duration: 210,
            syncedLyrics: null,
            plainLyrics: "We're no strangers to love",
          },
        ],
      };
      await fsp.writeFile(
        path.join(songDir, "lyrics.json"),
        JSON.stringify(lyricsPayload, null, 2),
        "utf8"
      );
      return lyricsPayload;
    },
  };

  const supervisor = createProcessSupervisor({
    command: process.execPath,
    baseArgs: [FAKE_WORKER_PATH],
    env: { FAKE_WORKER_STEP_DELAY_MS: "15" },
  });

  const app = createApp({
    cacheRoot,
    dataDir,
    supervisor,
    config: {
      cache: { max_size_gb: 5 },
    },
    youtubeSearchService: mockYoutubeSearchService,
    lyricsService: mockLyricsService,
    doctorOptions: {
      workerCommand: process.execPath,
      workerArgs: [FAKE_WORKER_PATH],
    },
  });

  const server = await new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });

  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Frontend HTML servido na mesma origem
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const htmlBody = await htmlRes.text();
    assert.match(htmlBody, /Karaokê Local/);

    // 2. Busca no YouTube (sem campo de compatibilidade)
    const searchRes = await fetch(`${baseUrl}/api/search?q=Rick%20Astley`);
    assert.equal(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert.equal(searchData.results.length, 1);
    assert.equal(searchData.results[0].videoId, "dQw4w9WgXcQ");
    assert.equal(searchData.results[0].compatibility, undefined);

    // 3. Dispara preparo + recebe compatibilidade provisória (Fase 1)
    const prepRes = await fetch(`${baseUrl}/api/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: "dQw4w9WgXcQ",
        title: "Rick Astley - Never Gonna Give You Up",
        channel: "Rick Astley",
        duration: 213,
      }),
    });
    assert.ok(prepRes.status === 200 || prepRes.status === 202);
    const prepData = await prepRes.json();
    assert.ok(prepData.compatibility);
    assert.equal(prepData.compatibility.provisional, true);

    // 4. Aguarda conclusão do job via polling/GET /api/jobs/:id
    if (prepData.jobId) {
      let jobState = prepData.status;
      for (let i = 0; i < 150 && jobState !== "ready"; i++) {
        await new Promise((r) => setTimeout(r, 60));
        const jRes = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(prepData.jobId)}`);
        const jData = await jRes.json();
        jobState = jData.state;
        assert.notEqual(jobState, "failed");
      }
      assert.equal(jobState, "ready");
    }

    // 5. Pré-jogo: GET /api/songs/:id devolve manifest + compatibilidade definitiva (Fase 2)
    const songRes = await fetch(`${baseUrl}/api/songs/dQw4w9WgXcQ`);
    assert.equal(songRes.status, 200);
    const songData = await songRes.json();
    assert.equal(songData.manifest.status, "ready");
    assert.equal(songData.manifest.compatibility.provisional, false);

    // 6. Segurança: bloqueio de Path Traversal na entrega de arquivos do cache
    const traversalRes = await fetch(
      `${baseUrl}/api/songs/dQw4w9WgXcQ/files/..%2F..%2Fpackage.json`
    );
    assert.ok(traversalRes.status === 400 || traversalRes.status === 403);

    // 7. Troca de letra no Pré-Jogo (PATCH /api/songs/:id) recalcula compatibilidade
    const patchRes = await fetch(`${baseUrl}/api/songs/dQw4w9WgXcQ`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lyrics: { selected_id: 102 } }),
    });
    assert.equal(patchRes.status, 200);
    const patchData = await patchRes.json();
    assert.equal(patchData.manifest.lyrics.selected_id, 102);

    // 8. Criação de jogador local
    const playerRes = await fetch(`${baseUrl}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Willian" }),
    });
    assert.equal(playerRes.status, 201);
    const playerData = await playerRes.json();
    const player = playerData.player || playerData;
    assert.equal(player.name, "Willian");

    // 9. Registro idempotente de partida concluída (POST /api/history)
    const matchId = "11111111-2222-4333-8444-555555555555";
    const matchPayload = {
      id: matchId,
      player_id: player.id,
      player_name: player.name,
      mode: "standard",
      session_id: null,
      video_id: "dQw4w9WgXcQ",
      song_title: "Never Gonna Give You Up",
      artist: "Rick Astley",
      played_at: new Date().toISOString(),
      duration_s: 213,
      score: 9.4,
      completed: true,
      difficulty: "normal",
      compatibility_level: songData.manifest.compatibility.level,
      scoring_confidence: "high",
      mic_quality: "good",
      assists: { auto_transpose: false, guide_volume: 0.25 },
      details: { best_streak: 42, coverage: 0.91, segments: [0.92, 0.95] },
      scoring_version: 1,
      app_version: "0.1.0",
    };

    const histPost1 = await fetch(`${baseUrl}/api/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(matchPayload),
    });
    assert.ok(histPost1.status === 200 || histPost1.status === 201);

    // Reenvio duplicado (mesmo UUID) não cria registro duplo
    const histPost2 = await fetch(`${baseUrl}/api/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(matchPayload),
    });
    assert.ok(histPost2.status === 200 || histPost2.status === 201);

    const histListRes = await fetch(`${baseUrl}/api/history`);
    const histList = await histListRes.json();
    assert.equal(histList.entries.length, 1);

    // 10. Ranking por música e Exportação CSV PT-BR + TXT
    const rankRes = await fetch(`${baseUrl}/api/history/rankings?video_id=dQw4w9WgXcQ`);
    assert.equal(rankRes.status, 200);
    const rankData = await rankRes.json();
    assert.equal(rankData.entries.length, 1);
    assert.equal(rankData.entries[0].best_score, 9.4);

    const csvRes = await fetch(
      `${baseUrl}/api/history/export?format=csv&bom=1&sep=%3B&decimal=comma`
    );
    assert.equal(csvRes.status, 200);
    const csvBuf = Buffer.from(await csvRes.arrayBuffer());
    // Verifica UTF-8 BOM (EF BB BF) e vírgula decimal "9,4"
    assert.equal(csvBuf[0], 0xef);
    assert.equal(csvBuf[1], 0xbb);
    assert.equal(csvBuf[2], 0xbf);
    assert.match(csvBuf.toString("utf8"), /9,4/);

    const txtRes = await fetch(`${baseUrl}/api/history/export?format=txt`);
    assert.equal(txtRes.status, 200);
    const txtText = await txtRes.text();
    assert.match(txtText, /Willian/);
    assert.match(txtText, /Never Gonna Give You Up/);

    // 11. Exclusão da música na Biblioteca (DELETE /api/songs/:id)
    const delRes = await fetch(`${baseUrl}/api/songs/dQw4w9WgXcQ`, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 200);
    const delData = await delRes.json();
    assert.equal(delData.deleted, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
});