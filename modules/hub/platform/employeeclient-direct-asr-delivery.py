"""Reviewed platform action: approved EmployeeClient resource -> direct runtime config."""
import json,pathlib,ssl,urllib.request,subprocess,sys
b=json.load(sys.stdin)
if b['package_id']!='70572722-1cb8-4cb3-a6b6-11eaa235129d':raise RuntimeError('unexpected_resource_package')
def authority(path,body=None):
 req=urllib.request.Request('https://hufu.example.invalid/hub2-preview/hufu'+path,data=None if body is None else json.dumps(body).encode(),headers={'authorization':'Bearer '+b['manager_token'],'content-type':'application/json'})
 with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
me=authority('/v2/me');package=authority('/v2/services/resource-packages/read',{'package_id':b['package_id']})
if me.get('principal_kind')!='member' or me.get('member_role')!='organization_admin' or package.get('state') not in ['approved','partially_delivered','delivered'] or package.get('project_id')!='ad44cc0e-159e-4e0f-a5ca-73d3920240d9':raise RuntimeError('approved_resource_manager_required')
if not any(x['item_id']=='cd46731f-8acc-430a-aa1f-0a8c782152ce' and x['requirements'].get('provider_target_id')=='bailian-beijing-asr' and x['requirements'].get('direct_supplier_call') is True for x in package['resources']):raise RuntimeError('approved_ASR_item_required')
c=json.loads(pathlib.Path('/etc/workspace-hub2/asr-member-runtime74/config.private.json').read_text());a=json.loads(pathlib.Path(c['bootstrap']['bootstrap_file']).read_text());ctx=ssl.create_default_context(cafile=c['bootstrap']['ca_file'])
def call(path,body=None,token=None):
 r=urllib.request.Request(c['bootstrap']['base_url']+'/v1/'+path,data=None if body is None else json.dumps(body).encode(),headers={'content-type':'application/json',**({'x-vault-token':token} if token else {})})
 with urllib.request.urlopen(r,context=ctx,timeout=10) as response:
  data=response.read();return json.loads(data) if data else {}
t=call('auth/'+a.get('auth_mount','approle')+'/login',{'role_id':a['role_id'],'secret_id':a['secret_id']})['auth']['client_token']
try:
 p=call('ops58/data/providers/bailian-asr74',token=t)['data']['data']
 target=c['targets']['bailian-beijing-asr'];key=p.get('api_key')
 if not isinstance(key,str) or not key:raise RuntimeError('supplier_key_unavailable')
 config={'format':'employeeclient.direct-asr.v1','provider_target_id':'bailian-beijing-asr','base_url':target['approved_origin']+'/api/v1','model':target['model'],'region':'cn-beijing','workspace_id':target['workspace_id'],'api_key':key,'input_transport':'input.file_url HTTPS signed/private object URL accessible by supplier;parameters object required','billing':'existing company Bailian workspace;no new subscription or test charge','provider_remaining_quota':'not_reported_by_existing_configuration','rotation_owner':'company_resource_manager;replace this runtime config;application re-read','preserve_existing_run':'4c330332-e046-40b0-a5c0-85a05caf48de','mcp_required_for_calls':False}
 b['secret_values']={'cd46731f-8acc-430a-aa1f-0a8c782152ce':json.dumps(config)}
 r=subprocess.run(['python3','/usr/local/libexec/workspace-resource-delivery.py'],input=json.dumps(b).encode(),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=90)
 if r.returncode:raise RuntimeError('approved_resource_configuration_failed')
 print(r.stdout.decode())
finally:call('auth/token/revoke-self',{},t)
