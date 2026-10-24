#!/usr/bin/env python3
"""New nonroot forced-command endpoint; original2.0 pinned FS/effect SQLite engine.
The relay sends only bearer+typed request; never accepts a client-made permit.
"""
import os,json,sys,pathlib,stat,hashlib,urllib.request,ssl,time,subprocess
from fs_executor_original20 import Executor,Rejected,canonical,sha

def controlled(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd) as f:
  s=os.fstat(f.fileno());assert stat.S_ISREG(s.st_mode) and s.st_uid in(0,os.geteuid()) and not s.st_mode&0o022
  return json.load(f)
def execute(config,call,authority=None):
 assert set(call)=={'bearer','request'} and isinstance(call['bearer'],str)
 r=call['request'];assert set(r)<=set(['project_id','region_id','area_id','target_id','operation','action','parameters','idempotency_key'])
 t=next(x for x in config['targets'] if x['id']==r['target_id']);assert t['enabled'] is True and t['project_id']==r['project_id'] and t['area_id']==r['area_id'] and t['region_id']==r['region_id'] and r['action'] in t['actions']
 action={'ssh.file.read':'read','ssh.file.write':'write','ssh.artifact.deploy':'deploy','ssh.service.status':'read'};assert r['action'] in action and r['operation']==action[r['action']]
 if r['action']=='ssh.service.status':
  assert set(r['parameters'])=={'service'} and r['parameters']['service'] in t['services']
  digest=sha(canonical(r));p=authority(call['bearer'],{**r,'request_hash':digest,'phase':'effect'}) if authority else online(config,call['bearer'],{**r,'request_hash':digest,'phase':'effect'})
  assert p['target_fingerprint']==t['fingerprint'] and p['adapter_action']==r['action'] and p['request_hash']==digest and p['target_epoch']==t['epoch'] and p['region_epoch']==t['region_epoch']
  x=subprocess.run(['/usr/bin/systemctl','show',r['parameters']['service'],'-p','ActiveState','-p','SubState','-p','MainPID'],capture_output=True,text=True,timeout=5,check=True)
  return {'format':'resource-execution-receipt.v2','state':'read','operation_id':sha(canonical([p['actor_id'],p['client_id'],r['idempotency_key']])),'request_hash':digest,'target_fingerprint':t['fingerprint'],'result':dict(line.split('=',1) for line in x.stdout.splitlines() if '=' in line)}
 params=r['parameters'];assert set(params)<=set(['path','data_b64','sha256','expected_sha256','create_parents'])
 converted={'project_id':r['project_id'],'area_id':r['area_id'],'operation':r['operation'],'idempotency_key':r['idempotency_key'],'environment':t['environment'],**params};digest=sha(canonical(r))
 first_identity={}
 def check(bearer,request,unused_digest,phase):
  p=authority(bearer,{**r,'request_hash':digest,'phase':phase}) if authority else online(config,bearer,{**r,'request_hash':digest,'phase':phase})
  assert p['format']=='resource-execution-permit.v2' and p['request_hash']==digest and p['target_fingerprint']==t['fingerprint'] and p['target_epoch']==t['epoch'] and p['region_epoch']==t['region_epoch'] and p['region_id']==t['region_id'] and p['adapter_action']==r['action']
  assert p['project_id']==r['project_id'] and p['area_id']==r['area_id'] and p['target_id']==r['target_id']
  for key in ['actor_id','client_id','credential_id','security_era','principal_epoch','client_epoch','credential_epoch']:
   assert key in p
   if first_identity:assert p[key]==first_identity[key]
  if not first_identity:first_identity.update(p)
  return {**p,'action':'resource.'+r['operation'],'area_epoch':t['area_epoch'],'environment':t['environment'],'target_epoch':t['epoch'],'endpoint_epoch':t['endpoint_epoch'],'root_fingerprint':t['root_fingerprint']}
 area={'id':t['area_id'],'project_id':t['project_id'],'root':t['root'],'epoch':t['area_epoch'],'environment':t['environment'],'target_epoch':t['epoch'],'endpoint_epoch':t['endpoint_epoch'],'root_fingerprint':t['root_fingerprint'],**({'runner':t['runner']} if t.get('runner') else {})}
 x=Executor({t['area_id']:area},config['journal'],check)
 try:result=x.execute(call['bearer'],converted)
 finally:x.close()
 return {'format':'resource-execution-receipt.v2','state':result['state'],'operation_id':sha(canonical([result['actor_id'],result['client_id'],r['idempotency_key']])),'request_hash':digest,'target_fingerprint':t['fingerprint'],'result':result}
def online(config,bearer,body):
 key=pathlib.Path(config['service_key_file']).read_text().strip();url=config['authority_url'];assert url.startswith('https://') or url.startswith('http://127.0.0.1:')
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*a):return None
 op=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect(),urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=config.get('authority_ca_file'))))
 req=urllib.request.Request(url,data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+bearer,'X-Hub-Service-Key':key,'Content-Type':'application/json'})
 with op.open(req,timeout=5) as response:return json.load(response)
def main():
 assert os.geteuid()!=0 and os.environ.get('SSH_ORIGINAL_COMMAND')=='resource-adapter-v2'
 config=controlled(os.environ['HUB2_RESOURCE_V2_CONFIG']);raw=sys.stdin.buffer.read(3*1024*1024+1);assert len(raw)<=3*1024*1024
 return execute(config,json.loads(raw))
if __name__=='__main__':
 try:print(json.dumps(main()))
 except Exception as e:print(json.dumps({'state':'rejected','error_code':e.code if isinstance(e,Rejected) else 'typed_endpoint_rejected','secret_values_logged':False}));sys.exit(1)
