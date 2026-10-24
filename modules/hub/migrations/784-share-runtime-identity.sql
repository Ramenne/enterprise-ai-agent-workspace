BEGIN;
SET ROLE hub2_authz_owner;
DO $patch$
DECLARE s text;
BEGIN
 s:=pg_get_functiondef('authz.material_share(text,jsonb)'::regprocedure);
 s:=replace(s,'session_user<>''hub2_hufu''','authz.runtime_role()<>''hub2_hufu''');
 s:=replace(s,'PERFORM id FROM authz.security_state FOR SHARE;', 'PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals WHERE id=a FOR SHARE;
 PERFORM id FROM authz.clients WHERE id=cl FOR SHARE;
 PERFORM id FROM authz.credentials WHERE id=(i->>''credential_id'')::uuid FOR SHARE;
 i:=authz.authenticate(proof);');
 EXECUTE s;
END $patch$;
RESET ROLE;
COMMIT;
