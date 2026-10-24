"""Caller-authorized Comfy Cloud H3 adapter; no provider secrets in source/state."""
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import uuid

# TEMPLATE is appended from the successful N07 execution graph at packaging time.
CONFIG_PROJECT = 'ab817207-5829-4429-a165-bf1159ae4de0'
CONFIG_PATH = '调用配置/Comfy-Cloud-QQ.json'
ORIGIN = 'https://cloud.comfy.org/api/v2'
LOCK = threading.Lock()


class Fault(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def identifier(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise Fault(422, 'asset_or_job_uuid_required')


def build(body):
    prompt = body.get('prompt', '')
    if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 20000:
        raise Fault(422, 'explicit_prompt_required')
    tier = body.get('resolution', '544P')
    if tier not in ('352P', '544P'):
        raise Fault(422, 'turbo4_supports_352P_or_544P_in_this_adapter')
    duration = body.get('duration', 5)
    if type(duration) not in (int, float) or not math.isfinite(duration) or not 0 < duration <= 15:
        raise Fault(422, 'duration_must_be_positive_up_to_15_seconds')
    frames = 5 + 17 * math.ceil((max(5, duration * 24) - 5) / 17)
    width, height = (608, 352) if tier == '352P' else (960, 544)
    if body.get('orientation', 'landscape') == 'portrait':
        width, height = height, width
    elif body.get('orientation', 'landscape') != 'landscape':
        raise Fault(422, 'invalid_orientation')
    images = body.get('reference_image_asset_ids', [])
    if not isinstance(images, list) or len(images) > 9:
        raise Fault(422, 'up_to_nine_reference_images')
    video = identifier(body.get('reference_video_asset_id'))
    images = [identifier(v) for v in images]
    seed = body.get('seed', 42424242)
    if type(seed) is not int or not 0 <= seed <= 2**53 - 1:
        raise Fault(422, 'seed_out_of_range')
    g = copy.deepcopy(TEMPLATE)
    cond = g['5']['inputs']
    cond.update(prompt=prompt.strip(), width=width, height=height, length=frames)
    asset = lambda v: {'__type': 'core/ASSET', 'info': {'id': v}}
    g['21']['inputs']['file'] = asset(video)
    for k, value in enumerate(images):
        node = str(40 + k)
        g[node] = {'class_type': 'LoadImage', 'inputs': {'image': asset(value)}}
        cond['ref_images.ref_image_' + str(k)] = [node, 0]
    g['7']['inputs']['noise_seed'] = seed
    return g, {'profile': 'ref2va_turbo4', 'width': width, 'height': height,
               'frames': frames, 'fps': 24, 'duration': frames / 24,
               'requested_duration': duration, 'reference_images': len(images),
               'reference_video': True, 'output_nodes': ['15']}


def provider(method, path, key, body=None, idem=None):
    headers = {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}
    if idem:
        headers['Idempotency-Key'] = idem
    request = urllib.request.Request(ORIGIN + path, method=method, headers=headers,
                                     data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # Never expose supplier response bodies, signed URLs, or credentials.
        raise Fault(error.code if error.code in (401, 403, 404, 409, 422, 429) else 502,
                    'supplier_http_' + str(error.code))
    except (OSError, ValueError):
        raise Fault(502, 'supplier_effect_or_observation_unknown')


def configured_key(call):
    identity = call('hufu_whoami', {})
    if 'mem.process' not in identity.get('client_actions', []):
        raise Fault(403, 'current_client_mem_process_required')
    document = call('hub.document.open', {'project_id': CONFIG_PROJECT, 'path': CONFIG_PATH})
    try:
        config = json.loads(document['text'])
        key = config['COMFY_API_KEY']
        if not isinstance(key, str) or not key.strip():
            raise ValueError()
        return key.strip()
    except (KeyError, TypeError, ValueError):
        raise Fault(503, 'authorized_comfy_configuration_unavailable')


def connection():
    # Private durable service data; no inputs, prompts or secrets in this ledger.
    root = Path(os.environ.get('H3_CLOUD_STATE_DIR', str(Path.home() / '.local/state/workspace-h3-cloud-api')))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(root / 'jobs.sqlite', timeout=30)
    db.execute('PRAGMA synchronous=FULL')
    db.execute('CREATE TABLE IF NOT EXISTS jobs(owner TEXT, id TEXT, digest TEXT, '
               'provider_key TEXT, provider_job TEXT, state TEXT, created REAL, PRIMARY KEY(owner,id))')
    return db


def reserve(owner, local_id, digest):
    identifier(local_id)
    with LOCK, connection() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT digest,provider_key,provider_job,state FROM jobs WHERE owner=? AND id=?',
                         (owner, local_id)).fetchone()
        if row:
            if row[0] != digest:
                raise Fault(409, 'idempotency_key_bound_to_other_request')
            return False, row
        key = str(uuid.uuid4())
        db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)',
                   (owner, local_id, digest, key, None, 'submission_unknown', time.time()))
        return True, (digest, key, None, 'submission_unknown')


def update(owner, local_id, job, state):
    with connection() as db:
        db.execute('UPDATE jobs SET provider_job=?,state=? WHERE owner=? AND id=?',
                   (job, state, owner, local_id))


def owned(owner, local_id):
    identifier(local_id)
    with connection() as db:
        row = db.execute('SELECT provider_job,state FROM jobs WHERE owner=? AND id=?',
                         (owner, local_id)).fetchone()
    if row is None:
        raise Fault(404, 'job_not_found_in_current_owner_scope')
    return row


def sanitized(job):
    return {k: job.get(k) for k in ('id', 'status', 'queue_position', 'progress', 'metrics', 'expires_at')} | {
        'outputs': [{k: o.get(k) for k in ('id', 'node_id', 'name', 'content_type', 'size_bytes', 'hash')}
                    for o in job.get('outputs', [])]}


def install():
    from fastapi import APIRouter, HTTPException, Request
    from web.server import app
    from caller_context import CURRENT_CALLER
    from tools_mcp_bridge import call
    router = APIRouter(prefix='/api/h3-cloud', tags=['Comfy Cloud H3'])

    def owner():
        c = CURRENT_CALLER.get()
        if not c or not c.get('legacy_subject'):
            raise Fault(401, 'current_native_caller_required')
        return hashlib.sha256(c['legacy_subject'].encode()).hexdigest()

    def action(fn, *args):
        try:
            return fn(*args)
        except Fault as error:
            raise HTTPException(error.status, {'code': error.code})

    @router.get('/capabilities')
    def capabilities():
        action(owner)
        return {'provider': 'comfy-cloud', 'workflow': 'ref2va_turbo4',
                'resolutions': ['352P', '544P'], 'max_duration': 15,
                'reference_video_required': True, 'reference_images_max': 9,
                'generation_submitted': False, 'paid_generation_tested_this_stage': False}

    @router.post('/preview')
    def preview(body: dict):
        action(owner)
        graph, summary = action(build, body)
        digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        return {'parameters': summary, 'request_sha256': digest, 'workflow': graph, 'submitted': False}

    @router.post('/health')
    def health():
        action(owner)
        key = action(configured_key, call)
        action(provider, 'GET', '/jobs/5b6531c0-467a-48e6-a9d7-757cf62a9d97', key)
        return {'credential_and_supplier_read': 'verified', 'probe': 'verified_qq_native_h3_historical_job', 'submitted': False}

    @router.post('/jobs')
    def submit(body: dict, request: Request):
        who = action(owner)
        graph, summary = action(build, body)
        if body.get('generation_authorized') is not True:
            raise HTTPException(422, 'generation_authorized=true required')
        estimate, budget = body.get('estimated_credits'), body.get('budget_credits')
        if any(type(v) not in (int, float) or not math.isfinite(v) or v <= 0 for v in (estimate, budget)) or estimate > budget:
            raise HTTPException(422, 'positive estimate within explicit budget required')
        key = action(configured_key, call)
        local_id = request.headers.get('Idempotency-Key', '')
        digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        fresh, row = action(reserve, who, local_id, digest)
        if not fresh:
            return {'id': local_id, 'state': row[3], 'provider_job_id': row[2], 'resubmitted': False}
        # Reservation is durable BEFORE any provider POST. No auto retry of unknowns.
        job = action(provider, 'POST', '/jobs', key, {'workflow': graph}, row[1])
        if not isinstance(job.get('id'), str):
            raise HTTPException(502, 'submission_unknown; query original local id')
        action(identifier, job['id'])
        action(update, who, local_id, job['id'], job['status'])
        return {'id': local_id, 'provider_job_id': job['id'], 'state': job['status'],
                'parameters': summary, 'budget_is_supplier_estimate_only': True}

    @router.get('/jobs/{local_id}')
    def status(local_id: str):
        who = action(owner)
        job_id, state = action(owned, who, local_id)
        if not job_id:
            return {'id': local_id, 'state': state, 'resubmit_allowed': False}
        key = action(configured_key, call)
        job = action(provider, 'GET', '/jobs/' + identifier(job_id), key)
        action(update, who, local_id, job_id, job['status'])
        return {'id': local_id, 'supplier': sanitized(job)}

    @router.get('/jobs/{local_id}/outputs/{asset_id}')
    def output(local_id: str, asset_id: str):
        from fastapi.responses import StreamingResponse
        who = action(owner)
        job_id, _ = action(owned, who, local_id)
        if not job_id:
            raise HTTPException(409, 'submission_unknown')
        key = action(configured_key, call)
        job = action(provider, 'GET', '/jobs/' + identifier(job_id), key)
        aid = action(identifier, asset_id)
        if not any(o.get('id') == aid for o in job.get('outputs', [])):
            raise HTTPException(404, 'output_not_in_this_job')
        asset = action(provider, 'GET', '/assets/' + aid, key)
        url = asset.get('url', '')
        if not url.startswith('https://'):
            raise HTTPException(502, 'supplier_output_url_unavailable')
        # Fresh unauthenticated storage request: never forward the Hufu bearer.
        try:
            remote = urllib.request.urlopen(urllib.request.Request(url), timeout=60)
        except OSError:
            raise HTTPException(502, 'supplier_output_stream_unavailable')
        def chunks():
            try:
                while True:
                    block = remote.read(1024 * 1024)
                    if not block:
                        break
                    yield block
            finally:
                remote.close()
        return StreamingResponse(chunks(), media_type='application/octet-stream',
                                 headers={'Cache-Control': 'private, no-store',
                                          'Content-Disposition': 'attachment',
                                          'X-Content-Type-Options': 'nosniff'})

    app.include_router(router)
TEMPLATE = {'1': {'inputs': {'unet_name': 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', 'weight_dtype': 'default'}, 'class_type': 'UNETLoader', '_meta': {'title': 'UNet加载器'}}, '2': {'inputs': {'clip_name': 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'type': 'minimax', 'device': 'default'}, 'class_type': 'CLIPLoader', '_meta': {'title': '加载CLIP'}}, '3': {'inputs': {'vae_name': 'minimax_h3_video_vae_fp16.safetensors'}, 'class_type': 'VAELoader', '_meta': {'title': '加载VAE'}}, '4': {'inputs': {'vae_name': 'minimax_h3_audio_vae_fp32.safetensors'}, 'class_type': 'VAELoader', '_meta': {'title': '加载VAE'}}, '5': {'inputs': {'prompt': '', 'width': 960, 'height': 544, 'length': 124, 'ref_image_size': 'match', 'clip': ['2', 0], 'vae': ['3', 0], 'audio_vae': ['4', 0], 'ref_videos.ref_video_0': ['22', 0]}, 'class_type': 'MiniMaxH3ReferenceToVideo', '_meta': {'title': 'MiniMax H3 参考转视频'}}, '6': {'inputs': {'model': ['30', 0], 'conditioning': ['5', 0]}, 'class_type': 'BasicGuider', '_meta': {'title': '基本引导器'}}, '7': {'inputs': {'noise_seed': 42424242}, 'class_type': 'RandomNoise', '_meta': {'title': '随机噪波'}}, '8': {'inputs': {'sampler_name': 'res_multistep'}, 'class_type': 'KSamplerSelect', '_meta': {'title': 'K采样器选择'}}, '9': {'inputs': {'scheduler': 'simple', 'steps': 4, 'denoise': 1, 'model': ['30', 0]}, 'class_type': 'BasicScheduler', '_meta': {'title': '基本调度器'}}, '10': {'inputs': {'noise': ['7', 0], 'guider': ['6', 0], 'sampler': ['8', 0], 'sigmas': ['9', 0], 'latent_image': ['5', 1]}, 'class_type': 'SamplerCustomAdvanced', '_meta': {'title': '自定义采样器（高级）'}}, '11': {'inputs': {'av_latent': ['10', 0]}, 'class_type': 'LTXVSeparateAVLatent', '_meta': {'title': '分离 AV 潜空间'}}, '12': {'inputs': {'tile_size': 512, 'overlap': 64, 'temporal_size': 64, 'temporal_overlap': 8, 'samples': ['11', 0], 'vae': ['3', 0]}, 'class_type': 'VAEDecodeTiled', '_meta': {'title': 'VAE解码（分块）'}}, '14': {'inputs': {'fps': 24, 'bit_depth': 'auto', 'color_space': 'sRGB', 'codec': 'none', 'images': ['12', 0]}, 'class_type': 'CreateVideo', '_meta': {'title': '创建视频'}}, '15': {'inputs': {'filename_prefix': 'H3-Cloud-API', 'format': 'mp4', 'format.codec': 'auto', 'codec': 'h264', 'codec.encoding': 'auto', 'video': ['14', 0]}, 'class_type': 'SaveVideo', '_meta': {'title': '保存视频'}}, '21': {'inputs': {'file': 'ASSET_REQUIRED', 'video-preview': ''}, 'class_type': 'LoadVideo', '_meta': {'title': 'Video1 15秒白模 上冲仰拍跟随'}}, '22': {'inputs': {'video': ['21', 0]}, 'class_type': 'GetVideoComponents', '_meta': {'title': '获取视频元素'}}, '30': {'inputs': {'lora_name': 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors', 'strength_model': 1, 'model': ['1', 0]}, 'class_type': 'LoraLoaderModelOnly', '_meta': {'title': 'LoRA加载器（仅模型）'}}}
