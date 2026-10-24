SET ROLE hub2_authz_owner;
-- Only the existing runtime roles may derive this authenticated context.
CREATE OR REPLACE FUNCTION authz.taskhall_service_context(service_proof text,member_proof text,op text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;s jsonb;g authz.service_authorizations;p authz.principals;issuer authz.principals;pr record;wanted text;writing boolean;
BEGIN
 IF authz.runtime_role()<>'hub2_v8' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 wanted:=CASE WHEN op IN('tasks_lookup','receipts_read','operations_read','member_work_read') THEN 'v8.board.read' WHEN op='claim' THEN 'v8.board.claim' WHEN op='receipt_save' THEN 'v8.board.receipt' ELSE NULL END;
 IF wanted IS NULL THEN RAISE EXCEPTION 'task_service_operation_forbidden' USING ERRCODE='42501';END IF;
 writing:=op IN('claim','receipt_save');
 -- Actor comes from a second real member credential, never a supplied actor UUID.
 i:=authz.board_identity(member_proof,writing,false);
 s:=authz.authenticate(service_proof);
 IF s->>'principal_kind'<>'service' OR NOT authz.product_service_client((s->>'client_id')::uuid) OR NOT coalesce(s->'client_actions','[]'::jsonb) ? wanted THEN RAISE EXCEPTION 'task_service_credential_required' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM authz.principals WHERE id=(s->>'actor_id')::uuid FOR SHARE;
 PERFORM id FROM authz.clients WHERE id=(s->>'client_id')::uuid FOR SHARE;
 PERFORM id FROM authz.credentials WHERE id=(s->>'credential_id')::uuid FOR SHARE;
 s:=authz.authenticate(service_proof);
 SELECT * INTO g FROM authz.service_authorizations WHERE service_id=p.id AND project_id='69197d56-41b0-4c8b-ac19-181f63e87c1f'::uuid FOR SHARE;
 SELECT * INTO pr FROM v8.projects WHERE id=g.project_id FOR SHARE;
 SELECT * INTO issuer FROM authz.principals WHERE id=g.source_actor_id FOR SHARE;
 IF NOT coalesce(p.active AND p.kind='service' AND p.organization_id=(i->>'organization_id')::uuid AND g.id IS NOT NULL AND g.active AND 'task_board'=ANY(g.capabilities) AND (g.until_revoked OR g.expires_at>clock_timestamp()) AND pr.state='active' AND pr.organization_id=p.organization_id AND issuer.active AND issuer.kind='member' AND issuer.organization_id=p.organization_id AND (issuer.role='organization_admin' OR issuer.id=pr.manager_id) AND authz.client_resource_allowed745((s->>'client_id')::uuid,g.project_id) AND authz.selector_matches(g.resource_selector,g.project_id,jsonb_build_object('project_id',g.project_id)),false) THEN RAISE EXCEPTION 'task_service_authorization_required' USING ERRCODE='42501';END IF;

 RETURN i||jsonb_build_object('named_member_scope',true,'task_service_id',p.id,'task_service_client_id',s->>'client_id','task_service_authorization_id',g.id);
END $$;
REVOKE ALL ON FUNCTION authz.taskhall_service_context(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.taskhall_service_context(text,text,text) TO hub2_v8_owner;
RESET ROLE;
