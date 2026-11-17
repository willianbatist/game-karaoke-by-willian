/**
 * Script de benchmark e validação do Spike (T0.6).
 * Executa o Worker Python sequencialmente sobre a lista de músicas em
 * `scripts/spike-songs.json`, coleta tempos e métricas acústicas e gera
 * `scripts/spike-report.json` para apoiar a calibração dos limiares.
 *
 * Uso:
 *   node scripts/spike-benchmark.js              (roda todas as músicas da lista)
 *   node scripts/spike-benchmark.js --limit 3    (roda apenas as 3 primeiras)
 *   node scripts/spike-benchmark.js --force      (reprocessa mesmo se já estiver ready)
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getVenvPaths, ROOT_DIR } from "./lib/venvPaths.js";

const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
const SONGS_FILE = path.join(ROOT_DIR, "scripts", "spike-songs.json");
const REPORT_FILE = path.join(ROOT_DIR, "scripts", "spike-report.json");
const DEFAULT_CONFIG_FILE = path.join(ROOT_DIR, "config", "default.json");
const WEIGHTS_CONFIG_FILE = path.join(ROOT_DIR, "config", "compatibility-weights.json");
const CACHE_DIR = path.join(ROOT_DIR, "backend", "cache");

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/**
 * Calcula a pontuação e o nível acústico preliminar conforme CONTRACTS.md §8.2
 * (considerando apenas as 6 métricas acústicas do worker, sem letra nesta fase).
 */
function evaluateAcousticCompatibility(metrics, pitchMode, weightsCfg) {
  const weights = weightsCfg.weights || {};
  const thresholds = weightsCfg.thresholds || {};
  const minVoiced = Number(weightsCfg.incompatible_rules?.min_voiced_ratio ?? 0.05);

  if (pitchMode === "heuristic" || Number(metrics.voiced_ratio ?? 0) < minVoiced) {
    return {
      level: "incompatible",
      score: 0,
      note: pitchMode === "heuristic" ? "Modo heurístico (instrumental)" : "Pouquíssima voz detectada",
    };
  }

  const normalized = {
    voiced_ratio: Number(metrics.voiced_ratio ?? 0),
    mean_confidence: Number(metrics.mean_confidence ?? 0),
    vocal_energy_ratio: Number(metrics.vocal_energy_ratio ?? 0),
    bleed_estimate: 1 - Number(metrics.bleed_estimate ?? 1),
    backing_vocals_estimate: 1 - Number(metrics.backing_vocals_estimate ?? 1),
    pitch_stability: Number(metrics.pitch_stability ?? 0),
  };

  let weightedSum = 0;
  let weightTotal = 0;

  for (const [key, mPrime] of Object.entries(normalized)) {
    const w = Number(weights[key] ?? 0);
    weightedSum += w * mPrime;
    weightTotal += w;
  }

  const score = weightTotal > 0 ? weightedSum / weightTotal : 0;
  let level = "incompatible";
  if (score >= Number(thresholds.excellent ?? 0.8)) level = "excellent";
  else if (score >= Number(thresholds.good ?? 0.65)) level = "good";
  else if (score >= Number(thresholds.regular ?? 0.5)) level = "regular";
  else if (score >= Number(thresholds.low ?? 0.3)) level = "low";

  return {
    level,
    score: Number(score.toFixed(4)),
    note: "",
  };
}

function normalizeSongEntries(rawList) {
  if (!Array.isArray(rawList)) {
    throw new Error("O arquivo scripts/spike-songs.json deve conter um array JSON.");
  }

  return rawList.map((item, idx) => {
    if (typeof item === "string") {
      return { videoId: item.trim(), category: "Não informada", index: idx + 1 };
    }
    if (item && typeof item === "object" && typeof item.videoId === "string") {
      return {
        videoId: item.videoId.trim(),
        category: String(item.category || "Não informada"),
        index: idx + 1,
      };
    }
    throw new Error(`Item inválido na posição ${idx + 1} de scripts/spike-songs.json.`);
  });
}

function parseCliArgs(argv) {
  let limit = Infinity;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--force") {
      force = true;
    } else if (argv[i] === "--limit" && argv[i + 1]) {
      limit = Number.parseInt(argv[i + 1], 10);
      i++;
    }
  }
  return { limit, force };
}

function main() {
  const { limit, force } = parseCliArgs(process.argv.slice(2));
  const venvPaths = getVenvPaths();

  if (!venvPaths.hasVenv) {
    console.error("❌ Ambiente virtual Python não encontrado. Rode: python3 worker/setup/install.py");
    process.exit(1);
  }

  if (!fs.existsSync(SONGS_FILE)) {
    console.error(`❌ Arquivo não encontrado: ${SONGS_FILE}`);
    process.exit(1);
  }

  const defaultCfg = loadJson(DEFAULT_CONFIG_FILE);
  const weightsCfg = loadJson(WEIGHTS_CONFIG_FILE);
  const allEntries = normalizeSongEntries(loadJson(SONGS_FILE));

  if (allEntries.length === 0) {
    console.error("❌ O arquivo scripts/spike-songs.json está vazio. Adicione seus videoIds primeiro.");
    process.exit(1);
  }

  for (const entry of allEntries) {
    if (!VIDEO_ID_REGEX.test(entry.videoId)) {
      console.error(
        `❌ videoId inválido no item ${entry.index}: "${entry.videoId}". ` +
          "Deve ter exatamente 11 caracteres (letras, números, _ ou -)."
      );
      process.exit(1);
    }
  }

  const entries = allEntries.slice(0, Number.isFinite(limit) ? limit : allEntries.length);

  console.log(`\n=== Spike Benchmark (T0.6) — ${entries.length} de ${allEntries.length} música(s) ===\n`);

  const results = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const workdir = path.join(CACHE_DIR, entry.videoId);
    const manifestPath = path.join(workdir, "manifest.json");
    const pitchMapPath = path.join(workdir, "pitch_map.json");

    if (force && fs.existsSync(workdir)) {
      fs.rmSync(workdir, { recursive: true, force: true });
    }

    fs.mkdirSync(workdir, { recursive: true });

    const jobPath = path.join(workdir, "spike_job.json");
    const jobPayload = {
      contract_version: Number(defaultCfg.worker?.contract_version ?? 1),
      video_id: entry.videoId,
      workdir,
      steps: ["download", "separate", "pitch", "analyze", "package"],
      options: {
        separation_model: defaultCfg.worker?.separation_model,
        device: "auto",
        pitch_extractor: defaultCfg.worker?.pitch_extractor ?? "pyin",
        pitch_hop_seconds: Number(defaultCfg.worker?.pitch_hop_seconds ?? 0.02),
        output_audio_format: defaultCfg.cache?.audio_format ?? "flac",
      },
    };
    fs.writeFileSync(jobPath, JSON.stringify(jobPayload, null, 2) + "\n", "utf-8");

    console.log(`[${i + 1}/${entries.length}] Processando ${entry.videoId} (${entry.category})...`);
    const tStart = Date.now();

    const proc = spawnSync(
      venvPaths.pythonBin,
      ["-m", "karaoke_worker", "run", "--job", jobPath],
      {
        cwd: ROOT_DIR,
        encoding: "utf-8",
        maxBuffer: 20 * 1024 * 1024,
      }
    );

    const elapsedSeconds = Number(((Date.now() - tStart) / 1000).toFixed(2));
    fs.unlinkSync(jobPath);

    // Extrai tempos por etapa a partir dos eventos JSON Lines do stdout
    const stepSeconds = {};
    const warnings = [];
    let lastError = null;

    for (const line of (proc.stdout || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed);
        if (evt.event === "step_done" && evt.step) {
          stepSeconds[evt.step] = evt.seconds;
        } else if (evt.event === "warning") {
          warnings.push(`${evt.code}: ${evt.message}`);
        } else if (evt.event === "error") {
          lastError = `${evt.code}: ${evt.message}`;
        }
      } catch {
        // Ignora linhas não JSON se existirem
      }
    }

    if (proc.status !== 0 || !fs.existsSync(manifestPath)) {
      console.log(`   ❌ Falhou em ${elapsedSeconds}s — ${lastError || `exit code ${proc.status}`}\n`);
      results.push({
        videoId: entry.videoId,
        category: entry.category,
        ok: false,
        elapsedSeconds,
        error: lastError || `exit code ${proc.status}`,
      });
      continue;
    }

    const manifest = loadJson(manifestPath);
    const pitchMap = fs.existsSync(pitchMapPath) ? loadJson(pitchMapPath) : { mode: "reference" };
    const metrics = manifest.metrics || {};
    const compat = evaluateAcousticCompatibility(metrics, pitchMap.mode, weightsCfg);

    console.log(
      `   ✅ "${manifest.source?.title}" (${manifest.source?.duration}s) — ` +
        `Tempo: ${elapsedSeconds}s [${manifest.pipeline?.device_used}] | ` +
        `Modo: ${pitchMap.mode} | Nível atual: ${compat.level.toUpperCase()} (${compat.score})`
    );
    console.log(
      `      voiced=${metrics.voiced_ratio} | conf=${metrics.mean_confidence} | ` +
        `vocal_energy=${metrics.vocal_energy_ratio} | bleed=${metrics.bleed_estimate} | ` +
        `backing=${metrics.backing_vocals_estimate} | stability=${metrics.pitch_stability}\n`
    );

    results.push({
      videoId: entry.videoId,
      category: entry.category,
      ok: true,
      title: manifest.source?.title || entry.videoId,
      channel: manifest.source?.channel || "",
      duration: manifest.source?.duration || 0,
      deviceUsed: manifest.pipeline?.device_used || "cpu",
      elapsedSeconds,
      stepSeconds,
      pitchMode: pitchMap.mode,
      metrics,
      preliminaryAcousticCompatibility: compat,
      warnings,
      cacheDir: `backend/cache/${entry.videoId}`,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    totalSongs: entries.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + "\n", "utf-8");

  console.log("=== Resumo do Benchmark ===");
  console.log(`Sucesso: ${report.succeeded}/${report.totalSongs} | Falhas: ${report.failed}`);
  console.log(`Relatório salvo em: ${REPORT_FILE}`);
  console.log(
    "Os áudios separados (vocals.flac e instrumental.flac) estão em backend/cache/<videoId>/ para sua avaliação auditiva.\n"
  );
}

main();