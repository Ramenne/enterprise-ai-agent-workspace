import unittest,tempfile,json,sqlite3
from pathlib import Path
from contextlib import closing
from runtime_state import snapshot,CACHE,invalidate_project
class StateTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.repo=self.root/'repo';self.repo.mkdir();self.releases=self.root/'releases';self.releases.mkdir();self.db=self.root/'ops.sqlite';self.t={'repo':str(self.repo),'release_root':str(self.releases),'service':'synthetic.service'}
  with closing(sqlite3.connect(self.db))as c,c:c.execute('CREATE TABLE operations(record TEXT,project TEXT,state TEXT)')
  CACHE.clear()
 def tearDown(self):self.tmp.cleanup()
 def append(self,op,action,result):
  r={'operation_id':op,'action':action,'finished_at':'2026-10-07T02:00:00Z','result':result}
  with closing(sqlite3.connect(self.db))as c,c:c.execute('INSERT INTO operations VALUES(?,?,?)',(json.dumps(r),'p','completed'))
 def state(self,force=False):return snapshot('p',self.t,self.db,lambda t,a:{'exit_code':0,'output':'new-source'if a[0]=='rev-parse'else''},lambda t:{'output':'active'},force=force)
 def test_release_and_new_workspace_are_distinct(self):
  r=self.releases/'old';(r/'dist').mkdir(parents=True);(r/'dist/.engineering-build.json').write_text('{"commit":"old-source"}');(self.releases/'current').symlink_to(r);self.append('deploy1','deploy',{'release':str(r),'commit':'old-source'});s=self.state();self.assertEqual(s['deployed_release']['operation_id'],'deploy1');self.assertEqual(s['workspace_commit'],'new-source');self.assertEqual(s['drift'],[]);self.assertTrue(s['notes'])
 def test_project_runtime_uses_operation_and_registered_artifact(self):
  a=self.repo/'dist-viz';a.mkdir();(self.repo/'dist').mkdir();(self.repo/'dist/.engineering-build.json').write_text('{"commit":"built-source"}');self.t['artifact_path']=str(a);self.append('build1','build',{'commit':'built-source'});self.append('deploy1','deploy',{'exit_code':0});s=self.state();self.assertEqual(s['deployed_release']['source_commit'],'built-source');self.assertEqual(s['current_release'],str(a))
 def test_component_deploy_does_not_replace_core(self):
  r=self.releases/'old';r.mkdir();(self.releases/'current').symlink_to(r);self.append('core','deploy',{'release':str(r),'commit':'core'});self.append('portal','deploy',{'release':'/unrelated/portal','commit':'portal'});self.assertEqual(self.state()['deployed_release']['source_commit'],'core')
 def test_unknown_deployment_is_not_success(self):
  s=self.state();self.assertIsNone(s['deployed_release']);self.assertEqual(s['business_ready']['state'],'not_verified_by_health_probe')
 def test_cache_can_be_refreshed(self):
  a=self.state();b=self.state();c=self.state(force=True);self.assertFalse(a['cache']['hit']);self.assertTrue(b['cache']['hit']);self.assertFalse(c['cache']['hit'])
 def test_cache_isolated_by_identity_and_invalidated_after_effect(self):
  calls=[]
  def view(scope):
   return snapshot('p',self.t,self.db,lambda t,a:(calls.append(a)or{'exit_code':0,'output':'head'if a[0]=='rev-parse'else''}),lambda t:{'output':'active'},cache_scope=scope)
  a=view(('member-a','client-a','credential-a'));self.assertFalse(a['cache']['hit']);n=len(calls)
  self.assertTrue(view(('member-a','client-a','credential-a'))['cache']['hit']);self.assertEqual(len(calls),n)
  self.assertFalse(view(('member-b','client-b','credential-b'))['cache']['hit']);self.assertGreater(len(calls),n)
  invalidate_project('p');self.assertFalse(view(('member-a','client-a','credential-a'))['cache']['hit'])
if __name__=='__main__':unittest.main()
