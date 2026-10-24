"""Jiaxin-side fixed engineering profile. Uses existing authenticated runtime tunnel."""
import json,pathlib,urllib.request,urllib.error
BUILD_SCRIPT=r'''
import pathlib,ast,json,subprocess
root=pathlib.Path('src');files={}
if root.is_symlink():raise ValueError('project_source_directory_must_not_be_symlink')
for f in sorted(root.glob('*.py')):
 if f.is_symlink() or not f.is_file():raise ValueError('regular_project_source_required')
 text=f.read_text();ast.parse(text,filename=str(f));files[f.name]=text
if not files or len(json.dumps(files).encode())>650000:raise ValueError('bounded_Python_source_required')
dist=pathlib.Path('dist');dist.mkdir(exist_ok=True)
commit=subprocess.check_output(['/usr/bin/git','rev-parse','HEAD'],text=True).strip()
manifest=json.loads(pathlib.Path('.hub/application-profile.json').read_text())
(dist/'application-artifact.json').write_text(json.dumps({'commit':commit,'project_id':manifest['project_id'],'files':files}))
print(json.dumps({'state':'built','commit':commit,'files':sorted(files),'coverage':'syntax_checked_original_project_sources;not_legacy_import_execution'}))
'''
HUFU='fbe863aa-824f-4688-a24d-bc3398754704'
PROFILES={HUFU,'3527ac31-0643-4f89-a6bd-b1e9768b2e42','69197d56-41b0-4c8b-ac19-181f63e87c1f','6aedbc32-3768-47cc-a1e2-ff4297be5be7'}
def dispatch(t,phase,parameters,identity,project_process,git):
 if identity['project_id'] not in PROFILES:raise PermissionError('fixed_application_project_required')
 if parameters.get('component')=='public-entry':
  from baize_public_entry_route import dispatch as public_dispatch
  return public_dispatch(t,phase,parameters,identity,project_process,git)
 shared=identity['project_id']==HUFU
 background=parameters.get('component')=='background-directory'
 if background and identity['project_id']!='3527ac31-0643-4f89-a6bd-b1e9768b2e42':raise PermissionError('fixed_baize_background_component_required')
 script=BUILD_SCRIPT
 if shared:
  script=script.replace("root=pathlib.Path('src')","root=pathlib.Path('packages/application-gates/backend/shared')").replace("manifest=json.loads(pathlib.Path('.hub/application-profile.json').read_text())","manifest={'project_id':"+repr(HUFU)+"}").replace('application-artifact.json','application-shared-artifact.json')
 if background:
  script=script.replace('application-artifact.json','application-background-artifact.json')
 if phase=='build':
  p=project_process(t,['/usr/bin/python3','-c',script])
  return {'exit_code':p.returncode,'output':p.stdout[-10000:]}
 body={'phase':phase,**({'component':'background-directory'}if background else{})}
 if phase=='deploy':
  commit=git(t,['rev-parse','HEAD'])['output'].strip()
  if git(t,['status','--porcelain'])['output'].strip():raise ValueError('commit_current_changes_before_deploy')
  artifact_path='dist/application-background-artifact.json'if background else('dist/application-shared-artifact.json' if shared else 'dist/application-artifact.json')
  exported=project_process(t,['/usr/bin/python3','-c',"from pathlib import Path;print(Path("+repr(artifact_path)+").read_text())"])
  if exported.returncode:raise ValueError('build_current_commit_before_deploy')
  artifact=json.loads(exported.stdout)
  if artifact['commit']!=commit or artifact['project_id']!=identity['project_id']:raise ValueError('build_current_project_commit_before_deploy')
  body['artifact']=artifact
  if background:
   from baize_directory_profile import prepare
   body['private_directory_credential']=prepare(identity)
 if phase=='service':body['operation']=parameters.get('operation')
 request={'project_id':identity['project_id'],'action':'application_release','parameters':body}
 key=pathlib.Path('/etc/workspace-hub2/runtime/zm-xiaochen.private').read_text().strip()
 req=urllib.request.Request('http://127.0.0.1:14629/execute',data=json.dumps({'request':request,'identity':{**identity,'application_release_phase':phase,**({'application_release_component':'background-directory'}if background else{})}}).encode(),headers={'Content-Type':'application/json','x-hub-resource-key':key},method='POST')
 try:
  with urllib.request.urlopen(req,timeout=65) as r:return json.load(r)
 except urllib.error.HTTPError as e:raise ValueError(json.load(e).get('error_code','application_release_failed'))
