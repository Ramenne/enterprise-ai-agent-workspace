-- Platform ownership repair only. This does not apply the team's business permission patch.
BEGIN;
DO $check$ BEGIN
 IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid='authz.authorization_application_decision(text,jsonb)'::regprocedure))
    NOT IN('postgres','hub2_authz_owner') THEN RAISE EXCEPTION 'unexpected_function_owner';END IF;
 IF md5(pg_get_functiondef('authz.authorization_application_decision(text,jsonb)'::regprocedure))<>'85aa27a6f61cf964125573a29e31d043' THEN
  RAISE EXCEPTION 'application_function_baseline_changed';END IF;
END $check$;
ALTER FUNCTION authz.authorization_application_decision(text,jsonb) OWNER TO hub2_authz_owner;
GRANT SELECT ON authz.application_targets TO hub2_authz_owner;
DO $verify$ BEGIN
 ASSERT pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid='authz.authorization_application_decision(text,jsonb)'::regprocedure))='hub2_authz_owner';
 ASSERT md5(pg_get_functiondef('authz.authorization_application_decision(text,jsonb)'::regprocedure))='85aa27a6f61cf964125573a29e31d043','function implementation changed';
 ASSERT has_function_privilege('hub2_hufu','authz.authorization_application_decision(text,jsonb)','EXECUTE');
 ASSERT NOT EXISTS(SELECT FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid='authz.authorization_application_decision(text,jsonb)'::regprocedure)) WHERE grantee=0 AND privilege_type='EXECUTE'),'PUBLIC execution granted';
 ASSERT has_table_privilege('hub2_authz_owner','authz.application_targets','SELECT');
END $verify$;
COMMIT;
