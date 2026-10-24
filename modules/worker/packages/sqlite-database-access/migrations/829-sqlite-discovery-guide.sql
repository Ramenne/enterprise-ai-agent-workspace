BEGIN;
-- Current catalogue function preserved;only database discovery metadata extended.
CREATE OR REPLACE FUNCTION authz.authorization_catalog(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;p record;e authz.engineering_projects;acts text[];a text;allowed text[];d timestamptz;items jsonb:='[]';resolved jsonb;gid uuid;
BEGIN
 i:=authz.authenticate(proof);
 IF b ? 'project' OR b ? 'project_id' THEN resolved:=authz.authorization_resolve(proof,b);IF resolved->>'state'<>'resolved' THEN RETURN resolved;END IF;gid:=(resolved->'project'->>'project_id')::uuid;END IF;
 FOR p IN SELECT * FROM v8.projects WHERE organization_id=(i->>'organization_id')::uuid AND state='active' AND (gid IS NULL OR id=gid) AND (visibility='team' OR owner_id=(i->>'actor_id')::uuid OR manager_id=(i->>'actor_id')::uuid OR EXISTS(SELECT FROM authz.qualifications q WHERE q.principal_id=(i->>'actor_id')::uuid AND q.project_id=v8.projects.id AND authz.qualification_deadline(q.id,q.principal_id,v8.projects.id,'v8.project.read',jsonb_build_object('project_id',v8.projects.id))>clock_timestamp())) AND authz.client_resource_allowed745((i->>'client_id')::uuid,id) ORDER BY title LOOP
  SELECT * INTO e FROM authz.engineering_projects WHERE project_id=p.id;
  SELECT actions INTO acts FROM authz.work_presets WHERE project_id=p.id;acts:=coalesce(acts,authz.business_actions());allowed:='{}';
  FOREACH a IN ARRAY acts LOOP
   BEGIN d:=authz.resource_deadline((i->>'actor_id')::uuid,(i->>'client_id')::uuid,p.id,a,jsonb_build_object('project_id',p.id));IF d>clock_timestamp() THEN allowed:=array_append(allowed,a);END IF;EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  END LOOP;
  items:=items||jsonb_build_array(jsonb_build_object('project_id',p.id,'title',p.title,'visibility',p.visibility,'can_manage',authz.engineering_can_manage(proof,p.id),
   'business',jsonb_build_object('ready',acts<@allowed,'allowed_actions',allowed,'missing_actions',ARRAY(SELECT unnest(acts) EXCEPT SELECT unnest(allowed)),'apply',jsonb_build_object('path','/v2/authorization/apply','profile','business')),
   'engineering',CASE WHEN e.project_id IS NULL THEN jsonb_build_object('state','not_registered') ELSE jsonb_build_object('registered',e.ready,'resources',e.descriptor,'apply_path','/v2/engineering/apply') END,
   'database',jsonb_build_object('domains',coalesce(e.descriptor->'database_domains','[]'),'domains_backend','postgresql','domains_note','empty PostgreSQL domains does not indicate absence of SQLite;discover actual schemas/tables/backend using objects','objects_path','/v2/database-access/objects','objects_fields',jsonb_build_array('project_id'),'sqlite_inspect_path','/v2/database-access/sqlite/inspect','sqlite_execute_path','/v2/database-access/sqlite/execute','help_path','/v2/database-access/help'),
   'routes',jsonb_build_object('credentials','/v2/vault/directory','resource_apply','/v2/authorization/apply','management_challenge','/v2/engineering/management/challenge')));
 END LOOP;
 RETURN jsonb_build_object('state','read','identity',jsonb_build_object('actor_id',i->>'actor_id','client_id',i->>'client_id'),'items',items,'coverage','currently_visible_projects_and_registered_resources;not_a_grant');
END $function$;


COMMIT;
