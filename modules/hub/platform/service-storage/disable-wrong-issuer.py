"""Stop only the newly created unused issuer in the mistakenly selected account."""
import json,pathlib,sys
from cloud_control import api
p=pathlib.Path('/srv/workspace');d=json.loads(p.read_text())
if d['owner_uin']!='100049209055' or int(d['uin'])!=100053512346 or d['name']!='workspace-app-storage-issuer-v1':raise RuntimeError('owned_unused_issuer_required')
s,r=api(d,'cam','UpdateAccessKey',{'AccessKeyId':d['SecretId'],'Status':'Inactive','TargetUin':int(d['uin'])},'2019-01-16')
result={'state':'unused_issuer_disabled' if not r.get('Error') else 'disable_rejected','owner_uin':d['owner_uin'],'uin':d['uin'],'provider_status':s,'provider_request_id':r.get('RequestId'),'provider_error_code':r.get('Error',{}).get('Code'),'bucket_created_in_this_account':False,'secret_values_in_output':False}
if not r.get('Error'):
 d['enabled']=False;d['canceled_reason']='user_corrected_target_account;Jie_custody_not_Jie_account';p.write_text(json.dumps(d));p.chmod(0o600)
print(json.dumps(result))
