/**
 * Registro central de modos de jogo (FRONTEND_ARCHITECTURE.md §3.3 e T4.4).
 */

import { championshipMode } from "./championship.js";
import { standardMode } from "./standard.js";

const modesMap = new Map([
  [standardMode.id, standardMode],
  [championshipMode.id, championshipMode],
]);

export function registerMode(modeDef) {
  if (!modeDef || typeof modeDef.id !== "string" || !modeDef.id.trim()) {
    throw new Error("Definição de modo inválida: campo 'id' obrigatório.");
  }
  modesMap.set(modeDef.id, modeDef);
  return modeDef;
}

export function getMode(modeId) {
  return modesMap.get(modeId) || null;
}

export function getDefaultMode() {
  return modesMap.get("standard") || standardMode;
}

export function listModes() {
  return Array.from(modesMap.values());
}

export function listEnabledModes() {
  return listModes().filter((m) => m.enabled === true);
}