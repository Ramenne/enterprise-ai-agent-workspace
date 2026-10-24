import importlib.util,json,pathlib,tempfile,unittest,zipfile,os,base64
from unittest.mock import patch
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('pdd_publish',pathlib.Path(__file__).with_name('pdd_publish.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class ReleaseChecks(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.previous=(m.SOURCE,m.STATE);m.SOURCE=pathlib.Path(self.tmp.name)/'source';m.STATE=pathlib.Path(self.tmp.name)/'state';m.STATE.mkdir();m.SOURCE.mkdir();self.f=m.SOURCE/'backend/app/main.py';self.f.parent.mkdir(parents=True);self.f.write_text('original');(m.SOURCE/'customer-data').write_text('keep');self.original=m.file_sha(self.f)
  self.uid_patch=patch('pwd.getpwnam',return_value=SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid()));self.uid_patch.start()
 def tearDown(self):self.uid_patch.stop();m.SOURCE,m.STATE=self.previous;self.tmp.cleanup()
 def bundle(self,name='r1'):
  d=m.release_path(name);row={'path':'backend/app/main.py','sha256':m.digest(b'candidate'),'expected_sha256':self.original}
  with zipfile.ZipFile(d/'bundle.zip','w') as z:z.writestr('manifest.json',json.dumps({'files':[row],'services':['backend']}));z.writestr('files/backend/app/main.py','candidate')
  plan=m.inspect_bundle(name);return {'release_id':name,'archive_sha256':plan['archive_sha256'],'plan_sha256':plan['plan_sha256']}
 def test_apply_backup_rollback_data_preserved(self):
  out=m.apply_release(self.bundle(),restart_fn=lambda n:{'fake_service':n});self.assertEqual(out['state'],'completed');self.assertEqual(self.f.read_text(),'candidate');m.restore(m.STATE/'backups/r1');self.assertEqual(self.f.read_text(),'original');self.assertEqual((m.SOURCE/'customer-data').read_text(),'keep')
 def test_concurrent_change_refused(self):
  p=self.bundle();self.f.write_text('FF-new-change')
  with self.assertRaises(ValueError):m.apply_release(p,restart_fn=lambda n:{})
  self.assertEqual(self.f.read_text(),'FF-new-change')
 def test_failed_health_restores_files(self):
  calls=[]
  def health(names):
   calls.append(names)
   if len(calls)==1:raise RuntimeError('synthetic failure')
  out=m.apply_release(self.bundle(),restart_fn=health);self.assertEqual(out['state'],'failed');self.assertEqual(self.f.read_text(),'original');self.assertEqual(len(calls),2)
 def test_rollback_preserves_newer_edit(self):
  m.apply_release(self.bundle(),restart_fn=lambda n:{});self.f.write_text('newer-edit')
  with self.assertRaises(ValueError):m.restore(m.STATE/'backups/r1')
  self.assertEqual(self.f.read_text(),'newer-edit')
 def test_secret_path_traversal_and_symlink_denied(self):
  for path in ['../etc/shadow','backend/../../etc/shadow','backend/.env','frontend/credentials.json','backend//x.py','frontend/../common/x.py']:
   with self.assertRaises(ValueError):m.source_path(path)
  (m.SOURCE/'backend/app/link.py').symlink_to('/etc/passwd')
  with self.assertRaises(ValueError):m.source_path('backend/app/link.py')
 def test_unlisted_archive_members_denied(self):
  p=self.bundle()
  with zipfile.ZipFile(m.release_path('r1')/'bundle.zip','a') as z:z.writestr('files/backend/extra.py','bad')
  with self.assertRaises(ValueError):m.inspect_bundle('r1')
 def test_no_shell_or_unapproved_migration(self):
  for b in [{'action':'command','parameters':{'operation':'shell','command':'id'}},{'action':'service','parameters':{'operation':'migrate','migration':'drop-all'}},{'action':'service','parameters':{'operation':'restart','service':'mysql'}}]:
   with self.assertRaises(ValueError):m.validate(b)
 def test_upload_replay_is_same_bytes(self):
  b={'action':'command','parameters':{'operation':'upload_chunk','release_id':'upload-test','offset':0,'data_base64':base64.b64encode(b'abc').decode()}}
  self.assertEqual(m.execute(b)['bytes_uploaded'],3);self.assertEqual(m.execute(b)['bytes_uploaded'],3)
  b['parameters']['data_base64']=base64.b64encode(b'xyz').decode()
  with self.assertRaises(ValueError):m.execute(b)
 def test_readiness_waits_for_process_start(self):
  from types import SimpleNamespace
  with patch.object(m.subprocess,'run',return_value=SimpleNamespace(stdout='active\n',returncode=0)),patch('urllib.request.urlopen',side_effect=[OSError('synthetic starting'),SimpleNamespace(close=lambda:None)]) as http,patch.object(m.time,'sleep'):
   out=m.restart(['backend']);self.assertEqual(out['active'],['backend']);self.assertEqual(http.call_count,2)
 def test_exact_token_python_source_allowed_secret_variants_denied(self):
  self.assertEqual(m.source_path('websocket/channel_pdd/core/pdd_token.py'),m.SOURCE/'websocket/channel_pdd/core/pdd_token.py')
  for path in ['websocket/channel_pdd/core/pdd_token.json','websocket/channel_pdd/core/tokens.py','frontend/token.py','websocket/private/pdd_token.py']:
   with self.assertRaises(ValueError):m.source_path(path)

if __name__=='__main__':unittest.main()
