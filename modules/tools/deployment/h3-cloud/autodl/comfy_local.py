#!/usr/bin/env python3
"""ComfyUI-local adapter for the same Krea Turbo graph used by Comfy Cloud."""
import argparse
import json
from pathlib import Path
import sys
import time
import urllib.request
import uuid

ORIGIN = 'http://127.0.0.1:8191'

def build(req, lora_file=None):
    def node(name, **inputs):
        return {'class_type': name, 'inputs': inputs}
    graph = {
        '10': node('UNETLoader', unet_name='krea2_turbo_fp8_scaled.safetensors', weight_dtype='default'),
        '11': node('CLIPLoader', clip_name='qwen3vl_4b_fp8_scaled.safetensors', type='krea2', device='default'),
        '12': node('VAELoader', vae_name='qwen_image_vae.safetensors'),
        '6': node('CLIPTextEncode', clip=['11', 0], text=req['prompt'].strip()),
        '13': node('ConditioningZeroOut', conditioning=['6', 0]),
        '5': node('EmptyLatentImage', width=req.get('width', 1024), height=req.get('height', 1024), batch_size=1),
        '3': node('KSampler', model=['10', 0], positive=['6', 0], negative=['13', 0], latent_image=['5', 0],
                  seed=req.get('seed', 42), steps=8, cfg=1.0, sampler_name='euler', scheduler='simple', denoise=1.0),
        '8': node('VAEDecode', samples=['3', 0], vae=['12', 0]),
        '29': node('SaveImage', images=['8', 0], filename_prefix='Krea2-AutoDL/' + req['request_id'])}
    if lora_file:
        graph['14'] = node('LoraLoaderModelOnly', model=['10', 0], lora_name=lora_file,
                           strength_model=req['loras'][0].get('strength', 1.0))
        graph['3']['inputs']['model'] = ['14', 0]
    return graph

def api(path, body=None):
    request = urllib.request.Request(ORIGIN + path, method='POST' if body is not None else 'GET',
                                    headers={'Content-Type': 'application/json'},
                                    data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--request', type=Path, required=True)
    p.add_argument('--root', type=Path, required=True)
    args = p.parse_args()
    from krea2ctl import validate_request, resolve_loras
    req = json.loads(args.request.read_text()); validate_request(req)
    resolve_loras(args.root, req)  # approved manifest, base family and SHA validation
    lora = req.get('loras', [])
    local_name = (lora[0]['id'] + '/weights.safetensors') if lora else None
    graph = build(req, local_name)
    job = args.root / 'jobs' / req['request_id']
    (job / 'comfy-graph.json').write_text(json.dumps(graph, ensure_ascii=False, indent=2))
    queue = api('/queue')
    if queue.get('queue_running') or queue.get('queue_pending'):
        raise RuntimeError('ComfyUI queue is busy; no task submitted')
    # Written BEFORE the only submission. Any submission error is ambiguous, never automatically retry.
    marker = job / 'supplier-job.json'
    marker.write_text(json.dumps({'state': 'submission_unknown', 'provider': 'autodl_comfyui'}))
    response = api('/prompt', {'prompt': graph, 'client_id': str(uuid.uuid4())})
    if not response.get('prompt_id'):
        marker.write_text(json.dumps({'state': 'rejected', 'provider': 'autodl_comfyui'}))
        raise RuntimeError('ComfyUI rejected the workflow')
    prompt_id = response['prompt_id']
    marker.write_text(json.dumps({'state': 'submitted', 'provider': 'autodl_comfyui', 'prompt_id': prompt_id}))
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        history = api('/history/' + prompt_id)
        item = history.get(prompt_id)
        if item:
            (job / 'comfy-history.json').write_text(json.dumps(item, ensure_ascii=False, indent=2))
            if item.get('status', {}).get('status_str') == 'error':
                marker.write_text(json.dumps({'state': 'failed', 'provider': 'autodl_comfyui', 'prompt_id': prompt_id}))
                raise RuntimeError('ComfyUI execution failed; inspect the original prompt ID')
            images = item.get('outputs', {}).get('29', {}).get('images', [])
            if images:
                from urllib.parse import urlencode
                for i, image in enumerate(images):
                    params = {k: image[k] for k in ('filename', 'subfolder', 'type') if k in image}
                    with urllib.request.urlopen(ORIGIN + '/view?' + urlencode(params), timeout=60) as response:
                        (job / 'outputs' / f'{i:03d}.png').write_bytes(response.read())
                marker.write_text(json.dumps({'state': 'completed', 'provider': 'autodl_comfyui', 'prompt_id': prompt_id}))
                return
        time.sleep(2)
    raise TimeoutError('Original Comfy prompt may still be running; do not resubmit on another provider')

if __name__ == '__main__':
    main()
