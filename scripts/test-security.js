/**
 * Testes automatizados das guardas de segurança local (T1.1).
 * Executar com: node --test scripts/test-security.js
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AppError } from "../backend/utils/errors.js";
import { safeResolveCachePath, validateVideoId } from "../backend/utils/security.js";

test("validateVideoId aceita IDs válidos de 11 caracteres", () => {
  assert.equal(validateVideoId("abc123XYZ_0"), true);
  assert.equal(validateVideoId("jNQXAC9IVRw"), true);
  assert.equal(validateVideoId("-----------"), true);
  assert.equal(validateVideoId("___________"), true);
});

test("validateVideoId rejeita entradas inválidas ou maliciosas", () => {
  assert.equal(validateVideoId(""), false);
  assert.equal(validateVideoId(null), false);
  assert.equal(validateVideoId(undefined), false);
  assert.equal(validateVideoId(12345678901), false);
  assert.equal(validateVideoId("curto123"), false);
  assert.equal(validateVideoId("longodemais123"), false);
  assert.equal(validateVideoId("../secret12"), false);
  assert.equal(validateVideoId("abc/def1234"), false);
  assert.equal(validateVideoId("abc def1234"), false);
  assert.equal(validateVideoId("abc$def1234"), false);
});

test("safeResolveCachePath resolve arquivos legítimos dentro da pasta do vídeo", () => {
  const cacheRoot = path.resolve("backend", "cache");
  const videoId = "jNQXAC9IVRw";

  const resolved = safeResolveCachePath(cacheRoot, videoId, "instrumental.flac");
  assert.equal(resolved, path.join(cacheRoot, videoId, "instrumental.flac"));
});

test("safeResolveCachePath bloqueia tentativas de path traversal (../) e caminhos inválidos", () => {
  const cacheRoot = path.resolve("backend", "cache");
  const videoId = "jNQXAC9IVRw";

  // Tentativa de subir nível com ../
  assert.throws(
    () => safeResolveCachePath(cacheRoot, videoId, "../manifest.json"),
    (err) => err instanceof AppError && err.statusCode === 400
  );

  // Tentativa de acessar pasta de outro vídeo
  assert.throws(
    () => safeResolveCachePath(cacheRoot, videoId, "../z2ZmXRkXREw/manifest.json"),
    (err) => err instanceof AppError && err.statusCode === 400
  );

  // Tentativa de ler arquivo do sistema operacional
  assert.throws(
    () => safeResolveCachePath(cacheRoot, videoId, "../../../../etc/passwd"),
    (err) => err instanceof AppError && err.statusCode === 400
  );

  // Tentativa com caminho absoluto
  assert.throws(
    () => safeResolveCachePath(cacheRoot, videoId, "/etc/passwd"),
    (err) => err instanceof AppError && err.statusCode === 400
  );

  // Tentativa com videoId inválido
  assert.throws(
    () => safeResolveCachePath(cacheRoot, "../hack", "instrumental.flac"),
    (err) => err instanceof AppError && err.statusCode === 400 && err.code === "INVALID_VIDEO_ID"
  );

  // Tentativa com nome de arquivo vazio
  assert.throws(
    () => safeResolveCachePath(cacheRoot, videoId, ""),
    (err) => err instanceof AppError && err.statusCode === 400
  );
});