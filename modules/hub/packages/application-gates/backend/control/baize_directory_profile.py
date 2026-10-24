"""Fixed existing-service child issuance; manager first issue, permit-based reuse.
Secrets stay in Bao and the authenticated internal 14629 packet, never API output.
"""
import json,os,pathlib,subprocess,sys,urllib.request,uuid
PROJECT='3527ac31-0643-4f89-a6bd-b1e9768b2e42'
ACTOR='9567d1c6-ae3c-4ee9-a9cd-55e83bd697f3'
PARENT='035360c8-6dec-4456-a138-cbb41746f7b6'
PARENT_CLIENT='712aeaec-7da7-42b0-aa59-0961ce66dfa7'
CAPABILITY='hufu.baize.members.read'
PARENT_PATH='hub2/data/hufu/vault2/serviceprofiles/'+ACTOR
PATH=PARENT_PATH+'/baize-directory'
ISSUE_KEY='v51-baize-owned-directory-child-20261007-v1'
PG=['runuser','-u','postgres','--','/srv/workspace','-h','/run/workspace-hub2-postgres','-d','hub_core','-X','-qAt','-v','ON_ERROR_STOP=1']
def quoted(value):return "'"+str(value).replace("'","''")+"'"
def query(sql):
    result=subprocess.run(PG,input=sql,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
    if result.returncode:raise RuntimeError('fixed_service_profile_database_rejected')
    return result.stdout.strip()
def native_api(token,path,body=None,key=None):
    if not isinstance(token,str)or not token.startswith('hub2_')or len(token)>512 or any(c.isspace()for c in token):raise RuntimeError('bare_service_profile_credential_required')
    headers={'Content-Type':'application/json','Authorization':'Bearer '+token}
    if key:headers['Idempotency-Key']=key
    request=urllib.request.Request('https://hufu.example.invalid/'+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method='GET'if body is None else'POST')
    try:
        with urllib.request.urlopen(request,timeout=8)as response:
            data=response.read(65537)
            if len(data)>65536:raise RuntimeError('service_issuance_response_too_large')
        return json.loads(data)
    except Exception:raise RuntimeError('current_service_issuance_API_failed')from None

def prepare(identity):
    if os.geteuid()!=0 or identity.get('project_id')!=PROJECT:raise PermissionError('fixed_baize_platform_controller_required')
    for key in ('actor_id','client_id','credential_id'):uuid.UUID(identity[key])
    check="""SELECT jsonb_build_object('issuer',authz.authenticate(k.token_hash),'manager',authz.engineering_can_manage(k.token_hash,%s::uuid),'service',EXISTS(SELECT FROM authz.principals s WHERE s.id=%s::uuid AND s.active AND s.kind='service' AND s.trusted_source='verified_legacy_service_registry:baize-worker'),'binding',EXISTS(SELECT FROM vault2.service_bindings b WHERE b.principal_id=%s::uuid AND b.legacy_subject='baize-worker'),'parent',authz.family_valid(%s::uuid),'qualification',EXISTS(SELECT FROM authz.qualifications q WHERE q.principal_id=%s::uuid AND q.project_id=%s::uuid AND authz.qualification_deadline(q.id,q.principal_id,q.project_id,%s,jsonb_build_object('project_id',q.project_id))>clock_timestamp())) FROM authz.credentials k WHERE k.id=%s::uuid;"""%tuple(map(quoted,[PROJECT,ACTOR,ACTOR,PARENT,ACTOR,PROJECT,CAPABILITY,identity['credential_id']]))
    state=json.loads(query(check));issuer=state.get('issuer',{})
    if issuer.get('actor_id')!=identity['actor_id']or issuer.get('client_id')!=identity['client_id']or not all(state.get(k)for k in ('service','binding','parent','qualification')):raise PermissionError('current_verified_service_registration_authority_required')
    # The surrounding fixed dispatcher has already admitted the actual current
    # Baize engineering permit. Reuse does not demand management again.
    sys.path.insert(0,'/srv/workspace')
    from api import Bao
    api=Bao();machine=json.loads(pathlib.Path('/etc/workspace-hub2/bootstrap/hufu/machine.private.json').read_text())
    holder=api.expect('auth/approle/login','POST',{'role_id':machine['role_id'],'secret_id':machine['secret_id']})['auth']['client_token']
    try:
        code,stored=api.call(PATH,token=holder)
        if code==404:
            if not state.get('manager'):raise PermissionError('initial_owned_service_profile_requires_current_manager')
            # Never issue a second child after a lost profile/unknown outcome.
            if query("SELECT EXISTS(SELECT FROM authz.credential_receipts WHERE principal_id="+quoted(ACTOR)+"::uuid AND idempotency_key="+quoted(ISSUE_KEY)+");")=='t':raise RuntimeError('existing_service_child_receipt_requires_profile_recovery')
            details=json.dumps({'source':'current_manager_approved_existing_service_directory_capability','service_principal_id':ACTOR,'project_id':PROJECT,'added_action':CAPABILITY,'qualification_id':'38945883-111f-48de-a5d5-0012002f2dd9','other_actions_filters_qualifications':'unchanged'})
            sql="""BEGIN;
UPDATE authz.clients c SET actions=ARRAY(SELECT DISTINCT a FROM unnest(c.actions||ARRAY[%s])a ORDER BY a),epoch=epoch+1 WHERE c.id=%s::uuid AND c.principal_id=%s::uuid AND c.active AND NOT %s=ANY(c.actions);
DO $issuer$ BEGIN IF NOT EXISTS(SELECT FROM authz.clients c WHERE c.id=%s::uuid AND c.principal_id=%s::uuid AND c.active AND %s=ANY(c.actions))THEN RAISE EXCEPTION 'existing_worker_issuer_binding_required';END IF;END $issuer$;
INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details)SELECT %s::uuid,%s::uuid,'authz','service_directory.issuer_capability',%s::uuid,%s::jsonb WHERE NOT EXISTS(SELECT FROM evidence.audit WHERE action='service_directory.issuer_capability'AND aggregate_id=%s::uuid);
COMMIT;"""%tuple(map(quoted,[CAPABILITY,PARENT_CLIENT,ACTOR,CAPABILITY,PARENT_CLIENT,ACTOR,CAPABILITY,identity['actor_id'],identity['client_id'],PARENT_CLIENT,details,PARENT_CLIENT]))
            query(sql)
            parent_code,parent_stored=api.call(PARENT_PATH,token=holder)
            if parent_code!=200:raise RuntimeError('owned_service_parent_profile_unavailable')
            original=parent_stored['data']['data']
            parent_token=original['token'];parent_identity=native_api(parent_token,'/v2/me')
            if parent_identity.get('principal_kind')!='service'or parent_identity.get('actor_id')!=ACTOR or parent_identity.get('client_id')!=PARENT_CLIENT or parent_identity.get('credential_id')!=PARENT:raise PermissionError('actual_owned_service_parent_required')
            # Existing native API generates child IDs, inherited filter/parent,
            # deterministic recoverable secret and the real credential receipt.
            issued=native_api(parent_token,'/v2/credentials/create',{'label':'Baize fixed background directory','actions':[CAPABILITY],'resource_selector':{'version':1,'kind':'projects','project_ids':[PROJECT]},'until_revoked':True},ISSUE_KEY)
            if issued.get('state')!='committed'or issued.get('credential_delivery')!='available':raise RuntimeError('owned_directory_child_not_delivered')
            data={'token':issued['credential'],'actor_id':ACTOR,'client_id':issued['client_id'],'credential_id':issued['credential_id'],'operation_id':issued['operation_id'],'purpose':'fixed_Baize_public_member_directory_only','lifecycle':'until_revoked'}
            api.expect(PATH,'POST',{'options':{'cas':0},'data':data},holder)
        elif code==200:data=stored['data']['data']
        else:raise RuntimeError('owned_directory_profile_unavailable')
        if data.get('actor_id')!=ACTOR or data.get('purpose')!='fixed_Baize_public_member_directory_only'or data.get('lifecycle')!='until_revoked':raise RuntimeError('owned_directory_profile_binding_mismatch')
        cid=str(uuid.UUID(data['client_id']));kid=str(uuid.UUID(data['credential_id']));token=data['token']
        child=native_api(token,'/v2/me')
        if child.get('principal_kind')!='service'or child.get('actor_id')!=ACTOR or child.get('client_id')!=cid or child.get('credential_id')!=kid or child.get('parent_credential_id')!=PARENT or child.get('client_actions')!=[CAPABILITY]or child.get('scope_filters')!=[{'project_ids':[PROJECT]}]:raise PermissionError('actual_scoped_service_child_required')
        # Private internal packet only. The runtime receiver/API result returns
        # IDs, counts and file mode; never this object or the raw secret.
        return {'token':token,'actor_id':ACTOR,'client_id':cid,'credential_id':kid}
    finally:api.call('auth/token/revoke-self','POST',{},holder)
