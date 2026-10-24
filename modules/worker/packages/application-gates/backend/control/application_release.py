"""Fixed application release relay. Only root trusted runtime dispatcher imports this.
Member Python is syntax-checked/exported in project UID, never executed by root.
"""
import pathlib,json,datetime,hashlib,re,os,subprocess,urllib.request,time
PROFILES={
 '3527ac31-0643-4f89-a6bd-b1e9768b2e42':{'slug':'baize','uid':'baize','services':['hufu2-baize-compat.service'],'entry':'baize_entry.py','legacy':'/opt/baize/app','python':'/opt/baize/app/.venv/bin/python','launch':['/opt/baize/app/.venv/bin/uvicorn','baize_entry:baize','--factory','--host','127.0.0.1','--port','18000','--no-access-log'],'ports':[18000]},
 '69197d56-41b0-4c8b-ac19-181f63e87c1f':{'slug':'tools','uid':'fgb-collector-poc','services':['hufu2-tools-compat.service'],'entry':'tools_entry.py','legacy':'/opt/fgb-tools','python':'/opt/fgb-collector-web-poc/venv/bin/python','launch':['/opt/fgb-collector-web-poc/venv/bin/uvicorn','tools_entry:tools','--factory','--host','127.0.0.1','--port','18767','--no-access-log'],'ports':[18767]},
 '6aedbc32-3768-47cc-a1e2-ff4297be5be7':{'slug':'jiling','uid':'jiling-relay','services':['hufu2-jiling-compat.service','hufu2-jiling-ws.service'],'entry':'jiling_native.py','legacy':'/opt/jiling-relay','python':'/opt/jiling-relay/.venv/bin/python','ports':[4635,4634]}}
HUFU='fbe863aa-824f-4688-a24d-bc3398754704'
ROOT=pathlib.Path('/srv/workspace')
SHARED=ROOT/'shared/current'
def run(*args):return subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=45)
def switch(link,destination):
 tmp=link.with_name(link.name+'.next');tmp.unlink(missing_ok=True);tmp.symlink_to(destination);os.replace(tmp,link)
def verify(profile,release):
 import socket
 for _ in range(20):
  if all(run('/usr/bin/systemctl','is-active','--quiet',s).returncode==0 for s in profile['services']):
   try:
    for port in profile['ports']:
     with socket.create_connection(('127.0.0.1',port),timeout=1):pass
    return True
   except OSError:pass
  time.sleep(.3)
 return False

def execute(request,identity):
 if request.get('parameters',{}).get('component')=='public-entry':
  from baize_public_entry import execute as public_execute
  return public_execute(request,identity)
 if request.get('parameters',{}).get('component')=='background-directory':
  from baize_background_release import execute as background_execute
  return background_execute(request,identity)
 project=request['project_id'];shared=project==HUFU
 p=({'slug':'shared','uid':'fixed_existing_project_unit_UIDs','services':[u for x in PROFILES.values() for u in x['services']],'entry':'application_gate.py','ports':[18000,18767,4635,4634]} if shared else PROFILES.get(project))
 if not p or identity.get('project_id')!=project:raise PermissionError('fixed_application_project_required')
 if datetime.datetime.fromisoformat(identity['deadline'].replace('Z','+00:00'))<=datetime.datetime.now(datetime.timezone.utc):raise PermissionError('engineering_permit_expired')
 phase=request['parameters']['phase']
 if shared and phase not in ['deploy','rollback','status']:raise PermissionError('Hufu_shared_fixed_release_only')
 if identity.get('application_release_phase')!=phase:raise PermissionError('current_engineering_phase_required')
 base=ROOT/p['slug'];current=base/'current';previous=base/'previous'
 if phase=='status':return {'state':'read','services':{s:run('/usr/bin/systemctl','is-active',s).stdout.decode().strip() for s in p['services']},'release':str(current.resolve()) if current.exists() else None,'shared_release':str(SHARED.resolve())}
 if phase=='logs':return {'state':'read','output':'\n'.join(run('/usr/bin/journalctl','-u',s,'-n','80','--no-pager').stdout.decode()[-16000:] for s in p['services'])}
 if phase=='deploy':
  artifact=request['parameters']['artifact'];commit=artifact['commit'];files=artifact['files']
  if not re.fullmatch('[a-f0-9]{40}',commit) or artifact['project_id']!=project or not isinstance(files,dict) or p['entry'] not in files or len(files)>50:raise ValueError('fixed_project_artifact_required')
  if len(json.dumps(files).encode())>650000:raise ValueError('artifact_too_large')
  if shared and set(files)!={'application_gate.py','native_identity_bridge.py','caller_context.py','application_browser_sso.py'}:raise ValueError('fixed_shared_gate_files_required')
  for name,text in files.items():
   if not re.fullmatch('[A-Za-z_][A-Za-z_0-9]*[.]py',name) or (not shared and name in ['application_gate.py','native_identity_bridge.py','caller_context.py','application_browser_sso.py']) or not isinstance(text,str):raise ValueError('project_python_artifact_only')
  # Root does not compile/import/execute project Python. Export is plain bounded data.
  digest=hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest();release=base/(commit[:12]+'-'+digest[:12]);base.mkdir(parents=True,exist_ok=True)
  if not release.exists():
   release.mkdir(mode=0o755);os.chmod(release,0o755)
   for name,text in files.items():(release/name).write_text(text);os.chmod(release/name,0o644)
   (release/'manifest.json').write_text(json.dumps({'project_id':project,'commit':commit,'sha256':digest,'actor_id':identity['actor_id'],'client_id':identity['client_id']}))
  os.chmod(release,0o755)
  if current.exists():switch(previous,current.resolve())
  switch(current,release)
 elif phase=='rollback':
  if not previous.exists():raise ValueError('previous_application_release_missing')
  old=current.resolve();switch(current,previous.resolve());switch(previous,old);commit=json.loads((current/'manifest.json').read_text()).get('commit')
 elif phase=='service':
  operation=request['parameters'].get('operation')
  if operation not in ['start','stop','restart','reload']:raise ValueError('fixed_service_operation_required')
  codes=[run('/usr/bin/systemctl',operation,s).returncode for s in p['services']]
  return {'exit_code':max(codes),'services':p['services'],'operation':operation}
 else:raise ValueError('application_release_phase_required')
 for s in p['services']:run('/usr/bin/systemctl','reset-failed',s)
 failed=any(run('/usr/bin/systemctl','restart',s).returncode!=0 for s in p['services'])
 if not failed and verify(p,current):return {'exit_code':0,'release':str(current.resolve()),'commit':commit,'services':p['services'],'running_uid':p['uid'],'ready':'active_units_and_loopback_ports;business_auth_still_required'}
 if previous.exists():
  switch(current,previous.resolve())
  for s in p['services']:
   run('/usr/bin/systemctl','reset-failed',s);run('/usr/bin/systemctl','restart',s)
 return {'exit_code':1,'error_code':'application_candidate_not_ready','previous_restored':previous.exists(),'data_preserved':True}
