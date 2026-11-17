/**
 * Guardas de segurança local (ARCHITECTURE.md §13.5 e CONTRACTS.md §1):
 * - Validação estrita de videoId (11 caracteres).
 * - Resolução segura de caminhos dentro do cache (bloqueio de path traversal).
 */

import path from "node:path";
import { AppError } from "./errors.js";

const VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

/**
 * Verifica se o identificador do vídeo do YouTube é válido (11 caracteres).
 */
export function validateVideoId(id) {
  return typeof id === "string" && VIDEO_ID_REGEX.test(id);
}

/**
 * Resolve o caminho absoluto de um arquivo dentro de `cacheRoot/<videoId>/<filename>`,
 * bloqueando qualquer tentativa de sair da pasta da música (ex.: ../).
 */
export function safeResolveCachePath(cacheRoot, videoId, filename) {
  if (!validateVideoId(videoId)) {
    throw new AppError(400, "INVALID_VIDEO_ID", "Identificador de vídeo inválido.");
  }

  if (typeof filename !== "string" || filename.trim() === "" || filename.includes("\0")) {
    throw new AppError(400, "INVALID_FILENAME", "Nome de arquivo inválido.");
  }

  const resolvedCacheRoot = path.resolve(cacheRoot);
  const resolvedSongDir = path.resolve(resolvedCacheRoot, videoId);

  // Garante que a pasta da música está estritamente dentro de cacheRoot
  if (!resolvedSongDir.startsWith(resolvedCacheRoot + path.sep)) {
    throw new AppError(400, "PATH_TRAVERSAL", "Caminho de vídeo fora do diretório permitido.");
  }

  const resolvedFilePath = path.resolve(resolvedSongDir, filename);

  // Garante que o arquivo está diretamente dentro da pasta da música (bloqueia ../ e subpastas)
  if (
    !resolvedFilePath.startsWith(resolvedSongDir + path.sep) ||
    path.dirname(resolvedFilePath) !== resolvedSongDir
  ) {
    throw new AppError(400, "PATH_TRAVERSAL", "Acesso fora do diretório de cache bloqueado.");
  }

  return resolvedFilePath;
}