"""
Ponto de entrada CLI do Worker Python:
  python -m karaoke_worker run --job <caminho_job.json>
  python -m karaoke_worker doctor --json
"""

import argparse
import importlib
import json
import signal
import sys
from pathlib import Path
from typing import Any

from karaoke_worker import (
    EXIT_CANCELED,
    EXIT_DATA_ERROR,
    EXIT_DEPENDENCY_ERROR,
    EXIT_SUCCESS,
)
from karaoke_worker.contract import (
    DependencyWorkerError,
    JobCanceledError,
    JobContext,
    WorkerError,
    ensure_within_workdir,
    load_and_validate_job,
)
from karaoke_worker.util.events import (
    emit_done,
    emit_error,
    emit_event,
    redirect_library_stdout_to_stderr,
)
from karaoke_worker.util.hardware import (
    MODELS_DIR,
    ROOT_DIR,
    build_doctor_report,
    get_installed_profile,
    resolve_execution_device,
)

DEFAULT_CONFIG_FILE = ROOT_DIR / "config" / "default.json"


def _handle_termination_signal(signum: int, _frame: Any) -> None:
    """Converte SIGTERM/SIGINT em exceção controlada para sair com código 130."""
    raise JobCanceledError(f"Processo interrompido por sinal ({signum}).")


def _load_app_config() -> dict[str, Any]:
    """Carrega config/default.json se disponível."""
    if DEFAULT_CONFIG_FILE.is_file():
        try:
            return json.loads(DEFAULT_CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def cmd_doctor(_args: argparse.Namespace) -> int:
    """Executa o diagnóstico e imprime uma única linha JSON no stdout."""
    report = build_doctor_report()
    emit_event(report)
    return EXIT_SUCCESS


def cmd_run(args: argparse.Namespace) -> int:
    """Valida o job.json e executa sequencialmente as etapas solicitadas."""
    job_path = Path(args.job).resolve()
    job = load_and_validate_job(job_path)

    # Garante que o diretório de trabalho exista antes de iniciar as etapas
    job.workdir.mkdir(parents=True, exist_ok=True)
    manifest_path = ensure_within_workdir(job.workdir, "manifest.json")

    app_config = _load_app_config()
    installed_profile = get_installed_profile()
    requested_device = str(job.options.get("device", "auto"))
    resolved_device = resolve_execution_device(requested_device, installed_profile)

    ctx = JobContext(
        job=job,
        workdir=job.workdir,
        models_dir=MODELS_DIR,
        config=app_config,
        device=resolved_device,
        manifest_path=manifest_path,
    )

    for step_name in job.steps:
        module_name = f"karaoke_worker.steps.{step_name}"
        try:
            step_module = importlib.import_module(module_name)
        except ModuleNotFoundError as exc:
            raise DependencyWorkerError(
                f"Módulo da etapa '{step_name}' ainda não implementado ({module_name}).",
                code="STEP_NOT_IMPLEMENTED",
            ) from exc

        run_fn = getattr(step_module, "run", None)
        if not callable(run_fn):
            raise DependencyWorkerError(
                f"A etapa '{module_name}' não expõe a função run(ctx).",
                code="INVALID_STEP_MODULE",
            )

        run_fn(ctx)

    emit_done("manifest.json")
    return EXIT_SUCCESS


def main(argv: list[str] | None = None) -> int:
    # Reserva stdout exclusivamente para JSON Lines e redireciona bibliotecas para stderr
    redirect_library_stdout_to_stderr()

    # Trata encerramento gracioso (SIGTERM / SIGINT -> código 130)
    signal.signal(signal.SIGTERM, _handle_termination_signal)
    signal.signal(signal.SIGINT, _handle_termination_signal)

    parser = argparse.ArgumentParser(
        prog="karaoke_worker",
        description="Worker de IA do Karaokê Local (contrato v1).",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Subcomando: run --job <caminho>
    run_parser = subparsers.add_parser("run", help="Executa um job de preparo de música.")
    run_parser.add_argument(
        "--job",
        required=True,
        help="Caminho para o arquivo job.json.",
    )
    run_parser.set_defaults(func=cmd_run)

    # Subcomando: doctor --json
    doctor_parser = subparsers.add_parser(
        "doctor", help="Verifica dependências, acelerador e modelos."
    )
    doctor_parser.add_argument(
        "--json",
        action="store_true",
        default=True,
        help="Emite o diagnóstico em formato JSON no stdout.",
    )
    doctor_parser.set_defaults(func=cmd_doctor)

    try:
        parsed_args = parser.parse_args(argv)
        return parsed_args.func(parsed_args)
    except JobCanceledError as exc:
        emit_error(exc.code, exc.message, retryable=False)
        return EXIT_CANCELED
    except WorkerError as exc:
        emit_error(exc.code, exc.message, retryable=exc.retryable)
        return exc.exit_code
    except SystemExit as exc:
        # Erros de sintaxe do argparse retornam código de dados inválidos (30)
        if exc.code == 0:
            return EXIT_SUCCESS
        return EXIT_DATA_ERROR
    except Exception as exc:
        emit_error("UNEXPECTED_ERROR", str(exc), retryable=False)
        return EXIT_DEPENDENCY_ERROR


if __name__ == "__main__":
    sys.exit(main())