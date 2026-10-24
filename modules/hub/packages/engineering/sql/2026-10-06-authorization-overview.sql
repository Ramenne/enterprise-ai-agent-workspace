BEGIN;


CREATE OR REPLACE FUNCTION authz.authorization_overview(proof text, b jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE
 i jsonb;
 requested_project uuid;
 projects jsonb:='[]'::jsonb;
 pr record;
 members jsonb;
 pending jsonb;
BEGIN
 i:=authz.authenticate(proof);
 requested_project:=NULLIF(b->>'project_id','')::uuid;

 FOR pr IN
  SELECT p.id,p.title,p.visibility,p.owner_id,p.manager_id,p.state
  FROM v8.projects p
  WHERE p.organization_id=(i->>'organization_id')::uuid
    AND p.state='active'
    AND (requested_project IS NULL OR p.id=requested_project)
    AND authz.engineering_can_manage(proof,p.id)
  ORDER BY p.title,p.id
 LOOP
  SELECT coalesce(jsonb_agg(x.member ORDER BY x.label),'[]'::jsonb)
  INTO members
  FROM (
   SELECT max(coalesce(principal.display_name,q.principal_id::text)) AS label,
          jsonb_build_object(
            'actor_id',q.principal_id,
            'member',max(coalesce(principal.display_name,q.principal_id::text)),
            'qualifications',jsonb_agg(
              jsonb_build_object(
                'qualification_id',q.id,
                'kind',q.kind,
                'actions',q.actions,
                'active',q.active,
                'frozen',q.frozen,
                'until_revoked',q.until_revoked,
                'expires_at',q.expires_at,
                'effective_now',q.active AND NOT q.frozen AND (
                  q.until_revoked OR q.expires_at>clock_timestamp()
                )
            ) ORDER BY q.id DESC
            )
          ) AS member
   FROM authz.qualifications q
   LEFT JOIN authz.principals principal ON principal.id=q.principal_id
   WHERE q.project_id=pr.id
   GROUP BY q.principal_id
  ) x;

  pending:='[]'::jsonb;

  projects:=projects||jsonb_build_array(jsonb_build_object(
    'project_id',pr.id,
    'title',pr.title,
    'visibility',pr.visibility,
    'owner_id',pr.owner_id,
    'manager_id',pr.manager_id,
    'members',members,
    'pending_requests',pending,
    'member_count',jsonb_array_length(members),
    'pending_count',jsonb_array_length(pending),
    'scope','project'
  ));
 END LOOP;

 RETURN jsonb_build_object(
   'state','read',
   'view','managed',
   'scope','project',
   'projects',projects,
   'project_count',jsonb_array_length(projects),
   'note','Read-only overview; changes still use the original apply, decide and change routes.'
 );
END $$;

REVOKE ALL ON FUNCTION authz.authorization_overview(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.authorization_overview(text,jsonb) TO hub2_hufu;

COMMIT;
