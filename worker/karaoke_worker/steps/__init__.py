"""
Helpers compartilhados entre as etapas do pipeline:
- Leitura e escrita atômica do manifest.json (respeitando os donos de cada campo).
- Verificação de idempotência para retomada de etapas já concluídas.
"""

import json
import os
from pathlib import Path
from typing import Any

from karaoke_worker import CONTRACT_VERSION
from karaoke_worker.contract import JobContext, ensure_within_workdir


def load_manifest(ctx: JobContext) -> dict[str, Any]:
    """Lê o manifest.json existente em workdir ou cria a estrutura inicial do worker."""
    if ctx.manifest_path.is_file():
        try:
            data = json.loads(ctx.manifest_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            pass

    model_name = str(
        ctx.job.options.get("separation_model")
        or ctx.config.get("worker", {}).get("separation_model", "UVR_MDXNET_KARA_2.onnx")
    )
    pitch_extractor = str(
        ctx.job.options.get("pitch_extractor")
        or ctx.config.get("worker", {}).get("pitch_extractor", "pyin")
    )

    return {
        "schema_version": 1,
        "video_id": ctx.job.video_id,
        "status": "running",
        "steps_done": [],
        "source": {
            "title": "",
            "channel": "",
            "duration": 0.0,
        },
        "pipeline": {
            "separation_model": model_name,
            "pitch_extractor": pitch_extractor,
            "device_used": ctx.device,
            "worker_contract_version": CONTRACT_VERSION,
        },
        "files": {},
        "metrics": {},
    }


def save_manifest_atomic(ctx: JobContext, manifest: dict[str, Any]) -> None:
    """Grava manifest.json de forma atômica (.tmp + os.replace) dentro de workdir."""
    target = ensure_within_workdir(ctx.workdir, "manifest.json")
    tmp_path = ensure_within_workdir(ctx.workdir, "manifest.json.tmp")

    # Garante metadados básicos do worker sem apagar campos do Node (compatibility, lyrics, user)
    manifest["schema_version"] = 1
    manifest["video_id"] = ctx.job.video_id
    manifest.setdefault("steps_done", [])

    content = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    tmp_path.write_text(content, encoding="utf-8")
    os.replace(tmp_path, target)


def is_step_completed(ctx: JobContext, step_name: str, required_files: list[str]) -> bool:
    """
    Retorna True se a etapa já estiver registrada em steps_done e todos os seus
    artefatos existirem em workdir com tamanho maior que zero.
    """
    manifest = load_manifest(ctx)
    steps_done = manifest.get("steps_done")
    if not isinstance(steps_done, list) or step_name not in steps_done:
        return False

    for rel_name in required_files:
        artifact = ensure_within_workdir(ctx.workdir, rel_name)
        if not artifact.is_file() or artifact.stat().st_size <= 0:
            return False

    return True


def mark_step_completed(
    ctx: JobContext,
    step_name: str,
    updates: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Adiciona a etapa em steps_done, aplica atualizações e salva o manifest atomicamente."""
    manifest = load_manifest(ctx)
    steps_done = list(manifest.get("steps_done") or [])
    if step_name not in steps_done:
        steps_done.append(step_name)
    manifest["steps_done"] = steps_done

    if updates:
        for key, value in updates.items():
            if isinstance(value, dict) and isinstance(manifest.get(key), dict):
                manifest[key].update(value)
            else:
                manifest[key] = value

    save_manifest_atomic(ctx, manifest)
    return manifest


def find_source_audio(workdir: Path) -> Path | None:
    """Localiza o arquivo de áudio bruto baixado (source.<ext>) dentro de workdir."""
    base = workdir.resolve()
    for item in sorted(base.iterdir()):
        if (
            item.is_file()
            and item.name.startswith("source.")
            and not item.name.endswith(".json")
            and not item.name.endswith(".part")
            and not item.name.endswith(".tmp")
            and item.stat().st_size > 0
        ):
            return item
    return None