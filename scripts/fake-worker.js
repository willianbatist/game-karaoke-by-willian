/**
 * Worker simulado (Node.js) que obedece ao contrato Node <-> Python v1 (CONTRACTS.md §2).
 * Usado nos testes automatizados da fila, SSE, cancelamento e retomada.
 */

import fs from "node:fs";
import path from "node:path";

let canceled = false;

process.on("SIGTERM", () => {
  canceled = true;
  process.exit(130);
});

process.on("SIGINT", () => {
  canceled = true;
  process.exit(130);
});

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const cmd = argv[0];
  let jobPath = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--job" && argv[i + 1]) {
      jobPath = argv[i + 1];
      i++;
    }
  }
  return { cmd, jobPath };
}

async function main() {
  const { cmd, jobPath } = parseArgs(process.argv.slice(2));

  if (cmd === "doctor") {
    process.stdout.write(
      JSON.stringify({
        contract_version: 1,
        python_version: "3.12.0-fake",
        accelerator_profile_installed: "cpu",
        accelerator_detected: "cpu",
        accelerator_test: { ok: true, device: "cpu", detail: "" },
        ffmpeg: { ok: true, version: "fake-ffmpeg" },
        yt_dlp: { ok: true, version: "2026.01.01" },
        models: [{ name: "UVR_MDXNET_KARA_2.onnx", downloaded: true }],
        disk_free_gb: 100.0,
      }) + "\n"
    );
    process.exit(0);
  }

  if (cmd !== "run" || !jobPath) {
    process.stderr.write("Uso: fake-worker.js run --job <caminho>\n");
    process.exit(30);
  }

  const job = JSON.parse(fs.readFileSync(jobPath, "utf-8"));
  if (job.contract_version !== 1) {
    emit({
      event: "error",
      code: "CONTRACT_MISMATCH",
      message: "contract_version inválida",
      retryable: false,
    });
    process.exit(20);
  }

  const workdir = path.resolve(job.workdir);
  fs.mkdirSync(workdir, { recursive: true });

  const manifestPath = path.join(workdir, "manifest.json");
  let manifest = {
    schema_version: 1,
    video_id: job.video_id,
    status: "running",
    steps_done: [],
    source: {
      title: `Música Teste ${job.video_id}`,
      channel: "Canal Teste",
      duration: 180.0,
    },
    pipeline: {
      separation_model: job.options?.separation_model || "UVR_MDXNET_KARA_2.onnx",
      pitch_extractor: job.options?.pitch_extractor || "pyin",
      device_used: "cpu",
      worker_contract_version: 1,
    },
    files: {},
    metrics: {},
  };

  if (fs.existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      if (existing && typeof existing === "object") {
        manifest = { ...manifest, ...existing };
      }
    } catch {
      // Ignora manifest anterior inválido
    }
  }

  const stepDelayMs = Number(process.env.FAKE_WORKER_STEP_DELAY_MS ?? 15);
  const failStep = process.env.FAKE_WORKER_FAIL_STEP || "";
  const hangStep = process.env.FAKE_WORKER_HANG_STEP || "";
  const retryableFail = process.env.FAKE_WORKER_RETRYABLE === "1";

  const steps = Array.isArray(job.steps)
    ? job.steps
    : ["download", "separate", "pitch", "analyze", "package"];

  for (const step of steps) {
    if (canceled) process.exit(130);

    // Retomada / idempotência: pula etapas já concluídas
    if (Array.isArray(manifest.steps_done) && manifest.steps_done.includes(step)) {
      emit({ event: "step_done", step, artifacts: [], seconds: 0.0 });
      continue;
    }

    emit({
      event: "progress",
      step,
      percent: 25,
      message: `Executando ${step}`,
      ...(step === "separate" ? { device: "cpu" } : {}),
    });

    if (hangStep === step) {
      // Simula etapa travada para testar timeout e cancelamento
      await sleep(60000);
    }

    if (failStep === step) {
      emit({
        event: "error",
        code: "FAKE_STEP_ERROR",
        message: `Erro simulado na etapa ${step}`,
        retryable: retryableFail,
      });
      process.exit(retryableFail ? 10 : 30);
    }

    await sleep(stepDelayMs);

    if (step === "analyze") {
      manifest.metrics = {
        voiced_ratio: 0.72,
        mean_confidence: 0.85,
        vocal_energy_ratio: 0.25,
        bleed_estimate: 0.05,
        backing_vocals_estimate: 0.12,
        pitch_stability: 0.98,
      };
    }

    if (step === "package") {
      fs.writeFileSync(path.join(workdir, "instrumental.flac"), "FAKE_FLAC_INST");
      fs.writeFileSync(path.join(workdir, "vocals.flac"), "FAKE_FLAC_VOCALS");
      fs.writeFileSync(
        path.join(workdir, "pitch_map.json"),
        JSON.stringify({
          schema_version: 1,
          extractor: "pyin",
          hop: 0.02,
          t0: 0.0,
          midi: [null, 60.0, 62.0],
          conf: [0.0, 0.9, 0.92],
          mode: "reference",
        })
      );
      manifest.status = "ready";
      manifest.files = {
        instrumental: "instrumental.flac",
        vocals: "vocals.flac",
        pitch_map: "pitch_map.json",
      };
    }

    manifest.steps_done = [...new Set([...(manifest.steps_done || []), step])];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    emit({
      event: "step_done",
      step,
      artifacts:
        step === "package"
          ? ["instrumental.flac", "vocals.flac", "pitch_map.json", "manifest.json"]
          : [],
      seconds: Number((stepDelayMs / 1000).toFixed(3)),
    });
  }

  emit({ event: "done", manifest: "manifest.json" });
  process.exit(0);
}

main();