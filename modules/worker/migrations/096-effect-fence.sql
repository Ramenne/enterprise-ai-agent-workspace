SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.assert_effect(p_handle uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;c authz.credentials;p authz.principals;cl authz.clients;era uuid;audience text;revision bigint;
BEGIN
 audience:=CASE session_user WHEN 'hub2_mem' THEN 'mem' WHEN 'hub2_v8' THEN 'v8' WHEN 'hub2_worker' THEN 'worker' ELSE NULL END;
 SELECT * INTO h FROM authz.handles WHERE id=p_handle;
 IF p_handle IS NULL OR audience IS NULL OR h.id IS NULL OR h.audience<>audience OR h.consumed_at IS NULL OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id()
 THEN RAISE EXCEPTION 'effect_without_current_guard' USING ERRCODE='42501'; END IF;
 SELECT security_state.era INTO era FROM authz.security_state WHERE id;
 SELECT * INTO p FROM authz.principals WHERE id=h.principal_id;
 SELECT * INTO cl FROM authz.clients WHERE id=h.client_id;
 SELECT * INTO c FROM authz.credentials WHERE id=h.credential_id;
 IF p.id IS NULL OR cl.id IS NULL OR c.id IS NULL THEN RAISE EXCEPTION 'effect_identity_missing' USING ERRCODE='42501';END IF;
 IF era IS DISTINCT FROM h.security_era OR NOT p.active OR NOT cl.active OR c.revoked_at IS NOT NULL
 OR authz.family_valid(c.id) IS DISTINCT FROM true
 OR p.epoch<>h.principal_epoch OR cl.epoch<>h.client_epoch OR c.epoch<>h.credential_epoch
 OR h.expires_at<=clock_timestamp() OR (NOT c.until_revoked AND c.expires_at<=clock_timestamp())
 THEN RAISE EXCEPTION 'effect_authority_expired' USING ERRCODE='42501'; END IF;
 -- The first guard retains all safety row locks. Re-evaluate the clocks after the last business lock wait.
 PERFORM authz.resource_deadline(h.principal_id,h.client_id,h.project_id,h.action,COALESCE(h.resource->'resolved_resource',h.resource));
 PERFORM authz.assert_all_sources(p_handle);
 revision:=authz.check_access(h.principal_id,h.client_id,h.project_id,h.action);
 IF revision IS DISTINCT FROM h.project_revision AND NOT(h.action='v8.project.create' AND h.project_revision IS NULL)
 THEN RAISE EXCEPTION 'effect_project_changed' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION authz.assert_effect(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.assert_effect(uuid) TO hub2_mem_owner,hub2_v8_owner;
RESET ROLE;
