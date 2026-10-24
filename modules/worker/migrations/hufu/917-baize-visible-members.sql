BEGIN;
SET LOCAL ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.baize_visible_members(proof text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE d jsonb;i jsonb;p v8.projects;members jsonb;missing integer;duplicates integer;
BEGIN
 IF authz.runtime_role() IS DISTINCT FROM 'hub2_hufu' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 d:=authz.authorization_application_decision(proof,jsonb_build_object('application_id','baize','action','read'));
 i:=authz.authenticate(proof);
 IF d->>'project_id'<>'3527ac31-0643-4f89-a6bd-b1e9768b2e42' THEN RAISE EXCEPTION 'registered_baize_project_binding_required' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM v8.projects WHERE id=(d->>'project_id')::uuid AND organization_id=(i->>'organization_id')::uuid AND state='active';
 -- This public identity projection follows the existing company-visible team
 -- scope. A private/personal target cannot expose an organization directory.
 IF p.id IS NULL OR p.visibility<>'team' THEN RAISE EXCEPTION 'company_visible_baize_project_required' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('actor_id',a.id,'legacy_subject',m.legacy_subject,'display_name',coalesce(nullif(btrim(a.display_name),''),'member-'||a.id::text)) ORDER BY a.display_name,a.id) FILTER(WHERE NULLIF(m.legacy_subject,'') IS NOT NULL),'[]'::jsonb),count(*)FILTER(WHERE NULLIF(m.legacy_subject,'') IS NULL),count(NULLIF(m.legacy_subject,''))-count(DISTINCT NULLIF(m.legacy_subject,''))
 INTO members,missing,duplicates FROM authz.principals a LEFT JOIN authz.member_profiles m ON m.principal_id=a.id
 WHERE a.organization_id=p.organization_id AND a.kind='member' AND a.active;
 RETURN jsonb_build_object('state','read','scope','company_visible_baize_project','project_id',p.id,'members',members,'coverage',CASE WHEN missing=0 AND duplicates=0 THEN 'complete_active_members' ELSE 'partial_legacy_binding' END,'unmapped_member_count',missing,'ambiguous_binding_count',duplicates);
END $$;
REVOKE ALL ON FUNCTION authz.baize_visible_members(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.baize_visible_members(text) TO hub2_hufu;
COMMIT;
