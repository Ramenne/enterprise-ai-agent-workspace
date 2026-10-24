import os,tempfile,threading,unittest,uuid
from unittest.mock import patch
import visual_queue as q
import tools_visual as v

class QueueTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.env=patch.dict(os.environ,{'KREA2_CLOUD_STATE_DIR':self.tmp.name});self.env.start()
 def tearDown(self):self.env.stop();self.tmp.cleanup()
 def add(self,owner='a',now=100):
  j=str(uuid.uuid4());v.pin(owner,j,'digest','pending');q.enqueue(owner,j,owner,{'prompt':'x','lora_id':'exact-lora'},now);return j
 def test_cloud_claim_is_immediate_even_when_autodl_ready(self):
  j=self.add();self.assertEqual(q.claim('a',j,True,'gpu',100),'comfy_cloud')
  self.assertIsNone(q.slot('gpu'));self.assertEqual(v.job('a',j)[1],'comfy_cloud')
 def test_unknown_submission_remains_pinned(self):
  j=self.add();q.claim('a',j,True,'gpu',100);q.result('a',j,error='timeout')
  self.assertIsNone(q.claim('a',j,True,'gpu',500));self.assertEqual(v.job('a',j)[1],'comfy_cloud')
 def test_independent_members_do_not_contend_for_retired_gpu_slot(self):
  a=self.add('a',100);b=self.add('b',101)
  self.assertEqual(q.claim('a',a,True,'gpu',101),'comfy_cloud');self.assertEqual(q.claim('b',b,True,'gpu',101),'comfy_cloud')
  self.assertIsNone(q.slot('gpu'))
 def test_racing_claims_never_submit_twice(self):
  j=self.add();barrier=threading.Barrier(3);results=[]
  def run():barrier.wait();results.append(q.claim('a',j,True,'gpu',100))
  ts=[threading.Thread(target=run) for _ in range(2)]
  for t in ts:t.start()
  barrier.wait()
  for t in ts:t.join()
  self.assertEqual(results.count('comfy_cloud'),1);self.assertEqual(results.count(None),1)
 def test_waiting_survives_connection_restart_and_owner_isolation(self):
  j=self.add();self.assertEqual(q.get('a',j)['deadline'],100);self.assertIsNone(q.get('b',j));q.enqueue('a',j,'a',{'prompt':'ignored'},now=155)
  self.assertEqual(q.get('a',j)['request']['lora_id'],'exact-lora');self.assertEqual(q.get('a',j)['deadline'],100)
 def test_legacy_waiting_deadline_does_not_delay_new_cloud_policy(self):
  j=self.add()
  with v.connection() as db:db.execute('UPDATE visual_waiting SET deadline=999999 WHERE id=?',(j,))
  self.assertEqual(q.claim('a',j,False,None,100),'comfy_cloud')
 def test_historical_autodl_claim_is_not_migrated(self):
  j=self.add()
  with v.connection() as db:
   db.execute("UPDATE visual_waiting SET state='submitting',provider='autodl' WHERE id=?",(j,))
   db.execute("UPDATE visual_jobs SET provider='autodl' WHERE id=?",(j,))
  self.assertIsNone(q.claim('a',j,True,'gpu',100));self.assertEqual(v.job('a',j)[1],'autodl')
 def test_unknown_submission_cannot_be_returned_to_queue(self):
  j=self.add();q.claim('a',j,True,'gpu',120);q.result('a',j,error='unknown')
  with self.assertRaises(v.Fault):q.unclaim('a',j)
 def test_no_bearer_in_durable_record(self):
  j=self.add();self.assertNotIn('token',q.get('a',j));self.assertEqual(q.public(q.get('a',j))['provider'],'pending')
if __name__=='__main__':unittest.main()
