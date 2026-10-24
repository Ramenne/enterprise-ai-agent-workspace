BEGIN;
INSERT INTO authz.security_state DEFAULT VALUES;
INSERT INTO authz.principals(id,organization_id,kind,display_name,role,trusted_source) VALUES
('ff418794-de29-4c67-abc5-7574c089bba6','ee065f82-4c18-441d-a795-39af1ac76d74','member','synthetic member','member','isolated-v51-fixture'),
('0202bf99-223d-4691-a64c-648b49067ec7','ee065f82-4c18-441d-a795-39af1ac76d74','member','synthetic manager','organization_admin','isolated-v51-fixture'),
('b790a321-563d-460f-a424-9c38ca4bea70','ee065f82-4c18-441d-a795-39af1ac76d74','service','synthetic service','member','isolated-v51-fixture');
INSERT INTO authz.clients(id,principal_id,label,actions) VALUES
('6542517e-7654-4bc3-a7cf-568ba5b627ae','ff418794-de29-4c67-abc5-7574c089bba6','synthetic member first','{v8.work.read}'),
('6c42ed73-9b19-4b74-a321-8a9b843b221c','ff418794-de29-4c67-abc5-7574c089bba6','synthetic member second','{v8.work.read}'),
('09992444-693f-4a54-a794-3fa47eb54a3a','b790a321-563d-460f-a424-9c38ca4bea70','synthetic service','{v8.work.read}'),
('8514cfc6-4e50-4cfc-af43-d52d0b441ccf','0202bf99-223d-4691-a64c-648b49067ec7','synthetic manager','{v8.work.read}'),
('9d9b3c79-235e-4950-af3f-c7684bfad8f3','ff418794-de29-4c67-abc5-7574c089bba6','synthetic delegated','{v8.work.read}');
INSERT INTO authz.credentials(client_id,token_hash,until_revoked,authority_source) SELECT id,encode(public.digest('synthetic-v51-'||id::text,'sha256'),'hex'),true,
CASE WHEN label='synthetic service' THEN 'registered_service_owned_profile' WHEN label='synthetic delegated' THEN 'delegated_api' ELSE 'member_issued_api' END FROM authz.clients;
INSERT INTO authz.client_filters745(client_id,clauses) VALUES('6542517e-7654-4bc3-a7cf-568ba5b627ae','[{"project_ids":["30740b27-2b4f-4609-a26e-650d9acb729f"]}]'),('9d9b3c79-235e-4950-af3f-c7684bfad8f3','[{"project_ids":["30740b27-2b4f-4609-a26e-650d9acb729f"]}]');
INSERT INTO v8.projects(id,organization_id,owner_id,manager_id,kind,visibility,title) VALUES
('294eaf50-f866-4535-a136-29248b0b75de','ee065f82-4c18-441d-a795-39af1ac76d74','ff418794-de29-4c67-abc5-7574c089bba6','ff418794-de29-4c67-abc5-7574c089bba6','project','personal','synthetic own'),
('9bcbc775-52ec-40b4-a60e-69ba7bb742e6','ee065f82-4c18-441d-a795-39af1ac76d74','0202bf99-223d-4691-a64c-648b49067ec7','0202bf99-223d-4691-a64c-648b49067ec7','project','team','synthetic team'),
('ff7d4937-10db-4cb9-ae26-de20b842bca3','ee065f82-4c18-441d-a795-39af1ac76d74','0202bf99-223d-4691-a64c-648b49067ec7','0202bf99-223d-4691-a64c-648b49067ec7','project','personal','synthetic private');
INSERT INTO authz.qualifications(id,principal_id,project_id,actions,source_actor_id,kind,until_revoked,source_project_revision,source_basis) VALUES
('85100cba-e39e-4be7-ac67-d33570cd3e7c','ff418794-de29-4c67-abc5-7574c089bba6','9bcbc775-52ec-40b4-a60e-69ba7bb742e6','{v8.work.commit}','0202bf99-223d-4691-a64c-648b49067ec7','work',true,1,'management_appointment');
\set create_body '{"idempotency_key":"synthetic-v51-project-create","kind":"project","organization_id":"ee065f82-4c18-441d-a795-39af1ac76d74","owner_id":"ff418794-de29-4c67-abc5-7574c089bba6","project_id":"d67d2b11-1c8e-437b-a073-c5af6aa51cc2","title":"synthetic actual create","visibility":"personal"}'
SELECT encode(public.digest(:'create_body','sha256'),'hex') AS create_digest \gset
SELECT encode(public.digest('synthetic-v51-6542517e-7654-4bc3-a7cf-568ba5b627ae','sha256'),'hex') AS synthetic_proof \gset
SET SESSION AUTHORIZATION hub2_hufu;
SELECT (authz.issue_handle(:'synthetic_proof','v8','v8.project.create',:'create_body'::jsonb,:'create_digest','{"provider":"synthetic-v51","native_key":null,"envelope":{"capture_method":"fixture"}}'::jsonb)->>'handle') AS create_handle \gset
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION hub2_v8;
SELECT v8.project_create(:'create_handle'::uuid,:'create_digest',:'create_body') AS create_result \gset
RESET SESSION AUTHORIZATION;
SELECT 1 / ((:'create_result'::jsonb->>'state' = 'created')::int) AS create_assertion;
\set work_body '{"context":false,"goal":"synthetic actual work","idempotency_key":"synthetic-v51-work-save","project_id":"d67d2b11-1c8e-437b-a073-c5af6aa51cc2","summary":"actual domain commit in isolated schema"}'
SELECT encode(public.digest(:'work_body','sha256'),'hex') AS work_digest \gset
SELECT encode(public.digest('synthetic-v51-6542517e-7654-4bc3-a7cf-568ba5b627ae','sha256'),'hex') AS synthetic_proof \gset
SET SESSION AUTHORIZATION hub2_hufu;
SELECT (authz.issue_handle(:'synthetic_proof','v8','v8.work.commit',:'work_body'::jsonb,:'work_digest','{"provider":"synthetic-v51","native_key":null,"envelope":{"capture_method":"fixture"}}'::jsonb)->>'handle') AS work_handle \gset
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION hub2_v8;
SELECT v8.work_save(:'work_handle'::uuid,:'work_digest',:'work_body') AS work_result \gset
RESET SESSION AUTHORIZATION;
SELECT 1 / ((:'work_result'::jsonb->>'state' = 'saved')::int) AS work_assertion;
SELECT 1 / ((SELECT count(*) FROM v8.work_items WHERE project_id='d67d2b11-1c8e-437b-a073-c5af6aa51cc2')=1)::int AS one_actual_work;

SELECT short_no FROM v8.work_items WHERE project_id='d67d2b11-1c8e-437b-a073-c5af6aa51cc2' \gset
SELECT jsonb_build_object('project_id','d67d2b11-1c8e-437b-a073-c5af6aa51cc2','query','W-'||:'short_no','limit',5)::text AS number_body \gset
SELECT encode(public.digest(:'number_body','sha256'),'hex') AS number_digest \gset
SET SESSION AUTHORIZATION hub2_hufu;
SELECT authz.issue_handle(:'synthetic_proof','v8','v8.work.read',:'number_body'::jsonb,:'number_digest','{"provider":"synthetic-number","native_key":null,"envelope":{}}'::jsonb)->>'handle' AS number_handle \gset
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION hub2_v8;
SELECT v8.work_search(:'number_handle'::uuid,:'number_digest',:'number_body') AS number_result \gset
RESET SESSION AUTHORIZATION;
SELECT 1 / ((jsonb_array_length(:'number_result'::jsonb->'items')=1)::int) AS indexed_number_hit;
CREATE FUNCTION pg_temp.synthetic_hash(t text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT encode(public.digest(t,'sha256'),'hex') $$;
GRANT EXECUTE ON FUNCTION pg_temp.synthetic_hash(text) TO hub2_v8;
SET SESSION AUTHORIZATION hub2_v8;
DO $test$
DECLARE b text:='{"project_id":"d67d2b11-1c8e-437b-a073-c5af6aa51cc2","expected_revision":5,"summary":"missing ID must not create another work"}';denied boolean:=false;
BEGIN
 BEGIN PERFORM v8.work_save(NULL,pg_temp.synthetic_hash(b),b);EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='work_item_required_for_existing_revision';denied:=true;END;
 ASSERT denied;
END $test$;
RESET SESSION AUTHORIZATION;
SELECT 1 / ((SELECT count(*) FROM v8.work_items WHERE project_id='d67d2b11-1c8e-437b-a073-c5af6aa51cc2')=1)::int AS invalid_update_no_new_work;
ROLLBACK;
