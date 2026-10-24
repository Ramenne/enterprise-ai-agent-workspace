-- Exact fixed-version HEAD reconciliation contract; old580/590 bytes retained.
-- Root-bound provider semantics + current exact control are enforced in executor.
SET ROLE hub2_mem_owner;
CREATE OR REPLACE FUNCTION mem.gc_reconcile(plan uuid,token uuid,proof jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE p mem.gc_plans;
BEGIN
 SELECT * INTO p FROM mem.gc_plans WHERE id=plan FOR UPDATE;
 IF p.id IS NULL OR p.execution_token IS DISTINCT FROM token OR proof->'locator'IS DISTINCT FROM p.locator OR(coalesce(jsonb_array_length(p.locators),1)>1 AND proof->'locators'IS DISTINCT FROM p.locators)OR proof->'scan_complete'IS DISTINCT FROM 'true'::jsonb OR NOT ((proof->>'method' IS NOT DISTINCT FROM 'authenticated_ListObjectVersions_all_pages') OR ((proof->>'method' IS NOT DISTINCT FROM 'authenticated_exact_version_HEAD') AND (proof->>'coverage' IS NOT DISTINCT FROM 'sealed_locators_only')))OR p.state NOT IN('sealed','unknown','failed')OR NOT EXISTS(SELECT FROM mem.gc_attempts WHERE plan_id=p.id AND execution_token=token)THEN RAISE EXCEPTION 'gc_reconciliation_rejected';END IF;
 IF proof->'present'='false'::jsonb THEN UPDATE mem.gc_plans SET state='succeeded',receipt=jsonb_build_object('previous_receipt',receipt,'reconciliation',proof)WHERE id=p.id RETURNING * INTO p;UPDATE mem.gc_objects SET state='deleted'WHERE object_id=p.object_id;UPDATE mem.verified_objects SET availability='unavailable'WHERE id=p.object_id;END IF;
 IF proof->'present'='false'::jsonb THEN PERFORM mem.gc_outcome_event(p,3);END IF;
 RETURN to_jsonb(p)||jsonb_build_object('permanent_fence_retained',true,'automatic_retry',false);
END $$;
REVOKE ALL ON FUNCTION mem.gc_reconcile(uuid,uuid,jsonb)FROM PUBLIC;GRANT EXECUTE ON FUNCTION mem.gc_reconcile(uuid,uuid,jsonb)TO hub2_gc_executor;
RESET ROLE;
