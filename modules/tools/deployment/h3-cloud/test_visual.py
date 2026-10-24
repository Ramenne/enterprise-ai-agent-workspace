import hashlib,json,os,sys,tempfile,time,types,unittest,uuid
from unittest.mock import patch
from pathlib import Path
import tools_visual as m
from tools_krea2_cloud import Fault

class VisualTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.env=patch.dict(os.environ,{'KREA2_CLOUD_STATE_DIR':self.tmp.name,'VISUAL_AUTODL_CONFIG':self.tmp.name+'/none.json'});self.env.start()
 def tearDown(self):self.env.stop();self.tmp.cleanup()
 def test_common_contract_rejects_invalid_shape(self):
  for d in ({'prompt':'x','width':520},{'prompt':'x','seed':2**32},{'prompt':'x','surprise':1},{'prompt':'x','lora_strength':float('nan')}):
   with self.assertRaises(Fault):m.validate('visual.image.preview',d)
  m.validate('visual.image.preview',{'prompt':'x','width':1024,'seed':0})
 def test_owner_isolation_and_idempotency(self):
  j=str(uuid.uuid4());self.assertEqual(m.pin('a',j,'digest','autodl'),('autodl',True))
  self.assertEqual(m.pin('a',j,'digest','comfy_cloud'),('autodl',False))
  self.assertIsNone(m.job('b',j))
  with self.assertRaises(Fault):m.pin('a',j,'other','comfy_cloud')
 def test_uuid_case_cannot_create_a_second_provider_binding(self):
  j=str(uuid.uuid4());m.pin('a',j.upper(),'digest','autodl')
  self.assertEqual(m.pin('a',j,'digest','comfy_cloud'),('autodl',False))
  self.assertEqual(m.job('a',j.upper())[1],'autodl')
  old=str(uuid.uuid4())
  with m.connection() as db:db.execute('INSERT INTO visual_jobs VALUES(?,?,?,?,?)',('a',old.upper(),'legacy','comfy_cloud',0))
  self.assertEqual(m.pin('a',old,'legacy','autodl'),('comfy_cloud',False))
 def test_only_controlled_loopback_connector(self):
  p=Path(self.tmp.name)/'config.json';os.environ['VISUAL_AUTODL_CONFIG']=str(p)
  for u in ('https://example.com','http://169.254.169.254','http://127.0.0.1:1/x','http://user@127.0.0.1'):
   p.write_text(json.dumps({'origin':u}))
   with self.assertRaises(Fault):m.config()
 def test_route_requires_lease_shutdown_freshness_and_exact_lora(self):
  c={'origin':'http://127.0.0.1:18293','authorized_actors':['a'],'worker_id':'w','lease_authorized':True,'starts_at':time.time()-5,'ends_at':time.time()+3600,'shutdown_verified_until':time.time()+3700}
  p=Path(self.tmp.name)/'config.json';p.write_text(json.dumps(c));os.environ['VISUAL_AUTODL_CONFIG']=str(p)
  h={'worker_id':'w','observed_at':time.time(),'contract':'krea2_turbo_shared_v1','model_ready':True,'idle':True,'ready_loras':['l']}
  with patch.object(m,'worker',return_value=h):
   self.assertTrue(m.snapshot('a','l')[0]['ready']);self.assertFalse(m.snapshot('a','other')[0]['ready']);self.assertFalse(m.snapshot('b')[0]['ready'])
   h['observed_at']-=100;self.assertFalse(m.snapshot('a')[0]['ready'])
 def test_same_rule_for_cloud_and_autodl_prompt(self):
  with self.assertRaises(Fault):m.image_body({'prompt':'x\n--steps 99'})
  self.assertEqual(m.image_body({'prompt':'plain','demand':'batch','idempotency_key':'a'}),{'prompt':'plain'})
  self.assertIs(type(m.image_body({'prompt':'plain','estimated_credits':60})['estimated_credits']),float)
 def test_offline_autodl_falls_back_before_submission_only(self):
  s,c=m.snapshot('a');self.assertFalse(s['ready'])
  self.assertEqual(m.choose_route('image','batch',s.get('gates',{}))['action'],'route_new_job')
  self.assertEqual(m.choose_route('image','batch',{},original_provider='autodl',submission_state='submission_unknown')['action'],'observe_original_job')
 def test_dispatch_calls_existing_domain_and_preserves_original_submission(self):
  from fastapi import FastAPI,Request,APIRouter
  import contextvars
  app=FastAPI();calls=[];router=APIRouter()
  @router.post('/api/h3-cloud/krea2/preview')
  def preview(body:dict):return {'submitted':False,'workflow':{}}
  @router.post('/api/h3-cloud/krea2/jobs')
  def submit(body:dict,request:Request):calls.append(request.headers['Idempotency-Key']);return {'state':'queued'}
  @router.get('/api/h3-cloud/krea2/jobs/{local_id}')
  def status(local_id:str):return {'id':local_id,'state':'queued'}
  app.include_router(router)
  web=types.ModuleType('web.server');web.app=app
  ctx=types.ModuleType('caller_context');ctx.CURRENT_CALLER=contextvars.ContextVar('test_visual_caller',default={'legacy_subject':'actor'})
  bridge=types.ModuleType('tools_mcp_bridge');bridge.call=lambda *a:None
  with patch.dict(sys.modules,{'web.server':web,'caller_context':ctx,'tools_mcp_bridge':bridge}):m.install()
  dispatch=next(r.endpoint for r in app.routes if getattr(r,'path',None)=='/api/h3-cloud/mcp/{name}')
  a={'prompt':'x','idempotency_key':str(uuid.uuid4()),'demand':'batch','generation_authorized':True,'estimated_credits':1,'budget_credits':2}
  with patch.object(m,'snapshot',side_effect=AssertionError('generation must not probe AutoDL')), patch.object(m.threading,'Thread') as thread:
   first=dispatch('visual.image.generate',a)
   self.assertEqual(first['provider'],'pending')
   with m.connection() as db:db.execute('UPDATE visual_waiting SET deadline=0')
   thread.call_args.kwargs['target']()
   again=dispatch('visual.image.generate',a|{'idempotency_key':a['idempotency_key'].upper()})
  self.assertEqual(again['provider'],'comfy_cloud');self.assertFalse(again['resubmitted']);self.assertEqual(len(calls),1)
  compat=next(r.endpoint for r in app.routes if getattr(r,'path',None)=='/api/h3-cloud/unified/krea2/preview')
  self.assertFalse(compat({'prompt':'x','profile':'turbo'})['submitted'])
  caps=next(r.endpoint for r in app.routes if getattr(r,'path',None)=='/api/h3-cloud/unified/krea2/capabilities')
  self.assertEqual(caps()['provider'],'unified-visual')
  self.assertEqual(caps()['dimensions_multiple_of'],16)
 def test_contract_tool_names_are_unique(self):
  self.assertEqual(len(set(x['name'] for x in m.CONTRACT)),len(m.CONTRACT))
if __name__=='__main__':unittest.main()
