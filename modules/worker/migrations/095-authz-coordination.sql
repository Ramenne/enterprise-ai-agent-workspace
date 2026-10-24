-- Internal coordination capabilities; not callable by ordinary runtime connections.
GRANT SELECT ON authz.principals,authz.qualifications TO hub2_v8_owner;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.organization_manager(c jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE actor authz.principals; manager uuid; candidates integer;
BEGIN
 IF session_user<>'hub2_v8' THEN RAISE EXCEPTION 'invalid_coordination_caller' USING ERRCODE='42501'; END IF;
 SELECT * INTO actor FROM authz.principals WHERE id=(c->>'actor_id')::uuid AND active;
 IF actor.id IS NULL OR actor.organization_id IS DISTINCT FROM (c->>'organization_id')::uuid THEN RAISE EXCEPTION 'invalid_identity' USING ERRCODE='42501'; END IF;
 IF actor.role='organization_admin' THEN manager:=actor.id;
 ELSE
  SELECT count(*) INTO candidates FROM authz.principals WHERE organization_id=actor.organization_id AND active AND role='organization_admin';
  IF candidates>1 THEN RAISE EXCEPTION 'organization_manager_ambiguous' USING ERRCODE='42501'; END IF;
  SELECT id INTO manager FROM authz.principals WHERE organization_id=actor.organization_id AND active AND role='organization_admin' LIMIT 1;
 END IF;
 IF manager IS NULL THEN RAISE EXCEPTION 'organization_manager_required' USING ERRCODE='42501'; END IF;
 RETURN manager;
END $$;

CREATE FUNCTION authz.project_scope_transition(c jsonb,p_project uuid,p_expected bigint,p_visibility text,p_kind text,p_manager uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE pr record; actor authz.principals; manager authz.principals; root_qualification uuid; leader_qualification uuid; next_revision bigint;
 management_actions text[]:=ARRAY['mem.read','mem.upload','mem.write','mem.delete','mem.process','mem.correct','mem.share',
 'v8.project.convert','v8.project.update',
 'v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read',
 'v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read',
 'v8.experience.publish','v8.experience.feedback','v8.experience.read'];
 work_actions text[]:=ARRAY['mem.read','mem.upload','mem.write','mem.process',
 'v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read',
 'v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read',
 'v8.experience.feedback','v8.experience.read'];
BEGIN
 IF session_user<>'hub2_v8' OR p_visibility NOT IN('personal','team') OR p_kind NOT IN('project','dialogue')
 OR (c->>'project_id')::uuid IS DISTINCT FROM p_project THEN RAISE EXCEPTION 'invalid_coordination' USING ERRCODE='42501'; END IF;
 SELECT * INTO actor FROM authz.principals WHERE id=(c->>'actor_id')::uuid AND active;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project FOR UPDATE;
 IF actor.id IS NULL OR pr.id IS NULL OR pr.revision<>p_expected OR actor.organization_id<>pr.organization_id THEN RAISE EXCEPTION 'revision_or_identity_conflict' USING ERRCODE='40001'; END IF;
 IF actor.id NOT IN(pr.owner_id,pr.manager_id) AND actor.role<>'organization_admin' THEN RAISE EXCEPTION 'management_required' USING ERRCODE='42501'; END IF;
 next_revision:=CASE WHEN c->>'action'='v8.project.create' THEN p_expected ELSE p_expected+1 END;
 IF p_visibility='team' THEN
  SELECT * INTO manager FROM authz.principals WHERE id=p_manager AND active AND role='organization_admin' AND organization_id=pr.organization_id;
  IF manager.id IS NULL THEN RAISE EXCEPTION 'invalid_organization_manager' USING ERRCODE='42501'; END IF;
  -- Explicit management source, distinct from ordinary work rights. Retain independent work qualifications.
  UPDATE authz.qualifications SET active=false,epoch=epoch+1 WHERE project_id=p_project AND kind='management';
  INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,kind,depth,until_revoked,source_project_revision)
   VALUES(manager.id,p_project,management_actions,manager.id,'management',0,true,next_revision) RETURNING id INTO root_qualification;
  IF pr.owner_id<>manager.id THEN
   INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,parent_id,kind,depth,until_revoked,source_project_revision)
    VALUES(pr.owner_id,p_project,work_actions,manager.id,root_qualification,'management',1,true,next_revision) RETURNING id INTO leader_qualification;
  ELSE leader_qualification:=root_qualification; END IF;
  INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,parent_id,kind,depth,until_revoked,source_project_revision)
   VALUES(pr.owner_id,p_project,work_actions,manager.id,leader_qualification,'work',1,true,next_revision);
 ELSIF p_manager IS DISTINCT FROM pr.owner_id THEN
  RAISE EXCEPTION 'personal_manager_must_be_owner' USING ERRCODE='42501';
 END IF;
 -- Called after exclusive principal fencing for project create/convert in consume_handle.
 UPDATE authz.principals SET epoch=epoch+1 WHERE id IN(SELECT principal_id FROM authz.qualifications WHERE project_id=p_project) OR id IN(pr.owner_id,pr.manager_id,p_manager);
 RETURN jsonb_build_object('state','coordinated','manager_id',p_manager,'root_management_qualification',root_qualification,
  'leader_management_qualification',leader_qualification);
END $$;
REVOKE ALL ON FUNCTION authz.organization_manager(jsonb),authz.project_scope_transition(jsonb,uuid,bigint,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.organization_manager(jsonb),authz.project_scope_transition(jsonb,uuid,bigint,text,text,uuid) TO hub2_v8_owner;
RESET ROLE;
