CREATE OR REPLACE FUNCTION mem.storage_lifecycle_archive_due(vid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'mem'
AS $function$
 SELECT CASE WHEN t.tier='infrequent' AND coalesce(s.basis,'') NOT LIKE 'standard_copy:%' THEN true ELSE
  coalesce(m.properties#>>'{governance,special_designation,active}','false')<>'true'
  AND coalesce(m.properties#>>'{storage_policy,keep_standard}','false')<>'true'
  AND mem.storage_lifecycle_last_activity(greatest(m.created_at,v.created_at),sc.original_created_at,sc.original_last_used_at,
   (SELECT max(occurred_at) FROM mem.material_use_events WHERE material_id=m.id),CASE WHEN s.basis LIKE 'standard_copy:%' THEN s.selected_at END,
   sc.version_id IS NOT NULL OR (m.origin_kind='legacy_import' AND v.reason IN('actual_verified_current_regional_copy','legacy_ledger_digest_bound_to_actual_COS_fixed_version;bytes_verified_before_each_delivery')) OR EXISTS(SELECT FROM mem.legacy_reference_bindings lb WHERE lb.target_version_id=v.id AND lb.source_system LIKE 'legacy-mengstore%'))<=statement_timestamp()-(mem.storage_lifecycle_policy()->>'idle_days')::integer*interval '1 day' END
 FROM mem.content_versions v JOIN mem.materials m ON m.id=v.material_id LEFT JOIN mem.storage_source_clocks sc ON sc.version_id=v.id LEFT JOIN mem.storage_primary_locations s ON s.version_id=v.id
 LEFT JOIN mem.storage_tier_copies t ON t.copy_id=s.copy_id WHERE v.id=vid
$function$;

