/**
 * Testes automatizados da T4.3 — Persistência de Jogadores, Histórico, Rankings e Exportação CSV/TXT.
 * Executar no WSL2: node --test scripts/test-history.js
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../backend/server.js";

function buildValidEntry(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    player_id: "p_test_01",
    player_name: "Ana",
    mode: "standard",
    session_id: null,
    video_id: "z2Zw0RRXREw",
    song_title: "Numa Ilha",
    artist: "Marina Sena",
    played_at: "2026-11-18T04:00:00-03:00",
    duration_s: 210,
    score: 8.7,
    completed: true,
    difficulty: "normal",
    compatibility_level: "good",
    scoring_confidence: "high",
    mic_quality: "acceptable",
    assists: { auto_transpose: false, guide_volume: 0.3 },
    details: { best_streak: 42, coverage: 0.83, segments: [0.8, 0.9, 0.85] },
    scoring_version: 1,
    app_version: "0.1.0",
    ...overrides,
  };
}

async function startTestServer() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "karaoke-history-"));
  const cacheRoot = path.join(tmpRoot, "cache");
  const dataDir = path.join(tmpRoot, "data");

  const app = createApp({ cacheRoot, dataDir });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    cleanup() {
      server.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

test("Jogadores: criação com acentos/emojis, deduplicação case-insensitive, renomear e excluir (keep/delete)", async () => {
  const env = await startTestServer();
  try {
    // 1. Cria jogador com acento, emoji e caracteres de controle que devem ser limpos
    const createRes = await fetch(`${env.baseUrl}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  João 🎤\u0007  " }),
    });
    assert.equal(createRes.status, 201);
    const joao = await createRes.json();
    assert.equal(joao.name, "João 🎤");
    assert.ok(joao.id.startsWith("p_"));

    // 2. Bloqueia nome duplicado sem diferenciar maiúsculas/minúsculas (409)
    const dupRes = await fetch(`${env.baseUrl}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "JOÃO 🎤" }),
    });
    assert.equal(dupRes.status, 409);

    // 3. Bloqueia nome vazio ou acima de 30 caracteres (400)
    const emptyRes = await fetch(`${env.baseUrl}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    assert.equal(emptyRes.status, 400);

    const longRes = await fetch(`${env.baseUrl}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "A".repeat(31) }),
    });
    assert.equal(longRes.status, 400);

    // 4. Cria segundo jogador e renomeia
    const mariaRes = await fetch(`${env.baseUrl}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Maria" }),
    });
    const maria = await mariaRes.json();

    const patchRes = await fetch(`${env.baseUrl}/api/players/${maria.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Maria Clara" }),
    });
    assert.equal(patchRes.status, 200);
    const renamed = await patchRes.json();
    assert.equal(renamed.name, "Maria Clara");

    // 5. Registra uma partida para João e outra para Maria Clara
    const entryJoao = buildValidEntry({ player_id: joao.id, player_name: joao.name, score: 9.1 });
    const entryMaria = buildValidEntry({
      player_id: maria.id,
      player_name: renamed.name,
      score: 7.8,
    });

    await fetch(`${env.baseUrl}/api/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entryJoao),
    });
    await fetch(`${env.baseUrl}/api/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entryMaria),
    });

    // 6. Exclui João com history=keep -> entrada permanece com player_id: null e player_name original
    const delKeepRes = await fetch(`${env.baseUrl}/api/players/${joao.id}?history=keep`, {
      method: "DELETE",
    });
    assert.equal(delKeepRes.status, 200);

    const keptEntryRes = await fetch(`${env.baseUrl}/api/history/${entryJoao.id}`);
    assert.equal(keptEntryRes.status, 200);
    const keptEntry = await keptEntryRes.json();
    assert.equal(keptEntry.player_id, null);
    assert.equal(keptEntry.player_name, "João 🎤");

    // 7. Exclui Maria Clara com history=delete -> entrada é removida do histórico
    const delDeleteRes = await fetch(`${env.baseUrl}/api/players/${maria.id}?history=delete`, {
      method: "DELETE",
    });
    assert.equal(delDeleteRes.status, 200);

    const deletedEntryRes = await fetch(`${env.baseUrl}/api/history/${entryMaria.id}`);
    assert.equal(deletedEntryRes.status, 404);
  } finally {
    env.cleanup();
  }
});

test("Histórico: validação rigorosa, idempotência por id e escritas concorrentes sem corrupção", async () => {
  const env = await startTestServer();
  try {
    // 1. Rejeita nota fora da faixa 0..10 (400)
    const invalidScoreRes = await fetch(`${env.baseUrl}/api/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildValidEntry({ score: 10.5 })),
    });
    assert.equal(invalidScoreRes.status, 400);

    // 2. Idempotência por UUID: primeiro POST retorna 201, segundo com mesmo id retorna 200 sem duplicar
    const fixedEntry = buildValidEntry({ score: 8.4 });
    const firstPost = await fetch(`${env.baseUrl}/api/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fixedEntry),
    });
    assert.equal(firstPost.status, 201);

    const secondPost = await fetch(`${env.baseUrl}/api/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fixedEntry),
    });
    assert.equal(secondPost.status, 200);

    // 3. Dispara 15 gravações simultâneas para validar serialização na fila de escrita
    const batch = Array.from({ length: 15 }, (_, idx) =>
      buildValidEntry({
        player_id: `p_batch_${idx % 3}`,
        player_name: `Jogador ${idx % 3}`,
        score: Number(((idx % 10) + 0.3).toFixed(1)),
        played_at: `2026-11-18T04:${String(idx).padStart(2, "0")}:00-03:00`,
      })
    );

    const responses = await Promise.all(
      batch.map((item) =>
        fetch(`${env.baseUrl}/api/history`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        })
      )
    );
    assert.ok(responses.every((r) => r.status === 201));

    const listRes = await fetch(`${env.baseUrl}/api/history`);
    const listBody = await listRes.json();
    // 1 do teste de idempotência + 15 do lote = 16 entradas íntegras
    assert.equal(listBody.entries.length, 16);

    // 4. Verifica que a pasta backups/ manteve no máximo 5 arquivos rotativos
    const backupsDir = path.join(env.dataDir, "backups");
    const historyBackups = fs
      .readdirSync(backupsDir)
      .filter((name) => name.startsWith("history-"));
    assert.ok(historyBackups.length <= 5 && historyBackups.length >= 1);
  } finally {
    env.cleanup();
  }
});

test("Recuperação automática de arquivo JSON corrompido", async () => {
  const env = await startTestServer();
  try {
    // Grava um jogador inicialmente
    await fetch(`${env.baseUrl}/api/players`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Carlos" }),
    });

    // Corrompe manualmente o arquivo players.json no disco
    const playersFile = path.join(env.dataDir, "players.json");
    fs.writeFileSync(playersFile, "{ json totalmente quebrado !!!", "utf-8");

    // Ao listar jogadores, o sistema deve mover o corrompido para *.corrupt-* e inicializar limpo
    const res = await fetch(`${env.baseUrl}/api/players`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.players, []);

    const corruptFiles = fs
      .readdirSync(env.dataDir)
      .filter((name) => name.startsWith("players.json.corrupt-"));
    assert.equal(corruptFiles.length, 1);
  } finally {
    env.cleanup();
  }
});

test("Rankings por música e exportação CSV (pt-BR com BOM) e TXT", async () => {
  const env = await startTestServer();
  try {
    const entries = [
      buildValidEntry({
        player_id: "p_ana",
        player_name: "Ana",
        video_id: "abc123XYZ_0",
        song_title: "Evidências; Ao Vivo",
        artist: 'Chitãozinho "CH&X" Xororó',
        score: 8.7,
        difficulty: "normal",
        compatibility_level: "good",
        played_at: "2026-11-18T02:00:00-03:00",
      }),
      // Nota maior da Ana na mesma música -> deve prevalecer no ranking
      buildValidEntry({
        player_id: "p_ana",
        player_name: "Ana",
        video_id: "abc123XYZ_0",
        song_title: "Evidências; Ao Vivo",
        artist: 'Chitãozinho "CH&X" Xororó',
        score: 9.4,
        difficulty: "hard",
        compatibility_level: "good",
        played_at: "2026-11-18T03:00:00-03:00",
      }),
      // Partida não concluída (nota 10.0) não deve entrar no ranking
      buildValidEntry({
        player_id: "p_bruno",
        player_name: "Bruno",
        video_id: "abc123XYZ_0",
        song_title: "Evidências; Ao Vivo",
        artist: "Chitãozinho & Xororó",
        score: 10.0,
        completed: false,
        played_at: "2026-11-18T03:10:00-03:00",
      }),
      buildValidEntry({
        player_id: "p_bruno",
        player_name: "Bruno",
        video_id: "abc123XYZ_0",
        song_title: "Evidências; Ao Vivo",
        artist: "Chitãozinho & Xororó",
        score: 8.9,
        difficulty: "normal",
        compatibility_level: "good",
        played_at: "2026-11-18T03:20:00-03:00",
      }),
    ];

    for (const item of entries) {
      const r = await fetch(`${env.baseUrl}/api/history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      });
      assert.equal(r.status, 201);
    }

    // 1. Verifica ranking local da música abc123XYZ_0
    const rankRes = await fetch(`${env.baseUrl}/api/history/rankings?video_id=abc123XYZ_0`);
    assert.equal(rankRes.status, 200);
    const ranking = await rankRes.json();
    assert.equal(ranking.video_id, "abc123XYZ_0");
    assert.equal(ranking.entries.length, 2);
    assert.equal(ranking.entries[0].player_name, "Ana");
    assert.equal(ranking.entries[0].best_score, 9.4);
    assert.equal(ranking.entries[1].player_name, "Bruno");
    assert.equal(ranking.entries[1].best_score, 8.9);

    // 2. Exportação CSV pt-BR com BOM=1, separador ';' e decimal vírgula
    const csvRes = await fetch(
      `${env.baseUrl}/api/history/export?format=csv&bom=1&sep=;&decimal=comma`
    );
    assert.equal(csvRes.status, 200);
    assert.ok(csvRes.headers.get("content-type")?.includes("text/csv"));
    assert.ok(csvRes.headers.get("content-disposition")?.includes("historico-karaoke.csv"));

    // Lê os bytes brutos (res.text() da API Fetch remove BOM UTF-8 automaticamente)
    const csvBytes = new Uint8Array(await csvRes.arrayBuffer());
    assert.equal(csvBytes[0], 0xef);
    assert.equal(csvBytes[1], 0xbb);
    assert.equal(csvBytes[2], 0xbf);

    const csvText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(csvBytes);
    assert.ok(csvText.startsWith("\uFEFFdata_hora;jogador;modo;musica;artista;nota;dificuldade;compatibilidade;concluida"));
    // Verifica escape de ';' e '"' e formatação decimal com vírgula ('9,4')
    assert.ok(csvText.includes('"Evidências; Ao Vivo"'));
    assert.ok(csvText.includes('"Chitãozinho ""CH&X"" Xororó"'));
    assert.ok(csvText.includes(";9,4;difícil;Boa;sim"));

    // 3. Exportação TXT agrupada por jogador
    const txtRes = await fetch(`${env.baseUrl}/api/history/export?format=txt`);
    assert.equal(txtRes.status, 200);
    assert.ok(txtRes.headers.get("content-type")?.includes("text/plain"));
    const txtText = await txtRes.text();
    assert.ok(txtText.includes("=== Ana ==="));
    assert.ok(txtText.includes("=== Bruno ==="));
    assert.ok(txtText.includes("9,4 | Difícil | Compat.: Boa | concluída"));

    // 4. Exclusão total exige confirm=all
    const delNoConfirm = await fetch(`${env.baseUrl}/api/history`, { method: "DELETE" });
    assert.equal(delNoConfirm.status, 400);

    const delAll = await fetch(`${env.baseUrl}/api/history?confirm=all`, { method: "DELETE" });
    assert.equal(delAll.status, 200);
    const delAllBody = await delAll.json();
    assert.equal(delAllBody.deletedCount, 4);
  } finally {
    env.cleanup();
  }
});