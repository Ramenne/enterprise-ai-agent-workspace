"""Current Hufu project authorization -> fixed PDD production read-only SSH reader."""
import datetime,json,pathlib,subprocess
from pdd_readonly import validate

PROJECT='2b6594cc-3866-4862-a4cf-a46ed0dbba61'
TARGET='pdd-production-readonly'
EXPIRY=datetime.datetime.fromisoformat('2026-10-28T23:59:59+08:00')
REQUEST='1720d33c-983b-4156-a4a7-cd126bf6f3b1'
ALLOWED_ACTORS={'46b19322-b0f9-490c-ad90-47989799fd74','acca6883-4cc2-4805-aefe-29d413ce0abd'}

def dispatch(request,identity):
    p=request['parameters']
    now=datetime.datetime.now(datetime.timezone.utc)
    if request['project_id']!=PROJECT or identity.get('project_id')!=PROJECT or p.get('target')!=TARGET:
        raise PermissionError('production_project_mismatch')
    if identity.get('actor_id') not in ALLOWED_ACTORS or identity.get('runtime_mode')!='read':
        raise PermissionError('production_current_reader_required')
    if now>=EXPIRY or datetime.datetime.fromisoformat(identity['deadline'].replace('Z','+00:00'))<=now:
        raise PermissionError('production_authority_expired')
    # Keep the specific production approval revocable independently of the
    # requester's pre-existing permanent source collaboration qualification.
    q="SELECT state IN ('approved','fulfilled') AND approved_until>clock_timestamp() AND EXISTS (SELECT 1 FROM authz.qualifications q WHERE q.id=r.qualification_id AND q.active AND NOT q.frozen AND (q.expires_at IS NULL OR q.expires_at>clock_timestamp())) FROM authz.engineering_requests r WHERE r.id='"+REQUEST+"'::uuid"
    checked=subprocess.run(['/usr/sbin/runuser','-u','postgres','--','/srv/workspace','-h','/run/workspace-hub2-postgres','-d','hub_core','-X','-Atc',q],capture_output=True,text=True,timeout=3)
    if checked.returncode or checked.stdout.strip()!='t':raise PermissionError('production_approval_not_effective')
    b={'action':p['action'],'parameters':p.get('parameters',{})}
    validate(b)
    cmd=['/usr/bin/ssh','-F','/dev/null','-T','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=/etc/workspace-hub2/runtime/pdd-production.known_hosts','-o','ConnectTimeout=4','-i','/etc/workspace-hub2/runtime/pdd-production.private','root@192.0.2.10',json.dumps(b,separators=(',',':'))]
    r=subprocess.run(cmd,capture_output=True,text=True,timeout=12)
    if r.returncode:return {'state':'failed','error_code':'pdd_production_reader_unreachable','target':TARGET},503
    try:out=json.loads(r.stdout)
    except (ValueError,TypeError):return {'state':'failed','error_code':'pdd_production_invalid_response'},503
    out.update(target=TARGET,caller_actor_id=identity['actor_id'],caller_client_id=identity['client_id'],approval_request_id=REQUEST)
    return out,200 if out.get('state')=='read' else 403 if out.get('state')=='denied' else 503
