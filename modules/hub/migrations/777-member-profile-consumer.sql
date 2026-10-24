-- Current native identity for existing Baize ownership IDs; old role text is informational.
CREATE OR REPLACE FUNCTION authz.member_profile_self(proof text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE identity jsonb;result jsonb;
BEGIN
 IF authz.runtime_role() IS DISTINCT FROM 'hub2_hufu' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 identity:=authz.authenticate(proof);
 SELECT jsonb_build_object('profile',p.profile,'legacy_subject',p.legacy_subject,'current_role',a.role,'source',p.source,'imported_at',p.imported_at)
 INTO result FROM authz.member_profiles p JOIN authz.principals a ON a.id=p.principal_id WHERE p.principal_id=(identity->>'actor_id')::uuid;
 RETURN result;
END $$;
