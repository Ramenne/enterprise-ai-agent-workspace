"""Current-member engineering authorization feeds a fixed Baize static publisher."""
import json,pathlib,urllib.request,urllib.error
PROJECT='3527ac31-0643-4f89-a6bd-b1e9768b2e42'
BUILD=r'''
import pathlib,json,base64,subprocess
root=pathlib.Path('public-entry');policy=json.loads((root/'policy.json').read_text());web=root/'web';files={};total=0
if root.is_symlink()or web.is_symlink():raise ValueError('regular_public_source_required')
for f in sorted(web.rglob('*')):
 if f.is_symlink():raise ValueError('public_symlink_not_allowed')
 if not f.is_file():continue
 name=f.relative_to(web).as_posix()
 if any(p.startswith('.')for p in pathlib.PurePosixPath(name).parts):continue
 data=f.read_bytes();total+=len(data)
 if len(data)>4*1024*1024 or total>16*1024*1024:raise ValueError('public_static_size_limit')
 files[name]=base64.b64encode(data).decode()
commit=subprocess.check_output(['/usr/bin/git','rev-parse','HEAD'],text=True).strip()
artifact={'project_id':'3527ac31-0643-4f89-a6bd-b1e9768b2e42','commit':commit,'policy':policy,'files':files}
dist=pathlib.Path('dist');dist.mkdir(exist_ok=True);(dist/'public-entry-artifact.json').write_text(json.dumps(artifact))
print(json.dumps({'state':'built','component':'public-entry','commit':commit,'files':len(files),'bytes':total,'policy':policy,'validation':'static_bytes_only;nginx_full_validation_on_publish'}))
'''
def dispatch(t,phase,parameters,identity,project_process,git):
 if identity['project_id']!=PROJECT or phase not in ['build','deploy','rollback','status']:raise PermissionError('fixed_baize_public_entry_required')
 if phase=='build':
  p=project_process(t,['/usr/bin/python3','-c',BUILD]);return {'exit_code':p.returncode,'output':p.stdout[-10000:]}
 body={'phase':phase,'component':'public-entry'}
 if phase=='deploy':
  if git(t,['status','--porcelain'])['output'].strip():raise ValueError('commit_current_changes_before_deploy')
  commit=git(t,['rev-parse','HEAD'])['output'].strip();p=project_process(t,['/usr/bin/python3','-c',"from pathlib import Path;print(Path('dist/public-entry-artifact.json').read_text())"])
  if p.returncode:raise ValueError('build_current_commit_before_deploy')
  artifact=json.loads(p.stdout)
  if artifact['commit']!=commit or artifact['project_id']!=PROJECT:raise ValueError('build_current_project_commit_before_deploy')
  body['artifact']=artifact
 key=pathlib.Path('/etc/workspace-hub2/runtime/zm-xiaochen.private').read_text().strip()
 packet={'request':{'project_id':PROJECT,'action':'application_release','parameters':body},'identity':{**identity,'application_release_phase':phase,'application_release_component':'public-entry'}}
 req=urllib.request.Request('http://127.0.0.1:14629/execute',data=json.dumps(packet).encode(),headers={'Content-Type':'application/json','x-hub-resource-key':key},method='POST')
 try:
  with urllib.request.urlopen(req,timeout=65)as r:return json.load(r)
 except urllib.error.HTTPError as e:raise ValueError(json.load(e).get('error_code','public_entry_publish_failed'))
