"""
Etapa 4 (analyze): calcula as métricas acústicas do gabarito (CONTRACTS.md §3)
e detecta faixas já instrumentais para ativar o modo heurístico.
"""

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import librosa
import numpy as np

from karaoke_worker.contract import (
    DataWorkerError,
    JobContext,
    ensure_within_workdir,
)
from karaoke_worker.steps import (
    find_source_audio,
    is_step_completed,
    mark_step_completed,
)
from karaoke_worker.util.events import emit_progress, emit_step_done, emit_warning

SAMPLE_RATE = 22050


def _decode_mono_f32(audio_path: Path, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Decodifica qualquer arquivo de áudio em vetor float32 mono usando ffmpeg."""
    ffmpeg_bin = shutil.which("ffmpeg")
    if ffmpeg_bin:
        cmd = [
            ffmpeg_bin,
            "-v",
            "error",
            "-i",
            str(audio_path),
            "-f",
            "f32le",
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "pipe:1",
        ]
        res = subprocess.run(cmd, capture_output=True)
        if res.returncode == 0 and res.stdout:
            return np.frombuffer(res.stdout, dtype=np.float32)

    y, _ = librosa.load(str(audio_path), sr=sample_rate, mono=True)
    return y


def _resolve_existing_audio(workdir: Path, candidates: list[str]) -> Path | None:
    """Retorna o primeiro arquivo existente e não vazio dentre os candidatos."""
    for name in candidates:
        path = ensure_within_workdir(workdir, name)
        if path.is_file() and path.stat().st_size > 0:
            return path
    return None


def run(ctx: JobContext) -> None:
    start_time = time.monotonic()

    # Verifica retomada/idempotência
    if is_step_completed(ctx, "analyze", ["pitch_map.json"]):
        emit_step_done("analyze", ["pitch_map.json"], time.monotonic() - start_time)
        return

    vocals_path = _resolve_existing_audio(ctx.workdir, ["vocals_raw.wav", "vocals.flac"])
    pitch_map_path = ensure_within_workdir(ctx.workdir, "pitch_map.json")
    source_path = find_source_audio(ctx.workdir)

    if vocals_path is None or not pitch_map_path.is_file():
        raise DataWorkerError(
            "Artefatos necessários ausentes para a etapa analyze.",
            code="ANALYZE_INPUTS_MISSING",
        )

    emit_progress("analyze", 20, "Calculando métricas de qualidade vocal")

    pitch_map = json.loads(pitch_map_path.read_text(encoding="utf-8"))
    midi_arr: list[float | None] = pitch_map.get("midi") or []
    conf_arr: list[float] = pitch_map.get("conf") or []
    hop_seconds = float(pitch_map.get("hop") or 0.02)

    audio_cfg = ctx.config.get("audio", {})
    analysis_cfg = ctx.config.get("analysis", {})

    conf_threshold = float(audio_cfg.get("pitch_conf_threshold", 0.12))
    inst_vocal_ratio = float(analysis_cfg.get("instrumental_vocal_energy_ratio", 0.05))
    jump_semitones = float(analysis_cfg.get("jump_semitones", 3))

    total_frames = len(midi_arr)

    # 1. voiced_ratio: frames com voz confiável / total de frames
    reliable_flags = [
        (m is not None and c >= conf_threshold)
        for m, c in zip(midi_arr, conf_arr)
    ]
    voiced_ratio = (sum(reliable_flags) / total_frames) if total_frames > 0 else 0.0

    # 2. mean_confidence: média de conf nos frames com midi != null
    voiced_confs = [c for m, c in zip(midi_arr, conf_arr) if m is not None]
    mean_confidence = float(np.mean(voiced_confs)) if voiced_confs else 0.0

    # 3. vocal_energy_ratio: energia do stem vocal / energia do áudio original [0, 1]
    y_vocals = _decode_mono_f32(vocals_path, SAMPLE_RATE)
    vocal_energy = float(np.mean(np.square(y_vocals))) if y_vocals.size > 0 else 0.0

    if source_path is not None and source_path.is_file():
        y_orig = _decode_mono_f32(source_path, SAMPLE_RATE)
        orig_energy = float(np.mean(np.square(y_orig))) if y_orig.size > 0 else 0.0
    else:
        inst_path = _resolve_existing_audio(
            ctx.workdir, ["instrumental_raw.wav", "instrumental.flac"]
        )
        if inst_path is not None:
            y_inst = _decode_mono_f32(inst_path, SAMPLE_RATE)
            min_len = min(y_vocals.size, y_inst.size)
            orig_energy = (
                float(np.mean(np.square(y_vocals[:min_len] + y_inst[:min_len])))
                if min_len > 0
                else 0.0
            )
        else:
            orig_energy = 0.0

    if orig_energy > 1e-12:
        vocal_energy_ratio = float(np.clip(vocal_energy / orig_energy, 0.0, 1.0))
    else:
        vocal_energy_ratio = 0.0

    emit_progress("analyze", 60, "Analisando estabilidade de pitch e vazamento")

    # Energia por frame do stem vocal alinhada aos frames do pitch_map
    hop_samples = max(1, int(round(SAMPLE_RATE * hop_seconds)))
    frame_energies = np.zeros(total_frames, dtype=np.float64)
    for idx in range(total_frames):
        start_s = idx * hop_samples
        end_s = min(y_vocals.size, start_s + hop_samples)
        if end_s > start_s:
            segment = y_vocals[start_s:end_s]
            frame_energies[idx] = float(np.mean(np.square(segment)))

    # 4. bleed_estimate: energia média nos frames sem voz / energia média nos frames com voz
    voiced_mask = np.array([m is not None for m in midi_arr], dtype=bool)
    unvoiced_mask = ~voiced_mask

    if np.any(voiced_mask) and np.any(unvoiced_mask):
        mean_e_voiced = float(np.mean(frame_energies[voiced_mask]))
        mean_e_unvoiced = float(np.mean(frame_energies[unvoiced_mask]))
        if mean_e_voiced > 1e-12:
            bleed_estimate = float(np.clip(mean_e_unvoiced / mean_e_voiced, 0.0, 1.0))
        else:
            bleed_estimate = 0.0
    else:
        bleed_estimate = 0.0

    # 5. backing_vocals_estimate: frames com energia acima do piso mas sem F0 confiável
    if frame_energies.size > 0 and float(np.max(frame_energies)) > 1e-12:
        energy_floor = max(1e-7, 0.02 * float(np.percentile(frame_energies, 90)))
        active_mask = frame_energies > energy_floor
        active_count = int(np.sum(active_mask))
        if active_count > 0:
            reliable_arr = np.array(reliable_flags, dtype=bool)
            ambiguous_active = int(np.sum(active_mask & (~reliable_arr)))
            backing_vocals_estimate = float(np.clip(ambiguous_active / active_count, 0.0, 1.0))
        else:
            backing_vocals_estimate = 0.0
    else:
        backing_vocals_estimate = 0.0

    # 6. pitch_stability: 1 - (saltos >= jump_semitones entre frames consecutivos com voz / pares)
    consecutive_pairs = 0
    large_jumps = 0
    for idx in range(total_frames - 1):
        m_curr = midi_arr[idx]
        m_next = midi_arr[idx + 1]
        if m_curr is not None and m_next is not None:
            consecutive_pairs += 1
            if abs(m_next - m_curr) >= jump_semitones:
                large_jumps += 1

    if consecutive_pairs > 0:
        pitch_stability = float(np.clip(1.0 - (large_jumps / consecutive_pairs), 0.0, 1.0))
    else:
        pitch_stability = 0.0

    # Detecção de vídeo já instrumental (CONTRACTS.md §3 / ARCHITECTURE.md §11)
    if vocal_energy_ratio < inst_vocal_ratio:
        pitch_map["mode"] = "heuristic"
        emit_warning(
            "LOW_VOCAL_ENERGY",
            f"Energia vocal muito baixa ({vocal_energy_ratio:.4f}). Gabarito alterado para modo heurístico.",
        )
    else:
        pitch_map["mode"] = "reference"

    tmp_pm = ensure_within_workdir(ctx.workdir, "pitch_map.json.tmp")
    tmp_pm.write_text(
        json.dumps(pitch_map, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    os.replace(tmp_pm, pitch_map_path)

    metrics = {
        "voiced_ratio": round(voiced_ratio, 4),
        "mean_confidence": round(mean_confidence, 4),
        "vocal_energy_ratio": round(vocal_energy_ratio, 4),
        "bleed_estimate": round(bleed_estimate, 4),
        "backing_vocals_estimate": round(backing_vocals_estimate, 4),
        "pitch_stability": round(pitch_stability, 4),
    }

    mark_step_completed(ctx, "analyze", updates={"metrics": metrics})

    emit_progress("analyze", 100, "Análise acústica concluída")
    emit_step_done("analyze", ["pitch_map.json"], time.monotonic() - start_time)