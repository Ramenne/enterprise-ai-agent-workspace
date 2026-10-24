"""Fixed platform bootstrap. Root in RAM only; issuer private to core service."""
import json,os,pathlib,sys
from cloud_control import api
os.umask(0o077)
def main():
 b=json.load(sys.stdin);c=b['issuer_credentials'];owner='100029668957';appid='1316920087';base=pathlib.Path('/srv/workspace');base.mkdir(mode=0o700,parents=True,exist_ok=True)
 account_directory=base/'accounts'/owner;account_directory.mkdir(mode=0o700,parents=True,exist_ok=True)
 path=account_directory/'issuer-bootstrap.private.json';state=json.loads(path.read_text()) if path.exists() else {'owner_uin':owner,'appid':appid,'name':'workspace-app-storage-issuer-v1','events':[]}
 def save():
  temp=path.with_suffix('.tmp');temp.write_text(json.dumps(state));os.chmod(temp,0o600);os.replace(temp,path)
 def call(action,payload,effect=False):
  if effect:
   if state.get('pending_effect'):raise RuntimeError('original_issuer_effect_requires_reconciliation')
   state['pending_effect']=action;save()
  status,r=api(c,'cam',action,payload,'2019-01-16');state['events'].append({'action':action,'status':status,'request_id':r.get('RequestId'),'error_code':r.get('Error',{}).get('Code')})
  # Save complete new credential/identity response before clearing uncertainty.
  if effect and not r.get('Error'):state['response_'+action]=r
  state['pending_effect']=None;save()
  if r.get('Error'):raise RuntimeError('issuer_provider_'+r['Error']['Code'])
  return r
 identity=call('GetUserAppId',{})
 if str(identity.get('AppId'))!=appid or str(identity.get('OwnerUin'))!=owner:raise RuntimeError('selected_existing_Jie_account_required')
 if not state.get('response_AddUser'):call('AddUser',{'Name':state['name'],'Remark':'Company approved project storage supply; platform use only','ConsoleLogin':0,'UseApi':1},True)
 bucket='qcs::cos:ap-guangzhou:uid/'+appid+':hub2-app-*'
 policy={'version':'2.0','statement':[{'effect':'allow','action':['name/cam:AddUser','name/cam:GetUser','name/cam:CreatePolicy','name/cam:GetPolicy','name/cam:AttachUserPolicy','name/cam:ListAttachedUserPolicies','name/cam:CreateAccessKey','name/cam:ListAccessKeys','name/cam:UpdateAccessKey'],'resource':['*']},{'effect':'allow','action':['name/cos:HeadBucket','name/cos:GetBucket','name/cos:DeleteBucket','name/cos:GetBucketACL','name/cos:PutBucketACL','name/cos:PutBucketTagging','name/cos:GetBucketTagging','name/cos:PutObject','name/cos:GetObject','name/cos:HeadObject','name/cos:DeleteObject'],'resource':[bucket]},{'effect':'allow','action':['name/cos:PutBucket'],'resource':['*']}]}
 if not state.get('response_CreatePolicy'):call('CreatePolicy',{'PolicyName':state['name']+'-supply','Description':'CAM provision control retained only by platform; COS operations only hub2-app bucket family','PolicyDocument':json.dumps(policy,separators=(',',':'))},True)
 if not state.get('response_AttachUserPolicy'):call('AttachUserPolicy',{'PolicyId':state['response_CreatePolicy']['PolicyId'],'AttachUin':int(state['response_AddUser']['Uin'])},True)
 keys=state['response_AddUser']
 if not keys.get('SecretId') or not keys.get('SecretKey'):
  if not state.get('response_CreateAccessKey'):call('CreateAccessKey',{'TargetUin':int(keys['Uin']),'Description':'Platform project storage supply'},True)
  k=state['response_CreateAccessKey']['AccessKey'];keys={**keys,'SecretId':k['AccessKeyId'],'SecretKey':k['SecretAccessKey']}
 config={'format':'workspace.platform-storage-issuer.v1','organization_id':b['organization_id'],'owner_uin':owner,'appid':appid,'region':'ap-guangzhou','name':state['name'],'uin':state['response_AddUser']['Uin'],'policy_id':state['response_CreatePolicy']['PolicyId'],'SecretId':keys['SecretId'],'SecretKey':keys['SecretKey'],'root_parent_in_config':False,'enabled':True,'parent_source':'zm-center.manage','account_label':'jie (user-specified;existing COS account)','verified_parent_uin':identity.get('Uin'),'recipient':'fixed_core_platform_storage_supply;not_application','authorized_request_gate':'authz.service_storage_supply_prepare;current_real_org_manager_and_approved_bundle','policy':policy}
 output=base/'issuer.private.json';temp=output.with_suffix('.tmp');temp.write_text(json.dumps(config));os.chmod(temp,0o600);os.replace(temp,output)
 print(json.dumps({'state':'platform_storage_issuer_ready','owner_uin':owner,'appid':appid,'name':state['name'],'uin':config['uin'],'policy_id':config['policy_id'],'policy':policy,'private_config_path':str(output),'root_parent_in_config':False,'enabled':True,'parent_source':'zm-center.manage','account_label':'jie (user-specified;existing COS account)','verified_parent_uin':identity.get('Uin'),'application_receives_this_issuer':False,'events':state['events'],'secret_values_in_output':False}))
try:main()
except Exception as e:
 print(json.dumps({'state':'failed','error_code':str(e) if isinstance(e,RuntimeError) else type(e).__name__,'secret_values_in_output':False}));sys.exit(1)
