"""Unified member MCP domain. No GPU rental, no direct hub to Civitai traffic."""
import asyncio
import base64
import hashlib
import inspect
import contextvars
import threading
import visual_queue as vq
import json
import math
import os
from pathlib import Path
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from tools_krea2_cloud import Fault, connection, LOCK, identifier
from visual_routing_policy import choose_route

CONTRACT = json.loads(Path(__file__).with_name('visual-contract.json').read_text())

def validate(name, args):
    spec = next((t['inputSchema'] for t in CONTRACT if t['name'] == name), None)
    if not spec or not isinstance(args, dict) or set(args)-set(spec['properties']) or set(spec['required'])-set(args):
        raise Fault(422, 'unknown_tool_or_invalid_arguments')
    for k,v in args.items():
        s=spec['properties'][k]; typ=s.get('type')
        if typ=='string' and not isinstance(v,str) or typ=='integer' and type(v) is not int or typ=='number' and (type(v) not in (int,float) or not math.isfinite(v)) or typ=='boolean' and type(v) is not bool or typ=='object' and not isinstance(v,dict):
            raise Fault(422,'invalid_argument_type_'+k)
        if 'enum' in s and v not in s['enum']: raise Fault(422,'invalid_argument_'+k)
        if typ in ('integer','number') and (v<s.get('minimum',-float('inf')) or v>s.get('maximum',float('inf')) or 'multipleOf' in s and v%s['multipleOf']): raise Fault(422,'invalid_argument_range_'+k)
        if typ=='string' and not s.get('minLength',0)<=len(v)<=s.get('maxLength',20000): raise Fault(422,'invalid_argument_length_'+k)
        if s.get('format')=='uuid': identifier(v)

def schema(db):
    db.execute('CREATE TABLE IF NOT EXISTS visual_jobs(owner TEXT,id TEXT,digest TEXT,provider TEXT,created REAL,PRIMARY KEY(owner,id))')

def job(owner,jid):
    jid=identifier(jid)
    with connection() as db:
        schema(db); r=db.execute('SELECT digest,provider FROM visual_jobs WHERE owner=? AND id=? COLLATE NOCASE',(owner,jid)).fetchone()
    return r

def pin(owner,jid,digest,provider):
    jid=identifier(jid)
    with LOCK,connection() as db:
        schema(db); db.execute('BEGIN IMMEDIATE')
        r=db.execute('SELECT digest,provider FROM visual_jobs WHERE owner=? AND id=? COLLATE NOCASE',(owner,jid)).fetchone()
        if r:
            if r[0]!=digest:raise Fault(409,'idempotency_key_bound_to_other_request')
            return r[1],False
        db.execute('INSERT INTO visual_jobs VALUES(?,?,?,?,?)',(owner,jid,digest,provider,time.time()))
    return provider,True

def config():
    # Controlled service config, never a caller supplied URL or bearer.
    p=Path(os.environ.get('VISUAL_AUTODL_CONFIG','/srv/workspace'))
    if not p.exists():return None
    c=json.loads(p.read_text());u=urlsplit(c.get('origin',''))
    if u.scheme!='http' or u.hostname!='127.0.0.1' or u.username or u.password or u.path not in ('','/') or u.query or u.fragment:
        raise Fault(503,'autodl_connector_must_be_loopback_tunnel')
    return c

def worker(c,actor,path,body=None,timeout=15):
    if not c or actor not in c.get('authorized_actors',[]):raise Fault(503,'autodl_worker_not_available_to_caller')
    req=urllib.request.Request(c['origin'].rstrip('/')+path,method='GET' if body is None else 'POST',data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=timeout) as r:return json.load(r)
    except urllib.error.HTTPError as e:
        if body is not None and path=='/jobs' and e.code==409:
            try:proof=json.loads(e.read(1024))
            except Exception:proof={}
            if proof.get('error')=='worker_not_submitted' and proof.get('submitted') is False:
                raise Fault(409,'autodl_definitely_not_submitted')
        raise Fault(503,'autodl_worker_observation_unknown')
    except (OSError,ValueError):raise Fault(503,'autodl_worker_observation_unknown')

def snapshot(actor,lid=None,timeout=15):
    c=config()
    if not c or actor not in c.get('authorized_actors',[]):return {'state':'not_connected','ready':False},c
    try:h=worker(c,actor,'/health',timeout=timeout)
    except Fault:return {'state':'unreachable','ready':False},c
    now=time.time()
    gates={'running':h.get('worker_id')==c.get('worker_id'), 'health_ok':type(h.get('observed_at')) in (int,float) and abs(now-h['observed_at'])<30,
        'lease_authorized':c.get('lease_authorized') is True,'within_active_window':c.get('starts_at',float('inf'))<=now<c.get('ends_at',0)-c.get('drain_seconds',300),
        'shutdown_protected':c.get('shutdown_verified_until',0)>=c.get('ends_at',float('inf')),
        'workflow_compatible':h.get('contract')=='krea2_turbo_shared_v1','model_ready':h.get('model_ready') is True,
        'lora_ready':not lid or lid in h.get('ready_loras',[]),'capacity_available':h.get('idle') is True}
    return {'state':'connected','ready':all(gates.values()),'gates':gates,'worker_id':h.get('worker_id'),'lease_ends_at':c.get('ends_at')},c

def image_body(a):
    b={k:v for k,v in a.items() if k not in ('demand','idempotency_key')}
    # Common denominator must be explicit, never silently round or truncate.
    if '\n' in b['prompt'] or '\r' in b['prompt'] or '--' in b['prompt'] or b['prompt'].startswith('-'):raise Fault(422,'shared_prompt_must_be_plain_single_line')
    # MCP JSON transports normalize 60.0 to 60; the legacy Python API hashes representations.
    for field in ('estimated_credits','budget_credits','lora_strength'):
        if field in b:b[field]=float(b[field])
    return b

def install():
    from fastapi import Request,HTTPException
    from starlette.requests import Request as NativeRequest
    from web.server import app
    from caller_context import CURRENT_CALLER
    from tools_mcp_bridge import call
    active = set()
    active_lock = threading.Lock()

    def resume(owner,jid,actor):
        key=(owner,jid)
        with active_lock:
            if key in active:return
            active.add(key)
        ctx=contextvars.copy_context()
        def run():
            try:
                while True:
                    row=vq.get(owner,jid)
                    if not row or row['state']!='waiting':return
                    # Generation is Cloud-only, including never-submitted legacy waiting jobs.
                    provider=vq.claim(owner,jid)
                    if not provider:return
                    c=None
                    try:
                        b=row['request']
                        output=(invoke('/api/h3-cloud/krea2/jobs','POST',b,jid)
                            if provider=='comfy_cloud' else worker(c,actor,'/jobs',{'id':jid,'request':b,'start_before':row['deadline']}))
                        vq.result(owner,jid,output)
                    except Fault as e:
                        if provider=='autodl' and e.code=='autodl_definitely_not_submitted':
                            vq.unclaim(owner,jid)
                            time.sleep(.5)
                            continue
                        vq.result(owner,jid,error='supplier_effect_or_observation_unknown_query_original_job')
                    except Exception:
                        vq.result(owner,jid,error='supplier_effect_or_observation_unknown_query_original_job')
                    return
            finally:
                with active_lock:active.discard(key)
        threading.Thread(target=lambda:ctx.run(run),daemon=True,name='visual-queue').start()

    def observe(owner,jid,actor):
        row=vq.get(owner,jid)
        if not row:return None
        if row['state']=='waiting':
            resume(owner,jid,actor)
            return vq.public(vq.get(owner,jid))
        # Once provider is reserved, status is always read from that provider.
        try:
            out=(invoke('/api/h3-cloud/krea2/jobs/{local_id}',params={'local_id':jid})
                if row['provider']=='comfy_cloud' else worker(config(),actor,'/jobs/'+jid))
            if row['provider']=='autodl' and out.get('state') in ('succeeded','failed','cancelled'):
                vq.release(owner,jid)
            return vq.public(row)|{'job':out}
        except Exception:
            return vq.public(row)

    def invoke(path,method='GET',args=None,idem=None,params=None):
        def routes(items):
            for r in items:
                nested=getattr(r,'original_router',None)
                if nested is not None:yield from routes(nested.routes)
                else:yield r
        route=next((r for r in routes(app.routes) if getattr(r,'path',None)==path and method in (getattr(r,'methods',None) or [])),None)
        if not route:raise Fault(503,'domain_route_not_installed')
        kwargs=dict(params or {})
        sig=inspect.signature(route.endpoint)
        if 'body' in sig.parameters:kwargs['body']=args or {}
        if 'request' in sig.parameters:kwargs['request']=NativeRequest({'type':'http','headers':[(b'idempotency-key',(idem or '').encode())]})
        return route.endpoint(**kwargs)

    @app.post('/api/h3-cloud/mcp/{name}')
    def dispatch(name:str,body:dict):
        try:
            validate(name,body)
            body=dict(body)
            for field in ('idempotency_key','id','asset_id','lora_id'):
                if field in body:body[field]=identifier(body[field])
            caller=CURRENT_CALLER.get();actor=caller['legacy_subject'];owner=hashlib.sha256(actor.encode()).hexdigest()
            k='/api/h3-cloud/krea2';v='/api/h3-cloud'
            if name=='visual.capabilities':
                s={'state':'training_only','ready':False}
                return {'state':'ready','contract':'krea2_turbo_shared_v1','image':{'model':'Krea2 Turbo FP8','steps':8,'cfg':1,'sampler':'euler','scheduler':'simple','width_height_multiple':16,'max_pixels':2097152,'seed_max':2**32-1,'single_lora':True,'reference_images_supported':False},'routing':{'batch_images':'comfy_cloud_only','sporadic_images':'comfy_cloud_only','video_reference_images':'comfy_cloud_only','max_autodl_wait_seconds':0,'video':'comfy_cloud_only','training':'autodl_only','queue_restart':'authenticated_job_get_resumes_waiting;claimed_jobs_observe_only'},'autodl':s,'training_execution':'not_exposed_until_gpu_and_dataset_validation','cloud_credential':'caller_authorized_configuration_checked_on_effect','tools':[t['name'] for t in CONTRACT],'result_loop':{'discover':{'tool':'hub.tools','arguments':{'group':'gallery'}},'flow':['gallery.recipe.save','gallery.generation.create','gallery.generation.sync','gallery.feedback.add','gallery.provenance.get'],'feedback_source':'caller_declared;AI_observation_is_not_human_quote'}}
            if name in ('visual.image.preview','visual.image.generate'):
                b=image_body(body);preview=invoke(k+'/preview','POST',b)
                s,c={'state':'training_only','ready':False},None
                route=choose_route('image',body.get('demand','sporadic'),s.get('gates',{}))
                provider=route['provider']
                if name.endswith('preview'):return preview|{'route':route,'autodl':s,'submitted':False}
                if b.get('generation_authorized') is not True or any(type(b.get(t)) not in (int,float) or not math.isfinite(b[t]) or b[t]<=0 for t in ('estimated_credits','budget_credits')) or b['estimated_credits']>b['budget_credits']:raise Fault(422,'generation_authorization_and_positive_estimate_within_budget_required')
                jid=body['idempotency_key'];digest=hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest()
                provider,fresh=pin(owner,jid,digest,'pending')
                if vq.get(owner,jid):return observe(owner,jid,actor)
                if fresh or provider=='pending':
                    vq.enqueue(owner,jid,actor,b)
                    resume(owner,jid,actor)
                    return vq.public(vq.get(owner,jid))
                queued=observe(owner,jid,actor)
                if queued:return queued
                result=invoke(k+'/jobs/{local_id}',params={'local_id':jid}) if provider=='comfy_cloud' else worker(c,actor,'/jobs/'+jid)
                return {'id':jid,'provider':provider,'resubmitted':False,'job':result}
            if name.startswith('visual.lora.'):
                op=name.rsplit('.',1)[1]
                if op=='import' and body.get('target')=='autodl':raise Fault(409,'autodl_reserved_for_lora_training')
                if op=='resolve':return invoke(k+'/loras/resolve','POST',body)
                if op in ('list','get'):
                    data=invoke(k+'/loras') if op=='list' else invoke(k+'/loras/{lid}',params={'lid':body['id']})
                    items=data['loras'] if op=='list' else [data]
                    for item in items:
                        item['bindings']={'comfy_cloud':{'state':item['state'],'asset_id':item.get('asset_id'),'content_hash':item.get('cloud_content_hash')}}
                        item['bindings']['autodl']={'state':'training_only_not_image_backend'}
                    return data
                item=invoke(k+'/loras/import','POST',{'url':body['url']},body['idempotency_key'])
                if body.get('target','comfy_cloud')=='autodl':
                    if item.get('state')!='ready':return {'lora':item,'autodl':{'state':'waiting_for_pinned_cloud_metadata'}}
                    s,c=snapshot(actor)
                    if not s.get('ready'):raise Fault(503,'autodl_not_ready_cloud_import_preserved_query_same_id')
                    binding=worker(c,actor,'/loras/import',{'id':item['id'],'model_id':item['model_id'],'version_id':item['version_id'],'file_id':item['file_id']})
                    return {'lora':item,'autodl':binding}
                return item
            if name=='visual.job.get':
                jid=body['id'];r=job(owner,jid) if body['kind']=='image' else None
                if body['kind']=='training':return {'state':'not_submitted','reason':'training_execution_not_exposed'}
                queued=observe(owner,jid,actor) if body['kind']=='image' else None
                if queued:return queued
                if r and r[1]=='autodl':return {'provider':'autodl','job':worker(config(),actor,'/jobs/'+jid)}
                return {'provider':'comfy_cloud','job':invoke((k if body['kind']=='image' else v)+'/jobs/{local_id}',params={'local_id':jid})}
            if name=='visual.output.get':
                jid=body['id'];aid=body['asset_id'];r=job(owner,jid) if body['kind']=='image' else None
                if r and r[1]=='pending':raise Fault(409,'image_still_waiting_in_central_queue')
                if r and r[1]=='autodl':return worker(config(),actor,'/jobs/'+jid+'/outputs/'+identifier(aid))
                identifier(jid);identifier(aid)
                if body['kind']=='video':
                    # Ownership and output membership checked before returning an authenticated route.
                    result=invoke(v+'/jobs/{local_id}',params={'local_id':jid})
                    if not any(o.get('id')==aid for o in result.get('supplier',{}).get('outputs',[])):raise Fault(404,'output_not_in_current_job')
                    return {'url':'https://hufu.example.invalid/'+v+'/jobs/'+jid+'/outputs/'+aid,'authorization':'current_hufu_bearer_required'}
                response=invoke(k+'/jobs/{local_id}/outputs/{asset_id}',params={'local_id':jid,'asset_id':aid})
                async def collect():
                    data=bytearray()
                    async for block in response.body_iterator:
                        data.extend(block)
                        if len(data)>8*1024*1024:raise Fault(413,'mcp_image_exceeds_8MiB_use_authenticated_api')
                    return bytes(data)
                data=asyncio.run(collect())
                if data.startswith(b'\x89PNG\r\n\x1a\n'):mime='image/png'
                elif data.startswith(b'\xff\xd8'):mime='image/jpeg'
                elif data.startswith(b'RIFF') and data[8:12]==b'WEBP':mime='image/webp'
                else:raise Fault(422,'output_is_not_supported_image')
                return {'id':jid,'asset_id':aid,'mime_type':mime,'sha256':hashlib.sha256(data).hexdigest(),'image_base64':base64.b64encode(data).decode()}
            if name=='visual.video.capabilities':return invoke(v+'/capabilities')
            if name=='visual.video.preview':return invoke(v+'/preview','POST',body['request'])
            if name=='visual.video.generate':return invoke(v+'/jobs','POST',body['request'],body['idempotency_key'])
            if name=='visual.training.plan':return {'state':'plan_only','provider':'autodl','backend':'musubi-tuner','base_model':'Krea2 RAW','request':body,'submitted':False,'reason':'worker_gpu_dataset_and_lease_validation_required_before_training','local_entry':'deploy/autodl-krea2/krea2ctl.py','requires':['authorized_active_gpu_window','validated_local_dataset','RAW_model_weights','GPU_lock','output_candidate_validation']}
            raise Fault(404,'unknown_visual_tool')
        except Fault as e:raise HTTPException(e.status,{'code':e.code})

    # Shared execution contract for the existing gallery HTTP orchestrator.
    # Existing galleries keep recipe/publication ownership; this layer only executes jobs.
    def compat_body(body):
        b=dict(body)
        if b.pop('profile','turbo')!='turbo':raise HTTPException(422,'only_turbo_supported')
        return b

    @app.get('/api/h3-cloud/unified/krea2/capabilities')
    def compat_capabilities():
        data=dispatch('visual.capabilities',{})
        return {'provider':'unified-visual','workflow':'krea2_turbo_fp8','steps':8,'dimension_min':512,'dimension_max':2048,'dimensions_multiple_of':16,'max_pixels':2097152,'seed_max':2**32-1,'batch_size':1,'reference_images_supported':False,'lora_import':'civitai','routing':data['routing'],'autodl':data['autodl']}

    @app.post('/api/h3-cloud/unified/krea2/preview')
    def compat_preview(body:dict):return dispatch('visual.image.preview',compat_body(body))

    @app.post('/api/h3-cloud/unified/krea2/jobs')
    def compat_submit(body:dict,request:Request):
        data=dispatch('visual.image.generate',compat_body(body)|{'idempotency_key':request.headers.get('Idempotency-Key','')})
        job=data['job'];supplier=job.get('supplier',{})
        return job|{'id':data['id'],'provider':data['provider'],'state':supplier.get('status',job.get('state','submission_unknown')),'provider_job_id':supplier.get('id',job.get('provider_job_id'))}

    @app.get('/api/h3-cloud/unified/krea2/jobs/{local_id}')
    def compat_status(local_id:str):
        data=dispatch('visual.job.get',{'kind':'image','id':local_id});job=data['job']
        if data['provider']=='autodl':
            job={'id':local_id,'supplier':{'status':job.get('state'),'outputs':[o|{'content_type':'image/png'} for o in job.get('outputs',[])]}}
        return job|{'provider':data['provider']}

    @app.get('/api/h3-cloud/unified/krea2/jobs/{local_id}/outputs/{asset_id}')
    def compat_output(local_id:str,asset_id:str):
        from fastapi.responses import Response
        data=dispatch('visual.output.get',{'kind':'image','id':local_id,'asset_id':asset_id})
        return Response(base64.b64decode(data['image_base64']),media_type=data['mime_type'])
