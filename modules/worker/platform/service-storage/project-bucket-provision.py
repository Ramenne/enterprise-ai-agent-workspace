"""Platform COS project allocation. No material/workflow row for internal files.
Input is prepared by authenticated manager wrapper; private provider journal is
outside workspace. Never repeats a mutation with unknown provider outcome.
"""
import base64,datetime,hashlib,json,os,pathlib,re,sys,xml.etree.ElementTree as ET
from cloud_control import account,api,cos,xml,PRIVATE
os.umask(0o077)
def main():
 request=json.load(sys.stdin);package=request['approved_package'];item=request['item']
 if package['state'] not in ['approved','partially_delivered','delivered'] or item not in package['resources'] or item['kind']!='storage' or item['requirements'].get('mode')!='object_namespace':raise RuntimeError('approved_object_storage_item_required')
 pid=package['project_id'];sid=package['service_id'];oid=item['item_id']
 import uuid
 for value in [pid,sid,oid,package['package_id']]:uuid.UUID(value)
 intent=request.get('cloud_account',{'appid':'1316920087','owner_uin':'100029668957','region':'ap-guangzhou'})
 region=intent['region'];appid=str(intent['appid']);owner=str(intent['owner_uin'])
 if region!='ap-guangzhou' or not re.fullmatch(r'[0-9]{10}',appid) or not re.fullmatch(r'[0-9]{12}',owner):raise RuntimeError('invalid_registered_storage_account')
 bucket='hub2-app-'+pid[:8]+'-'+appid;host=bucket+'.cos.'+region+'.myqcloud.com'
 directory=PRIVATE/'service-storage-provisioning'
 if owner!='100029668957':directory=directory/owner
 directory=directory/package['package_id'];directory.mkdir(mode=0o700,parents=True,exist_ok=True)
 private=directory/(oid+'.private.json');state=json.loads(private.read_text()) if private.exists() else {'project_id':pid,'service_id':sid,'bucket':bucket,'region':region,'owner_uin':owner,'package_id':package['package_id'],'item_id':oid,'events':[]}
 if any(state[k]!=v for k,v in [('project_id',pid),('service_id',sid),('bucket',bucket)]):raise RuntimeError('storage_binding_identity_conflict')
 public={k:state[k] for k in ['project_id','service_id','bucket','region','owner_uin','package_id','item_id']}
 public.update(format='application-storage-binding-v1',backend='tencent_cos',mode='dedicated_bucket',endpoint='https://'+host,material_catalog_mode='explicit_registration_only',business_file_index='application_owned',default_acl='private',capacity_budget_gib=item['requirements'].get('proposed_capacity_gib',10),capacity_budget_type='planning_threshold;not_provider_hard_quota',credentials_in_output=False)
 def save():
  temp=private.with_suffix('.tmp');temp.write_text(json.dumps(state));os.chmod(temp,0o600);os.replace(temp,private)
 def event(name,status,request_id=None,error=None):
  v={'name':name,'status':status,'request_id':request_id}
  if error:v['error_code']=error
  state['events'].append(v);save()
 def begin(name):
  if state.get('pending_effect'):raise RuntimeError('unknown_effect_requires_original_operation_reconciliation')
  state['pending_effect']=name;save()
 def finish():state['pending_effect']=None;save()
 strategy=item['requirements'].get('credential_strategy','existing_resource')
 if strategy not in ['existing_resource','isolated_application']:raise RuntimeError('unsupported_storage_credential_strategy')
 c=(request.get('resource_credentials') if strategy=='existing_resource' else request.get('issuer_credentials')) or account()
 if not isinstance(c,dict) or not c.get('SecretId') or not c.get('SecretKey'):raise RuntimeError('actual_provider_issuer_required')
 status,identity=api(c,'cam','GetUserAppId',{},'2019-01-16');event('verify_storage_account',status,identity.get('RequestId'),identity.get('Error',{}).get('Code'))
 if identity.get('Error') or str(identity.get('AppId'))!=appid or str(identity.get('OwnerUin'))!=owner:raise RuntimeError('registered_storage_account_required')
 public['storage_manager_uin']=identity.get('Uin')
 tags={'workspace-project-id':pid,'workspace-service-id':sid,'workspace-resource-package':package['package_id'],'workspace-catalog-mode':'explicit-registration'}
 if not state.get('bucket_created'):
  status,h,b=cos(c,host,'HEAD')
  if status==200:raise RuntimeError('preexisting_bucket_not_owned_by_this_allocation')
  if status not in [404]:raise RuntimeError('bucket_creation_preflight_unavailable')
  begin('create_private_bucket');status,h,b=cos(c,host,'PUT',headers={'x-cos-acl':'private'},data=b'')
  event('create_private_bucket',status,h.get('x-cos-request-id'));finish()
  if status not in [200,201]:public.update(state='bucket_creation_rejected',provider_status=status);print(json.dumps(public));return
  state['bucket_created']=True;save()
 if not state.get('tags_written'):
  root=ET.Element('Tagging');tagset=ET.SubElement(root,'TagSet')
  for k,v in tags.items():t=ET.SubElement(tagset,'Tag');ET.SubElement(t,'Key').text=k;ET.SubElement(t,'Value').text=v
  body=ET.tostring(root,encoding='utf-8');begin('bind_bucket_tags');status,h,b=cos(c,host,'PUT',query={'tagging':''},headers={'content-type':'application/xml','content-md5':base64.b64encode(hashlib.md5(body).digest()).decode()},data=body);event('bind_bucket_tags',status,h.get('x-cos-request-id'));finish()
  if status!=204:raise RuntimeError('bucket_binding_tags_not_written')
  state['tags_written']=True;save()
 status,h,b=cos(c,host,'GET',query={'tagging':''});event('verify_bucket_project_tags',status,h.get('x-cos-request-id'))
 actual={t.findtext('Key'):t.findtext('Value') for t in xml(b).findall('.//Tag')} if status==200 else {}
 if actual!=tags:raise RuntimeError('bucket_project_binding_mismatch')
 status,h,b=cos(c,host,'GET',query={'acl':''});event('verify_private_bucket_acl',status,h.get('x-cos-request-id'))
 acl=xml(b) if status==200 else None
 if acl is None or any(g.find('Grantee/URI') is not None or g.findtext('Grantee/ID')!=acl.findtext('Owner/ID') for g in acl.findall('.//Grant')):raise RuntimeError('bucket_private_acl_not_verified')
 public.update(bucket_created=True,private_acl_verified=True,tags_verified=True,tags=tags)
 public['credential_strategy']=strategy
 if strategy=='existing_resource' and state.get('application_config',{}).get('credential_type','').startswith('CAM_API_only') and not state.get('pending_effect'):
  # Keep configurations already delivered by earlier provisioning. The new
  # default removes a gate; it does not rotate another application's keys.
  public.update(state='bucket_and_existing_delivered_config_ready',credential_strategy='preserve_existing_usable_configuration',new_CAM_user_created=False,new_access_key_created=False,private_config_file=str(private),events=state['events']);print(json.dumps(public));return
 if strategy=='existing_resource':
  # A usable approved resource configuration is the delivery. CAM user/key
  # creation is optional, and must never gate this default resource path.
  if state.get('pending_effect'):raise RuntimeError('unknown_effect_requires_original_operation_reconciliation')
  config={**{k:public[k] for k in ['format','backend','project_id','service_id','bucket','region','endpoint','mode','material_catalog_mode','capacity_budget_gib','capacity_budget_type']},'access_key_id':c['SecretId'],'secret_access_key':c['SecretKey'],'credential_type':'existing_resource_configuration;until_provider_rotation','credential_strategy':strategy,'credential_source':'storage.cos.manage','provider_permission_scope':'existing_company_COS_resource_permissions;not_application_bucket_only','rotation_owner':'company_resource_manager','mcp_required_for_calls':False,'application_security_owner':'application_team'}
  if c.get('Token') or c.get('SessionToken'):config['session_token']=c.get('Token',c.get('SessionToken'))
  state['application_config']=config;state['credential_strategy']=strategy;save()
  public.update(state='bucket_and_resource_config_ready',credential_source='storage.cos.manage',provider_permission_scope=config['provider_permission_scope'],new_CAM_user_created=False,new_access_key_created=False,private_config_file=str(private),events=state['events']);print(json.dumps(public));return
 user='hub2-app-'+pid[:8]+'-'+sid[:8];policyname=user+'-objects'
 resource='qcs::cos:'+region+':uid/'+appid+':'+bucket+'/'
 data_actions=['HeadObject','GetObject','PutObject','PutObjectCopy','DeleteObject','InitiateMultipartUpload','UploadPart','UploadPartCopy','ListParts','CompleteMultipartUpload','AbortMultipartUpload']
 policy={'version':'2.0','statement':[{'effect':'allow','action':['name/cos:'+a for a in data_actions],'resource':[resource+'*']},{'effect':'allow','action':['name/cos:HeadBucket','name/cos:GetBucket','name/cos:ListMultipartUploads','name/cos:GetBucketObjectVersions'],'resource':[resource+'*']}]}
 public.update(application_user=user,application_policy=policy)
 if not state.get('app_user'):
  # Fixed owned name, no console access. Denial is a real write result;
  # never infer write denial only from failed GetUser permissions.
  begin('create_application_api_user');status,result=api(c,'cam','AddUser',{'Name':user,'Remark':'Approved Workspace product bucket '+pid,'ConsoleLogin':0,'UseApi':1},'2019-01-16')
  if not result.get('Error'):state['app_user']=result;save()
  event('create_application_api_user',status,result.get('RequestId'),result.get('Error',{}).get('Code'));finish()
  if result.get('Error'):
   public.update(state='bucket_ready_application_key_pending',provider_error_code=result['Error']['Code'],missing_supply_ability='CAM AddUser/CreatePolicy/AttachUserPolicy/CreateAccessKey for application-scoped issuer',provider_request_id=result.get('RequestId'),events=state['events']);print(json.dumps(public));return
  state['app_user']=result;save()
 if not state.get('policy'):
  begin('create_application_bucket_policy');status,result=api(c,'cam','CreatePolicy',{'PolicyName':policyname,'PolicyDocument':json.dumps(policy,separators=(',',':')),'Description':'One approved application bucket only; no bucket/account control'},'2019-01-16')
  if not result.get('Error'):state['policy']=result;save()
  event('create_application_bucket_policy',status,result.get('RequestId'),result.get('Error',{}).get('Code'));finish()
  if result.get('Error'):raise RuntimeError('application_policy_creation_rejected')
  state['policy']=result;save()
 if not state.get('policy_attached'):
  begin('attach_application_bucket_policy');status,result=api(c,'cam','AttachUserPolicy',{'PolicyId':state['policy']['PolicyId'],'AttachUin':int(state['app_user']['Uin'])},'2019-01-16');event('attach_application_bucket_policy',status,result.get('RequestId'),result.get('Error',{}).get('Code'));finish()
  if result.get('Error'):raise RuntimeError('application_policy_attachment_rejected')
  state['policy_attached']=True;save()
 # The AddUser response, including keys, has already been saved privately.
 keys=state['app_user']
 if not keys.get('SecretId') or not keys.get('SecretKey'):
  if not state.get('access_key'):
   begin('create_application_access_key');status,result=api(c,'cam','CreateAccessKey',{'TargetUin':int(keys['Uin']),'Description':'Workspace application bucket '+pid},'2019-01-16')
   if not result.get('Error'):state['access_key']=result['AccessKey'];save()
   event('create_application_access_key',status,result.get('RequestId'),result.get('Error',{}).get('Code'));finish()
   if result.get('Error'):raise RuntimeError('application_access_key_creation_rejected')
   state['access_key']=result['AccessKey'];save()
  keys={'SecretId':state['access_key']['AccessKeyId'],'SecretKey':state['access_key']['SecretAccessKey']}
 config={**{k:public[k] for k in ['format','backend','project_id','service_id','bucket','region','endpoint','mode','material_catalog_mode','capacity_budget_gib','capacity_budget_type']},'access_key_id':keys['SecretId'],'secret_access_key':keys['SecretKey'],'credential_type':'CAM_API_only;until_provider_rotation','rotation_owner':'company_storage_manager'}
 state['application_config']=config;save()
 public.update(state='bucket_and_application_key_ready',private_config_file=str(private),events=state['events']);print(json.dumps(public))
if __name__=='__main__':
 try:main()
 except Exception as e:
  print(json.dumps({'state':'failed','error_code':str(e) if isinstance(e,RuntimeError) else type(e).__name__,'credentials_in_output':False}));sys.exit(1)
