-- Actual project qualifications govern member engineering; verified primary proof still required for management context.
SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.engineering_access(proof text, p_project uuid, p_operation text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE
 i jsonb;
 b authz.engineering_bindings;
 q authz.qualifications;
 pr authz.engineering_projects;
 d timestamptz;
 act text;
 client_scope boolean;
 account_scope boolean := false;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR p_operation NOT IN('read','write','deploy') THEN
  RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';
 END IF;
 i:=authz.authenticate(proof);
 act:='resource.'||p_operation;
 PERFORM authz.require_client_capability(i,act);
 SELECT * INTO pr FROM authz.engineering_projects WHERE project_id=p_project;
 client_scope:=authz.client_resource_allowed745((i->>'client_id')::uuid,p_project);

 -- The member's active project qualification is authoritative for project
 -- scope.  This is intentionally independent of a stale client project
 -- filter.  The client action list is checked below as the capability ceiling.
 FOR q IN
  SELECT * FROM authz.qualifications
  WHERE principal_id=(i->>'actor_id')::uuid
    AND project_id=p_project
    AND kind='work'
    AND actions @> ARRAY[act]
 LOOP
  d:=authz.qualification_deadline(q.id,(i->>'actor_id')::uuid,p_project,act,jsonb_build_object('project_id',p_project));
  IF d IS NOT NULL AND d>clock_timestamp() THEN
   account_scope:=true;
   IF b.client_id IS NULL OR b.expires_at<=clock_timestamp() THEN
    INSERT INTO authz.engineering_bindings(project_id,client_id,qualification_id,expires_at,approved_actor_id)
    VALUES(p_project,(i->>'client_id')::uuid,q.id,d,q.source_actor_id)
    ON CONFLICT(project_id,client_id) DO UPDATE
      SET qualification_id=EXCLUDED.qualification_id,
          expires_at=EXCLUDED.expires_at,
          approved_actor_id=EXCLUDED.approved_actor_id;
    SELECT * INTO b FROM authz.engineering_bindings
    WHERE project_id=p_project AND client_id=(i->>'client_id')::uuid;
   END IF;
   EXIT;
  END IF;
 END LOOP;

 IF pr.ready IS DISTINCT FROM true
    OR b.client_id IS NULL
    OR b.expires_at<=clock_timestamp()
    OR NOT client_scope THEN
  RAISE EXCEPTION 'engineering_project_access_required' USING ERRCODE='42501';
 END IF;

 -- Keep the software capability ceiling, but do not require a project-specific
 -- MCP. Read operations need a read-capable client; writes/deploys need write.
 IF p_operation='read' THEN
  IF NOT('mem.read'=ANY(ARRAY(SELECT jsonb_array_elements_text(i->'client_actions')))
         OR 'v8.project.read'=ANY(ARRAY(SELECT jsonb_array_elements_text(i->'client_actions')))
         OR 'mem.write'=ANY(ARRAY(SELECT jsonb_array_elements_text(i->'client_actions')))) THEN
   RAISE EXCEPTION 'software_work_capability_required' USING ERRCODE='42501';
  END IF;
 ELSE
  IF NOT('mem.write'=ANY(ARRAY(SELECT jsonb_array_elements_text(i->'client_actions')))) THEN
   RAISE EXCEPTION 'software_work_capability_required' USING ERRCODE='42501';
  END IF;
 END IF;

 d:=authz.qualification_deadline(b.qualification_id,(i->>'actor_id')::uuid,p_project,act,jsonb_build_object('project_id',p_project));
 IF d IS NULL THEN RAISE EXCEPTION 'engineering_qualification_expired_or_revoked' USING ERRCODE='42501';END IF;
 RETURN i||jsonb_build_object('project_id',p_project,'deadline',least(d,b.expires_at,CASE WHEN (i->>'until_revoked')::boolean THEN 'infinity'::timestamptz ELSE (i->>'expires_at')::timestamptz END),'descriptor',pr.descriptor,'operation',p_operation,'qualification_id',b.qualification_id);
END $function$;
CREATE OR REPLACE FUNCTION authz.engineering_context_register(proof text, primary_proof text, p_project uuid, p_source text, p_until timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;p jsonb;id uuid;temporary_actions text[]:='{}';
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR p_source NOT IN('verified_email_otp','explicit_user_approved_operator') OR p_until>clock_timestamp()+interval '3 hours' OR p_until<=clock_timestamp() THEN RAISE EXCEPTION 'invalid_management_context' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);p:=authz.authenticate(primary_proof);
 IF i->>'actor_id' IS DISTINCT FROM p->>'actor_id' OR p->>'is_primary'<>'true' THEN RAISE EXCEPTION 'same_current_primary_required' USING ERRCODE='42501';END IF;
 -- The OTP session is a temporary software management context; original client actions are not changed.
 -- Current authorization sources, project filters, actor/software/credential and expiry still apply.
 IF (authz.ordinary_member_client901((i->>'client_id')::uuid) OR i->'client_actions' ? 'hufu.vault.read') AND (
  (p_project IS NULL AND (authz.ordinary_member_client901((i->>'client_id')::uuid) OR i->'scope_filters'='[]'::jsonb) AND EXISTS(SELECT FROM authz.principals WHERE principals.id=(i->>'actor_id')::uuid AND active AND role='organization_admin')) OR
  (p_project IS NOT NULL AND authz.client_resource_allowed745((i->>'client_id')::uuid,p_project) AND EXISTS(
   SELECT FROM v8.projects pr JOIN authz.principals a ON a.id=(i->>'actor_id')::uuid WHERE pr.id=p_project AND pr.state='active' AND a.active AND pr.organization_id=a.organization_id AND
   (pr.manager_id=a.id OR (pr.visibility='personal' AND pr.owner_id=a.id) OR a.role='organization_admin' OR EXISTS(
    SELECT FROM authz.qualifications q WHERE q.project_id=pr.id AND q.principal_id=a.id AND 'credential.manage'=ANY(q.actions) AND authz.management_valid(q.id,a.id,pr.id)))))
 ) THEN temporary_actions:=CASE WHEN p_project IS NULL THEN ARRAY['hufu.vault.decide','hufu.vault.delivery.manage'] ELSE ARRAY['hufu.vault.decide'] END;END IF;
 -- The operator variant is installed only by the server administrator, not exposed publicly.
 INSERT INTO authz.engineering_contexts(actor_id,client_id,credential_id,primary_proof,project_id,authority_source,expires_at,authorized_actions)
 VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,(i->>'credential_id')::uuid,primary_proof,p_project,p_source,p_until,temporary_actions) RETURNING engineering_contexts.id INTO id;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details)
 VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','engineering.context',id,jsonb_build_object('source',p_source,'project_id',p_project,'expires_at',p_until,'authorized_actions',to_jsonb(temporary_actions),'email_verification_claimed',p_source='verified_email_otp'));
 RETURN jsonb_build_object('state','management_ready','context_id',id,'expires_at',p_until,'authority_source',p_source,'authorized_actions',to_jsonb(temporary_actions),'original_software_unchanged',true,'project_id',p_project);
END $function$;
RESET ROLE;
