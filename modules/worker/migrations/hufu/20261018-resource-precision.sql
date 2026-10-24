-- Full current definitions: preserve exact resource authorization and all transaction fences.
-- The former project-only authorization discarded the file selector. Read its revision
-- separately; resource_deadline remains the authority check on the complete resource.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SET LOCAL ROLE hub2_authz_owner;
CREATE TEMP TABLE resource_precision_preimage ON COMMIT DROP AS
SELECT p.oid,to_jsonb(p)-'prosrc' AS metadata FROM pg_catalog.pg_proc p
WHERE p.oid IN ('authz.issue_handle(text,text,text,jsonb,text,jsonb)'::regprocedure,'authz.consume_handle(uuid,text,text)'::regprocedure,'authz.assert_effect(uuid)'::regprocedure);
DO $guard$ BEGIN
 ASSERT (SELECT count(*)=3 FROM resource_precision_preimage),'missing_function';
 ASSERT (SELECT md5(prosrc)='ddc89537266576641d63442a507b2ba9' AND prosecdef AND proowner='hub2_authz_owner'::regrole AND proconfig=ARRAY['search_path=pg_catalog, authz'] FROM pg_proc WHERE oid='authz.issue_handle(text,text,text,jsonb,text,jsonb)'::regprocedure),'preimage_mismatch_issue_handle';
 ASSERT (SELECT md5(prosrc)='0fcd42097add503ff9b4172072774550' AND prosecdef AND proowner='hub2_authz_owner'::regrole AND proconfig=ARRAY['search_path=pg_catalog, authz'] FROM pg_proc WHERE oid='authz.consume_handle(uuid,text,text)'::regprocedure),'preimage_mismatch_consume_handle';
 ASSERT (SELECT md5(prosrc)='2240ea85318b6e002b3bacb66b037e31' AND prosecdef AND proowner='hub2_authz_owner'::regrole AND proconfig=ARRAY['search_path=pg_catalog, authz'] FROM pg_proc WHERE oid='authz.assert_effect(uuid)'::regprocedure),'preimage_mismatch_assert_effect';
END $guard$;
CREATE OR REPLACE FUNCTION authz.issue_handle(p_hash text,p_audience text,p_action text,p_resource jsonb,p_digest text,p_source jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE identity jsonb; p authz.principals; cl authz.clients; c authz.credentials; revision bigint; sid uuid; h authz.handles; pid uuid;
BEGIN
 IF p_hash IS NULL OR p_action IS NULL OR p_audience IS NULL OR p_resource IS NULL OR p_digest IS NULL OR authz.runtime_role()<>'hub2_hufu' OR p_audience NOT IN ('mem','v8','worker') OR split_part(p_action,'.',1)<>p_audience OR p_digest !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 identity:=authz.authenticate(p_hash); pid:=(p_resource->>'project_id')::uuid;
 IF pid IS NULL THEN RAISE EXCEPTION 'project_required'; END IF;
 PERFORM authz.lock_resources((identity->>'actor_id')::uuid,(identity->>'client_id')::uuid,(identity->>'credential_id')::uuid,authz.request_resources((identity->>'actor_id')::uuid,(identity->>'client_id')::uuid,p_resource,p_action));
 SELECT * INTO p FROM authz.principals WHERE id=(identity->>'actor_id')::uuid;
 SELECT * INTO cl FROM authz.clients WHERE id=(identity->>'client_id')::uuid;
 SELECT * INTO c FROM authz.credentials WHERE id=(identity->>'credential_id')::uuid;
 identity:=authz.authenticate(p_hash);
 IF p_action='v8.project.create' AND ((p_resource->>'organization_id')::uuid IS DISTINCT FROM p.organization_id OR (p_resource ? 'owner_id' AND (p_resource->>'owner_id')::uuid IS DISTINCT FROM p.id)) THEN RAISE EXCEPTION 'project_identity_override' USING ERRCODE='42501'; END IF;
 p_resource:=authz.resolve_resource(p_resource);
 SELECT pr.revision INTO revision FROM v8.projects pr WHERE pr.id=pid;
 PERFORM authz.resource_deadline(p.id,cl.id,pid,p_action,p_resource);
 INSERT INTO authz.source_contexts(principal_id,client_id,provider,native_key,envelope) VALUES(p.id,cl.id,p_source->>'provider',p_source->>'native_key',p_source->'envelope') ON CONFLICT(principal_id,client_id,provider,native_key) DO UPDATE SET envelope=EXCLUDED.envelope RETURNING id INTO sid;
 INSERT INTO authz.handles(principal_id,client_id,credential_id,audience,action,project_id,resource,request_digest,source_context_id,security_era,principal_epoch,client_epoch,credential_epoch,project_revision,expires_at)
 VALUES(p.id,cl.id,c.id,p_audience,p_action,pid,p_resource,p_digest,sid,(SELECT era FROM authz.security_state),p.epoch,cl.epoch,c.epoch,revision,least(clock_timestamp()+interval '30 seconds',CASE WHEN c.until_revoked THEN 'infinity'::timestamptz ELSE c.expires_at END,authz.resource_deadline(p.id,cl.id,pid,p_action,p_resource))) RETURNING * INTO h;
 PERFORM authz.issue_source_fences(h.id,p_resource,p_action);
 SELECT * INTO h FROM authz.handles WHERE id=h.id;
 RETURN jsonb_build_object('handle',h.id,'actor_id',p.id,'client_id',cl.id,'project_id',pid,'source_context_id',sid,'expires_at',h.expires_at);
END $$;

CREATE OR REPLACE FUNCTION authz.consume_handle(p_handle uuid,p_action text,p_request_digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles; p authz.principals; cl authz.clients; c authz.credentials; audience text; revision bigint;
BEGIN
 audience:=CASE authz.runtime_role() WHEN 'hub2_mem' THEN 'mem' WHEN 'hub2_v8' THEN 'v8' WHEN 'hub2_worker' THEN 'worker' ELSE NULL END;
 IF p_handle IS NULL OR p_action IS NULL OR p_request_digest IS NULL OR p_request_digest !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_handle_input' USING ERRCODE='42501'; END IF;
 SELECT * INTO h FROM authz.handles WHERE id=p_handle;
 IF h.id IS NULL OR audience IS NULL OR h.audience IS DISTINCT FROM audience OR h.action IS DISTINCT FROM p_action OR h.request_digest IS DISTINCT FROM p_request_digest THEN RAISE EXCEPTION 'invalid_handle' USING ERRCODE='42501'; END IF;
 PERFORM authz.lock_resources(h.principal_id,h.client_id,h.credential_id,COALESCE((SELECT jsonb_agg(resource) FROM authz.handle_sources WHERE handle_id=h.id),'[]')||authz.request_resources(h.principal_id,h.client_id,h.resource,h.action));
 SELECT * INTO p FROM authz.principals WHERE id=h.principal_id;
 SELECT * INTO cl FROM authz.clients WHERE id=h.client_id;
 SELECT * INTO c FROM authz.credentials WHERE id=h.credential_id;
 SELECT * INTO h FROM authz.handles WHERE id=p_handle FOR UPDATE;
 IF h.security_era IS DISTINCT FROM (SELECT era FROM authz.security_state) OR NOT p.active OR NOT cl.active OR c.revoked_at IS NOT NULL OR authz.family_valid(c.id) IS DISTINCT FROM true OR p.epoch<>h.principal_epoch OR cl.epoch<>h.client_epoch OR c.epoch<>h.credential_epoch OR (NOT c.until_revoked AND c.expires_at<=clock_timestamp()) OR h.expires_at<=clock_timestamp() OR h.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'stale_handle' USING ERRCODE='42501'; END IF;
 SELECT pr.revision INTO revision FROM v8.projects pr WHERE pr.id=h.project_id;
 PERFORM authz.resource_deadline(p.id,cl.id,h.project_id,p_action,h.resource);
 IF revision IS DISTINCT FROM h.project_revision THEN RAISE EXCEPTION 'project_changed' USING ERRCODE='42501'; END IF;
 UPDATE authz.handles SET consumed_at=clock_timestamp(),consumed_xid=pg_current_xact_id() WHERE id=h.id;
 RETURN jsonb_build_object('handle_id',h.id,'action',h.action,'actor_id',p.id,'client_id',cl.id,'project_id',h.project_id,'qualification_epoch',p.epoch,'source_context_id',h.source_context_id,'resource',h.resource,'organization_id',p.organization_id);
END $$;

CREATE OR REPLACE FUNCTION authz.assert_effect(p_handle uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;c authz.credentials;p authz.principals;cl authz.clients;era uuid;audience text;revision bigint;
BEGIN
 audience:=CASE authz.runtime_role() WHEN 'hub2_mem' THEN 'mem' WHEN 'hub2_v8' THEN 'v8' WHEN 'hub2_worker' THEN 'worker' ELSE NULL END;
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
 SELECT pr.revision INTO revision FROM v8.projects pr WHERE pr.id=h.project_id;
 IF revision IS DISTINCT FROM h.project_revision AND NOT(h.action='v8.project.create' AND h.project_revision IS NULL)
 THEN RAISE EXCEPTION 'effect_project_changed' USING ERRCODE='42501'; END IF;
END $$;

DO $guard$ BEGIN
 ASSERT NOT EXISTS(SELECT FROM resource_precision_preimage b JOIN pg_proc p ON p.oid=b.oid WHERE b.metadata IS DISTINCT FROM to_jsonb(p)-'prosrc'),'function_metadata_or_acl_changed';
 ASSERT (SELECT md5(prosrc)='b5c4e7afd5ceef89d58ecffaf42de924' FROM pg_proc WHERE oid='authz.issue_handle(text,text,text,jsonb,text,jsonb)'::regprocedure),'postimage_mismatch_issue_handle';
 ASSERT (SELECT md5(prosrc)='dd4d07d943a5919a17df79731f30c37c' FROM pg_proc WHERE oid='authz.consume_handle(uuid,text,text)'::regprocedure),'postimage_mismatch_consume_handle';
 ASSERT (SELECT md5(prosrc)='1946ba494d2694fe23b097267f8dd46b' FROM pg_proc WHERE oid='authz.assert_effect(uuid)'::regprocedure),'postimage_mismatch_assert_effect';
END $guard$;
RESET ROLE;
