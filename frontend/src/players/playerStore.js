/**
 * Gerenciador de perfis de jogadores no frontend (FRONTEND_ARCHITECTURE.md §4.2, §9 e CONTRACTS.md §10).
 * Comunica-se exclusivamente com `api`, `store` e `localStorage`.
 */

import { api } from "../api.js";
import { setState } from "../store.js";

export const LAST_PLAYER_STORAGE_KEY = "karaoke.lastPlayer.v1";

export const GUEST_PLAYER = Object.freeze({
  id: null,
  name: "Convidado",
  isGuest: true,
});

function getBrowserStorage() {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignora bloqueio de storage
  }
  return null;
}

function readLastPlayerId(storage = getBrowserStorage()) {
  if (!storage) return "guest";
  try {
    const raw = storage.getItem(LAST_PLAYER_STORAGE_KEY);
    if (!raw) return "guest";
    return raw.trim() || "guest";
  } catch {
    return "guest";
  }
}

function writeLastPlayerId(playerId, storage = getBrowserStorage()) {
  if (!storage) return;
  try {
    storage.setItem(LAST_PLAYER_STORAGE_KEY, playerId ? String(playerId) : "guest");
  } catch {
    // Ignora falha de armazenamento
  }
}

export function normalizePlayerNameInput(rawName) {
  if (typeof rawName !== "string") {
    throw new Error("Informe um nome válido para o jogador.");
  }
  const cleaned = rawName.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
  const length = [...cleaned].length;
  if (length < 1 || length > 30) {
    throw new Error("O nome do jogador deve ter entre 1 e 30 caracteres.");
  }
  return cleaned;
}

export function createPlayerStore({
  apiClient = api,
  storage = getBrowserStorage(),
  onChange = null,
} = {}) {
  let players = [];
  let activePlayer = { ...GUEST_PLAYER };

  function syncStore() {
    setState({
      players: [...players],
      player: { ...activePlayer },
    });
    if (typeof onChange === "function") {
      try {
        onChange({ players: [...players], activePlayer: { ...activePlayer } });
      } catch {
        // Ignora erro em listener externo
      }
    }
  }

  function getPlayers() {
    return [...players];
  }

  function getActivePlayer() {
    return { ...activePlayer };
  }

  function selectPlayer(playerOrId) {
    if (!playerOrId || playerOrId === "guest" || playerOrId?.id === null) {
      activePlayer = { ...GUEST_PLAYER };
      writeLastPlayerId("guest", storage);
      syncStore();
      return getActivePlayer();
    }

    const targetId = typeof playerOrId === "string" ? playerOrId : playerOrId.id;
    const found = players.find((p) => p.id === targetId);
    if (found) {
      activePlayer = { id: found.id, name: found.name, isGuest: false };
      writeLastPlayerId(found.id, storage);
    } else if (typeof playerOrId === "object" && playerOrId.id && playerOrId.name) {
      activePlayer = { id: playerOrId.id, name: playerOrId.name, isGuest: false };
      writeLastPlayerId(playerOrId.id, storage);
    } else {
      activePlayer = { ...GUEST_PLAYER };
      writeLastPlayerId("guest", storage);
    }

    syncStore();
    return getActivePlayer();
  }

  /**
   * Carrega a lista de jogadores do backend e restaura o último jogador salvo no localStorage.
   */
  async function loadPlayers() {
    const res = await apiClient.getPlayers();
    players = Array.isArray(res?.players) ? res.players : [];

    const savedId = readLastPlayerId(storage);
    if (savedId && savedId !== "guest") {
      const matched = players.find((p) => p.id === savedId);
      if (matched) {
        activePlayer = { id: matched.id, name: matched.name, isGuest: false };
      } else {
        activePlayer = { ...GUEST_PLAYER };
        writeLastPlayerId("guest", storage);
      }
    } else {
      activePlayer = { ...GUEST_PLAYER };
    }

    syncStore();
    return getPlayers();
  }

  async function createPlayer(rawName) {
    const cleanName = normalizePlayerNameInput(rawName);
    const created = await apiClient.createPlayer(cleanName);
    players = [...players.filter((p) => p.id !== created.id), created];
    activePlayer = { id: created.id, name: created.name, isGuest: false };
    writeLastPlayerId(created.id, storage);
    syncStore();
    return created;
  }

  async function renamePlayer(playerId, rawName) {
    const cleanName = normalizePlayerNameInput(rawName);
    const updated = await apiClient.renamePlayer(playerId, cleanName);
    players = players.map((p) => (p.id === playerId ? updated : p));
    if (activePlayer.id === playerId) {
      activePlayer = { id: updated.id, name: updated.name, isGuest: false };
    }
    syncStore();
    return updated;
  }

  async function deletePlayer(playerId, historyPolicy = "keep") {
    await apiClient.deletePlayer(playerId, historyPolicy);
    players = players.filter((p) => p.id !== playerId);
    if (activePlayer.id === playerId) {
      activePlayer = { ...GUEST_PLAYER };
      writeLastPlayerId("guest", storage);
    }
    syncStore();
    return { deleted: true };
  }

  syncStore();

  return {
    getPlayers,
    getActivePlayer,
    selectPlayer,
    loadPlayers,
    createPlayer,
    renamePlayer,
    deletePlayer,
  };
}

export const playerStore = createPlayerStore();