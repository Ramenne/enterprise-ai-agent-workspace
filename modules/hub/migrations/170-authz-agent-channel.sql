GRANT UPDATE(id) ON mem.disclosures TO hub2_authz_owner;
-- Agent fluency: typed actual references, bounded appointments, lifecycle reads, precise authority fences.
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.is_fixed_ref(r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,authz AS $$
 SELECT COALESCE(jsonb_typeof(r)='object' AND r->>'material_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND r->>'version_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND r->>'sha256' ~ '^[0-9a-f]{64}$',false) $$;
CREATE FUNCTION authz.request_refs(b jsonb,a text) RETURNS SETOF jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,authz AS $$
 SELECT DISTINCT value FROM jsonb_path_query(CASE WHEN a='mem.process' THEN b-'outputs' ELSE b END,'$.**') value WHERE authz.is_fixed_ref(value) $$;
CREATE FUNCTION authz.request_roots(b jsonb,a text) RETURNS TABLE(version_id uuid,implicit boolean) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE r jsonb;run mem.processing_runs;
BEGIN
 FOR r IN SELECT * FROM authz.request_refs(b,a) LOOP
  IF NOT EXISTS(SELECT FROM mem.content_versions cv WHERE cv.id=(r->>'version_id')::uuid AND cv.material_id=(r->>'material_id')::uuid AND cv.sha256=r->>'sha256') THEN RAISE EXCEPTION 'fixed_ref_mismatch' USING ERRCODE='42501';END IF;
  version_id:=(r->>'version_id')::uuid;implicit:=false;RETURN NEXT;
 END LOOP;
 IF a IN('mem.read','mem.share','mem.write','mem.correct','mem.process') AND b->>'version_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN version_id:=(b->>'version_id')::uuid;implicit:=false;RETURN NEXT;END IF;
 IF b->>'run_id' ~ '^[0-9a-f-]{36}$' THEN
  SELECT * INTO run FROM mem.processing_runs WHERE id=(b->>'run_id')::uuid;
  FOR r IN SELECT value FROM jsonb_array_elements(COALESCE(run.inputs,'[]')) LOOP version_id:=(r->>'version_id')::uuid;implicit:=false;RETURN NEXT;END LOOP;
 END IF;
 IF b->>'context_id' ~ '^[0-9a-f-]{36}$' THEN
  FOR version_id IN SELECT cs.version_id FROM v8.context_sources cs WHERE cs.context_id=(b->>'context_id')::uuid LOOP implicit:=true;RETURN NEXT;END LOOP;
 END IF;
END $$;
CREATE FUNCTION authz.version_resources(v uuid,a text,actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,authz AS $$
DECLARE root mem.content_versions;disclosed boolean;result jsonb;
BEGIN
 SELECT * INTO root FROM mem.content_versions WHERE id=v;
 IF root.id IS NULL OR (root.provenance_state='pending' AND (a='mem.share' OR NOT(root.actor_id=actor OR EXISTS(SELECT FROM mem.materials own WHERE own.id=root.material_id AND own.owner_id=actor)))) THEN RAISE EXCEPTION 'source_unavailable_to_actor' USING ERRCODE='42501';END IF;
 disclosed:=a='mem.read' AND EXISTS(SELECT FROM mem.disclosures d WHERE d.output_version_id=v AND d.state='active' AND d.manifest->>'continued_source_access'='not_required');
 SELECT jsonb_agg(jsonb_build_object('project_id',m.project_id,'material_id',m.id,'version_id',cv.id,'sha256',cv.sha256) ORDER BY m.project_id,m.id,cv.id) INTO result FROM (WITH RECURSIVE closure(id) AS(SELECT v UNION SELECT e.input_version_id FROM mem.source_edges e JOIN closure c ON c.id=e.output_version_id WHERE NOT disclosed) SELECT id FROM closure) cl JOIN mem.content_versions cv ON cv.id=cl.id JOIN mem.materials m ON m.id=cv.material_id;
 RETURN result;
END $$;
CREATE FUNCTION authz.resource_set_readable(actor uuid,client uuid,resources jsonb,a text) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,authz AS $$
DECLARE r jsonb;
BEGIN
 FOR r IN SELECT value FROM jsonb_array_elements(resources) LOOP PERFORM authz.resource_deadline(actor,client,(r->>'project_id')::uuid,a,r);END LOOP;RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;
CREATE FUNCTION authz.lock_resources(actor uuid,client uuid,credential uuid,resources jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE project_ids uuid[];qids uuid[];people uuid[];origin uuid;fid uuid;
BEGIN
 SELECT array_agg(DISTINCT (r->>'project_id')::uuid) INTO project_ids FROM jsonb_array_elements(resources) r;
 SELECT array_agg(id),array_agg(DISTINCT person) INTO qids,people FROM (
  WITH RECURSIVE dependencies AS(SELECT q.id,q.parent_id,q.source_actor_id,q.principal_id FROM authz.qualifications q WHERE q.project_id=ANY(project_ids) AND q.principal_id=actor UNION SELECT q.id,q.parent_id,q.source_actor_id,q.principal_id FROM authz.qualifications q JOIN dependencies d ON q.id=d.parent_id)
  SELECT d.id,x.person FROM dependencies d CROSS JOIN LATERAL(VALUES(d.source_actor_id),(d.principal_id)) x(person)) selected;
 SELECT family_id INTO fid FROM authz.credentials WHERE id=credential;
 SELECT origin_credential_id INTO origin FROM authz.refresh_families WHERE id=fid;
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals WHERE id=actor OR id=ANY(people) OR id IN(SELECT owner_id FROM v8.projects WHERE id=ANY(project_ids)) OR id IN(SELECT manager_id FROM v8.projects WHERE id=ANY(project_ids)) ORDER BY id FOR SHARE;
 PERFORM id FROM authz.clients WHERE id=client OR id IN(SELECT client_id FROM authz.credentials WHERE id=origin) ORDER BY id FOR SHARE;
 PERFORM id FROM authz.credentials WHERE id=credential OR id=origin ORDER BY id FOR SHARE;
 PERFORM id FROM authz.refresh_families WHERE id=fid FOR SHARE;
 PERFORM id FROM v8.projects WHERE id=ANY(project_ids) ORDER BY id FOR SHARE;
 PERFORM id FROM authz.qualifications WHERE id=ANY(qids) ORDER BY id FOR SHARE;
 PERFORM d.id FROM mem.disclosures d WHERE d.output_version_id IN(SELECT (r->>'version_id')::uuid FROM jsonb_array_elements(resources) r WHERE r->>'version_id' ~* '^[0-9a-f-]{36}$') ORDER BY d.id FOR SHARE;
 PERFORM id FROM authz.resource_areas WHERE id IN(SELECT (r->>'area_id')::uuid FROM jsonb_array_elements(resources) r WHERE r->>'area_id' ~ '^[0-9a-f-]{36}$') ORDER BY id FOR SHARE;
END $$;
CREATE FUNCTION authz.request_resources(actor uuid,client uuid,b jsonb,a text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,authz AS $$
DECLARE result jsonb:=jsonb_build_array(b);root record;resources jsonb;action text;
BEGIN
 action:=CASE WHEN a='mem.share' AND b->>'version_id' IS NOT NULL THEN 'mem.share' ELSE 'mem.read' END;
 FOR root IN SELECT DISTINCT * FROM authz.request_roots(b,a) LOOP
  BEGIN
   resources:=authz.version_resources(root.version_id,action,actor);
   IF root.implicit AND NOT authz.resource_set_readable(actor,client,resources,action) THEN CONTINUE;END IF;
   result:=result||resources;
  EXCEPTION WHEN insufficient_privilege THEN IF NOT root.implicit THEN RAISE;END IF;
  END;
 END LOOP;RETURN result;
END $$;
CREATE OR REPLACE FUNCTION authz.issue_source_fences(hid uuid,b jsonb,a text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;root record;resources jsonb;r jsonb;source_action text;deadline timestamptz;rev bigint;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF session_user<>'hub2_hufu' OR h.id IS NULL OR h.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'invalid_source_signer' USING ERRCODE='42501';END IF;
 source_action:=CASE WHEN a='mem.share' AND b->>'version_id' IS NOT NULL THEN 'mem.share' ELSE 'mem.read' END;
 FOR root IN SELECT DISTINCT * FROM authz.request_roots(b,a) LOOP
  BEGIN
   resources:=authz.version_resources(root.version_id,source_action,h.principal_id);
   IF root.implicit AND NOT authz.resource_set_readable(h.principal_id,h.client_id,resources,source_action) THEN CONTINUE;END IF;
   FOR r IN SELECT value FROM jsonb_array_elements(resources) LOOP
    SELECT revision INTO rev FROM v8.projects WHERE id=(r->>'project_id')::uuid;
    deadline:=least(h.expires_at,authz.resource_deadline(h.principal_id,h.client_id,(r->>'project_id')::uuid,source_action,r));
    INSERT INTO authz.handle_sources VALUES(hid,(r->>'project_id')::uuid,source_action,r,rev,deadline) ON CONFLICT(handle_id,project_id,action,resource) DO UPDATE SET deadline=least(authz.handle_sources.deadline,EXCLUDED.deadline);
    UPDATE authz.handles SET expires_at=least(expires_at,deadline) WHERE id=hid;
   END LOOP;
  EXCEPTION WHEN insufficient_privilege THEN IF NOT root.implicit THEN RAISE;END IF;
  END;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION authz.check_access(p_actor uuid,p_client uuid,p_project uuid,p_action text) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
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
 IF pr.state<>'active' AND p_action NOT IN ('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read') THEN RAISE EXCEPTION 'project_closed' USING ERRCODE='42501'; END IF;
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
CREATE OR REPLACE FUNCTION authz.qualification_deadline(qid uuid,p_actor uuid,p_project uuid,p_action text,r jsonb) RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path=pg_catalog,authz AS $$
DECLARE q authz.qualifications;p authz.principals;pr record;parent authz.qualifications;root authz.qualifications;issuer authz.principals;deadline timestamptz:='infinity';
BEGIN
 SELECT * INTO q FROM authz.qualifications WHERE id=qid;
 SELECT * INTO p FROM authz.principals WHERE id=p_actor;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project;
 IF q.id IS NULL OR p.id IS NULL OR pr.id IS NULL OR p.active IS DISTINCT FROM true OR (pr.state IS DISTINCT FROM 'active' AND p_action NOT IN ('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read')) OR pr.kind NOT IN('project','dialogue') OR p.organization_id IS DISTINCT FROM pr.organization_id OR q.principal_id IS DISTINCT FROM p_actor OR q.project_id IS DISTINCT FROM p_project OR q.kind<>'work' OR q.active IS DISTINCT FROM true OR q.frozen OR (p_action=ANY(q.actions)) IS DISTINCT FROM true OR NOT authz.selector_matches(q.resource_selector,p_project,r) THEN RETURN NULL;END IF;
 SELECT * INTO issuer FROM authz.principals WHERE id=q.source_actor_id;
 IF issuer.active IS DISTINCT FROM true OR issuer.organization_id IS DISTINCT FROM pr.organization_id THEN RETURN NULL;END IF;
 IF NOT q.until_revoked THEN deadline:=q.expires_at;END IF;
 IF deadline IS NULL OR deadline<=clock_timestamp() THEN RETURN NULL;END IF;
 IF q.parent_id IS NULL THEN
  IF q.source_basis='independent_work' OR q.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND q.source_actor_id=pr.owner_id) OR issuer.role='organization_admin' THEN RETURN deadline;END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO parent FROM authz.qualifications WHERE id=q.parent_id;
 IF parent.id IS NULL OR parent.kind<>'management' OR parent.active IS DISTINCT FROM true OR parent.frozen OR parent.project_id<>p_project OR q.source_actor_id NOT IN(parent.principal_id,parent.source_actor_id) OR (q.actions<@parent.actions) IS DISTINCT FROM true OR NOT authz.selector_subset(q.resource_selector,parent.resource_selector) THEN RETURN NULL;END IF;
 IF NOT parent.until_revoked THEN deadline:=least(deadline,parent.expires_at);END IF;
 SELECT * INTO issuer FROM authz.principals WHERE id=parent.source_actor_id;
 IF issuer.active IS DISTINCT FROM true OR issuer.organization_id IS DISTINCT FROM pr.organization_id OR deadline<=clock_timestamp() THEN RETURN NULL;END IF;
 IF parent.depth=0 THEN
  IF parent.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND parent.source_actor_id=pr.owner_id) OR issuer.role='organization_admin' THEN RETURN deadline;END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO root FROM authz.qualifications WHERE id=parent.parent_id;
 SELECT * INTO issuer FROM authz.principals WHERE id=root.source_actor_id;
 IF root.id IS NULL OR root.kind<>'management' OR root.depth<>0 OR root.active IS DISTINCT FROM true OR root.frozen OR root.project_id<>p_project OR parent.source_actor_id IS DISTINCT FROM root.principal_id OR issuer.active IS DISTINCT FROM true OR issuer.organization_id IS DISTINCT FROM pr.organization_id OR (parent.actions<@root.actions) IS DISTINCT FROM true OR NOT authz.selector_subset(parent.resource_selector,root.resource_selector) THEN RETURN NULL;END IF;
 IF NOT root.until_revoked THEN deadline:=least(deadline,root.expires_at);END IF;
 IF deadline<=clock_timestamp() OR NOT(root.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND root.source_actor_id=pr.owner_id) OR issuer.role='organization_admin') THEN RETURN NULL;END IF;
 RETURN deadline;
END $$;
CREATE OR REPLACE FUNCTION authz.resource_deadline(p_actor uuid,p_client uuid,p_project uuid,p_action text,r jsonb) RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path=pg_catalog,authz AS $$
DECLARE p authz.principals;pr record;deadline timestamptz;q record;
BEGIN
 IF p_action NOT IN('mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','mem.discover','mem.read_history','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read') THEN RAISE EXCEPTION 'unknown_action' USING ERRCODE='42501';END IF;
 IF p_actor IS NULL OR p_client IS NULL OR p_project IS NULL OR p_action IS NULL OR r IS NULL THEN RAISE EXCEPTION 'invalid_authority_input' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM authz.principals WHERE id=p_actor;
 IF p.active IS DISTINCT FROM true OR NOT EXISTS(SELECT FROM authz.clients c WHERE c.id=p_client AND c.principal_id=p_actor AND c.active AND p_action=ANY(c.actions)) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project;
 IF NOT FOUND THEN IF p_action='v8.project.create' AND (r->>'organization_id')::uuid=p.organization_id THEN RETURN 'infinity';END IF;RAISE EXCEPTION 'invisible_project' USING ERRCODE='42501';END IF;
 IF (pr.state<>'active' AND p_action NOT IN ('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read')) OR pr.kind NOT IN('project','dialogue') OR pr.organization_id IS DISTINCT FROM p.organization_id OR NOT authz.selector_matches('{"version":1,"kind":"project"}',p_project,r) THEN RAISE EXCEPTION 'invalid_project_resource' USING ERRCODE='42501';END IF;
 IF p_action='v8.project.create' AND pr.owner_id=p_actor THEN RETURN 'infinity';END IF;
 IF p_action IN('v8.project.convert','v8.project.update') AND pr.manager_id=p_actor THEN RETURN 'infinity';END IF;
 IF (pr.visibility='personal' AND pr.owner_id=p_actor) OR p_action IN('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read') AND (pr.owner_id=p_actor OR pr.visibility='team') THEN RETURN 'infinity';END IF;
 FOR q IN SELECT id FROM authz.qualifications WHERE principal_id=p_actor AND project_id=p_project AND kind='work' ORDER BY id LOOP
  deadline:=authz.qualification_deadline(q.id,p_actor,p_project,p_action,r);
  IF deadline IS NOT NULL THEN RETURN deadline;END IF;
 END LOOP;
 RAISE EXCEPTION 'resource_scope_forbidden' USING ERRCODE='42501';
END $$;
CREATE OR REPLACE FUNCTION authz.resolve_resource(r jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,authz AS $$
DECLARE mid uuid;pid uuid;vid uuid;
BEGIN
 IF r IS NULL OR jsonb_typeof(r)<>'object' THEN RAISE EXCEPTION 'invalid_resource' USING ERRCODE='42501';END IF;
 mid:=CASE WHEN r->>'material_id' ~* '^[0-9a-f-]{36}$' THEN (r->>'material_id')::uuid END;pid:=(r->>'project_id')::uuid;
 IF mid IS NULL AND r->>'operation_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN SELECT material_id INTO mid FROM mem.operations WHERE id=(r->>'operation_id')::uuid AND project_id=pid;END IF;
 IF mid IS NULL AND r->>'placement_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN SELECT material_id INTO mid FROM mem.placements WHERE id=(r->>'placement_id')::uuid AND project_id=pid;END IF;
 IF mid IS NULL AND r->>'read_receipt_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN SELECT material_id INTO mid FROM mem.read_receipts WHERE id=(r->>'read_receipt_id')::uuid;END IF;
 IF mid IS NULL AND r->>'disclosure_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN SELECT cv.material_id INTO mid FROM mem.disclosures d JOIN mem.content_versions cv ON cv.id=d.output_version_id WHERE d.id=(r->>'disclosure_id')::uuid;END IF;
 IF mid IS NULL AND r->>'version_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN SELECT material_id INTO mid FROM mem.content_versions WHERE id=(r->>'version_id')::uuid;END IF;
 IF mid IS NOT NULL THEN RETURN r||jsonb_build_object('material_id',mid);END IF;RETURN r;
END $$;
CREATE OR REPLACE FUNCTION authz.issue_handle(p_hash text,p_audience text,p_action text,p_resource jsonb,p_digest text,p_source jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE identity jsonb; p authz.principals; cl authz.clients; c authz.credentials; revision bigint; sid uuid; h authz.handles; pid uuid;
BEGIN
 IF p_hash IS NULL OR p_action IS NULL OR p_audience IS NULL OR p_resource IS NULL OR p_digest IS NULL OR session_user<>'hub2_hufu' OR p_audience NOT IN ('mem','v8','worker') OR split_part(p_action,'.',1)<>p_audience OR p_digest !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 identity:=authz.authenticate(p_hash); pid:=(p_resource->>'project_id')::uuid;
 IF pid IS NULL THEN RAISE EXCEPTION 'project_required'; END IF;
 PERFORM authz.lock_resources((identity->>'actor_id')::uuid,(identity->>'client_id')::uuid,(identity->>'credential_id')::uuid,authz.request_resources((identity->>'actor_id')::uuid,(identity->>'client_id')::uuid,p_resource,p_action));
 SELECT * INTO p FROM authz.principals WHERE id=(identity->>'actor_id')::uuid;
 SELECT * INTO cl FROM authz.clients WHERE id=(identity->>'client_id')::uuid;
 SELECT * INTO c FROM authz.credentials WHERE id=(identity->>'credential_id')::uuid;
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
CREATE OR REPLACE FUNCTION authz.consume_handle(p_handle uuid,p_action text,p_request_digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles; p authz.principals; cl authz.clients; c authz.credentials; audience text; revision bigint;
BEGIN
 audience:=CASE session_user WHEN 'hub2_mem' THEN 'mem' WHEN 'hub2_v8' THEN 'v8' WHEN 'hub2_worker' THEN 'worker' ELSE NULL END;
 IF p_handle IS NULL OR p_action IS NULL OR p_request_digest IS NULL OR p_request_digest !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_handle_input' USING ERRCODE='42501'; END IF;
 SELECT * INTO h FROM authz.handles WHERE id=p_handle;
 IF h.id IS NULL OR audience IS NULL OR h.audience IS DISTINCT FROM audience OR h.action IS DISTINCT FROM p_action OR h.request_digest IS DISTINCT FROM p_request_digest THEN RAISE EXCEPTION 'invalid_handle' USING ERRCODE='42501'; END IF;
 PERFORM authz.lock_resources(h.principal_id,h.client_id,h.credential_id,COALESCE((SELECT jsonb_agg(resource) FROM authz.handle_sources WHERE handle_id=h.id),'[]')||authz.request_resources(h.principal_id,h.client_id,h.resource,h.action));
 SELECT * INTO p FROM authz.principals WHERE id=h.principal_id;
 SELECT * INTO cl FROM authz.clients WHERE id=h.client_id;
 SELECT * INTO c FROM authz.credentials WHERE id=h.credential_id;
 SELECT * INTO h FROM authz.handles WHERE id=p_handle FOR UPDATE;
 IF h.security_era IS DISTINCT FROM (SELECT era FROM authz.security_state) OR NOT p.active OR NOT cl.active OR c.revoked_at IS NOT NULL OR authz.family_valid(c.id) IS DISTINCT FROM true OR p.epoch<>h.principal_epoch OR cl.epoch<>h.client_epoch OR c.epoch<>h.credential_epoch OR (NOT c.until_revoked AND c.expires_at<=clock_timestamp()) OR h.expires_at<=clock_timestamp() OR h.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'stale_handle' USING ERRCODE='42501'; END IF;
 revision:=authz.check_access(p.id,cl.id,h.project_id,p_action);
 PERFORM authz.resource_deadline(p.id,cl.id,h.project_id,p_action,h.resource);
 IF revision IS DISTINCT FROM h.project_revision THEN RAISE EXCEPTION 'project_changed' USING ERRCODE='42501'; END IF;
 UPDATE authz.handles SET consumed_at=clock_timestamp(),consumed_xid=pg_current_xact_id() WHERE id=h.id;
 RETURN jsonb_build_object('handle_id',h.id,'action',h.action,'actor_id',p.id,'client_id',cl.id,'project_id',h.project_id,'qualification_epoch',p.epoch,'source_context_id',h.source_context_id,'resource',h.resource,'organization_id',p.organization_id);
END $$;
CREATE OR REPLACE FUNCTION authz.assert_request_resource(hid uuid,b jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;r jsonb;deadline timestamptz;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF h.id IS NULL OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() OR b IS NULL OR (b->>'project_id')::uuid IS DISTINCT FROM h.project_id THEN RAISE EXCEPTION 'invalid_bound_resource' USING ERRCODE='42501';END IF;
 r:=authz.resolve_resource(b);
 PERFORM authz.lock_resources(h.principal_id,h.client_id,h.credential_id,authz.request_resources(h.principal_id,h.client_id,b,h.action));
 deadline:=authz.resource_deadline(h.principal_id,h.client_id,h.project_id,h.action,r);
 UPDATE authz.handles SET expires_at=least(expires_at,deadline),resource=resource||jsonb_build_object('resolved_resource',r) WHERE id=hid;
 -- Moving a material into another collection requires rights to the exact destination as well.
 IF b->>'collection_id' IS NOT NULL AND b->>'material_id' IS NOT NULL THEN
  deadline:=authz.resource_deadline(h.principal_id,h.client_id,h.project_id,h.action,jsonb_build_object('project_id',h.project_id,'collection_id',b->>'collection_id'));
  UPDATE authz.handles SET expires_at=least(expires_at,deadline) WHERE id=hid;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION authz.assert_sources(hid uuid,resources jsonb,source_action text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;r jsonb;deadline timestamptz;pid uuid;rev bigint;audience text;
BEGIN
 audience:=CASE session_user WHEN 'hub2_mem' THEN 'mem' WHEN 'hub2_v8' THEN 'v8' ELSE NULL END;
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF h.id IS NULL OR audience IS NULL OR h.audience IS DISTINCT FROM audience OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() OR source_action NOT IN('mem.read','mem.share','v8.project.read') OR source_action IS NULL OR resources IS NULL OR jsonb_typeof(resources)<>'array' THEN RAISE EXCEPTION 'invalid_source_guard' USING ERRCODE='42501';END IF;
 PERFORM authz.lock_resources(h.principal_id,h.client_id,h.credential_id,resources);
 FOR r IN SELECT value FROM jsonb_array_elements(resources) LOOP
  pid:=(r->>'project_id')::uuid;
  -- consume_handle already holds the common ordered source-authority fences.
  SELECT revision INTO rev FROM v8.projects WHERE id=pid;
  IF rev IS NULL THEN RAISE EXCEPTION 'unknown_source_project' USING ERRCODE='42501';END IF;
  deadline:=least(h.expires_at,authz.resource_deadline(h.principal_id,h.client_id,pid,source_action,r));
  INSERT INTO authz.handle_sources VALUES(hid,pid,source_action,r,rev,deadline) ON CONFLICT(handle_id,project_id,action,resource) DO UPDATE SET deadline=least(authz.handle_sources.deadline,EXCLUDED.deadline);
  UPDATE authz.handles SET expires_at=least(expires_at,deadline) WHERE id=hid;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION authz.manage(p_hash text,p_command text,p_body jsonb,p_key text,p_digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
#variable_conflict use_variable
DECLARE identity jsonb; actor uuid; client uuid; old authz.operations; result jsonb; pid uuid; pr record; parent authz.qualifications; q authz.qualifications; target uuid; actions text[]; expiry timestamptz; unlimited boolean; cid uuid; cred uuid; event_id uuid; event_revision bigint;
BEGIN
 IF p_hash IS NULL OR p_command IS NULL OR p_body IS NULL OR p_key IS NULL OR p_digest IS NULL OR session_user<>'hub2_hufu' OR length(p_key) NOT BETWEEN 1 AND 200 OR p_digest !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 identity:=authz.authenticate(p_hash); actor:=(identity->>'actor_id')::uuid; client:=(identity->>'client_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals WHERE id=actor OR id IN(SELECT owner_id FROM v8.projects WHERE id=(p_body->>'project_id')::uuid) OR id IN(SELECT manager_id FROM v8.projects WHERE id=(p_body->>'project_id')::uuid) ORDER BY id FOR SHARE;
 PERFORM id FROM authz.clients WHERE id=client FOR SHARE;
 PERFORM id FROM authz.credentials WHERE id=(identity->>'credential_id')::uuid FOR SHARE;
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
CREATE OR REPLACE FUNCTION authz.qualification_epoch_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF (NEW.active,NEW.frozen,NEW.expires_at,NEW.until_revoked,NEW.actions,NEW.resource_selector,NEW.parent_id,NEW.source_basis) IS DISTINCT FROM (OLD.active,OLD.frozen,OLD.expires_at,OLD.until_revoked,OLD.actions,OLD.resource_selector,OLD.parent_id,OLD.source_basis) THEN
  NEW.epoch:=greatest(NEW.epoch,OLD.epoch+1);

 END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION authz.lock_security_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 PERFORM id FROM authz.security_state FOR SHARE;



 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION authz.session_start(p_hash text,p_access_hash text,p_refresh_hash text,p_key text,p_digest text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE identity jsonb;actor uuid;cid uuid;origin authz.credentials;f authz.refresh_families;access authz.credentials;expiry timestamptz;old authz.operations;result jsonb;
BEGIN
 IF session_user<>'hub2_hufu' OR p_hash IS NULL OR p_access_hash IS NULL OR p_refresh_hash IS NULL OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_access_hash !~ '^[0-9a-f]{64}$' OR p_refresh_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_session_start' USING ERRCODE='42501';END IF;
 identity:=authz.authenticate(p_hash);actor:=(identity->>'actor_id')::uuid;cid:=(identity->>'client_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id=actor FOR UPDATE;PERFORM id FROM authz.clients WHERE id=cid FOR UPDATE;PERFORM id FROM authz.credentials WHERE client_id=cid ORDER BY id FOR UPDATE;
 identity:=authz.authenticate(p_hash);SELECT * INTO origin FROM authz.credentials WHERE id=(identity->>'credential_id')::uuid;
 SELECT * INTO old FROM authz.operations WHERE principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN IF old.request_digest IS DISTINCT FROM p_digest THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;RETURN old.result;END IF;
 IF origin.family_id IS NOT NULL THEN RAISE EXCEPTION 'nested_refresh_family' USING ERRCODE='42501';END IF;
 expiry:=least(clock_timestamp()+interval '7 days',CASE WHEN origin.until_revoked THEN 'infinity'::timestamptz ELSE origin.expires_at END);
 INSERT INTO authz.refresh_families(principal_id,client_id,origin_credential_id,expires_at) VALUES(actor,cid,origin.id,expiry) RETURNING * INTO f;
 INSERT INTO authz.credentials(client_id,token_hash,expires_at,family_id) VALUES(cid,p_access_hash,least(expiry,clock_timestamp()+interval '15 minutes'),f.id) RETURNING * INTO access;
 INSERT INTO authz.refresh_generations VALUES(f.id,1,p_refresh_hash,access.id,expiry,NULL);
 INSERT INTO authz.sessions(principal_id,token_hash,refresh_hash,expires_at,refresh_expires_at) VALUES(actor,p_access_hash,p_refresh_hash,access.expires_at,expiry);
 result:=jsonb_build_object('state','committed','family_id',f.id,'generation',1,'expires_at',access.expires_at,'refresh_expires_at',expiry,'operation_id',gen_random_uuid());
 INSERT INTO authz.operations VALUES(actor,p_key,p_digest,result);RETURN result;
END $$;
CREATE OR REPLACE FUNCTION authz.session_refresh(p_refresh_hash text,p_access_hash text,p_next_refresh_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE g authz.refresh_generations;f authz.refresh_families;p authz.principals;c authz.clients;origin authz.credentials;access authz.credentials;expiry timestamptz;
BEGIN
 IF session_user<>'hub2_hufu' OR p_refresh_hash IS NULL OR p_access_hash IS NULL OR p_next_refresh_hash IS NULL OR p_refresh_hash !~ '^[0-9a-f]{64}$' OR p_access_hash !~ '^[0-9a-f]{64}$' OR p_next_refresh_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_refresh' USING ERRCODE='42501';END IF;
 SELECT * INTO g FROM authz.refresh_generations WHERE refresh_hash=p_refresh_hash;
 IF g.family_id IS NULL THEN RETURN jsonb_build_object('state','rejected','error_code','unauthenticated');END IF;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id IN(SELECT principal_id FROM authz.refresh_families WHERE id=g.family_id) FOR UPDATE;PERFORM id FROM authz.clients WHERE id IN(SELECT client_id FROM authz.refresh_families WHERE id=g.family_id) FOR UPDATE;PERFORM id FROM authz.credentials WHERE family_id=g.family_id OR id IN(SELECT origin_credential_id FROM authz.refresh_families WHERE id=g.family_id) ORDER BY id FOR UPDATE;
 SELECT * INTO f FROM authz.refresh_families WHERE id=g.family_id FOR UPDATE;
 SELECT * INTO g FROM authz.refresh_generations WHERE refresh_hash=p_refresh_hash FOR UPDATE;
 IF g.used_at IS NOT NULL THEN PERFORM authz.revoke_family(f.id,'refresh_reuse');RETURN jsonb_build_object('state','rejected','error_code','refresh_reuse','family_revoked',true);END IF;
 SELECT * INTO p FROM authz.principals WHERE id=f.principal_id;SELECT * INTO c FROM authz.clients WHERE id=f.client_id;SELECT * INTO origin FROM authz.credentials WHERE id=f.origin_credential_id;
 IF f.active IS DISTINCT FROM true OR p.active IS DISTINCT FROM true OR c.active IS DISTINCT FROM true OR f.expires_at<=clock_timestamp() OR g.expires_at<=clock_timestamp() OR NOT authz.family_valid(origin.id) THEN PERFORM authz.revoke_family(f.id,'expired_or_disabled');RETURN jsonb_build_object('state','rejected','error_code','unauthenticated');END IF;
 UPDATE authz.refresh_generations SET used_at=clock_timestamp() WHERE family_id=g.family_id AND generation=g.generation;
 UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE id=g.credential_id;
 UPDATE authz.sessions SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE token_hash=(SELECT token_hash FROM authz.credentials WHERE id=g.credential_id);
 expiry:=least(f.expires_at,clock_timestamp()+interval '15 minutes');
 INSERT INTO authz.credentials(client_id,token_hash,expires_at,family_id) VALUES(c.id,p_access_hash,expiry,f.id) RETURNING * INTO access;
 INSERT INTO authz.refresh_generations VALUES(f.id,g.generation+1,p_next_refresh_hash,access.id,f.expires_at,NULL);
 INSERT INTO authz.sessions(principal_id,token_hash,refresh_hash,expires_at,refresh_expires_at) VALUES(p.id,p_access_hash,p_next_refresh_hash,expiry,f.expires_at);
 RETURN jsonb_build_object('state','committed','family_id',f.id,'generation',g.generation+1,'expires_at',expiry,'refresh_expires_at',f.expires_at);
END $$;
CREATE OR REPLACE FUNCTION authz.stop(p_hash text,p_command text,p_target uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE identity jsonb;actor uuid;subject authz.principals;caller authz.principals;cid uuid;fid uuid;
BEGIN
 IF session_user<>'hub2_hufu' OR p_hash IS NULL OR p_command IS NULL OR p_target IS NULL OR p_command NOT IN('principal.disable','session.logout_all','client.disable','session.logout') THEN RAISE EXCEPTION 'invalid_stop' USING ERRCODE='42501';END IF;
 identity:=authz.authenticate(p_hash);actor:=(identity->>'actor_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id=actor OR id=p_target OR id IN(SELECT principal_id FROM authz.clients WHERE id=p_target) ORDER BY id FOR UPDATE;PERFORM id FROM authz.clients WHERE principal_id IN(actor,p_target) OR id=p_target ORDER BY id FOR UPDATE;PERFORM id FROM authz.credentials WHERE client_id IN(SELECT id FROM authz.clients WHERE principal_id IN(actor,p_target) OR id=p_target) ORDER BY id FOR UPDATE;
 identity:=authz.authenticate(p_hash);SELECT * INTO caller FROM authz.principals WHERE id=actor;
 IF p_command='client.disable' THEN
  SELECT principal_id INTO cid FROM authz.clients WHERE id=p_target;
  IF cid IS DISTINCT FROM actor THEN RAISE EXCEPTION 'foreign_client' USING ERRCODE='42501';END IF;
  UPDATE authz.clients SET active=false,epoch=epoch+1 WHERE id=p_target;
  UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE client_id=p_target;
 ELSIF p_command='session.logout' THEN
  IF p_target IS DISTINCT FROM (identity->>'credential_id')::uuid THEN RAISE EXCEPTION 'foreign_session' USING ERRCODE='42501';END IF;
  SELECT family_id INTO fid FROM authz.credentials WHERE id=p_target;
  IF fid IS NOT NULL THEN PERFORM authz.revoke_family(fid,'session_logout');ELSE UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE id=p_target;END IF;
 ELSE
  SELECT * INTO subject FROM authz.principals WHERE id=p_target;
  IF subject.id IS NULL OR (actor<>subject.id AND (caller.role<>'organization_admin' OR caller.organization_id<>subject.organization_id)) THEN RAISE EXCEPTION 'foreign_principal' USING ERRCODE='42501';END IF;
  UPDATE authz.principals SET active=CASE WHEN p_command='principal.disable' THEN false ELSE active END,epoch=epoch+1 WHERE id=p_target;
  UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE client_id IN(SELECT id FROM authz.clients WHERE principal_id=p_target);
  UPDATE authz.sessions SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE principal_id=p_target;
  DELETE FROM authn."session" WHERE "userId" IN(SELECT authn_user_id FROM authz.member_accounts WHERE principal_id=p_target);
 END IF;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(actor,(identity->>'client_id')::uuid,'authz',p_command,p_target,'{}');
 RETURN jsonb_build_object('state','committed','target_id',p_target,'operation_id',gen_random_uuid());
END $$;
CREATE OR REPLACE FUNCTION authz.mem_scope_membership_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF (NEW.collection_id,NEW.project_id,NEW.material_id,NEW.active) IS DISTINCT FROM (OLD.collection_id,OLD.project_id,OLD.material_id,OLD.active) THEN
  PERFORM id FROM authz.security_state FOR SHARE;
  PERFORM id FROM v8.projects WHERE id IN(OLD.project_id,NEW.project_id) ORDER BY id FOR UPDATE;
 END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION authz.can_read(p_actor uuid,p_project uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE cid uuid;act text;
BEGIN
 IF p_actor IS NULL OR p_project IS NULL THEN RETURN false;END IF;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id=p_actor FOR SHARE;PERFORM id FROM v8.projects WHERE id=p_project FOR SHARE;PERFORM id FROM authz.qualifications WHERE principal_id=p_actor AND project_id=p_project ORDER BY id FOR SHARE;
 FOR cid,act IN SELECT c.id,allowed.action FROM authz.clients c CROSS JOIN (VALUES('mem.read'),('v8.project.read')) allowed(action) WHERE c.principal_id=p_actor AND c.active AND allowed.action=ANY(c.actions) ORDER BY c.id LOOP
  BEGIN PERFORM authz.resource_deadline(p_actor,cid,p_project,act,jsonb_build_object('project_id',p_project));RETURN true;EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 END LOOP;RETURN false;
END $$;
CREATE OR REPLACE FUNCTION authz.can_share(p_actor uuid,p_client uuid,p_project uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF p_actor IS NULL OR p_client IS NULL OR p_project IS NULL THEN RETURN false;END IF;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id=p_actor FOR SHARE;PERFORM id FROM authz.clients WHERE id=p_client FOR SHARE;PERFORM id FROM v8.projects WHERE id=p_project FOR SHARE;PERFORM id FROM authz.qualifications WHERE principal_id=p_actor AND project_id=p_project ORDER BY id FOR SHARE;
 PERFORM authz.resource_deadline(p_actor,p_client,p_project,'mem.share',jsonb_build_object('project_id',p_project));RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;
RESET ROLE;
SET ROLE hub2_mem_owner;
CREATE OR REPLACE FUNCTION mem.bind_request_sources(h uuid,b jsonb,actor uuid,a text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE root record;
BEGIN
 FOR root IN SELECT DISTINCT * FROM authz.request_roots(b,a) LOOP
  BEGIN PERFORM mem.assert_version_sources(h,root.version_id,'mem.read');EXCEPTION WHEN insufficient_privilege THEN IF NOT root.implicit THEN RAISE;END IF;END;
 END LOOP;
END $$;
RESET ROLE;
GRANT EXECUTE ON FUNCTION authz.request_roots(jsonb,text) TO hub2_mem_owner;

ALTER TABLE v8.projects DROP CONSTRAINT projects_state_check;
ALTER TABLE v8.projects ADD CONSTRAINT projects_state_check CHECK(state IN('active','closed','archived'));
SET ROLE hub2_authz_owner;
CREATE TABLE authz.work_presets(project_id uuid PRIMARY KEY,actions text[] NOT NULL CHECK(cardinality(actions)>0 AND array_position(actions,NULL) IS NULL),resource_selector jsonb NOT NULL CHECK(authz.valid_selector(resource_selector)),source_actor_id uuid NOT NULL REFERENCES authz.principals,revision bigint NOT NULL DEFAULT 1);
CREATE FUNCTION authz.set_work_preset(p_hash text,project uuid,acts text[],selector jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE identity jsonb;actor uuid;pr record;person authz.principals;parent authz.qualifications;
BEGIN
 IF session_user<>'hub2_hufu' OR project IS NULL OR acts IS NULL OR cardinality(acts)=0 OR array_position(acts,NULL) IS NOT NULL OR NOT authz.valid_selector(selector) THEN RAISE EXCEPTION 'invalid_work_preset' USING ERRCODE='42501';END IF;
 identity:=authz.authenticate(p_hash);actor:=(identity->>'actor_id')::uuid;
 SELECT * INTO pr FROM v8.projects WHERE id=project FOR UPDATE;SELECT * INTO person FROM authz.principals WHERE id=actor FOR SHARE;
 IF pr.id IS NULL OR NOT(actor=pr.manager_id OR (pr.visibility='personal' AND actor=pr.owner_id) OR (person.role='organization_admin' AND person.organization_id=pr.organization_id)) THEN RAISE EXCEPTION 'management_required' USING ERRCODE='42501';END IF;
 SELECT * INTO parent FROM authz.qualifications WHERE project_id=project AND principal_id=pr.manager_id AND kind='management' AND depth=0 AND active AND NOT frozen ORDER BY id LIMIT 1;
 IF parent.id IS NOT NULL AND (NOT acts<@parent.actions OR NOT authz.selector_subset(selector,parent.resource_selector)) THEN RAISE EXCEPTION 'preset_expansion' USING ERRCODE='42501';END IF;
 IF acts && ARRAY['v8.project.create','v8.project.convert','v8.project.update'] THEN RAISE EXCEPTION 'management_action_in_work_preset' USING ERRCODE='42501';END IF;
 INSERT INTO authz.work_presets VALUES(project,acts,selector,actor,1) ON CONFLICT(project_id) DO UPDATE SET actions=EXCLUDED.actions,resource_selector=EXCLUDED.resource_selector,source_actor_id=actor,revision=authz.work_presets.revision+1 WHERE (authz.work_presets.actions,authz.work_presets.resource_selector,authz.work_presets.source_actor_id) IS DISTINCT FROM (EXCLUDED.actions,EXCLUDED.resource_selector,EXCLUDED.source_actor_id);
 RETURN jsonb_build_object('state','configured','project_id',project,'actions',acts,'resource_selector',selector);
END $$;
REVOKE ALL ON authz.work_presets FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
GRANT EXECUTE ON FUNCTION authz.set_work_preset(text,uuid,text[],jsonb) TO hub2_hufu;
CREATE OR REPLACE FUNCTION authz.project_scope_transition(c jsonb,p_project uuid,p_expected bigint,p_visibility text,p_kind text,p_manager uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE pr record; actor authz.principals; manager authz.principals; root_qualification uuid; leader_qualification uuid; next_revision bigint;existing authz.qualifications;selector jsonb:='{"version":1,"kind":"project"}';preset authz.work_presets;
 management_actions text[]:=ARRAY['mem.read','mem.upload','mem.write','mem.delete','mem.process','mem.correct','mem.share',
 'v8.project.convert','v8.project.update',
 'v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read',
 'v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read',
 'v8.experience.publish','v8.experience.publish','v8.experience.feedback','v8.experience.read'];
 work_actions text[]:=ARRAY['mem.read','mem.upload','mem.write','mem.delete','mem.share','mem.correct','mem.process',
 'v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read',
 'v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read',
 'v8.experience.publish','v8.experience.feedback','v8.experience.read'];
BEGIN
 IF session_user<>'hub2_v8' OR p_visibility NOT IN('personal','team') OR p_kind NOT IN('project','dialogue')
 OR (c->>'project_id')::uuid IS DISTINCT FROM p_project THEN RAISE EXCEPTION 'invalid_coordination' USING ERRCODE='42501'; END IF;
 SELECT * INTO actor FROM authz.principals WHERE id=(c->>'actor_id')::uuid AND active;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project FOR UPDATE;
 IF actor.id IS NULL OR pr.id IS NULL OR pr.revision<>p_expected OR actor.organization_id<>pr.organization_id THEN RAISE EXCEPTION 'revision_or_identity_conflict' USING ERRCODE='40001'; END IF;
 IF actor.id NOT IN(pr.owner_id,pr.manager_id) AND actor.role<>'organization_admin' THEN RAISE EXCEPTION 'management_required' USING ERRCODE='42501'; END IF;
 next_revision:=CASE WHEN c->>'action'='v8.project.create' THEN p_expected ELSE p_expected+1 END;
 IF p_visibility='team' THEN
  SELECT * INTO manager FROM authz.principals WHERE id=p_manager AND active AND role='organization_admin' AND organization_id=pr.organization_id FOR SHARE;
  IF manager.id IS NULL THEN RAISE EXCEPTION 'invalid_organization_manager' USING ERRCODE='42501'; END IF;
  SELECT * INTO existing FROM authz.qualifications WHERE project_id=p_project AND principal_id=manager.id AND kind='management' AND depth=0 AND active AND NOT frozen ORDER BY CASE WHEN resource_selector->>'kind'='set' THEN 0 ELSE 1 END,id LIMIT 1;
  IF existing.id IS NOT NULL THEN selector:=existing.resource_selector;management_actions:=existing.actions;END IF;
  SELECT * INTO preset FROM authz.work_presets WHERE project_id=p_project;
  IF preset.project_id IS NOT NULL AND preset.actions<@management_actions AND authz.selector_subset(preset.resource_selector,selector) THEN work_actions:=preset.actions;selector:=preset.resource_selector;
  ELSE SELECT array_agg(a) INTO work_actions FROM unnest(work_actions) a WHERE a=ANY(management_actions);END IF;
  -- Explicit management source, distinct from ordinary work rights. Retain independent work qualifications.
  UPDATE authz.qualifications SET active=false,epoch=epoch+1 WHERE project_id=p_project AND kind='management';
  INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,kind,depth,until_revoked,source_project_revision)
   VALUES(manager.id,p_project,management_actions,manager.id,'management',0,true,next_revision) RETURNING id INTO root_qualification;
  UPDATE authz.qualifications SET resource_selector=selector,expires_at=CASE WHEN existing.id IS NOT NULL THEN existing.expires_at END,until_revoked=CASE WHEN existing.id IS NOT NULL THEN existing.until_revoked ELSE true END WHERE id=root_qualification;
  IF cardinality(work_actions)>0 THEN INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,parent_id,kind,depth,until_revoked,source_project_revision,resource_selector,source_basis) VALUES(manager.id,p_project,work_actions,manager.id,root_qualification,'work',1,true,next_revision,selector,'management_appointment');END IF;
  IF pr.owner_id<>manager.id AND cardinality(work_actions)>0 THEN
   INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,parent_id,kind,depth,until_revoked,source_project_revision)
    VALUES(pr.owner_id,p_project,work_actions,manager.id,root_qualification,'management',1,true,next_revision) RETURNING id INTO leader_qualification;
  UPDATE authz.qualifications SET resource_selector=selector WHERE id=leader_qualification;
  ELSE leader_qualification:=CASE WHEN pr.owner_id=manager.id THEN root_qualification ELSE NULL END; END IF;
  IF cardinality(work_actions)>0 THEN
  INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,parent_id,kind,depth,until_revoked,source_project_revision)
   VALUES(pr.owner_id,p_project,work_actions,manager.id,leader_qualification,'work',1,true,next_revision);
  END IF;
 UPDATE authz.qualifications SET resource_selector=selector,expires_at=CASE WHEN existing.id IS NOT NULL THEN existing.expires_at END,until_revoked=CASE WHEN existing.id IS NOT NULL THEN existing.until_revoked ELSE true END WHERE project_id=p_project AND (id=leader_qualification OR (parent_id IN(root_qualification,leader_qualification) AND kind='work'));
 ELSIF p_manager IS DISTINCT FROM pr.owner_id THEN
  RAISE EXCEPTION 'personal_manager_must_be_owner' USING ERRCODE='42501';
 END IF;
 -- Called after exclusive principal fencing for project create/convert in consume_handle.

 RETURN jsonb_build_object('state','coordinated','manager_id',p_manager,'root_management_qualification',root_qualification,
  'leader_management_qualification',leader_qualification);
END $$;
RESET ROLE;
GRANT EXECUTE ON FUNCTION authz.is_fixed_ref(jsonb) TO hub2_v8_owner;
SET ROLE hub2_v8_owner;
CREATE OR REPLACE FUNCTION v8.ref_inputs(p_explanation jsonb) RETURNS SETOF jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,v8 AS $$ SELECT DISTINCT value FROM jsonb_path_query(p_explanation,'$.**') value WHERE authz.is_fixed_ref(value) $$;
RESET ROLE;
SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.authn_session_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE actor uuid; cid uuid; h text;
BEGIN
 SELECT principal_id INTO actor FROM authz.member_accounts WHERE authn_user_id=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
 IF actor IS NULL THEN RAISE EXCEPTION 'untrusted_member_account' USING ERRCODE='42501'; END IF;
 PERFORM id FROM authz.principals WHERE id=actor FOR UPDATE;
 IF TG_OP='DELETE' THEN
  h:=encode(public.digest(OLD.token,'sha256'),'hex');
  UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE token_hash=h;
  UPDATE authz.sessions SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE token_hash=h;
  RETURN OLD;
 END IF;
 h:=encode(public.digest(NEW.token,'sha256'),'hex');
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT FROM authz.principals WHERE id=actor AND active) THEN RAISE EXCEPTION 'disabled_member' USING ERRCODE='42501'; END IF;
  INSERT INTO authz.clients(principal_id,label,actions) VALUES(actor,'member-browser',ARRAY['mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read']) RETURNING id INTO cid;
  INSERT INTO authz.credentials(client_id,token_hash,expires_at) VALUES(cid,h,NEW."expiresAt");
  INSERT INTO authz.sessions(principal_id,token_hash,expires_at,refresh_expires_at) VALUES(actor,h,NEW."expiresAt",NEW."expiresAt");
 ELSE
  IF NEW.token IS DISTINCT FROM OLD.token OR NEW."userId" IS DISTINCT FROM OLD."userId" THEN RAISE EXCEPTION 'session_identity_immutable'; END IF;
  UPDATE authz.credentials SET expires_at=NEW."expiresAt",epoch=epoch+1 WHERE token_hash=h;
  UPDATE authz.sessions SET expires_at=NEW."expiresAt",epoch=epoch+1 WHERE token_hash=h;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION authz.authn_account_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE actor uuid;
BEGIN
 IF TG_OP='UPDATE' AND NEW.password IS NOT DISTINCT FROM OLD.password AND NEW."providerId" IS NOT DISTINCT FROM OLD."providerId" THEN RETURN NEW; END IF;
 SELECT principal_id INTO actor FROM authz.member_accounts WHERE authn_user_id=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
 PERFORM id FROM authz.principals WHERE id=actor FOR UPDATE;
 UPDATE authz.principals SET epoch=epoch+1 WHERE id=actor;
 UPDATE authz.credentials SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE client_id IN(SELECT id FROM authz.clients WHERE principal_id=actor);
 UPDATE authz.sessions SET revoked_at=clock_timestamp(),epoch=epoch+1 WHERE principal_id=actor;
 DELETE FROM authn."session" WHERE "userId"=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION authz.wechat_finish(p_claim uuid,p_app_id text,p_open_id text,p_access_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE s authz.wechat_states;p authz.principals;cid uuid;credential uuid;
BEGIN
 IF session_user<>'hub2_hufu' OR p_claim IS NULL OR COALESCE(p_app_id,'')='' OR COALESCE(p_open_id,'')='' OR p_access_hash IS NULL OR p_access_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_wechat_identity' USING ERRCODE='42501';END IF;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id IN(SELECT principal_id FROM authz.wechat_members WHERE app_id=p_app_id AND open_id=p_open_id) FOR UPDATE;
 SELECT * INTO s FROM authz.wechat_states WHERE claim_id=p_claim AND app_id=p_app_id FOR UPDATE;
 IF s.id IS NULL OR s.completed_at IS NOT NULL OR s.expires_at<=clock_timestamp() OR s.claimed_at IS NULL THEN RAISE EXCEPTION 'wechat_claim_expired_or_replayed' USING ERRCODE='42501';END IF;
 SELECT actor.* INTO p FROM authz.wechat_members mapping JOIN authz.principals actor ON actor.id=mapping.principal_id WHERE mapping.app_id=p_app_id AND mapping.open_id=p_open_id AND mapping.active;
 IF p.id IS NULL OR p.active IS DISTINCT FROM true OR p.kind<>'member' THEN RAISE EXCEPTION 'wechat_membership_unverified' USING ERRCODE='42501';END IF;
 INSERT INTO authz.clients(principal_id,label,actions) VALUES(p.id,s.client_label,ARRAY['mem.read','mem.upload','mem.write','mem.delete','mem.share','mem.process','mem.correct','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read']) RETURNING id INTO cid;
 INSERT INTO authz.credentials(client_id,token_hash,until_revoked,wechat_app_id,wechat_open_id) VALUES(cid,p_access_hash,true,p_app_id,p_open_id) RETURNING id INTO credential;
 UPDATE authz.wechat_states SET completed_at=clock_timestamp() WHERE id=s.id;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(p.id,cid,'authz','wechat.login',credential,jsonb_build_object('trusted_mapping',true,'state_id',s.id));
 RETURN jsonb_build_object('state','authenticated','actor_id',p.id,'client_id',cid,'credential_id',credential,'until_revoked',true);
END $$;
CREATE OR REPLACE FUNCTION authz.assert_service(a text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE b evidence.service_binding;p authz.principals;c authz.clients;k authz.credentials;era uuid;
BEGIN
 IF session_user IS DISTINCT FROM 'hub2_worker' OR a IS NULL OR a NOT IN ('worker.dispatch','worker.consume','worker.maintenance','worker.metrics','worker.governance') THEN RAISE EXCEPTION 'internal_service_required' USING ERRCODE='42501';END IF;
 SELECT * INTO b FROM evidence.service_binding WHERE db_role=session_user AND active FOR SHARE;
 IF b.db_role IS NULL THEN RAISE EXCEPTION 'unbound_service' USING ERRCODE='42501';END IF;
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals WHERE id=b.principal_id FOR SHARE;
 SELECT * INTO p FROM authz.principals WHERE id=b.principal_id;
 SELECT * INTO c FROM authz.clients WHERE id=b.client_id FOR SHARE;
 SELECT * INTO k FROM authz.credentials WHERE id=b.credential_id FOR SHARE;
 SELECT security_state.era INTO era FROM authz.security_state WHERE id;
 IF p.id IS NULL OR c.id IS NULL OR k.id IS NULL OR p.kind IS DISTINCT FROM 'service' OR NOT p.active OR NOT c.active OR c.principal_id IS DISTINCT FROM p.id OR k.client_id IS DISTINCT FROM c.id OR k.revoked_at IS NOT NULL OR authz.family_valid(k.id) IS DISTINCT FROM true OR (NOT k.until_revoked AND k.expires_at<=clock_timestamp()) OR era IS DISTINCT FROM b.security_era OR (a=ANY(c.actions)) IS DISTINCT FROM true THEN RAISE EXCEPTION 'service_authority_expired' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('actor_id',p.id,'client_id',c.id,'security_era',era);
END $$;
RESET ROLE;
