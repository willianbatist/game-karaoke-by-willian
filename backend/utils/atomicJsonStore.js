/**
 * Armazenamento JSON atômico com fila de serialização, backup rotativo e
 * recuperação automática de arquivos corrompidos (FRONTEND_ARCHITECTURE.md §4.4 e CONTRACTS.md §9.4).
 */

import fs from "node:fs";
import path from "node:path";

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY"]);

/**
 * Formata uma data em ISO 8601 com offset de fuso horário local (ex.: 2026-11-18T04:30:05-03:00).
 */
export function toLocalIsoString(date = new Date()) {
  const pad = (num) => String(num).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());

  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const offsetHours = pad(Math.floor(absMinutes / 60));
  const offsetMins = pad(absMinutes % 60);

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetMins}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executa fs.promises.rename com novas tentativas caso o sistema operacional
 * bloqueie temporariamente o arquivo (EPERM / EBUSY).
 */
async function renameWithRetry(tmpPath, targetPath, maxRetries = 5) {
  let attempt = 0;
  while (true) {
    try {
      await fs.promises.rename(tmpPath, targetPath);
      return;
    } catch (err) {
      if (!RETRYABLE_RENAME_CODES.has(err?.code) || attempt >= maxRetries) {
        try {
          await fs.promises.unlink(tmpPath);
        } catch {
          // Ignora falha ao remover temporário
        }
        throw err;
      }
      attempt += 1;
      await sleep(15 * 2 ** (attempt - 1));
    }
  }
}

export function createAtomicJsonStore({
  filePath,
  createInitialData,
  validateData = null,
  maxBackups = 5,
  onCorruption = null,
}) {
  const resolvedPath = path.resolve(filePath);
  const dirPath = path.dirname(resolvedPath);
  const baseName = path.basename(resolvedPath, path.extname(resolvedPath));
  const backupsDir = path.join(dirPath, "backups");

  let writeCounter = 0;
  let backupCounter = 0;
  let queue = Promise.resolve();

  function ensureDirectories() {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  /**
   * Salva uma cópia de segurança rotativa do arquivo atual e mantém apenas os `maxBackups` mais recentes.
   */
  async function rotateBackup() {
    if (!fs.existsSync(resolvedPath)) return;

    ensureDirectories();
    backupCounter += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupName = `${baseName}-${stamp}-${String(backupCounter).padStart(3, "0")}.json`;
    const backupPath = path.join(backupsDir, backupName);

    await fs.promises.copyFile(resolvedPath, backupPath);

    const allFiles = await fs.promises.readdir(backupsDir);
    const matching = allFiles
      .filter((name) => name.startsWith(`${baseName}-`) && name.endsWith(".json"))
      .sort();

    if (matching.length > maxBackups) {
      const toRemove = matching.slice(0, matching.length - maxBackups);
      for (const oldFile of toRemove) {
        try {
          await fs.promises.unlink(path.join(backupsDir, oldFile));
        } catch {
          // Ignora falha na limpeza de backup antigo
        }
      }
    }
  }

  /**
   * Grava os dados de forma atômica (.tmp + rename) após rotacionar backup.
   */
  async function writeAtomically(data) {
    ensureDirectories();
    await rotateBackup();

    writeCounter += 1;
    const tmpPath = path.join(
      dirPath,
      `${path.basename(resolvedPath)}.${process.pid}.${writeCounter}.tmp`
    );
    const serialized = JSON.stringify(data, null, 2) + "\n";

    await fs.promises.writeFile(tmpPath, serialized, "utf-8");
    await renameWithRetry(tmpPath, resolvedPath);
    return data;
  }

  /**
   * Lê o arquivo JSON do disco; se estiver corrompido, renomeia para `*.corrupt-<timestamp>`
   * e reinicializa com uma estrutura limpa sem perder o arquivo original.
   */
  async function readOrRecover() {
    ensureDirectories();

    if (!fs.existsSync(resolvedPath)) {
      return createInitialData();
    }

    const raw = await fs.promises.readFile(resolvedPath, "utf-8");
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Raiz do JSON inválida.");
      }
      if (typeof validateData === "function" && !validateData(parsed)) {
        throw new Error("Estrutura do JSON incompatível com o esquema esperado.");
      }
      return parsed;
    } catch (err) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const corruptPath = `${resolvedPath}.corrupt-${stamp}`;
      try {
        await renameWithRetry(resolvedPath, corruptPath);
      } catch {
        // Se não conseguir renomear, sobrescreve a seguir
      }

      const message = `Arquivo corrompido detectado em ${resolvedPath}. Movido para ${corruptPath}.`;
      console.warn(`[atomicJsonStore] ${message} (${err.message})`);
      if (typeof onCorruption === "function") {
        onCorruption({ filePath: resolvedPath, corruptPath, error: err });
      }

      const fresh = createInitialData();
      await writeAtomically(fresh);
      return fresh;
    }
  }

  /**
   * Enfileira uma operação assíncrona na fila única deste arquivo para evitar corrida de escrita.
   */
  function enqueue(task) {
    const execution = queue.then(task, task);
    queue = execution.catch(() => {});
    return execution;
  }

  /**
   * Lê o estado atual respeitando a fila de operações pendentes.
   */
  function read() {
    return enqueue(() => readOrRecover());
  }

  /**
   * Executa uma transação atômica de leitura -> modificação -> gravação.
   */
  function update(mutatorFn) {
    return enqueue(async () => {
      const current = await readOrRecover();
      const outcome = await mutatorFn(current);

      if (outcome && typeof outcome === "object" && "data" in outcome) {
        await writeAtomically(outcome.data);
        return outcome.result;
      }

      await writeAtomically(current);
      return outcome;
    });
  }

  return {
    filePath: resolvedPath,
    backupsDir,
    read,
    update,
  };
}