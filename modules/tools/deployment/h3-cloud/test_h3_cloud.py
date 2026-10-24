import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

import tools_h3_cloud as h3


class AdapterTests(unittest.TestCase):
    def request(self):
        return {'prompt': 'Use <Video 1> for camera and <Picture 1> for identity.',
                'reference_video_asset_id': str(uuid.uuid4()),
                'reference_image_asset_ids': [str(uuid.uuid4())]}

    def test_real_reference_video_chain_and_turbo(self):
        body = self.request()
        graph, summary = h3.build(body)
        self.assertEqual(graph['5']['inputs']['ref_videos.ref_video_0'], ['22', 0])
        self.assertEqual(graph['22']['inputs']['video'], ['21', 0])
        self.assertEqual(graph['21']['inputs']['file']['info']['id'], body['reference_video_asset_id'])
        self.assertEqual(graph['40']['inputs']['image']['info']['id'], body['reference_image_asset_ids'][0])
        self.assertEqual(graph['9']['inputs']['steps'], 4)
        self.assertEqual((summary['width'], summary['height']), (960, 544))
        self.assertEqual(summary['frames'] % 17, 5)
        self.assertGreaterEqual(summary['duration'], 5)

    def test_invalid_or_unsupported_inputs_fail_before_provider(self):
        for change in [{'reference_video_asset_id': 'local-file.mp4'}, {'prompt': ''},
                       {'resolution': '768P'}, {'duration': float('nan')},
                       {'duration': 16}, {'seed': True}]:
            with self.assertRaises(h3.Fault):
                h3.build(self.request() | change)

    def test_unknown_submission_is_durable_and_never_fresh_twice(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, H3_CLOUD_STATE_DIR=root):
            local_id = str(uuid.uuid4())
            first, row = h3.reserve('owner-a', local_id, 'hash-a')
            again, previous = h3.reserve('owner-a', local_id, 'hash-a')
            self.assertTrue(first)
            self.assertFalse(again)
            self.assertEqual(row, previous)
            self.assertEqual(previous[3], 'submission_unknown')
            with self.assertRaises(h3.Fault):
                h3.reserve('owner-a', local_id, 'hash-b')
            with self.assertRaises(h3.Fault):
                h3.owned('owner-b', local_id)

    def test_result_metadata_omits_signed_urls_and_errors(self):
        output = h3.sanitized({'id': 'x', 'error': {'secret': 'bad'},
                               'outputs': [{'id': 'a', 'url': 'https://signed.example'}]})
        self.assertNotIn('error', output)
        self.assertNotIn('url', output['outputs'][0])


if __name__ == '__main__':
    unittest.main()
