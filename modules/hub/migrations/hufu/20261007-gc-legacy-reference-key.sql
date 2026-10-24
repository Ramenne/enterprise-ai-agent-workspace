-- Legacy fixed/latest references must share the uuid key domain used by scan and fencing.
BEGIN;
CREATE OR REPLACE FUNCTION mem.gc_fact_keys(sch text, tbl text, rowvalue jsonb)
 RETURNS SETOF text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'mem'
AS $function$
DECLARE contract mem.gc_reference_contracts;field text;id text;hasversion boolean:=false;
BEGIN
 IF sch='mem'AND tbl='external_model_dispatches'THEN IF EXISTS(SELECT FROM mem.processing_runs pr WHERE pr.id=(rowvalue->>'run_id')::uuid AND pr.technical_state NOT IN('succeeded','cancelled'))THEN RETURN QUERY SELECT * FROM mem.gc_reference_keys(jsonb_build_array(rowvalue->'input_refs',rowvalue->'source_refs'));END IF;RETURN;END IF;
 IF sch='mem'AND tbl='legacy_reference_bindings'THEN IF rowvalue->>'reference_kind'='fixed'THEN RETURN QUERY SELECT 'uuid:'||(rowvalue->>'target_version_id');ELSIF rowvalue->>'reference_kind'='latest'THEN RETURN QUERY SELECT 'uuid:'||m.current_version_id::text FROM mem.materials m WHERE m.id=(rowvalue->>'target_material_id')::uuid AND m.current_version_id IS NOT NULL;END IF;RETURN;END IF;
 -- Dedicated live lease table is not an ordinary historical read receipt.
 IF sch='mem'AND tbl='gc_use_leases'THEN IF(rowvalue->>'expires_at')::timestamptz>clock_timestamp()THEN RETURN NEXT 'uuid:'||(rowvalue->>'object_id');END IF;RETURN;END IF;
 SELECT * INTO contract FROM mem.gc_reference_contracts WHERE schema_name=sch AND table_name=tbl;
 IF contract.kind IS NULL OR contract.kind IN('none','ledger')THEN RETURN;END IF;
 IF sch='v8'AND tbl='context_manifests'THEN IF rowvalue->>'state'<>'invalid'AND(rowvalue->>'expires_at')::timestamptz>clock_timestamp()THEN RETURN QUERY SELECT 'uuid:'||cs.version_id::text FROM v8.context_sources cs WHERE cs.context_id=(rowvalue->>'id')::uuid;END IF;RETURN;END IF;
 IF sch='mem'AND tbl='text_drafts'THEN RETURN QUERY SELECT * FROM mem.gc_reference_keys(rowvalue->'body'->'source'->'actual_inputs');RETURN;END IF;
 IF sch='jobs'AND tbl='tasks'AND rowvalue->>'kind'NOT IN('index','verification_compensation')THEN RETURN;END IF;
 IF sch='mem'AND tbl='processing_runs'AND rowvalue->>'technical_state'IN('cancelled','succeeded')THEN RETURN;END IF;
 IF sch='mem'AND tbl='object_probe_runs'AND rowvalue->>'state'<>'prepared'THEN RETURN;END IF;
 IF sch='mem'AND tbl='operations'AND rowvalue->>'state'IN('published','cancelled','expired','rejected','conflict')THEN RETURN;END IF;
 IF sch='v8'AND tbl='experiences'AND rowvalue->>'state'IN('superseded','withdrawn')THEN RETURN;END IF;
 IF sch='v8'AND tbl='adoptions'AND EXISTS(SELECT FROM v8.adoptions newer WHERE newer.supersedes=(rowvalue->>'id')::uuid)THEN RETURN;END IF;
 IF sch='mem'AND tbl='disclosures'AND rowvalue->>'state'<>'active'THEN RETURN;END IF;
 IF sch='jobs'AND tbl='tasks'AND rowvalue->>'state'IN('done','dead')THEN RETURN;END IF;
 IF sch='v8'AND tbl='context_sources'AND NOT EXISTS(SELECT FROM v8.context_manifests cm WHERE cm.id=(rowvalue->>'context_id')::uuid AND cm.state<>'invalid'AND cm.expires_at>clock_timestamp())THEN RETURN;END IF;
 IF sch='mem'AND tbl='source_edges'AND EXISTS(SELECT FROM mem.content_versions i JOIN mem.content_versions o ON o.id=(rowvalue->>'output_version_id')::uuid WHERE i.id=(rowvalue->>'input_version_id')::uuid AND i.material_id=o.material_id)THEN RETURN;END IF;
 FOR field IN SELECT unnest(contract.uuid_fields)LOOP IF field LIKE '%version_id'AND rowvalue->>field IS NOT NULL THEN hasversion:=true;END IF;END LOOP;
 FOR field IN SELECT unnest(contract.uuid_fields)LOOP
  IF hasversion AND field IN('material_id','target_material_id')AND contract.kind='reference'THEN CONTINUE;END IF;
  id:=rowvalue->>field;IF id~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'THEN RETURN NEXT 'uuid:'||id;END IF;
 END LOOP;
 FOR field IN SELECT unnest(contract.json_fields)LOOP RETURN QUERY SELECT * FROM mem.gc_reference_keys(rowvalue->field);END LOOP;
 IF sch='mem'AND tbl='fixed_object_copies'THEN RETURN QUERY SELECT * FROM mem.gc_reference_keys(rowvalue);END IF;
END $function$;

DO $verify$
DECLARE keys text[];
BEGIN
 SELECT array_agg(k) INTO keys FROM mem.gc_fact_keys('mem','legacy_reference_bindings','{"reference_kind":"fixed","target_version_id":"e3835720-e7c9-4fd5-a652-232c99533e49"}'::jsonb)k;
 IF keys IS DISTINCT FROM ARRAY['uuid:e3835720-e7c9-4fd5-a652-232c99533e49'] THEN RAISE EXCEPTION 'legacy_fixed_reference_key_mismatch';END IF;
 SELECT array_agg(k) INTO keys FROM mem.gc_fact_keys('mem','legacy_reference_bindings','{"reference_kind":"latest","target_material_id":"85ad8209-b729-4d6e-aa05-983c7e7c9f9b"}'::jsonb)k;
 IF keys IS DISTINCT FROM ARRAY['uuid:e3835720-e7c9-4fd5-a652-232c99533e49'] THEN RAISE EXCEPTION 'legacy_latest_reference_key_mismatch';END IF;
END $verify$;
COMMIT;
