"""
Validação do contrato Node <-> Python v1, estruturas de contexto do job
e guarda de isolamento de disco (workdir).
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from karaoke_worker import (
    CONTRACT_VERSION,
    EXIT_CANCELED,
    EXIT_DATA_ERROR,
    EXIT_DEPENDENCY_ERROR,
    EXIT_RETRYABLE_ERROR,
)

VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
VALID_STEPS = ("download", "separate", "pitch", "analyze", "package")


class WorkerError(Exception):
    """Erro estruturado do Worker com código simbólico e código de saída."""

    def __init__(
        self,
        message: str,
        code: str = "WORKER_ERROR",
        exit_code: int = EXIT_DATA_ERROR,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.exit_code = exit_code
        self.retryable = retryable


class RetryableWorkerError(WorkerError):
    """Erro temporário (ex.: falha de rede ou YouTube), código de saída 10."""

    def __init__(self, message: str, code: str = "RETRYABLE_ERROR") -> None:
        super().__init__(
            message=message,
            code=code,
            exit_code=EXIT_RETRYABLE_ERROR,
            retryable=True,
        )


class DependencyWorkerError(WorkerError):
    """Erro de dependência externa ausente (ffmpeg, yt-dlp, modelo), código 20."""

    def __init__(self, message: str, code: str = "DEPENDENCY_MISSING") -> None:
        super().__init__(
            message=message,
            code=code,
            exit_code=EXIT_DEPENDENCY_ERROR,
            retryable=False,
        )


class DataWorkerError(WorkerError):
    """Erro de dados/contrato/áudio inválido, código 30."""

    def __init__(self, message: str, code: str = "INVALID_DATA") -> None:
        super().__init__(
            message=message,
            code=code,
            exit_code=EXIT_DATA_ERROR,
            retryable=False,
        )


class JobCanceledError(WorkerError):
    """Execução interrompida por sinal SIGINT/SIGTERM, código 130."""

    def __init__(self, message: str = "Job cancelado pelo usuário.") -> None:
        super().__init__(
            message=message,
            code="JOB_CANCELED",
            exit_code=EXIT_CANCELED,
            retryable=False,
        )


@dataclass
class JobSpec:
    """Representa um arquivo job.json validado conforme CONTRACTS.md §2.1."""

    contract_version: int
    video_id: str
    workdir: Path
    steps: list[str]
    options: dict[str, Any] = field(default_factory=dict)


@dataclass
class JobContext:
    """Contexto compartilhado passado para cada etapa do pipeline na T0.4."""

    job: JobSpec
    workdir: Path
    models_dir: Path
    config: dict[str, Any]
    device: str
    manifest_path: Path


def ensure_within_workdir(workdir: Path, target: str | Path) -> Path:
    """
    Resolve um caminho relativo ou absoluto e garante que ele esteja
    estritamente dentro de `workdir` (bloqueia escrita externa e path traversal).
    """
    base = workdir.resolve()
    candidate = Path(target)
    if not candidate.is_absolute():
        candidate = base / candidate
    resolved = candidate.resolve()

    if resolved != base and base not in resolved.parents:
        raise DataWorkerError(
            f"Acesso negado fora do diretório de trabalho permitido: {resolved}",
            code="PATH_OUTSIDE_WORKDIR",
        )
    return resolved


def load_and_validate_job(job_path: Path) -> JobSpec:
    """Lê e valida o arquivo job.json enviado pelo Node.js."""
    if not job_path.is_file():
        raise DataWorkerError(
            f"Arquivo job.json não encontrado: {job_path}",
            code="JOB_FILE_NOT_FOUND",
        )

    try:
        raw = json.loads(job_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise DataWorkerError(
            f"Falha ao ler JSON de {job_path}: {exc}",
            code="INVALID_JOB_JSON",
        ) from exc

    if not isinstance(raw, dict):
        raise DataWorkerError("job.json deve ser um objeto JSON.", code="INVALID_JOB_JSON")

    version = raw.get("contract_version")
    if version != CONTRACT_VERSION:
        raise DataWorkerError(
            f"Versão de contrato incompatível: esperado {CONTRACT_VERSION}, recebido {version}.",
            code="CONTRACT_VERSION_MISMATCH",
        )

    video_id = raw.get("video_id")
    if not isinstance(video_id, str) or not VIDEO_ID_PATTERN.match(video_id):
        raise DataWorkerError(
            f"video_id inválido no job.json: {video_id!r}",
            code="INVALID_VIDEO_ID",
        )

    raw_workdir = raw.get("workdir")
    if not isinstance(raw_workdir, str) or not raw_workdir.strip():
        raise DataWorkerError("Campo 'workdir' ausente ou inválido.", code="INVALID_WORKDIR")
    workdir = Path(raw_workdir).resolve()

    steps = raw.get("steps")
    if not isinstance(steps, list) or not steps:
        raise DataWorkerError("Campo 'steps' deve ser uma lista não vazia.", code="INVALID_STEPS")
    for step in steps:
        if step not in VALID_STEPS:
            raise DataWorkerError(f"Etapa desconhecida no job.json: {step!r}", code="INVALID_STEP")

    options = raw.get("options") or {}
    if not isinstance(options, dict):
        raise DataWorkerError("Campo 'options' deve ser um objeto JSON.", code="INVALID_OPTIONS")

    return JobSpec(
        contract_version=version,
        video_id=video_id,
        workdir=workdir,
        steps=steps,
        options=options,
    )