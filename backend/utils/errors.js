/**
 * Padronização de erros HTTP da API (CONTRACTS.md §1).
 * Todas as rotas devolvem { error: { code, message } }.
 */

export class AppError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Envia uma resposta de erro padronizada em JSON.
 */
export function sendError(res, statusCode, code, message) {
  return res.status(statusCode).json({
    error: {
      code,
      message,
    },
  });
}

/**
 * Middleware global do Express para capturar erros lançados nas rotas.
 */
export function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    return sendError(res, err.statusCode, err.code, err.message);
  }

  // Erro de JSON malformado enviado no corpo da requisição
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return sendError(res, 400, "INVALID_JSON", "Corpo da requisição JSON inválido.");
  }

  console.error("[backend] Erro interno inesperado:", err);
  return sendError(res, 500, "INTERNAL_ERROR", "Erro interno no servidor local.");
}