"""Fixed remote dispatch extension for engineering_executor.Handler.
Only original Hufu relay can populate identity.runtime_mode after live SQL check.
"""
import json,pathlib,urllib.request,urllib.error
from executor_bridge import REQUIRED, packet
CONF=pathlib.Path('/etc/workspace-hub2/runtime/routes.json')
ALLOWED={'zm-jiaxin':'http://127.0.0.1:4629/execute','zm-xiaochen':'http://127.0.0.1:14629/execute','zm-main':'http://127.0.0.1:24629/execute'}

def dispatch(request,identity):
    p=request['parameters'];target_id=p.get('target');action=p.get('action')
    config=json.loads(CONF.read_text());t=config['targets'].get(target_id)
    if not t or t['project_id']!=request['project_id']: raise PermissionError('runtime_project_target_required')
    if target_id=='pdd-production-publish':
        from pdd_publish_route import dispatch as pdd_publish_dispatch
        return pdd_publish_dispatch(request,identity)
    if target_id=='pdd-production-readonly':
        from pdd_production_route import dispatch as pdd_dispatch
        return pdd_dispatch(request,identity)
    mode=REQUIRED.get(action)
    if not mode or identity.get('runtime_mode')!=mode: raise PermissionError('runtime_verified_mode_required')
    route=config['hosts'].get(t['host'])
    if not route or route['url']!=ALLOWED.get(t['host']): raise PermissionError('runtime_registered_loopback_host_required')
    keyfile=pathlib.Path(route['key_file'])
    if keyfile.parent!=pathlib.Path('/etc/workspace-hub2/runtime') or keyfile.name!=t['host']+'.private': raise ValueError('invalid_relay_key_location')
    req={'project_id':request['project_id'],'action':action,'parameters':p.get('parameters',{}),'idempotency_key':request.get('idempotency_key')}
    payload=packet(req,identity,[mode],target_id)
    # polling uses status scope; command/service scopes are otherwise exact.
    if action=='operation':payload['identity']['runtime_scopes'][target_id]=['status']
    req=urllib.request.Request(route['url'],data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','x-hub-resource-key':keyfile.read_text().strip()},method='POST')
    try:
        with urllib.request.urlopen(req,timeout=20) as response:return json.load(response),response.status
    except urllib.error.HTTPError as error:return json.load(error),error.code
