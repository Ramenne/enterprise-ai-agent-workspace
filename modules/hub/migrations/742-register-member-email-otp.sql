-- Original 2.0: current primary binds a pending email; only provider OTP verifies it.
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.register_member_otp(proof text,uid text,p_email text,p_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;actor uuid;existing authn."user"; normalized text:=lower(btrim(p_email));
BEGIN
 IF authz.runtime_role() IS DISTINCT FROM 'hub2_hufu' OR uid IS NULL OR normalized IS NULL OR normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR length(normalized)>254 OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_member_registration' USING ERRCODE='22023'; END IF;
 i:=authz.authenticate(proof);actor:=(i->>'actor_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals WHERE id=actor FOR UPDATE;
 i:=authz.authenticate(proof);
 IF (i->>'is_primary')::boolean IS DISTINCT FROM true OR NOT EXISTS(SELECT FROM authz.principals WHERE id=actor AND active AND kind='member') THEN RAISE EXCEPTION 'current_primary_member_required' USING ERRCODE='42501'; END IF;
 SELECT u.* INTO existing FROM authn."user" u JOIN authz.member_accounts m ON m.authn_user_id=u.id WHERE m.principal_id=actor FOR UPDATE OF u;
 IF FOUND THEN
  IF lower(existing.email) IS DISTINCT FROM normalized THEN RAISE EXCEPTION 'member_email_already_bound' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('state','primary_bound_email_pending','email_verified',existing."emailVerified",'member_mapping','current_primary_identity');
 END IF;
 INSERT INTO authn."user"(id,name,email,"emailVerified",image,"createdAt","updatedAt") VALUES(uid,btrim(p_name),normalized,false,NULL,clock_timestamp(),clock_timestamp());
 INSERT INTO authz.member_accounts(authn_user_id,principal_id,provenance) VALUES(uid,actor,'current_primary_credential_verified_email_otp_pending');
 RETURN jsonb_build_object('state','primary_bound_email_pending','email_verified',false,'member_mapping','current_primary_identity');
END $$;
REVOKE ALL ON FUNCTION authz.register_member_otp(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.register_member_otp(text,text,text,text) TO hub2_hufu;
RESET ROLE;
