BEGIN;
SET ROLE hub2_mem_owner;
DO $patch$
DECLARE s text;
BEGIN
 s:=pg_get_functiondef('mem.material_use_candidates(uuid,text,text)'::regprocedure);
 s:=replace(s,'Agent_assesses_actual_use_and_dependencies_then_calls_hub.material.govern;no_human_approval_needed_within_scope','Agent_assesses_usage_then_adjusts_storage_tier_with_hub.material.govern;do_not_change_importance_from_frequency;no_human_approval_needed_within_scope');EXECUTE s;
 s:=pg_get_functiondef('mem.storage_warm_control(uuid,text,text)'::regprocedure);
 s:=replace(s,'''source_archive_retained'',true','''previous_storage_copy_retained'',true');EXECUTE s;
END $patch$;
RESET ROLE;
COMMIT;
