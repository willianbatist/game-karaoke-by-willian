/**
 * Fila de processamento com concorrência 1 e transmissão SSE (ARCHITECTURE.md §13.2 e CONTRACTS.md §5.1).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadDefaultConfig } from "../utils/configLoader.js";
import { AppError } from "../utils/errors.js";
import { validateVideoId } from "../utils/security.js";

const DEFAULT_STEPS = ["download", "separate", "pitch", "analyze", "package"];

export function createJobQueue({
  cacheManager,
  supervisor,
  config = null,
  stepTimeoutMs = null,
}) {
  const effectiveConfig = config ?? loadDefaultConfig();
  const heartbeatSeconds = Number(effectiveConfig.server?.sse_heartbeat_seconds ?? 15);

  const configuredTimeoutMs =
    stepTimeoutMs != null
      ? Number(stepTimeoutMs)
      : config?.worker?.step_timeout_seconds != null
        ? Number(config.worker.step_timeout_seconds) * 1000
        : undefined;

  const jobs = new Map(); // jobId -> job
  const activeByVideoId = new Map(); // videoId -> jobId (somente queued/running)
  const pendingQueue = []; // array de jobIds aguardando execução
  let runningJobId = null;

  // Hooks registrados para pós-processamento antes da mesclagem final no manifest.json
  const postProcessHooks = [];

  /**
   * Mescla o resumo de lyrics.json em manifest.lyrics e inicializa manifest.user.
   */
  function defaultMergeLyricsAndUser(videoId) {
    const manifest = cacheManager.readManifest(videoId);
    if (!manifest) return;

    const lyricsData = cacheManager.readLyrics(videoId);
    let lyricsSummary = {
      source: "lrclib",
      type: "none",
      selected_id: null,
      offset_ms: manifest.lyrics?.offset_ms ?? 0,
      sync_quality: manifest.lyrics?.sync_quality ?? 0.0,
    };

    if (lyricsData && Array.isArray(lyricsData.candidates) && lyricsData.selected_id != null) {
      const selected = lyricsData.candidates.find((c) => c.id === lyricsData.selected_id);
      if (selected) {
        let type = "none";
        if (selected.syncedLyrics) type = "synced";
        else if (selected.plainLyrics) type = "plain";

        lyricsSummary = {
          source: "lrclib",
          type,
          selected_id: lyricsData.selected_id,
          offset_ms: manifest.lyrics?.offset_ms ?? 0,
          sync_quality: manifest.lyrics?.sync_quality ?? 0.0,
        };
      }
    }

    manifest.lyrics = lyricsSummary;
    manifest.user = {
      latency_offsets_ms: {},
      last_played: null,
      ...(manifest.user || {}),
    };

    cacheManager.writeManifestAtomic(videoId, manifest, { isJobActive: false });
  }

  function registerOnJobDone(hookFn) {
    if (typeof hookFn === "function") {
      postProcessHooks.push(hookFn);
    }
  }

  async function runPostProcess(videoId) {
    for (const hook of postProcessHooks) {
      await hook(videoId);
    }
    defaultMergeLyricsAndUser(videoId);
  }

  function hasActiveJob(videoId) {
    return activeByVideoId.has(videoId);
  }

  function emitSseEvent(job, payload, { closeAfter = false } = {}) {
    job.history.push(payload);
    if (job.history.length > 50) {
      job.history.shift();
    }

    const serialized = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of job.sseClients) {
      try {
        client.res.write(serialized);
        if (closeAfter) {
          clearInterval(client.heartbeatTimer);
          client.res.end();
        }
      } catch {
        clearInterval(client.heartbeatTimer);
        job.sseClients.delete(client);
      }
    }

    if (closeAfter) {
      job.sseClients.clear();
    }
  }

  function notifyQueuePositions() {
    pendingQueue.forEach((queuedJobId, idx) => {
      const queuedJob = jobs.get(queuedJobId);
      if (queuedJob && queuedJob.state === "queued") {
        emitSseEvent(queuedJob, {
          event: "state",
          state: "queued",
          step: null,
          percent: 0,
          position: idx + 1,
        });
      }
    });
  }

  function getJobPublicState(jobId) {
    const job = jobs.get(jobId);
    if (!job) return null;

    const payload = {
      id: job.id,
      videoId: job.videoId,
      state: job.state,
      step: job.step,
      percent: job.percent,
    };

    if (job.device) {
      payload.device = job.device;
    }

    if (job.state === "queued") {
      const idx = pendingQueue.indexOf(job.id);
      if (idx >= 0) payload.position = idx + 1;
    }

    if (job.error) {
      payload.error = job.error;
    }

    return payload;
  }

  function enqueue(videoId) {
    if (!validateVideoId(videoId)) {
      throw new AppError(400, "INVALID_VIDEO_ID", "Identificador de vídeo inválido.");
    }

    if (cacheManager.isSongReady(videoId)) {
      return { status: "ready", videoId };
    }

    if (activeByVideoId.has(videoId)) {
      const existingId = activeByVideoId.get(videoId);
      const existingJob = jobs.get(existingId);
      return {
        status: existingJob.state,
        jobId: existingJob.id,
        videoId,
      };
    }

    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      videoId,
      state: "queued",
      step: null,
      percent: 0,
      device: null,
      error: null,
      history: [],
      sseClients: new Set(),
      cancelHandle: null,
      cancelRequested: false,
      doneWaiters: [],
    };

    jobs.set(jobId, job);
    activeByVideoId.set(videoId, jobId);
    pendingQueue.push(jobId);

    emitSseEvent(job, {
      event: "state",
      state: "queued",
      step: null,
      percent: 0,
      position: pendingQueue.length,
    });

    pump();

    return {
      status: job.state,
      jobId: job.id,
      videoId,
    };
  }

  function resolveDoneWaiters(job) {
    while (job.doneWaiters.length > 0) {
      const resolve = job.doneWaiters.shift();
      resolve(getJobPublicState(job.id));
    }
  }

  function pump() {
    if (runningJobId !== null) return;
    if (pendingQueue.length === 0) return;

    const nextJobId = pendingQueue.shift();
    const job = jobs.get(nextJobId);
    if (!job || job.state !== "queued") {
      pump();
      return;
    }

    runningJobId = job.id;
    job.state = "running";
    job.step = "download";
    job.percent = 0;

    emitSseEvent(job, {
      event: "state",
      state: "running",
      step: job.step,
      percent: 0,
    });

    notifyQueuePositions();
    executeJob(job);
  }

  async function executeJob(job) {
    const workdir = cacheManager.ensureSongDir(job.videoId);
    const jobFilePath = path.join(workdir, `job.${job.id}.json`);

    const jobPayload = {
      contract_version: Number(effectiveConfig.worker?.contract_version ?? 1),
      video_id: job.videoId,
      workdir,
      steps: DEFAULT_STEPS,
      options: {
        separation_model:
          effectiveConfig.worker?.separation_model ?? "UVR_MDXNET_KARA_2.onnx",
        device: "auto",
        pitch_extractor: effectiveConfig.worker?.pitch_extractor ?? "pyin",
        pitch_hop_seconds: Number(effectiveConfig.worker?.pitch_hop_seconds ?? 0.02),
        output_audio_format: effectiveConfig.cache?.audio_format ?? "flac",
      },
    };

    fs.writeFileSync(jobFilePath, JSON.stringify(jobPayload, null, 2) + "\n", "utf-8");

    const runHandle = supervisor.runJob(jobFilePath, {
      ...(configuredTimeoutMs != null ? { stepTimeoutMs: configuredTimeoutMs } : {}),
      onEvent: (evt) => {
        if (evt.event === "progress") {
          job.step = evt.step ?? job.step;
          if (typeof evt.percent === "number") job.percent = evt.percent;
          if (evt.device) job.device = evt.device;
        } else if (evt.event === "step_done") {
          job.step = evt.step ?? job.step;
          job.percent = 100;
        }
        emitSseEvent(job, evt);
      },
    });

    job.cancelHandle = runHandle;

    let outcome;
    try {
      outcome = await runHandle.promise;
    } catch (err) {
      outcome = {
        exitCode: 20,
        timedOut: false,
        canceled: job.cancelRequested,
        lastErrorEvent: {
          code: "WORKER_SPAWN_ERROR",
          message: err.message,
          retryable: false,
        },
      };
    } finally {
      try {
        fs.unlinkSync(jobFilePath);
      } catch {
        // Ignora se já removido
      }
    }

    activeByVideoId.delete(job.videoId);
    runningJobId = null;

    if (job.cancelRequested || outcome.canceled) {
      job.state = "canceled";
      emitSseEvent(
        job,
        {
          event: "state",
          state: "canceled",
          step: job.step,
          percent: job.percent,
        },
        { closeAfter: true }
      );
      resolveDoneWaiters(job);
      pump();
      return;
    }

    if (outcome.timedOut) {
      job.state = "failed";
      job.error = {
        code: "STEP_TIMEOUT",
        message: `Tempo limite excedido na etapa '${job.step || "desconhecida"}'.`,
        retryable: true,
      };
      emitSseEvent(job, {
        event: "error",
        code: job.error.code,
        message: job.error.message,
        retryable: true,
      });
      emitSseEvent(
        job,
        {
          event: "state",
          state: "failed",
          step: job.step,
          percent: job.percent,
        },
        { closeAfter: true }
      );
      resolveDoneWaiters(job);
      pump();
      return;
    }

    if (outcome.exitCode === 130) {
      job.state = "canceled";
      emitSseEvent(
        job,
        {
          event: "state",
          state: "canceled",
          step: job.step,
          percent: job.percent,
        },
        { closeAfter: true }
      );
      resolveDoneWaiters(job);
      pump();
      return;
    }

    if (outcome.exitCode !== 0 || !cacheManager.isSongReady(job.videoId)) {
      job.state = "failed";
      job.error = outcome.lastErrorEvent
        ? {
            code: outcome.lastErrorEvent.code || "WORKER_FAILED",
            message: outcome.lastErrorEvent.message || "Falha no processamento.",
            retryable: Boolean(outcome.lastErrorEvent.retryable),
          }
        : {
            code: "WORKER_FAILED",
            message: `Worker encerrou com código ${outcome.exitCode}.`,
            retryable: outcome.exitCode === 10,
          };

      emitSseEvent(
        job,
        {
          event: "state",
          state: "failed",
          step: job.step,
          percent: job.percent,
        },
        { closeAfter: true }
      );
      resolveDoneWaiters(job);
      pump();
      return;
    }

    try {
      await runPostProcess(job.videoId);
      cacheManager.enforceLru({ hasActiveJob });
    } catch (postErr) {
      console.error("[jobQueue] Erro no pós-processamento:", postErr);
    }

    job.state = "ready";
    job.percent = 100;

    emitSseEvent(
      job,
      {
        event: "state",
        state: "ready",
        step: "package",
        percent: 100,
      },
      { closeAfter: true }
    );

    resolveDoneWaiters(job);
    pump();
  }

  async function cancelJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) {
      throw new AppError(404, "JOB_NOT_FOUND", "Job não encontrado.");
    }

    if (job.state === "ready" || job.state === "failed" || job.state === "canceled") {
      return { state: job.state };
    }

    if (job.state === "queued") {
      const idx = pendingQueue.indexOf(jobId);
      if (idx >= 0) pendingQueue.splice(idx, 1);
      activeByVideoId.delete(job.videoId);
      job.state = "canceled";
      job.cancelRequested = true;

      emitSseEvent(
        job,
        {
          event: "state",
          state: "canceled",
          step: null,
          percent: 0,
        },
        { closeAfter: true }
      );
      notifyQueuePositions();
      resolveDoneWaiters(job);
      return { state: "canceled" };
    }

    job.cancelRequested = true;
    const waitTermination = new Promise((resolve) => {
      job.doneWaiters.push(resolve);
    });
    job.cancelHandle?.cancel();
    await waitTermination;

    return { state: "canceled" };
  }

  function subscribeSse(jobId, req, res) {
    const job = jobs.get(jobId);
    if (!job) {
      throw new AppError(404, "JOB_NOT_FOUND", "Job não encontrado.");
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    for (const pastEvent of job.history) {
      res.write(`data: ${JSON.stringify(pastEvent)}\n\n`);
    }

    if (job.state === "ready" || job.state === "failed" || job.state === "canceled") {
      res.end();
      return;
    }

    const heartbeatTimer = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(heartbeatTimer);
      }
    }, Math.max(1, heartbeatSeconds) * 1000);
    heartbeatTimer.unref();

    const client = { res, heartbeatTimer };
    job.sseClients.add(client);

    req.on("close", () => {
      clearInterval(heartbeatTimer);
      job.sseClients.delete(client);
    });
  }

  function waitForJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return Promise.resolve(null);
    if (job.state === "ready" || job.state === "failed" || job.state === "canceled") {
      return Promise.resolve(getJobPublicState(jobId));
    }
    return new Promise((resolve) => {
      job.doneWaiters.push(resolve);
    });
  }

  return {
    enqueue,
    cancelJob,
    getJobPublicState,
    subscribeSse,
    registerOnJobDone,
    runPostProcess,
    hasActiveJob,
    waitForJob,
  };
}