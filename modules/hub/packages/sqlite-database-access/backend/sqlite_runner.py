"""Root dispatches one fixed worker; SQL itself runs as registered project service UID.
This identity is distinct from command workspace UID. DB is not command-mounted.
"""
import json,pathlib,subprocess,uuid
CONF=pathlib.Path('/etc/workspace-hub2/runtime/sqlite-targets.json')
ROOT='/srv/workspace'
WORKER='/srv/workspace'
def execute(request,identity):
    if identity.get('backend')!='sqlite':raise PermissionError('database_backend_permit_required')
    t=json.loads(CONF.read_text())[identity['target_id']]
    if request['project_id']!=t['project_id'] or identity['project_id']!=t['project_id']:raise PermissionError('database_project_mismatch')
    source=pathlib.Path(t['path']);readonly=['/usr:/usr','/bin:/bin','/lib:/lib','/lib64:/lib64',WORKER+':/worker.py']
    readonly=[x for x in readonly if pathlib.Path(x.split(':')[0]).exists()]
    args=['/usr/bin/systemd-run','--quiet','--wait','--pipe','--collect','--unit=hufu-sqlite-'+uuid.uuid4().hex,
          '-p','User='+t['os_user'],'-p','Group='+t['os_user'],'-p','RootDirectory='+ROOT,
          '-p','ProtectSystem=strict','-p','PrivateTmp=yes','-p','PrivateDevices=yes',
          '-p','NoNewPrivileges=yes','-p','CapabilityBoundingSet=','-p','RestrictSUIDSGID=yes',
          '-p','InaccessiblePaths=/proc /sys','-p','ProtectHome=yes','-p','RuntimeMaxSec=12s',
          '-p','BindReadOnlyPaths='+' '.join(readonly),
          '-p','BindPaths='+str(source.parent)+':/database '+t['receipts']+':/receipts',
          '-p','ReadWritePaths=/database /receipts','-p','UMask=0077',
          '/usr/bin/python3','/worker.py']
    packet={'request':request,'identity':identity,'target':{'filename':source.name,'project_id':t['project_id']}}
    p=subprocess.run(args,input=json.dumps(packet),text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15)
    try:result=json.loads(p.stdout)
    except ValueError:raise RuntimeError('sqlite_project_worker_unavailable;no_SQL_or_rows_logged')
    return result
