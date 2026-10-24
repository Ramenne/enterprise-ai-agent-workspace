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

\set project_body '{"project_id":"d67d2b11-1c8e-437b-a073-c5af6aa51cc2"}'
SELECT encode(public.digest(:'project_body','sha256'),'hex') AS project_digest \gset
SET SESSION AUTHORIZATION hub2_hufu;
SELECT authz.issue_handle(:'synthetic_proof','v8','v8.project.read',:'project_body'::jsonb,:'project_digest','{"provider":"synthetic-activity","native_key":null,"envelope":{}}'::jsonb)->>'handle' AS project_handle \gset
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION hub2_v8;
SELECT v8.project_read(:'project_handle'::uuid,:'project_digest',:'project_body') AS project_result \gset
RESET SESSION AUTHORIZATION;
SELECT 1 / (coalesce(:'project_result'::jsonb->'recent_work'->0->'current_summary'->>'text'='actual domain commit in isolated schema',false)::int) AS actual_project_current_activity;


INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,kind,until_revoked,source_project_revision,source_basis) VALUES('0202bf99-223d-4691-a64c-648b49067ec7','d67d2b11-1c8e-437b-a073-c5af6aa51cc2','{v8.project.read}','ff418794-de29-4c67-abc5-7574c089bba6','work',true,1,'management_appointment');
SELECT encode(public.digest('synthetic-v51-8514cfc6-4e50-4cfc-af43-d52d0b441ccf','sha256'),'hex') AS other_proof \gset
SET SESSION AUTHORIZATION hub2_hufu;
SELECT authz.issue_handle(:'other_proof','v8','v8.project.read',:'project_body'::jsonb,:'project_digest','{"provider":"synthetic-activity","native_key":null,"envelope":{}}'::jsonb)->>'handle' AS other_handle \gset
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION hub2_v8;
SELECT v8.project_read(:'other_handle'::uuid,:'project_digest',:'project_body') AS other_result \gset
RESET SESSION AUTHORIZATION;
SELECT 1 / (coalesce(jsonb_array_length(:'other_result'::jsonb->'recent_work')=0 AND :'other_result'::jsonb->>'activity_coverage'='work_read_permission_unavailable;not_an_empty_project_claim',false)::int) AS project_metadata_does_not_leak_private_work;
ROLLBACK;
