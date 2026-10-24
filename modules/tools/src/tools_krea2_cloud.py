"""Caller-authorized Comfy Cloud Krea 2 Turbo adapter; no provider secrets in source/state."""
from contextlib import contextmanager
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

# Native graph adapted from Comfy-Org image_krea2_turbo_t2i; no partner node.
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


def build(body, lora=None):
    allowed = {'prompt', 'width', 'height', 'seed', 'profile', 'generation_authorized',
               'estimated_credits', 'budget_credits', 'lora_id', 'lora_strength'}
    if set(body) - allowed:
        raise Fault(422, 'unsupported_parameters')
    prompt = body.get('prompt', '')
    if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 20000:
        raise Fault(422, 'explicit_prompt_required')
    if body.get('profile', 'turbo') != 'turbo':
        raise Fault(422, 'this_adapter_supports_krea2_turbo_only')
    width, height = body.get('width', 1024), body.get('height', 1024)
    if any(type(v) is not int or not 512 <= v <= 2048 or v % 8 for v in (width, height)):
        raise Fault(422, 'dimensions_512_to_2048_and_multiple_of_8_required')
    if width * height > 2097152:
        raise Fault(422, 'maximum_2_megapixels')
    seed = body.get('seed', 42424242)
    if type(seed) is not int or not 0 <= seed <= 2**53 - 1:
        raise Fault(422, 'seed_out_of_range')
    strength = body.get('lora_strength', 1.0)
    if type(strength) not in (int, float) or not math.isfinite(strength) or not -2 <= strength <= 2:
        raise Fault(422, 'lora_strength_between_minus2_and2_required')
    if body.get('lora_id') and (not lora or lora.get('state') != 'ready' or lora.get('id') != body['lora_id']):
        raise Fault(422, 'import_and_verify_lora_before_generation')
    if 'lora_strength' in body and not body.get('lora_id'):
        raise Fault(422, 'lora_id_required_with_strength')
    def node(name, **inputs):
        return {'class_type': name, 'inputs': inputs}
    graph = {
        '10': node('UNETLoader', unet_name='krea2_turbo_fp8_scaled.safetensors', weight_dtype='default'),
        '11': node('CLIPLoader', clip_name='qwen3vl_4b_fp8_scaled.safetensors', type='krea2', device='default'),
        '12': node('VAELoader', vae_name='qwen_image_vae.safetensors'),
        '6': node('CLIPTextEncode', clip=['11', 0], text=prompt.strip()),
        '13': node('ConditioningZeroOut', conditioning=['6', 0]),
        '5': node('EmptyLatentImage', width=width, height=height, batch_size=1),
        '3': node('KSampler', model=['10', 0], positive=['6', 0], negative=['13', 0],
                  latent_image=['5', 0], seed=seed, steps=8, cfg=1.0,
                  sampler_name='euler', scheduler='simple', denoise=1.0),
        '8': node('VAEDecode', samples=['3', 0], vae=['12', 0]),
        '29': node('SaveImage', images=['8', 0], filename_prefix='Krea2-Cloud-API')}
    if lora:
        graph['14'] = node('LoraLoaderModelOnly', model=['10', 0],
                           lora_name=lora['loader_path'],
                           strength_model=strength)
        graph['3']['inputs']['model'] = ['14', 0]
    return graph, {'lora': ({'id': lora['id'], 'version_id': lora['version_id'], 'strength': strength} if lora else None), 'profile': 'krea2_turbo_fp8', 'width': width, 'height': height,
                   'seed': seed, 'steps': 8, 'batch_size': 1, 'output_nodes': ['29'],
                   'prompt_enhancement': False, 'reference_images_supported': False}


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
        raise Fault(error.code if error.code in (401, 402, 403, 404, 409, 422, 429) else 502,
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


@contextmanager
def connection():
    # Private durable service data; no inputs, prompts or secrets in this ledger.
    root = Path(os.environ.get('KREA2_CLOUD_STATE_DIR', str(Path(os.environ.get('H3_CLOUD_STATE_DIR', str(Path.home() / '.local/state/workspace-h3-cloud-api'))) / 'krea2')))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(root / 'jobs.sqlite', timeout=30)
    db.execute('PRAGMA synchronous=FULL')
    db.execute('CREATE TABLE IF NOT EXISTS jobs(owner TEXT, id TEXT, digest TEXT, '
               'provider_key TEXT, provider_job TEXT, state TEXT, created REAL, PRIMARY KEY(owner,id))')
    try:
        with db:
            yield db
    finally:
        db.close()


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
    router = APIRouter(prefix='/api/h3-cloud/krea2', tags=['Comfy Cloud Krea 2'])

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

    def selected_build(body):
        who = owner()
        item = None
        if body.get('lora_id'):
            import tools_krea2_loras as loras
            item = loras.observe(who, body['lora_id'], configured_key(call))
        return build(body, item)

    import tools_krea2_loras as loras
    loras.install(router, owner, action, configured_key, call)

    @router.get('/capabilities')
    def capabilities():
        action(owner)
        return {'provider': 'comfy-cloud', 'workflow': 'krea2_turbo_fp8',
                'profiles': ['turbo'], 'steps': 8, 'dimensions_multiple_of': 8,
                'dimension_min': 512, 'dimension_max': 2048, 'max_pixels': 2097152,
                'batch_size': 1, 'reference_images_supported': False,
                'native_model': True, 'partner_node': False, 'lora_import': 'civitai',
                'lora_strength_range': [-2, 2], 'max_loras_per_image': 1}


    @router.post('/preview')
    def preview(body: dict):
        action(owner)
        graph, summary = action(selected_build, body)
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
        graph, summary = action(selected_build, body)
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
        try:
            job = provider('POST', '/jobs', key, {'workflow': graph}, row[1])
        except Fault as error:
            if error.status == 402:
                action(update, who, local_id, None, 'rejected_payment_required')
            raise HTTPException(error.status, {'code': error.code})
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
