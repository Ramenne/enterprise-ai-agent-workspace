"""Live member/project authorization to PDD-only production release provider."""
import datetime,json,subprocess
from pdd_publish import validate
PROJECT='2b6594cc-3866-4862-a4cf-a46ed0dbba61'
TARGET='pdd-production-publish'
REQUEST='551267dd-9aa9-4e60-ac1d-79fec4730702'
EXPIRY=datetime.datetime.fromisoformat('2026-10-28T23:59:59+08:00')
READERS={'46b19322-b0f9-490c-ad90-47989799fd74','acca6883-4cc2-4805-aefe-29d413ce0abd'}
MODES={'status':'read','read':'read','operation':'read','command':'write','service':'deploy'}
def dispatch(request,identity):
    p=request['parameters'];action=p.get('action');now=datetime.datetime.now(datetime.timezone.utc)
    if request['project_id']!=PROJECT or identity.get('project_id')!=PROJECT or p.get('target')!=TARGET:raise PermissionError('publish_project_mismatch')
    if action not in MODES or identity.get('runtime_mode')!=MODES[action] or identity.get('actor_id') not in READERS:raise PermissionError('current_publish_actor_and_mode_required')
    if now>=EXPIRY or datetime.datetime.fromisoformat(identity['deadline'].replace('Z','+00:00'))<=now:raise PermissionError('publish_authority_expired')
    sql="SELECT state IN ('approved','fulfilled') AND approved_until>clock_timestamp() AND EXISTS(SELECT 1 FROM authz.qualifications q WHERE q.id=r.qualification_id AND q.active AND NOT q.frozen AND (q.expires_at IS NULL OR q.expires_at>clock_timestamp())) FROM authz.engineering_requests r WHERE r.id='"+REQUEST+"'::uuid"
    r=subprocess.run(['/usr/sbin/runuser','-u','postgres','--','/srv/workspace','-h','/run/workspace-hub2-postgres','-d','hub_core','-X','-Atc',sql],capture_output=True,text=True,timeout=3)
    if r.returncode or r.stdout.strip()!='t':raise PermissionError('current_publish_approval_required')
    b={'action':action,'parameters':p.get('parameters',{}),'idempotency_key':request.get('idempotency_key'),'origin':{k:identity[k] for k in ['actor_id','client_id','credential_id']}}
    validate(b)
    raw=json.dumps(b,separators=(',',':'))
    if len(raw)>64000:raise ValueError('publish_request_size_limit')
    r=subprocess.run(['/usr/bin/ssh','-F','/dev/null','-T','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=/etc/workspace-hub2/runtime/pdd-production.known_hosts','-o','ConnectTimeout=4','-i','/etc/workspace-hub2/runtime/pdd-publish.private','root@192.0.2.10',raw],capture_output=True,text=True,timeout=13)
    if r.returncode:return {'state':'failed','error_code':'pdd_publish_provider_unreachable','query_original_operation_before_retry':action=='service'},503
    try:out=json.loads(r.stdout)
    except ValueError:return {'state':'failed','error_code':'pdd_publish_provider_invalid_response'},503
    out.update(target=TARGET,caller_actor_id=identity['actor_id'],caller_client_id=identity['client_id'],approval_request_id=REQUEST)
    return out,202 if out.get('state') in ('queued','running') else 403 if out.get('state')=='denied' else 400 if out.get('state')=='failed' else 200
