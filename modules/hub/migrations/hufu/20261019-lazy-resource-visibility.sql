CREATE OR REPLACE FUNCTION authz.can_read_resource(actor uuid, project uuid, r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE candidate record;
BEGIN
 IF actor IS NULL OR project IS NULL OR r IS NULL THEN RETURN false;END IF;
 FOR candidate IN SELECT id,actions FROM authz.clients WHERE principal_id=actor AND active ORDER BY id LOOP
  IF NOT (coalesce('mem.read'=ANY(candidate.actions),false) OR authz.ordinary_member_client901(candidate.id)) THEN CONTINUE;END IF;
  BEGIN PERFORM authz.resource_deadline(actor,candidate.id,project,'mem.read',r);RETURN true;EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 END LOOP;RETURN false;
END $function$;

