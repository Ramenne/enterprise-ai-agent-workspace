"""Pinned Civitai LoRA import using the current caller's authorized Cloud key."""
import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
import urllib.error
from tools_krea2_cloud import Fault, connection, LOCK, identifier


def cloud(method, path, key, body=None):
    req = urllib.request.Request('https://cloud.comfy.org/api' + path, method=method,
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'},
        data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise Fault(error.code if error.code in (400, 401, 402, 403, 404, 409, 422, 429) else 502,
                    'cloud_model_http_' + str(error.code))
    except (OSError, ValueError):
        raise Fault(502, 'cloud_model_observation_unknown')


def parse_url(url):
    if not isinstance(url, str) or len(url) > 2048:
        raise Fault(422, 'civitai_url_required')
    p = urllib.parse.urlsplit(url)
    if p.scheme != 'https' or p.hostname not in ('civitai.com', 'www.civitai.com') or p.username or p.password or p.port:
        raise Fault(422, 'https_civitai_model_url_required')
    query = urllib.parse.parse_qs(p.query)
    if set(query) - {'modelVersionId', 'fileId'} or any(len(v) != 1 for v in query.values()):
        raise Fault(422, 'unsupported_url_query_no_tokens_allowed')
    match = re.fullmatch(r'/api/download/models/([1-9][0-9]*)/?', p.path)
    if match:
        return None, int(match[1]), query.get('fileId', [None])[0]
    match = re.fullmatch(r'/models/([1-9][0-9]*)(?:/[^/]*)?/?', p.path)
    version = query.get('modelVersionId', [None])[0]
    if not match or version is not None and not re.fullmatch(r'[1-9][0-9]*', version):
        raise Fault(422, 'civitai_model_or_version_url_required')
    return int(match[1]), int(version) if version else None, query.get('fileId', [None])[0]


def resolve(url, key):
    mid, vid, fid = parse_url(url)
    meta = cloud('GET', '/assets/remote-metadata?' + urllib.parse.urlencode({'url': url}), key)
    if meta.get('validation', {}).get('is_valid') is False or 'loras' not in meta.get('tags', []) or not meta.get('filename', '').lower().endswith('.safetensors'):
        raise Fault(422, 'cloud_preflight_requires_safetensors_lora')
    if type(meta.get('content_length')) not in (int, float) or not 0 < meta['content_length'] <= 2 * 1024**3:
        raise Fault(422, 'cloud_import_invalid_or_over_2GiB')
    return {'model_id': mid, 'version_id': vid or -mid, 'file_id': int(fid) if fid else 0,
            'name': meta.get('name', ''), 'filename': meta['filename'],
            'source_url': url, 'download_url': url, 'base_model': 'pending_import_verification',
            'sha256': None, 'blake3': None, 'trigger_words': [], 'trigger_words_state': 'not_provided_by_cloud',
            'version_pinned': vid is not None, 'content_length': meta['content_length']}



def schema(db):
    db.execute('CREATE TABLE IF NOT EXISTS loras(owner TEXT,id TEXT,version INTEGER,file INTEGER,info TEXT,task TEXT,asset TEXT,state TEXT,created REAL,PRIMARY KEY(owner,id),UNIQUE(owner,version,file))')


def find(owner, lid):
    identifier(lid)
    with connection() as db:
        schema(db)
        r = db.execute('SELECT info,task,asset,state FROM loras WHERE owner=? AND id=?', (owner, lid)).fetchone()
    if not r:
        raise Fault(404, 'lora_not_found_in_current_owner_scope')
    return {'id': lid, **json.loads(r[0]), 'task_id': r[1], 'asset_id': r[2], 'state': r[3]}


def set_state(owner, lid, state, task=None, asset=None):
    with connection() as db:
        schema(db)
        db.execute('UPDATE loras SET state=?,task=COALESCE(?,task),asset=COALESCE(?,asset) WHERE owner=? AND id=?',
                   (state, task, asset, owner, lid))


def start(owner, lid, url, key):
    identifier(lid)
    info = resolve(url, key)
    with LOCK, connection() as db:
        schema(db)
        db.execute('BEGIN IMMEDIATE')
        existing = db.execute('SELECT id,version,file FROM loras WHERE owner=? AND (id=? OR (version=? AND file=?))',
            (owner, lid, info['version_id'], info['file_id'])).fetchone()
        if existing:
            if existing[0] == lid and (existing[1], existing[2]) != (info['version_id'], info['file_id']):
                raise Fault(409, 'lora_id_bound_to_other_version')
            selected = existing[0]
        else:
            selected = None
            db.execute('INSERT INTO loras VALUES(?,?,?,?,?,?,?,?,?)',
                (owner, lid, info['version_id'], info['file_id'], json.dumps(info), None, None, 'import_unknown', time.time()))
    if selected:
        return find(owner, selected) | {'reimported': False}
    # Durable claim precedes external POST. Unknown effect is never automatically repeated.
    result = cloud('POST', '/assets/download', key, {'source_url': info['download_url'],
        'tags': ['models', 'loras'], 'user_metadata': {'source': 'civitai', 'model_type': 'loras', 'source_url': info['download_url']}})
    if result.get('task_id'):
        set_state(owner, lid, 'importing', str(result['task_id']))
    elif result.get('id'):
        set_state(owner, lid, 'importing', asset=identifier(result['id']))
    else:
        raise Fault(502, 'cloud_import_response_unconfirmed_query_original_id')
    return observe(owner, lid, key)


def observe(owner, lid, key):
    item = find(owner, lid)
    if item['state'] == 'failed' or item['state'] == 'ready' and item.get('loader_path'):
        return item
    aid = item['asset_id']
    if not aid and item['task_id']:
        task = cloud('GET', '/tasks/' + urllib.parse.quote(item['task_id'], safe=''), key)
        if task.get('status') in ('failed', 'cancelled'):
            set_state(owner, lid, 'failed')
            return find(owner, lid)
        result = task.get('result') or {}
        aid = result.get('asset_id')
        if not aid:
            return item
    if aid:
        asset = cloud('GET', '/assets/' + identifier(aid), key)
        if 'loras' not in asset.get('tags', []) and asset.get('user_metadata', {}).get('model_type') != 'loras':
            raise Fault(422, 'imported_asset_is_not_tagged_as_lora')
        metadata = asset.get('metadata', {})
        if str(metadata.get('base_model', '')).lower().replace(' ', '') not in ('krea2', 'krea2turbo', 'krea2raw'):
            set_state(owner, lid, 'failed')
            raise Fault(422, 'imported_lora_base_must_be_krea2')
        arn = re.fullmatch(r'civitai:model:([0-9]+):version:([0-9]+):file:([0-9]+)', metadata.get('source_arn', ''))
        if not arn:
            raise Fault(422, 'imported_civitai_version_provenance_required')
        mid, vid, fid = map(int, arn.groups())
        if (item.get('model_id') and item['model_id'] != mid) or (item['version_id'] > 0 and item['version_id'] != vid) or (item['file_id'] and item['file_id'] != fid):
            set_state(owner, lid, 'failed')
            raise Fault(422, 'imported_civitai_version_mismatch')
        hashes = [asset.get('hash'), asset.get('sha256'), asset.get('hashes', {}).get('sha256')]
        supplied = [str(h).lower().removeprefix('sha256:') for h in hashes if h and (str(h).startswith('sha256:') or len(str(h)) == 64)]
        if supplied and item.get('sha256') and item['sha256'] not in supplied:
            set_state(owner, lid, 'failed')
            raise Fault(422, 'imported_model_hash_mismatch')
        content_hash = str(asset.get('hash', '')).lower().removeprefix('blake3:').removesuffix('.safetensors')
        if item.get('blake3') and content_hash and content_hash != item['blake3']:
            set_state(owner, lid, 'failed')
            raise Fault(422, 'imported_model_blake3_mismatch')
        info = {k: v for k, v in item.items() if k not in ('id', 'task_id', 'asset_id', 'state')}
        loader_path = asset.get('loader_path')
        if not isinstance(loader_path, str) or not loader_path.endswith('.safetensors') or '..' in loader_path.split('/'):
            raise Fault(422, 'verified_cloud_loader_path_required')
        info.update(loader_path=loader_path, model_id=mid, version_id=vid, file_id=fid, base_model=metadata['base_model'],
                    version_pinned=True, cloud_content_hash=asset.get('hash'),
                    source_url='https://civitai.com/models/' + str(mid) + '?modelVersionId=' + str(vid))
        with connection() as db:
            db.execute('UPDATE loras SET info=? WHERE owner=? AND id=?', (json.dumps(info), owner, lid))
        set_state(owner, lid, 'ready', asset=identifier(aid))
    return find(owner, lid)


def list_owned(owner):
    with connection() as db:
        schema(db)
        ids = [r[0] for r in db.execute('SELECT id FROM loras WHERE owner=? ORDER BY created DESC LIMIT 200', (owner,))]
    return [find(owner, lid) for lid in ids]


def install(router, owner, action, configured_key, call):
    from fastapi import Request

    @router.post('/loras/resolve')
    def resolve_route(body: dict):
        action(owner)
        return action(resolve, body.get('url'), action(configured_key, call))

    @router.post('/loras/import')
    def import_route(body: dict, request: Request):
        who = action(owner)
        return action(start, who, request.headers.get('Idempotency-Key', ''), body.get('url'), action(configured_key, call))

    @router.get('/loras')
    def list_route():
        return {'loras': action(list_owned, action(owner))}

    @router.get('/loras/{lid}')
    def observe_route(lid: str):
        return action(observe, action(owner), lid, action(configured_key, call))
