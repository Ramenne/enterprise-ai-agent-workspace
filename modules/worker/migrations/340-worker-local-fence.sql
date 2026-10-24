-- Only the actual service authority is a dependency; unrelated members must not stall worker tasks.
SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.assert_service(a text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE b evidence.service_binding;current_binding evidence.service_binding;p authz.principals;c authz.clients;k authz.credentials;era uuid;
BEGIN
 IF session_user IS DISTINCT FROM 'hub2_worker' OR a IS NULL OR a NOT IN ('worker.dispatch','worker.consume','worker.maintenance','worker.metrics','worker.governance') THEN RAISE EXCEPTION 'internal_service_required' USING ERRCODE='42501';END IF;
 -- Read a pointer, then take ordered authority locks and recheck the pointer.
 -- No binding mutation can replace these dependencies during admitted effects.
 SELECT * INTO b FROM evidence.service_binding WHERE db_role=session_user AND active;
 IF b.db_role IS NULL THEN RAISE EXCEPTION 'unbound_service' USING ERRCODE='42501';END IF;
 PERFORM id FROM authz.security_state FOR SHARE;
 SELECT * INTO p FROM authz.principals WHERE id=b.principal_id FOR SHARE;
 SELECT * INTO c FROM authz.clients WHERE id=b.client_id FOR SHARE;
 SELECT * INTO k FROM authz.credentials WHERE id=b.credential_id FOR SHARE;
 SELECT * INTO current_binding FROM evidence.service_binding WHERE db_role=session_user AND active FOR SHARE;
 IF current_binding.db_role IS NULL OR
    ROW(current_binding.principal_id,current_binding.client_id,current_binding.credential_id,current_binding.security_era)
    IS DISTINCT FROM ROW(b.principal_id,b.client_id,b.credential_id,b.security_era) THEN
  RAISE EXCEPTION 'service_binding_changed' USING ERRCODE='42501';
 END IF;
 SELECT security_state.era INTO era FROM authz.security_state WHERE id;
 IF p.id IS NULL OR c.id IS NULL OR k.id IS NULL OR p.kind IS DISTINCT FROM 'service' OR NOT p.active OR NOT c.active OR c.principal_id IS DISTINCT FROM p.id OR k.client_id IS DISTINCT FROM c.id OR k.revoked_at IS NOT NULL OR authz.family_valid(k.id) IS DISTINCT FROM true OR (NOT k.until_revoked AND k.expires_at<=clock_timestamp()) OR era IS DISTINCT FROM b.security_era OR (a=ANY(c.actions)) IS DISTINCT FROM true THEN RAISE EXCEPTION 'service_authority_expired' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('actor_id',p.id,'client_id',c.id,'security_era',era);
END $$;
REVOKE ALL ON FUNCTION authz.assert_service(text) FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
GRANT EXECUTE ON FUNCTION authz.assert_service(text) TO hub2_evidence_owner;
RESET ROLE;
