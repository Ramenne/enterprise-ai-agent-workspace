BEGIN;
SET LOCAL ROLE hub2_authz_owner;
CREATE TABLE IF NOT EXISTS authz.member_profiles (
 principal_id uuid PRIMARY KEY REFERENCES authz.principals(id),
 legacy_subject text NOT NULL,
 profile jsonb NOT NULL,
 source text NOT NULL,
 imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON authz.member_profiles FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
CREATE OR REPLACE FUNCTION authz.member_profile_self(proof text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE identity jsonb; result jsonb;
BEGIN
 IF authz.runtime_role() IS DISTINCT FROM 'hub2_hufu' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 identity:=authz.authenticate(proof);
 SELECT jsonb_build_object('profile',p.profile,'source',p.source,'imported_at',p.imported_at)
 INTO result FROM authz.member_profiles p WHERE p.principal_id=(identity->>'actor_id')::uuid;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION authz.member_profile_self(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.member_profile_self(text) TO hub2_hufu;
COMMIT;
