"""Fixed platform installer for the existing Baize service; no scope expansion."""
import json,sys,pathlib,urllib.request,hashlib,subprocess
ACTOR='9567d1c6-ae3c-4ee9-a9cd-55e83bd697f3';PARENT='035360c8-6dec-4456-a138-cbb41746f7b6';CLIENT='712aeaec-7da7-42b0-aa59-0961ce66dfa7';PROJECT='3527ac31-0643-4f89-a6bd-b1e9768b2e42';ACTIONS=['mem.process','mem.read','mem.upload','v8.project.read'];KEY='baize-existing-service-processing-child-20261008-v2-existing-actions';BASE='hub2/data/hufu/vault2/serviceprofiles/'+ACTOR;DEST=BASE+'/baize-processing-v2'
def api(token,path,body=None,key=None):
 headers={'authorization':'Bearer '+token,'content-type':'application/json'}
 if key:headers['idempotency-key']=key
 req=urllib.request.Request('http://127.0.0.1:4611'+path,data=json.dumps(body).encode()if body is not None else None,headers=headers,method='POST'if body is not None else'GET')
 try:
  with urllib.request.urlopen(req,timeout=20)as r:return json.loads(r.read())
 except urllib.error.HTTPError as e:
  d=json.loads(e.read());raise RuntimeError('native_API_'+str(e.code)+':'+str(d.get('error_code','rejected')))from None
request=json.load(sys.stdin);operator=api(request['token'],'/v2/me');assert operator['actor_id']=='46b19322-b0f9-490c-ad90-47989799fd74'and operator['member_role']=='organization_admin'
sys.path.insert(0,'/srv/workspace');from api import Bao
bao=Bao();machine=json.loads(pathlib.Path('/etc/workspace-hub2/bootstrap/hufu/machine.private.json').read_text());holder=bao.expect('auth/approle/login','POST',{'role_id':machine['role_id'],'secret_id':machine['secret_id']})['auth']['client_token']
try:
 code,p=bao.call(BASE,token=holder);assert code==200;parent=p['data']['data'];me=api(parent['token'],'/v2/me');assert me['principal_kind']=='service'and me['actor_id']==ACTOR and me['client_id']==CLIENT and me['credential_id']==PARENT;assert set(ACTIONS)<=set(me['client_actions'])
 code,p=bao.call(DEST,token=holder)
 if code==404:
  issued=api(parent['token'],'/v2/credentials/create',{'label':'Baize current processing, existing parent actions only','actions':ACTIONS,'until_revoked':True},KEY);assert issued['state']=='committed'and issued['credential_delivery']=='available';child={'token':issued['credential'],'actor_id':ACTOR,'client_id':issued['client_id'],'credential_id':issued['credential_id'],'operation_id':issued['operation_id'],'purpose':'fixed_Baize_native_processing_existing_actions_only'};check=api(child['token'],'/v2/me');assert check['parent_credential_id']==PARENT and check['scope_filters']==me['scope_filters']and set(check['client_actions'])==set(ACTIONS);bao.expect(DEST,'POST',{'options':{'cas':0},'data':child},holder)
 elif code==200:child=p['data']['data']
 else:raise RuntimeError('controlled_child_profile_unavailable')
 check=api(child['token'],'/v2/me');assert check['actor_id']==ACTOR and check['parent_credential_id']==PARENT and check['scope_filters']==me['scope_filters']and set(check['client_actions'])==set(ACTIONS)
 print(json.dumps({**child,'actions':ACTIONS}))
finally:bao.call('auth/token/revoke-self','POST',{},holder)
