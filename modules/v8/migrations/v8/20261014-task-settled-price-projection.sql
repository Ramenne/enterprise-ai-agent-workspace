BEGIN;
SET ROLE hub2_v8_owner;
DO $patch$
DECLARE body text; anchor text;
BEGIN
 body:=pg_get_functiondef('v8.board_task_projection(uuid,uuid,boolean,boolean,boolean)'::regprocedure);
 anchor:='RETURN jsonb_build_object(''publication_state'',t.state,';
 IF position('settled_base_points_cents' in body)=0 THEN
  IF position(anchor in body)=0 THEN RAISE EXCEPTION 'task_projection_source_changed'; END IF;
  body:=replace(body,anchor,'RETURN jsonb_build_object(''settled_base_points_cents'',CASE WHEN t.completion_receipt_id IS NOT NULL THEN (SELECT e.debt_delta_cents FROM v8.points_entries e WHERE e.organization_id=t.organization_id AND e.task_id=t.id AND e.claim_id=(owner->>''claim_id'')::uuid AND e.category=''base'') ELSE NULL END,''publication_state'',t.state,');
  EXECUTE body;
 END IF;
END $patch$;
RESET ROLE;
COMMIT;