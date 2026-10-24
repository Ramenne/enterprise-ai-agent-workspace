from pathlib import Path
import json
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'packages/semantic-service/source'))
import input_contracts as contracts
import warm_service
from semantic_adapter import SemanticAdapter

ID = '16f05f01-4a43-4e96-a16b-d8ed69eff77d'
Q = {'project_id': ID, 'text': 'synthetic'}
REF = {'project_id': ID, 'fixed_ref': {'material_id': ID, 'version_id': ID, 'sha256': 'a' * 64}}
CASES = [
    ('ordinary', 'query', Q),
    ('defaults', 'query', {**Q, 'top_k': 10, 'mode': 'exact', 'compare_exact': False, 'include_historical': False}),
    ('boolean_top', 'query', {**Q, 'top_k': True}), ('too_many', 'query', {**Q, 'top_k': 101}),
    ('utf8_budget', 'query', {**Q, 'text': '字' * 12000}), ('whitespace', 'query', {**Q, 'text': ' '}),
    ('compact_uuid', 'query', {**Q, 'project_id': ID.replace('-', '')}), ('unknown', 'query', {**Q, 'extra': 1}),
    ('fixed', 'index', REF), ('newline_hash', 'index', {**REF, 'fixed_ref': {**REF['fixed_ref'], 'sha256': 'a' * 64 + '\n'}})
]


class SemanticContracts(unittest.TestCase):
    def test_original_http_validation_outcomes(self):
        expected = json.loads((ROOT / 'tests/fixtures/independent-semantic-before.json').read_text())
        for label, kind, body in CASES:
            try:
                warm_service.WarmEngine.validate(None, kind, body)
                actual = {'label': label, 'ok': True}
            except contracts.CandidateError as error:
                actual = {'label': label, 'ok': False, 'error_code': error.code}
            self.assertEqual(actual, next(x for x in expected if x['label'] == label), label)
        self.assertIs(warm_service.CandidateError, contracts.CandidateError)

    def test_projection_keeps_domain_defaults_and_protocol_source_separate(self):
        published = contracts.mcp_publication()
        self.assertEqual(published['origin']['endpoint_key'], 'semantic')
        for item in published['contracts']:
            self.assertNotIn('source_context', item['input_schema']['properties'])
            self.assertNotIn('"default"', json.dumps(item['input_schema']))
        self.assertEqual(contracts.SCHEMAS['query']['properties']['top_k']['default'], 10)
        self.assertEqual(contracts.OPERATIONS['/semantic/query'], 'query')

    def test_adapter_uses_same_defaults_without_initializing_a_model(self):
        class Vector:
            def tolist(self):
                return [0.0]
        adapter = SemanticAdapter.__new__(SemanticAdapter)
        adapter.space = {'synthetic': True}
        adapter.embed = lambda texts, kind: [Vector()]
        request = adapter.query_request('synthetic', ID)
        for key, value in contracts.QUERY_DEFAULTS.items():
            self.assertEqual(request['body'][key], value)
        self.assertEqual(request['endpoint'], '/v2/materials/description-vector-search')


if __name__ == '__main__':
    unittest.main()
