import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid
import tools_minimax_audio as a

class AudioTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, MINIMAX_AUDIO_STATE_DIR=self.tmp.name)
        self.env.start()
        self.id = str(uuid.uuid4())
    def tearDown(self):
        self.env.stop(); self.tmp.cleanup()
    def test_credit_source_and_budget_are_explicit(self):
        b = dict(generation_authorized=True, estimated_cost_cny=.1, max_cost_cny=1)
        with self.assertRaises(a.Fault) as err: a.authorize_spend(b)
        self.assertEqual(err.exception.status, 409)
        b.update(billing_source='official_api', billing_acknowledged=True)
        a.authorize_spend(b)
        b['billing_source'] = 'm_plan'
        a.authorize_spend(b)
        b['estimated_cost_cny'] = 2
        with self.assertRaises(a.Fault): a.authorize_spend(b)
    def test_idempotency_is_owner_scoped_and_conflicts_rejected(self):
        self.assertTrue(a.reserve('alice', self.id, {'text':'one'}))
        self.assertFalse(a.reserve('alice', self.id, {'text':'one'}))
        with self.assertRaises(a.Fault): a.reserve('alice', self.id, {'text':'two'})
        with self.assertRaises(a.Fault): a.status('bob', self.id)
        self.assertTrue(a.reserve('bob', self.id, {'text':'two'}))
    def test_restart_marks_unknown_without_retry(self):
        a.reserve('alice', self.id, {})
        with patch.object(a, 'BOOT', 'another-process'):
            self.assertEqual(a.status('alice', self.id)['state'], 'submission_unknown')
            self.assertFalse(a.reserve('alice', self.id, {}))
    def test_http200_provider_error_is_not_success(self):
        with patch.object(a.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps({'base_resp':{'status_code':1008}}).encode())):
            with self.assertRaises(a.Fault) as err: a.provider('/t2a_v2', {}, 'SYNTHETIC-NOT-A-REAL-KEY')
            self.assertEqual(err.exception.code, 'supplier_base_resp_1008')
    def test_worker_saves_audio_but_never_key(self):
        a.reserve('alice', self.id, {})
        with patch.object(a, 'provider', return_value={'data':{'audio':b'ID3fixture'.hex()},'trace_id':'fixture-trace'}):
            a.execute('alice', self.id, 'speech', {'model':'speech-2.8-hd'}, 'SYNTHETIC-SECRET')
        result=a.status('alice', self.id)
        self.assertEqual(result['state'], 'succeeded')
        self.assertFalse(result['full_decode_verified'])
        self.assertEqual((Path(self.tmp.name)/'alice'/(self.id+'.mp3')).read_bytes(), b'ID3fixture')
        self.assertNotIn(b'SYNTHETIC-SECRET', (Path(self.tmp.name)/'jobs.sqlite').read_bytes())
    def test_record_preserves_subscription_billing(self):
        a.reserve('alice', self.id, {'body': {'billing_source': 'm_plan'}})
        self.assertEqual(a.status('alice', self.id)['billing_source'], 'm_plan')
    def test_music_has_no_fabricated_duration(self):
        p=a.build('music', {'prompt':'piano', 'is_instrumental':True})
        self.assertNotIn('duration',p)
        with self.assertRaises(a.Fault): a.build('music', {'prompt':'piano','is_instrumental':True,'duration':30})
    def test_speech_nonstream_hex_output(self):
        p=a.build('speech', {'text':'你好','voice_id':'male-qn-qingse'})
        self.assertFalse(p['stream']); self.assertEqual(p['output_format'],'hex')
        with self.assertRaises(a.Fault): a.build('speech', {'text':'你好','voice_id':'x','speed':True})

if __name__=='__main__': unittest.main()
