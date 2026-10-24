CREATE OR REPLACE FUNCTION authz.service_authorizations_read(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $f$
DECLARE i jsonb;items jsonb;pid uuid;sid uuid;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR b IS NULL OR b-ARRAY['project_id','service_id']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid_service_query' USING ERRCODE='22023';END IF;
 i:=authz.authenticate(proof);pid:=(b->>'project_id')::uuid;sid:=(b->>'service_id')::uuid;
 IF pid IS NOT NULL AND (i->>'principal_kind')<>'service' THEN PERFORM authz.resource_deadline((i->>'actor_id')::uuid,(i->>'client_id')::uuid,pid,'v8.project.read',jsonb_build_object('project_id',pid));
 ELSIF (i->>'principal_kind')<>'service' AND NOT EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND role='organization_admin' AND kind='member') THEN RAISE EXCEPTION 'service_query_manager_required' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('authorization_id',g.id,'service_id',g.service_id,'service_name',p.display_name,'project_id',g.project_id,'capabilities',to_jsonb(g.capabilities),'actions',to_jsonb(authz.service_actions(g.capabilities)),'resource_selector',g.resource_selector,'active',g.active,'effective_now',g.active AND (g.until_revoked OR g.expires_at>clock_timestamp()),'revision',g.revision,'expires_at',g.expires_at,'until_revoked',g.until_revoked) ORDER BY g.created_at),'[]') INTO items FROM authz.service_authorizations g JOIN authz.principals p ON p.id=g.service_id WHERE (pid IS NULL OR g.project_id=pid) AND (sid IS NULL OR g.service_id=sid) AND ((i->>'principal_kind')<>'service' OR g.service_id=(i->>'actor_id')::uuid AND authz.client_resource_allowed745((i->>'client_id')::uuid,g.project_id));
 RETURN jsonb_build_object('state','read','authorization_mode','product_service','items',items,'agent_work_required',false);
END $f$;
