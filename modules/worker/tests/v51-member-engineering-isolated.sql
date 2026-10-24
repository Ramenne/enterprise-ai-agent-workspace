BEGIN;
DO $isolation$ BEGIN ASSERT current_database() LIKE 'governance_v51_fixture%','isolated database required'; END $isolation$;
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
DO $test$
DECLARE identity jsonb; a uuid:='ff418794-de29-4c67-abc5-7574c089bba6';c uuid; denied boolean; count_pass int:=0;
BEGIN
 FOR c IN SELECT id FROM authz.clients WHERE label IN('synthetic member first','synthetic member second') LOOP
  identity:=authz.authenticate(encode(public.digest('synthetic-v51-'||c::text,'sha256'),'hex'));
  ASSERT identity->>'principal_kind'='member'; ASSERT identity->>'authorization_mode'='member_qualification';
  ASSERT identity->'client_actions' ? 'v8.project.create'; ASSERT identity ? 'scope_filters';
  PERFORM authz.check_access(a,c,'294eaf50-f866-4535-a136-29248b0b75de','mem.write');
  PERFORM authz.check_access(a,c,'9bcbc775-52ec-40b4-a60e-69ba7bb742e6','v8.work.commit');
  PERFORM authz.resource_deadline(a,c,'d67d2b11-1c8e-437b-a073-c5af6aa51cc2','v8.project.create',jsonb_build_object('project_id','d67d2b11-1c8e-437b-a073-c5af6aa51cc2','owner_id',a,'organization_id','ee065f82-4c18-441d-a795-39af1ac76d74'));
  denied:=false;BEGIN PERFORM authz.check_access(a,c,'ff7d4937-10db-4cb9-ae26-de20b842bca3','mem.read');EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;ASSERT denied;
  count_pass:=count_pass+4;
 END LOOP;
 UPDATE authz.qualifications SET active=false WHERE id='85100cba-e39e-4be7-ac67-d33570cd3e7c';
 FOR c IN SELECT id FROM authz.clients WHERE label IN('synthetic member first','synthetic member second') LOOP
  denied:=false;BEGIN PERFORM authz.check_access(a,c,'9bcbc775-52ec-40b4-a60e-69ba7bb742e6','v8.work.commit');EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;ASSERT denied; count_pass:=count_pass+1;
 END LOOP;
 identity:=authz.authenticate(encode(public.digest('synthetic-v51-09992444-693f-4a54-a794-3fa47eb54a3a','sha256'),'hex'));
 ASSERT identity->>'authorization_mode'='restricted_credential';ASSERT NOT (identity->'client_actions' ? 'v8.project.create');
 denied:=false;BEGIN PERFORM authz.require_client_capability(identity,'v8.project.create');EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;ASSERT denied;count_pass:=count_pass+1;
 ASSERT NOT authz.client_resource_allowed745('9d9b3c79-235e-4950-af3f-c7684bfad8f3','9bcbc775-52ec-40b4-a60e-69ba7bb742e6');count_pass:=count_pass+1;
 UPDATE authz.credentials SET revoked_at=clock_timestamp() WHERE client_id='6c42ed73-9b19-4b74-a321-8a9b843b221c';
 denied:=false;BEGIN PERFORM authz.authenticate(encode(public.digest('synthetic-v51-6c42ed73-9b19-4b74-a321-8a9b843b221c','sha256'),'hex'));EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;ASSERT denied;count_pass:=count_pass+1;
 RAISE NOTICE 'fixture actual PostgreSQL function scenarios passed: %',count_pass;
END $test$;

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

\set related_body '{"cursor":0,"fixed_refs":[],"limit":5,"participants":[],"project_id":"d67d2b11-1c8e-437b-a073-c5af6aa51cc2","query":""}'
SELECT encode(public.digest(:'related_body','sha256'),'hex') AS related_digest \gset
SELECT encode(public.digest('synthetic-v51-6542517e-7654-4bc3-a7cf-568ba5b627ae','sha256'),'hex') AS synthetic_proof \gset
SET SESSION AUTHORIZATION hub2_hufu;
SELECT authz.issue_handle(:'synthetic_proof','v8','v8.work.related_candidates',:'related_body'::jsonb,:'related_digest','{"provider":"synthetic-v51","native_key":null,"envelope":{}}'::jsonb)->>'handle' AS related_handle \gset
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION hub2_v8;
SELECT v8.related_candidates(:'related_handle'::uuid,:'related_digest',:'related_body') AS related_result \gset
SELECT 1 / ((jsonb_array_length(:'related_result'::jsonb->'items')=1)::int) AS actual_candidate_visible;
RESET SESSION AUTHORIZATION;

\set search_body '{"limit":5,"project_id":"d67d2b11-1c8e-437b-a073-c5af6aa51cc2","query":"actual domain commit"}'
SELECT encode(public.digest(:'search_body','sha256'),'hex') AS search_digest \gset
SET SESSION AUTHORIZATION hub2_hufu;
SELECT authz.issue_handle(:'synthetic_proof','v8','v8.work.read',:'search_body'::jsonb,:'search_digest','{"provider":"synthetic-v51","native_key":null,"envelope":{}}'::jsonb)->>'handle' AS search_handle \gset
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION hub2_v8;
SELECT v8.work_search(:'search_handle'::uuid,:'search_digest',:'search_body') AS search_result \gset
RESET SESSION AUTHORIZATION;
SELECT 1 / ((:'search_result'::jsonb->'items'->0->'current_summary'->>'text'='actual domain commit in isolated schema')::int) AS current_stage_summary;

-- Appended inside the independent fixture transaction. All identities and
-- primary proof are synthetic; this is the authorized OTP-result simulation.
UPDATE authz.credentials SET revoked_at=NULL WHERE client_id='6c42ed73-9b19-4b74-a321-8a9b843b221c';
UPDATE authz.qualifications SET active=true,actions='{resource.read,resource.write,resource.deploy}',until_revoked=false,expires_at=clock_timestamp()+interval '10 minutes' WHERE id='85100cba-e39e-4be7-ac67-d33570cd3e7c';
INSERT INTO authz.engineering_projects(project_id,title,descriptor,ready) VALUES('9bcbc775-52ec-40b4-a60e-69ba7bb742e6','synthetic engineering','{"source":"isolated-fixture-only","workspace":"/synthetic/not-a-production-path"}',true);
UPDATE authz.clients SET actions='{mem.write,resource.read,resource.write,resource.deploy}' WHERE id='9d9b3c79-235e-4950-af3f-c7684bfad8f3';
INSERT INTO authz.clients(id,principal_id,label,actions) VALUES('d5b2473d-6b78-4d0d-a370-ec9f96ed38ff','0202bf99-223d-4691-a64c-648b49067ec7','synthetic primary OTP-result fixture','{v8.work.read}');
INSERT INTO authz.credentials(client_id,token_hash,until_revoked,is_primary,authority_source) VALUES('d5b2473d-6b78-4d0d-a370-ec9f96ed38ff',encode(public.digest('synthetic-v51-d5b2473d-6b78-4d0d-a370-ec9f96ed38ff','sha256'),'hex'),true,true,'authn_session');
INSERT INTO authz.client_filters745(client_id,clauses) VALUES('8514cfc6-4e50-4cfc-af43-d52d0b441ccf','[{"project_ids":["30740b27-2b4f-4609-a26e-650d9acb729f"]}]');
CREATE FUNCTION pg_temp.synthetic_hash(t text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT encode(public.digest(t,'sha256'),'hex') $$;
GRANT EXECUTE ON FUNCTION pg_temp.synthetic_hash(text) TO hub2_hufu;
SET SESSION AUTHORIZATION hub2_hufu;
DO $test$
DECLARE cid text; operation text; result jsonb; denied boolean; count_pass int:=0; proof text; primary_proof text; ident jsonb;
BEGIN
 FOR cid IN SELECT unnest(ARRAY['6542517e-7654-4bc3-a7cf-568ba5b627ae','6c42ed73-9b19-4b74-a321-8a9b843b221c']) LOOP
  FOREACH operation IN ARRAY ARRAY['read','write','deploy'] LOOP
   result:=authz.engineering_access(pg_temp.synthetic_hash('synthetic-v51-'||cid),'9bcbc775-52ec-40b4-a60e-69ba7bb742e6',operation);
   ASSERT result->>'project_id'='9bcbc775-52ec-40b4-a60e-69ba7bb742e6';ASSERT result->>'qualification_id'='85100cba-e39e-4be7-ac67-d33570cd3e7c';count_pass:=count_pass+1;
  END LOOP;
 END LOOP;
 denied:=false;BEGIN PERFORM authz.engineering_access(pg_temp.synthetic_hash('synthetic-v51-9d9b3c79-235e-4950-af3f-c7684bfad8f3'),'9bcbc775-52ec-40b4-a60e-69ba7bb742e6','deploy');EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;ASSERT denied;count_pass:=count_pass+1;
 proof:=pg_temp.synthetic_hash('synthetic-v51-8514cfc6-4e50-4cfc-af43-d52d0b441ccf');primary_proof:=pg_temp.synthetic_hash('synthetic-v51-d5b2473d-6b78-4d0d-a370-ec9f96ed38ff');
 result:=authz.engineering_context_register(proof,primary_proof,NULL,'verified_email_otp',clock_timestamp()+interval '10 minutes');
 ASSERT result->>'state'='management_ready';ASSERT result->'authorized_actions' ? 'hufu.vault.decide';count_pass:=count_pass+1;
 ident:=authz.authenticate(proof);
 ASSERT authz.management_context_valid(ident,NULL);ASSERT authz.management_context_allows(ident,NULL,'hufu.vault.decide');
 ASSERT authz.management_context_valid(ident,NULL);count_pass:=count_pass+1;
 result:=authz.client_identity_lookup(proof,'00000000-0000-4000-8000-000000000099');ASSERT result->>'error_code'='client_not_found';count_pass:=count_pass+1;
 RAISE NOTICE 'engineering member clients and isolated simulated OTP-result scenarios passed: %',count_pass;
END $test$;
RESET SESSION AUTHORIZATION;
UPDATE authz.qualifications SET active=false WHERE id='85100cba-e39e-4be7-ac67-d33570cd3e7c';
SET SESSION AUTHORIZATION hub2_hufu;
DO $test$
DECLARE cid text; denied boolean;
BEGIN
 FOREACH cid IN ARRAY ARRAY['6542517e-7654-4bc3-a7cf-568ba5b627ae','6c42ed73-9b19-4b74-a321-8a9b843b221c'] LOOP
  denied:=false;BEGIN PERFORM authz.engineering_access(pg_temp.synthetic_hash('synthetic-v51-'||cid),'9bcbc775-52ec-40b4-a60e-69ba7bb742e6','deploy');EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;ASSERT denied;
 END LOOP;
 RAISE NOTICE 'engineering revoked qualification denied both existing bound clients';
END $test$;
RESET SESSION AUTHORIZATION;

ROLLBACK;
