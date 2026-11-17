/**
 * Resolve os caminhos do ambiente virtual Python (worker/.venv)
 * de forma compatível com Linux/WSL2, macOS e Windows.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Raiz do projeto (dois níveis acima de scripts/lib/)
export const ROOT_DIR = path.resolve(__dirname, "..", "..");
export const WORKER_DIR = path.join(ROOT_DIR, "worker");
export const VENV_DIR = path.join(WORKER_DIR, ".venv");

/**
 * Retorna os caminhos resolvidos para Python e yt-dlp no ambiente virtual.
 */
export function getVenvPaths() {
  const isWindows = process.platform === "win32";
  const binDir = isWindows
    ? path.join(VENV_DIR, "Scripts")
    : path.join(VENV_DIR, "bin");

  const pythonBin = path.join(binDir, isWindows ? "python.exe" : "python");
  const venvYtdlpBin = path.join(binDir, isWindows ? "yt-dlp.exe" : "yt-dlp");

  const hasVenv = fs.existsSync(pythonBin);
  const hasVenvYtdlp = fs.existsSync(venvYtdlpBin);

  return {
    rootDir: ROOT_DIR,
    workerDir: WORKER_DIR,
    venvDir: VENV_DIR,
    binDir,
    pythonBin,
    hasVenv,
    // Usa o yt-dlp do venv se existir; caso contrário faz fallback para o PATH do sistema
    ytdlpBin: hasVenvYtdlp ? venvYtdlpBin : "yt-dlp",
    hasVenvYtdlp,
  };
}