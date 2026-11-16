import os
import sys
import platform
import json
from pathlib import Path

def detect_accelerator():
    if platform.system() == 'Windows':
        # Check for DirectML
        try:
            import directml
            return 'directml'
        except:
            pass
        return 'cpu'
    elif platform.system() == 'Darwin':
        # Check for Apple Silicon (MPS)
        if platform.machine() == 'arm64':
            return 'mps'
        return 'cpu'
    else:
        # Linux - check for CUDA, ROCm
        try:
            import torch
            if torch.cuda.is_available():
                return 'cuda'
        except:
            pass
        try:
            import rocm
            if rocm.is_available():
                return 'rocm'
        except:
            pass
        return 'cpu'


def main():
    # Correct workdir calculation
    workdir = Path(__file__).parent.parent.parent
    venv_dir = workdir / 'worker' / '.venv'
    
    # Force recreate venv if --force is specified
    force = '--force' in sys.argv
    
    if force:
        if venv_dir.exists():
            print(f"Removing existing venv at {venv_dir}")
            venv_dir.rmdir()

    # Create venv if not exists
    if not venv_dir.exists():
        print(f"Creating venv at {venv_dir}")
        venv_dir.mkdir()
        
        # Use python3 from PATH (assuming it's the correct version)
        python_exec = sys.executable
        
        # Install base requirements
        os.system(f"{python_exec} -m pip install -r {workdir}/worker/setup/requirements-base.txt --target {venv_dir}")
        
        # Install accelerator-specific requirements
        accelerator = detect_accelerator()
        os.system(f"{python_exec} -m pip install -r {workdir}/worker/setup/requirements-{accelerator}.txt --target {venv_dir}")
        
        # Write accelerator profile
        profile_path = workdir / 'worker' / 'accelerator_profile.json'
        with open(profile_path, 'w') as f:
            json.dump({'accelerator': accelerator}, f)
        
        print(f"Venv created with accelerator: {accelerator}")
    else:
        print(f"Venv already exists at {venv_dir}")

if __name__ == "__main__":
    main()