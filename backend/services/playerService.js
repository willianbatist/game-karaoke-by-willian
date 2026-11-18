/**
 * Serviço de gerenciamento de perfis de jogadores (FRONTEND_ARCHITECTURE.md §4.2 e CONTRACTS.md §5.2).
 */

import crypto from "node:crypto";
import path from "node:path";
import { createAtomicJsonStore, toLocalIsoString } from "../utils/atomicJsonStore.js";
import { DATA_DIR } from "../utils/configLoader.js";
import { AppError } from "../utils/errors.js";

const SCHEMA_VERSION = 1;

/**
 * Remove caracteres de controle ASCII/Unicode e espaços nas extremidades,
 * preservando acentos e emojis (FRONTEND_ARCHITECTURE.md §4.2).
 */
export function sanitizePlayerName(rawName) {
  if (typeof rawName !== "string") {
    throw new AppError(400, "INVALID_PLAYER_NAME", "O nome do jogador deve ser um texto.");
  }

  const cleaned = rawName.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
  const charCount = [...cleaned].length;

  if (charCount < 1 || charCount > 30) {
    throw new AppError(
      400,
      "INVALID_PLAYER_NAME",
      "O nome do jogador deve ter entre 1 e 30 caracteres."
    );
  }

  return cleaned;
}

function normalizeForComparison(name) {
  return name.toLocaleLowerCase("pt-BR");
}

export function createPlayerService(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? DATA_DIR);
  const filePath = path.join(dataDir, "players.json");
  let historyService = options.historyService ?? null;

  const store = createAtomicJsonStore({
    filePath,
    createInitialData: () => ({
      schema_version: SCHEMA_VERSION,
      players: [],
    }),
    validateData: (parsed) =>
      parsed.schema_version === SCHEMA_VERSION && Array.isArray(parsed.players),
    onCorruption: options.onCorruption,
  });

  function setHistoryService(service) {
    historyService = service;
  }

  async function listPlayers() {
    const data = await store.read();
    return data.players;
  }

  async function getPlayerById(playerId) {
    const data = await store.read();
    return data.players.find((p) => p.id === playerId) ?? null;
  }

  async function createPlayer(rawName) {
    const name = sanitizePlayerName(rawName);
    const normalizedNew = normalizeForComparison(name);

    return store.update((data) => {
      const duplicate = data.players.find(
        (p) => normalizeForComparison(p.name) === normalizedNew
      );
      if (duplicate) {
        throw new AppError(409, "PLAYER_EXISTS", "Já existe um jogador cadastrado com esse nome.");
      }

      const player = {
        id: `p_${crypto.randomUUID().slice(0, 8)}`,
        name,
        created_at: toLocalIsoString(),
      };

      data.players.push(player);
      return player;
    });
  }

  async function renamePlayer(playerId, rawName) {
    if (typeof playerId !== "string" || !playerId.trim()) {
      throw new AppError(400, "INVALID_PLAYER_ID", "Identificador de jogador inválido.");
    }

    const name = sanitizePlayerName(rawName);
    const normalizedNew = normalizeForComparison(name);

    return store.update((data) => {
      const player = data.players.find((p) => p.id === playerId);
      if (!player) {
        throw new AppError(404, "PLAYER_NOT_FOUND", "Jogador não encontrado.");
      }

      const duplicate = data.players.find(
        (p) => p.id !== playerId && normalizeForComparison(p.name) === normalizedNew
      );
      if (duplicate) {
        throw new AppError(409, "PLAYER_EXISTS", "Já existe outro jogador cadastrado com esse nome.");
      }

      player.name = name;
      return { ...player };
    });
  }

  async function deletePlayer(playerId, { history = "keep" } = {}) {
    if (typeof playerId !== "string" || !playerId.trim()) {
      throw new AppError(400, "INVALID_PLAYER_ID", "Identificador de jogador inválido.");
    }

    if (history !== "keep" && history !== "delete") {
      throw new AppError(
        400,
        "INVALID_HISTORY_POLICY",
        "O parâmetro history deve ser 'keep' ou 'delete'."
      );
    }

    await store.update((data) => {
      const index = data.players.findIndex((p) => p.id === playerId);
      if (index === -1) {
        throw new AppError(404, "PLAYER_NOT_FOUND", "Jogador não encontrado.");
      }
      data.players.splice(index, 1);
    });

    if (historyService && typeof historyService.onPlayerDeleted === "function") {
      await historyService.onPlayerDeleted(playerId, history);
    }

    return { deleted: true };
  }

  return {
    store,
    setHistoryService,
    listPlayers,
    getPlayerById,
    createPlayer,
    renamePlayer,
    deletePlayer,
  };
}