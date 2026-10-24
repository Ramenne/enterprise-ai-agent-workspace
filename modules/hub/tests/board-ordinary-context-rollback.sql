-- Synthetic identities and task only; no real credentials are read. Always rollback.
BEGIN;
INSERT INTO authz.principals(id,organization_id,kind,display_name,role,trusted_source) VALUES
('36bf36c9-5edb-4631-a501-5f8bff7c5fb7','a091058a-8160-404e-a2e9-d97f52776fe3','member','synthetic ordinary member','member','board-context-rollback-test'),
('7511ffa8-03cb-43d1-a875-bab007851603','a091058a-8160-404e-a2e9-d97f52776fe3','service','synthetic service','member','board-context-rollback-test');
INSERT INTO authz.clients(id,principal_id,label,actions) VALUES
('be33bb2b-bed2-4500-a606-209ad6142f43','36bf36c9-5edb-4631-a501-5f8bff7c5fb7','synthetic ordinary',ARRAY['v8.work.read','v8.work.commit']),
('4dfd3898-cf5e-4157-af92-27caee49abb6','36bf36c9-5edb-4631-a501-5f8bff7c5fb7','synthetic restricted',ARRAY['v8.work.read','v8.work.commit']),
('da13463e-f27d-4683-a3c5-1c178f7b149b','7511ffa8-03cb-43d1-a875-bab007851603','synthetic service',ARRAY['v8.work.read','v8.work.commit']);
INSERT INTO authz.credentials(client_id,token_hash,until_revoked,authority_source)
SELECT id,(md5('synthetic-board-context-'||id::text)||md5('synthetic-board-context-'||id::text)),true,
CASE WHEN label='synthetic ordinary' THEN 'member_issued_api' ELSE 'delegated_api' END
FROM authz.clients WHERE id IN('be33bb2b-bed2-4500-a606-209ad6142f43','4dfd3898-cf5e-4157-af92-27caee49abb6','da13463e-f27d-4683-a3c5-1c178f7b149b');
INSERT INTO authz.client_filters745(client_id,clauses)
SELECT id,'[{"project_ids":["b8d37eac-354f-45df-afb9-ae7e0c11c93b"]}]'::jsonb
FROM authz.clients WHERE id IN('be33bb2b-bed2-4500-a606-209ad6142f43','4dfd3898-cf5e-4157-af92-27caee49abb6');
SET SESSION AUTHORIZATION hub2_v8;
DO $test$
DECLARE proof text:=(md5('synthetic-board-context-be33bb2b-bed2-4500-a606-209ad6142f43')||md5('synthetic-board-context-be33bb2b-bed2-4500-a606-209ad6142f43')); r jsonb; tid uuid; denied boolean;
BEGIN
 r:=v8.board_call(proof,'proposals_read','{}'::jsonb,NULL);
 ASSERT r->>'state'='read';
 r:=v8.board_call(proof,'task_propose','{"title":"synthetic rollback proposal","description":"No production effect","suggested_cash_cents":500,"suggested_points_cents":500,"idempotency_key":"synthetic-board-propose"}'::jsonb,NULL);
 ASSERT r->>'state'='proposed'; tid:=(r->>'task_id')::uuid;
 r:=v8.board_call(proof,'proposals_read','{}'::jsonb,NULL);
 ASSERT jsonb_array_length(r->'items')=1 AND (r#>>'{items,0,id}')::uuid=tid;
 r:=v8.board_call(proof,'task_propose','{"title":"synthetic rollback proposal","description":"No production effect","suggested_cash_cents":500,"suggested_points_cents":500,"idempotency_key":"synthetic-board-propose"}'::jsonb,NULL);
 ASSERT r->>'replayed'='true';
 denied:=false;
 BEGIN PERFORM v8.board_call(proof,'task_decide','{}'::jsonb,NULL); EXCEPTION WHEN insufficient_privilege THEN denied:=SQLERRM='supervisor_required'; END;
 ASSERT denied,'ordinary member gained supervisor authority';
 denied:=false;
 BEGIN PERFORM v8.board_call((md5('synthetic-board-context-4dfd3898-cf5e-4157-af92-27caee49abb6')||md5('synthetic-board-context-4dfd3898-cf5e-4157-af92-27caee49abb6')),'proposals_read','{}'::jsonb,NULL);
 EXCEPTION WHEN insufficient_privilege THEN denied:=SQLERRM='unrestricted_member_credential_required'; END;
 ASSERT denied,'restricted filter bypassed';
 denied:=false;
 BEGIN PERFORM v8.board_call((md5('synthetic-board-context-da13463e-f27d-4683-a3c5-1c178f7b149b')||md5('synthetic-board-context-da13463e-f27d-4683-a3c5-1c178f7b149b')),'proposals_read','{}'::jsonb,NULL);
 EXCEPTION WHEN insufficient_privilege THEN denied:=SQLERRM='unrestricted_member_credential_required'; END;
 ASSERT denied,'service impersonated member';
 denied:=false;
 BEGIN PERFORM v8.board_call(proof,'proposals_read','{"member_id":"46b19322-b0f9-490c-ad90-47989799fd74"}'::jsonb,NULL);
 EXCEPTION WHEN insufficient_privilege THEN denied:=SQLERRM='member_scope_forbidden'; END;
 ASSERT denied,'cross-member proposal access';
 denied:=false;
 BEGIN PERFORM v8.board_call(proof,'task_propose','{"title":"synthetic forbidden project","project_id":"ad44cc0e-159e-4e0f-a5ca-73d3920240d9","idempotency_key":"synthetic-project-denied"}'::jsonb,NULL);
 EXCEPTION WHEN insufficient_privilege THEN denied:=SQLERRM='project_scope_mismatch'; END;
 ASSERT denied,'project authority bypassed';
 RAISE NOTICE 'PASS: legacy-filter member read/write/propose/query/replay; supervisor/restricted/service/cross-member/project denied';
END $test$;
RESET SESSION AUTHORIZATION;
UPDATE authz.credentials SET revoked_at=clock_timestamp() WHERE client_id='be33bb2b-bed2-4500-a606-209ad6142f43';
SET SESSION AUTHORIZATION hub2_v8;
DO $test$
DECLARE denied boolean:=false;
BEGIN
 BEGIN PERFORM v8.board_call((md5('synthetic-board-context-be33bb2b-bed2-4500-a606-209ad6142f43')||md5('synthetic-board-context-be33bb2b-bed2-4500-a606-209ad6142f43')),'proposals_read','{}'::jsonb,NULL);
 EXCEPTION WHEN insufficient_privilege THEN denied:=SQLERRM='unauthenticated'; END;
 ASSERT denied,'revoked credential accepted';
 RAISE NOTICE 'PASS: revoked credential denied';
END $test$;
RESET SESSION AUTHORIZATION;
ROLLBACK;
