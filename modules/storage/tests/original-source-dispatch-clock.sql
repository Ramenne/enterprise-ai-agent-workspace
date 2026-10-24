BEGIN;
SET LOCAL ROLE hub2_mem_owner;
DO $$
DECLARE checked bigint; mismatches bigint;
BEGIN
 WITH facts AS(
 SELECT v.id,m.properties,mem.storage_lifecycle_last_activity(greatest(m.created_at,v.created_at),sc.original_created_at,sc.original_last_used_at,
  (SELECT max(occurred_at) FROM mem.material_use_events WHERE material_id=m.id),CASE WHEN s.basis LIKE 'standard_copy:%' THEN s.selected_at END,true) activity
 FROM mem.storage_source_clocks sc JOIN mem.content_versions v ON v.id=sc.version_id JOIN mem.materials m ON m.id=v.material_id
 LEFT JOIN mem.storage_primary_locations s ON s.version_id=v.id LEFT JOIN mem.storage_tier_copies t ON t.copy_id=s.copy_id
 WHERE CASE WHEN s.basis LIKE 'standard_copy:%' THEN 'standard' ELSE coalesce(t.tier,'standard') END='standard'
 )
 SELECT count(*),count(*) FILTER(WHERE mem.storage_lifecycle_archive_due(id) IS DISTINCT FROM
  coalesce(mem.storage_lifecycle_target('standard',activity,0,coalesce(properties#>>'{governance,special_designation,active}','false')='true' OR coalesce(properties#>>'{storage_policy,keep_standard}','false')='true',NULL,statement_timestamp())='archive',false))
 INTO checked,mismatches FROM facts;
 IF checked=0 THEN RAISE EXCEPTION 'no_real_imported_standard_cases_checked';END IF;
 IF mismatches<>0 THEN RAISE EXCEPTION 'planner_dispatch_clock_disagreement';END IF;
END $$;
SELECT jsonb_build_object('state','passed','check','planner_dispatch_agreement_on_real_imported_standard_versions');
ROLLBACK;
