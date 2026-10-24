"""Fixed Hufu Portal 2.0 release; project code is never evaluated by root."""
import base64, hashlib, json, os, pathlib, re, subprocess, time, urllib.request
HUFU='fbe863aa-824f-4688-a24d-bc3398754704'
SOURCE='packages/portal/source'
ROOT=pathlib.Path('/srv/workspace')
DATA=pathlib.Path('/srv/workspace')
UNIT='hub2-portal.service'
NODE='/srv/workspace'
# Names reserved for controller metadata or existing persistent configuration.
RESERVED=('docs','private','env','consumers.private.json','portal-session-key.private','release.json','node_modules','.git')
def safe_name(name):
 if not isinstance(name,str) or not name or len(name)>1000 or '\x00' in name or '\\' in name:raise ValueError('ordinary_project_relative_path_required')
 path=pathlib.PurePosixPath(name)
 if path.is_absolute() or name!=path.as_posix() or path.parts[0].lower() in RESERVED or any(part in ('.','..','.git','node_modules') or '.private' in part.lower() or part.lower().startswith('.env') or part.lower().endswith('.env') for part in path.parts):raise ValueError('reserved_or_unsafe_portal_path')
 return path
BUILD_SCRIPT=r'''
import base64,json,pathlib,subprocess,hashlib
root=pathlib.Path(SOURCE)
if any(p.is_symlink() for p in [root,*root.parents]):raise ValueError('regular_source_directory_required')
if not root.is_dir() or not (root/'server.mjs').is_file():raise ValueError('portal_source_entry_required')
files={}
for f in sorted(root.rglob('*')):
 if f.is_symlink():raise ValueError('source_symlink_forbidden')
 name=f.relative_to(root).as_posix()
 path=pathlib.PurePosixPath(name)
 if name!=path.as_posix() or path.parts[0].lower() in RESERVED or any(part in ('.','..','.git','node_modules') or '.private' in part.lower() or part.lower().startswith('.env') or part.lower().endswith('.env') for part in path.parts) or '\\' in name or '\x00' in name:raise ValueError('reserved_or_unsafe_portal_path')
 if f.is_dir():continue
 if f.is_symlink() or not f.is_file() or any(p.is_symlink() for p in f.parents):raise ValueError('regular_allowed_source_required')
 b=f.read_bytes()
 if len(b)>20000000:raise ValueError('source_size_limit')
 if name.endswith(('.mjs','.js')):subprocess.run([NODE,'--check',str(f)],check=True,stdout=subprocess.DEVNULL)
 files[name]=base64.b64encode(b).decode()
commit=subprocess.check_output(['/usr/bin/git','rev-parse','HEAD'],text=True).strip()
artifact={'component':'portal','project_id':HUFU,'commit':commit,'files':files}
text=json.dumps(artifact)
if len(text)>64000000:raise ValueError('artifact_size_limit')
dist=pathlib.Path('dist');dist.mkdir(exist_ok=True)
p=dist/'portal-artifact.json'
if p.is_symlink():raise ValueError('regular_artifact_required')
p.write_text(text)
print(json.dumps({'state':'built','component':'portal','commit':commit,'files':sorted(files),'artifact_sha256':hashlib.sha256(text.encode()).hexdigest(),'dependencies':'node_builtin_modules_only'}))
'''
def fixed_run(args):return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=60)
def active():return subprocess.run(['/usr/bin/systemctl','is-active','--quiet',UNIT]).returncode==0
def switch(path):
 tmp=ROOT/'current.next';tmp.unlink(missing_ok=True);tmp.symlink_to(path);os.replace(tmp,ROOT/'current')
def dispatch(t,phase,p,identity,project_process,git):
 if identity['project_id']!=HUFU or p!={'component':'portal'}:raise ValueError('fixed_hufu_portal_component_required')
 if phase=='build':
  script='\n'.join(k+'='+repr(v) for k,v in [('SOURCE',SOURCE),('RESERVED',RESERVED),('NODE',NODE),('HUFU',HUFU)])+'\n'+BUILD_SCRIPT
  result=project_process(t,['/usr/bin/python3','-c',script])
  return {'exit_code':result.returncode,'output':result.stdout[-12000:]}
 if phase not in ('deploy','rollback'):raise ValueError('portal_build_deploy_rollback_only')
 if not active():raise ValueError('portal_paused_or_inactive;deployment_must_not_start_service')
 ROOT.mkdir(parents=True,exist_ok=True);os.chmod(ROOT,0o755)
 previous=(ROOT/'current').resolve() if (ROOT/'current').exists() else DATA
 if phase=='rollback':
  marker=ROOT/'previous'
  if not marker.exists():raise ValueError('portal_previous_release_missing')
  release=marker.resolve()
  if release!=DATA and release.parent!=ROOT:raise ValueError('invalid_registered_previous_release')
 else:
  if git(t,['status','--porcelain'])['output'].strip():raise ValueError('commit_current_changes_before_deploy')
  commit=git(t,['rev-parse','HEAD'])['output'].strip()
  export=project_process(t,['/usr/bin/python3','-c',"import pathlib; p=pathlib.Path('dist/portal-artifact.json'); assert not p.is_symlink(); assert p.stat().st_size<=64000000; print(p.read_text())"])
  if export.returncode:raise ValueError('build_current_commit_before_deploy')
  artifact=json.loads(export.stdout)
  if artifact.get('commit')!=commit or not re.fullmatch('[a-f0-9]{40}',commit) or artifact.get('project_id')!=HUFU or artifact.get('component')!='portal' or not isinstance(artifact.get('files'),dict) or 'server.mjs' not in artifact['files'] or len(artifact['files'])>10000:raise ValueError('current_portal_artifact_required')
  for name in artifact['files']:safe_name(name)
  release=ROOT/(commit[:12]+'-'+str(time.time_ns()));release.mkdir(mode=0o755)
  for name in sorted(artifact['files']):
   b=base64.b64decode(artifact['files'][name],validate=True)
   if len(b)>20000000:raise ValueError('allowed_file_size_limit')
   dest=release/name;dest.parent.mkdir(parents=True,exist_ok=True);os.chmod(dest.parent,0o755);dest.write_bytes(b);os.chmod(dest,0o644)
  for directory,_,_ in os.walk(release):os.chmod(directory,0o755)
  for name in ('consumers.private.json','portal-session-key.private','docs'):
   if not (DATA/name).exists():raise ValueError('registered_portal_persistent_data_missing')
   (release/name).symlink_to(DATA/name)
  (release/'release.json').write_text(json.dumps({'project_id':HUFU,'component':'portal','commit':commit,'actor_id':identity['actor_id'],'client_id':identity['client_id'],'source':SOURCE,'service':UNIT,'files':sorted(artifact['files'])}));os.chmod(release/'release.json',0o644)
 if not active():raise ValueError('portal_became_inactive;deployment_must_not_start_service')
 # Fixed controller owns this exact unit and directory; callers supply neither.
 drop=pathlib.Path('/etc/systemd/system/hub2-portal.service.d');drop.mkdir(exist_ok=True)
 (drop/'40-engineering-portal.conf').write_text('[Service]\nWorkingDirectory='+str(ROOT/'current')+'\n')
 switch(release);fixed_run(['/usr/bin/systemctl','daemon-reload'])
 try:
  fixed_run(['/usr/bin/systemctl','restart',UNIT])
  for _ in range(25):
   if active():
    try:
     req=urllib.request.Request('http://127.0.0.1:4616/hub2-preview/hufu/portal/start',headers={'Host':'service.example.invalid'})
     with urllib.request.urlopen(req,timeout=2) as r:
      if r.status==200:break
    except Exception:pass
   time.sleep(.2)
  else:raise RuntimeError('portal_readiness_failed')
 except Exception:
  switch(previous);fixed_run(['/usr/bin/systemctl','restart',UNIT]);raise
 old=ROOT/'previous';old.unlink(missing_ok=True);old.symlink_to(previous)
 return {'exit_code':0,'component':'portal','commit':release.name.split('-')[0],'release':str(release),'service':UNIT,'service_state':'active','runtime_user':'hub2hufu','persistent_data':str(DATA),'previous_release':str(previous),'data_preserved':True,'publication_scope':SOURCE,'file_count':len(artifact['files']) if phase=='deploy' else None,'anonymous_navigation_http':200}
