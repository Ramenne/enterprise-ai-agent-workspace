"""Explicit fixed-component observation; caller authorization stays in Hufu."""
import json,re,subprocess,datetime
from pathlib import Path
HUFU='fbe863aa-824f-4688-a24d-bc3398754704'
BAIZE='3527ac31-0643-4f89-a6bd-b1e9768b2e42'
COMPONENTS={'portal':('hub2-portal.service','/srv/workspace'),'cloud-runtime':('hub2-owned58-typed-executor.service','/srv/workspace')}
def validate_component(project,component):
 allowed={'core'}
 if project==HUFU:allowed.update(['portal','cloud-runtime','asr-runtime','application-gates'])
 if project==BAIZE:allowed.update(['public-entry','background-directory'])
 if component not in allowed:raise ValueError('unknown_project_component')
def observe_component(project,component,action):
 validate_component(project,component)
 if project!=HUFU or component not in COMPONENTS:raise ValueError('fixed_component_required')
 unit,root=COMPONENTS[component];stamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
 if action=='status':
  r=subprocess.run(['/usr/bin/systemctl','is-active',unit],capture_output=True,text=True,timeout=10)
  return {'state':'read','component':component,'service':unit,'service_state':r.stdout.strip()or'unknown','current_release':str(Path(root).resolve()) if Path(root).exists() else None,'observed_at':stamp,'business_ready':'not_verified'}
 if action!='logs':raise ValueError('observation_action_required')
 r=subprocess.run(['/usr/bin/journalctl','-u',unit,'-n','200','--no-pager','-o','json'],capture_output=True,text=True,timeout=10)
 events=[]
 for line in r.stdout.splitlines():
  try:
   row=json.loads(line);message=row.get('MESSAGE','')
   if row.get('SYSLOG_IDENTIFIER')=='systemd':
    m=re.match(r'^(?:'+re.escape(unit)+r': )?(Started|Stopped|Starting|Stopping|Main process exited|Failed with result|Consumed|Scheduled restart job)\b',message)
    if m:events.append({'timestamp':row.get('__REALTIME_TIMESTAMP'),'transition':m.group(1)})
   else:
    data=json.loads(message)
    if not isinstance(data,dict):continue
    safe={k:v for k,v in data.items() if k in('state','error_code','retryable') and (isinstance(v,bool) or isinstance(v,str) and re.fullmatch('[a-z0-9_]{1,100}',v))}
    if safe:events.append({'timestamp':row.get('__REALTIME_TIMESTAMP'),**safe})
  except (ValueError,TypeError):continue
 return {'state':'read','component':component,'service':unit,'events':events,'coverage':'structured_codes_and_systemd_transitions_only','observed_at':stamp}
