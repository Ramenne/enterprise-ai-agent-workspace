#!/usr/bin/python3
"""Fixed control-plane patch installer; run as root on specified known host."""
from pathlib import Path
import json,sys
if sys.argv[1]=='jiaxin':
 p=Path('/srv/workspace');s=p.read_text();needle='def perform(t,a,p,identity):\n'
 addition=" if t.get('deployment_profile')=='python_compat' and a in ['build','deploy','rollback','service']:\n  from application_release_route import dispatch\n  return dispatch(t,a,p,identity,project_process,git)\n"
 if addition not in s:s=s.replace(needle,needle+addition)
 prefix="import sys\nsys.path.insert(0,'/srv/workspace')\n"
 if prefix not in s:s=s.replace('import os,json,sqlite3',prefix+'import os,json,sqlite3',1)
 needle="   if a=='status':return self.respond(status(t))"
 addition="   if t.get('deployment_profile')=='python_compat' and a in ['status','logs']:\n    from application_release_route import dispatch\n    out=dispatch(t,a,p,i,project_process,git)\n    if 'output' in out:out['output']=scrub(out['output'])\n    return self.respond(out)\n"
 if addition not in s:s=s.replace(needle,addition+needle)
 p.write_text(s)
 p=Path('/etc/workspace-hub2/engineering/targets.json');targets=json.loads(p.read_text())
 for pid,slug,unit in [('3527ac31-0643-4f89-a6bd-b1e9768b2e42','baize','hufu2-baize-compat.service'),('69197d56-41b0-4c8b-ac19-181f63e87c1f','tools','hufu2-tools-compat.service'),('6aedbc32-3768-47cc-a1e2-ff4297be5be7','jiling','hufu2-jiling-compat.service')]:
  targets[pid].update(build_profile='python_compat',deployment_profile='python_compat',deployment_enabled=True,service=unit,services=[unit]+(['hufu2-jiling-ws.service'] if slug=='jiling' else []),release_host='zm-xiaochen',release_root='/srv/workspace'+slug,source_path='src',runtime_uid={'baize':'baize','tools':'fgb-collector-poc','jiling':'jiling-relay'}[slug])
 p.write_text(json.dumps(targets,indent=2));p.chmod(0o600)
elif sys.argv[1]=='xiaochen':
 p=Path('/srv/workspace');s=p.read_text();needle="            if r['action']=='database_sqlite':"
 addition="            if r['action']=='application_release':\n                from application_release import execute\n                return self.reply(execute(r,i))\n"
 if addition not in s:s=s.replace(needle,addition+needle)
 p.write_text(s)
else:raise ValueError('fixed_host_required')
