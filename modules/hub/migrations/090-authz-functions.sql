GRANT SELECT ON v8.projects TO hub2_authz_owner;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.authenticate(p_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE c authz.credentials; cl authz.clients; p authz.principals;
BEGIN
 SELECT * INTO c FROM authz.credentials WHERE token_hash=p_hash;
 SELECT * INTO cl FROM authz.clients WHERE id=c.client_id;
 SELECT * INTO p FROM authz.principals WHERE id=cl.principal_id;
 IF p_hash IS NULL OR p.id IS NULL OR cl.id IS NULL OR c.id IS NULL OR p.active IS DISTINCT FROM true OR cl.active IS DISTINCT FROM true OR c.revoked_at IS NOT NULL OR authz.family_valid(c.id) IS DISTINCT FROM true OR (NOT c.until_revoked AND c.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('actor_id',p.id,'client_id',cl.id,'credential_id',c.id,'organization_id',p.organization_id,'member_label',p.display_name,'client_label',cl.label);
END $$;
CREATE FUNCTION authz.check_access(p_actor uuid,p_client uuid,p_project uuid,p_action text) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE p authz.principals; pr record; allowed boolean;
BEGIN
 SELECT * INTO p FROM authz.principals WHERE id=p_actor;
 IF p_action NOT IN ('mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','mem.discover','mem.read_history','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read') THEN RAISE EXCEPTION 'unknown_action' USING ERRCODE='42501'; END IF;
 IF NOT p.active OR NOT EXISTS(SELECT FROM authz.clients WHERE id=p_client AND principal_id=p_actor AND active AND p_action=ANY(actions)) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project;
 IF NOT FOUND THEN
  IF p_action='v8.project.create' THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'invisible_project' USING ERRCODE='42501';
 END IF;
 IF pr.state<>'active' THEN RAISE EXCEPTION 'project_closed' USING ERRCODE='42501'; END IF;
 IF p_action='v8.project.create' AND pr.owner_id=p_actor AND pr.organization_id=p.organization_id THEN RETURN pr.revision; END IF;
 IF p_action IN ('v8.project.convert','v8.project.update') AND pr.manager_id=p_actor THEN RETURN pr.revision; END IF;
 IF pr.owner_id=p_actor AND (pr.visibility='personal' OR p_action IN('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read')) THEN RETURN pr.revision; END IF;
 IF p_action IN ('mem.read','mem.discover','mem.read_history','v8.read','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read') AND pr.visibility='team' AND pr.organization_id=p.organization_id THEN RETURN pr.revision; END IF;
 SELECT EXISTS(SELECT FROM authz.qualifications q JOIN authz.principals issuer ON issuer.id=q.source_actor_id
 WHERE q.principal_id=p_actor AND q.project_id=p_project AND q.kind='work' AND q.active AND issuer.active AND (q.until_revoked OR q.expires_at>clock_timestamp()) AND p_action=ANY(q.actions)
 AND ((q.parent_id IS NULL AND (q.source_basis='independent_work' OR q.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND q.source_actor_id=pr.owner_id) OR (issuer.role='organization_admin' AND issuer.organization_id=pr.organization_id))) OR EXISTS(SELECT FROM authz.qualifications parent JOIN authz.principals pi ON pi.id=parent.source_actor_id WHERE parent.id=q.parent_id AND parent.active AND parent.kind='management' AND parent.depth<=1 AND pi.active AND (parent.until_revoked OR parent.expires_at>clock_timestamp()) AND ((parent.depth=0 AND (parent.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND parent.source_actor_id=pr.owner_id))) OR EXISTS(SELECT FROM authz.qualifications root WHERE root.id=parent.parent_id AND root.active AND root.kind='management' AND root.depth=0 AND (root.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND root.source_actor_id=pr.owner_id)) AND (root.until_revoked OR root.expires_at>clock_timestamp()) AND parent.actions<@root.actions)) AND q.actions<@parent.actions))) INTO allowed;
 IF NOT allowed THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 RETURN pr.revision;
END $$;
CREATE FUNCTION authz.issue_handle(p_hash text,p_audience text,p_action text,p_resource jsonb,p_digest text,p_source jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE identity jsonb; p authz.principals; cl authz.clients; c authz.credentials; revision bigint; sid uuid; h authz.handles; pid uuid;
BEGIN
 IF p_hash IS NULL OR p_action IS NULL OR p_audience IS NULL OR p_resource IS NULL OR p_digest IS NULL OR session_user<>'hub2_hufu' OR p_audience NOT IN ('mem','v8','worker') OR split_part(p_action,'.',1)<>p_audience OR p_digest !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 identity:=authz.authenticate(p_hash); pid:=(p_resource->>'project_id')::uuid;
 IF pid IS NULL THEN RAISE EXCEPTION 'project_required'; END IF;
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals ORDER BY id FOR SHARE;
 SELECT * INTO p FROM authz.principals WHERE id=(identity->>'actor_id')::uuid;
 SELECT * INTO cl FROM authz.clients WHERE id=(identity->>'client_id')::uuid FOR SHARE;
 SELECT * INTO c FROM authz.credentials WHERE id=(identity->>'credential_id')::uuid FOR SHARE;
 PERFORM id FROM v8.projects ORDER BY id FOR SHARE;
 PERFORM id FROM authz.qualifications ORDER BY id FOR SHARE;
 identity:=authz.authenticate(p_hash);
 IF p_action='v8.project.create' AND ((p_resource->>'organization_id')::uuid IS DISTINCT FROM p.organization_id OR (p_resource ? 'owner_id' AND (p_resource->>'owner_id')::uuid IS DISTINCT FROM p.id)) THEN RAISE EXCEPTION 'project_identity_override' USING ERRCODE='42501'; END IF;
 p_resource:=authz.resolve_resource(p_resource);
 revision:=authz.check_access(p.id,cl.id,pid,p_action);
 PERFORM authz.resource_deadline(p.id,cl.id,pid,p_action,p_resource);
 INSERT INTO authz.source_contexts(principal_id,client_id,provider,native_key,envelope) VALUES(p.id,cl.id,p_source->>'provider',p_source->>'native_key',p_source->'envelope') ON CONFLICT(principal_id,client_id,provider,native_key) DO UPDATE SET envelope=EXCLUDED.envelope RETURNING id INTO sid;
 INSERT INTO authz.handles(principal_id,client_id,credential_id,audience,action,project_id,resource,request_digest,source_context_id,security_era,principal_epoch,client_epoch,credential_epoch,project_revision,expires_at)
 VALUES(p.id,cl.id,c.id,p_audience,p_action,pid,p_resource,p_digest,sid,(SELECT era FROM authz.security_state),p.epoch,cl.epoch,c.epoch,revision,least(clock_timestamp()+interval '30 seconds',CASE WHEN c.until_revoked THEN 'infinity'::timestamptz ELSE c.expires_at END,authz.resource_deadline(p.id,cl.id,pid,p_action,p_resource))) RETURNING * INTO h;
 PERFORM authz.issue_source_fences(h.id,p_resource,p_action);
 SELECT * INTO h FROM authz.handles WHERE id=h.id;
 RETURN jsonb_build_object('handle',h.id,'actor_id',p.id,'client_id',cl.id,'project_id',pid,'source_context_id',sid,'expires_at',h.expires_at);
END $$;
CREATE FUNCTION authz.consume_handle(p_handle uuid,p_action text,p_request_digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles; p authz.principals; cl authz.clients; c authz.credentials; audience text; revision bigint;
BEGIN
 audience:=CASE session_user WHEN 'hub2_mem' THEN 'mem' WHEN 'hub2_v8' THEN 'v8' WHEN 'hub2_worker' THEN 'worker' ELSE NULL END;
 IF p_handle IS NULL OR p_action IS NULL OR p_request_digest IS NULL OR p_request_digest !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_handle_input' USING ERRCODE='42501'; END IF;
 SELECT * INTO h FROM authz.handles WHERE id=p_handle;
 IF h.id IS NULL OR audience IS NULL OR h.audience IS DISTINCT FROM audience OR h.action IS DISTINCT FROM p_action OR h.request_digest IS DISTINCT FROM p_request_digest THEN RAISE EXCEPTION 'invalid_handle' USING ERRCODE='42501'; END IF;
 PERFORM id FROM authz.security_state FOR SHARE;
 IF p_action IN ('v8.project.create','v8.project.convert') THEN
  PERFORM id FROM authz.principals ORDER BY id FOR UPDATE;
 ELSE
  PERFORM id FROM authz.principals ORDER BY id FOR SHARE;
 END IF;
 SELECT * INTO p FROM authz.principals WHERE id=h.principal_id;
 SELECT * INTO cl FROM authz.clients WHERE id=h.client_id FOR SHARE;
 SELECT * INTO c FROM authz.credentials WHERE id=h.credential_id FOR SHARE;
 PERFORM id FROM v8.projects ORDER BY id FOR SHARE;
 PERFORM id FROM authz.qualifications ORDER BY id FOR SHARE;
 SELECT * INTO h FROM authz.handles WHERE id=p_handle FOR UPDATE;
 IF h.security_era IS DISTINCT FROM (SELECT era FROM authz.security_state) OR NOT p.active OR NOT cl.active OR c.revoked_at IS NOT NULL OR authz.family_valid(c.id) IS DISTINCT FROM true OR p.epoch<>h.principal_epoch OR cl.epoch<>h.client_epoch OR c.epoch<>h.credential_epoch OR (NOT c.until_revoked AND c.expires_at<=clock_timestamp()) OR h.expires_at<=clock_timestamp() OR h.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'stale_handle' USING ERRCODE='42501'; END IF;
 revision:=authz.check_access(p.id,cl.id,h.project_id,p_action);
 PERFORM authz.resource_deadline(p.id,cl.id,h.project_id,p_action,h.resource);
 IF revision IS DISTINCT FROM h.project_revision THEN RAISE EXCEPTION 'project_changed' USING ERRCODE='42501'; END IF;
 UPDATE authz.handles SET consumed_at=clock_timestamp(),consumed_xid=pg_current_xact_id() WHERE id=h.id;
 RETURN jsonb_build_object('handle_id',h.id,'action',h.action,'actor_id',p.id,'client_id',cl.id,'project_id',h.project_id,'qualification_epoch',p.epoch,'source_context_id',h.source_context_id,'resource',h.resource,'organization_id',p.organization_id);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA authz FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.authenticate(text),authz.issue_handle(text,text,text,jsonb,text,jsonb) TO hub2_hufu;
GRANT EXECUTE ON FUNCTION authz.consume_handle(uuid,text,text) TO hub2_mem,hub2_v8,hub2_worker,hub2_mem_owner,hub2_v8_owner;
RESET ROLE;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.manage(p_hash text,p_command text,p_body jsonb,p_key text,p_digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
#variable_conflict use_variable
DECLARE identity jsonb; actor uuid; client uuid; old authz.operations; result jsonb; pid uuid; pr record; parent authz.qualifications; q authz.qualifications; target uuid; actions text[]; expiry timestamptz; unlimited boolean; cid uuid; cred uuid; event_id uuid; event_revision bigint;
BEGIN
 IF p_hash IS NULL OR p_command IS NULL OR p_body IS NULL OR p_key IS NULL OR p_digest IS NULL OR session_user<>'hub2_hufu' OR length(p_key) NOT BETWEEN 1 AND 200 OR p_digest !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 identity:=authz.authenticate(p_hash); actor:=(identity->>'actor_id')::uuid; client:=(identity->>'client_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals ORDER BY id FOR UPDATE;
 PERFORM id FROM authz.clients WHERE id=client FOR UPDATE;
 PERFORM id FROM authz.credentials WHERE id=(identity->>'credential_id')::uuid FOR UPDATE;
 identity:=authz.authenticate(p_hash);
 SELECT * INTO old FROM authz.operations WHERE principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN IF old.request_digest<>p_digest THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF; RETURN old.result; END IF;
 IF p_command='credential.create' THEN
  SELECT array_agg(value) INTO actions FROM jsonb_array_elements_text(p_body->'actions');
  IF actions IS NULL OR cardinality(actions)=0 OR array_position(actions,NULL) IS NOT NULL THEN RAISE EXCEPTION 'action_expansion' USING ERRCODE='42501'; END IF;
  -- Explicit alias avoids column/variable ambiguity.
  IF NOT EXISTS(SELECT FROM authz.clients c WHERE c.id=client AND actions<@c.actions) THEN RAISE EXCEPTION 'action_expansion' USING ERRCODE='42501'; END IF;
  expiry:=(p_body->>'expires_at')::timestamptz; unlimited:=coalesce((p_body->>'until_revoked')::boolean,false);
  IF (expiry IS NULL)<>unlimited OR (expiry IS NOT NULL AND (NOT isfinite(expiry) OR expiry<=clock_timestamp())) THEN RAISE EXCEPTION 'invalid_expiry'; END IF;
  INSERT INTO authz.clients(principal_id,label,actions) VALUES(actor,p_body->>'label',actions) RETURNING id INTO cid;
  INSERT INTO authz.credentials(client_id,token_hash,expires_at,until_revoked,wechat_app_id,wechat_open_id) SELECT cid,p_body->>'token_hash',expiry,unlimited,origin.wechat_app_id,origin.wechat_open_id FROM authz.credentials origin WHERE origin.id=(identity->>'credential_id')::uuid RETURNING id INTO cred;
  result:=jsonb_build_object('client_id',cid,'credential_id',cred,'state','committed');
 ELSIF p_command='credential.revoke' THEN
  UPDATE authz.credentials c SET revoked_at=clock_timestamp(),epoch=epoch+1 FROM authz.clients cl WHERE c.id=(p_body->>'credential_id')::uuid AND cl.id=c.client_id AND cl.principal_id=actor RETURNING c.id INTO cred;
  IF cred IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  result:=jsonb_build_object('credential_id',cred,'state','committed');
 ELSIF p_command IN ('qualification.grant','management.delegate','qualification.revoke','qualification.freeze','qualification.unfreeze') THEN
  pid:=(p_body->>'project_id')::uuid; SELECT * INTO pr FROM v8.projects WHERE id=pid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  PERFORM id FROM authz.qualifications WHERE project_id=pid ORDER BY id FOR UPDATE;
  IF p_body->>'parent_id' IS NOT NULL THEN
   SELECT * INTO parent FROM authz.qualifications WHERE id=(p_body->>'parent_id')::uuid;
   IF NOT authz.management_valid(parent.id,actor,pid) OR parent.id IS NULL OR parent.principal_id<>actor OR parent.project_id<>pid OR parent.kind<>'management' OR parent.depth>1 OR NOT parent.active OR parent.frozen OR (NOT parent.until_revoked AND parent.expires_at<=clock_timestamp()) OR (NOT(parent.depth=0 AND (parent.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND parent.source_actor_id=pr.owner_id))) AND NOT EXISTS(SELECT FROM authz.qualifications root WHERE root.id=parent.parent_id AND root.active AND root.depth=0 AND (root.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND root.source_actor_id=pr.owner_id)) AND (root.until_revoked OR root.expires_at>clock_timestamp()))) THEN RAISE EXCEPTION 'invalid_management_source' USING ERRCODE='42501'; END IF;
  ELSIF NOT(actor=pr.manager_id OR (pr.visibility='personal' AND actor=pr.owner_id)) AND NOT EXISTS(SELECT FROM authz.principals a JOIN authz.principals o ON o.id=pr.owner_id WHERE a.id=actor AND a.role='organization_admin' AND a.organization_id=o.organization_id) THEN RAISE EXCEPTION 'management_required' USING ERRCODE='42501'; END IF;
  IF p_command IN('qualification.revoke','qualification.freeze','qualification.unfreeze') THEN
   SELECT * INTO q FROM authz.qualifications WHERE id=(p_body->>'qualification_id')::uuid AND project_id=pid;
   IF q.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
   IF parent.id IS NOT NULL AND q.parent_id IS DISTINCT FROM parent.id THEN RAISE EXCEPTION 'source_mismatch' USING ERRCODE='42501'; END IF;
   IF p_body ? 'expected_epoch' AND q.epoch IS DISTINCT FROM (p_body->>'expected_epoch')::bigint THEN RAISE EXCEPTION 'qualification_revision_conflict' USING ERRCODE='40001';END IF;
   UPDATE authz.qualifications SET active=CASE WHEN p_command='qualification.revoke' THEN false ELSE active END,frozen=CASE WHEN p_command='qualification.freeze' THEN true WHEN p_command='qualification.unfreeze' THEN false ELSE frozen END,epoch=epoch+1 WHERE id=q.id;
   UPDATE authz.principals SET epoch=epoch+1 WHERE id=q.principal_id OR id IN(SELECT principal_id FROM authz.qualifications WHERE parent_id=q.id OR parent_id IN(SELECT id FROM authz.qualifications WHERE parent_id=q.id));
   result:=jsonb_build_object('qualification_id',q.id,'state','committed');
  ELSE
   target:=(p_body->>'principal_id')::uuid;
   IF NOT EXISTS(SELECT FROM authz.principals a JOIN authz.principals t ON t.id=target WHERE a.id=actor AND t.active AND a.organization_id=t.organization_id) THEN RAISE EXCEPTION 'organization_mismatch' USING ERRCODE='42501'; END IF;
   SELECT array_agg(value) INTO actions FROM jsonb_array_elements_text(p_body->'actions');
   expiry:=(p_body->>'expires_at')::timestamptz; unlimited:=coalesce((p_body->>'until_revoked')::boolean,false);
   IF actions IS NULL OR cardinality(actions)=0 OR array_position(actions,NULL) IS NOT NULL OR (expiry IS NULL)<>unlimited OR (expiry IS NOT NULL AND (NOT isfinite(expiry) OR expiry<=clock_timestamp())) THEN RAISE EXCEPTION 'invalid_scope'; END IF;
   IF p_command='qualification.grant' AND actions && ARRAY['v8.project.convert','v8.project.update'] THEN RAISE EXCEPTION 'management_action_in_work_grant' USING ERRCODE='42501';END IF;
   IF NOT authz.valid_selector(COALESCE(p_body->'resource_selector','{"version":1,"kind":"project"}')) THEN RAISE EXCEPTION 'invalid_selector' USING ERRCODE='42501';END IF;
   IF parent.id IS NOT NULL AND NOT authz.selector_subset(COALESCE(p_body->'resource_selector','{"version":1,"kind":"project"}'),parent.resource_selector) THEN RAISE EXCEPTION 'resource_expansion' USING ERRCODE='42501';END IF;
   IF parent.id IS NOT NULL AND (NOT actions<@parent.actions OR (NOT parent.until_revoked AND (unlimited OR expiry>parent.expires_at))) THEN RAISE EXCEPTION 'scope_expansion' USING ERRCODE='42501'; END IF;
   IF p_command='management.delegate' AND parent.id IS NOT NULL THEN RAISE EXCEPTION 'delegation_depth' USING ERRCODE='42501'; END IF;
   IF p_command='management.delegate' THEN
    INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,kind,depth,expires_at,until_revoked,source_project_revision) VALUES(actor,pid,actions,actor,'management',0,expiry,unlimited,pr.revision) RETURNING * INTO parent;
    UPDATE authz.qualifications SET resource_selector=COALESCE(p_body->'resource_selector','{"version":1,"kind":"project"}'),source_basis='management_appointment' WHERE id=parent.id;
    parent.resource_selector:=COALESCE(p_body->'resource_selector','{"version":1,"kind":"project"}');
   END IF;
   INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,parent_id,kind,depth,expires_at,until_revoked,source_project_revision)
   VALUES(target,pid,actions,actor,parent.id,CASE WHEN p_command='management.delegate' THEN 'management' ELSE 'work' END,CASE WHEN parent.id IS NULL THEN 0 ELSE 1 END,expiry,unlimited,pr.revision) RETURNING id INTO target;
   UPDATE authz.qualifications SET resource_selector=COALESCE(p_body->'resource_selector','{"version":1,"kind":"project"}'),source_basis=CASE WHEN p_command='qualification.grant' AND parent.id IS NULL THEN 'independent_work' ELSE 'management_appointment' END WHERE id=target;
   result:=jsonb_build_object('qualification_id',target,'state','committed');
  END IF;
 ELSE RAISE EXCEPTION 'unknown_command' USING ERRCODE='42501'; END IF;
 result:=result||jsonb_build_object('operation_id',gen_random_uuid());
 INSERT INTO authz.operations VALUES(actor,p_key,p_digest,result);
 event_id:=coalesce((result->>'qualification_id')::uuid,(result->>'credential_id')::uuid);
 SELECT epoch INTO event_revision FROM authz.qualifications WHERE id=event_id;
 IF event_revision IS NULL THEN SELECT epoch INTO event_revision FROM authz.credentials WHERE id=event_id; END IF;
 INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload) VALUES('authz',event_id,event_revision,p_command,pid,result);
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(actor,client,'authz',p_command,coalesce(pid,cred),result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION authz.manage(text,text,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.manage(text,text,jsonb,text,text) TO hub2_hufu;
RESET ROLE;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.can_read(p_actor uuid,p_project uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE p authz.principals; pr record;
BEGIN
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals ORDER BY id FOR SHARE;
 SELECT * INTO p FROM authz.principals WHERE id=p_actor;
 IF p.id IS NULL OR NOT p.active THEN RETURN false; END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM id FROM authz.qualifications WHERE project_id=p_project ORDER BY id FOR SHARE;
 IF pr.state<>'active' THEN RETURN false; END IF;
 IF pr.owner_id=p_actor THEN RETURN true; END IF;
 IF pr.visibility='team' AND pr.organization_id=p.organization_id THEN RETURN true; END IF;
 RETURN EXISTS(SELECT FROM authz.qualifications q JOIN authz.principals issuer ON issuer.id=q.source_actor_id WHERE q.principal_id=p_actor AND q.project_id=p_project AND q.kind='work' AND q.active AND issuer.active AND (q.until_revoked OR q.expires_at>clock_timestamp()) AND q.actions && ARRAY['mem.read','v8.project.read','v8.work.read'] AND ((q.parent_id IS NULL AND (q.source_basis='independent_work' OR q.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND q.source_actor_id=pr.owner_id) OR (issuer.role='organization_admin' AND issuer.organization_id=pr.organization_id))) OR EXISTS(SELECT FROM authz.qualifications parent WHERE parent.id=q.parent_id AND parent.active AND parent.kind='management' AND (parent.until_revoked OR parent.expires_at>clock_timestamp()) AND ((parent.depth=0 AND (parent.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND parent.source_actor_id=pr.owner_id))) OR EXISTS(SELECT FROM authz.qualifications root WHERE root.id=parent.parent_id AND root.active AND root.depth=0 AND (root.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND root.source_actor_id=pr.owner_id)) AND (root.until_revoked OR root.expires_at>clock_timestamp()))))));
END $$;
REVOKE ALL ON FUNCTION authz.can_read(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.can_read(uuid,uuid) TO hub2_mem_owner,hub2_v8_owner;
RESET ROLE;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.can_share(p_actor uuid,p_client uuid,p_project uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals ORDER BY id FOR SHARE;
 PERFORM id FROM authz.clients WHERE id=p_client FOR SHARE;
 PERFORM id FROM v8.projects WHERE id=p_project FOR SHARE;
 PERFORM id FROM authz.qualifications WHERE project_id=p_project ORDER BY id FOR SHARE;
 PERFORM authz.check_access(p_actor,p_client,p_project,'mem.share'); RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION authz.can_share(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.can_share(uuid,uuid,uuid) TO hub2_mem_owner,hub2_v8_owner;
RESET ROLE;
