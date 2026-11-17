/**
 * Diagnóstico completo do ambiente (Node.js + Worker Python + dependências externas).
 * Pode ser executado no terminal (`npm run doctor`) ou importado pela rota GET /api/health.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getVenvPaths, ROOT_DIR } from "./lib/venvPaths.js";

/**
 * Lê a versão esperada do contrato em config/default.json (padrão: 1).
 */
function getExpectedContractVersion() {
  const configPath = path.join(ROOT_DIR, "config", "default.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return Number(parsed?.worker?.contract_version ?? 1);
  } catch {
    return 1;
  }
}

/**
 * Verifica se o Node.js está acessível no PATH (usado como runtime JS pelo yt-dlp).
 */
function checkJsRuntimeInPath() {
  const res = spawnSync("node", ["-v"], {
    encoding: "utf-8",
    timeout: 5000,
  });
  if (res.status === 0 && res.stdout) {
    return {
      ok: true,
      version: res.stdout.trim(),
    };
  }
  return { ok: false, version: "" };
}

/**
 * Executa todas as verificações de ambiente e retorna o objeto padronizado
 * para a rota GET /api/health (CONTRACTS.md §2.4).
 */
export async function runDoctor() {
  const checks = [];
  let ytdlpVersion = "";

  // 1. Versão do Node.js (>= 20)
  const nodeVersionStr = process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersionStr.split(".")[0], 10);
  if (nodeMajor >= 20) {
    checks.push({
      id: "node",
      label: "Node.js",
      status: "ok",
      detail: `v${nodeVersionStr}`,
    });
  } else {
    checks.push({
      id: "node",
      label: "Node.js",
      status: "fail",
      detail: `v${nodeVersionStr} (mínimo exigido: v20.0.0)`,
      fix: "Instale o Node.js 20 ou superior no ambiente.",
    });
  }

  // 2. Runtime JS no PATH (exigido por versões recentes do yt-dlp)
  const jsRuntime = checkJsRuntimeInPath();
  if (jsRuntime.ok) {
    checks.push({
      id: "js_runtime",
      label: "Runtime JS (yt-dlp)",
      status: "ok",
      detail: `Node.js ${jsRuntime.version} disponível no PATH`,
    });
  } else {
    checks.push({
      id: "js_runtime",
      label: "Runtime JS (yt-dlp)",
      status: "warn",
      detail: "Binário 'node' não encontrado no PATH global",
      fix: "Garanta que o Node.js esteja no PATH para que o yt-dlp resolva desafios do YouTube.",
    });
  }

  // 3. Ambiente virtual Python (worker/.venv)
  const venvPaths = getVenvPaths();
  if (!venvPaths.hasVenv) {
    checks.push({
      id: "venv",
      label: "Ambiente virtual Python (worker/.venv)",
      status: "fail",
      detail: `Não encontrado em ${venvPaths.venvDir}`,
      fix: "Execute: python3 worker/setup/install.py",
    });

    const ok = checks.every((c) => c.status !== "fail");
    return {
      doctor: { ok, checks },
      ytdlp_version: ytdlpVersion,
    };
  }

  checks.push({
    id: "venv",
    label: "Ambiente virtual Python (worker/.venv)",
    status: "ok",
    detail: venvPaths.venvDir,
  });

  // 4. Diagnóstico interno do Worker Python (`python -m karaoke_worker doctor --json`)
  const workerRes = spawnSync(
    venvPaths.pythonBin,
    ["-m", "karaoke_worker", "doctor", "--json"],
    {
      cwd: ROOT_DIR,
      encoding: "utf-8",
      timeout: 30000,
    }
  );

  if (workerRes.status !== 0 || !workerRes.stdout) {
    const errDetail = (workerRes.stderr || workerRes.error?.message || "Erro desconhecido").trim();
    checks.push({
      id: "worker",
      label: "Worker Python (karaoke_worker)",
      status: "fail",
      detail: `Falha ao executar doctor --json: ${errDetail}`,
      fix: "Recrie o ambiente virtual com: python3 worker/setup/install.py --force",
    });

    const ok = checks.every((c) => c.status !== "fail");
    return {
      doctor: { ok, checks },
      ytdlp_version: ytdlpVersion,
    };
  }

  let report;
  try {
    report = JSON.parse(workerRes.stdout.trim());
  } catch (err) {
    checks.push({
      id: "worker",
      label: "Worker Python (karaoke_worker)",
      status: "fail",
      detail: `Saída JSON inválida do worker: ${err.message}`,
      fix: "Verifique se nenhuma biblioteca está imprimindo texto no stdout do worker.",
    });

    const ok = checks.every((c) => c.status !== "fail");
    return {
      doctor: { ok, checks },
      ytdlp_version: ytdlpVersion,
    };
  }

  // 5. Compatibilidade do contract_version
  const expectedContract = getExpectedContractVersion();
  if (report.contract_version === expectedContract) {
    checks.push({
      id: "contract",
      label: "Contrato Node ↔ Python",
      status: "ok",
      detail: `v${report.contract_version} (Python ${report.python_version})`,
    });
  } else {
    checks.push({
      id: "contract",
      label: "Contrato Node ↔ Python",
      status: "fail",
      detail: `Versão incompatível: esperado v${expectedContract}, encontrado v${report.contract_version}`,
      fix: "Atualize o worker e execute: python3 worker/setup/install.py --force",
    });
  }

  // 6. Acelerador de hardware (CPU / GPU)
  const accelTest = report.accelerator_test || {};
  const installedProfile = report.accelerator_profile_installed || "unknown";
  const detectedProfile = report.accelerator_detected || "cpu";
  if (accelTest.ok) {
    checks.push({
      id: "accelerator",
      label: "Aceleração de IA",
      status: "ok",
      detail: `Perfil '${installedProfile}' ativo (dispositivo: ${accelTest.device}, detectado: ${detectedProfile})`,
    });
  } else {
    checks.push({
      id: "accelerator",
      label: "Aceleração de IA",
      status: "warn",
      detail: accelTest.detail || `Perfil '${installedProfile}' falhou; usando fallback CPU`,
      fix: "Para usar CPU sem avisos, execute: python3 worker/setup/install.py --accelerator cpu --force",
    });
  }

  // 7. FFmpeg
  if (report.ffmpeg?.ok) {
    checks.push({
      id: "ffmpeg",
      label: "FFmpeg",
      status: "ok",
      detail: report.ffmpeg.version,
    });
  } else {
    checks.push({
      id: "ffmpeg",
      label: "FFmpeg",
      status: "fail",
      detail: "Não encontrado no PATH",
      fix: "No Ubuntu/WSL2 instale com: sudo apt update && sudo apt install -y ffmpeg",
    });
  }

  // 8. yt-dlp
  ytdlpVersion = report.yt_dlp?.version || "";
  if (report.yt_dlp?.ok) {
    checks.push({
      id: "yt_dlp",
      label: "yt-dlp",
      status: "ok",
      detail: `v${ytdlpVersion}`,
    });
  } else {
    checks.push({
      id: "yt_dlp",
      label: "yt-dlp",
      status: "fail",
      detail: "Não encontrado ou falhou ao executar",
      fix: "Instale/atualize com: node scripts/update-ytdlp.js",
    });
  }

  // 9. Modelos de separação vocal
  const models = Array.isArray(report.models) ? report.models : [];
  const missingModels = models.filter((m) => !m.downloaded);
  if (models.length > 0 && missingModels.length === 0) {
    checks.push({
      id: "models",
      label: "Modelo de separação vocal",
      status: "ok",
      detail: models.map((m) => m.name).join(", "),
    });
  } else {
    const names = missingModels.map((m) => m.name).join(", ") || "nenhum configurado";
    checks.push({
      id: "models",
      label: "Modelo de separação vocal",
      status: "fail",
      detail: `Modelo ausente: ${names}`,
      fix: "Baixe o modelo executando: python3 worker/setup/install.py",
    });
  }

  // 10. Espaço livre em disco
  const freeGb = Number(report.disk_free_gb ?? 0);
  if (freeGb >= 5) {
    checks.push({
      id: "disk",
      label: "Espaço em disco",
      status: "ok",
      detail: `${freeGb} GB livres`,
    });
  } else if (freeGb >= 1) {
    checks.push({
      id: "disk",
      label: "Espaço em disco",
      status: "warn",
      detail: `Apenas ${freeGb} GB livres`,
      fix: "Libere espaço em disco para evitar falhas ao armazenar músicas em cache.",
    });
  } else {
    checks.push({
      id: "disk",
      label: "Espaço em disco",
      status: "fail",
      detail: `Espaço crítico: ${freeGb} GB livres`,
      fix: "Libere pelo menos 5 GB de espaço em disco antes de processar músicas.",
    });
  }

  const ok = checks.every((c) => c.status !== "fail");
  return {
    doctor: { ok, checks },
    ytdlp_version: ytdlpVersion,
  };
}

/**
 * Formata e imprime o relatório legível no terminal quando executado via CLI.
 */
async function cliMain() {
  const args = process.argv.slice(2);
  const result = await runDoctor();

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.doctor.ok ? 0 : 1);
  }

  console.log("\n=== Diagnóstico do Ambiente (game-karaoke-by-willian) ===\n");

  const badges = {
    ok: "[OK]   ",
    warn: "[AVISO]",
    fail: "[FALHA]",
  };

  for (const item of result.doctor.checks) {
    const badge = badges[item.status] || "[INFO] ";
    console.log(`${badge} ${item.label}: ${item.detail}`);
    if (item.fix) {
      console.log(`        -> Como corrigir: ${item.fix}`);
    }
  }

  console.log("");
  if (result.doctor.ok) {
    console.log("✅ Ambiente pronto! Todos os requisitos obrigatórios estão funcionando.\n");
    process.exit(0);
  } else {
    console.log("❌ Existem pendências obrigatórias acima. Siga as instruções para corrigir.\n");
    process.exit(1);
  }
}

// Executa o modo CLI apenas se o arquivo for chamado diretamente (`node scripts/doctor.js`)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cliMain();
}