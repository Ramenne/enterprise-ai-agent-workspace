#!/usr/bin/env python3
"""Local/Jupyter worker entry point. Preview by default; no cloud rental operations."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

BUNDLE = Path(__file__).resolve().parent
CONFIG = json.loads((BUNDLE / 'profiles.json').read_text())
MODEL_NAMES = ('raw', 'turbo', 'text_encoder', 'vae')

def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda: f.read(8 * 1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()

def safe_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,95}', value):
        raise ValueError('IDs must contain only letters, digits, underscore and hyphen')
    return value

def model_paths(root):
    lock = json.loads((BUNDLE / 'research/models-lock.json').read_text())
    return {name: root / 'models' / name / row['file'] for name, row in zip(MODEL_NAMES, lock)}

def validate_request(req):
    safe_id(req.get('request_id'))
    if req.get('profile', 'rtx5090') not in CONFIG['profiles']:
        raise ValueError('Unknown GPU profile')
    if req.get('operation') == 'generate':
        prompt = req.get('prompt')
        if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 10000:
            raise ValueError('A nonempty prompt up to 10000 characters is required')
        # Backend supports per-line option overrides; never forward them from a prompt.
        if '\n' in prompt or '\r' in prompt or '--' in prompt or prompt.startswith('-'):
            raise ValueError('Prompt must be one plain line without backend option syntax')
        for k in ('width', 'height'):
            value = req.get(k, 1024)
            if type(value) is not int or not 512 <= value <= 2048 or value % 16:
                raise ValueError('Width/height must be 512..2048, divisible by 16')
        if req.get('width', 1024) * req.get('height', 1024) > 2097152:
            raise ValueError('Initial shared profile is limited to 2 megapixels')
        seed = req.get('seed', 42)
        if type(seed) is not int or not 0 <= seed < 2**32:
            raise ValueError('Seed must be an unsigned 32-bit integer')
        loras = req.get('loras', [])
        if not isinstance(loras, list) or len(loras) > 1:
            raise ValueError('Shared initial contract allows one registered LoRA per generation')
        for lora in loras:
            safe_id(lora.get('id'))
            value = lora.get('strength', 1.0)
            if type(value) not in (int, float) or not math.isfinite(value) or not -2 <= value <= 2:
                raise ValueError('LoRA strength must be finite and in -2..2')
    elif req.get('operation') == 'train':
        safe_id(req.get('dataset_id'))
        safe_id(req.get('output_name'))
        steps = req.get('max_train_steps', 50)
        if type(steps) is not int or not 1 <= steps <= 10000:
            raise ValueError('Training steps must be 1..10000')
    else:
        raise ValueError('Operation must be generate or train')

def resolve_loras(root, req):
    files, scales = [], []
    registry = root / 'loras'
    for item in req.get('loras', []):
        folder = registry / safe_id(item['id'])
        meta = json.loads((folder / 'manifest.json').read_text())
        if meta.get('status') != 'approved' or meta.get('base_inference') != 'krea/Krea-2-Turbo':
            raise ValueError('LoRA must be approved and compatible with Krea 2 Turbo')
        weights = folder / 'weights.safetensors'
        if digest(weights) != meta['weights_sha256']:
            raise ValueError('LoRA hash mismatch')
        files.append(str(weights)); scales.append(str(item.get('strength', 1.0)))
    return files, scales

def plan(root, req):
    validate_request(req)
    profile = CONFIG['profiles'][req.get('profile', CONFIG['default_profile'])]
    models = model_paths(root)
    python = str(root / 'venv/bin/python')
    scripts = root / 'musubi-tuner/src/musubi_tuner'
    job = root / 'jobs' / req['request_id']
    if req['operation'] == 'generate':
        from comfy_local import build
        resolve_loras(root, req)
        loras = req.get('loras', [])
        command = [python, str(BUNDLE / 'comfy_local.py'), '--root', str(root), '--request', str(job / 'request.json')]
        return {'commands': [command], 'job_dir': str(job), 'models_required': [],
                'comfy_models_required': True, 'inference_backend': 'comfyui',
                'comfy_graph': build(req, loras[0]['id'] + '/weights.safetensors' if loras else None),
                'service_required': 'http://127.0.0.1:8191'}
    params = profile['training']
    dataset = root / 'datasets' / req['dataset_id']
    images = dataset / 'images'
    # Cache directories are job-specific so two resolutions never reuse mismatched cached embeddings.
    dataset_toml = (f'[general]\nresolution = [{params["resolution"]}, {params["resolution"]}]\n'
                    'caption_extension = ".txt"\nbatch_size = 1\nenable_bucket = true\nbucket_no_upscale = true\n'
                    f'\n[[datasets]]\nimage_directory = {json.dumps(str(images))}\n'
                    f'cache_directory = {json.dumps(str(job / "cache"))}\nnum_repeats = 1\n')
    dataset_cfg = str(job / 'dataset.toml')
    latent = [python, str(scripts / 'krea2_cache_latents.py'), '--dataset_config', dataset_cfg,
              '--vae', str(models['vae'])]
    text = [python, str(scripts / 'krea2_cache_text_encoder_outputs.py'), '--dataset_config', dataset_cfg,
            '--text_encoder', str(models['text_encoder']), '--batch_size', '1']
    train = [str(root / 'venv/bin/accelerate'), 'launch', '--num_processes', '1',
             '--num_cpu_threads_per_process', '2', '--mixed_precision', 'bf16',
             str(scripts / 'krea2_train_network.py'), '--dit', str(models['raw']),
             '--vae', str(models['vae']), '--dataset_config', dataset_cfg, '--sdpa',
             '--mixed_precision', 'bf16', '--timestep_sampling', 'krea2_shift',
             '--weighting_scheme', 'none', '--optimizer_type', 'adamw8bit',
             '--learning_rate', str(params['learning_rate']), '--gradient_checkpointing',
             '--fp8_base', '--fp8_scaled', '--blocks_to_swap', str(params['blocks_to_swap']),
             '--max_data_loader_n_workers', '2', '--persistent_data_loader_workers',
             '--network_module', 'networks.lora_krea2', '--network_dim', str(params['network_dim']),
             '--network_alpha', str(params['network_alpha']), '--max_train_steps', str(req.get('max_train_steps', 50)),
             '--save_every_n_steps', '250', '--seed', '42', '--save_state',
             '--output_dir', str(job / 'outputs'), '--output_name', req['output_name']]
    return {'commands': [latent, text, train], 'job_dir': str(job), 'dataset_toml': dataset_toml,
            'dataset_images': str(images), 'models_required': ['raw', 'text_encoder', 'vae']}

def require_license(root):
    receipt = root / 'access/model-license-acceptance.json'
    if not receipt.exists():
        raise ValueError('Krea license acceptance/access receipt is missing; review terms before model use')
    data = json.loads(receipt.read_text())
    if data.get('accepted') is not True or not data.get('accepted_by') or not data.get('accepted_at'):
        raise ValueError('Incomplete license acceptance record')

def verify_models(root, names):
    models = model_paths(root)
    lock = json.loads((BUNDLE / 'research/models-lock.json').read_text())
    for name in names:
        row = lock[MODEL_NAMES.index(name)]
        if not models[name].is_file() or models[name].stat().st_size != row['size']:
            raise ValueError('Missing/incomplete model: ' + name)
        if digest(models[name]) != row['lfs']['sha256']:
            raise ValueError('Model checksum mismatch: ' + name)

def verify_comfy_models(root):
    rows = json.loads((BUNDLE / 'research/comfy-models-lock.json').read_text())
    for row in rows:
        path = root / 'models/comfy' / row['file']
        if not path.is_file() or path.stat().st_size != row['size'] or digest(path) != row['sha256']:
            raise ValueError('Missing or mismatched Comfy model: ' + row['file'])

def validate_dataset(images):
    from PIL import Image
    files = [x for x in images.iterdir() if x.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp')]
    if not files:
        raise ValueError('Dataset contains no images')
    for path in files:
        if not path.with_suffix('.txt').read_text().strip():
            raise ValueError('Empty caption: ' + path.name)
        with Image.open(path) as im:
            im.verify()
    return {p.name: {'image_sha256': digest(p), 'caption_sha256': digest(p.with_suffix('.txt'))} for p in sorted(files)}

def save_json(path, data):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(path)

def execute(root, req, prepared):
    if sys.platform != 'linux':
        raise ValueError('Execution targets AutoDL Linux, preview is available locally')
    import fcntl
    root.mkdir(parents=True, exist_ok=True)
    with (root / '.gpu-job.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        job = Path(prepared['job_dir'])
        if job.exists():
            raise ValueError('Request ID already exists: inspect its state; never auto-resubmit an unknown job')
        require_license(root)
        verify_models(root, prepared['models_required'])
        if prepared.get('comfy_models_required'):
            verify_comfy_models(root)
        repo = root / 'musubi-tuner'
        commit = json.loads((BUNDLE / 'research/source-lock.json').read_text())['musubi']['commit']
        if subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip() != commit:
            raise ValueError('Backend revision mismatch')
        if req['operation'] == 'generate':
            comfy_commit = json.loads((BUNDLE / 'research/source-lock.json').read_text())['comfy']['commit']
            if subprocess.check_output(['git', '-C', str(root / 'ComfyUI'), 'rev-parse', 'HEAD'], text=True).strip() != comfy_commit:
                raise ValueError('ComfyUI revision mismatch')
        else:
            # Free resident inference weights before training; no interruption of existing Comfy tasks.
            from comfy_local import api
            try:
                queue = api('/queue')
            except OSError:
                queue = None  # ComfyUI is not running; training can proceed directly.
            if queue is not None:
                if queue.get('queue_running') or queue.get('queue_pending'):
                    raise ValueError('ComfyUI still has work; finish it before training')
                api('/free', {'unload_models': True, 'free_memory': True})
        hardware = subprocess.check_output([str(root / 'venv/bin/python'), '-c',
            'import torch,json; assert torch.cuda.is_available(); print(json.dumps({"gpu":torch.cuda.get_device_name(0),"vram":torch.cuda.get_device_properties(0).total_memory,"torch":torch.__version__,"cuda":torch.version.cuda}))'], text=True)
        gpu = json.loads(hardware)
        expected = CONFIG['profiles'][req.get('profile', CONFIG['default_profile'])]
        if expected['gpu'] not in gpu['gpu'] or gpu['vram'] < (expected['vram_gb'] - 2) * 1024**3:
            raise ValueError('GPU/profile mismatch; select the actual hardware profile')
        dataset_manifest = validate_dataset(Path(prepared['dataset_images'])) if req['operation'] == 'train' else None
        job.mkdir(parents=True)
        (job / 'outputs').mkdir()
        if dataset_manifest:
            save_json(job / 'dataset-manifest.json', dataset_manifest)
        if 'dataset_toml' in prepared:
            (job / 'dataset.toml').write_text(prepared['dataset_toml'])
        save_json(job / 'request.json', req)
        state = {'state': 'running', 'started_at': time.time(), 'hardware': gpu, 'request_id': req['request_id']}
        save_json(job / 'state.json', state)
        env = dict(os.environ, HF_HOME=str(root / 'hf-cache'), TOKENIZERS_PARALLELISM='false')
        # Tokens are inherited only by the subprocess; environment values are never logged.
        try:
            with (job / 'worker.log').open('a') as log:
                for i, command in enumerate(prepared['commands']):
                    state['stage'] = i
                    save_json(job / 'state.json', state)
                    subprocess.run(command, cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
            outputs = sorted((job / 'outputs').glob('*.png')) if req['operation'] == 'generate' else sorted((job / 'outputs').glob('*.safetensors'))
            if not outputs:
                raise ValueError('Backend returned without a final output')
            if req['operation'] == 'generate':
                from PIL import Image
                for output in outputs:
                    with Image.open(output) as im:
                        im.verify()
            state.update(state='completed', outputs=[{'file': str(x), 'sha256': digest(x)} for x in outputs])
        except BaseException as error:
            outcome = 'interrupted' if isinstance(error, KeyboardInterrupt) else 'failed'
            supplier_path = job / 'supplier-job.json'
            if supplier_path.exists():
                supplier_state = json.loads(supplier_path.read_text()).get('state')
                if supplier_state == 'submission_unknown':
                    outcome = 'submission_unknown'
                elif supplier_state == 'submitted':
                    outcome = 'observation_pending'
            state.update(state=outcome, error=type(error).__name__)
            raise
        finally:
            state['ended_at'] = time.time()
            save_json(job / 'state.json', state)
    return state

def download(root):
    require_license(root)
    from huggingface_hub import hf_hub_download
    rows = json.loads((BUNDLE / 'research/models-lock.json').read_text())
    for name, row in zip(MODEL_NAMES, rows):
        if name == 'turbo':
            continue  # Inference uses the same FP8 Turbo file as the Cloud Comfy graph.
        path = hf_hub_download(row['repo'], row['file'], revision=row['revision'], local_dir=root / 'models' / name)
        if digest(path) != row['lfs']['sha256']:
            raise ValueError('Downloaded checksum mismatch: ' + name)
        print(json.dumps({'model': name, 'verified': True}))
    for row in json.loads((BUNDLE / 'research/comfy-models-lock.json').read_text()):
        path = hf_hub_download(row['repo'], row['file'], revision=row['revision'], local_dir=root / 'models/comfy')
        if digest(path) != row['sha256']:
            raise ValueError('Downloaded Comfy checksum mismatch')
        print(json.dumps({'comfy_model': row['file'], 'verified': True}))

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, default=Path(os.environ.get('KREA_ROOT', CONFIG['runtime_root'])))
    sub = p.add_subparsers(dest='cmd', required=True)
    q = sub.add_parser('job'); q.add_argument('request', type=Path); q.add_argument('--execute', action='store_true')
    sub.add_parser('download-models')
    args = p.parse_args()
    root = args.root.resolve()
    if args.cmd == 'download-models':
        download(root)
    else:
        req = json.loads(args.request.read_text()); prepared = plan(root, req)
        if args.execute:
            print(json.dumps(execute(root, req, prepared), ensure_ascii=False, indent=2))
        else:
            prepared['shell_preview'] = [shlex.join(x) for x in prepared['commands']]
            print(json.dumps(prepared, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
