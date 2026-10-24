#!/usr/bin/env bash
set -euo pipefail
# Run only inside a subsequently authorized AutoDL instance. No cloud rental API.
bundle_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
task_root="${KREA_ROOT:-/root/autodl-tmp/krea2}"
test "$(uname -s)" = Linux || { echo 'This bootstrap targets AutoDL Linux only.' >&2; exit 2; }
mkdir -p "$task_root" "$task_root/models" "$task_root/datasets" "$task_root/jobs" "$task_root/loras" "$task_root/logs"
export HF_HOME="$task_root/hf-cache"
export PIP_CACHE_DIR="$task_root/pip-cache"
python3 -m venv "$task_root/venv"
"$task_root/venv/bin/python" -m pip install --upgrade pip
# Same CUDA 13.0 runtime supports 4090 and Blackwell 5090; host driver must support it.
"$task_root/venv/bin/python" -m pip install torch==2.12.0 torchvision==0.27.0 --index-url https://download.pytorch.org/whl/cu130
export KREA_BUNDLE_DIR="$bundle_dir" KREA_ROOT="$task_root"
"$task_root/venv/bin/python" - <<'PY'
import json, os, pathlib, subprocess
locks=json.loads((pathlib.Path(os.environ['KREA_BUNDLE_DIR'])/'research/source-lock.json').read_text())
for key, folder in [('musubi','musubi-tuner'),('comfy','ComfyUI')]:
    lock=locks[key];repo=pathlib.Path(os.environ['KREA_ROOT'])/folder
    if not repo.exists():
        subprocess.run(['git','init',str(repo)],check=True)
        subprocess.run(['git','-C',str(repo),'remote','add','origin',lock['repository']],check=True)
    else:
        remote=subprocess.check_output(['git','-C',str(repo),'remote','get-url','origin'],text=True).strip()
        if remote != lock['repository']: raise SystemExit('Unexpected repository origin; stop for inspection')
        if subprocess.check_output(['git','-C',str(repo),'status','--porcelain'],text=True).strip():
            raise SystemExit('Working tree modified; refusing to overwrite')
    subprocess.run(['git','-C',str(repo),'fetch','--depth','1','origin',lock['commit']],check=True)
    subprocess.run(['git','-C',str(repo),'checkout','--detach',lock['commit']],check=True)
PY
"$task_root/venv/bin/python" -m pip install -e "$task_root/musubi-tuner"
"$task_root/venv/bin/python" -m pip check
"$task_root/venv/bin/python" -m pip freeze > "$task_root/logs/pip-freeze.txt"
python3 -m venv "$task_root/venv-comfy"
"$task_root/venv-comfy/bin/python" -m pip install --upgrade pip
"$task_root/venv-comfy/bin/python" -m pip install torch==2.12.0 torchvision==0.27.0 torchaudio==2.12.0 --index-url https://download.pytorch.org/whl/cu130
"$task_root/venv-comfy/bin/python" -m pip install -r "$task_root/ComfyUI/requirements.txt"
"$task_root/venv-comfy/bin/python" -m pip check
"$task_root/venv-comfy/bin/python" -m pip freeze > "$task_root/logs/pip-freeze-comfy.txt"
echo 'Environment installed. Model download, inference, training and sharing are separate steps.'
echo 'Review the Krea license and supply authorized model access before downloading.'
