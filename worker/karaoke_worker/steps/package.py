"""
Etapa 5 (package): converte os stems para FLAC, finaliza manifest.json
com status='ready' e remove arquivos temporários de workdir.
"""

import shutil
import subprocess
import time
from pathlib import Path

from karaoke_worker.contract import (
    DataWorkerError,
    DependencyWorkerError,
    JobContext,
    ensure_within_workdir,
)
from karaoke_worker.steps import is_step_completed, mark_step_completed
from karaoke_worker.util.events import emit_progress, emit_step_done


def _convert_wav_to_flac(ffmpeg_bin: str, src_wav: Path, dst_flac: Path) -> None:
    """Converte um arquivo WAV para FLAC usando ffmpeg sem shell."""
    cmd = [
        ffmpeg_bin,
        "-y",
        "-v",
        "error",
        "-i",
        str(src_wav),
        "-c:a",
        "flac",
        str(dst_flac),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0 or not dst_flac.is_file() or dst_flac.stat().st_size <= 0:
        detail = (res.stderr or "").strip() or "Falha na conversão FLAC."
        raise DataWorkerError(
            f"Erro ao converter {src_wav.name} para {dst_flac.name}: {detail}",
            code="FLAC_ENCODE_FAILED",
        )


def _cleanup_temporaries(workdir: Path) -> None:
    """Remove source.* e arquivos temporários WAV/TMP dentro de workdir."""
    base = workdir.resolve()
    for item in base.iterdir():
        if not item.is_file():
            continue
        name = item.name
        if (
            name.startswith("source.")
            or name.endswith(".wav")
            or name.endswith(".tmp")
            or name.endswith(".part")
        ):
            item.unlink(missing_ok=True)


def run(ctx: JobContext) -> None:
    start_time = time.monotonic()

    # Verifica retomada/idempotência
    if is_step_completed(
        ctx,
        "package",
        ["instrumental.flac", "vocals.flac", "pitch_map.json", "manifest.json"],
    ):
        emit_step_done(
            "package",
            ["instrumental.flac", "vocals.flac", "pitch_map.json", "manifest.json"],
            time.monotonic() - start_time,
        )
        return

    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise DependencyWorkerError(
            "Executável 'ffmpeg' não encontrado no PATH.",
            code="FFMPEG_MISSING",
        )

    vocals_wav = ensure_within_workdir(ctx.workdir, "vocals_raw.wav")
    inst_wav = ensure_within_workdir(ctx.workdir, "instrumental_raw.wav")
    pitch_map_path = ensure_within_workdir(ctx.workdir, "pitch_map.json")

    if not vocals_wav.is_file() or not inst_wav.is_file() or not pitch_map_path.is_file():
        raise DataWorkerError(
            "Arquivos necessários ausentes para empacotamento final.",
            code="PACKAGE_INPUTS_MISSING",
        )

    vocals_flac = ensure_within_workdir(ctx.workdir, "vocals.flac")
    inst_flac = ensure_within_workdir(ctx.workdir, "instrumental.flac")

    emit_progress("package", 25, "Convertendo faixa instrumental para FLAC")
    _convert_wav_to_flac(ffmpeg_bin, inst_wav, inst_flac)

    emit_progress("package", 65, "Convertendo faixa vocal para FLAC")
    _convert_wav_to_flac(ffmpeg_bin, vocals_wav, vocals_flac)

    emit_progress("package", 90, "Gravando manifest.json e limpando temporários")

    mark_step_completed(
        ctx,
        "package",
        updates={
            "status": "ready",
            "files": {
                "instrumental": "instrumental.flac",
                "vocals": "vocals.flac",
                "pitch_map": "pitch_map.json",
            },
        },
    )

    _cleanup_temporaries(ctx.workdir)

    emit_progress("package", 100, "Empacotamento concluído")
    emit_step_done(
        "package",
        ["instrumental.flac", "vocals.flac", "pitch_map.json", "manifest.json"],
        time.monotonic() - start_time,
    )