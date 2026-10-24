-- Safe project-read observation permit; no engineering binding/grant is minted.
SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.project_observation_permit(proof text,p_project uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;d timestamptz;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR p_project IS NULL THEN RAISE EXCEPTION 'project_read_authority_required' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);
 PERFORM authz.lock_resources((i->>'actor_id')::uuid,(i->>'client_id')::uuid,(i->>'credential_id')::uuid,
   authz.request_resources((i->>'actor_id')::uuid,(i->>'client_id')::uuid,jsonb_build_object('project_id',p_project),'v8.project.read'));
 i:=authz.authenticate(proof);
 PERFORM authz.require_client_capability(i,'v8.project.read');
 PERFORM authz.check_access((i->>'actor_id')::uuid,(i->>'client_id')::uuid,p_project,'v8.project.read');
 d:=authz.resource_deadline((i->>'actor_id')::uuid,(i->>'client_id')::uuid,p_project,'v8.project.read',jsonb_build_object('project_id',p_project));
 IF d IS NULL OR d<=clock_timestamp() THEN RAISE EXCEPTION 'project_read_authority_required' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('actor_id',i->>'actor_id','client_id',i->>'client_id','credential_id',i->>'credential_id','project_id',p_project,
  'permit_kind','project_observation.v1','permitted_actions',jsonb_build_array('observe'),
  'deadline',least(d,clock_timestamp()+interval '30 seconds',CASE WHEN (i->>'until_revoked')::boolean THEN 'infinity'::timestamptz ELSE (i->>'expires_at')::timestamptz END));
END $$;
REVOKE ALL ON FUNCTION authz.project_observation_permit(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.project_observation_permit(text,uuid) TO hub2_hufu;
RESET ROLE;
