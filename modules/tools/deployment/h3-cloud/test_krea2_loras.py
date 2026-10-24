import os
import tempfile
import unittest
from unittest.mock import patch
import uuid
import tools_krea2_loras as l
import tools_krea2_cloud as k

class LoraTests(unittest.TestCase):
    def version(self, base='Krea 2'):
        return {'id': 22, 'modelId': 11, 'model': {'type': 'LORA', 'name': 'test'}, 'baseModel': base,
                'files': [{'id': 33, 'name': 'test.safetensors', 'primary': True,
                           'hashes': {'SHA256': 'a'*64, 'BLAKE3': 'b'*64}}]}

    def test_resolve_preflights_via_cloud_only(self):
        with patch.object(l, 'cloud', return_value={'filename':'test.safetensors','tags':['models','loras'],
                          'content_length':100,'validation':{'is_valid':True}}) as cloud:
            r=l.resolve('https://civitai.com/models/11/test?modelVersionId=22','fake')
            self.assertEqual(r['version_id'],22)
            self.assertTrue(cloud.call_args.args[1].startswith('/assets/remote-metadata?'))
        for url in ('http://civitai.com/models/1', 'https://civitai.com.evil.org/models/1',
                    'https://civitai.com@127.0.0.1/models/1', 'https://civitai.com/models/1?token=secret'):
            with self.assertRaises(k.Fault): l.parse_url(url)

    def test_import_unknown_never_repeats_and_other_owner_cannot_read(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, KREA2_CLOUD_STATE_DIR=root), \
             patch.object(l, 'resolve', return_value={'version_id':22,'file_id':33,'download_url':'https://civitai.com/api/download/models/22','base_model':'Krea 2'}):
            lid=str(uuid.uuid4())
            def cloud(method,*args):
                if method=='GET':return {'validation':{'is_valid':True}, 'content_length':100}
                raise k.Fault(502,'unknown')
            with patch.object(l,'cloud',side_effect=cloud) as supplier:
                with self.assertRaises(k.Fault): l.start('a',lid,'https://civitai.com/models/11?modelVersionId=22','fake')
                item=l.start('a',lid,'https://civitai.com/models/11?modelVersionId=22','fake')
                self.assertEqual(item['state'],'import_unknown')
                self.assertFalse(item['reimported'])
                self.assertEqual(sum(c.args[0]=='POST' for c in supplier.call_args_list),1)
                with self.assertRaises(k.Fault):l.find('b',lid)

    def test_ready_import_checks_hash_and_graph_loads_asset(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, KREA2_CLOUD_STATE_DIR=root), \
             patch.object(l,'resolve',return_value={'version_id':22,'file_id':33,'download_url':'https://civitai.com/api/download/models/22','sha256':'a'*64,'blake3':'b'*64}):
            aid=str(uuid.uuid4());lid=str(uuid.uuid4())
            def cloud(method,path,*args):
                if 'remote-metadata' in path:return {'validation':{'is_valid':True},'content_length':100}
                if method=='POST':return {'id':aid}
                return {'id':aid,'tags':['models','loras'],'loader_path':'test.safetensors','hash':'b'*64+'.safetensors','metadata':{'base_model':'Krea 2','source_arn':'civitai:model:11:version:22:file:33'}}
            with patch.object(l,'cloud',side_effect=cloud):
                item=l.start('a',lid,'https://civitai.com/models/11?modelVersionId=22','fake')
                self.assertEqual(item['state'],'ready')
                graph,meta=k.build({'prompt':'Test','lora_id':lid,'lora_strength':0.8},item)
                self.assertEqual(graph['14']['inputs']['lora_name'],'test.safetensors')
                self.assertEqual(graph['3']['inputs']['model'],['14',0])
                self.assertEqual(meta['lora']['strength'],0.8)
                with self.assertRaises(k.Fault):k.build({'prompt':'Test','lora_id':lid})
                with self.assertRaises(k.Fault):k.build({'prompt':'Test','lora_id':lid,'lora_strength':3},item)
