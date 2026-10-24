"""Read only account identity/CAM availability; never infer account from custodian."""
import json,sys
from cloud_control import api
b=json.load(sys.stdin);c=b['issuer_credentials'];status,r=api(c,'cam','GetUserAppId',{},'2019-01-16')
out={'state':'account_identity_read','source_key':'zm-center.manage','status':status,'appid':r.get('AppId'),'owner_uin':r.get('OwnerUin'),'uin':r.get('Uin'),'provider_request_id':r.get('RequestId'),'error_code':r.get('Error',{}).get('Code'),'cloud_mutation_performed':False,'secret_values_in_output':False}
if not r.get('Error'):
 status,u=api(c,'cam','GetUser',{'Name':'jie'},'2019-01-16');out['jie_user_lookup']={'status':status,'uin':u.get('Uin'),'name':u.get('Name'),'console_login':u.get('ConsoleLogin'),'provider_request_id':u.get('RequestId'),'error_code':u.get('Error',{}).get('Code')}
print(json.dumps(out))
