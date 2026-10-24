-- MCP member-level authorization.
-- A technical client remains member-bound and revocable, but ordinary MCP
-- project/resource authority comes from the member qualification.
SET ROLE hub2_authz_owner;

CREATE OR REPLACE FUNCTION authz.check_access(p_actor uuid,p_client uuid,p_project uuid,p_action text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE p authz.principals; pr record; allowed boolean;
BEGIN
 SELECT * INTO p FROM authz.principals WHERE id=p_actor;
 IF p_action NOT IN ('mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','mem.discover','mem.read_history','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read') THEN RAISE EXCEPTION 'unknown_action' USING ERRCODE='42501'; END IF;
 IF p.active IS DISTINCT FROM true OR NOT EXISTS(SELECT FROM authz.clients c WHERE c.id=p_client AND c.principal_id=p_actor AND c.active) THEN RAISE EXCEPTION 'identity_mismatch' USING ERRCODE='42501'; END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project;
 IF NOT FOUND THEN IF p_action='v8.project.create' THEN RETURN NULL; END IF; RAISE EXCEPTION 'invisible_project' USING ERRCODE='42501'; END IF;
 IF pr.state<>'active' THEN RAISE EXCEPTION 'project_closed' USING ERRCODE='42501'; END IF;
 IF p_action='v8.project.create' AND pr.owner_id=p_actor AND pr.organization_id=p.organization_id THEN RETURN pr.revision; END IF;
 IF p_action IN ('v8.project.convert','v8.project.update') AND pr.manager_id=p_actor THEN RETURN pr.revision; END IF;
 IF pr.owner_id=p_actor AND (pr.visibility='personal' OR p_action IN('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read')) THEN RETURN pr.revision; END IF;
 IF p_action IN ('mem.read','mem.discover','mem.read_history','v8.read','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read') AND pr.visibility='team' AND pr.organization_id=p.organization_id THEN RETURN pr.revision; END IF;
 SELECT EXISTS(SELECT FROM authz.qualifications q JOIN authz.principals issuer ON issuer.id=q.source_actor_id WHERE q.principal_id=p_actor AND q.project_id=p_project AND q.kind='work' AND q.active AND issuer.active AND (q.until_revoked OR q.expires_at>clock_timestamp()) AND p_action=ANY(q.actions) AND ((q.parent_id IS NULL AND (q.source_basis='independent_work' OR q.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND q.source_actor_id=pr.owner_id) OR (issuer.role='organization_admin' AND issuer.organization_id=pr.organization_id))) OR EXISTS(SELECT FROM authz.qualifications parent JOIN authz.principals pi ON pi.id=parent.source_actor_id WHERE parent.id=q.parent_id AND parent.active AND parent.kind='management' AND parent.depth<=1 AND pi.active AND (parent.until_revoked OR parent.expires_at>clock_timestamp()) AND ((parent.depth=0 AND (parent.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND parent.source_actor_id=pr.owner_id))) OR EXISTS(SELECT FROM authz.qualifications root WHERE root.id=parent.parent_id AND root.active AND root.kind='management' AND root.depth=0 AND (root.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND root.source_actor_id=pr.owner_id)) AND (root.until_revoked OR root.expires_at>clock_timestamp()) AND parent.actions<@root.actions)) AND q.actions<@parent.actions))) INTO allowed;
 IF NOT allowed THEN RAISE EXCEPTION 'member_qualification_required' USING ERRCODE='42501'; END IF;
 RETURN pr.revision;
END $$;

CREATE OR REPLACE FUNCTION authz.resource_deadline(p_actor uuid,p_client uuid,p_project uuid,p_action text,r jsonb)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,authz AS $$
DECLARE p authz.principals; pr record; deadline timestamptz; q record;
BEGIN
 IF p_action NOT IN('mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','mem.discover','mem.read_history','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read') THEN RAISE EXCEPTION 'unknown_action' USING ERRCODE='42501'; END IF;
 IF p_actor IS NULL OR p_client IS NULL OR p_project IS NULL OR p_action IS NULL OR r IS NULL THEN RAISE EXCEPTION 'invalid_authority_input' USING ERRCODE='42501'; END IF;
 SELECT * INTO p FROM authz.principals WHERE id=p_actor;
 IF p.active IS DISTINCT FROM true OR NOT EXISTS(SELECT FROM authz.clients c WHERE c.id=p_client AND c.principal_id=p_actor AND c.active) THEN RAISE EXCEPTION 'identity_mismatch' USING ERRCODE='42501'; END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project;
 IF NOT FOUND THEN RAISE EXCEPTION 'invisible_project' USING ERRCODE='42501'; END IF;
 IF pr.state<>'active' OR pr.kind NOT IN('project','dialogue') OR pr.organization_id IS DISTINCT FROM p.organization_id OR NOT authz.selector_matches('{"version":1,"kind":"project"}',p_project,r) THEN RAISE EXCEPTION 'invalid_project_resource' USING ERRCODE='42501'; END IF;
 IF p_action='v8.project.create' AND pr.owner_id=p_actor THEN RETURN 'infinity'; END IF;
 IF p_action IN('v8.project.convert','v8.project.update') AND pr.manager_id=p_actor THEN RETURN 'infinity'; END IF;
 IF (pr.visibility='personal' AND pr.owner_id=p_actor) OR p_action IN('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read') AND (pr.owner_id=p_actor OR pr.visibility='team') THEN RETURN 'infinity'; END IF;
 FOR q IN SELECT id FROM authz.qualifications WHERE principal_id=p_actor AND project_id=p_project AND kind='work' ORDER BY id LOOP
  deadline:=authz.qualification_deadline(q.id,p_actor,p_project,p_action,r); IF deadline IS NOT NULL THEN RETURN deadline; END IF;
 END LOOP;
 RAISE EXCEPTION 'member_qualification_required' USING ERRCODE='42501';
END $$;

-- The legacy project filter function is retained for compatibility but now
-- checks only that the credential belongs to an active member. Member
-- qualifications are the sole source of ordinary project authority.
DO $patch$
BEGIN
 IF to_regprocedure('authz.client_resource_allowed745(uuid,uuid,uuid,text)') IS NOT NULL THEN
  EXECUTE $fn$CREATE OR REPLACE FUNCTION authz.client_resource_allowed745(cid uuid,pid uuid,eid uuid DEFAULT NULL,ename text DEFAULT NULL) RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,authz AS $$ SELECT EXISTS(SELECT 1 FROM authz.clients c JOIN authz.principals p ON p.id=c.principal_id WHERE c.id=cid AND c.active AND p.active) $$;$fn$;
 END IF;
 IF to_regprocedure('authz.client_resource_allowed745(uuid,uuid)') IS NOT NULL THEN
  EXECUTE $fn$CREATE OR REPLACE FUNCTION authz.client_resource_allowed745(uuid,uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,authz AS $$ SELECT EXISTS(SELECT 1 FROM authz.clients c JOIN authz.principals p ON p.id=c.principal_id WHERE c.id=$1 AND c.active AND p.active) $$;$fn$;
 END IF;
END $patch$;

-- Client capability metadata is no longer the ordinary MCP business gate.
-- Management handlers retain their own member/project checks after this call.
CREATE OR REPLACE FUNCTION authz.require_client_capability(identity jsonb,capability text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF identity IS NULL OR NOT EXISTS(SELECT 1 FROM authz.clients c JOIN authz.principals p ON p.id=c.principal_id WHERE c.id=(identity->>'client_id')::uuid AND c.principal_id=(identity->>'actor_id')::uuid AND c.active AND p.active) THEN
  RAISE EXCEPTION 'identity_mismatch' USING ERRCODE='42501';
 END IF;
END $$;

REVOKE ALL ON FUNCTION authz.check_access(uuid,uuid,uuid,text),authz.resource_deadline(uuid,uuid,uuid,text,jsonb),authz.require_client_capability(jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.check_access(uuid,uuid,uuid,text),authz.resource_deadline(uuid,uuid,uuid,text,jsonb) TO hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
RESET ROLE;
