#!/usr/bin/env python3
"""
Script de instalação isolada do Worker Python por perfil de acelerador.
Cria o ambiente virtual em worker/.venv, instala as dependências do perfil
escolhido e baixa/valida o modelo de separação vocal para karaokê.
"""

import argparse
import json
import platform
import shutil
import subprocess
import sys
import venv
from datetime import datetime, timezone
from pathlib import Path

# Caminhos principais calculados a partir da localização deste script
SETUP_DIR = Path(__file__).resolve().parent
WORKER_DIR = SETUP_DIR.parent
ROOT_DIR = WORKER_DIR.parent
VENV_DIR = WORKER_DIR / ".venv"
MODELS_DIR = WORKER_DIR / "models"
PROFILE_FILE = WORKER_DIR / "accelerator_profile.json"
DEFAULT_CONFIG_FILE = ROOT_DIR / "config" / "default.json"

VALID_PROFILES = ("cpu", "cuda", "directml", "rocm", "mps")
# Modelo especializado em karaokê (isola voz principal de backing vocals + instrumental)
DEFAULT_SEPARATION_MODEL = "UVR_MDXNET_KARA_2.onnx"


def detect_recommended_profile() -> tuple[str, str]:
    """Detecta o sistema operacional e hardware para sugerir o melhor perfil."""
    system = platform.system().lower()
    machine = platform.machine().lower()

    # macOS Apple Silicon (M1/M2/M3/M4)
    if system == "darwin":
        if machine == "arm64":
            return "mps", "Apple Silicon detectado (aceleração MPS)."
        return "cpu", "macOS Intel detectado (usando CPU)."

    # Verifica presença de GPU NVIDIA (CUDA)
    if shutil.which("nvidia-smi"):
        try:
            res = subprocess.run(
                ["nvidia-smi"], capture_output=True, text=True, timeout=5
            )
            if res.returncode == 0:
                return "cuda", "GPU NVIDIA detectada via nvidia-smi."
        except Exception:
            pass

    # Windows sem NVIDIA -> DirectML
    if system == "windows":
        return "directml", "Windows detectado sem GPU NVIDIA (sugerindo DirectML)."

    # Linux / WSL2 sem NVIDIA (inclui sistemas com GPU AMD)
    is_wsl = "microsoft" in platform.release().lower()
    if is_wsl:
        return (
            "cpu",
            "WSL2 (Linux) detectado sem CUDA. Perfil 'cpu' recomendado para máxima estabilidade.",
        )

    return "cpu", "Linux detectado sem CUDA (usando CPU)."


def validate_profile_os(profile: str) -> None:
    """Impede escolher perfis incompatíveis com o sistema operacional atual."""
    system = platform.system().lower()
    if profile == "rocm" and system != "linux":
        sys.exit("Erro: o perfil 'rocm' é suportado apenas no Linux.")
    if profile == "mps" and system != "darwin":
        sys.exit("Erro: o perfil 'mps' é suportado apenas no macOS.")
    if profile == "directml" and system != "windows":
        sys.exit("Erro: o perfil 'directml' é suportado apenas no Windows.")


def get_venv_python() -> Path:
    """Retorna o caminho do executável Python dentro do venv (Linux/macOS vs Windows)."""
    if platform.system().lower() == "windows":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def run_cmd(cmd: list[str], description: str) -> None:
    """Executa um comando externo exibindo progresso e interrompendo em caso de falha."""
    print(f"\n==> {description}...")
    result = subprocess.run(cmd)
    if result.returncode != 0:
        sys.exit(f"\nFalha ao executar: {' '.join(cmd)} (código {result.returncode})")


def update_default_config(model_name: str) -> None:
    """Atualiza o campo worker.separation_model em config/default.json."""
    if not DEFAULT_CONFIG_FILE.exists():
        print(f"Aviso: {DEFAULT_CONFIG_FILE} não encontrado; pulando atualização.")
        return

    config_data = json.loads(DEFAULT_CONFIG_FILE.read_text(encoding="utf-8"))
    config_data.setdefault("worker", {})["separation_model"] = model_name
    DEFAULT_CONFIG_FILE.write_text(
        json.dumps(config_data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Configuração atualizada em {DEFAULT_CONFIG_FILE}: separation_model = {model_name}")


def download_and_validate_model(venv_python: Path, model_name: str) -> None:
    """Usa o audio-separator dentro do venv para baixar e validar o modelo escolhido."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    validation_code = (
        "import sys; "
        "from audio_separator.separator import Separator; "
        f"sep = Separator(model_file_dir={repr(str(MODELS_DIR))}); "
        f"sep.load_model(model_filename={repr(model_name)}); "
        "print('Modelo carregado e validado com sucesso!')"
    )
    run_cmd(
        [str(venv_python), "-c", validation_code],
        f"Baixando e validando o modelo de karaokê ({model_name})",
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Configura o ambiente isolado (venv) do Worker Python."
    )
    parser.add_argument(
        "--accelerator",
        choices=VALID_PROFILES,
        default=None,
        help="Perfil de aceleração (cpu, cuda, directml, rocm, mps).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Apaga e recria o worker/.venv do zero (obrigatório ao trocar de perfil).",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_SEPARATION_MODEL,
        help=f"Nome do modelo do audio-separator (padrão: {DEFAULT_SEPARATION_MODEL}).",
    )
    parser.add_argument(
        "--skip-model",
        action="store_true",
        help="Não baixa o modelo agora (apenas instala as dependências).",
    )
    args = parser.parse_args()

    recommended_profile, reason = detect_recommended_profile()
    profile = args.accelerator or recommended_profile
    validate_profile_os(profile)

    print("=== Setup do Worker Python (game-karaoke-by-willian) ===")
    print(f"Hardware/SO: {reason}")
    print(f"Perfil selecionado: {profile}")
    print(f"Python utilizado: {sys.executable} ({platform.python_version()})")

    # Regra crítica: nunca instalar um perfil por cima de outro
    if VENV_DIR.exists():
        if args.force:
            print(f"Removendo ambiente anterior em {VENV_DIR} (--force)...")
            shutil.rmtree(VENV_DIR)
        else:
            existing_profile = None
            if PROFILE_FILE.exists():
                try:
                    existing_profile = json.loads(
                        PROFILE_FILE.read_text(encoding="utf-8")
                    ).get("profile")
                except Exception:
                    pass
            if existing_profile and existing_profile != profile:
                sys.exit(
                    f"Erro: já existe um venv com perfil '{existing_profile}'. "
                    f"Para trocar para '{profile}', rode novamente com --force."
                )
            print(f"Ambiente virtual já existe em {VENV_DIR}. Reutilizando...")

    if not VENV_DIR.exists():
        print(f"\n==> Criando ambiente virtual isolado em {VENV_DIR}...")
        venv.create(VENV_DIR, with_pip=True)

    venv_python = get_venv_python()
    base_req = WORKER_DIR / "requirements-base.txt"
    profile_req = SETUP_DIR / f"requirements-{profile}.txt"

    run_cmd(
        [str(venv_python), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
        "Atualizando pip, setuptools e wheel no venv",
    )
    run_cmd(
        [str(venv_python), "-m", "pip", "install", "-r", str(base_req)],
        "Instalando dependências comuns (requirements-base.txt)",
    )
    run_cmd(
        [str(venv_python), "-m", "pip", "install", "-r", str(profile_req)],
        f"Instalando dependências do perfil '{profile}' ({profile_req.name})",
    )

    update_default_config(args.model)

    if not args.skip_model:
        download_and_validate_model(venv_python, args.model)

    profile_metadata = {
        "profile": profile,
        "python_version": platform.python_version(),
        "python_executable": str(venv_python),
        "separation_model": args.model,
        "models_dir": "worker/models",
        "installed_at": datetime.now(timezone.utc).isoformat(),
    }
    PROFILE_FILE.write_text(
        json.dumps(profile_metadata, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    print("\n✅ Setup do Worker Python concluído com sucesso!")
    print(f"   Perfil ativo gravado em: {PROFILE_FILE}")


if __name__ == "__main__":
    main()