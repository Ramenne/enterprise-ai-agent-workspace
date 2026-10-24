BEGIN;
SET LOCAL ROLE hub2_mem_owner;
CREATE OR REPLACE FUNCTION mem.storage_lifecycle_plan(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;items jsonb:='[]'::jsonb;n integer:=coalesce((b->>'limit')::integer,20);after_id uuid:=(b->>'after_version_id')::uuid;candidate record;loc jsonb;operation_key text;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d OR n NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_input';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 FOR candidate IN
 WITH facts AS MATERIALIZED (
 SELECT m.id material_id,m.project_id,m.importance_level,m.properties,v.id version_id,v.object_id,v.created_at,
  s.selected_at,s.operation_id,s.basis,t.tier,q.state retirement_state,
  CASE WHEN s.basis LIKE 'standard_copy:%' THEN 'standard' ELSE coalesce(t.tier,'standard') END primary_tier,
  greatest(m.created_at,v.created_at,coalesce(u.last_used_at,m.created_at),coalesce(CASE WHEN s.basis LIKE 'standard_copy:%' THEN s.selected_at END,m.created_at)) last_activity,
  coalesce(w.uses,0) archive_uses
 FROM mem.materials m JOIN mem.content_versions v ON v.material_id=m.id
 LEFT JOIN mem.storage_primary_locations s ON s.version_id=v.id
 LEFT JOIN mem.storage_tier_copies t ON t.copy_id=s.copy_id
 LEFT JOIN mem.storage_physical_retirements q ON q.operation_id=s.operation_id
 LEFT JOIN LATERAL(SELECT max(occurred_at) last_used_at FROM mem.material_use_events WHERE material_id=m.id)u ON true
 LEFT JOIN LATERAL(SELECT count(DISTINCT (actor_id,client_id,version_id,event_key)) uses FROM mem.material_use_events
  WHERE material_id=m.id AND occurred_at>=s.selected_at AND kind IN('body_read','adopted','reused'))w ON true
 WHERE m.project_id=(c->>'project_id')::uuid AND m.state IN('active','trashed')
  AND (b->>'material_id' IS NULL OR m.id=(b->>'material_id')::uuid)
  AND (b->>'version_id' IS NULL OR v.id=(b->>'version_id')::uuid)
  AND (after_id IS NULL OR v.id>after_id)
 ), due AS MATERIALIZED (
 SELECT *,mem.storage_lifecycle_target(primary_tier,last_activity,archive_uses,coalesce(properties#>>'{governance,special_designation,active}','false')='true' OR coalesce(properties#>>'{storage_policy,keep_standard}','false')='true',retirement_state,clock_timestamp()) target_tier FROM facts
 )
 SELECT * FROM due WHERE target_tier IS NOT NULL ORDER BY version_id
 LOOP
  loc:=mem.fixed_object_locator_for_version(candidate.version_id);
  IF loc IS NULL OR NOT mem.version_visible((c->>'actor_id')::uuid,candidate.version_id) THEN CONTINUE;END IF;
  operation_key:='lifecycle14:'||candidate.version_id||':'||candidate.target_tier||':'||substr(encode(public.digest(loc::text,'sha256'),'hex'),1,24);
  items:=items||jsonb_build_array(jsonb_build_object('project_id',candidate.project_id,'material_id',candidate.material_id,'version_id',candidate.version_id,'primary_tier',candidate.primary_tier,
   'target_tier',candidate.target_tier,'last_activity',candidate.last_activity,'archive_uses',candidate.archive_uses,'idempotency_key',operation_key,'placement_operation_id',candidate.operation_id));
  EXIT WHEN jsonb_array_length(items)=n;
 END LOOP;
 RETURN jsonb_build_object('state','lifecycle_plan','policy',mem.storage_lifecycle_policy(),'items',items,'next_after_version_id',CASE WHEN jsonb_array_length(items)=n THEN items->(n-1)->>'version_id' END,
  'coverage','current_authorized_fixed_versions;usage_since_instrumentation;creation_is_fallback','classification','Agent_or_member;unclassified_does_not_block_archive');
END $$;
RESET ROLE;
COMMIT;
