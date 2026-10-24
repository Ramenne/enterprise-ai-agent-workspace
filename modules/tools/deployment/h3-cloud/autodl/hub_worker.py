#!/usr/bin/env python3
"""Private AutoDL bridge. Bind loopback only; expose to hub using an authorized SSH tunnel.
Does not rent/start/extend a GPU. Shares krea2ctl's GPU lock and approved LoRA registry.
"""
import argparse,base64,fcntl,hashlib,json,os,re,threading,time,urllib.request,uuid
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
import krea2ctl as ctl
from comfy_local import api

ROOT=Path(os.environ.get('KREA_ROOT','/root/autodl-tmp/krea2'))
WORKER=os.environ.get('KREA_WORKER_ID','autodl-krea2')
END=float(os.environ.get('KREA_LEASE_ENDS_AT','0'))
PROFILE=os.environ.get('KREA_PROFILE','rtx5090')
MUTEX=threading.Lock()
VERIFIED_FILES=None

def verify_models_cached():
    global VERIFIED_FILES
    paths=[ROOT/'models/comfy'/r['file'] for r in json.loads((ctl.BUNDLE/'research/comfy-models-lock.json').read_text())]
    stamp=tuple((str(p),p.stat().st_size,p.stat().st_mtime_ns) for p in paths)
    if stamp!=VERIFIED_FILES:ctl.verify_comfy_models(ROOT);VERIFIED_FILES=stamp

def uid(s):return str(uuid.UUID(s))
def save(p,d):ctl.save_json(p,d)
def ledger(j):return ROOT/'hub-jobs'/uid(j)
def request_digest(d):return hashlib.sha256(json.dumps(d,sort_keys=True).encode()).hexdigest()
def active():
    if time.time()>=END-300:raise ValueError('lease_absent_or_draining')
def health():
    ready=False;idle=False;loras=[]
    try:
        q=api('/queue');nodes=api('/object_info')
        checks=[('UNETLoader','unet_name','krea2_turbo_fp8_scaled.safetensors'),('CLIPLoader','clip_name','qwen3vl_4b_fp8_scaled.safetensors'),('VAELoader','vae_name','qwen_image_vae.safetensors')]
        ready=all(name in nodes[cl]['input']['required'][field][0] for cl,field,name in checks) and 'LoraLoaderModelOnly' in nodes
        verify_models_cached()
        idle=not q.get('queue_running') and not q.get('queue_pending')
        with (ROOT/'.gpu-job.lock').open('a') as lock:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if idle:
            for p in (ROOT/'loras').glob('*/manifest.json'):
                m=json.loads(p.read_text());weight=p.parent/'weights.safetensors'
                if m.get('status')=='approved' and weight.exists() and ctl.digest(weight)==m.get('weights_sha256'):loras.append(p.parent.name)
    except Exception:idle=False
    return {'worker_id':WORKER,'contract':'krea2_turbo_shared_v1','observed_at':time.time(),'model_ready':ready,'idle':idle and time.time()<END-300,'ready_loras':loras,'lease_ends_at':END}

def import_lora(d):
    lid=uid(d['id']);p=ROOT/'loras'/lid;p.mkdir(parents=True,exist_ok=True)
    marker=p/'hub-import.json'
    with MUTEX:
        if marker.exists():
            old=json.loads(marker.read_text())
            if old['digest']!=request_digest(d):raise ValueError('id_bound_to_other_lora')
            return old
        state={'id':lid,'state':'importing','digest':request_digest(d)};save(marker,state)
    def run():
        try:
            active();vid=int(d['version_id']);fid=int(d['file_id']);mid=int(d['model_id'])
            if min(vid,fid,mid)<=0:raise ValueError('pinned_version_required')
            with urllib.request.urlopen('https://civitai.com/api/v1/model-versions/'+str(vid),timeout=30) as r:meta=json.load(r)
            if meta.get('modelId')!=mid or str(meta.get('baseModel','')).lower().replace(' ','') not in ('krea2','krea2turbo','krea2raw') or str(meta.get('model',{}).get('type','')).lower()!='lora':raise ValueError('incompatible_base_or_type')
            file=next(x for x in meta['files'] if x['id']==fid)
            expected=file.get('hashes',{}).get('SHA256','').lower()
            if not re.fullmatch('[a-f0-9]{64}',expected) or not file['name'].lower().endswith('.safetensors'):raise ValueError('sha256_safetensors_required')
            # Civitai handles CDN redirects; no member bearer or provider key is attached.
            url='https://civitai.com/api/download/models/'+str(vid)+'?fileId='+str(fid)
            tmp=p/'weights.download';h=hashlib.sha256();size=0
            with urllib.request.urlopen(url,timeout=60) as src,tmp.open('wb') as out:
                if not src.geturl().startswith('https://'):raise ValueError('https_download_required')
                while True:
                    b=src.read(1024*1024)
                    if not b:break
                    size+=len(b)
                    if size>2*1024**3:raise ValueError('model_exceeds_2GiB')
                    h.update(b);out.write(b)
            if h.hexdigest()!=expected:raise ValueError('sha256_mismatch')
            # Validate safetensors header without executing weights or pickle.
            with tmp.open('rb') as f:
                n=int.from_bytes(f.read(8),'little')
                if not 2<=n<=min(size-8,100*1024**2):raise ValueError('invalid_safetensors_header')
                header=json.loads(f.read(n))
                if not isinstance(header,dict):raise ValueError('invalid_safetensors')
            tmp.replace(p/'weights.safetensors')
            manifest={'status':'approved','base_inference':'krea/Krea-2-Turbo','weights_sha256':expected,'source':'civitai','model_id':mid,'version_id':vid,'file_id':fid,'approval_basis':'provider_base_metadata_and_verified_safetensors_hash;gpu_behavior_pending','trained_words':meta.get('trainedWords',[])}
            save(p/'manifest.json',manifest)
            state.update(state='ready',sha256=expected,loader_path=lid+'/weights.safetensors',gpu_loading_verified=False)
        except Exception:state.update(state='failed',error='worker_import_failed_inspect_private_worker')
        save(marker,state)
    threading.Thread(target=run,daemon=True).start();return state

def submit(d):
    active();jid=uid(d['id']);b=d['request'];job=ledger(jid);marker=job/'state.json'
    req={'operation':'generate','request_id':'hub-'+jid,'profile':PROFILE,'prompt':b['prompt'],'width':b.get('width',1024),'height':b.get('height',1024),'seed':b.get('seed',42424242),'loras':[{'id':uid(b['lora_id']),'strength':b.get('lora_strength',1)}] if b.get('lora_id') else []}
    ctl.validate_request(req);prepared=ctl.plan(ROOT,req)
    with MUTEX:
        if marker.exists():
            old=json.loads(marker.read_text())
            if old['digest']!=request_digest(d):raise ValueError('id_bound_to_other_request')
            return old
        if not health()['idle']:raise ValueError('worker_busy_or_not_ready')
        job.mkdir(parents=True)
        state={'id':jid,'digest':request_digest(d),'state':'submission_unknown','provider':'autodl'};save(marker,state)
    def run():
        try:
            ctl.execute(ROOT,req,prepared)
            files=sorted((Path(prepared['job_dir'])/'outputs').glob('*.png'))
            outputs=[{'id':str(uuid.uuid5(uuid.UUID(jid),str(i))),'name':p.name,'size_bytes':p.stat().st_size,'sha256':ctl.digest(p)} for i,p in enumerate(files)]
            state.update(state='succeeded',outputs=outputs)
        except Exception:state.update(state='failed_or_submission_unknown',resubmit_allowed=False)
        save(marker,state)
    threading.Thread(target=run,daemon=True).start();return state

def get_job(j):return json.loads((ledger(j)/'state.json').read_text())
def output(j,aid):
    st=get_job(j);a=next(x for x in st.get('outputs',[]) if x['id']==uid(aid));p=ROOT/'jobs'/('hub-'+uid(j))/'outputs'/a['name']
    data=p.read_bytes()
    if len(data)>8*1024**2:raise ValueError('image_exceeds_mcp_limit')
    return {'id':j,'asset_id':aid,'mime_type':'image/png','sha256':hashlib.sha256(data).hexdigest(),'image_base64':base64.b64encode(data).decode()}

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*a):pass
    def handle_request(self):
        try:
            path=self.path.split('/')
            if self.command=='GET':
                if self.path=='/health':data=health()
                elif len(path)==3 and path[1]=='loras':data=json.loads((ROOT/'loras'/uid(path[2])/'hub-import.json').read_text())
                elif len(path)==3 and path[1]=='jobs':data=get_job(path[2])
                elif len(path)==5 and path[1]=='jobs' and path[3]=='outputs':data=output(path[2],path[4])
                else:raise ValueError('unknown_route')
            else:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=100000:raise ValueError('invalid_body')
                body=json.loads(self.rfile.read(size))
                if self.path=='/jobs':data=submit(body)
                elif self.path=='/loras/import':data=import_lora(body)
                else:raise ValueError('unknown_route')
            code=200
        except Exception:data={'error':'worker_request_rejected_or_observation_unknown'};code=409
        raw=json.dumps(data).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    do_GET=handle_request;do_POST=handle_request

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8192);args=p.parse_args()
    ROOT.mkdir(parents=True,exist_ok=True);ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
