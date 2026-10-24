BEGIN;
ALTER TABLE authz.engineering_requests DROP CONSTRAINT engineering_requests_state_check;
ALTER TABLE authz.engineering_requests ADD CONSTRAINT engineering_requests_state_check CHECK(state IN('pending','approved','rejected','withdrawn','superseded','fulfilled'));
ALTER TABLE authz.engineering_requests ADD COLUMN IF NOT EXISTS execution_result jsonb;
ALTER TABLE authz.engineering_requests ADD COLUMN IF NOT EXISTS execution_receipt_id uuid;
CREATE OR REPLACE FUNCTION authz.control_resolve_engineering(proof text,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;r authz.engineering_requests;operation_ uuid:=gen_random_uuid();
BEGIN
 i:=authz.authenticate(proof);SELECT * INTO r FROM authz.engineering_requests WHERE id=(b->>'request_id')::uuid FOR UPDATE;
 IF r.id IS NULL OR NOT authz.engineering_can_manage(proof,r.project_id) THEN RAISE EXCEPTION 'current_project_manager_required' USING ERRCODE='42501';END IF;
 PERFORM authz.lock_resources((i->>'actor_id')::uuid,(i->>'client_id')::uuid,(i->>'credential_id')::uuid,authz.request_resources((i->>'actor_id')::uuid,(i->>'client_id')::uuid,jsonb_build_object('project_id',r.project_id),'v8.work.commit'));
 i:=authz.authenticate(proof);
 IF NOT authz.engineering_can_manage(proof,r.project_id) THEN RAISE EXCEPTION 'current_project_manager_required' USING ERRCODE='42501';END IF;
 PERFORM authz.require_client_capability(i,'v8.work.commit');
 IF r.state='fulfilled' AND r.execution_result=b->'result' THEN RETURN jsonb_build_object('state','fulfilled','request_id',r.id,'revision',r.revision,'operation_id',r.execution_receipt_id,'replayed',true,'permission_effect','none');END IF;
 IF r.state<>'pending' OR r.revision IS DISTINCT FROM (b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'request_revision_conflict' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(b->'result') IS DISTINCT FROM 'object' OR length(coalesce(b->'result'->>'summary',''))=0 THEN RAISE EXCEPTION 'execution_result_required' USING ERRCODE='22023';END IF;
 UPDATE authz.engineering_requests SET state='fulfilled',execution_result=b->'result',execution_receipt_id=operation_,approval_note=b->'result'->>'summary',decided_by=(i->>'actor_id')::uuid,decided_client_id=(i->>'client_id')::uuid,decided_at=clock_timestamp(),revision=revision+1 WHERE id=r.id RETURNING * INTO r;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','engineering.execution_fulfilled',r.id,jsonb_build_object('operation_id',operation_,'result',r.execution_result,'permission_effect','none','judgment','manager_declared_actual_execution'));
 RETURN jsonb_build_object('state','fulfilled','request_id',r.id,'project_id',r.project_id,'revision',r.revision,'operation_id',operation_,'result',r.execution_result,'permission_effect','none;existing_qualifications_unchanged');
END $$;
ALTER FUNCTION authz.control_resolve_engineering(text,jsonb) OWNER TO hub2_authz_owner;
REVOKE ALL ON FUNCTION authz.control_resolve_engineering(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.control_resolve_engineering(text,jsonb) TO hub2_hufu;
COMMIT;
