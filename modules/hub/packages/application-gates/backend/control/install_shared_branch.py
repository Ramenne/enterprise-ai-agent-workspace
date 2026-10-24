from pathlib import Path
p=Path('/srv/workspace');s=p.read_text()
needle='def perform(t,a,p,identity):\n'
addition=" if identity['project_id']=='fbe863aa-824f-4688-a24d-bc3398754704' and p.get('component')=='application-gates':\n  if a not in ['build','deploy','rollback']:raise ValueError('shared_application_component_build_deploy_rollback_only')\n  from application_release_route import dispatch\n  return dispatch(t,a,p,identity,project_process,git)\n"
if addition not in s:s=s.replace(needle,needle+addition)
p.write_text(s)
