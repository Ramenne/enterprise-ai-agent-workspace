BEGIN;
CREATE OR REPLACE FUNCTION authz._clock_test_original_can_read(actor uuid, project uuid, r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE cid uuid;
BEGIN
 IF actor IS NULL OR project IS NULL OR r IS NULL THEN RETURN false;END IF;
 FOR cid IN SELECT id FROM authz.clients WHERE principal_id=actor AND active AND (authz.ordinary_member_client901(id) OR 'mem.read'=ANY(actions)) ORDER BY id LOOP
  BEGIN PERFORM authz.resource_deadline(actor,cid,project,'mem.read',r);RETURN true;EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 END LOOP;RETURN false;
END $function$;


DO $$
DECLARE x record;expected boolean;observed boolean;actor uuid:='46b19322-b0f9-490c-ad90-47989799fd74';r jsonb; checked integer:=0;
BEGIN
 FOR x IN SELECT * FROM (VALUES ('50a739be-40ee-40ce-a5d5-94304e55f355'::uuid,'f7108359-c848-4bac-add2-46faa3326f44'::uuid),('49f74db2-c4b7-40f5-a37a-e45a552df416'::uuid,'873bdece-ece6-48c2-ade0-dd631141609f'::uuid),('3e6b07ac-ee24-44cf-afcb-6fc3e64ea18e'::uuid,'9caa7dd5-dbee-4c54-a255-d3b30a60a042'::uuid),('23aa4b7f-3854-4fe8-ac72-328a059fb1d7'::uuid,'5b127fa7-73f4-44f2-af0c-a0f6915d4e92'::uuid)) AS scopes(project_id,material_id) LOOP
  r:=jsonb_build_object('project_id',x.project_id,'material_id',x.material_id);
  expected:=authz._clock_test_original_can_read(actor,x.project_id,r);observed:=authz.can_read_resource(actor,x.project_id,r);
  IF expected IS DISTINCT FROM observed THEN RAISE EXCEPTION 'resource_visibility_semantics_changed';END IF;checked:=checked+1;
 END LOOP;
 IF checked<3 THEN RAISE EXCEPTION 'insufficient_actual_scope_cases';END IF;
 IF authz.can_read_resource(NULL,'23aa4b7f-3854-4fe8-ac72-328a059fb1d7','{}') OR authz.can_read_resource(actor,NULL,'{}') OR authz.can_read_resource(actor,'23aa4b7f-3854-4fe8-ac72-328a059fb1d7',NULL) OR authz.can_read_resource('00000000-0000-4000-8000-000000000099','23aa4b7f-3854-4fe8-ac72-328a059fb1d7','{}') THEN RAISE EXCEPTION 'invalid_scope_allowed';END IF;
END $$;
SELECT jsonb_build_object('state','passed','checks','original_and_lazy_visibility_equal_on_real_scopes;nulls_and_unknown_actor_denied');
ROLLBACK;
