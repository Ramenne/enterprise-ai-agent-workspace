"""Current project runtime view. Deployment facts come from engineering's
existing operation journal; process/HTTP observations are time-bound views.
This module is called only after the current Hufu project authorization.
"""
import datetime,json,sqlite3,urllib.request,urllib.error,threading,time
from pathlib import Path
from contextlib import closing
CACHE={}
CACHE_LOCK=threading.Lock()
READS_ONLY=True

def utc():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def json_file(path):
 try:return json.loads(Path(path).read_text())
 except (OSError,ValueError):return None

def records(database,project):
 if not Path(database).is_file():return []
 try:
  with closing(sqlite3.connect('file:'+str(database)+'?mode=ro',uri=True,timeout=3))as con:
   rows=con.execute("SELECT record FROM operations WHERE project=? AND state=? AND json_extract(record,'$.action') IN('deploy','rollback','build','maintenance') ORDER BY rowid DESC",(project,'completed')).fetchall()
  return sorted([json.loads(row[0]) for row in rows],key=lambda r:r.get('finished_at',''),reverse=True)
 except (sqlite3.Error,ValueError):return []

def component_matches(record,t):
 component=record.get('component') or record.get('parameters',{}).get('component')
 if component and component!='core':return False
 result=record.get('result',{});release=result.get('release')
 if release and t.get('release_root'):
  try:return Path(release).is_relative_to(Path(t['release_root']))
  except (ValueError,TypeError):return False
 return True

def public_probe(url):
 stamp=utc()
 if not url:return {'state':'not_configured','observed_at':stamp}
 try:
  with urllib.request.urlopen(url,timeout=3)as response:
   raw=response.read(1024);extra={}
   try:
    body=json.loads(raw);extra={'database':body.get('database')} if isinstance(body,dict)and body.get('database') in('connected','disconnected') else {}
   except (ValueError,UnicodeError):pass
   return {'state':'reachable','http_status':response.status,'url':url,'observed_at':stamp,**extra}
 except urllib.error.HTTPError as e:
  return {'state':'authentication_required' if e.code in (401,403) else 'http_error','http_status':e.code,'url':url,'observed_at':stamp}
 except Exception as e:return {'state':'unknown','reason':type(e).__name__,'url':url,'observed_at':stamp}

def invalidate_project(project):
 with CACHE_LOCK:
  for key in list(CACHE):
   if key[0]==project:CACHE.pop(key,None)

def snapshot(project,t,database,git_reader,service_reader,force=False,ttl=3,cache_scope=()):
 # Only project facts are cached. The calling Hufu route authenticates and
 # checks the caller's current qualification before every cache lookup.
 key=(project,str(t.get('repo')),str(t.get('release_root')),t.get('service'),t.get('release_host')or'local',tuple(cache_scope))
 with CACHE_LOCK:
  cached=CACHE.get(key)
  if not force and cached and cached[0]>time.monotonic():return {**cached[1],'cache':{'hit':True,'permission_checked_by':'hufu_before_provider_call'}}
 repo=Path(t['repo']);root=Path(t['release_root']);link=root/'current';live=link.resolve() if link.exists() else None
 workspace=git_reader(t,['rev-parse','HEAD']);commit=workspace.get('output','').strip() if workspace.get('exit_code',1)==0 else None
 dirty=git_reader(t,['status','--porcelain']);changed=dirty.get('exit_code',1)==0 and bool(dirty.get('output','').strip())
 history=records(database,project)
 eligible=[r for r in history if component_matches(r,t)and r.get('result',{}).get('exit_code',0)==0 and not r.get('result',{}).get('error_code') and r.get('result',{}).get('state') not in('failed','rejected','error')]
 builds=[r for r in eligible if r.get('action')=='build']
 deployments=[r for r in eligible if r.get('action')in('deploy','rollback')]
 artifact=live or (Path(t['artifact_path']) if t.get('artifact_path') else None)
 marker=json_file(artifact/'dist/.engineering-build.json') if live else None
 if marker is None and artifact:marker=json_file(repo/'dist/.engineering-build.json')
 deployed=None
 for r in deployments:
  result=r.get('result',{});location=result.get('release') or result.get('active_release')
  if live and location and Path(location).resolve()!=live:continue
  if live and not location:continue
  built=None
  if not result.get('commit'):
   built=next((b for b in builds if b.get('finished_at','')<=r.get('finished_at','')),None)
  source_commit=result.get('commit') or (built or {}).get('result',{}).get('commit')
  deployed={'release_id':r['operation_id'],'operation_id':r['operation_id'],'project_id':project,'source_commit':source_commit,'artifact_path':str(location or artifact) if (location or artifact) else None,'deployment_target':t.get('service'),'deployed_at':r.get('finished_at'),'source':'engineering.operations.sqlite','result':'completed','component':r.get('component')or'core','source_commit_basis':'deploy_result' if result.get('commit') else 'preceding_successful_build' if source_commit else 'unknown'}
  break
 if deployed is None and live:
  # Existing release symlinks remain useful observations. Lack of a recorded
  # operation is explicit; it does not become a fabricated deployment receipt.
  deployed={'release_id':live.name,'project_id':project,'operation_id':None,'source_commit':(marker or {}).get('commit'),'artifact_path':str(live),'deployment_target':t.get('service'),'source':'current_release_artifact','result':'observed;operation_unknown','source_commit_basis':'artifact_marker' if marker else 'unknown'}
 stamp=utc();service=service_reader(t);state=service.get('output','unknown').strip()or'unknown'
 drift=[];notes=[]
 maintenance=[]
 for r in history:
  if r.get('action')!='maintenance':continue
  fact=r.get('maintenance_fact',{})
  if fact.get('release')!=str(live):continue
  modules=[]
  for m in fact.get('modules',[]):
   path=Path(m.get('path',''))
   if not live or not path.is_relative_to(live) or path.suffix not in('.mjs','.js','.py'):continue
   try:actual=__import__('hashlib').sha256(path.read_bytes()).hexdigest()
   except OSError:actual=None
   modules.append({'path':str(path),'recorded_sha256':m.get('after_sha256'),'current_sha256':actual,'matches_record':actual==m.get('after_sha256')})
  maintenance.append({'operation_id':r.get('operation_id'),'observed_at':r.get('finished_at'),'modules':modules,'source':'engineering.operations.sqlite'})
 if maintenance:drift.append({'kind':'runtime_maintenance_after_formal_deployment','operation_ids':[m['operation_id'] for m in maintenance],'coverage':'selected_maintained_modules;formal_deployment_commit_unchanged'})
 if deployed and marker and deployed.get('source_commit')and marker.get('commit')!=deployed['source_commit']:drift.append({'kind':'runtime_artifact_differs_from_last_deployment','recorded_commit':deployed['source_commit'],'artifact_commit':marker.get('commit')})
 if deployments and live:
  last=deployments[0].get('result',{}).get('release')
  if last and Path(last).resolve()!=live:notes.append('current_symlink_is_an_older_release;rollback_or_manual_change_needs_its_operation')
 if commit and deployed and deployed.get('source_commit')and commit!=deployed['source_commit']:notes.append('workspace_differs_from_deployed_source;normal_development_or_rollback')
 observed={'state':'read','schema':'workspace.runtime-state.v1','project_id':project,'service':t.get('service'),'service_state':state,'partition':{'os_user':t.get('os_user'),'workspace':str(repo),'filesystem':'private_mount_namespace','other_projects':'hidden'},'git':workspace,'workspace':str(repo),'workspace_commit':commit,'workspace_dirty':changed,'build':{'commit':(builds[0].get('result',{}).get('commit') if builds else None),'operation_id':(builds[0].get('operation_id')if builds else None),'artifact_marker':{k:v for k,v in (marker or {}).items()if k in('commit','built_at','artifact_path','workspace_dirty','component')}},'current_release':str(artifact)if artifact else None,'deployed_release':deployed,'running_service':{'state':state,'unit':t.get('service'),'observed_at':stamp},'health':public_probe(t.get('ready_url')),'public_entry':{'url':t.get('public_url'),'state':'not_observed_by_engineering;MCP_or_portal_probes_public_origin'},'business_ready':{'state':'not_verified_by_health_probe'},'drift':drift,'runtime_maintenance':maintenance,'notes':notes,'observed_at':stamp,'expires_at':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=ttl)).isoformat(),'cache':{'hit':False,'permission_checked_by':'hufu_before_provider_call'}}
 with CACHE_LOCK:CACHE[key]=(time.monotonic()+ttl,observed)
 return observed
