"""MiniMax official speech/music API adapter. No browser or session-cookie path."""
from contextlib import contextmanager
import concurrent.futures
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import time
import urllib.error
import urllib.request
import uuid

ENTRY = 'a4f798b3-ed0d-478b-a189-d8638a60da16'
BASE = 'https://api.minimax.cn/v1'
PREFIX = '/api/h3-cloud/audio'
BOOT = str(uuid.uuid4())
POOL = concurrent.futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix='minimax-audio')


class Fault(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def root():
    p = Path(os.environ.get('MINIMAX_AUDIO_STATE_DIR',
             str(Path(os.environ.get('H3_CLOUD_STATE_DIR', str(Path.home() / '.local/state/workspace-h3-cloud-api'))) / 'minimax-audio')))
    p.mkdir(parents=True, exist_ok=True, mode=0o700)
    return p


@contextmanager
def db():
    c = sqlite3.connect(root() / 'jobs.sqlite', timeout=30)
    c.execute('PRAGMA synchronous=FULL')
    c.execute('CREATE TABLE IF NOT EXISTS jobs(owner TEXT,id TEXT,digest TEXT,state TEXT,boot TEXT,meta TEXT,PRIMARY KEY(owner,id))')
    try:
        with c:
            yield c
    finally:
        c.close()


def uid(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError):
        raise Fault(422, 'stable_job_uuid_required')


def text(value, maximum, required=True):
    if not isinstance(value, str) or len(value) > maximum or (required and not value.strip()):
        raise Fault(422, 'invalid_text_or_length')
    return value


def build(kind, b):
    common = {'generation_authorized', 'billing_acknowledged', 'billing_source', 'estimated_cost_cny', 'max_cost_cny'}
    if kind == 'speech':
        allowed = common | {'text', 'model', 'voice_id', 'speed', 'volume', 'pitch', 'emotion'}
        model = b.get('model', 'speech-2.8-hd')
        if model not in ('speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo'):
            raise Fault(422, 'unsupported_speech_model')
        speed, volume, pitch = b.get('speed', 1), b.get('volume', 1), b.get('pitch', 0)
        for val, low, high in [(speed, .5, 2), (volume, .01, 10), (pitch, -12, 12)]:
            if type(val) not in (int, float) or not math.isfinite(val) or not low <= val <= high:
                raise Fault(422, 'invalid_voice_setting')
        if type(pitch) is not int:
            raise Fault(422, 'pitch_must_be_integer')
        voice = {'voice_id': text(b.get('voice_id'), 200), 'speed': speed, 'vol': volume, 'pitch': pitch}
        if b.get('emotion'):
            if b['emotion'] not in ('happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper'):
                raise Fault(422, 'invalid_emotion')
            voice['emotion'] = b['emotion']
        payload = {'model': model, 'text': text(b.get('text'), 3000), 'stream': False,
                   'output_format': 'hex', 'voice_setting': voice,
                   'audio_setting': {'sample_rate': 32000, 'bitrate': 128000, 'format': 'mp3', 'channel': 1}}
    elif kind == 'music':
        allowed = common | {'model', 'prompt', 'lyrics', 'is_instrumental'}
        model = b.get('model', 'music-3.0')
        if model not in ('music-3.0', 'music-2.6'):
            raise Fault(422, 'unsupported_music_model')
        instrumental = b.get('is_instrumental', False)
        if type(instrumental) is not bool:
            raise Fault(422, 'is_instrumental_must_be_boolean')
        payload = {'model': model, 'prompt': text(b.get('prompt', ''), 2000, instrumental),
                   'lyrics': text(b.get('lyrics', ''), 3500, not instrumental),
                   'is_instrumental': instrumental, 'lyrics_optimizer': False,
                   'stream': False, 'output_format': 'hex',
                   'audio_setting': {'sample_rate': 44100, 'bitrate': 256000, 'format': 'mp3'}}
    else:
        raise Fault(404, 'unknown_audio_kind')
    if set(b) - allowed:
        raise Fault(422, 'unsupported_fields')
    return payload


def authorize_spend(b):
    if b.get('generation_authorized') is not True:
        raise Fault(422, 'generation_authorized_required')
    if b.get('billing_source') not in ('official_api', 'm_plan') or b.get('billing_acknowledged') is not True:
        raise Fault(409, 'explicit_official_api_or_m_plan_billing_required')
    est, cap = b.get('estimated_cost_cny'), b.get('max_cost_cny')
    if any(type(v) not in (float, int) or not math.isfinite(v) or v <= 0 for v in (est, cap)) or est > cap:
        raise Fault(422, 'positive_estimate_within_approved_budget_required')


def credential(call):
    identity = call('hufu_whoami', {})
    if 'mem.process' not in identity.get('client_actions', []):
        raise Fault(403, 'current_client_mem_process_required')
    result = call('hufu.vault.reveal', {'entry_id': ENTRY})
    if result.get('state') != 'revealed' or not isinstance(result.get('value'), str):
        raise Fault(403, 'current_minimax_credential_grant_required')
    return result['value']


def provider(path, body, key):
    if path not in ('/get_voice', '/t2a_v2', '/music_generation'):
        raise Fault(422, 'provider_path_not_allowed')
    r = urllib.request.Request(BASE + path, method='POST', data=json.dumps(body).encode(),
                               headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=900) as response:
            data = response.read(80 * 1024 * 1024 + 1)
        if len(data) > 80 * 1024 * 1024:
            raise Fault(502, 'supplier_response_too_large_original_effect_not_retried')
        result = json.loads(data)
    except urllib.error.HTTPError as error:
        try:
            response = json.loads(error.read(65536))
            provider_code = response.get('base_resp', {}).get('status_code')
        except (ValueError, AttributeError):
            provider_code = None
        suffix = '_base_resp_' + str(provider_code) if type(provider_code) is int else ''
        raise Fault(502, 'supplier_http_' + str(error.code) + suffix)
    except (OSError, ValueError):
        raise Fault(502, 'supplier_effect_or_read_unknown')
    code = result.get('base_resp', {}).get('status_code')
    if code != 0:
        raise Fault(502, 'supplier_base_resp_' + str(code))
    return result


def reserve(owner, local_id, body):
    local_id = uid(local_id)
    digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        row = c.execute('SELECT digest FROM jobs WHERE owner=? AND id=?', (owner, local_id)).fetchone()
        if row:
            if row[0] != digest:
                raise Fault(409, 'job_uuid_bound_to_other_input')
            return False
        count = c.execute("SELECT count(*) FROM jobs WHERE owner=? AND boot=? AND state IN ('queued','submitting')", (owner, BOOT)).fetchone()[0]
        if count >= 4:
            raise Fault(429, 'too_many_active_audio_jobs')
        meta = {'id': local_id, 'state': 'queued', 'created_at': time.time(), 'resubmit_allowed': False,
                'billing_source': body.get('body', {}).get('billing_source', 'unconfirmed'), 'budget_is_estimate_not_provider_hard_cap': True}
        c.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?)', (owner, local_id, digest, 'queued', BOOT, json.dumps(meta)))
    return True


def save(owner, local_id, **fields):
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        row = c.execute('SELECT meta FROM jobs WHERE owner=? AND id=?', (owner, local_id)).fetchone()
        meta = json.loads(row[0]); meta.update(fields)
        c.execute('UPDATE jobs SET state=?,meta=? WHERE owner=? AND id=?',
                  (meta['state'], json.dumps(meta), owner, local_id))


def status(owner, local_id):
    uid(local_id)
    with db() as c:
        row = c.execute('SELECT boot,meta FROM jobs WHERE owner=? AND id=?', (owner, local_id)).fetchone()
    if not row:
        raise Fault(404, 'job_not_found_in_current_owner_scope')
    meta = json.loads(row[1])
    if row[0] != BOOT and meta['state'] in ('queued', 'submitting'):
        meta.update(state='submission_unknown', resubmit_allowed=False,
                    next_step='inspect_original_provider_trace_and_saved_outputs_no_automatic_resend')
    return meta


def execute(owner, local_id, kind, payload, key):
    save(owner, local_id, state='submitting', started_at=time.time())
    try:
        result = provider('/t2a_v2' if kind == 'speech' else '/music_generation', payload, key)
        audio = result.get('data', {}).get('audio')
        if not isinstance(audio, str) or not audio:
            raise Fault(502, 'supplier_audio_missing')
        try:
            content = bytes.fromhex(audio)
        except ValueError:
            raise Fault(502, 'supplier_audio_not_hex')
        if not content:
            raise Fault(502, 'supplier_audio_empty')
        folder = root() / owner
        folder.mkdir(mode=0o700, exist_ok=True)
        part = folder / (local_id + '.part')
        part.write_bytes(content); os.chmod(part, 0o600)
        part.replace(folder / (local_id + '.mp3'))
        save(owner, local_id, state='succeeded', model=payload['model'], kind=kind,
             completed_at=time.time(), trace_id=result.get('trace_id'),
             audio_size=len(content), audio_sha256=hashlib.sha256(content).hexdigest(),
             extra_info=result.get('extra_info'), format='mp3',
             full_decode_verified=False)
    except Fault as error:
        save(owner, local_id, state='failed_or_unknown', error_code=error.code,
             completed_at=time.time(), resubmit_allowed=False)
    except Exception:
        save(owner, local_id, state='failed_or_unknown', error_code='local_processing_or_effect_unknown',
             completed_at=time.time(), resubmit_allowed=False)


def install():
    from fastapi import APIRouter, HTTPException, Request
    from fastapi.responses import FileResponse
    from caller_context import CURRENT_CALLER
    from tools_mcp_bridge import call
    from web.server import app
    router = APIRouter(prefix=PREFIX, tags=['MiniMax official audio API'])

    def action(fn, *args):
        try:
            return fn(*args)
        except Fault as e:
            raise HTTPException(e.status, {'code': e.code})

    def owner():
        c = CURRENT_CALLER.get()
        if not c or not c.get('legacy_subject'):
            raise Fault(401, 'current_native_identity_required')
        return hashlib.sha256(c['legacy_subject'].encode()).hexdigest()

    @router.get('/capabilities')
    def capabilities():
        action(owner)
        return {'backend': 'official_minimax_api_only', 'browser_used': False,
                'speech_models': ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo'],
                'music_models': ['music-3.0', 'music-2.6'], 'speech_max_characters': 3000,
                'format': 'mp3', 'stream': False, 'website_credits_api_mapping': 'unverified',
                'music_account_generation_entitlement': 'unverified_historical_paid_access_required',
                'generation_verification': 'see_current_provider_facts_and_job_receipts',
                'billing_sources': ['official_api', 'm_plan'],
                'billing_source_checked_against_key_type': True}

    @router.post('/health')
    def health():
        action(owner)
        key = action(credential, call)
        result = action(provider, '/get_voice', {'voice_type': 'system'}, key)
        return {'provider_auth_read': 'verified', 'system_voice_count': len(result.get('system_voice', [])),
                'generation_submitted': False, 'billing_or_music_entitlement_not_proven': True,
                'billing_source': 'm_plan' if key.startswith('sk-cp-') else 'official_api'}

    @router.get('/voices')
    def voices():
        action(owner)
        key = action(credential, call)
        result = action(provider, '/get_voice', {'voice_type': 'system'}, key)
        return {'system_voice': result.get('system_voice', []), 'generation_submitted': False}

    @router.post('/{kind}/preview')
    def preview(kind: str, body: dict):
        action(owner)
        return {'provider_request': action(build, kind, body), 'generation_submitted': False,
                'billing_source': body.get('billing_source', 'not_confirmed')}

    @router.post('/{kind}/jobs', status_code=202)
    def submit(kind: str, body: dict, request: Request):
        who = action(owner)
        payload = action(build, kind, body)
        action(authorize_spend, body)
        key = action(credential, call)
        actual_source = 'm_plan' if key.startswith('sk-cp-') else 'official_api'
        if body.get('billing_source') != actual_source:
            raise HTTPException(409, {'code': 'billing_source_does_not_match_current_key_type', 'actual_source': actual_source})
        local_id = action(uid, request.headers.get('Idempotency-Key', ''))
        fresh = action(reserve, who, local_id, {'kind': kind, 'body': body})
        if fresh:
            try:
                POOL.submit(execute, who, local_id, kind, payload, key)
            except RuntimeError:
                save(who, local_id, state='queue_failed', error_code='local_queue_unavailable', resubmit_allowed=False)
        return action(status, who, local_id)

    @router.get('/jobs/{local_id}')
    def get_status(local_id: str):
        return action(status, action(owner), local_id)

    @router.get('/jobs/{local_id}/audio')
    def download(local_id: str):
        who = action(owner)
        record = action(status, who, local_id)
        action(credential, call)
        if record['state'] != 'succeeded':
            raise HTTPException(409, 'audio_not_ready')
        path = root() / who / (uid(local_id) + '.mp3')
        if not path.is_file():
            raise HTTPException(410, 'local_audio_not_available_no_regeneration')
        return FileResponse(path, media_type='audio/mpeg', filename=local_id + '.mp3',
                            headers={'Cache-Control': 'private, no-store'})

    app.include_router(router)
