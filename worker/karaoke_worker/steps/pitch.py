"""
Etapa 3 (pitch): extrai o contorno de frequência fundamental (F0) da voz isolada
usando pYIN e grava pitch_map.json em escala MIDI contínua.
"""

import json
import os
import time

import librosa
import numpy as np

from karaoke_worker.contract import (
    DataWorkerError,
    JobContext,
    ensure_within_workdir,
)
from karaoke_worker.steps import is_step_completed, mark_step_completed
from karaoke_worker.util.events import emit_progress, emit_step_done

SAMPLE_RATE = 22050
FRAME_LENGTH = 2048
FMIN_HZ = 65.0   # ~C2 (cobre vozes masculinas muito graves)
FMAX_HZ = 1200.0 # ~D6 (cobre agudos femininos)


def run(ctx: JobContext) -> None:
    start_time = time.monotonic()

    # Verifica retomada/idempotência
    if is_step_completed(ctx, "pitch", ["pitch_map.json"]):
        emit_step_done("pitch", ["pitch_map.json"], time.monotonic() - start_time)
        return

    vocals_path = ensure_within_workdir(ctx.workdir, "vocals_raw.wav")
    if not vocals_path.is_file():
        raise DataWorkerError(
            "Arquivo vocals_raw.wav não encontrado para extração de F0.",
            code="VOCALS_WAV_MISSING",
        )

    hop_seconds = float(
        ctx.job.options.get("pitch_hop_seconds")
        or ctx.config.get("worker", {}).get("pitch_hop_seconds", 0.02)
    )
    extractor = str(
        ctx.job.options.get("pitch_extractor")
        or ctx.config.get("worker", {}).get("pitch_extractor", "pyin")
    )

    emit_progress("pitch", 15, "Carregando faixa vocal para extração de afinação")

    y, sr = librosa.load(str(vocals_path), sr=SAMPLE_RATE, mono=True)
    if y.size == 0:
        raise DataWorkerError("O áudio vocal está vazio.", code="EMPTY_VOCAL_AUDIO")

    hop_length = max(1, int(round(sr * hop_seconds)))

    emit_progress("pitch", 45, "Extraindo contorno de afinação (pYIN)")

    f0, voiced_flag, voiced_probs = librosa.pyin(
        y,
        fmin=FMIN_HZ,
        fmax=FMAX_HZ,
        sr=sr,
        frame_length=FRAME_LENGTH,
        hop_length=hop_length,
    )

    emit_progress("pitch", 85, "Convertendo frequências para escala MIDI")

    midi_list: list[float | None] = []
    conf_list: list[float] = []

    for freq, is_voiced, prob in zip(f0, voiced_flag, voiced_probs):
        clean_prob = float(np.clip(prob, 0.0, 1.0)) if np.isfinite(prob) else 0.0
        if bool(is_voiced) and np.isfinite(freq) and freq > 0.0:
            midi_val = 69.0 + 12.0 * float(np.log2(freq / 440.0))
            midi_list.append(round(midi_val, 3))
            conf_list.append(round(clean_prob, 4))
        else:
            midi_list.append(None)
            conf_list.append(round(clean_prob, 4))

    pitch_map = {
        "schema_version": 1,
        "extractor": extractor,
        "hop": hop_seconds,
        "t0": 0.0,
        "midi": midi_list,
        "conf": conf_list,
        "mode": "reference",
    }

    target_path = ensure_within_workdir(ctx.workdir, "pitch_map.json")
    tmp_path = ensure_within_workdir(ctx.workdir, "pitch_map.json.tmp")
    tmp_path.write_text(
        json.dumps(pitch_map, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp_path, target_path)

    mark_step_completed(
        ctx,
        "pitch",
        updates={
            "pipeline": {
                "pitch_extractor": extractor,
            }
        },
    )

    emit_progress("pitch", 100, "Gabarito de afinação gerado")
    emit_step_done("pitch", ["pitch_map.json"], time.monotonic() - start_time)