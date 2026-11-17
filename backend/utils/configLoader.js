/**
 * Carrega os arquivos de configuração em config/ para uso do backend e da rota /api/config.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, "..", "..");
export const CONFIG_DIR = path.join(ROOT_DIR, "config");
export const FRONTEND_DIR = path.join(ROOT_DIR, "frontend");
export const CACHE_DIR = path.join(ROOT_DIR, "backend", "cache");
export const DATA_DIR = path.join(ROOT_DIR, "backend", "data");

const DEFAULT_SCORING_CONFIG = {
  heuristic: {
    stability_window_frames: 5,
    stability_tolerance_semitones: 1.5,
    full_score_coverage: 0.6,
  },
};

/**
 * Lê e interpreta config/default.json.
 */
export function loadDefaultConfig() {
  const filePath = path.join(CONFIG_DIR, "default.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

/**
 * Lê e interpreta config/compatibility-weights.json.
 */
export function loadCompatibilityWeights() {
  const filePath = path.join(CONFIG_DIR, "compatibility-weights.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

/**
 * Retorna apenas os blocos públicos exigidos pelo frontend em GET /api/config (CONTRACTS.md §5).
 */
export function getPublicConfig() {
  const cfg = loadDefaultConfig();
  return {
    audio: cfg.audio ?? {},
    tolerances: cfg.tolerances ?? {},
    scoring: cfg.scoring ?? DEFAULT_SCORING_CONFIG,
  };
}