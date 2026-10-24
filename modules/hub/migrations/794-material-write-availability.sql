BEGIN;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.material_write_available(hid uuid,r jsonb)RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;
BEGIN
 SELECT *INTO h FROM authz.handles WHERE id=hid;
 IF authz.runtime_role()<>'hub2_mem'OR h.audience<>'mem'OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id()OR h.expires_at<=clock_timestamp()OR h.project_id IS DISTINCT FROM(r->>'project_id')::uuid THEN RETURN false;END IF;
 BEGIN PERFORM authz.resource_deadline(h.principal_id,h.client_id,h.project_id,'mem.write',r);RETURN true;EXCEPTION WHEN insufficient_privilege THEN RETURN false;END;
END $$;
REVOKE ALL ON FUNCTION authz.material_write_available(uuid,jsonb)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.material_write_available(uuid,jsonb)TO hub2_mem_owner;
RESET ROLE;
SET ROLE hub2_mem_owner;
DO $patch$
DECLARE s text;
BEGIN
 s:=pg_get_functiondef('mem.material_display_info(uuid,jsonb,jsonb)'::regprocedure);
 s:=replace(s,'BEGIN PERFORM authz.resource_deadline((c->>''actor_id'')::uuid,(c->>''client_id'')::uuid,m.project_id,''mem.write'',jsonb_build_object(''project_id'',m.project_id,''material_id'',m.id));writable:=true;EXCEPTION WHEN insufficient_privilege THEN writable:=false;END;','writable:=authz.material_write_available(h,jsonb_build_object(''project_id'',m.project_id,''material_id'',m.id));');EXECUTE s;
END $patch$;
RESET ROLE;
COMMIT;
