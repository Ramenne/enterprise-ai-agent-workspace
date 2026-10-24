BEGIN;
SET LOCAL ROLE hub2_mem_owner;
CREATE TABLE IF NOT EXISTS mem.storage_source_clocks(
 version_id uuid PRIMARY KEY REFERENCES mem.content_versions(id),
 source_system text NOT NULL,source_id text NOT NULL,
 original_created_at timestamptz,original_last_used_at timestamptz,
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 observed_at timestamptz NOT NULL,
 CHECK(original_created_at IS NOT NULL OR original_last_used_at IS NOT NULL),
 CHECK(original_created_at IS NULL OR original_created_at<=observed_at),
 CHECK(original_last_used_at IS NULL OR original_last_used_at<=observed_at)
);
REVOKE ALL ON mem.storage_source_clocks FROM PUBLIC;
INSERT INTO mem.gc_reference_contracts(schema_name,table_name,kind,uuid_fields,json_fields,shape_hash)
VALUES('mem','storage_source_clocks','ledger','{}','{}',mem.gc_relation_shape('mem.storage_source_clocks'::regclass))
ON CONFLICT(schema_name,table_name)DO UPDATE SET kind=EXCLUDED.kind,uuid_fields=EXCLUDED.uuid_fields,json_fields=EXCLUDED.json_fields,shape_hash=EXCLUDED.shape_hash;

CREATE INDEX IF NOT EXISTS legacy_bindings_version_clock_idx ON mem.legacy_reference_bindings(target_version_id,source_system,source_id) WHERE target_version_id IS NOT NULL;
CREATE OR REPLACE FUNCTION mem.storage_source_epoch(value text) RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE epoch numeric;
BEGIN
 IF value IS NULL OR value !~ '^[0-9]+([.][0-9]+)?$' THEN RETURN NULL;END IF;
 epoch:=value::numeric;IF epoch>100000000000 THEN epoch:=epoch/1000;END IF;
 IF epoch<=0 OR epoch>32503680000 THEN RETURN NULL;END IF;
 RETURN timestamptz '1970-01-01 00:00:00+00'+epoch::double precision*interval '1 second';
END $$;
CREATE OR REPLACE FUNCTION mem.storage_lifecycle_last_activity(native_created timestamptz,source_created timestamptz,source_used timestamptz,local_used timestamptz,warmed_at timestamptz,imported boolean)
RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT greatest(CASE WHEN imported THEN coalesce(source_used,source_created) ELSE native_created END,local_used,warmed_at)
$$;
REVOKE ALL ON FUNCTION mem.storage_source_epoch(text),mem.storage_lifecycle_last_activity(timestamptz,timestamptz,timestamptz,timestamptz,timestamptz,boolean) FROM PUBLIC;

WITH originals AS(SELECT value x FROM jsonb_array_elements($source_clocks$[]$source_clocks$::jsonb)),
matched AS(
 SELECT v.id version_id,orig.x,
 coalesce(l.source_system,'legacy-mengstore-regional770') source_system
 FROM mem.content_versions v JOIN mem.materials m ON m.id=v.material_id
 LEFT JOIN LATERAL(SELECT source_system,source_id FROM mem.legacy_reference_bindings WHERE target_version_id=v.id AND source_system LIKE 'legacy-mengstore%' ORDER BY source_system LIMIT 1)l ON true
 JOIN originals orig ON orig.x->>'source_id'=coalesce(l.source_id,CASE WHEN m.origin_kind='legacy_import' AND v.reason IN('actual_verified_current_regional_copy','legacy_ledger_digest_bound_to_actual_COS_fixed_version;bytes_verified_before_each_delivery') THEN m.properties->>'legacy_source_file_id' END)
)
INSERT INTO mem.storage_source_clocks(version_id,source_system,source_id,original_created_at,original_last_used_at,evidence_sha256,observed_at)
SELECT version_id,source_system,x->>'source_id',mem.storage_source_epoch(x->>'created_at'),mem.storage_source_epoch(x->>'last_access_at'),x->>'evidence_sha256','2026-10-19T17:06:31.398101+00:00'::timestamptz FROM matched
WHERE coalesce(mem.storage_source_epoch(x->>'last_access_at'),mem.storage_source_epoch(x->>'created_at')) IS NOT NULL
ON CONFLICT(version_id)DO UPDATE SET original_created_at=EXCLUDED.original_created_at,original_last_used_at=greatest(mem.storage_source_clocks.original_last_used_at,EXCLUDED.original_last_used_at),evidence_sha256=EXCLUDED.evidence_sha256,observed_at=EXCLUDED.observed_at;
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
  mem.storage_lifecycle_last_activity(greatest(m.created_at,v.created_at),sc.original_created_at,sc.original_last_used_at,u.last_used_at,CASE WHEN s.basis LIKE 'standard_copy:%' THEN s.selected_at END,
   sc.version_id IS NOT NULL OR (m.origin_kind='legacy_import' AND v.reason IN('actual_verified_current_regional_copy','legacy_ledger_digest_bound_to_actual_COS_fixed_version;bytes_verified_before_each_delivery')) OR EXISTS(SELECT FROM mem.legacy_reference_bindings lb WHERE lb.target_version_id=v.id AND lb.source_system LIKE 'legacy-mengstore%')) last_activity,
  coalesce(w.uses,0) archive_uses
 FROM mem.materials m JOIN mem.content_versions v ON v.material_id=m.id
 LEFT JOIN mem.storage_source_clocks sc ON sc.version_id=v.id
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
  'coverage','current_authorized_fixed_versions;original_source_usage_preserved;missing_source_clock_pending','classification','Agent_or_member;unclassified_does_not_block_archive');
END $$;

RESET ROLE;
COMMIT;
