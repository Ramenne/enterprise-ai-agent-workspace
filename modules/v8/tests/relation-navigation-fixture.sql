-- Synthetic authority ports in an isolated local PG cluster, not production acceptance.
CREATE EXTENSION pgcrypto;
CREATE ROLE hub2_v8_owner;
CREATE ROLE hub2_v8;
CREATE SCHEMA v8 AUTHORIZATION hub2_v8_owner;
CREATE SCHEMA authz AUTHORIZATION hub2_v8_owner;
CREATE SCHEMA mem AUTHORIZATION hub2_v8_owner;
SET ROLE hub2_v8_owner;
CREATE TABLE v8.work_items(id uuid PRIMARY KEY,project_id uuid,short_no bigint,goal text,revision bigint,actor_id uuid,created_at timestamptz,updated_at timestamptz);
CREATE TABLE v8.work_relations(id uuid PRIMARY KEY,from_work_id uuid,to_work_id uuid,basis jsonb,state text,supersedes uuid);
CREATE TABLE v8.results(work_item_id uuid,material_id uuid,version_id uuid,sha256 text);
CREATE TABLE v8.fixture_access(project_id uuid PRIMARY KEY);
CREATE TABLE v8.fixture_responses(raw jsonb);
CREATE FUNCTION authz.effect_identity(uuid) RETURNS TABLE(actor_id uuid,client_id uuid) LANGUAGE sql AS $$SELECT '00000000-0000-4000-8000-000000000001'::uuid,'00000000-0000-4000-8000-000000000002'::uuid$$;
CREATE FUNCTION authz.can_read(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT EXISTS(SELECT FROM v8.fixture_access WHERE project_id=$2)$$;
CREATE FUNCTION authz.assert_effect(uuid) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF $1 IS NULL THEN RAISE EXCEPTION 'fixture_revoked';END IF;END$$;
CREATE FUNCTION mem.version_visible(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
CREATE FUNCTION v8.assert_ref(jsonb,jsonb) RETURNS void LANGUAGE plpgsql AS $$BEGIN END$$;
CREATE FUNCTION v8.guard(uuid,text,text,jsonb) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('project_id',$4->'project_id','actor_id','00000000-0000-4000-8000-000000000001')$$;
CREATE FUNCTION v8.authorized_statement(uuid,jsonb,jsonb) RETURNS boolean LANGUAGE sql AS $$SELECT NOT coalesce(($3->>'denied')::boolean,false)$$;
CREATE FUNCTION v8.work_read(uuid,text,text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$BEGIN PERFORM authz.assert_effect($1);RETURN(SELECT raw FROM v8.fixture_responses);END$$;
INSERT INTO v8.fixture_access VALUES('00000000-0000-4000-8000-000000000011'),('00000000-0000-4000-8000-000000000012');
INSERT INTO v8.work_items VALUES
 ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000011',1,'source',1,'00000000-0000-4000-8000-000000000001',now(),now()),
 ('00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000012',2,'target',1,'00000000-0000-4000-8000-000000000001',now(),now()),
 ('00000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-000000000011',3,'candidate',1,'00000000-0000-4000-8000-000000000001',now(),now());
INSERT INTO v8.work_relations VALUES
 ('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000022','{"explanation":"old"}','active',NULL),
 ('00000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000022','{"explanation":"corrected"}','corrected','00000000-0000-4000-8000-000000000031'),
 ('00000000-0000-4000-8000-000000000033','00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000023','{"explanation":"current"}','corrected',NULL);
INSERT INTO v8.fixture_responses SELECT jsonb_build_object('state','read','current_summary','kept','read_receipt_id','kept',
 'work_item',jsonb_build_object('id','00000000-0000-4000-8000-000000000021','project_id','00000000-0000-4000-8000-000000000011'),
 'coverage',jsonb_build_object('complete',true),'relations',jsonb_build_array(to_jsonb(r))) FROM v8.work_relations r WHERE id='00000000-0000-4000-8000-000000000032';
RESET ROLE;
