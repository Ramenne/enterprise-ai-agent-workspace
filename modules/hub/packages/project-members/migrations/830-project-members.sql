BEGIN;
CREATE OR REPLACE FUNCTION authz.project_members(proof text,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;p v8.projects;out_ jsonb;lim int;off_ int;
BEGIN
 i:=authz.authenticate(proof);
 SELECT * INTO p FROM v8.projects WHERE id=(b->>'project_id')::uuid AND organization_id=(i->>'organization_id')::uuid AND state='active' AND visibility='team';
 IF p.id IS NULL THEN RAISE EXCEPTION 'active_team_project_required' USING ERRCODE='42501';END IF;
 PERFORM authz.lock_resources((i->>'actor_id')::uuid,(i->>'client_id')::uuid,(i->>'credential_id')::uuid,authz.request_resources((i->>'actor_id')::uuid,(i->>'client_id')::uuid,jsonb_build_object('project_id',p.id),'v8.project.read'));
 PERFORM authz.check_access((i->>'actor_id')::uuid,(i->>'client_id')::uuid,p.id,'v8.project.read');
 lim:=coalesce((b->>'limit')::int,100);off_:=coalesce((b->>'offset')::int,0);
 IF lim NOT BETWEEN 1 AND 100 OR off_<0 THEN RAISE EXCEPTION 'invalid_pagination' USING ERRCODE='22023';END IF;
 WITH qualified AS (
 SELECT q.principal_id,unnest(q.actions) action FROM authz.qualifications q JOIN authz.principals issuer ON issuer.id=q.source_actor_id
 WHERE q.project_id=p.id AND q.kind='work' AND q.active AND NOT q.frozen AND issuer.active AND (q.until_revoked OR q.expires_at>clock_timestamp())
 AND ((q.parent_id IS NULL AND (q.source_basis='independent_work' OR q.source_actor_id=p.manager_id OR (issuer.role='organization_admin' AND issuer.organization_id=p.organization_id)))
 OR EXISTS(SELECT FROM authz.qualifications parent WHERE parent.id=q.parent_id AND q.actions<@parent.actions AND authz.management_valid(parent.id,parent.principal_id,p.id)))
 ), grouped AS (SELECT principal_id,array_agg(DISTINCT action) actions FROM qualified GROUP BY principal_id),members AS (
 SELECT a.id actor_id,a.display_name, a.id=p.manager_id is_manager,coalesce(g.actions,'{}') actions FROM authz.principals a LEFT JOIN grouped g ON g.principal_id=a.id
 WHERE a.organization_id=p.organization_id AND a.active AND a.kind='member' AND (a.id IN(p.owner_id,p.manager_id) OR ('mem.read'=ANY(g.actions) AND 'v8.project.read'=ANY(g.actions))) ORDER BY a.id LIMIT lim+1 OFFSET off_)
 SELECT coalesce(jsonb_agg(jsonb_build_object('actor_id',actor_id,'display_name',display_name,'is_manager',is_manager,'can_read',true,'can_write','mem.write'=ANY(actions) AND 'v8.work.commit'=ANY(actions))),'[]') INTO out_ FROM members;
 RETURN jsonb_build_object('state','read','project_id',p.id,'members',CASE WHEN jsonb_array_length(out_)>lim THEN out_-lim ELSE out_ END,'next_offset',CASE WHEN jsonb_array_length(out_)>lim THEN off_+lim ELSE NULL END,'coverage','current_project_qualified_members;not_organization_directory','authority','current_member_project_read;not_a_grant');
END $$;
ALTER FUNCTION authz.project_members(text,jsonb) OWNER TO hub2_authz_owner;
REVOKE ALL ON FUNCTION authz.project_members(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.project_members(text,jsonb) TO hub2_hufu;
COMMIT;
