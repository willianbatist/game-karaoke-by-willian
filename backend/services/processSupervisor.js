/**
 * Supervisor de execução do Worker Python (ARCHITECTURE.md §5.3 e FASE_1 T1.2).
 * Invoca o worker via spawn com array de argumentos, faz parse de JSON Lines,
 * controla timeout por etapa e realiza cancelamento limpo.
 */

import { spawn } from "node:child_process";
import readline from "node:readline";
import { getVenvPaths, ROOT_DIR } from "../../scripts/lib/venvPaths.js";

/**
 * Encerra o processo filho de forma compatível com Linux/macOS (SIGTERM) e Windows (taskkill).
 */
function killChildProcess(child) {
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
      });
    } catch {
      // Ignora erro caso o processo já tenha encerrado
    }
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  // Garante encerramento forçado se o processo ignorar SIGTERM após 3 segundos
  const forceTimer = setTimeout(() => {
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Processo já finalizado
      }
    }
  }, 3000);
  forceTimer.unref();
}

/**
 * Cria um supervisor configurável (permite injetar o fake-worker nos testes).
 */
export function createProcessSupervisor(options = {}) {
  const venvPaths = getVenvPaths();
  const command = options.command ?? venvPaths.pythonBin;
  const baseArgs = options.baseArgs ?? ["-m", "karaoke_worker"];
  const cwd = options.cwd ?? ROOT_DIR;
  const defaultStepTimeoutMs = Number(options.stepTimeoutMs ?? 600 * 1000);
  const extraEnv = options.env ?? {};

  /**
   * Executa `run --job <jobPath>` e retorna { promise, cancel }.
   */
  function runJob(jobPath, callbacks = {}) {
    const { onEvent, stepTimeoutMs = defaultStepTimeoutMs } = callbacks;

    let child = null;
    let stepTimer = null;
    let timedOut = false;
    let canceled = false;
    let lastErrorEvent = null;
    let doneEvent = null;
    const stderrLines = [];

    const clearStepTimer = () => {
      if (stepTimer) {
        clearTimeout(stepTimer);
        stepTimer = null;
      }
    };

    const resetStepTimer = () => {
      clearStepTimer();
      if (stepTimeoutMs > 0) {
        stepTimer = setTimeout(() => {
          timedOut = true;
          killChildProcess(child);
        }, stepTimeoutMs);
        stepTimer.unref();
      }
    };

    const args = [...baseArgs, "run", "--job", jobPath];
    child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    resetStepTimer();

    // Lê stdout linha por linha como JSON Lines (CONTRACTS.md §2.2)
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    const rlClosed = new Promise((resolve) => {
      rl.on("close", resolve);
    });

    rl.on("line", (rawLine) => {
      const line = rawLine.trim();
      if (!line) return;

      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        // Ignora qualquer saída não JSON por segurança do contrato
        return;
      }

      if (!evt || typeof evt !== "object" || !evt.event) return;

      if (evt.event === "step_done") {
        resetStepTimer();
      } else if (evt.event === "error") {
        lastErrorEvent = evt;
      } else if (evt.event === "done") {
        doneEvent = evt;
      }

      if (typeof onEvent === "function") {
        onEvent(evt);
      }
    });

    // Captura últimas linhas de stderr apenas para diagnóstico de falha inesperada
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf-8").trim();
      if (!text) return;
      for (const line of text.split(/\r?\n/)) {
        stderrLines.push(line);
        if (stderrLines.length > 20) stderrLines.shift();
      }
    });

    const promise = new Promise((resolve, reject) => {
      child.on("error", (spawnErr) => {
        clearStepTimer();
        reject(spawnErr);
      });

      child.on("close", async (exitCode) => {
        clearStepTimer();
        await rlClosed;

        resolve({
          exitCode: exitCode ?? 1,
          timedOut,
          canceled,
          doneEvent,
          lastErrorEvent,
          stderrTail: stderrLines.join("\n"),
        });
      });
    });

    function cancel() {
      if (canceled) return;
      canceled = true;
      clearStepTimer();
      killChildProcess(child);
    }

    return { promise, cancel };
  }

  return { runJob };
}