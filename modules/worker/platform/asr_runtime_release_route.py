"""Fixed ASR maintenance component; project source only executes as its runtime UID."""
import base64, hashlib, json, os, pathlib, re, subprocess, time, urllib.request
HUFU='fbe863aa-824f-4688-a24d-bc3398754704'
SOURCE='packages/asr-member-runtime74'
ROOT=pathlib.Path('/srv/workspace')
UNIT='hub2-asr-member74.service'
NODE='/srv/workspace'
HEALTH='http://127.0.0.1:18474/health'
REQUIRED={'start.mjs','bootstrap.mjs','authority-client.mjs','ram-authority.mjs','runtime.mjs','server.mjs','journal.mjs','input-cache.mjs','holder.mjs','multi-relay.mjs','provider72.mjs','publication72.mjs','shared-use-authority.mjs','native-asr-use-guard.mjs'}

def safe_name(name):
 if not isinstance(name,str) or not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_-]{0,100}\.mjs',name):raise ValueError('flat_public_asr_module_required')
 return name

def validate_artifact(artifact,commit):
 if artifact.get('component')!='asr-runtime' or artifact.get('project_id')!=HUFU or artifact.get('commit')!=commit or not re.fullmatch(r'[a-f0-9]{40}',commit):raise ValueError('current_asr_artifact_required')
 files=artifact.get('files')
 if not isinstance(files,dict) or not REQUIRED.issubset(files) or len(files)>100:raise ValueError('complete_asr_modules_required')
 decoded={}
 for name,value in files.items():
  safe_name(name);data=base64.b64decode(value,validate=True)
  if len(data)>1024*1024:raise ValueError('asr_module_size_limit')
  decoded[name]=data
 if sum(map(len,decoded.values()))>8*1024*1024:raise ValueError('asr_artifact_size_limit')
 return decoded

BUILD_SCRIPT=r'''
import base64,json,pathlib,subprocess,hashlib
root=pathlib.Path(SOURCE)
if any(p.is_symlink() for p in [root,*root.parents]) or not root.is_dir():raise ValueError('regular_source_directory_required')
files={}
for f in sorted(root.glob('*.mjs')):
 if f.is_symlink() or not f.is_file():raise ValueError('regular_asr_module_required')
 if not __import__('re').fullmatch(r'[a-zA-Z][a-zA-Z0-9_-]{0,100}\.mjs',f.name):raise ValueError('flat_public_asr_module_required')
 data=f.read_bytes()
 if len(data)>1024*1024:raise ValueError('asr_module_size_limit')
 subprocess.run([NODE,'--check',str(f)],check=True,stdout=subprocess.DEVNULL)
 files[f.name]=base64.b64encode(data).decode()
if not REQUIRED.issubset(files) or len(files)>100:raise ValueError('complete_asr_modules_required')
commit=subprocess.check_output(['/usr/bin/git','rev-parse','HEAD'],text=True).strip()
artifact={'component':'asr-runtime','project_id':HUFU,'commit':commit,'files':files}
text=json.dumps(artifact)
if len(text)>12*1024*1024:raise ValueError('asr_artifact_size_limit')
dist=pathlib.Path('dist');dist.mkdir(exist_ok=True);out=dist/'asr-runtime-artifact.json'
if out.is_symlink():raise ValueError('regular_artifact_required')
out.write_text(text)
print(json.dumps({'state':'built','component':'asr-runtime','commit':commit,'files':sorted(files),'artifact_sha256':hashlib.sha256(text.encode()).hexdigest(),'coverage':'actual_current_sources_syntax_checked;not_provider_execution'}))
'''

def fixed_run(args):return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=60)
def active():return subprocess.run(['/usr/bin/systemctl','is-active','--quiet',UNIT]).returncode==0
def health():
 try:
  with urllib.request.urlopen(HEALTH,timeout=2) as r:return r.status
 except Exception:return None
def switch(path):
 tmp=ROOT/'current.next';tmp.unlink(missing_ok=True);tmp.symlink_to(path);os.replace(tmp,ROOT/'current')
def diagnostics(lines):
 # This unit intentionally logs structured state only. Return those messages and
 # systemd transitions; never return arbitrary request text, config or bearer.
 raw=fixed_run(['/usr/bin/journalctl','-u',UNIT,'-n',str(lines),'--no-pager','-o','json']).stdout
 result=[]
 for line in raw.splitlines():
  try:
   row=json.loads(line);message=row.get('MESSAGE','');stamp=row.get('__REALTIME_TIMESTAMP')
   if row.get('SYSLOG_IDENTIFIER')=='systemd':
    # Return the transition category, not arbitrary journal message content.
    event=re.match(r'^(?:'+re.escape(UNIT)+r': )?(Started|Stopped|Starting|Stopping|Main process exited|Failed with result|Consumed|Scheduled restart job)\b',message) if isinstance(message,str) else None
    if event:result.append({'timestamp':stamp,'systemd_transition':event.group(1)})
    continue
   data=json.loads(message)
   if isinstance(data,dict):
    allowed={k:v for k,v in data.items() if k in ('state','error_code','retryable','secrets_logged') and isinstance(v,(str,bool,int)) and (not isinstance(v,str) or re.fullmatch(r'[a-z0-9_]{1,100}',v))}
    if allowed:result.append({'timestamp':stamp,**allowed})
  except (ValueError,TypeError):continue
 return {'state':'read','component':'asr-runtime','service':UNIT,'entries':result,'coverage':'structured_runtime_states_and_systemd_transitions;request_content_and_secrets_omitted','requested_lines':lines}

def dispatch(t,phase,p,identity,project_process,git):
 if identity['project_id']!=HUFU or p.get('component')!='asr-runtime':raise PermissionError('fixed_hufu_asr_component_required')
 extras=set(p)-{'component'}
 if phase=='logs':
  if extras-{'lines'}:raise ValueError('fixed_asr_logs_parameters_required')
  return diagnostics(max(1,min(int(p.get('lines',80)),200)))
 if phase=='service':
  if extras!={'operation'} or p.get('operation') not in ('start','stop','restart'):raise ValueError('fixed_asr_service_operation_required')
  fixed_run(['/usr/bin/systemctl',p['operation'],UNIT])
  return {'exit_code':0,'component':'asr-runtime','service':UNIT,'active':active()}
 if extras:raise ValueError('fixed_asr_component_parameters_required')
 if phase=='status':
  link=ROOT/'current';release=str(link.resolve()) if link.exists() else None
  return {'state':'read','component':'asr-runtime','service':UNIT,'service_state':'active' if active() else 'inactive','release':release,'runtime_user':'hub2asr74','health_http':health()}
 if phase=='build':
  script='\n'.join(k+'='+repr(v) for k,v in [('SOURCE',SOURCE),('NODE',NODE),('HUFU',HUFU),('REQUIRED',REQUIRED)])+'\n'+BUILD_SCRIPT
  r=project_process(t,['/usr/bin/python3','-c',script]);return {'exit_code':r.returncode,'output':r.stdout[-12000:]}
 if phase not in ('deploy','rollback'):raise ValueError('asr_component_action_not_supported')
 if not active():raise ValueError('asr_runtime_inactive;use_explicit_service_start')
 previous=(ROOT/'current').resolve()
 if previous.parent not in (ROOT,ROOT/'engineering-releases'):raise ValueError('registered_asr_current_release_required')
 ROOT.mkdir(exist_ok=True)
 files=None
 if phase=='rollback':
  marker=ROOT/'engineering-previous'
  if not marker.exists():raise ValueError('asr_previous_release_missing')
  release=marker.resolve()
  if release.parent not in (ROOT,ROOT/'engineering-releases') or not (release/'src/start.mjs').is_file():raise ValueError('registered_asr_previous_release_required')
  commit=release.name.split('-')[0]
 else:
  if git(t,['status','--porcelain','--',SOURCE])['output'].strip():raise ValueError('commit_current_changes_before_deploy')
  commit=git(t,['rev-parse','HEAD'])['output'].strip()
  exported=project_process(t,['/usr/bin/python3','-c',"import pathlib; p=pathlib.Path('dist/asr-runtime-artifact.json'); assert not p.is_symlink(); assert p.stat().st_size<12*1024*1024; print(p.read_text())"])
  if exported.returncode:raise ValueError('build_current_asr_commit_before_deploy')
  files=validate_artifact(json.loads(exported.stdout),commit)
  releases=ROOT/'engineering-releases';releases.mkdir(exist_ok=True)
  release=releases/(commit[:12]+'-'+str(time.time_ns()));release.mkdir(mode=0o755);(release/'src').mkdir(mode=0o755)
  for name,data in files.items():
   dest=release/'src'/name;dest.write_bytes(data);os.chmod(dest,0o644)
  (release/'package.json').write_text('{"type":"module","private":true}')
  (release/'release.json').write_text(json.dumps({'project_id':HUFU,'component':'asr-runtime','commit':commit,'actor_id':identity['actor_id'],'client_id':identity['client_id'],'service':UNIT,'source':SOURCE,'files':sorted(files)}))
 if not active():raise ValueError('asr_runtime_became_inactive')
 # No project executable runs in the controller. The unchanged unit executes
 # fixed start.mjs as hub2asr74 with its existing private config and journals.
 switch(release)
 try:
  fixed_run(['/usr/bin/systemctl','restart',UNIT])
  for _ in range(25):
   if active() and health()==200:break
   time.sleep(.2)
  else:raise RuntimeError('asr_runtime_readiness_failed')
 except Exception:
  switch(previous);fixed_run(['/usr/bin/systemctl','restart',UNIT]);raise
 marker=ROOT/'engineering-previous';marker.unlink(missing_ok=True);marker.symlink_to(previous)
 return {'exit_code':0,'component':'asr-runtime','commit':commit,'release':str(release),'previous_release':str(previous),'service':UNIT,'runtime_user':'hub2asr74','health_http':200,'private_config_and_journal_preserved':True,'provider_submission':'not_performed_by_deployment','files':len(files) if files else None}
