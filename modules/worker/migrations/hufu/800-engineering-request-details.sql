CREATE OR REPLACE FUNCTION authz.engineering_requests_read(proof text,p_view text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $body$
DECLARE i jsonb;items jsonb;
BEGIN
 i:=authz.authenticate(proof);
 IF p_view='pending' AND NOT EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND role='organization_admin') THEN RAISE EXCEPTION 'manager_required' USING ERRCODE='42501';END IF;
 IF p_view NOT IN('mine','pending') THEN RAISE EXCEPTION 'invalid_view' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('project_title',e.title,'resource_scope',e.descriptor,'resources_registered_ready',e.ready,'qualification_current',CASE WHEN r.qualification_id IS NULL THEN false ELSE authz.qualification_deadline(r.qualification_id,r.actor_id,r.project_id,'resource.read',jsonb_build_object('project_id',r.project_id)) IS NOT NULL END) ORDER BY r.created_at DESC),'[]') INTO items
 FROM authz.engineering_requests r JOIN authz.engineering_projects e ON e.project_id=r.project_id
 WHERE authz.client_resource_allowed745((i->>'client_id')::uuid,r.project_id) AND ((p_view='mine' AND r.actor_id=(i->>'actor_id')::uuid) OR (p_view='pending' AND r.state='pending' AND r.project_id IN(SELECT id FROM v8.projects WHERE organization_id=(i->>'organization_id')::uuid)));
 RETURN jsonb_build_object('state','read','items',items,'meaning','registered_project_resources_and_live_qualification;running_service_status_via_execute_status');
END $body$;
