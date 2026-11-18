/**
 * Testes automatizados da T4.4:
 * - Registro de modos (`standard` ativo + placeholder `championship` desabilitado)
 * - `playerStore.js`: validação de nome, modo Convidado, `karaoke.lastPlayer.v1` e CRUD
 * - `session.js` + `standard.js` + `historyClient.js`: fila offline (`karaoke.pendingHistory.v1`)
 *   quando o backend cai e sincronização idempotente automática quando o backend volta
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHistoryService } from "../backend/services/historyService.js";
import { createPlayerService } from "../backend/services/playerService.js";
import { championshipMode } from "../frontend/src/game/modes/championship.js";
import { getDefaultMode, getMode, listModes } from "../frontend/src/game/modes/registry.js";
import { createGameSession } from "../frontend/src/game/session.js";
import {
  createHistoryClient,
  PENDING_HISTORY_STORAGE_KEY,
} from "../frontend/src/history/historyClient.js";
import {
  createPlayerStore,
  LAST_PLAYER_STORAGE_KEY,
  normalizePlayerNameInput,
} from "../frontend/src/players/playerStore.js";

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    dump() {
      return Object.fromEntries(map.entries());
    },
  };
}

test("Registro de modos expõe standard ativo e championship como placeholder desabilitado", () => {
  const modes = listModes();
  assert.ok(modes.length >= 2);

  const std = getMode("standard");
  assert.equal(std.id, "standard");
  assert.equal(std.enabled, true);
  assert.equal(getDefaultMode().id, "standard");

  const champ = getMode("championship");
  assert.equal(champ.id, "championship");
  assert.equal(champ.enabled, false);
  assert.equal(champ.badgeKey, "mode.coming_soon");
  assert.equal(championshipMode.enabled, false);
  assert.equal(championshipMode.onStart, undefined);
});

test("playerStore gerencia Convidado, validação de nome, localStorage e sincronização com backend", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "karaoke-t44-players-"));
  try {
    const playerService = createPlayerService({ dataDir: tmpDir });
    const storage = createMemoryStorage();

    const mockApi = {
      getPlayers: async () => ({ players: await playerService.listPlayers() }),
      createPlayer: async (name) => playerService.createPlayer(name),
      renamePlayer: async (id, name) => playerService.renamePlayer(id, name),
      deletePlayer: async (id, history) => {
        await playerService.deletePlayer(id);
        return { deleted: true, history };
      },
    };

    const store = createPlayerStore({ apiClient: mockApi, storage });
    assert.equal(store.getActivePlayer().name, "Convidado");
    assert.equal(store.getActivePlayer().isGuest, true);

    assert.throws(() => normalizePlayerNameInput("   "), /entre 1 e 30/);
    assert.throws(() => normalizePlayerNameInput("a".repeat(31)), /entre 1 e 30/);

    const created = await store.createPlayer("  Ana Júlia 🎤\u0007  ");
    assert.equal(created.name, "Ana Júlia 🎤");
    assert.equal(store.getActivePlayer().id, created.id);
    assert.equal(storage.getItem(LAST_PLAYER_STORAGE_KEY), created.id);

    // Simula recarregamento da página restaurando o último jogador salvo
    const reloadedStore = createPlayerStore({ apiClient: mockApi, storage });
    await reloadedStore.loadPlayers();
    assert.equal(reloadedStore.getActivePlayer().id, created.id);
    assert.equal(reloadedStore.getActivePlayer().name, "Ana Júlia 🎤");

    await reloadedStore.renamePlayer(created.id, "Ana J.");
    assert.equal(reloadedStore.getActivePlayer().name, "Ana J.");

    await reloadedStore.deletePlayer(created.id, "keep");
    assert.equal(reloadedStore.getActivePlayer().isGuest, true);
    assert.equal(storage.getItem(LAST_PLAYER_STORAGE_KEY), "guest");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Partida concluída com backend desligado salva na fila local e sincroniza ao reconectar", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "karaoke-t44-history-"));
  try {
    const historyService = createHistoryService({ dataDir: tmpDir });
    const storage = createMemoryStorage();
    let backendOnline = false;

    const mockApi = {
      postHistory: async (entry) => {
        if (!backendOnline) {
          const err = new Error("Servidor local indisponível.");
          err.code = "NETWORK_ERROR";
          err.isNetworkError = true;
          throw err;
        }
        const saved = await historyService.addEntry(entry);
        return saved?.entry || saved;
      },
    };

    const client = createHistoryClient({
      apiClient: mockApi,
      storage,
      retryIntervalMs: 0,
      autoStart: false,
    });

    const session = createGameSession({
      modeId: "standard",
      player: { id: "p_will", name: "Willian", isGuest: false },
      song: {
        videoId: "dQw4w9WgXcQ",
        title: "Never Gonna Give You Up",
        artist: "Rick Astley",
        duration: 213,
        compatibilityLevel: "excellent",
      },
      difficulty: "normal",
      assists: { autoTranspose: false, guideVolume: 0.25 },
      client,
    });

    session.start();
    const frameFeedback = session.pushFrame({ counted: true, points: 1, hit: "perfect" });
    assert.equal(frameFeedback.streak, 1);

    // Backend fora do ar no momento em que a música termina
    const outcome = await session.finish({
      summary: {
        score: 9.2,
        best_streak: 48,
        coverage: 0.88,
        scoring_confidence: "high",
        segments: [0.9, 0.95, 0.88],
      },
      durationSeconds: 213,
    });

    assert.equal(outcome.persistence.synced, false);
    assert.equal(outcome.persistence.pending, true);
    assert.equal(client.getPendingCount(), 1);

    const storedQueue = JSON.parse(storage.getItem(PENDING_HISTORY_STORAGE_KEY));
    assert.equal(storedQueue.length, 1);
    assert.equal(storedQueue[0].id, outcome.entry.id);
    assert.equal(storedQueue[0].score, 9.2);

    // Backend volta ao ar -> reenvia fila pendente automaticamente
    backendOnline = true;
    const flushRes = await client.flushPending();
    assert.equal(flushRes.flushed, 1);
    assert.equal(flushRes.remaining, 0);
    assert.equal(client.getPendingCount(), 0);
    assert.equal(storage.getItem(PENDING_HISTORY_STORAGE_KEY), null);

    // Segundo flush não duplica (idempotência por UUID)
    await client.recordMatch(outcome.entry);
    const persisted = await historyService.listEntries();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].id, outcome.entry.id);
    assert.equal(persisted[0].player_name, "Willian");
    assert.equal(persisted[0].score, 9.2);

    client.destroy();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});