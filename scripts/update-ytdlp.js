/**
 * Atualiza o yt-dlp dentro do ambiente virtual do Worker Python (worker/.venv)
 * e exibe a versão instalada após a atualização.
 */

import { spawnSync } from "node:child_process";
import { getVenvPaths, ROOT_DIR } from "./lib/venvPaths.js";

function main() {
  const venvPaths = getVenvPaths();

  console.log("=== Atualização do yt-dlp (game-karaoke-by-willian) ===");

  if (!venvPaths.hasVenv) {
    console.error(
      `❌ Ambiente virtual não encontrado em ${venvPaths.venvDir}.\n` +
        "   Rode primeiro: python3 worker/setup/install.py"
    );
    process.exit(1);
  }

  console.log("==> Atualizando pacote yt-dlp no worker/.venv...");
  const updateRes = spawnSync(
    venvPaths.pythonBin,
    ["-m", "pip", "install", "--upgrade", "yt-dlp"],
    {
      cwd: ROOT_DIR,
      stdio: "inherit",
    }
  );

  if (updateRes.status !== 0) {
    console.error("\n❌ Falha ao atualizar o yt-dlp via pip.");
    process.exit(updateRes.status ?? 1);
  }

  // Confirma a versão instalada
  const refreshedPaths = getVenvPaths();
  const verRes = spawnSync(refreshedPaths.ytdlpBin, ["--version"], {
    encoding: "utf-8",
    timeout: 10000,
  });

  if (verRes.status === 0 && verRes.stdout) {
    console.log(`\n✅ yt-dlp atualizado com sucesso! Versão atual: ${verRes.stdout.trim()}`);
  } else {
    console.log("\n✅ Comando de atualização concluído.");
  }
}

main();