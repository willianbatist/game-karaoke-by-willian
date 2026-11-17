"""
Etapa 1 (download): baixa o melhor stream de áudio via yt-dlp,
extrai metadados e converte para source.wav via ffmpeg.
"""

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

from karaoke_worker.contract import (
    DataWorkerError,
    DependencyWorkerError,
    JobContext,
    RetryableWorkerError,
    ensure_within_workdir,
)
from karaoke_worker.steps import (
    find_source_audio,
    load_manifest,
    mark_step_completed,
)
from karaoke_worker.util.events import emit_progress, emit_step_done


def _resolve_ytdlp_binary() -> str:
    """Localiza o executável yt-dlp dentro do venv ou no PATH do sistema."""
    venv_bin = Path(sys.executable).resolve().parent
    for candidate_name in ("yt-dlp", "yt-dlp.exe"):
        candidate = venv_bin / candidate_name
        if candidate.is_file():
            return str(candidate)

    found = shutil.which("yt-dlp")
    if found:
        return found

    raise DependencyWorkerError(
        "Executável 'yt-dlp' não encontrado no ambiente.",
        code="YTDLP_MISSING",
    )


def _find_raw_download(workdir: Path) -> Path | None:
    """Localiza o arquivo temporário raw_download.<ext> baixado pelo yt-dlp."""
    for item in sorted(workdir.resolve().iterdir()):
        if (
            item.is_file()
            and item.name.startswith("raw_download.")
            and not item.name.endswith(".json")
            and not item.name.endswith(".part")
            and not item.name.endswith(".tmp")
            and item.stat().st_size > 0
        ):
            return item
    return None


def run(ctx: JobContext) -> None:
    start_time = time.monotonic()

    # Verifica retomada/idempotência
    manifest = load_manifest(ctx)
    existing_source = find_source_audio(ctx.workdir)
    if (
        "download" in (manifest.get("steps_done") or [])
        and existing_source is not None
        and existing_source.suffix.lower() == ".wav"
    ):
        emit_step_done(
            "download",
            [existing_source.name],
            time.monotonic() - start_time,
        )
        return

    ytdlp_bin = _resolve_ytdlp_binary()
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise DependencyWorkerError(
            "Executável 'ffmpeg' não encontrado no PATH.",
            code="FFMPEG_MISSING",
        )

    emit_progress("download", 10, "Iniciando download do áudio no YouTube")

    raw_template = str(ensure_within_workdir(ctx.workdir, "raw_download.%(ext)s"))
    video_url = f"https://www.youtube.com/watch?v={ctx.job.video_id}"

    cmd = [
        ytdlp_bin,
        "--no-playlist",
        "--no-warnings",
        "--write-info-json",
        "-f",
        "bestaudio/best",
        "-o",
        raw_template,
        video_url,
    ]

    result = subprocess.run(
        cmd,
        cwd=str(ctx.workdir),
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        err_snippet = (result.stderr or result.stdout or "").strip().splitlines()
        detail = err_snippet[-1] if err_snippet else "Erro desconhecido no yt-dlp."
        raise RetryableWorkerError(
            f"Falha ao baixar vídeo {ctx.job.video_id}: {detail}",
            code="DOWNLOAD_FAILED",
        )

    emit_progress("download", 65, "Extraindo metadados da faixa")

    raw_audio = _find_raw_download(ctx.workdir)
    if raw_audio is None:
        raise RetryableWorkerError(
            "Download concluído, mas nenhum arquivo de áudio bruto foi encontrado.",
            code="DOWNLOAD_NO_AUDIO",
        )

    # Lê metadados gerados pelo --write-info-json e remove o .info.json temporário
    title = ctx.job.video_id
    channel = ""
    duration = 0.0

    for info_file in ctx.workdir.glob("raw_download*.info.json"):
        try:
            info_data = json.loads(info_file.read_text(encoding="utf-8"))
            title = str(info_data.get("title") or title)
            channel = str(info_data.get("channel") or info_data.get("uploader") or "")
            duration = float(info_data.get("duration") or 0.0)
        except Exception:
            pass
        finally:
            info_file.unlink(missing_ok=True)

    emit_progress("download", 80, "Convertendo áudio para formato WAV padrão")

    source_wav = ensure_within_workdir(ctx.workdir, "source.wav")
    ffmpeg_cmd = [
        ffmpeg_bin,
        "-y",
        "-v",
        "error",
        "-i",
        str(raw_audio),
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "44100",
        str(source_wav),
    ]
    conv_res = subprocess.run(ffmpeg_cmd, capture_output=True, text=True)
    raw_audio.unlink(missing_ok=True)

    if conv_res.returncode != 0 or not source_wav.is_file() or source_wav.stat().st_size <= 0:
        detail = (conv_res.stderr or "").strip() or "Falha ao converter áudio com ffmpeg."
        raise DataWorkerError(
            f"Erro ao converter áudio baixado para WAV: {detail}",
            code="AUDIO_CONVERT_FAILED",
        )

    mark_step_completed(
        ctx,
        "download",
        updates={
            "status": "running",
            "source": {
                "title": title,
                "channel": channel,
                "duration": round(duration, 2),
            },
        },
    )

    emit_progress("download", 100, "Download concluído")
    emit_step_done("download", [source_wav.name], time.monotonic() - start_time)