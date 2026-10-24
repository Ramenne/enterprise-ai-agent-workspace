BEGIN;
SET LOCAL ROLE hub2_mem_owner;
CREATE OR REPLACE FUNCTION mem.storage_tier_retirement(h uuid, d text, payload text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'mem'
AS $function$
DECLARE b jsonb:=payload::jsonb;c jsonb;r mem.storage_tier_operations;q mem.storage_physical_retirements;
 v mem.content_versions;o mem.verified_objects;cp mem.fixed_object_copies;t mem.storage_tier_copies;loc jsonb;rev bigint;why text;
 x record;n bigint;phase text:=b->>'phase';
BEGIN
 IF payload IS NULL OR encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d OR coalesce(phase,'')NOT IN('status','attest_known','switch','claim','outcome')THEN RAISE EXCEPTION 'invalid_retirement_request';END IF;
 c:=mem.guard(h,CASE WHEN phase='status'THEN 'mem.read'ELSE 'mem.write'END,d,b);
 SELECT cv.* INTO v FROM mem.content_versions cv JOIN mem.materials m ON m.id=cv.material_id WHERE cv.id=(b->>'version_id')::uuid
 AND cv.material_id=(b->>'material_id')::uuid AND m.project_id=(c->>'project_id')::uuid AND mem.version_visible((c->>'actor_id')::uuid,cv.id);
 IF v.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;PERFORM mem.assert_version_sources(h,v.id,'mem.read');
 SELECT * INTO o FROM mem.verified_objects WHERE id=v.object_id;
 SELECT * INTO r FROM mem.storage_tier_operations WHERE id=(b->>'operation_id')::uuid AND version_id=v.id AND project_id=(c->>'project_id')::uuid AND command='archive_copy';
 IF r.id IS NULL OR r.state<>'copy_created' THEN RAISE EXCEPTION 'known_archive_copy_required';END IF;
 SELECT * INTO cp FROM mem.fixed_object_copies WHERE id=(r.receipt->>'copy_id')::uuid AND object_id=o.id;
 SELECT * INTO t FROM mem.storage_tier_copies WHERE copy_id=cp.id;
 loc:=jsonb_build_object('provider',cp.provider,'bucket',cp.bucket,'key',cp.object_key,'version_id',cp.provider_version_id);
 IF phase='attest_known' THEN
  -- Only controlled Mem code supplies evidence from its private durable journal.
  -- The public route/MCP strict schema never permits server_evidence.
  IF b->'server_evidence'->'source_locator'IS DISTINCT FROM r.locator OR b->'server_evidence'->'target_locator'IS DISTINCT FROM loc
   OR(b->'server_evidence'->>'size')::bigint IS DISTINCT FROM o.size OR b->'server_evidence'->>'storage_class'IS DISTINCT FROM(CASE t.tier WHEN 'archive'THEN 'ARCHIVE' WHEN 'infrequent' THEN 'STANDARD_IA' ELSE 'DEEP_ARCHIVE'END)
   OR coalesce(b->'server_evidence'->>'journal_sha256','')!~'^[a-f0-9]{64}$'THEN RAISE EXCEPTION 'known_fixed_copy_evidence_required';END IF;
  PERFORM authz.assert_effect(h);UPDATE mem.storage_tier_operations SET receipt=receipt||jsonb_build_object('copy_lineage_verified',true,'known_copy_journal_sha256',b->'server_evidence'->>'journal_sha256')WHERE id=r.id RETURNING * INTO r;
 END IF;
 IF cp.id IS NULL OR NOT(coalesce((r.receipt->>'copy_lineage_verified')::boolean,false)OR t.target_sha256_verified)THEN RAISE EXCEPTION 'copy_outcome_unknown_preserve_hot';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('mem.gc.fact:uuid:'||o.id::text,0));
 SELECT revision INTO rev FROM mem.object_storage_state WHERE object_id=o.id FOR UPDATE;
 PERFORM 1 FROM mem.gc_objects WHERE object_id=o.id FOR UPDATE;
 IF mem.gc_physical_state(o.id)<>'retained' THEN RAISE EXCEPTION 'gc_object_destroying_or_destroyed';END IF;
 SELECT * INTO q FROM mem.storage_physical_retirements WHERE operation_id=r.id FOR UPDATE;
 IF phase='switch' THEN
  IF q.id IS NULL THEN
   IF (b->>'expected_storage_revision')::bigint IS DISTINCT FROM rev THEN RAISE EXCEPTION 'tier_revision_conflict' USING ERRCODE='40001';END IF;
   -- No content version change. Only this authorized fixed version is moved.
   PERFORM authz.assert_effect(h);
   INSERT INTO mem.storage_primary_locations VALUES(v.id,o.id,cp.id,r.id,CASE WHEN t.target_sha256_verified THEN 'target_full_SHA'ELSE 'known_fixed_version_server_COPY'END,clock_timestamp())
    ON CONFLICT(version_id)DO UPDATE SET copy_id=excluded.copy_id,operation_id=excluded.operation_id,basis=excluded.basis,selected_at=excluded.selected_at;
   INSERT INTO mem.storage_physical_retirements(operation_id,object_id,version_id,project_id,material_id,hot,cold,reason)
    VALUES(r.id,o.id,v.id,(c->>'project_id')::uuid,v.material_id,r.locator,loc,'await_current_reader_and_explicit_recovery_protection')RETURNING * INTO q;
   UPDATE mem.object_storage_state SET revision=revision+1 WHERE object_id=o.id RETURNING revision INTO rev;
  END IF;
 END IF;
 IF phase IN('switch','claim')AND q.state IN('held','pending')THEN
  -- Logical references remain valid through cold. Only explicit physical hot
  -- references and versions not switched off hot must block this locator retirement.
  IF EXISTS(SELECT FROM mem.content_versions cv WHERE cv.object_id=o.id AND mem.fixed_object_locator_for_version(cv.id)=q.hot)THEN why:='unmigrated_fixed_version_uses_hot';END IF;
  IF EXISTS(SELECT FROM mem.verified_objects vo WHERE vo.id<>o.id AND jsonb_build_object('provider',vo.provider,'bucket',vo.bucket,'key',vo.object_key,'version_id',vo.provider_version_id)=q.hot)
   OR EXISTS(SELECT FROM mem.fixed_object_copies p WHERE p.object_id<>o.id AND jsonb_build_object('provider',p.provider,'bucket',p.bucket,'key',p.object_key,'version_id',p.provider_version_id)=q.hot)THEN why:='physical_hot_locator_shared';END IF;
  FOR x IN SELECT n.nspname,c1.relname,c1.oid,rc.kind FROM pg_class c1 JOIN pg_namespace n ON n.oid=c1.relnamespace LEFT JOIN mem.gc_reference_contracts rc ON rc.schema_name=n.nspname AND rc.table_name=c1.relname
   WHERE(n.nspname IN('mem','v8','evidence','coord','jobs')OR EXISTS(SELECT FROM pg_constraint f WHERE f.conrelid=c1.oid AND f.contype='f'AND f.confrelid IN('mem.materials'::regclass,'mem.content_versions'::regclass,'mem.verified_objects'::regclass)))AND c1.relkind IN('r','p')AND NOT c1.relispartition AND c1.relname NOT LIKE 'gc_%' LOOP
   IF x.kind='reference' THEN
    EXECUTE format('SELECT count(*)FROM %I.%I r WHERE EXISTS(SELECT FROM mem.gc_fact_keys($1,$2,to_jsonb(r))k WHERE k=$3)',x.nspname,x.relname)INTO n
      USING x.nspname,x.relname,'locator:'||jsonb_build_array(q.hot->>'provider',q.hot->>'bucket',q.hot->>'key',q.hot->>'version_id')::text;
    IF n>0 THEN why:='explicit_hot_locator_reference_retained';END IF;
   END IF;
  END LOOP;
  IF EXISTS(SELECT FROM mem.gc_use_leases WHERE object_id=o.id AND expires_at>clock_timestamp())THEN why:='active_reader_or_operation';END IF;
  IF EXISTS(SELECT FROM mem.gc_restore_protections WHERE project_id=q.project_id AND(object_id=o.id OR object_id IS NULL)AND retain_until>clock_timestamp())THEN why:='restore_manifest_protected';END IF;
  IF EXISTS(SELECT FROM mem.gc_restore_coverage WHERE project_id=q.project_id AND retain_until>clock_timestamp())THEN why:='recovery_retention_window_active';END IF;
  UPDATE mem.storage_physical_retirements SET state=CASE WHEN why IS NULL THEN 'pending'ELSE 'held'END,reason=why WHERE id=q.id RETURNING * INTO q;
 END IF;
 IF phase='claim' THEN
  IF q.state<>'pending' THEN RETURN jsonb_build_object('state','held','reason',coalesce(q.reason,'retirement_not_pending'),'retirement_id',q.id);END IF;
  IF (b->>'expected_storage_revision')::bigint IS DISTINCT FROM rev THEN RAISE EXCEPTION 'tier_revision_conflict' USING ERRCODE='40001';END IF;
  PERFORM authz.assert_effect(h);UPDATE mem.storage_physical_retirements SET state='dispatched'WHERE id=q.id RETURNING * INTO q;
 ELSIF phase='outcome' THEN
  IF q.state NOT IN('dispatched','unknown') AND NOT(q.state IN('pending','retired') AND b->>'outcome'='retired')THEN RAISE EXCEPTION 'retirement_state_changed';END IF;
  IF b->>'outcome'='retired' THEN
   IF b->'receipt'->'hot'IS DISTINCT FROM q.hot OR b->'receipt'->'cold'IS DISTINCT FROM q.cold OR b->'receipt'->'hot_absent'IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'exact_hot_absence_receipt_required';END IF;
   UPDATE mem.storage_physical_retirements SET state='retired',receipt=coalesce(receipt,b->'receipt'),reason=NULL WHERE id=q.id RETURNING * INTO q;
  ELSIF b->>'outcome'='no_effect' THEN
   UPDATE mem.storage_physical_retirements SET state='pending',reason='journal_preflight_no_provider_send'WHERE id=q.id RETURNING * INTO q;
  ELSIF b->>'outcome'='unknown' THEN
   UPDATE mem.storage_physical_retirements SET state='unknown',reason='query_exact_locator_do_not_repeat_delete'WHERE id=q.id RETURNING * INTO q;
  ELSE RAISE EXCEPTION 'invalid_retirement_outcome';END IF;
 END IF;
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('retirement_id',q.id,'operation_id',r.id,'state',coalesce(q.state,'not_switched'),'reason',q.reason,'hot',r.locator,'cold',loc,
  'sha256',o.sha256,'size',o.size,'storage_revision',rev,'primary_tier',t.tier,'logical_identity_unchanged',true,
  'hot_deleted',q.state='retired','receipt',q.receipt,'automatic_delete_retry',false,'recovery_coverage_advisory','mapping_uses_current_PG_transaction_and_WAL; independent_full_coverage_not_asserted');
END $function$


RESET ROLE;
COMMIT;
