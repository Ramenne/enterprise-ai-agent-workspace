import unittest,importlib.util,pathlib
p=pathlib.Path(__file__).resolve().parents[1]/'source/packages/storage-tiers/src/legacy-source-broker.py'
s=importlib.util.spec_from_file_location('broker',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
loc={'provider':'cos-legacy-shanghai','bucket':m.BUCKET,'key':'tech/unit/v1','version_id':'fixed-v1'}
m.admit_rows=lambda:[{'bucket':m.BUCKET,'key':'tech/unit/v1','versionId':'fixed-v1'}]
id='cfe3f0af-af84-4c63-a0d6-2d0677caaddd'
class ScopeTests(unittest.TestCase):
 def test_copy_is_exact_source_and_operation_owned_target(self):
  policy,bag=m.tier_policy({'locator':loc,'operation':'copy','operation_id':id})
  self.assertTrue(bag['verify_source_bytes']);self.assertEqual(bag['region'],'ap-shanghai')
  self.assertEqual(len(policy['statement']),2)
  self.assertTrue(policy['statement'][0]['resource'][0].endswith('/tech/unit/v1'))
  self.assertTrue(policy['statement'][1]['resource'][0].endswith('/hub2-archive/'+id))
  self.assertNotIn('name/cos:DeleteObject',str(policy));self.assertNotIn('*',str(policy))
 def test_delete_requires_the_exact_admitted_version(self):
  p,_=m.tier_policy({'locator':loc,'operation':'retire_hot'})
  self.assertEqual(p['statement'][0]['condition'],{'string_equal':{'cos:versionid':'fixed-v1'}})
  self.assertEqual(p['statement'][0]['action'],['name/cos:DeleteObject'])
 def test_wrong_bucket_key_or_version_is_refused(self):
  for patch in ({'bucket':'other'},{'key':'personal/not-admitted'},{'version_id':'different'},{'version_id':'null'}):
   with self.assertRaises(m.SourceError):m.tier_policy({'locator':dict(loc,**patch),'operation':'read'})
 def test_restore_and_reconcile_remain_narrow(self):
  p,_=m.tier_policy({'locator':loc,'operation':'restore'});self.assertEqual(p['statement'][0]['action'],['name/cos:PostObjectRestore'])
  p,_=m.tier_policy({'locator':loc,'operation':'head','operation_id':id,'reconcile_target':True});self.assertEqual(len(p['statement']),1);self.assertTrue(p['statement'][0]['resource'][0].endswith('/hub2-archive/'+id))
  with self.assertRaises(m.SourceError):m.tier_policy({'locator':loc,'operation':'copy','operation_id':'../../source'})
 def test_managed_copy_is_fixed_and_not_an_arbitrary_old_key(self):
  target=dict(loc,key='hub2-archive/'+id,version_id='new-fixed')
  _,bag=m.tier_policy({'locator':target,'operation':'read'});self.assertFalse(bag['verify_source_bytes'])
  with self.assertRaises(m.SourceError):m.tier_policy({'locator':dict(target,key='hub2-archive/other'), 'operation':'read'})
if __name__=='__main__':unittest.main()
