-- Versioned resource selectors and server-derived source effects. Existing broad grants explicitly retain project scope.
ALTER TABLE authz.qualifications ADD resource_selector jsonb NOT NULL DEFAULT '{"version":1,"kind":"project"}';
ALTER TABLE authz.qualifications ADD source_basis text NOT NULL DEFAULT 'legacy_current_authority' CHECK(source_basis IN('legacy_current_authority','independent_work','management_appointment'));
ALTER TABLE authz.qualifications ADD frozen boolean NOT NULL DEFAULT false;
CREATE TABLE authz.handle_sources(handle_id uuid NOT NULL REFERENCES authz.handles,project_id uuid NOT NULL,action text NOT NULL,resource jsonb NOT NULL,project_revision bigint NOT NULL,deadline timestamptz NOT NULL,PRIMARY KEY(handle_id,project_id,action,resource));
ALTER TABLE authz.handle_sources OWNER TO hub2_authz_owner;
CREATE TABLE authz.resource_areas(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL,label text NOT NULL,active boolean NOT NULL DEFAULT true,epoch bigint NOT NULL DEFAULT 1);
ALTER TABLE authz.resource_areas OWNER TO hub2_authz_owner;
GRANT SELECT ON mem.materials,mem.placements,mem.collections TO hub2_authz_owner;
GRANT SELECT(context_id,version_id) ON v8.context_sources TO hub2_mem_owner;
GRANT USAGE ON SCHEMA mem TO hub2_authz_owner;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.valid_selector(s jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,authz AS $$
DECLARE k text;x text;v jsonb;
BEGIN
 IF s IS NULL OR jsonb_typeof(s)<>'object' OR s->'version' IS DISTINCT FROM '1'::jsonb OR s->>'kind' NOT IN('project','set') OR s->>'kind' IS NULL THEN RETURN false;END IF;
 IF s->>'kind'='project' THEN RETURN s='{"version":1,"kind":"project"}'::jsonb;END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each(s) LOOP
  IF k NOT IN('version','kind','materials','collections','areas') THEN RETURN false;END IF;
  IF k IN('materials','collections','areas') THEN
   IF jsonb_typeof(v)<>'array' THEN RETURN false;END IF;
   FOR x IN SELECT jsonb_array_elements_text(v) LOOP
    IF x IS NULL OR x !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false;END IF;
   END LOOP;
   IF jsonb_array_length(v)<>(SELECT count(DISTINCT value) FROM jsonb_array_elements_text(v)) THEN RETURN false;END IF;
  END IF;
 END LOOP;
 RETURN COALESCE(jsonb_array_length(s->'materials'),0)+COALESCE(jsonb_array_length(s->'collections'),0)+COALESCE(jsonb_array_length(s->'areas'),0)>0;
END $$;
ALTER TABLE authz.qualifications ADD CONSTRAINT qualification_valid_selector CHECK(authz.valid_selector(resource_selector));
CREATE FUNCTION authz.selector_subset(child jsonb,parent jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,authz AS $$
 SELECT authz.valid_selector(child) AND authz.valid_selector(parent) AND (parent->>'kind'='project' OR (child->>'kind'='set' AND COALESCE(child->'materials','[]')<@COALESCE(parent->'materials','[]') AND COALESCE(child->'collections','[]')<@COALESCE(parent->'collections','[]') AND COALESCE(child->'areas','[]')<@COALESCE(parent->'areas','[]'))) $$;
CREATE FUNCTION authz.selector_matches(s jsonb,p_project uuid,r jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,authz AS $$
DECLARE mid uuid;cid uuid;aid uuid;
BEGIN
 IF NOT authz.valid_selector(s) OR p_project IS NULL OR r IS NULL OR jsonb_typeof(r)<>'object' THEN RETURN false;END IF;
 IF (r->>'project_id')::uuid IS DISTINCT FROM p_project THEN RETURN false;END IF;
 mid:=(r->>'material_id')::uuid;cid:=(r->>'collection_id')::uuid;aid:=(r->>'area_id')::uuid;
 IF mid IS NOT NULL AND EXISTS(SELECT FROM mem.materials WHERE id=mid AND project_id IS DISTINCT FROM p_project) THEN RETURN false;END IF;
 IF cid IS NOT NULL AND NOT EXISTS(SELECT FROM mem.collections WHERE id=cid AND project_id=p_project) THEN RETURN false;END IF;
 IF aid IS NOT NULL AND NOT EXISTS(SELECT FROM authz.resource_areas WHERE id=aid AND project_id=p_project AND active) THEN RETURN false;END IF;
 IF s->>'kind'='project' THEN RETURN true;END IF;
 IF mid IS NOT NULL THEN
  IF EXISTS(SELECT FROM jsonb_array_elements_text(COALESCE(s->'materials','[]')) x WHERE x.value=mid::text) THEN RETURN true;END IF;
  -- Collection membership comes from current authority, never from a request's collection label.
  RETURN EXISTS(SELECT FROM mem.placements p JOIN jsonb_array_elements_text(COALESCE(s->'collections','[]')) x ON x.value=p.collection_id::text WHERE p.material_id=mid AND p.project_id=p_project AND p.active);
 END IF;
 IF cid IS NOT NULL THEN RETURN EXISTS(SELECT FROM jsonb_array_elements_text(COALESCE(s->'collections','[]')) x WHERE x.value=cid::text);END IF;
 IF aid IS NOT NULL THEN RETURN EXISTS(SELECT FROM jsonb_array_elements_text(COALESCE(s->'areas','[]')) x WHERE x.value=aid::text);END IF;
 RETURN false;
END $$;
CREATE FUNCTION authz.qualification_deadline(qid uuid,p_actor uuid,p_project uuid,p_action text,r jsonb) RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path=pg_catalog,authz AS $$
DECLARE q authz.qualifications;p authz.principals;pr record;parent authz.qualifications;root authz.qualifications;issuer authz.principals;deadline timestamptz:='infinity';
BEGIN
 SELECT * INTO q FROM authz.qualifications WHERE id=qid;
 SELECT * INTO p FROM authz.principals WHERE id=p_actor;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project;
 IF q.id IS NULL OR p.id IS NULL OR pr.id IS NULL OR p.active IS DISTINCT FROM true OR pr.state IS DISTINCT FROM 'active' OR pr.kind NOT IN('project','dialogue') OR p.organization_id IS DISTINCT FROM pr.organization_id OR q.principal_id IS DISTINCT FROM p_actor OR q.project_id IS DISTINCT FROM p_project OR q.kind<>'work' OR q.active IS DISTINCT FROM true OR q.frozen OR (p_action=ANY(q.actions)) IS DISTINCT FROM true OR NOT authz.selector_matches(q.resource_selector,p_project,r) THEN RETURN NULL;END IF;
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
CREATE FUNCTION authz.resource_deadline(p_actor uuid,p_client uuid,p_project uuid,p_action text,r jsonb) RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path=pg_catalog,authz AS $$
DECLARE p authz.principals;pr record;deadline timestamptz;q record;
BEGIN
 IF p_action NOT IN('mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','mem.discover','mem.read_history','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read') THEN RAISE EXCEPTION 'unknown_action' USING ERRCODE='42501';END IF;
 IF p_actor IS NULL OR p_client IS NULL OR p_project IS NULL OR p_action IS NULL OR r IS NULL THEN RAISE EXCEPTION 'invalid_authority_input' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM authz.principals WHERE id=p_actor;
 IF p.active IS DISTINCT FROM true OR NOT EXISTS(SELECT FROM authz.clients c WHERE c.id=p_client AND c.principal_id=p_actor AND c.active AND p_action=ANY(c.actions)) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project;
 IF NOT FOUND THEN IF p_action='v8.project.create' AND (r->>'organization_id')::uuid=p.organization_id THEN RETURN 'infinity';END IF;RAISE EXCEPTION 'invisible_project' USING ERRCODE='42501';END IF;
 IF pr.state<>'active' OR pr.kind NOT IN('project','dialogue') OR pr.organization_id IS DISTINCT FROM p.organization_id OR NOT authz.selector_matches('{"version":1,"kind":"project"}',p_project,r) THEN RAISE EXCEPTION 'invalid_project_resource' USING ERRCODE='42501';END IF;
 IF p_action='v8.project.create' AND pr.owner_id=p_actor THEN RETURN 'infinity';END IF;
 IF p_action IN('v8.project.convert','v8.project.update') AND pr.manager_id=p_actor THEN RETURN 'infinity';END IF;
 IF (pr.visibility='personal' AND pr.owner_id=p_actor) OR p_action IN('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read') AND (pr.owner_id=p_actor OR pr.visibility='team') THEN RETURN 'infinity';END IF;
 FOR q IN SELECT id FROM authz.qualifications WHERE principal_id=p_actor AND project_id=p_project AND kind='work' ORDER BY id LOOP
  deadline:=authz.qualification_deadline(q.id,p_actor,p_project,p_action,r);
  IF deadline IS NOT NULL THEN RETURN deadline;END IF;
 END LOOP;
 RAISE EXCEPTION 'resource_scope_forbidden' USING ERRCODE='42501';
END $$;
CREATE FUNCTION authz.assert_sources(hid uuid,resources jsonb,source_action text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;r jsonb;deadline timestamptz;pid uuid;rev bigint;audience text;
BEGIN
 audience:=CASE session_user WHEN 'hub2_mem' THEN 'mem' WHEN 'hub2_v8' THEN 'v8' ELSE NULL END;
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF h.id IS NULL OR audience IS NULL OR h.audience IS DISTINCT FROM audience OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() OR source_action NOT IN('mem.read','mem.share','v8.project.read') OR source_action IS NULL OR resources IS NULL OR jsonb_typeof(resources)<>'array' THEN RAISE EXCEPTION 'invalid_source_guard' USING ERRCODE='42501';END IF;
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
CREATE FUNCTION authz.assert_all_sources(hid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;s authz.handle_sources;deadline timestamptz;rev bigint;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF h.id IS NULL OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'source_effect_without_guard' USING ERRCODE='42501';END IF;
 FOR s IN SELECT * FROM authz.handle_sources WHERE handle_id=hid ORDER BY project_id,action LOOP
  SELECT revision INTO rev FROM v8.projects WHERE id=s.project_id;
  IF rev IS DISTINCT FROM s.project_revision OR s.deadline<=clock_timestamp() THEN RAISE EXCEPTION 'source_authority_expired' USING ERRCODE='42501';END IF;
  deadline:=authz.resource_deadline(h.principal_id,h.client_id,s.project_id,s.action,s.resource);
  IF deadline<=clock_timestamp() THEN RAISE EXCEPTION 'source_authority_expired' USING ERRCODE='42501';END IF;
 END LOOP;
END $$;
CREATE FUNCTION authz.can_read_resource(actor uuid,project uuid,r jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE cid uuid;
BEGIN
 IF actor IS NULL OR project IS NULL OR r IS NULL THEN RETURN false;END IF;
 FOR cid IN SELECT id FROM authz.clients WHERE principal_id=actor AND active AND 'mem.read'=ANY(actions) ORDER BY id LOOP
  BEGIN PERFORM authz.resource_deadline(actor,cid,project,'mem.read',r);RETURN true;EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 END LOOP;RETURN false;
END $$;
REVOKE ALL ON FUNCTION authz.valid_selector(jsonb),authz.selector_subset(jsonb,jsonb),authz.selector_matches(jsonb,uuid,jsonb),authz.qualification_deadline(uuid,uuid,uuid,text,jsonb),authz.resource_deadline(uuid,uuid,uuid,text,jsonb),authz.assert_sources(uuid,jsonb,text),authz.assert_all_sources(uuid),authz.can_read_resource(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.assert_sources(uuid,jsonb,text),authz.can_read_resource(uuid,uuid,jsonb) TO hub2_mem_owner,hub2_v8_owner;
RESET ROLE;
GRANT SELECT ON mem.operations,mem.read_receipts,mem.processing_runs,mem.disclosures TO hub2_authz_owner;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.resolve_resource(r jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,authz AS $$
DECLARE mid uuid;pid uuid;vid uuid;
BEGIN
 IF r IS NULL OR jsonb_typeof(r)<>'object' THEN RAISE EXCEPTION 'invalid_resource' USING ERRCODE='42501';END IF;
 mid:=(r->>'material_id')::uuid;pid:=(r->>'project_id')::uuid;
 IF mid IS NULL AND r->>'operation_id' IS NOT NULL THEN SELECT material_id INTO mid FROM mem.operations WHERE id=(r->>'operation_id')::uuid AND project_id=pid;END IF;
 IF mid IS NULL AND r->>'placement_id' IS NOT NULL THEN SELECT material_id INTO mid FROM mem.placements WHERE id=(r->>'placement_id')::uuid AND project_id=pid;END IF;
 IF mid IS NULL AND r->>'read_receipt_id' IS NOT NULL THEN SELECT material_id INTO mid FROM mem.read_receipts WHERE id=(r->>'read_receipt_id')::uuid;END IF;
 IF mid IS NULL AND r->>'disclosure_id' IS NOT NULL THEN SELECT cv.material_id INTO mid FROM mem.disclosures d JOIN mem.content_versions cv ON cv.id=d.output_version_id WHERE d.id=(r->>'disclosure_id')::uuid;END IF;
 IF mid IS NULL AND r->>'version_id' IS NOT NULL THEN SELECT material_id INTO mid FROM mem.content_versions WHERE id=(r->>'version_id')::uuid;END IF;
 IF mid IS NOT NULL THEN RETURN r||jsonb_build_object('material_id',mid);END IF;RETURN r;
END $$;
CREATE FUNCTION authz.assert_request_resource(hid uuid,b jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;r jsonb;deadline timestamptz;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF h.id IS NULL OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() OR b IS NULL OR (b->>'project_id')::uuid IS DISTINCT FROM h.project_id THEN RAISE EXCEPTION 'invalid_bound_resource' USING ERRCODE='42501';END IF;
 r:=authz.resolve_resource(b);
 deadline:=authz.resource_deadline(h.principal_id,h.client_id,h.project_id,h.action,r);
 UPDATE authz.handles SET expires_at=least(expires_at,deadline),resource=resource||jsonb_build_object('resolved_resource',r) WHERE id=hid;
 -- Moving a material into another collection requires rights to the exact destination as well.
 IF b->>'collection_id' IS NOT NULL AND b->>'material_id' IS NOT NULL THEN
  deadline:=authz.resource_deadline(h.principal_id,h.client_id,h.project_id,h.action,jsonb_build_object('project_id',h.project_id,'collection_id',b->>'collection_id'));
  UPDATE authz.handles SET expires_at=least(expires_at,deadline) WHERE id=hid;
 END IF;
END $$;
REVOKE ALL ON FUNCTION authz.resolve_resource(jsonb),authz.assert_request_resource(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.assert_request_resource(uuid,jsonb) TO hub2_mem_owner,hub2_v8_owner;
RESET ROLE;
GRANT SELECT ON mem.content_versions TO hub2_authz_owner;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.mem_scope_membership_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF (NEW.collection_id,NEW.project_id,NEW.material_id,NEW.active) IS DISTINCT FROM (OLD.collection_id,OLD.project_id,OLD.material_id,OLD.active) THEN
  PERFORM id FROM authz.security_state FOR SHARE;
  PERFORM id FROM authz.principals ORDER BY id FOR UPDATE;
  UPDATE authz.principals SET epoch=epoch+1 WHERE id IN(SELECT principal_id FROM authz.qualifications WHERE project_id IN(OLD.project_id,NEW.project_id) AND resource_selector->>'kind'='set');
  -- Current authorized membership writer is rechecked against the new concrete scope before return. Other transactions retain stale epochs.
  UPDATE authz.handles h SET principal_epoch=p.epoch FROM authz.principals p WHERE h.principal_id=p.id AND h.consumed_xid=pg_current_xact_id() AND h.audience='mem' AND h.action='mem.write';
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION authz.mem_scope_membership_fence() FROM PUBLIC;
RESET ROLE;
CREATE TRIGGER mem_scope_membership_fence BEFORE UPDATE ON mem.placements FOR EACH ROW EXECUTE FUNCTION authz.mem_scope_membership_fence();
GRANT SELECT ON mem.source_edges TO hub2_authz_owner;
GRANT SELECT(context_id,version_id) ON v8.context_sources TO hub2_authz_owner;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.issue_source_fences(hid uuid,b jsonb,a text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;roots uuid[]:='{}';vid text;root uuid;src record;r jsonb;deadline timestamptz;disclosed boolean;source_action text;run mem.processing_runs;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF session_user<>'hub2_hufu' OR h.id IS NULL OR h.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'invalid_source_signer' USING ERRCODE='42501';END IF;
 FOR vid IN SELECT DISTINCT value #>> '{}' FROM jsonb_path_query((CASE WHEN a='mem.process' THEN b-'outputs' ELSE b END)-'properties'-'recipe','$.**.version_id') value LOOP IF vid IS NOT NULL THEN roots:=array_append(roots,vid::uuid);END IF;END LOOP;
 IF b->>'run_id' IS NOT NULL THEN SELECT * INTO run FROM mem.processing_runs WHERE id=(b->>'run_id')::uuid;FOR vid IN SELECT value->>'version_id' FROM jsonb_array_elements(COALESCE(run.inputs,'[]')) LOOP roots:=array_append(roots,vid::uuid);END LOOP;END IF;
 IF b->>'context_id' IS NOT NULL THEN
  FOR src IN SELECT cv.id,cv.material_id,m.project_id FROM v8.context_sources cs JOIN mem.content_versions cv ON cv.id=cs.version_id JOIN mem.materials m ON m.id=cv.material_id WHERE cs.context_id=(b->>'context_id')::uuid LOOP
   BEGIN PERFORM authz.resource_deadline(h.principal_id,h.client_id,src.project_id,'mem.read',jsonb_build_object('project_id',src.project_id,'material_id',src.material_id));roots:=array_append(roots,src.id);EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  END LOOP;
 END IF;
 source_action:=CASE WHEN a='mem.share' AND b->>'version_id' IS NOT NULL THEN 'mem.share' ELSE 'mem.read' END;
 FOREACH root IN ARRAY roots LOOP
  IF root IS NULL OR NOT EXISTS(SELECT FROM mem.content_versions WHERE id=root AND (provenance_state<>'pending' OR (source_action='mem.read' AND (actor_id=h.principal_id OR EXISTS(SELECT FROM mem.materials own WHERE own.id=material_id AND own.owner_id=h.principal_id))))) THEN RAISE EXCEPTION 'unknown_source' USING ERRCODE='42501';END IF;
  disclosed:=source_action='mem.read' AND EXISTS(SELECT FROM mem.disclosures WHERE output_version_id=root AND state='active' AND manifest->>'continued_source_access'='not_required');
  FOR src IN WITH RECURSIVE closure(id) AS(SELECT root UNION SELECT e.input_version_id FROM mem.source_edges e JOIN closure c ON c.id=e.output_version_id WHERE NOT disclosed) SELECT cv.id,cv.material_id,cv.sha256,m.project_id,pr.revision FROM closure c JOIN mem.content_versions cv ON cv.id=c.id JOIN mem.materials m ON m.id=cv.material_id JOIN v8.projects pr ON pr.id=m.project_id ORDER BY m.project_id,m.id,cv.id LOOP
   r:=jsonb_build_object('project_id',src.project_id,'material_id',src.material_id,'version_id',src.id,'sha256',src.sha256);
   deadline:=least(h.expires_at,authz.resource_deadline(h.principal_id,h.client_id,src.project_id,source_action,r));
   INSERT INTO authz.handle_sources VALUES(hid,src.project_id,source_action,r,src.revision,deadline) ON CONFLICT(handle_id,project_id,action,resource) DO UPDATE SET deadline=least(authz.handle_sources.deadline,EXCLUDED.deadline);
   UPDATE authz.handles SET expires_at=least(expires_at,deadline) WHERE id=hid;
  END LOOP;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION authz.issue_source_fences(uuid,jsonb,text) FROM PUBLIC;
RESET ROLE;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.management_valid(qid uuid,actor uuid,project uuid) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,authz AS $$
DECLARE q authz.qualifications;root authz.qualifications;issuer authz.principals;pr record;
BEGIN
 SELECT * INTO pr FROM v8.projects WHERE id=project;
 SELECT * INTO q FROM authz.qualifications WHERE id=qid;
 IF actor IS NULL OR pr.id IS NULL OR pr.state IS DISTINCT FROM 'active' OR q.id IS NULL OR q.principal_id IS DISTINCT FROM actor OR q.project_id IS DISTINCT FROM project OR q.kind<>'management' OR q.active IS DISTINCT FROM true OR q.frozen OR NOT(q.until_revoked OR q.expires_at>clock_timestamp()) THEN RETURN false;END IF;
 SELECT * INTO issuer FROM authz.principals WHERE id=q.source_actor_id;
 IF issuer.active IS DISTINCT FROM true OR issuer.organization_id IS DISTINCT FROM pr.organization_id THEN RETURN false;END IF;
 IF q.depth=0 THEN RETURN q.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND q.source_actor_id=pr.owner_id) OR issuer.role='organization_admin';END IF;
 SELECT * INTO root FROM authz.qualifications WHERE id=q.parent_id;
 IF root.id IS NULL OR root.depth<>0 OR root.project_id<>project OR root.kind<>'management' OR root.active IS DISTINCT FROM true OR root.frozen OR NOT(root.until_revoked OR root.expires_at>clock_timestamp()) OR q.source_actor_id IS DISTINCT FROM root.principal_id OR NOT q.actions<@root.actions OR NOT authz.selector_subset(q.resource_selector,root.resource_selector) THEN RETURN false;END IF;
 SELECT * INTO issuer FROM authz.principals WHERE id=root.source_actor_id;
 RETURN issuer.active AND issuer.organization_id=pr.organization_id AND (root.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND root.source_actor_id=pr.owner_id) OR issuer.role='organization_admin');
END $$;
CREATE OR REPLACE FUNCTION authz.can_read(p_actor uuid,p_project uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE cid uuid;act text;
BEGIN
 IF p_actor IS NULL OR p_project IS NULL THEN RETURN false;END IF;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals ORDER BY id FOR SHARE;PERFORM id FROM v8.projects ORDER BY id FOR SHARE;PERFORM id FROM authz.qualifications ORDER BY id FOR SHARE;
 FOR cid,act IN SELECT c.id,allowed.action FROM authz.clients c CROSS JOIN (VALUES('mem.read'),('v8.project.read')) allowed(action) WHERE c.principal_id=p_actor AND c.active AND allowed.action=ANY(c.actions) ORDER BY c.id LOOP
  BEGIN PERFORM authz.resource_deadline(p_actor,cid,p_project,act,jsonb_build_object('project_id',p_project));RETURN true;EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 END LOOP;RETURN false;
END $$;
CREATE OR REPLACE FUNCTION authz.can_share(p_actor uuid,p_client uuid,p_project uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF p_actor IS NULL OR p_client IS NULL OR p_project IS NULL THEN RETURN false;END IF;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals ORDER BY id FOR SHARE;PERFORM id FROM authz.clients WHERE id=p_client FOR SHARE;PERFORM id FROM v8.projects ORDER BY id FOR SHARE;PERFORM id FROM authz.qualifications ORDER BY id FOR SHARE;
 PERFORM authz.resource_deadline(p_actor,p_client,p_project,'mem.share',jsonb_build_object('project_id',p_project));RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION authz.management_valid(uuid,uuid,uuid) FROM PUBLIC;
RESET ROLE;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.effect_identity(hid uuid) RETURNS TABLE(actor_id uuid,client_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;audience text;
BEGIN
 audience:=CASE session_user WHEN 'hub2_mem' THEN 'mem' WHEN 'hub2_v8' THEN 'v8' ELSE NULL END;
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF h.id IS NULL OR audience IS NULL OR h.audience IS DISTINCT FROM audience OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'identity_without_current_guard' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT h.principal_id,h.client_id;
END $$;
REVOKE ALL ON FUNCTION authz.effect_identity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.effect_identity(uuid) TO hub2_mem_owner,hub2_v8_owner;
RESET ROLE;
