BEGIN;
INSERT INTO authz.security_state DEFAULT VALUES;
INSERT INTO authz.principals(id,organization_id,kind,display_name,role,trusted_source) VALUES
('ff418794-de29-4c67-abc5-7574c089bba6','ee065f82-4c18-441d-a795-39af1ac76d74','member','synthetic member','member','isolated-v51-fixture'),
('0202bf99-223d-4691-a64c-648b49067ec7','ee065f82-4c18-441d-a795-39af1ac76d74','member','synthetic manager','organization_admin','isolated-v51-fixture'),
('b790a321-563d-460f-a424-9c38ca4bea70','ee065f82-4c18-441d-a795-39af1ac76d74','member','synthetic third member','member','isolated-v51-fixture');
INSERT INTO authz.clients(id,principal_id,label,actions) VALUES
('6542517e-7654-4bc3-a7cf-568ba5b627ae','ff418794-de29-4c67-abc5-7574c089bba6','synthetic member first','{v8.project.read,v8.project.update,v8.work.read,v8.work.commit}'),
('6c42ed73-9b19-4b74-a321-8a9b843b221c','ff418794-de29-4c67-abc5-7574c089bba6','synthetic member second','{v8.project.read,v8.project.update,v8.work.read,v8.work.commit}'),
('09992444-693f-4a54-a794-3fa47eb54a3a','b790a321-563d-460f-a424-9c38ca4bea70','synthetic service','{v8.project.read,v8.project.update,v8.work.read,v8.work.commit}'),
('8514cfc6-4e50-4cfc-af43-d52d0b441ccf','0202bf99-223d-4691-a64c-648b49067ec7','synthetic manager','{v8.project.read,v8.project.update,v8.work.read,v8.work.commit}'),
('9d9b3c79-235e-4950-af3f-c7684bfad8f3','ff418794-de29-4c67-abc5-7574c089bba6','synthetic delegated','{v8.project.read,v8.project.update,v8.work.read,v8.work.commit}');
INSERT INTO authz.credentials(client_id,token_hash,until_revoked,authority_source) SELECT id,encode(public.digest('synthetic-v51-'||id::text,'sha256'),'hex'),true,
CASE WHEN label='synthetic service' THEN 'registered_service_owned_profile' WHEN label='synthetic delegated' THEN 'delegated_api' ELSE 'member_issued_api' END FROM authz.clients;

INSERT INTO v8.projects(id,organization_id,owner_id,manager_id,kind,visibility,title)VALUES
('294eaf50-f866-4535-a136-29248b0b75de','ee065f82-4c18-441d-a795-39af1ac76d74','ff418794-de29-4c67-abc5-7574c089bba6','ff418794-de29-4c67-abc5-7574c089bba6','project','personal','synthetic own source'),
('9bcbc775-52ec-40b4-a60e-69ba7bb742e6','ee065f82-4c18-441d-a795-39af1ac76d74','ff418794-de29-4c67-abc5-7574c089bba6','ff418794-de29-4c67-abc5-7574c089bba6','dialogue','personal','synthetic own target'),
('ff7d4937-10db-4cb9-ae26-de20b842bca3','ee065f82-4c18-441d-a795-39af1ac76d74','0202bf99-223d-4691-a64c-648b49067ec7','0202bf99-223d-4691-a64c-648b49067ec7','project','team','synthetic other audience');
INSERT INTO authz.qualifications(id,principal_id,project_id,actions,source_actor_id,kind,until_revoked,source_project_revision,source_basis,resource_selector)VALUES
('85100cba-e39e-4be7-ac67-d33570cd3e7c','0202bf99-223d-4691-a64c-648b49067ec7','294eaf50-f866-4535-a136-29248b0b75de','{v8.project.read,mem.read}','ff418794-de29-4c67-abc5-7574c089bba6','work',true,1,'management_appointment','{"version":1,"kind":"project"}'),
('9e6ac4f0-2b37-4f4b-ae99-4e7390f75124','b790a321-563d-460f-a424-9c38ca4bea70','ff7d4937-10db-4cb9-ae26-de20b842bca3','{v8.work.commit}','0202bf99-223d-4691-a64c-648b49067ec7','work',true,1,'management_appointment','{"version":1,"kind":"project"}');
SELECT 1/((jsonb_array_length(v8.project_governance_projection('294eaf50-f866-4535-a136-29248b0b75de',true,'ff418794-de29-4c67-abc5-7574c089bba6')->'authorized_takeovers')=0)::int)AS readonly_not_takeover;
SELECT 1/((v8.project_governance_projection('ff7d4937-10db-4cb9-ae26-de20b842bca3',true,'0202bf99-223d-4691-a64c-648b49067ec7')->>'responsibility_status'='authorized_takeover;progress_not_reported')::int)AS authorized_without_receipt_not_unowned;
\set proof_body 'synthetic-v51-6542517e-7654-4bc3-a7cf-568ba5b627ae'
SELECT encode(public.digest(:'proof_body','sha256'),'hex')AS proof \gset
\set b '{"project_id":"294eaf50-f866-4535-a136-29248b0b75de","expected_revision":1,"idempotency_key":"synthetic-governance-save","governance":{"purpose":"business","lifecycle":"paused","responsible_actor_id":"ff418794-de29-4c67-abc5-7574c089bba6","reason":"synthetic explicit judgment"}}'
SELECT encode(public.digest(:'b','sha256'),'hex')AS d \gset
SET SESSION AUTHORIZATION hub2_hufu;
SELECT authz.issue_handle(:'proof','v8','v8.project.update',:'b'::jsonb,:'d','{"provider":"synthetic-lifecycle","native_key":null,"envelope":{}}'::jsonb)->>'handle'AS h \gset
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION hub2_v8;
SELECT v8.project_governance_save(:'h'::uuid,:'d',:'b')AS saved \gset
RESET SESSION AUTHORIZATION;
SELECT 1/((:'saved'::jsonb->'project'->'properties'->'governance'->>'purpose'='business'AND :'saved'::jsonb->'project'->'properties'->'governance'->>'lifecycle'='paused'AND :'saved'::jsonb->'project'->>'state'='active')::int)AS purpose_lifecycle_independent_from_runtime_state;
\set b '{"project_id":"294eaf50-f866-4535-a136-29248b0b75de","expected_revision":2,"idempotency_key":"synthetic-readonly-responsible-denied","governance":{"responsible_actor_id":"0202bf99-223d-4691-a64c-648b49067ec7"}}'
SELECT encode(public.digest(:'b','sha256'),'hex')AS d \gset
SET SESSION AUTHORIZATION hub2_hufu;
SELECT authz.issue_handle(:'proof','v8','v8.project.update',:'b'::jsonb,:'d','{"provider":"synthetic-lifecycle","native_key":null,"envelope":{}}'::jsonb)->>'handle'AS h \gset
RESET SESSION AUTHORIZATION;
CREATE FUNCTION pg_temp.assert_readonly_denied(h uuid,d text,b text)RETURNS void LANGUAGE plpgsql AS $$
DECLARE denied boolean:=false;BEGIN
 BEGIN PERFORM v8.project_governance_save(h,d,b);EXCEPTION WHEN insufficient_privilege THEN ASSERT SQLERRM='responsible_requires_existing_work_or_management_authority';denied:=true;END;
 ASSERT denied;
END$$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_readonly_denied(uuid,text,text)TO hub2_v8;
SET SESSION AUTHORIZATION hub2_v8;
SELECT pg_temp.assert_readonly_denied(:'h'::uuid,:'d',:'b');
RESET SESSION AUTHORIZATION;
\set b '{"project_id":"294eaf50-f866-4535-a136-29248b0b75de","idempotency_key":"synthetic-move-work-create","goal":"synthetic actual business work","context":false}'
SELECT encode(public.digest(:'b','sha256'),'hex')AS d \gset
SET SESSION AUTHORIZATION hub2_hufu;
SELECT authz.issue_handle(:'proof','v8','v8.work.commit',:'b'::jsonb,:'d','{"provider":"synthetic-lifecycle","native_key":null,"envelope":{}}'::jsonb)->>'handle'AS h \gset
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION hub2_v8;
SELECT v8.work_save(:'h'::uuid,:'d',:'b')AS work \gset
RESET SESSION AUTHORIZATION;
SELECT :'work'::jsonb->>'work_item_id'AS w,:'work'::jsonb->>'short_no'AS old_no,(:'work'::jsonb->>'domain_revision')::integer AS old_rev,(SELECT count(*)FROM v8.work_updates WHERE work_item_id=(:'work'::jsonb->>'work_item_id')::uuid)AS old_count \gset
SELECT jsonb_build_object('project_id','294eaf50-f866-4535-a136-29248b0b75de','target_project_id','9bcbc775-52ec-40b4-a60e-69ba7bb742e6','work_item_id',:'w','expected_revision',:'old_rev'::integer,'idempotency_key','synthetic-actual-work-move','reason','same personal owner correction')::text AS b \gset
SELECT jsonb_build_object('project_id','9bcbc775-52ec-40b4-a60e-69ba7bb742e6','idempotency_key','synthetic-actual-work-move')::text AS tb \gset
SELECT encode(public.digest(:'b','sha256'),'hex')AS d,encode(public.digest(:'tb','sha256'),'hex')AS td \gset
SET SESSION AUTHORIZATION hub2_hufu;
SELECT authz.issue_handle(:'proof','v8','v8.work.commit',:'b'::jsonb,:'d','{"provider":"synthetic-lifecycle","native_key":null,"envelope":{}}'::jsonb)->>'handle'AS h \gset
SELECT authz.issue_handle(:'proof','v8','v8.work.commit',:'tb'::jsonb,:'td','{"provider":"synthetic-lifecycle","native_key":null,"envelope":{}}'::jsonb)->>'handle'AS th \gset
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION hub2_v8;
SELECT v8.work_project_move(:'h'::uuid,:'th'::uuid,:'d',:'b',:'td',:'tb')AS moved \gset
RESET SESSION AUTHORIZATION;
SELECT 1/((:'moved'::jsonb->>'state'='moved'AND :'moved'::jsonb->>'short_no'=:'old_no'AND :'moved'::jsonb->'work_item'->>'project_id'='9bcbc775-52ec-40b4-a60e-69ba7bb742e6'AND (SELECT count(*)FROM v8.work_updates WHERE work_item_id=:'w'::uuid)=:'old_count'::int+1)::int)AS original_no_and_history_preserved;
SELECT 1/((SELECT properties->'governance'->>'responsible_actor_id'FROM v8.projects WHERE id='294eaf50-f866-4535-a136-29248b0b75de')='ff418794-de29-4c67-abc5-7574c089bba6')::int AS readonly_assign_no_effect;
SELECT 1/((SELECT record->>'project_id'FROM v8.work_snapshots WHERE work_item_id=:'w'::uuid AND work_revision=:'old_rev'::integer)='294eaf50-f866-4535-a136-29248b0b75de')::int AS old_row_snapshot_preserved;
SET SESSION AUTHORIZATION hub2_hufu;
SELECT authz.issue_handle(:'proof','v8','v8.work.commit',:'b'::jsonb,:'d','{"provider":"synthetic-lifecycle","native_key":null,"envelope":{}}'::jsonb)->>'handle'AS h \gset
SELECT authz.issue_handle(:'proof','v8','v8.work.commit',:'tb'::jsonb,:'td','{"provider":"synthetic-lifecycle","native_key":null,"envelope":{}}'::jsonb)->>'handle'AS th \gset
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION hub2_v8;
SELECT v8.work_project_move(:'h'::uuid,:'th'::uuid,:'d',:'b',:'td',:'tb')AS repeated \gset
RESET SESSION AUTHORIZATION;
SELECT 1/((:'repeated'::jsonb->>'operation_id'=:'moved'::jsonb->>'operation_id'AND(SELECT count(*)FROM v8.work_updates WHERE work_item_id=:'w'::uuid)=:'old_count'::int+1)::int)AS repeated_move_single_effect;
INSERT INTO authz.qualifications(id,principal_id,project_id,actions,source_actor_id,kind,until_revoked,source_project_revision,source_basis,resource_selector)VALUES('bbd76915-aaed-4e2d-a1a9-f3fc985d0eef','ff418794-de29-4c67-abc5-7574c089bba6','ff7d4937-10db-4cb9-ae26-de20b842bca3','{v8.work.commit}','0202bf99-223d-4691-a64c-648b49067ec7','work',true,1,'management_appointment','{"version":1,"kind":"project"}');
SELECT jsonb_build_object('project_id','9bcbc775-52ec-40b4-a60e-69ba7bb742e6','target_project_id','ff7d4937-10db-4cb9-ae26-de20b842bca3','work_item_id',:'w','expected_revision',(:'moved'::jsonb->>'domain_revision')::integer,'idempotency_key','synthetic-unsafe-team-move','reason','must refuse broader audience')::text AS b \gset
SELECT jsonb_build_object('project_id','ff7d4937-10db-4cb9-ae26-de20b842bca3','idempotency_key','synthetic-unsafe-team-move')::text AS tb \gset
SELECT encode(public.digest(:'b','sha256'),'hex')AS d,encode(public.digest(:'tb','sha256'),'hex')AS td \gset
SET SESSION AUTHORIZATION hub2_hufu;
SELECT authz.issue_handle(:'proof','v8','v8.work.commit',:'b'::jsonb,:'d','{"provider":"synthetic-lifecycle","native_key":null,"envelope":{}}'::jsonb)->>'handle'AS h \gset
SELECT authz.issue_handle(:'proof','v8','v8.work.commit',:'tb'::jsonb,:'td','{"provider":"synthetic-lifecycle","native_key":null,"envelope":{}}'::jsonb)->>'handle'AS th \gset
RESET SESSION AUTHORIZATION;
CREATE FUNCTION pg_temp.assert_move_denied(h uuid,th uuid,d text,b text,td text,tb text)RETURNS void LANGUAGE plpgsql AS $$
DECLARE denied boolean:=false;BEGIN
 BEGIN PERFORM v8.work_project_move(h,th,d,b,td,tb);EXCEPTION WHEN insufficient_privilege THEN ASSERT SQLERRM='same_personal_owner_scope_required';denied:=true;END;
 ASSERT denied;
END$$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_move_denied(uuid,uuid,text,text,text,text)TO hub2_v8;
SET SESSION AUTHORIZATION hub2_v8;
SELECT pg_temp.assert_move_denied(:'h'::uuid,:'th'::uuid,:'d',:'b',:'td',:'tb');
RESET SESSION AUTHORIZATION;
SELECT 1/((SELECT project_id::text FROM v8.work_items WHERE id=:'w'::uuid)='9bcbc775-52ec-40b4-a60e-69ba7bb742e6')::int AS broader_audience_move_no_effect;
ROLLBACK;

