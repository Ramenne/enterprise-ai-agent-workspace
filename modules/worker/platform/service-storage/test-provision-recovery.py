import contextlib,importlib.util,io,json,pathlib,sys,tempfile,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('allocator',pathlib.Path(__file__).with_name('project-bucket-provision.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
PID='ad44cc0e-159e-4e0f-a5ca-73d3920240d9';SID='357b97c5-380c-4017-a332-c747385a7011';PACK='70572722-1cb8-4cb3-a6b6-11eaa235129d';ITEM='585efc9d-95dd-4c7b-aaa0-cfc4912300eb'
class Recovery(unittest.TestCase):
 def run_case(self,mode):
  item={'kind':'storage','item_id':ITEM,'requirements':{'mode':'object_namespace',**({} if mode=='existing_default' else {'credential_strategy':'isolated_application'})}};package={'state':'approved','project_id':PID,'service_id':SID,'package_id':PACK,'resources':[item]};payload={'approved_package':package,'item':item};seen=[];tags=b''
  def api(c,service,action,body,version):
   seen.append(action)
   if action=='GetUserAppId':return 200,{'AppId':1316920087,'OwnerUin':'wrong' if mode=='wrong_owner' else '100029668957','Uin':'100052320739'}
   if action=='AddUser':
    if mode=='unknown_user_effect':raise TimeoutError('fake provider lost response')
    if mode=='denied':return 200,{'Error':{'Code':'AuthFailure.UnauthorizedOperation','Message':'PRIVATE-ERROR-MARKER'}}
    return 200,{'Uin':123456789,'SecretId':'PRIVATE-CHILD-ID','SecretKey':'PRIVATE-CHILD-KEY'}
   if action=='CreatePolicy':
    if mode=='unknown_policy_effect':raise TimeoutError('fake provider lost policy response')
    return 200,{'PolicyId':12345}
   if action=='AttachUserPolicy':return 200,{}
   raise AssertionError(action)
  def cos(c,host,method='GET',path='/',query=None,headers=None,data=None):
   nonlocal tags
   seen.append(method+':'+str(query))
   if method=='HEAD':return (200 if mode=='foreign_bucket' else 404),{},b''
   if query=={'tagging':''}:
    if method=='PUT':tags=data;return 204,{},b''
    return 200,{},tags
   if query=={'acl':''}:
    return 200,{},b'<AccessControlPolicy><Owner><ID>owned</ID></Owner><AccessControlList><Grant><Grantee><ID>owned</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>'
   if method=='PUT':return 200,{},b''
   raise AssertionError((method,query))
  with tempfile.TemporaryDirectory() as d,patch.object(m,'PRIVATE',pathlib.Path(d)),patch.object(m,'account',return_value={'SecretId':'PRIVATE-PARENT-ID','SecretKey':'PRIVATE-PARENT-KEY'}),patch.object(m,'api',side_effect=api),patch.object(m,'cos',side_effect=cos),patch.object(sys,'stdin',io.StringIO(json.dumps(payload))),contextlib.redirect_stdout(io.StringIO()) as output:
   error=None
   try:m.main()
   except Exception as e:error=e
   paths=list(pathlib.Path(d).rglob('*.private.json'));journal=json.loads(paths[0].read_text()) if paths else {}
   # Simulate process resumption with original private journal.
   if mode.startswith('unknown'):
    old_calls=len(seen)
    with patch.object(sys,'stdin',io.StringIO(json.dumps(payload))):
     with self.assertRaisesRegex(RuntimeError,'unknown_effect_requires_original_operation_reconciliation'):m.main()
    self.assertNotIn('AddUser',seen[old_calls:]);self.assertNotIn('CreatePolicy',seen[old_calls:])
   if mode=='preserve_delivered':
    old_calls=len(seen);item['requirements'].pop('credential_strategy')
    with patch.object(sys,'stdin',io.StringIO(json.dumps(payload))):m.main()
    self.assertNotIn('AddUser',seen[old_calls:]);self.assertNotIn('CreatePolicy',seen[old_calls:])
    journal=json.loads(paths[0].read_text())
   text=output.getvalue();self.assertNotIn('PRIVATE-',text)
   return error,journal,seen,text
 def test_default_existing_resource_needs_no_CAM_creation(self):
  e,j,c,t=self.run_case('existing_default');self.assertIsNone(e);self.assertEqual(j['application_config']['secret_access_key'],'PRIVATE-PARENT-KEY');self.assertEqual(json.loads(t)['state'],'bucket_and_resource_config_ready');self.assertNotIn('AddUser',c);self.assertNotIn('CreatePolicy',c);self.assertNotIn('AttachUserPolicy',c);self.assertNotIn('app_user',j)
 def test_previously_delivered_configuration_is_kept(self):
  e,j,c,t=self.run_case('preserve_delivered');self.assertIsNone(e);self.assertEqual(j['application_config']['secret_access_key'],'PRIVATE-CHILD-KEY');self.assertEqual(json.loads(t.strip().splitlines()[-1])['state'],'bucket_and_existing_delivered_config_ready')
 def test_success_outputs_no_secret_and_journals_child(self):
  e,j,c,t=self.run_case('success');self.assertIsNone(e);self.assertEqual(j['application_config']['secret_access_key'],'PRIVATE-CHILD-KEY');self.assertEqual(json.loads(t)['state'],'bucket_and_application_key_ready')
 def test_denial_leaves_private_bucket_without_fabricated_key(self):
  e,j,c,t=self.run_case('denied');self.assertIsNone(e);self.assertEqual(json.loads(t)['state'],'bucket_ready_application_key_pending');self.assertNotIn('app_user',j)
 def test_unknown_user_effect_cannot_create_duplicate(self):
  e,j,c,t=self.run_case('unknown_user_effect');self.assertIsInstance(e,TimeoutError);self.assertEqual(j['pending_effect'],'create_application_api_user')
 def test_child_key_survives_unknown_policy_effect(self):
  e,j,c,t=self.run_case('unknown_policy_effect');self.assertIsInstance(e,TimeoutError);self.assertEqual(j['app_user']['SecretKey'],'PRIVATE-CHILD-KEY');self.assertEqual(j['pending_effect'],'create_application_bucket_policy')
 def test_wrong_owner_has_no_storage_or_cam_mutation(self):
  e,j,c,t=self.run_case('wrong_owner');self.assertRegex(str(e),'registered_storage_account_required');self.assertEqual(c,['GetUserAppId'])
 def test_foreign_bucket_is_not_adopted(self):
  e,j,c,t=self.run_case('foreign_bucket');self.assertRegex(str(e),'preexisting_bucket_not_owned');self.assertNotIn('AddUser',c)
if __name__=='__main__':unittest.main()
