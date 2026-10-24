#!/usr/bin/env bash
set -euo pipefail
task_root="${KREA_ROOT:-/root/autodl-tmp/krea2}"
task_profile="${1:-rtx5090}"
case "$task_profile" in
  rtx5090) task_vram="--normalvram" ;;
  rtx4090) task_vram="--lowvram" ;;
  *) echo 'Choose rtx5090 or rtx4090' >&2; exit 2 ;;
esac
export KREA_ROOT="$task_root"
"$task_root/venv/bin/python" - <<'PY'
import json,os,pathlib
root=pathlib.Path(os.environ['KREA_ROOT'])
data={
 'krea2_models':{'base_path':str(root/'models/comfy'),'diffusion_models':'diffusion_models','text_encoders':'text_encoders','vae':'vae'},
 'krea2_loras':{'base_path':str(root/'loras'),'loras':'.'}
}
# JSON is valid YAML; no additional YAML dependency in the launcher.
(root/'extra_model_paths.yaml').write_text(json.dumps(data,indent=2))
PY
# Foreground launch, reachable only from the instance; do not expose unauthenticated ComfyUI publicly.
exec "$task_root/venv-comfy/bin/python" "$task_root/ComfyUI/main.py" \
  --listen 127.0.0.1 --port 8191 --disable-auto-launch \
  --use-pytorch-cross-attention "$task_vram" \
  --extra-model-paths-config "$task_root/extra_model_paths.yaml" \
  --output-directory "$task_root/comfy-output"
