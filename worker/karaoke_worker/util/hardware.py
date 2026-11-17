"""
Detecção de hardware, teste real do acelerador e inventário de dependências
para o comando `doctor --json` (CONTRACTS.md §2.4).
"""

import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from karaoke_worker import CONTRACT_VERSION

# Caminhos calculados a partir de worker/karaoke_worker/util/hardware.py
UTIL_DIR = Path(__file__).resolve().parent
PACKAGE_DIR = UTIL_DIR.parent
WORKER_DIR = PACKAGE_DIR.parent
ROOT_DIR = WORKER_DIR.parent

PROFILE_FILE = WORKER_DIR / "accelerator_profile.json"
MODELS_DIR = WORKER_DIR / "models"
DEFAULT_CONFIG_FILE = ROOT_DIR / "config" / "default.json"


def get_installed_profile() -> str:
    """Lê o perfil gravado em worker/accelerator_profile.json."""
    if PROFILE_FILE.exists():
        try:
            data = json.loads(PROFILE_FILE.read_text(encoding="utf-8"))
            profile = data.get("profile")
            if isinstance(profile, str) and profile:
                return profile
        except Exception:
            pass
    return "unknown"


def detect_hardware_accelerator() -> str:
    """Detecta qual acelerador de hardware está disponível no sistema atual."""
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "darwin":
        return "mps" if machine == "arm64" else "cpu"

    if shutil.which("nvidia-smi"):
        try:
            res = subprocess.run(
                ["nvidia-smi"], capture_output=True, text=True, timeout=5
            )
            if res.returncode == 0:
                return "cuda"
        except Exception:
            pass

    if system == "windows":
        return "directml"

    # ROCm no Linux exige /dev/kfd acessível
    if system == "linux" and os.path.exists("/dev/kfd"):
        return "rocm"

    return "cpu"


def test_accelerator(profile: str) -> dict[str, Any]:
    """Executa um teste real de inicialização do backend de inferência."""
    try:
        import onnxruntime as ort

        providers = ort.get_available_providers()
    except Exception as exc:
        return {
            "ok": False,
            "device": "cpu",
            "detail": f"Falha ao importar onnxruntime: {exc}",
        }

    if profile == "cuda":
        if "CUDAExecutionProvider" in providers:
            return {"ok": True, "device": "cuda", "detail": ""}
        return {
            "ok": False,
            "device": "cpu",
            "detail": "CUDAExecutionProvider indisponível no onnxruntime.",
        }

    if profile == "directml":
        if "DmlExecutionProvider" in providers:
            return {"ok": True, "device": "directml", "detail": ""}
        return {
            "ok": False,
            "device": "cpu",
            "detail": "DmlExecutionProvider indisponível no onnxruntime.",
        }

    if profile == "rocm":
        if "ROCMExecutionProvider" in providers:
            return {"ok": True, "device": "rocm", "detail": ""}
        return {
            "ok": False,
            "device": "cpu",
            "detail": "ROCMExecutionProvider indisponível no onnxruntime.",
        }

    if profile == "mps":
        try:
            import torch

            if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                return {"ok": True, "device": "mps", "detail": ""}
        except Exception:
            pass
        return {
            "ok": True,
            "device": "cpu",
            "detail": "MPS indisponível; usando CPU.",
        }

    # Perfil 'cpu' (ou fallback)
    if "CPUExecutionProvider" in providers:
        return {"ok": True, "device": "cpu", "detail": ""}

    return {
        "ok": False,
        "device": "cpu",
        "detail": f"Provedores inesperados: {providers}",
    }


def resolve_execution_device(requested_device: str, installed_profile: str) -> str:
    """Resolve o dispositivo efetivo ('auto' usa o perfil instalado se estiver funcional)."""
    target = installed_profile if requested_device == "auto" else requested_device
    if target not in ("cpu", "cuda", "directml", "rocm", "mps"):
        return "cpu"
    test_res = test_accelerator(target)
    return test_res["device"] if test_res["ok"] else "cpu"


def check_binary_version(
    binary_name: str,
    version_args: list[str],
    venv_bin_dir: Path | None = None,
) -> dict[str, Any]:
    """Verifica se um executável externo (ffmpeg, yt-dlp) existe e retorna sua versão."""
    resolved_path: str | None = None

    if venv_bin_dir:
        candidate = venv_bin_dir / binary_name
        if candidate.exists():
            resolved_path = str(candidate)
        elif (venv_bin_dir / f"{binary_name}.exe").exists():
            resolved_path = str(venv_bin_dir / f"{binary_name}.exe")

    if not resolved_path:
        resolved_path = shutil.which(binary_name)

    if not resolved_path:
        return {"ok": False, "version": ""}

    try:
        res = subprocess.run(
            [resolved_path, *version_args],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if res.returncode != 0:
            return {"ok": False, "version": ""}
        first_line = (res.stdout or res.stderr or "").strip().splitlines()[0]
        return {"ok": True, "version": first_line}
    except Exception:
        return {"ok": False, "version": ""}


def check_models() -> list[dict[str, Any]]:
    """Verifica se o modelo de separação configurado em config/default.json está baixado."""
    model_name = "UVR_MDXNET_KARA_2.onnx"
    if DEFAULT_CONFIG_FILE.exists():
        try:
            cfg = json.loads(DEFAULT_CONFIG_FILE.read_text(encoding="utf-8"))
            configured = cfg.get("worker", {}).get("separation_model")
            if isinstance(configured, str) and configured and not configured.startswith("<"):
                model_name = configured
        except Exception:
            pass

    model_file = MODELS_DIR / model_name
    downloaded = model_file.is_file() and model_file.stat().st_size > 0
    return [{"name": model_name, "downloaded": downloaded}]


def build_doctor_report() -> dict[str, Any]:
    """Monta o relatório JSON completo conforme CONTRACTS.md §2.4."""
    venv_bin_dir = Path(sys.executable).resolve().parent
    installed_profile = get_installed_profile()
    detected_profile = detect_hardware_accelerator()
    accel_test = test_accelerator(installed_profile)

    ffmpeg_info = check_binary_version("ffmpeg", ["-version"])
    ytdlp_info = check_binary_version("yt-dlp", ["--version"], venv_bin_dir=venv_bin_dir)
    models_info = check_models()

    usage = shutil.disk_usage(ROOT_DIR)
    disk_free_gb = round(usage.free / (1024**3), 1)

    return {
        "contract_version": CONTRACT_VERSION,
        "python_version": platform.python_version(),
        "accelerator_profile_installed": installed_profile,
        "accelerator_detected": detected_profile,
        "accelerator_test": accel_test,
        "ffmpeg": ffmpeg_info,
        "yt_dlp": ytdlp_info,
        "models": models_info,
        "disk_free_gb": disk_free_gb,
    }