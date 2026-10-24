BEGIN;
INSERT INTO authz.security_state DEFAULT VALUES;
INSERT INTO authz.principals(id,organization_id,kind,display_name,role,trusted_source) VALUES
('ff418794-de29-4c67-abc5-7574c089bba6','ee065f82-4c18-441d-a795-39af1ac76d74','member','synthetic member','member','isolated-v51-fixture'),
('0202bf99-223d-4691-a64c-648b49067ec7','ee065f82-4c18-441d-a795-39af1ac76d74','member','synthetic manager','organization_admin','isolated-v51-fixture'),
('b790a321-563d-460f-a424-9c38ca4bea70','ee065f82-4c18-441d-a795-39af1ac76d74','service','synthetic service','member','isolated-v51-fixture');
INSERT INTO authz.clients(id,principal_id,label,actions) VALUES
('6542517e-7654-4bc3-a7cf-568ba5b627ae','ff418794-de29-4c67-abc5-7574c089bba6','synthetic member first','{mem.read}'),
('6c42ed73-9b19-4b74-a321-8a9b843b221c','ff418794-de29-4c67-abc5-7574c089bba6','synthetic member second','{mem.read}'),
('09992444-693f-4a54-a794-3fa47eb54a3a','b790a321-563d-460f-a424-9c38ca4bea70','synthetic service','{mem.read}'),
('8514cfc6-4e50-4cfc-af43-d52d0b441ccf','0202bf99-223d-4691-a64c-648b49067ec7','synthetic manager','{mem.read}'),
('9d9b3c79-235e-4950-af3f-c7684bfad8f3','ff418794-de29-4c67-abc5-7574c089bba6','synthetic delegated','{mem.read}');
INSERT INTO authz.credentials(client_id,token_hash,until_revoked,authority_source) SELECT id,encode(public.digest('synthetic-v51-'||id::text,'sha256'),'hex'),true,
CASE WHEN label='synthetic service' THEN 'registered_service_owned_profile' WHEN label='synthetic delegated' THEN 'delegated_api' ELSE 'member_issued_api' END FROM authz.clients;

INSERT INTO v8.projects(id,organization_id,owner_id,manager_id,kind,visibility,title) VALUES
('294eaf50-f866-4535-a136-29248b0b75de','ee065f82-4c18-441d-a795-39af1ac76d74','ff418794-de29-4c67-abc5-7574c089bba6','ff418794-de29-4c67-abc5-7574c089bba6','project','personal','synthetic own'),
('9bcbc775-52ec-40b4-a60e-69ba7bb742e6','ee065f82-4c18-441d-a795-39af1ac76d74','0202bf99-223d-4691-a64c-648b49067ec7','0202bf99-223d-4691-a64c-648b49067ec7','project','personal','synthetic other private');
INSERT INTO mem.materials(id,project_id,owner_id,origin_kind,producer)VALUES('ed3258cb-44c5-45bc-a8c7-f06486cf7e00','294eaf50-f866-4535-a136-29248b0b75de','ff418794-de29-4c67-abc5-7574c089bba6','member_submission','synthetic private file');
INSERT INTO mem.verified_objects(id,provider,bucket,object_key,provider_version_id,sha256,size,verification_run)VALUES('36bf36c9-5edb-4631-a501-5f8bff7c5fb7','cos','synthetic-fixture','synthetic-fixture','synthetic-fixture',repeat('b',64),0,gen_random_uuid());
INSERT INTO mem.content_versions(id,material_id,object_id,sha256,size,actor_id,reason)VALUES('2564a9b9-76b6-4115-a832-cfa7c9d97fe6','ed3258cb-44c5-45bc-a8c7-f06486cf7e00','36bf36c9-5edb-4631-a501-5f8bff7c5fb7',repeat('b',64),0,'ff418794-de29-4c67-abc5-7574c089bba6','synthetic');
UPDATE mem.materials SET current_version_id='2564a9b9-76b6-4115-a832-cfa7c9d97fe6'WHERE id='ed3258cb-44c5-45bc-a8c7-f06486cf7e00';
\set body '{"project_id":"294eaf50-f866-4535-a136-29248b0b75de","material_id":"ed3258cb-44c5-45bc-a8c7-f06486cf7e00"}'
SELECT encode(public.digest(:'body','sha256'),'hex')AS d \gset
SELECT encode(public.digest('synthetic-v51-6542517e-7654-4bc3-a7cf-568ba5b627ae','sha256'),'hex')AS proof \gset
SET SESSION AUTHORIZATION hub2_hufu;
SELECT authz.issue_handle(:'proof','mem','mem.read',:'body'::jsonb,:'d','{"provider":"synthetic-file-number","native_key":null,"envelope":{}}'::jsonb)->>'handle'AS h \gset
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION hub2_mem;
SELECT mem.file_number_head(:'h'::uuid,:'d',:'body')AS result \gset
RESET SESSION AUTHORIZATION;
SELECT 1/((:'result'::jsonb->>'local_version_no'='1'AND :'result'::jsonb->>'state'='found')::int)AS authorized_file_query;
SET SESSION AUTHORIZATION hub2_hufu;
SELECT authz.issue_handle(:'proof','mem','mem.read',:'body'::jsonb,:'d','{"provider":"synthetic-file-number","native_key":null,"envelope":{}}'::jsonb)->>'handle'AS revoke_h \gset
RESET SESSION AUTHORIZATION;
CREATE FUNCTION pg_temp.assert_hidden(proof text,d text,b text)RETURNS void LANGUAGE plpgsql AS $$
DECLARE denied boolean:=false;BEGIN
 BEGIN PERFORM authz.issue_handle(proof,'mem','mem.read',b::jsonb,d,'{"provider":"synthetic-private-denial","native_key":null,"envelope":{}}'::jsonb);EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'other_member_private_material_allowed';END IF;
END$$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_hidden(text,text,text)TO hub2_hufu;
SELECT encode(public.digest('synthetic-v51-8514cfc6-4e50-4cfc-af43-d52d0b441ccf','sha256'),'hex')AS other_proof \gset
SET SESSION AUTHORIZATION hub2_hufu;
SELECT pg_temp.assert_hidden(:'other_proof',:'d',:'body');
RESET SESSION AUTHORIZATION;
UPDATE authz.credentials SET revoked_at=clock_timestamp()WHERE client_id='6542517e-7654-4bc3-a7cf-568ba5b627ae';
CREATE FUNCTION pg_temp.assert_revoked(h uuid,d text,b text)RETURNS void LANGUAGE plpgsql AS $$
DECLARE denied boolean:=false;BEGIN
 BEGIN PERFORM mem.file_number_head(h,d,b);EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'revoked_credential_read_allowed';END IF;
END$$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_revoked(uuid,text,text)TO hub2_mem;
SET SESSION AUTHORIZATION hub2_mem;
SELECT pg_temp.assert_revoked(:'revoke_h'::uuid,:'d',:'body');
RESET SESSION AUTHORIZATION;
ROLLBACK;
