BEGIN;
SET LOCAL ROLE hub2_mem_owner;
-- Content importance and physical access frequency remain independent.
CREATE FUNCTION mem.storage_lifecycle_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT '{"version":"file-lifecycle-20261014-v1","idle_days":14,"warm_uses":3,"tiers":["standard","archive"],"infrequent":"migrate_to_archive","special_default":"keep_standard","usage":"body_read/adopted/reused;distinct actor/client/version/event_key;maintenance excluded","deletion":"no_logical_file_or_history_deletion"}'::jsonb
$$;
REVOKE ALL ON FUNCTION mem.storage_lifecycle_policy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.storage_lifecycle_policy() TO hub2_mem;
-- Internal enumeration discloses only scope IDs. Every plan/effect still uses current Hufu authority.
CREATE FUNCTION mem.storage_lifecycle_projects() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
 SELECT DISTINCT project_id FROM mem.materials WHERE state IN ('active','trashed') ORDER BY project_id
$$;
REVOKE ALL ON FUNCTION mem.storage_lifecycle_projects() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.storage_lifecycle_projects() TO hub2_mem;
CREATE INDEX IF NOT EXISTS material_use_lifecycle_version ON mem.material_use_events(version_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS material_use_lifecycle_material ON mem.material_use_events(material_id,occurred_at DESC);
CREATE FUNCTION mem.storage_lifecycle_plan(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;items jsonb;n integer:=coalesce((b->>'limit')::integer,20);after_id uuid:=(b->>'after_version_id')::uuid;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d OR n NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_input';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 WITH facts AS (
 SELECT m.id material_id,m.project_id,m.importance_level,m.properties,v.id version_id,v.object_id,v.created_at,
  s.selected_at,s.operation_id,s.basis,t.tier,q.state retirement_state,
  CASE WHEN s.basis LIKE 'standard_copy:%' THEN 'standard' ELSE coalesce(t.tier,'standard') END primary_tier,
  greatest(m.created_at,v.created_at,coalesce(u.last_used_at,m.created_at),coalesce(CASE WHEN s.basis LIKE 'standard_copy:%' THEN s.selected_at END,m.created_at)) last_activity,
  coalesce(w.uses,0) archive_uses,
  mem.fixed_object_locator_for_version(v.id) locator
 FROM mem.materials m JOIN mem.content_versions v ON v.material_id=m.id
 LEFT JOIN mem.storage_primary_locations s ON s.version_id=v.id
 LEFT JOIN mem.storage_tier_copies t ON t.copy_id=s.copy_id
 LEFT JOIN mem.storage_physical_retirements q ON q.operation_id=s.operation_id
 LEFT JOIN LATERAL(SELECT max(occurred_at) last_used_at FROM mem.material_use_events WHERE material_id=m.id)u ON true
 LEFT JOIN LATERAL(SELECT count(DISTINCT (actor_id,client_id,version_id,event_key)) uses FROM mem.material_use_events
  WHERE material_id=m.id AND occurred_at>=s.selected_at AND kind IN('body_read','adopted','reused'))w ON true
 WHERE m.project_id=(c->>'project_id')::uuid AND m.state IN('active','trashed')
  AND mem.version_visible((c->>'actor_id')::uuid,v.id)
  AND (b->>'material_id' IS NULL OR m.id=(b->>'material_id')::uuid)
  AND (b->>'version_id' IS NULL OR v.id=(b->>'version_id')::uuid)
  AND (after_id IS NULL OR v.id>after_id)
 ), due AS (
 SELECT *,CASE
  WHEN primary_tier='infrequent' THEN 'archive'
  WHEN primary_tier IN('archive','deep_archive') AND (archive_uses>=3 OR properties#>>'{governance,special_designation,active}'='true' OR properties#>>'{storage_policy,keep_standard}'='true') THEN 'standard'
  WHEN primary_tier='standard' AND last_activity<=clock_timestamp()-interval '14 days'
   AND coalesce(properties#>>'{governance,special_designation,active}','false')<>'true'
   AND coalesce(properties#>>'{storage_policy,keep_standard}','false')<>'true' THEN 'archive'
 WHEN primary_tier IN('infrequent','archive','deep_archive') AND retirement_state IN('pending','held','dispatched','unknown') THEN 'retire'
 END target_tier FROM facts
 ), selected AS (
 SELECT *, 'lifecycle14:'||version_id||':'||target_tier||':'||substr(encode(public.digest(coalesce(locator::text,'missing'),'sha256'),'hex'),1,24) idempotency_key
 FROM due WHERE target_tier IS NOT NULL AND locator IS NOT NULL ORDER BY version_id LIMIT n
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',project_id,'material_id',material_id,'version_id',version_id,'primary_tier',primary_tier,
  'target_tier',target_tier,'last_activity',last_activity,'archive_uses',archive_uses,'idempotency_key',idempotency_key,'placement_operation_id',operation_id)
  ORDER BY version_id),'[]'::jsonb) INTO items FROM selected;
 RETURN jsonb_build_object('state','lifecycle_plan','policy',mem.storage_lifecycle_policy(),'items',items,'next_after_version_id',CASE WHEN jsonb_array_length(items)=n THEN items->(n-1)->>'version_id' END,
  'coverage','current_authorized_fixed_versions;usage_since_instrumentation;creation_is_fallback','classification','Agent_or_member;unclassified_does_not_block_archive');
END $$;
REVOKE ALL ON FUNCTION mem.storage_lifecycle_plan(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.storage_lifecycle_plan(uuid,text,text) TO hub2_mem;
-- Recheck idle policy inside the actual dispatch transaction, after planning.
CREATE FUNCTION mem.storage_lifecycle_archive_due(vid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
 SELECT CASE WHEN t.tier='infrequent' AND coalesce(s.basis,'') NOT LIKE 'standard_copy:%' THEN true ELSE
  coalesce(m.properties#>>'{governance,special_designation,active}','false')<>'true'
  AND coalesce(m.properties#>>'{storage_policy,keep_standard}','false')<>'true'
  AND greatest(m.created_at,v.created_at,coalesce((SELECT max(occurred_at) FROM mem.material_use_events WHERE material_id=m.id),m.created_at),
   coalesce(CASE WHEN s.basis LIKE 'standard_copy:%' THEN s.selected_at END,m.created_at))<=statement_timestamp()-interval '14 days' END
 FROM mem.content_versions v JOIN mem.materials m ON m.id=v.material_id LEFT JOIN mem.storage_primary_locations s ON s.version_id=v.id
 LEFT JOIN mem.storage_tier_copies t ON t.copy_id=s.copy_id WHERE v.id=vid
$$;
REVOKE ALL ON FUNCTION mem.storage_lifecycle_archive_due(uuid) FROM PUBLIC;
-- Retire STANDARD_IA: explicit old requests now resolve to archive, never create more low-frequency copies.
DO $patch$
DECLARE s text;
BEGIN
 s:=pg_get_functiondef('mem.storage_tier_command(uuid,text,text)'::regprocedure);
 IF position('loc:=mem.fixed_object_locator_for_version(v.id);' IN s)=0 THEN RAISE EXCEPTION 'current_fixed_locator_patch_missing';END IF;
 s:=replace(s,'loc:=mem.fixed_object_locator_for_version(v.id);',
 'loc:=mem.fixed_object_locator_for_version(v.id); IF b->>''command''=''archive_copy'' AND b->>''tier''=''infrequent'' THEN RAISE EXCEPTION ''infrequent_tier_retired_use_archive''; END IF;');
 s:=replace(s,'IF r.state<>''prepared'' THEN RAISE EXCEPTION ''tier_already_dispatched_query_only'' USING ERRCODE=''40001'';END IF;',
 'IF r.state<>''prepared'' THEN RAISE EXCEPTION ''tier_already_dispatched_query_only'' USING ERRCODE=''40001'';END IF; IF r.idempotency_key LIKE ''lifecycle14:%'' AND r.command=''archive_copy'' AND mem.storage_lifecycle_archive_due(v.id) IS DISTINCT FROM true THEN RAISE EXCEPTION ''lifecycle_recent_activity_preserve_standard'' USING ERRCODE=''40001''; END IF;');
 EXECUTE s;
END $patch$;
RESET ROLE;
COMMIT;
