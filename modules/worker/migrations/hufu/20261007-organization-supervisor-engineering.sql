-- Current ordinary supervisor account authority; no delegated/service expansion.
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

 -- Organization supervisor authority is account-based. It does not require
 -- a synthetic personal application or a client-specific project grant.
 -- Service/delegated credentials never inherit this role; explicit scope stays.
 IF pr.ready IS TRUE AND client_scope
    AND i->>'principal_kind'='member'
    AND ((i->>'is_primary')::boolean OR i->>'authority_source'='member_issued_api')
    AND EXISTS(SELECT FROM authz.principals actor JOIN v8.projects project
       ON project.organization_id=actor.organization_id
       WHERE actor.id=(i->>'actor_id')::uuid AND actor.active
         AND actor.role='organization_admin' AND project.id=p_project
         AND (project.visibility='team' OR project.owner_id=actor.id)) THEN
  d:=least(clock_timestamp()+interval '30 minutes',
      COALESCE((pr.descriptor->>'resource_valid_until')::timestamptz,'infinity'::timestamptz),
      CASE WHEN COALESCE((i->>'until_revoked')::boolean,false)
        THEN 'infinity'::timestamptz ELSE (i->>'expires_at')::timestamptz END);
  IF d<=clock_timestamp() THEN RAISE EXCEPTION 'engineering_resource_expired' USING ERRCODE='42501';END IF;
  RETURN i||jsonb_build_object('project_id',p_project,'deadline',d,
     'descriptor',pr.descriptor,'operation',p_operation,'qualification_id',NULL,
     'engineering_authority_source','organization_supervisor',
     'authority_rechecked_each_call',true);
 END IF;


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


CREATE OR REPLACE FUNCTION authz.engineering_catalog(proof text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;e record;permit jsonb;access jsonb;items jsonb:='[]';
BEGIN
 i:=authz.authenticate(proof);
 FOR e IN
  SELECT ep.* FROM authz.engineering_projects ep
  JOIN v8.projects p ON p.id=ep.project_id
  WHERE p.organization_id=(i->>'organization_id')::uuid
    AND (p.visibility='team' OR p.owner_id=(i->>'actor_id')::uuid)
    AND (
      authz.client_resource_allowed745((i->>'client_id')::uuid,p.id)
      OR EXISTS (
        SELECT 1 FROM authz.qualifications q
        WHERE q.principal_id=(i->>'actor_id')::uuid
          AND q.project_id=p.id
          AND q.kind='work'
          AND q.actions @> ARRAY['resource.read']
          AND authz.qualification_deadline(q.id,(i->>'actor_id')::uuid,p.id,'resource.read',jsonb_build_object('project_id',p.id))>clock_timestamp()
      )
    )
 LOOP
  BEGIN
   permit:=authz.engineering_access(proof,e.project_id,'read');
   access:=jsonb_build_object('state','enabled','expires_at',CASE WHEN permit->>'engineering_authority_source'='organization_supervisor' THEN NULL ELSE permit->'deadline' END,'execution_permit_until',permit->'deadline','qualification_id',permit->'qualification_id','authority_source',COALESCE(permit->>'engineering_authority_source','project_qualification'));
  EXCEPTION WHEN insufficient_privilege THEN
   access:=jsonb_build_object('state','not_granted','next_step','apply_for_whole_project');
  END;
  items:=items||jsonb_build_array(jsonb_build_object('project_id',e.project_id,'title',e.title,'ready',e.ready,'resources',e.descriptor,'revision',e.revision,'current_access',access));
 END LOOP;
 RETURN jsonb_build_object('state','read','items',items);
END $function$;


