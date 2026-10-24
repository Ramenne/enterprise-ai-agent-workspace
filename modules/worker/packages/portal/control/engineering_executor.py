#!/usr/bin/python3
"""Registered Hufu engineering runner. Public callers are authorized by Hufu.
Root only dispatches fixed OS/service operations; user code runs as xiaochen.
"""
import sys
sys.path.insert(0,'/srv/workspace')
import os,json,sqlite3,hashlib,uuid,subprocess,threading,shutil,time,datetime,re,urllib.request,pwd,grp,tarfile,io
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
BASE=Path('/srv/workspace')
CONF=Path('/etc/workspace-hub2/engineering/targets.json')
SECRET=Path('/etc/workspace-hub2/engineering/relay.private')
NODE='/srv/workspace'
PG='/srv/workspace'
STATE=BASE/'operations.sqlite'
PROJECT_LOCKS={}
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def scrub(s):
 s=re.sub(r'(?i)(authorization\s*[:=]\s*bearer\s+|password\s*[:=]\s*|secret\s*[:=]\s*|token\s*[:=]\s*)[^\s,;]+',r'\1[redacted]',s)
 s=re.sub(r'hub2_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+','[redacted]',s)
 return s[-65000:]
def db():
 c=sqlite3.connect(STATE,timeout=15)
 c.execute('CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, actor TEXT, client TEXT, project TEXT, idem TEXT, digest TEXT, state TEXT, record TEXT, UNIQUE(actor,client,idem))')
 return c
def project_process(t,args,cwd=None,timeout=600,stdin=None,text=True,postgres=False):
 user=t.get('os_user','xiaochen');group=t.get('os_group',user);repo=t['repo']
 uid=pwd.getpwnam(user).pw_uid;gid=grp.getgrnam(group).gr_gid
 unit='hub2-project-command-'+uuid.uuid4().hex
 binds=[repo]
 readonly=['/srv/workspace','/srv/workspace','/srv/workspace']
 if Path(repo+'/reference').exists():readonly.append(repo+'/reference')
 if postgres:
  readonly.extend(['/srv/workspace','/run/workspace-hub2-postgres'])
 cmd=['/usr/bin/systemd-run','--quiet','--wait','--pipe','--collect','--unit='+unit,
  '--property=User='+user,'--property=Group='+group,'--property=WorkingDirectory='+(cwd or repo),
  '--property=ProtectSystem=strict','--property=ProtectHome=yes','--property=PrivateTmp=yes',
  '--property=ProtectProc=invisible','--property=NoNewPrivileges=yes','--property=CapabilityBoundingSet=',
  '--property=RestrictSUIDSGID=yes','--property=UMask=0007',
  '--property=TemporaryFileSystem=/opt:ro /srv/workspace /etc/workspace-hub2:ro /run:ro',
  '--property=BindPaths='+' '.join(binds),
  '--property=BindReadOnlyPaths='+' '.join(x for x in readonly if Path(x).exists()),
  '--setenv=PATH=/srv/workspace',
  '--setenv=HOME='+repo+'/.agent-home','--setenv=LANG=C.UTF-8','--setenv=GIT_TERMINAL_PROMPT=0',*args]
 return subprocess.run(cmd,input=stdin,text=text,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout)
def run(args,cwd=None,timeout=600,stdin=None,user='xiaochen',t=None,postgres=False):
 if t:
  p=project_process(t,args,cwd,timeout,stdin,postgres=postgres)
 else:
  command=['/usr/sbin/runuser','-u',user,'--',*args] if user else args
  p=subprocess.run(command,cwd=cwd,input=stdin,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout)
 return {'exit_code':p.returncode,'output':scrub(p.stdout)}
def target(project):
 t=json.loads(CONF.read_text()).get(project)
 if not t or not t.get('enabled'):raise ValueError('project_not_registered')
 return t
def path_in(t,name,write=False):
 if not isinstance(name,str) or '\x00' in name or Path(name).is_absolute() or '..' in Path(name).parts or '.git' in Path(name).parts:raise ValueError('project_relative_path_required')
 root=Path(t['repo']).resolve();p=(root/name).resolve()
 if p!=root and root not in p.parents:raise ValueError('outside_project_path')
 if write and not any(x=='*' or name==x or name.startswith(x+'/') for x in t['writable_paths']):raise ValueError('outside_project_write_scope')
 if any(x in p.parts for x in ['node_modules','.git']) or '.private' in p.name or p.name.endswith('.env'):raise ValueError('protected_file')
 return p
def git(t,args):return run(['/usr/bin/git','-C',t['repo'],*args],t=t)
def save(id,record,state):
 with db() as c:c.execute('UPDATE operations SET state=?,record=? WHERE id=?',(state,json.dumps(record,ensure_ascii=False),id))
def status(t):
 r=run(['/usr/bin/systemctl','is-active',t['service']],user=None) if t.get('service') else {'output':'not_configured'}
 live=Path(t['release_root'])/'current'
 return {'state':'read','partition':{'os_user':t.get('os_user'),'workspace':t['repo'],'filesystem':'private_mount_namespace','other_projects':'hidden'},'service':t.get('service'),'service_state':r['output'].strip(),'workspace':t['repo'],'current_release':str(live.resolve()) if live.exists() else None,'git':git(t,['log','-1','--format=%H %s'])}
def work(id,request,identity):
 t=target(request['project_id']);a=request['action'];p=request['parameters'];record={'operation_id':id,'project_id':request['project_id'],'actor_id':identity['actor_id'],'client_id':identity['client_id'],'credential_id':identity['credential_id'],'action':a,'started_at':now()}
 try:
  record['state']='running';save(id,record,'running')
  with PROJECT_LOCKS.setdefault(request['project_id'],threading.Lock()):
   if datetime.datetime.fromisoformat(identity['deadline'].replace('Z','+00:00'))<=datetime.datetime.now(datetime.timezone.utc):raise ValueError('project_authority_expired_before_start')
   result=perform(t,a,p,identity)
  state='completed' if result.get('exit_code',0)==0 else 'failed'
  record.update(state=state,result=result,finished_at=now());save(id,record,state)
 except Exception as e:
  record.update(state='failed',error_code=type(e).__name__,reason=str(e)[:300],finished_at=now(),next_step='inspect_operation_and_correct;do_not_automatically_repeat_effect');save(id,record,'failed')
def perform(t,a,p,identity):
 if p.get("component")=="portal":
  if identity["project_id"]!="fbe863aa-824f-4688-a24d-bc3398754704" or a not in ["build","deploy","rollback"]:raise ValueError("fixed_hufu_portal_component_required")
  from portal_release_route import dispatch
  return dispatch(t,a,p,identity,project_process,git)
 if identity['project_id']=='fbe863aa-824f-4688-a24d-bc3398754704' and p.get('component')=='application-gates':
  if a not in ['build','deploy','rollback']:raise ValueError('shared_application_component_build_deploy_rollback_only')
  from application_release_route import dispatch
  return dispatch(t,a,p,identity,project_process,git)
 if t.get('deployment_profile')=='python_compat' and a in ['build','deploy','rollback','service']:
  from application_release_route import dispatch
  return dispatch(t,a,p,identity,project_process,git)
 if a=='write':
  path_in(t,p.get('path'),True);text=p.get('text')
  if not isinstance(text,str) or len(text.encode())>1024*1024:raise ValueError('text_size_limit')
  script="""import json,pathlib,hashlib,os,sys
b=json.load(sys.stdin);dest=pathlib.Path(b['path'])
if b.get('expected_sha256') and (not dest.exists() or hashlib.sha256(dest.read_bytes()).hexdigest()!=b['expected_sha256']):raise ValueError('content_conflict')
dest.parent.mkdir(parents=True,exist_ok=True);temp=dest.with_name(dest.name+'.engineering-pending');temp.write_text(b['text']);os.chmod(temp,0o660);os.replace(temp,dest)
print(json.dumps({'path':b['path'],'bytes':len(b['text'].encode()),'sha256':hashlib.sha256(dest.read_bytes()).hexdigest()}))"""
  r=run(['/usr/bin/python3','-c',script],stdin=json.dumps(p),t=t)
  if r['exit_code']:return r
  return json.loads(r['output'])
 if a=='commit':
  changed=git(t,['status','--porcelain'])
  if changed['exit_code']:return changed
  for line in changed['output'].splitlines():
   name=line[3:]
   if name=='node_modules' and line[:2].strip()=='D':continue
   path_in(t,name,True)
  message=p.get('message')
  if not isinstance(message,str) or not message or len(message)>1000:raise ValueError('commit_message_required')
  stage=git(t,['add','--',*(['.'] if '*' in t['writable_paths'] else t['writable_paths'])])
  if stage['exit_code']:return stage
  r=git(t,['-c','user.name=企业 AI 协作平台工程通路','-c','user.email=engineering@service.example.invalid','commit','-m',message,'--trailer','Hub-Actor: '+identity['actor_id']])
  r['commit']=git(t,['rev-parse','HEAD'])['output'].strip();return r
 if a=='build':
  if t.get('build_profile')=='hufu_typescript':
   r=run([NODE,'node_modules/typescript/bin/tsc','-p','apps/hufu/tsconfig.engineering.json'],t=t)
   if r['exit_code']:return r
   script="""from pathlib import Path
import shutil
for folder in ['packages','apps/hufu']:
 for f in Path(folder).rglob('*'):
  if f.is_file() and f.suffix in ['.mjs','.json','.html','.css']:
   d=Path('dist')/f;d.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(f,d)
"""
   r=run(['/usr/bin/python3','-c',script],t=t)
  elif Path(t['repo']+'/.hub/build.sh').is_file():
   r=run(['/bin/bash','.hub/build.sh'],t=t)
  else:raise ValueError('configure_project_build_script_at_.hub/build.sh;or_use_command_for_current_work')
  if r['exit_code']==0:
   commit=git(t,['rev-parse','HEAD'])['output'].strip()
   marker={'commit':commit,'built_at':now()}
   run(['/usr/bin/python3','-c',"import pathlib,json,sys; p=pathlib.Path('dist');p.mkdir(exist_ok=True);(p/'.engineering-build.json').write_text(sys.stdin.read())"],stdin=json.dumps(marker),t=t)
   r['commit']=commit
  return r
 if a=='command':
  command=p.get('command')
  if not isinstance(command,str) or not command or len(command)>8000:raise ValueError('command_required')
  return run(['/bin/bash','-c',command],cwd=t['repo'],timeout=min(int(p.get('timeout_seconds',300)),600),t=t)
 if a=='migrate':
  text=p.get('sql')
  if not isinstance(text,str) or not text or len(text)>200000:raise ValueError('sql_required')
  # Real peer-authenticated non-superuser owns only Hufu domains. It cannot RESET ROLE into postgres.
  if not t.get('db_login') or not t.get('db_owner'):raise ValueError('project_database_not_registered')
  r=run([PG,'-h','/run/workspace-hub2-postgres','-U',t['db_login'],'-d','hub_core','-X','-q','-v','ON_ERROR_STOP=1'],stdin='BEGIN; SET LOCAL ROLE '+t['db_owner']+';\n'+text+'\nCOMMIT;\n',t=t,postgres=True)
  # SQL output can contain user data; return only success/failure diagnostics.
  if r['exit_code']==0:r['output']='Migration committed in the registered project database role; result rows omitted.'
  return r
 if a=='service':
  operation=p.get('operation')
  if operation not in ['start','stop','restart','reload']:raise ValueError('project_service_operation_required')
  if not t.get('service'):raise ValueError('project_service_not_registered')
  if operation in ['start','restart'] and t.get('deployment_profile')=='project_runtime' and not Path(t['repo']+'/.hub/start.sh').is_file():raise ValueError('configure_project_start_script_before_start')
  return run(['/usr/bin/systemctl',operation,t['service']],user=None,timeout=90)
 if a=='deploy':
  if not t.get('deployment_enabled'):raise ValueError('project_deployment_not_configured;continue_reconstruction_without_starting_legacy_services')
  if t.get('deployment_profile')=='project_runtime':
   if not Path(t['repo']+'/.hub/start.sh').is_file():raise ValueError('configure_project_start_script_at_.hub/start.sh')
   return run(['/usr/bin/systemctl','restart',t['service']],user=None,timeout=90)
  repo=Path(t['repo']);built=repo/'dist/.engineering-build.json';commit=git(t,['rev-parse','HEAD'])['output'].strip()
  if not built.exists() or json.loads(built.read_text())['commit']!=commit:raise ValueError('build_current_commit_before_deploy')
  dirty=git(t,['status','--porcelain'])['output'].strip()
  if dirty:raise ValueError('commit_current_changes_before_deploy')
  root=Path(t['release_root']);root.mkdir(parents=True,exist_ok=True);release=root/(commit[:12]+'-'+str(int(time.time())))
  packed=project_process(t,['/usr/bin/tar','-cf','-','dist','package.json'],text=False)
  if packed.returncode:return {'exit_code':packed.returncode,'output':'Project artifact export failed'}
  release.mkdir(parents=True)
  with tarfile.open(fileobj=io.BytesIO(packed.stdout),mode='r:') as archive:
   ordinary=[];public_links={}
   registered={'dist/packages/storage-tiers/node_modules':'/srv/workspace'}
   for entry in archive.getmembers():
    if entry.name.startswith('/') or '..' in Path(entry.name).parts:raise ValueError('unsafe_release_entry')
    if entry.issym():
     if registered.get(entry.name)!=entry.linkname or not Path(entry.linkname).is_dir():raise ValueError('unregistered_artifact_dependency_link')
     public_links[entry.name]=entry.linkname
    elif entry.isfile() or entry.isdir():ordinary.append(entry)
    else:raise ValueError('unsafe_release_entry')
   archive.extractall(release,members=ordinary,filter='data')
   for name,target in public_links.items():
    link=release/name;link.parent.mkdir(parents=True,exist_ok=True);link.symlink_to(target)
  os.symlink(t['node_modules'],release/'node_modules')
  for folder,dirs,files in os.walk(release):
   os.chmod(folder,0o755)
   for name in files:
    f=Path(folder)/name
    if not f.is_symlink():os.chmod(f,0o644)
  previous=root/'previous';current=root/'current'
  if current.exists():
   old=current.resolve();temp=root/'previous.next';temp.unlink(missing_ok=True);temp.symlink_to(old);os.replace(temp,previous)
  temp=root/'current.next';temp.unlink(missing_ok=True);temp.symlink_to(release);os.replace(temp,current)
  if t.get('service_dropin'):
   Path(t['service_dropin']).write_text('[Service]\nWorkingDirectory='+str(root/'current')+'\n');run(['/usr/bin/systemctl','daemon-reload'],user=None)
  r=run(['/usr/bin/systemctl','restart',t['service']],user=None,timeout=90)
  if r['exit_code']:return r
  for _ in range(30):
   try:
    with urllib.request.urlopen(t.get('ready_url','http://127.0.0.1:4611/ready'),timeout=2) as response:
     if response.status==200:
      r.update(release=str(release),commit=commit,service='active',ready_http=200);return r
   except Exception:pass
   time.sleep(0.5)
  if previous.exists():
   temp=root/'current.recover';temp.unlink(missing_ok=True);temp.symlink_to(previous.resolve());os.replace(temp,current);run(['/usr/bin/systemctl','restart',t['service']],user=None,timeout=90)
  return {'exit_code':1,'output':'New project runtime failed readiness; previous code restored, database retained.','candidate_release':str(release),'commit':commit,'previous_restored':previous.exists()}
 if a=='rollback':
  if not t.get('deployment_enabled') or t.get('deployment_profile')=='project_runtime':raise ValueError('project_release_rollback_not_configured')
  root=Path(t['release_root']);previous=root/'previous'
  if not previous.exists():raise ValueError('previous_release_missing')
  temp=root/'current.next';temp.unlink(missing_ok=True);temp.symlink_to(previous.resolve());os.replace(temp,root/'current')
  r=run(['/usr/bin/systemctl','restart',t['service']],user=None,timeout=90);r['data_preserved']=True;return r
 raise ValueError('unknown_effect_action')
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def respond(self,data,status=200):
  content=json.dumps(data,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(content)));self.end_headers();self.wfile.write(content)
 def do_POST(self):
  try:
   if self.path!='/execute' or self.headers.get('x-hub-resource-key')!=SECRET.read_text().strip():return self.respond({'error_code':'trusted_hufu_relay_required'},403)
   length=int(self.headers.get('Content-Length',0))
   if not 0<length<=2*1024*1024:return self.respond({'error_code':'size_limit'},400)
   packet=json.loads(self.rfile.read(length));r=packet['request'];i=packet['identity'];t=target(r['project_id'])
   if i['project_id']!=r['project_id'] or datetime.datetime.fromisoformat(i['deadline'].replace('Z','+00:00'))<=datetime.datetime.now(datetime.timezone.utc):return self.respond({'error_code':'current_project_permit_required'},403)
   a=r['action'];p=r['parameters'];repo=Path(t['repo'])
   if a=='database_sqlite':
    import sys
    if '/srv/workspace' not in sys.path:sys.path.insert(0,'/srv/workspace')
    from sqlite_route import execute
    out,status=execute(r,i)
    return self.respond(out,status)
   if a=='runtime':
    import sys
    if '/srv/workspace' not in sys.path:sys.path.insert(0,'/srv/workspace')
    from runtime_route import dispatch
    out,status_code=dispatch(r,i)
    return self.respond(out,status_code)
   if t.get('deployment_profile')=='python_compat' and a in ['status','logs']:
    from application_release_route import dispatch
    out=dispatch(t,a,p,i,project_process,git)
    if 'output' in out:out['output']=scrub(out['output'])
    return self.respond(out)
   if a=='status':return self.respond(status(t))
   if a=='logs':return self.respond({'state':'read',**run(['/usr/bin/journalctl','-u',t['service'],'-n',str(min(int(p.get('lines',80)),200)),'--no-pager'],user=None,timeout=10)})
   if a=='git_status':return self.respond({'state':'read',**git(t,['status','--short'])})
   if a=='read':
    path_in(t,p.get('path'))
    script="""import json,pathlib,hashlib,sys
b=json.load(sys.stdin);data=pathlib.Path(b['path']).read_bytes();offset=max(0,int(b.get('offset',0)));chunk=data[offset:offset+131072]
print(json.dumps({'state':'read','path':b['path'],'text':chunk.decode('utf-8'),'size':len(data),'offset':offset,'next_offset':offset+len(chunk) if offset+len(chunk)<len(data) else None,'coverage':'whole' if offset==0 and len(chunk)==len(data) else 'partial','sha256':hashlib.sha256(data).hexdigest()}))"""
    result=project_process(t,['/usr/bin/python3','-c',script],stdin=json.dumps(p))
    if result.returncode:return self.respond({'state':'failed','output':scrub(result.stdout),'exit_code':result.returncode},400)
    return self.respond(json.loads(result.stdout))
   if a=='list':
    path_in(t,p.get('path',''))
    script="""import json,pathlib,sys
b=json.load(sys.stdin);items=[{'name':x.name,'kind':'directory' if x.is_dir() else 'file'} for x in sorted(pathlib.Path(b.get('path','')).iterdir()) if x.name not in ['.git','node_modules','dist'] and '.private' not in x.name]
print(json.dumps({'state':'read','items':items}))"""
    result=project_process(t,['/usr/bin/python3','-c',script],stdin=json.dumps(p))
    if result.returncode:return self.respond({'state':'failed','output':scrub(result.stdout),'exit_code':result.returncode},400)
    return self.respond(json.loads(result.stdout))
   if a=='operation':
    with db() as c:row=c.execute('SELECT actor,client,project,state,record FROM operations WHERE id=?',(p.get('operation_id'),)).fetchone()
    if not row or row[0]!=i['actor_id'] or row[2]!=r['project_id']:return self.respond({'error_code':'operation_not_available'},403)
    return self.respond(json.loads(row[4]))
   if a not in ['write','commit','build','command','migrate','service','deploy','rollback']:raise ValueError('action_not_registered')
   idem=r.get('idempotency_key');fingerprint=hashlib.sha256(json.dumps(r,sort_keys=True,separators=(',',':')).encode()).hexdigest();id=str(uuid.uuid4());record={'state':'queued','operation_id':id,'actor_id':i['actor_id'],'client_id':i['client_id'],'project_id':r['project_id'],'action':a,'queued_at':now()}
   with db() as c:
    old=c.execute('SELECT digest,record FROM operations WHERE actor=? AND client=? AND idem=?',(i['actor_id'],i['client_id'],idem)).fetchone()
    if old:return self.respond(json.loads(old[1]) if old[0]==fingerprint else {'error_code':'idempotency_conflict'},200 if old[0]==fingerprint else 409)
    c.execute('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?)',(id,i['actor_id'],i['client_id'],r['project_id'],idem,fingerprint,'queued',json.dumps(record)))
   threading.Thread(target=work,args=(id,r,i),daemon=True).start();return self.respond(record,202)
  except Exception as e:return self.respond({'state':'failed','error_code':str(e)[:200]},400)
if __name__=='__main__':
 BASE.mkdir(parents=True,exist_ok=True)
 with db() as c:
  for id,record in c.execute("SELECT id,record FROM operations WHERE state IN('queued','running')").fetchall():
   r=json.loads(record);r.update(state='interrupted',next_step='inspect_actual_effect_before_retry')
   c.execute('UPDATE operations SET state=?,record=? WHERE id=?',('interrupted',json.dumps(r),id))
 ThreadingHTTPServer(('127.0.0.1',4619),Handler).serve_forever()
