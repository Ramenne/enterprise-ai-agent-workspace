BEGIN;
SET LOCAL ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.baize_visible_members(proof text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE d jsonb;i jsonb;p v8.projects;members jsonb;missing integer;duplicates integer;deadline timestamptz;
BEGIN
 IF authz.runtime_role() IS DISTINCT FROM 'hub2_hufu' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);
 IF i->>'principal_kind'='service' THEN
  IF i->>'actor_id'<>'9567d1c6-ae3c-4ee9-a9cd-55e83bd697f3' THEN RAISE EXCEPTION 'registered_baize_service_required' USING ERRCODE='42501';END IF;
  PERFORM authz.require_client_capability(i,'hufu.baize.members.read');
  IF i->'client_actions'<>'["hufu.baize.members.read"]'::jsonb OR NOT EXISTS(SELECT FROM jsonb_array_elements(i->'scope_filters')f WHERE f->'project_ids'='["3527ac31-0643-4f89-a6bd-b1e9768b2e42"]'::jsonb)THEN RAISE EXCEPTION 'dedicated_baize_directory_client_required' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT FROM authz.baize_directory_registered_target t WHERE t.application_id='baize'AND t.project_id='3527ac31-0643-4f89-a6bd-b1e9768b2e42'AND t.active)THEN RAISE EXCEPTION 'registered_baize_target_required' USING ERRCODE='42501';END IF;
  IF NOT authz.client_resource_allowed745((i->>'client_id')::uuid,'3527ac31-0643-4f89-a6bd-b1e9768b2e42') THEN RAISE EXCEPTION 'restricted_baize_directory_scope_required' USING ERRCODE='42501';END IF;
  SELECT max(authz.qualification_deadline(q.id,(i->>'actor_id')::uuid,q.project_id,'hufu.baize.members.read',jsonb_build_object('project_id',q.project_id)))INTO deadline
  FROM authz.qualifications q WHERE q.principal_id=(i->>'actor_id')::uuid AND q.project_id='3527ac31-0643-4f89-a6bd-b1e9768b2e42' AND q.kind='work';
  IF deadline IS NULL OR deadline<=clock_timestamp() OR (NOT(i->>'until_revoked')::boolean AND(i->>'expires_at')::timestamptz<=clock_timestamp()) THEN RAISE EXCEPTION 'baize_directory_service_qualification_required' USING ERRCODE='42501';END IF;
  d:=jsonb_build_object('project_id','3527ac31-0643-4f89-a6bd-b1e9768b2e42');
 ELSE
  d:=authz.authorization_application_decision(proof,jsonb_build_object('application_id','baize','action','read'));
  IF d->>'project_id'<>'3527ac31-0643-4f89-a6bd-b1e9768b2e42' THEN RAISE EXCEPTION 'registered_baize_project_binding_required' USING ERRCODE='42501';END IF;
 END IF;
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
