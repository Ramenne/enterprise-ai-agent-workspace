CREATE OR REPLACE FUNCTION authz.engineering_grant_existing(
 proof text,p_project uuid,p_principal uuid,p_until timestamptz,p_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;qual_row record;has_current boolean:=false;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' THEN
  RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';
 END IF;
 i:=authz.authenticate(proof);
 PERFORM authz.engineering_management_proof(proof,p_project);
 IF NOT EXISTS(SELECT FROM v8.projects p JOIN authz.principals a ON a.id=(i->>'actor_id')::uuid
   WHERE p.id=p_project AND (p.manager_id=a.id OR (a.role='organization_admin' AND p.organization_id=a.organization_id)))
   AND NOT EXISTS(SELECT FROM authz.qualifications q WHERE q.project_id=p_project AND q.principal_id=(i->>'actor_id')::uuid
     AND q.kind='management' AND authz.management_valid(q.id,q.principal_id,p_project)) THEN
  RAISE EXCEPTION 'management_required' USING ERRCODE='42501';
 END IF;
 FOR qual_row IN SELECT id FROM authz.qualifications
  WHERE project_id=p_project AND principal_id=p_principal AND kind='work'
    AND actions @> ARRAY['resource.read','resource.write','resource.deploy'] LOOP
  IF authz.qualification_deadline(qual_row.id,p_principal,p_project,'resource.deploy',jsonb_build_object('project_id',p_project))>clock_timestamp() THEN
   has_current:=true;EXIT;
  END IF;
 END LOOP;
 IF NOT has_current THEN
  RAISE EXCEPTION 'new_engineering_access_requires_application_and_approval' USING ERRCODE='42501';
 END IF;
 RETURN authz.engineering_grant(proof,p_project,p_principal,p_until,p_key);
END $$;
ALTER FUNCTION authz.engineering_grant_existing(text,uuid,uuid,timestamptz,text) OWNER TO hub2_authz_owner;
REVOKE ALL ON FUNCTION authz.engineering_grant_existing(text,uuid,uuid,timestamptz,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.engineering_grant_existing(text,uuid,uuid,timestamptz,text) TO hub2_hufu;
