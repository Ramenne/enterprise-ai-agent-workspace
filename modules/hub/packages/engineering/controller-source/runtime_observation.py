"""Fixed, project-readable service/publication observation. No workspace/Git/logs."""
import datetime,re
from urllib.parse import urlsplit
from runtime_state import records,public_probe
UNIT=re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.@-]{0,149}\.service$')
COMMIT=re.compile(r'^[0-9a-f]{12}(?:[0-9a-f]{28})?$')
HUFU='fbe863aa-824f-4688-a24d-bc3398754704'
COMPONENT_UNITS={'portal':'hub2-portal.service','cloud-runtime':'hub2-owned58-typed-executor.service'}
def observation_request(request,identity):
 observer=identity.get('permit_kind')=='project_observation.v1'
 if observer:
  if identity.get('permitted_actions')!=['observe'] or set(request)!={'project_id','action','parameters'} or request.get('action')!='observe' or request.get('parameters')!={} or request.get('project_id')!=identity.get('project_id'):
   raise PermissionError('observe_only_permit_required')
 elif request.get('action')=='observe':raise PermissionError('project_observation_permit_required')
 return observer

def _time(value):
 try:datetime.datetime.fromisoformat(value.replace('Z','+00:00'));return value
 except (AttributeError,TypeError,ValueError):return None

def public_entry(target):
 url=target.get('public_origin')
 try:
  parsed=urlsplit(url or '')
  valid=parsed.scheme=='https' and bool(parsed.hostname) and not parsed.username and not parsed.password
 except ValueError:valid=False
 return {'url':url if valid else None,'state':'registered' if valid else 'not_registered','source':'current_engineering_target'}

def snapshot(project,target,database,service_reader,probe=public_probe):
 stamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
 units={}
 if UNIT.fullmatch(str(target.get('service',''))):units['core']=target['service']
 history=records(database,project)
 publications=[]
 for record in history:
  if record.get('action')not in('deploy','rollback') or record.get('state')!='completed':continue
  result=record.get('result',{})
  if result.get('exit_code',0)!=0 or result.get('error_code') or result.get('state')in('failed','rejected','error'):continue
  component=record.get('component')or'core'
  unit=units.get(component)
  if project==HUFU and component in COMPONENT_UNITS:unit=COMPONENT_UNITS[component];units[component]=unit
  if not unit:continue
  fact=record.get('deployment_fact')or{}
  if fact and (fact.get('project_id')!=project or fact.get('deployment_target')!=unit or fact.get('result')!='completed'):continue
  commit=fact.get('source_commit')or result.get('commit')
  basis='deployment_fact' if fact.get('source_commit') else 'deploy_result' if result.get('commit') else 'unknown'
  if not commit:
   built=next((b for b in history if b.get('action')=='build' and b.get('state')=='completed' and (b.get('component')or'core')==component and b.get('finished_at','')<=record.get('finished_at','') and b.get('result',{}).get('exit_code',0)==0 and not b.get('result',{}).get('error_code') and b.get('result',{}).get('state')not in('failed','rejected','error')),None)
   commit=(built or{}).get('result',{}).get('commit')
   if commit:basis='preceding_successful_build'
  if not COMMIT.fullmatch(str(commit)):commit=None;basis='unknown'
  publications.append({'component':component,'service':unit,'operation_id':record.get('operation_id') if re.fullmatch(r'[0-9a-f-]{36}',str(record.get('operation_id',''))) else None,'source_commit':commit,'source_commit_basis':basis,'commit_unknown_reason':None if commit else 'missing_or_invalid_deployment_commit_and_preceding_successful_build','deployed_at':_time(fact.get('deployed_at')or record.get('finished_at')),'result':'completed','source':'original_deployment_fact' if fact else 'original_completed_deployment_operation'})
 services=[]
 origin=target.get('release_host')or'local'
 for component,unit in units.items():
  reason=None
  try:
   observed=service_reader(unit)
   if origin!='local':
    if not isinstance(observed,dict)or observed.get('runtime_origin')!=origin or observed.get('service')!=unit or observed.get('project_id')!=project:
     state='unknown';reason='registered_remote_target_not_observed'
    else:state=observed.get('state','unknown');reason=observed.get('unknown_reason')
   else:
    state=observed.get('state','unknown')if isinstance(observed,dict)else observed
    if isinstance(observed,dict):reason=observed.get('unknown_reason')
   if state not in('active','inactive','failed','activating','deactivating','reloading'):state='unknown';reason=reason or'registered_unit_not_observed'
  except Exception:state='unknown';reason='registered_runtime_provider_unavailable'
  current=next((x for x in publications if x['service']==unit),None)
  services.append({'component':component,'service':unit,'service_state':state,'runtime_origin':origin,'unknown_reason':reason if state=='unknown'else None,'observed_at':stamp,'deployed_release':current})
 health=probe(target.get('ready_url')) if target.get('ready_url') else {'state':'not_configured','observed_at':stamp}
 safe_health={k:health[k] for k in ['state','http_status','observed_at','database'] if k in health}
 core=next((s for s in services if s['component']=='core'),None)
 return{'state':'read','schema':'workspace.project-observation.v1','project_id':project,'service':core['service'] if core else None,'service_state':core['service_state'] if core else 'unknown','runtime_origin':origin,'unknown_reason':core['unknown_reason'] if core else 'registered_service_not_configured','deployed_release':core['deployed_release'] if core else None,'services':services,'public_entry':public_entry(target),'health':safe_health,'observed_at':stamp,'coverage':{'publication':'original_completed_operations;unknown_if_missing','runtime':'registered_units_and_registered_health_only','workspace':False,'git':False,'logs':False},'permission_checked_by':'hufu_current_project_read_before_and_after_observation'}

def bound_remote_state(project,target,unit,remote):
 origin=target.get('release_host')or'local'
 bound=(origin=='zm-xiaochen' and target.get('deployment_profile')=='python_compat' and unit==target.get('service') and isinstance(remote,dict) and remote.get('state')=='read' and remote.get('project_id',project)==project and isinstance(remote.get('services'),dict) and unit in remote['services'])
 return {'project_id':project,'service':unit,'runtime_origin':origin,'state':remote['services'][unit] if bound else'unknown','unknown_reason':None if bound else'fixed_remote_status_provider_unavailable_or_target_mismatch'}

def apply_namespace_view(view,project,target,remote):
 origin=target.get('release_host')or'local'
 if origin=='local':return view
 selected=bound_remote_state(project,target,target.get('service'),remote)
 state=selected['state']
 if state not in('active','inactive','failed','activating','deactivating','reloading'):state='unknown'
 reason=selected['unknown_reason']or('registered_remote_unit_not_observed' if state=='unknown'else None)
 result={**view,'runtime_origin':origin,'service_state':state,'unknown_reason':reason,'running_service':{**view.get('running_service',{}),'state':state,'runtime_origin':origin,'unknown_reason':reason},'health':{'state':'unknown','runtime_origin':origin,'reason':'registered_remote_health_not_observed','observed_at':view.get('observed_at')},'observation':{'runtime_origin':origin,'provider':'fixed_application_release_status','workspace_origin':'local_engineering_repo'}}
 return result
