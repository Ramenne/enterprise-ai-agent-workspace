"""Fixed existing project-runtime tunnel. No user URL/key/path selection."""
import urllib.request,urllib.error,json,pathlib
ALLOWED={'zm-xiaochen':'http://127.0.0.1:14629/execute'}
def execute(request,identity):
    if identity.get('backend')!='sqlite' or identity['project_id']!=request['project_id']:raise PermissionError('database_SQLite_permit_required')
    host=identity.get('host')
    if host=='zm-jiaxin':
        from sqlite_runner import execute as local_execute
        return local_execute(request['parameters'],identity),200
    url=ALLOWED.get(host)
    if not url:raise PermissionError('sqlite_runtime_host_not_registered')
    key=pathlib.Path('/etc/workspace-hub2/runtime/'+host+'.private').read_text().strip()
    req=urllib.request.Request(url,data=json.dumps({'request':request,'identity':identity}).encode(),headers={'Content-Type':'application/json','x-hub-resource-key':key},method='POST')
    try:
        with urllib.request.urlopen(req,timeout=17) as response:return json.load(response),response.status
    except urllib.error.HTTPError as e:return json.load(e),e.code
