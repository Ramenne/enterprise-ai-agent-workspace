BEGIN;
CREATE OR REPLACE FUNCTION authz.resource_deadline(p_actor uuid, p_client uuid, p_project uuid, p_action text, r jsonb)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE p authz.principals; pr record; deadline timestamptz; privacy_deadline timestamptz:='infinity'; q record;
BEGIN
 IF NOT xingxiu.agent_scope(p_actor,p_project) THEN RAISE EXCEPTION 'xingxiu_member_scope_no_longer_valid' USING ERRCODE='42501';END IF;
 IF p_action NOT IN('mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','mem.discover','mem.read_history','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read') THEN RAISE EXCEPTION 'unknown_action' USING ERRCODE='42501'; END IF;
 IF p_actor IS NULL OR p_client IS NULL OR p_project IS NULL OR p_action IS NULL OR r IS NULL THEN RAISE EXCEPTION 'invalid_authority_input' USING ERRCODE='42501'; END IF;
 SELECT * INTO p FROM authz.principals WHERE id=p_actor;
 IF p.active IS DISTINCT FROM true OR NOT EXISTS(SELECT FROM authz.clients c WHERE c.id=p_client AND c.principal_id=p_actor AND c.active) THEN RAISE EXCEPTION 'identity_mismatch' USING ERRCODE='42501'; END IF;
 PERFORM authz.require_client_capability(jsonb_build_object('actor_id',p_actor,'client_id',p_client),p_action);
 IF NOT authz.client_resource_allowed745(p_client,p_project) THEN RAISE EXCEPTION 'restricted_credential_scope_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project;
 IF NOT FOUND THEN
  IF p_action='v8.project.create' AND (r->>'project_id')::uuid=p_project AND (r->>'organization_id')::uuid=p.organization_id AND (r->>'owner_id')::uuid=p_actor THEN
   IF coalesce(r->>'visibility','personal') NOT IN('personal','team') THEN RAISE EXCEPTION 'privacy_requires_explicit_project_mark' USING ERRCODE='42501';END IF;
   IF r->>'visibility'='team' AND(p.role<>'organization_admin' OR p.kind<>'member') THEN RAISE EXCEPTION 'team_creation_requires_supervisor' USING ERRCODE='42501';END IF;
   RETURN 'infinity';END IF;
  RAISE EXCEPTION 'invisible_project' USING ERRCODE='42501';
 END IF;
 IF pr.state<>'active' OR pr.kind NOT IN('project','dialogue') OR pr.organization_id IS DISTINCT FROM p.organization_id OR NOT authz.selector_matches('{"version":1,"kind":"project"}',p_project,r) THEN RAISE EXCEPTION 'invalid_project_resource' USING ERRCODE='42501'; END IF;
 IF p_action='v8.project.create' AND pr.owner_id=p_actor THEN RETURN 'infinity'; END IF;
 IF pr.visibility='private' AND pr.owner_id<>p_actor THEN
  privacy_deadline:=authz.project_privacy_read_deadline(p_actor,p_project);
  IF privacy_deadline IS NULL THEN RAISE EXCEPTION 'privacy_dual_authorization_required' USING ERRCODE='42501';END IF;
 END IF;
 IF p_action IN('v8.project.convert','v8.project.update') THEN
  IF pr.visibility='private' AND pr.owner_id<>p_actor THEN RAISE EXCEPTION 'privacy_owner_controls_classification' USING ERRCODE='42501';END IF;
  IF pr.owner_id=p_actor OR(pr.visibility IN('personal','team') AND p.role='organization_admin' AND p.kind='member') THEN RETURN 'infinity';END IF;
 END IF;
 IF (pr.visibility IN('personal','private') AND pr.owner_id=p_actor) OR p_action IN('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read') AND (pr.owner_id=p_actor OR pr.visibility IN('personal','team')) THEN RETURN 'infinity'; END IF;
 IF pr.visibility='private' AND p_action IN('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read') AND privacy_deadline>clock_timestamp() THEN RETURN privacy_deadline;END IF;
 FOR q IN SELECT id FROM authz.qualifications WHERE principal_id=p_actor AND project_id=p_project AND kind='work' ORDER BY id LOOP
  deadline:=authz.qualification_deadline(q.id,p_actor,p_project,p_action,r); IF deadline IS NOT NULL THEN RETURN least(deadline,privacy_deadline); END IF;
 END LOOP;
 RAISE EXCEPTION 'member_qualification_required' USING ERRCODE='42501';
END $function$

;
DO $b$ DECLARE role_name text; BEGIN
 SELECT pg_get_userbyid(proowner) INTO role_name FROM pg_proc WHERE oid='authz.resource_deadline(uuid,uuid,uuid,text,jsonb)'::regprocedure;
 EXECUTE format('GRANT USAGE ON SCHEMA xingxiu TO %I',role_name);
 EXECUTE format('GRANT EXECUTE ON FUNCTION xingxiu.agent_scope(uuid,uuid) TO %I',role_name);
END $b$;
COMMIT;
