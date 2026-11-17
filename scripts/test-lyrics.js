/**
 * Testes automatizados do LyricsService (T1.3.1).
 * Executar com: node --test scripts/test-lyrics.js
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCacheManager } from "../backend/services/cacheManager.js";
import {
  createLyricsService,
  normalizeYouTubeTitle,
  selectBestCandidate,
} from "../backend/services/lyricsService.js";

test("normalizeYouTubeTitle limpa ruídos e preserva marcadores de versão", () => {
  const res1 = normalizeYouTubeTitle("Marina Sena - Numa Ilha (Clipe Oficial) [4K]");
  assert.equal(res1.artist_name, "Marina Sena");
  assert.equal(res1.track_name, "Numa Ilha");
  assert.deepEqual(res1.version_markers, []);

  const res2 = normalizeYouTubeTitle(
    "Gustavo Mioto - COM OU SEM MIM - DVD Ao Vivo Em Fortaleza"
  );
  assert.equal(res2.artist_name, "Gustavo Mioto");
  assert.equal(res2.track_name, "COM OU SEM MIM");
  assert.deepEqual(res2.version_markers, ["live"]);

  const res3 = normalizeYouTubeTitle("Tempo Perdido (Acústico) [HD]", "Legião Urbana - Topic");
  assert.equal(res3.artist_name, "Legião Urbana");
  assert.equal(res3.track_name, "Tempo Perdido");
  assert.deepEqual(res3.version_markers, ["acoustic"]);
});

test("selectBestCandidate escolhe o candidato com menor diferença de duração", () => {
  const candidates = [
    {
      id: 10,
      trackName: "Evidências",
      artistName: "Chitãozinho & Xororó",
      duration: 310, // +31s de diferença
      plainLyrics: "Quando digo que deixei...",
      syncedLyrics: "[00:15.00] Quando digo que deixei...",
    },
    {
      id: 20,
      trackName: "Evidências",
      artistName: "Chitãozinho & Xororó",
      duration: 280, // +1s de diferença (mais próximo de 279s)
      plainLyrics: "Quando digo que deixei...",
      syncedLyrics: "[00:14.20] Quando digo que deixei...",
    },
    {
      id: 30,
      trackName: "Evidências",
      artistName: "Chitãozinho & Xororó",
      duration: 240, // -39s de diferença
      plainLyrics: "Quando digo que deixei...",
      syncedLyrics: null,
    },
  ];

  const chosen = selectBestCandidate(candidates, 279);
  assert.equal(chosen.id, 20);
});

test("selectBestCandidate desempata duração igual priorizando letra sincronizada", () => {
  const candidates = [
    { id: 1, duration: 200, plainLyrics: "Texto simples", syncedLyrics: null },
    { id: 2, duration: 200, plainLyrics: "Texto simples", syncedLyrics: "[00:05.00] Texto" },
  ];

  const chosen = selectBestCandidate(candidates, 200);
  assert.equal(chosen.id, 2);
  assert.equal(selectBestCandidate([], 200), null);
});

test("fetchAndSaveLyrics usa fallback `q`, salva lyrics.json e não toca em manifest.json", async (t) => {
  const tempCache = fs.mkdtempSync(path.join(os.tmpdir(), "karaoke-t13-"));
  t.after(() => fs.rmSync(tempCache, { recursive: true, force: true }));

  const cacheManager = createCacheManager({ cacheRoot: tempCache });
  const calledUrls = [];

  // Simula LRCLIB retornando [] na busca estruturada e resultado válido no fallback `q`
  const fakeFetch = async (url) => {
    calledUrls.push(url);
    const parsed = new URL(url);
    if (parsed.searchParams.has("track_name")) {
      return { ok: true, json: async () => [] };
    }
    return {
      ok: true,
      json: async () => [
        {
          id: 999,
          trackName: "Numa Ilha",
          artistName: "Marina Sena",
          duration: 266,
          plainLyrics: "Letra completa...",
          syncedLyrics: "[00:12.00] Letra sincronizada...",
        },
      ],
    };
  };

  const lyricsService = createLyricsService({
    cacheManager,
    fetchImpl: fakeFetch,
  });

  const saved = await lyricsService.fetchAndSaveLyrics("z2ZmXRkXREw", {
    title: "Marina Sena - Numa Ilha (Clipe Oficial)",
    channel: "Marina Sena",
    duration: 267,
  });

  assert.equal(calledUrls.length, 2);
  assert.equal(saved.selected_id, 999);
  assert.equal(saved.candidates.length, 1);

  // Confirma que lyrics.json foi salvo e manifest.json NÃO foi criado pelo LyricsService
  const songDir = cacheManager.getSongDir("z2ZmXRkXREw");
  assert.equal(fs.existsSync(path.join(songDir, "lyrics.json")), true);
  assert.equal(fs.existsSync(path.join(songDir, "manifest.json")), false);
});

test("fetchAndSaveLyrics degrada graciosamente se LRCLIB falhar ou der timeout", async (t) => {
  const tempCache = fs.mkdtempSync(path.join(os.tmpdir(), "karaoke-t13-err-"));
  t.after(() => fs.rmSync(tempCache, { recursive: true, force: true }));

  const cacheManager = createCacheManager({ cacheRoot: tempCache });
  const failingFetch = async () => {
    throw new Error("Network unreachable");
  };

  const lyricsService = createLyricsService({
    cacheManager,
    fetchImpl: failingFetch,
  });

  const saved = await lyricsService.fetchAndSaveLyrics("abc123XYZ_0", {
    title: "Artista - Música",
    duration: 200,
  });

  assert.equal(saved.selected_id, null);
  assert.deepEqual(saved.candidates, []);
});