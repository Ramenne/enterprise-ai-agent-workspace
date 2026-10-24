SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION vault2.lighthouse_runtime_source(proof text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;e vault2.entries;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' THEN RAISE EXCEPTION 'service_only' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);
 SELECT * INTO e FROM vault2.entries WHERE name='server.jiaxin.manage' AND organization_id=(i->>'organization_id')::uuid;
 IF e.id IS NULL OR NOT e.active THEN RAISE EXCEPTION 'cloud_source_inactive' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('entry_id',e.id,'revision',e.revision,'secret_ref',e.secret_ref,'value_field',e.value_field);
END $$;
REVOKE ALL ON FUNCTION vault2.lighthouse_runtime_source(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault2.lighthouse_runtime_source(text) TO hub2_hufu;
RESET ROLE;
