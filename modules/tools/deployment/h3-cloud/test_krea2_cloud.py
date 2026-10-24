import contextvars
import os
import sys
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
import uuid

import tools_krea2_cloud as k


class KreaTests(unittest.TestCase):
    def test_native_official_turbo_graph(self):
        graph, meta = k.build({'prompt': 'A ceramic bird', 'width': 1920, 'height': 1080})
        self.assertEqual(graph['3']['inputs']['steps'], 8)
        self.assertEqual(graph['3']['inputs']['cfg'], 1)
        self.assertEqual(graph['3']['inputs']['sampler_name'], 'euler')
        self.assertEqual(graph['10']['inputs']['unet_name'], 'krea2_turbo_fp8_scaled.safetensors')
        self.assertEqual(graph['29']['inputs']['images'], ['8', 0])
        self.assertEqual((meta['width'], meta['height']), (1920, 1080))
        self.assertEqual(len(graph), 9)

    def test_limits_and_unimplemented_parameters_fail(self):
        for change in ({'width': True}, {'width': 513}, {'height': 4096},
                       {'width': 2048, 'height': 2048}, {'profile': 'raw'},
                       {'reference_image_asset_ids': []}, {'steps': 52},
                       {'seed': True}, {'prompt': ''}):
            with self.assertRaises(k.Fault):
                k.build({'prompt': 'Test'} | change)

    def test_ledger_durable_owner_and_h3_isolation(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, H3_CLOUD_STATE_DIR=root):
            ident = str(uuid.uuid4())
            fresh, row = k.reserve('a', ident, 'digest')
            self.assertTrue(fresh)
            self.assertFalse(k.reserve('a', ident, 'digest')[0])
            self.assertEqual(k.owned('a', ident), (None, 'submission_unknown'))
            with self.assertRaises(k.Fault):
                k.reserve('a', ident, 'changed')
            with self.assertRaises(k.Fault):
                k.owned('b', ident)
            self.assertTrue((Path(root)/'krea2/jobs.sqlite').exists())
            self.assertFalse((Path(root)/'jobs.sqlite').exists())

    def test_unknown_supplier_effect_not_retried(self):
        from fastapi import FastAPI, HTTPException
        ctx = contextvars.ContextVar('test_caller', default={'legacy_subject': 'test-a'})
        routers = []
        fake = {'web.server': types.SimpleNamespace(app=types.SimpleNamespace(include_router=routers.append)),
                'caller_context': types.SimpleNamespace(CURRENT_CALLER=ctx),
                'tools_mcp_bridge': types.SimpleNamespace(call=lambda *a: {})}
        with patch.dict(sys.modules, fake):
            k.install()
        endpoint = next(r.endpoint for r in routers[0].routes
                        if r.path.endswith('/jobs') and 'POST' in r.methods)
        body = {'prompt': 'Test', 'generation_authorized': True,
                'estimated_credits': 1, 'budget_credits': 2}
        req = types.SimpleNamespace(headers={'Idempotency-Key': str(uuid.uuid4())})
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, KREA2_CLOUD_STATE_DIR=root), \
             patch.object(k, 'configured_key', return_value='fake'), \
             patch.object(k, 'provider', side_effect=k.Fault(502, 'observation_unknown')) as supplier:
            with self.assertRaises(HTTPException):
                endpoint(body, req)
            again = endpoint(body, req)
            self.assertFalse(again['resubmitted'])
            self.assertEqual(again['state'], 'submission_unknown')
            self.assertEqual(supplier.call_count, 1)
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, KREA2_CLOUD_STATE_DIR=root), \
             patch.object(k, 'configured_key', return_value='fake'), \
             patch.object(k, 'provider', side_effect=k.Fault(402, 'supplier_http_402')) as supplier:
            with self.assertRaises(HTTPException) as error:
                endpoint(body, req)
            self.assertEqual(error.exception.status_code, 402)
            again = endpoint(body, req)
            self.assertEqual(again['state'], 'rejected_payment_required')
            self.assertFalse(again['resubmitted'])
            self.assertEqual(supplier.call_count, 1)
        with patch.object(k, 'configured_key') as key:
            with self.assertRaises(HTTPException):
                endpoint(body | {'generation_authorized': False}, req)
            key.assert_not_called()

    def test_result_metadata_contains_no_signed_urls(self):
        result = k.sanitized({'id': 'x', 'error': 'secret',
                              'outputs': [{'id': 'a', 'url': 'https://signed.example'}]})
        self.assertNotIn('error', result)
        self.assertNotIn('url', result['outputs'][0])


if __name__ == '__main__':
    unittest.main()
