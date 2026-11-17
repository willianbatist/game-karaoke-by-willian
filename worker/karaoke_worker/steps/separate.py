"""
Etapa 2 (separate): separa voz principal e instrumental usando audio-separator.
"""

import logging
import os
import time
from pathlib import Path

from karaoke_worker import CONTRACT_VERSION
from karaoke_worker.contract import (
    DataWorkerError,
    DependencyWorkerError,
    JobContext,
    ensure_within_workdir,
)
from karaoke_worker.steps import (
    find_source_audio,
    is_step_completed,
    mark_step_completed,
)
from karaoke_worker.util.events import emit_progress, emit_step_done


def run(ctx: JobContext) -> None:
    start_time = time.monotonic()

    # Verifica retomada/idempotência
    if is_step_completed(ctx, "separate", ["vocals_raw.wav", "instrumental_raw.wav"]):
        emit_step_done(
            "separate",
            ["vocals_raw.wav", "instrumental_raw.wav"],
            time.monotonic() - start_time,
        )
        return

    source_audio = find_source_audio(ctx.workdir)
    if source_audio is None:
        raise DataWorkerError(
            "Arquivo de origem (source.*) não encontrado para separação vocal.",
            code="SOURCE_AUDIO_MISSING",
        )

    model_name = str(
        ctx.job.options.get("separation_model")
        or ctx.config.get("worker", {}).get("separation_model", "UVR_MDXNET_KARA_2.onnx")
    )
    model_path = ctx.models_dir / model_name
    if not model_path.is_file():
        raise DependencyWorkerError(
            f"Modelo de separação não encontrado: {model_path}. Rode install.py.",
            code="MODEL_MISSING",
        )

    emit_progress(
        "separate",
        10,
        f"Carregando modelo de separação ({model_name})",
        device=ctx.device,
    )

    try:
        from audio_separator.separator import Separator
    except Exception as exc:
        raise DependencyWorkerError(
            f"Falha ao importar audio-separator: {exc}",
            code="SEPARATOR_IMPORT_ERROR",
        ) from exc

    separator = Separator(
        log_level=logging.WARNING,
        model_file_dir=str(ctx.models_dir),
        output_dir=str(ctx.workdir),
        output_format="WAV",
    )
    separator.load_model(model_filename=model_name)

    emit_progress(
        "separate",
        35,
        "Separando voz principal e instrumental (pode levar alguns instantes)",
        device=ctx.device,
    )

    output_files = separator.separate(str(source_audio))

    vocals_src: Path | None = None
    inst_src: Path | None = None

    for raw_item in output_files:
        candidate = Path(raw_item)
        if not candidate.is_absolute():
            candidate = ctx.workdir / candidate
        resolved = ensure_within_workdir(ctx.workdir, candidate)

        lower_name = resolved.name.lower()
        if "(vocals)" in lower_name:
            vocals_src = resolved
        elif "(instrumental)" in lower_name or "(no vocals)" in lower_name:
            inst_src = resolved

    if vocals_src is None or inst_src is None or not vocals_src.is_file() or not inst_src.is_file():
        raise DataWorkerError(
            f"Saída inesperada do audio-separator: {output_files}",
            code="SEPARATION_OUTPUT_INVALID",
        )

    vocals_dst = ensure_within_workdir(ctx.workdir, "vocals_raw.wav")
    inst_dst = ensure_within_workdir(ctx.workdir, "instrumental_raw.wav")

    os.replace(vocals_src, vocals_dst)
    os.replace(inst_src, inst_dst)

    mark_step_completed(
        ctx,
        "separate",
        updates={
            "pipeline": {
                "separation_model": model_name,
                "device_used": ctx.device,
                "worker_contract_version": CONTRACT_VERSION,
            }
        },
    )

    emit_progress("separate", 100, "Separação vocal concluída", device=ctx.device)
    emit_step_done(
        "separate",
        ["vocals_raw.wav", "instrumental_raw.wav"],
        time.monotonic() - start_time,
    )