/**
 * Servidor HTTP orquestrador local (ARCHITECTURE.md §5.1 e §13.5).
 * Vinculado estritamente a 127.0.0.1 e servindo frontend/ + /api/* na mesma origem.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import configRouter from "./routes/config.js";
import { createHealthRouter } from "./routes/health.js";
import { createJobsRouter } from "./routes/jobs.js";
import { createPrepareRouter } from "./routes/prepare.js";
import { createSearchRouter } from "./routes/search.js";
import { createSongsRouter } from "./routes/songs.js";
import { createCacheManager } from "./services/cacheManager.js";
import { createJobQueue } from "./services/jobQueue.js";
import { createLyricsService } from "./services/lyricsService.js";
import { createProcessSupervisor } from "./services/processSupervisor.js";
import { createYoutubeSearchService } from "./services/youtubeSearchService.js";
import { CACHE_DIR, FRONTEND_DIR, loadDefaultConfig } from "./utils/configLoader.js";
import { errorHandler, sendError } from "./utils/errors.js";

/**
 * Cria e configura a instância do Express (aceita injeção de dependências nos testes).
 */
export function createApp(overrides = {}) {
  const cfg = overrides.config ?? loadDefaultConfig();

  const cacheManager =
    overrides.cacheManager ??
    createCacheManager({
      cacheRoot: overrides.cacheRoot ?? CACHE_DIR,
      maxSizeGb: Number(cfg.cache?.max_size_gb ?? 10),
    });

  const supervisor = overrides.supervisor ?? createProcessSupervisor();

  const jobQueue =
    overrides.jobQueue ??
    createJobQueue({
      cacheManager,
      supervisor,
      config: cfg,
    });

  const lyricsService =
    overrides.lyricsService ??
    createLyricsService({
      cacheManager,
      config: cfg,
    });

  const youtubeSearchService =
    overrides.youtubeSearchService ??
    createYoutubeSearchService({
      cacheManager,
    });

  // Ao finalizar um job no Worker Python, busca a letra no LRCLIB antes de fechar manifest.json
  jobQueue.registerOnJobDone(async (videoId) => {
    const manifest = cacheManager.readManifest(videoId);
    if (!manifest) return;
    await lyricsService.fetchAndSaveLyrics(videoId, {
      title: manifest.source?.title ?? "",
      channel: manifest.source?.channel ?? "",
      duration: manifest.source?.duration ?? null,
    });
  });

  const app = express();
  app.use(express.json());

  // Rotas da API (CONTRACTS.md §5 e Fase 4)
  app.use("/api/config", configRouter);
  app.use("/api/search", createSearchRouter({ youtubeSearchService }));
  app.use("/api/prepare", createPrepareRouter({ jobQueue }));
  app.use("/api/jobs", createJobsRouter({ jobQueue }));
  app.use("/api/songs", createSongsRouter({ cacheManager, jobQueue }));
  app.use(
    "/api/health",
    createHealthRouter({
      cacheManager,
      doctorOptions: overrides.doctorOptions,
    })
  );

  // Qualquer rota /api/* não mapeada devolve 404 padronizado em JSON
  app.use("/api", (_req, res) => {
    return sendError(res, 404, "NOT_FOUND", "Endpoint da API não encontrado.");
  });

  // Entrega os arquivos estáticos do frontend na mesma origem
  app.use(express.static(FRONTEND_DIR));

  // Tratamento global de erros
  app.use(errorHandler);

  // Expõe referências internas para reidratação na inicialização ou inspeção em testes
  app.locals.services = {
    cacheManager,
    supervisor,
    jobQueue,
    lyricsService,
    youtubeSearchService,
  };

  return app;
}

/**
 * Inicia o servidor escutando estritamente em 127.0.0.1 e reidrata músicas prontas do cache.
 */
export async function startServer() {
  const cfg = loadDefaultConfig();
  const host = "127.0.0.1"; // Segurança local: nunca expor em 0.0.0.0
  const port = Number(cfg.server?.port ?? 3000);

  const app = createApp({ config: cfg });
  const { cacheManager, jobQueue } = app.locals.services;

  await cacheManager.rehydrate({
    hasActiveJob: jobQueue.hasActiveJob,
    onNeedsPostProcess: jobQueue.runPostProcess,
  });

  const server = app.listen(port, host, () => {
    console.log(`Servidor Karaokê Local ativo em http://${host}:${port}`);
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer();
}