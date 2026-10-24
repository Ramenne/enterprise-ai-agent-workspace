-- Approval and actual delivery are independent; existing qualifications are unchanged.
CREATE OR REPLACE FUNCTION authz.control_resolve_engineering(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;r authz.engineering_requests;operation_ uuid:=gen_random_uuid();
BEGIN
 i:=authz.authenticate(proof);SELECT * INTO r FROM authz.engineering_requests WHERE id=(b->>'request_id')::uuid FOR UPDATE;
 IF r.id IS NULL OR NOT authz.engineering_can_manage(proof,r.project_id) THEN RAISE EXCEPTION 'current_project_manager_required' USING ERRCODE='42501';END IF;
 PERFORM authz.lock_resources((i->>'actor_id')::uuid,(i->>'client_id')::uuid,(i->>'credential_id')::uuid,authz.request_resources((i->>'actor_id')::uuid,(i->>'client_id')::uuid,jsonb_build_object('project_id',r.project_id),'v8.work.commit'));
 i:=authz.authenticate(proof);
 IF NOT authz.engineering_can_manage(proof,r.project_id) THEN RAISE EXCEPTION 'current_project_manager_required' USING ERRCODE='42501';END IF;
 PERFORM authz.require_client_capability(i,'v8.work.commit');
 IF r.state='fulfilled' AND r.execution_result=b->'result' THEN RETURN jsonb_build_object('state','fulfilled','request_id',r.id,'revision',r.revision,'operation_id',r.execution_receipt_id,'replayed',true,'permission_effect','none');END IF;
 IF r.state NOT IN('pending','approved') OR r.revision IS DISTINCT FROM (b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'request_revision_conflict' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(b->'result') IS DISTINCT FROM 'object' OR length(coalesce(b->'result'->>'summary',''))=0 THEN RAISE EXCEPTION 'execution_result_required' USING ERRCODE='22023';END IF;
 UPDATE authz.engineering_requests SET state='fulfilled',execution_result=b->'result',execution_receipt_id=operation_,approval_note=CASE WHEN r.state='approved' THEN r.approval_note ELSE b->'result'->>'summary' END,decided_by=CASE WHEN r.state='approved' THEN r.decided_by ELSE (i->>'actor_id')::uuid END,decided_client_id=CASE WHEN r.state='approved' THEN r.decided_client_id ELSE (i->>'client_id')::uuid END,decided_at=CASE WHEN r.state='approved' THEN r.decided_at ELSE clock_timestamp() END,revision=revision+1 WHERE id=r.id RETURNING * INTO r;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','engineering.execution_fulfilled',r.id,jsonb_build_object('operation_id',operation_,'result',r.execution_result,'permission_effect','none','judgment','manager_declared_actual_execution'));
 RETURN jsonb_build_object('state','fulfilled','request_id',r.id,'project_id',r.project_id,'revision',r.revision,'operation_id',operation_,'result',r.execution_result,'permission_effect','none;existing_qualifications_unchanged');
END $function$

