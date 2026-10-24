SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.project_feedback_context(proof text,pid uuid,handling boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;p v8.projects;can_handle boolean:=false;a uuid;cl uuid;cr uuid;
BEGIN
 i:=authz.board_identity(proof,false,false);a:=(i->>'actor_id')::uuid;cl:=(i->>'client_id')::uuid;cr:=(i->>'credential_id')::uuid;
 SELECT * INTO p FROM v8.projects WHERE id=pid AND organization_id=(i->>'organization_id')::uuid;
 IF p.id IS NULL THEN RAISE EXCEPTION 'project_not_accessible' USING ERRCODE='42501';END IF;
 PERFORM id FROM authz.principals WHERE id IN(p.owner_id,p.manager_id) OR id IN(SELECT source_actor_id FROM authz.qualifications WHERE project_id=pid) OR id IN(SELECT owner_approved_by FROM authz.project_privacy_requests WHERE project_id=pid AND grantee_id=a) OR id IN(SELECT supervisor_approved_by FROM authz.project_privacy_requests WHERE project_id=pid AND grantee_id=a) ORDER BY id FOR SHARE;
 p:=v8.project_feedback_project_lock(pid,(i->>'organization_id')::uuid);
 PERFORM id FROM authz.qualifications WHERE project_id=pid ORDER BY id FOR SHARE;
 PERFORM id FROM authz.project_privacy_requests WHERE project_id=pid AND grantee_id=a ORDER BY id FOR SHARE;
 PERFORM authz.check_access(a,cl,pid,'v8.project.read');
 IF i->'client_actions'?'v8.work.commit' THEN
  BEGIN PERFORM authz.check_access(a,cl,pid,'v8.work.commit');can_handle:=true;
  EXCEPTION WHEN SQLSTATE '42501' THEN can_handle:=false;END;
 END IF;
 IF handling THEN
  IF NOT can_handle THEN RAISE EXCEPTION 'project_handler_required' USING ERRCODE='42501';END IF;
  PERFORM authz.check_access(a,cl,pid,'v8.work.commit');
 END IF;
 RETURN i||jsonb_build_object('can_handle',can_handle,'project_id',p.id,'project_title',p.title,'project_owner_id',p.owner_id,'project_manager_id',p.manager_id,'handling_authority','current_project_work_commit;not_feedback_reporter_identity');
END $$;
REVOKE ALL ON FUNCTION authz.project_feedback_context(text,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.project_feedback_context(text,uuid,boolean) TO hub2_v8_owner;
RESET ROLE;
