ALTER TABLE authz.engineering_requests ADD COLUMN IF NOT EXISTS decided_client_id uuid;
ALTER TABLE authz.engineering_requests ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE authz.engineering_requests ADD COLUMN IF NOT EXISTS approval_note text;
ALTER TABLE authz.engineering_requests ADD COLUMN IF NOT EXISTS approved_until timestamptz;

CREATE OR REPLACE FUNCTION authz.engineering_can_manage(proof text,p_project uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE ident jsonb;
BEGIN
 ident:=authz.authenticate(proof);
 IF NOT authz.client_resource_allowed745((ident->>'client_id')::uuid,p_project) THEN RETURN false;END IF;
 RETURN EXISTS(SELECT FROM v8.projects p JOIN authz.principals a ON a.id=(ident->>'actor_id')::uuid
  WHERE p.id=p_project AND p.organization_id=(ident->>'organization_id')::uuid
   AND (p.manager_id=a.id OR (p.visibility='team' AND a.role='organization_admin')))
  OR EXISTS(SELECT FROM authz.qualifications q WHERE q.project_id=p_project
   AND q.principal_id=(ident->>'actor_id')::uuid AND q.kind='management'
   AND authz.management_valid(q.id,q.principal_id,p_project));
END $$;
ALTER FUNCTION authz.engineering_can_manage(text,uuid) OWNER TO hub2_authz_owner;
REVOKE ALL ON FUNCTION authz.engineering_can_manage(text,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION authz.engineering_request_read(proof text,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE ident jsonb;req authz.engineering_requests;resources jsonb;current_access boolean;
BEGIN
 ident:=authz.authenticate(proof);SELECT * INTO req FROM authz.engineering_requests WHERE id=p_request;
 IF req.id IS NULL OR (req.actor_id<>(ident->>'actor_id')::uuid AND NOT authz.engineering_can_manage(proof,req.project_id)) THEN
  RAISE EXCEPTION 'request_not_available' USING ERRCODE='42501';
 END IF;
 SELECT descriptor INTO resources FROM authz.engineering_projects WHERE project_id=req.project_id;
 current_access:=req.qualification_id IS NOT NULL AND authz.qualification_deadline(req.qualification_id,req.actor_id,req.project_id,'resource.read',jsonb_build_object('project_id',req.project_id))>clock_timestamp();
 RETURN jsonb_build_object('state',req.state,'request',to_jsonb(req),'resources',resources,
  'qualification_current',coalesce(current_access,false),'next_step',CASE WHEN req.state='pending' THEN 'manager_confirm_then_decide' WHEN req.state='approved' THEN 'requester_read_engineering_projects_then_execute' ELSE 'review_decision' END);
END $$;
ALTER FUNCTION authz.engineering_request_read(text,uuid) OWNER TO hub2_authz_owner;
REVOKE ALL ON FUNCTION authz.engineering_request_read(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.engineering_request_read(text,uuid) TO hub2_hufu;

CREATE OR REPLACE FUNCTION authz.engineering_requests_read(proof text,p_view text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE ident jsonb;items jsonb;
BEGIN
 ident:=authz.authenticate(proof);
 IF p_view NOT IN('mine','pending') THEN RAISE EXCEPTION 'invalid_view' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(req)||jsonb_build_object('project_title',ep.title,'resource_scope',ep.descriptor,
  'resources_registered_ready',ep.ready,'qualification_current',CASE WHEN req.qualification_id IS NULL THEN false ELSE authz.qualification_deadline(req.qualification_id,req.actor_id,req.project_id,'resource.read',jsonb_build_object('project_id',req.project_id)) IS NOT NULL END) ORDER BY req.created_at DESC),'[]') INTO items
 FROM authz.engineering_requests req JOIN authz.engineering_projects ep ON ep.project_id=req.project_id
 WHERE authz.client_resource_allowed745((ident->>'client_id')::uuid,req.project_id)
  AND ((p_view='mine' AND req.actor_id=(ident->>'actor_id')::uuid)
   OR (p_view='pending' AND req.state='pending' AND authz.engineering_can_manage(proof,req.project_id)));
 RETURN jsonb_build_object('state','read','items',items,'meaning','current_requester_or_existing_project_management_scope;not_a_new_grant');
END $$;

CREATE OR REPLACE FUNCTION authz.engineering_decide(proof text,b jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE ident jsonb;req authz.engineering_requests;grant_result jsonb;effective text;until_time timestamptz;
BEGIN
 ident:=authz.authenticate(proof);
 SELECT * INTO req FROM authz.engineering_requests WHERE id=(b->>'request_id')::uuid FOR UPDATE;
 IF req.id IS NULL OR NOT authz.engineering_can_manage(proof,req.project_id) THEN RAISE EXCEPTION 'manager_required' USING ERRCODE='42501';END IF;
 IF b->>'decision' IS NULL OR b->>'decision' NOT IN('approve','reject') OR b->>'expected_revision' IS NULL
  OR (b->>'expected_revision')::bigint<1 OR length(coalesce(b->>'approval_note',''))>4000 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 until_time:=least(req.requested_until,coalesce((b->>'expires_at')::timestamptz,req.requested_until));
 IF req.state<>'pending' THEN
  IF req.decided_by=(ident->>'actor_id')::uuid AND req.revision=(b->>'expected_revision')::bigint+1
   AND ((req.state='approved' AND b->>'decision'='approve' AND (req.approved_until IS NULL OR req.approved_until=until_time)) OR (req.state='rejected' AND b->>'decision'='reject')) THEN
   RETURN authz.engineering_request_read(proof,req.id)||jsonb_build_object('replayed',true,'new_effect',false);
  END IF;
  RAISE EXCEPTION 'request_revision_conflict' USING ERRCODE='40001';
 END IF;
 IF req.revision<>(b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'request_revision_conflict' USING ERRCODE='40001';END IF;
 effective:=authz.engineering_management_proof(proof,req.project_id);
 IF b->>'decision'='approve' THEN
  grant_result:=authz.engineering_grant(proof,req.project_id,req.actor_id,until_time,'engineering-approval:'||req.id);
 END IF;
 UPDATE authz.engineering_requests SET state=CASE WHEN b->>'decision'='approve' THEN 'approved' ELSE 'rejected' END,
  revision=revision+1,decided_by=(ident->>'actor_id')::uuid,decided_client_id=(ident->>'client_id')::uuid,
  decided_at=clock_timestamp(),approval_note=b->>'approval_note',approved_until=CASE WHEN b->>'decision'='approve' THEN until_time ELSE NULL END,
  qualification_id=(grant_result->>'qualification_id')::uuid WHERE id=req.id RETURNING * INTO req;
 RETURN jsonb_build_object('state',req.state,'request',to_jsonb(req),'actual_resources',grant_result,
  'approval_note_source','Agent_statement;not_independent_native_human_origin_proof');
END $$;

-- Existing public functions keep their previous grants and owner.
