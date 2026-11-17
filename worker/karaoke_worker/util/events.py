"""
Protocolo de saída em JSON Lines (stdout) e redirecionamento de logs livres (stderr).
Garante que nenhuma biblioteca externa polua o canal de eventos lido pelo Node.js.
"""

import json
import logging
import sys
from typing import Any

# Guarda a referência original do stdout exclusivamente para emitir eventos JSON
_JSON_STDOUT = sys.stdout


def redirect_library_stdout_to_stderr() -> None:
    """
    Redireciona sys.stdout e o sistema de logging do Python para sys.stderr.
    Assim, prints e avisos de bibliotecas (librosa, audio-separator, etc.)
    vão para stderr sem corromper o JSON Lines no stdout.
    """
    sys.stdout = sys.stderr

    root_logger = logging.getLogger()
    for handler in list(root_logger.handlers):
        root_logger.removeHandler(handler)

    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    )
    root_logger.addHandler(stderr_handler)
    root_logger.setLevel(logging.INFO)


def emit_event(payload: dict[str, Any]) -> None:
    """Escreve uma única linha JSON válida no stdout original com flush imediato."""
    line = json.dumps(payload, ensure_ascii=False)
    _JSON_STDOUT.write(line + "\n")
    _JSON_STDOUT.flush()


def emit_progress(
    step: str,
    percent: int,
    message: str,
    device: str | None = None,
) -> None:
    """Emite evento de progresso de uma etapa (CONTRACTS.md §2.2)."""
    payload: dict[str, Any] = {
        "event": "progress",
        "step": step,
        "percent": max(0, min(100, int(percent))),
        "message": message,
    }
    if device:
        payload["device"] = device
    emit_event(payload)


def emit_step_done(step: str, artifacts: list[str], seconds: float) -> None:
    """Emite evento informando que uma etapa concluiu com sucesso."""
    emit_event(
        {
            "event": "step_done",
            "step": step,
            "artifacts": artifacts,
            "seconds": round(float(seconds), 2),
        }
    )


def emit_warning(code: str, message: str) -> None:
    """Emite aviso não bloqueante durante a execução."""
    emit_event(
        {
            "event": "warning",
            "code": code,
            "message": message,
        }
    )


def emit_error(code: str, message: str, retryable: bool = False) -> None:
    """Emite erro estruturado antes do encerramento do processo."""
    emit_event(
        {
            "event": "error",
            "code": code,
            "message": message,
            "retryable": bool(retryable),
        }
    )


def emit_done(manifest: str = "manifest.json") -> None:
    """Emite evento final indicando que todo o pipeline terminou."""
    emit_event(
        {
            "event": "done",
            "manifest": manifest,
        }
    )