CREATE OR REPLACE FUNCTION authz.engineering_access(proof text, p_project uuid, p_operation text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;b authz.engineering_bindings;q authz.qualifications;pr authz.engineering_projects;d timestamptz;act text;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR p_operation NOT IN('read','write','deploy') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);act:='resource.'||p_operation;
 SELECT * INTO pr FROM authz.engineering_projects WHERE project_id=p_project;
 SELECT * INTO b FROM authz.engineering_bindings WHERE project_id=p_project AND client_id=(i->>'client_id')::uuid;
 IF b.client_id IS NULL THEN
  -- A newly issued ordinary work client inherits this member's existing full-project grant.
  FOR q IN SELECT * FROM authz.qualifications WHERE principal_id=(i->>'actor_id')::uuid AND project_id=p_project AND kind='work' AND actions@>ARRAY['resource.read','resource.write','resource.deploy'] LOOP
   d:=authz.qualification_deadline(q.id,(i->>'actor_id')::uuid,p_project,act,jsonb_build_object('project_id',p_project));
   IF d IS NOT NULL AND d>clock_timestamp() THEN
    INSERT INTO authz.engineering_bindings VALUES(p_project,(i->>'client_id')::uuid,q.id,d,q.source_actor_id) ON CONFLICT DO NOTHING;
    SELECT * INTO b FROM authz.engineering_bindings WHERE project_id=p_project AND client_id=(i->>'client_id')::uuid;
    EXIT;
   END IF;
  END LOOP;
 END IF;
 IF pr.ready IS DISTINCT FROM true OR b.client_id IS NULL OR b.expires_at<=clock_timestamp() OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,p_project) THEN RAISE EXCEPTION 'engineering_project_access_required' USING ERRCODE='42501';END IF;
 IF NOT('mem.write'=ANY(ARRAY(SELECT jsonb_array_elements_text(i->'client_actions')))) THEN RAISE EXCEPTION 'software_work_capability_required' USING ERRCODE='42501';END IF;
 d:=authz.qualification_deadline(b.qualification_id,(i->>'actor_id')::uuid,p_project,act,jsonb_build_object('project_id',p_project));
 IF d IS NULL THEN RAISE EXCEPTION 'engineering_qualification_expired_or_revoked' USING ERRCODE='42501';END IF;
 RETURN i||jsonb_build_object('project_id',p_project,'deadline',least(d,b.expires_at,CASE WHEN (i->>'until_revoked')::boolean THEN 'infinity'::timestamptz ELSE (i->>'expires_at')::timestamptz END),'descriptor',pr.descriptor,'operation',p_operation,'qualification_id',b.qualification_id);
END $function$;
