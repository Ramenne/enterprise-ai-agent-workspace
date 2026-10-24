-- Additive to initial tier candidate. Root assigns number; no provider effect.
-- Switch selected versions only; all material/version/SHA identities stay fixed.
SET ROLE hub2_mem_owner;
CREATE TABLE mem.storage_primary_locations(
 version_id uuid PRIMARY KEY REFERENCES mem.content_versions,object_id uuid NOT NULL REFERENCES mem.verified_objects,
 copy_id uuid NOT NULL REFERENCES mem.fixed_object_copies,operation_id uuid NOT NULL REFERENCES mem.storage_tier_operations,
 basis text NOT NULL,selected_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE mem.storage_physical_retirements(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),operation_id uuid NOT NULL UNIQUE REFERENCES mem.storage_tier_operations,
 object_id uuid NOT NULL REFERENCES mem.verified_objects,version_id uuid NOT NULL REFERENCES mem.content_versions,
 project_id uuid NOT NULL,material_id uuid NOT NULL REFERENCES mem.materials,hot jsonb NOT NULL,cold jsonb NOT NULL,
 state text NOT NULL DEFAULT 'held'CHECK(state IN('held','pending','dispatched','unknown','retired')),
 reason text,receipt jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON mem.storage_primary_locations,mem.storage_physical_retirements FROM PUBLIC,hub2_mem,hub2_worker;

-- Primary is per logical fixed version. An archive request in one project must
-- not silently switch an unrelated project's shared object to cold storage.
CREATE OR REPLACE FUNCTION mem.fixed_object_locator(oid uuid)RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,mem AS $$
 SELECT coalesce((SELECT jsonb_build_object('provider',p.provider,'bucket',p.bucket,'key',p.object_key,'version_id',p.provider_version_id)
 FROM mem.fixed_object_copies p WHERE p.object_id=oid AND NOT EXISTS(SELECT FROM mem.storage_tier_copies t WHERE t.copy_id=p.id)
 AND NOT EXISTS(SELECT FROM mem.storage_physical_retirements r WHERE r.state='retired'AND r.hot=jsonb_build_object('provider',p.provider,'bucket',p.bucket,'key',p.object_key,'version_id',p.provider_version_id))
 AND coalesce((SELECT x.status FROM mem.object_observations x WHERE x.object_id=oid AND x.locator->>'key'=p.object_key AND x.locator->>'version_id'=p.provider_version_id ORDER BY x.observed_at DESC,x.id DESC LIMIT 1),'verified')NOT IN('not_found','integrity_mismatch')
 ORDER BY p.created_at DESC,p.id DESC LIMIT 1),
 (SELECT jsonb_build_object('provider',o.provider,'bucket',o.bucket,'key',o.object_key,'version_id',o.provider_version_id)
 FROM mem.verified_objects o WHERE o.id=oid AND NOT EXISTS(SELECT FROM mem.storage_physical_retirements r WHERE r.state='retired'AND r.hot=jsonb_build_object('provider',o.provider,'bucket',o.bucket,'key',o.object_key,'version_id',o.provider_version_id))));
$$;
CREATE FUNCTION mem.fixed_object_locator_for_version(vid uuid)RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,mem AS $$
 SELECT coalesce((SELECT jsonb_build_object('provider',p.provider,'bucket',p.bucket,'key',p.object_key,'version_id',p.provider_version_id)
 FROM mem.storage_primary_locations s JOIN mem.fixed_object_copies p ON p.id=s.copy_id JOIN mem.content_versions v ON v.id=s.version_id
 WHERE v.id=vid AND p.object_id=v.object_id AND p.sha256=v.sha256 AND p.size=v.size),
 (SELECT mem.fixed_object_locator(object_id)FROM mem.content_versions WHERE id=vid));
$$;
REVOKE ALL ON FUNCTION mem.fixed_object_locator_for_version(uuid)FROM PUBLIC;

DO $tier_primary_routes$
DECLARE sig text;before text;after text;
BEGIN
 FOREACH sig IN ARRAY ARRAY['mem.read_version(uuid,text,text)','mem.read_range(uuid,text,text)']LOOP
  before:=pg_get_functiondef(sig::regprocedure);after:=replace(before,'mem.fixed_object_locator(v.object_id)','mem.fixed_object_locator_for_version(v.id)');
  IF after=before THEN RAISE EXCEPTION 'fixed_version_route_base_changed:%',sig;END IF;EXECUTE after;
 END LOOP;
 before:=pg_get_functiondef('mem.storage_tier_command(uuid,text,text)'::regprocedure);
 after:=replace(before,'loc:=mem.fixed_object_locator(o.id);','loc:=mem.fixed_object_locator_for_version(v.id);');
 after:=replace(after,'''target_sha256_verified'',false,''standard_source_retained'',true',
  '''target_sha256_verified'',false,''standard_source_retained'',true,''copy_lineage_verified'',coalesce((b->''receipt''->>''copy_lineage_verified'')::boolean,false),''source_locator'',r.locator');
 IF after=before THEN RAISE EXCEPTION 'tier_command_base_changed';END IF;EXECUTE after;
 -- Worker scope must resolve the event's fixed logical version, never object-wide latest.
 before:=pg_get_functiondef('mem.index_publication_scope(jsonb)'::regprocedure);
 -- Current 390/450 resolves event payload version_id/fixed_refs to v mem.content_versions.
 after:=replace(before,'mem.fixed_object_locator(o.id)','mem.fixed_object_locator_for_version(v.id)');
 IF after=before THEN RAISE EXCEPTION 'worker_scope_base_changed';END IF;
 -- Static 390 declaration was read; native current function must still match.
 IF position('v mem.content_versions'IN before)=0 THEN RAISE EXCEPTION 'worker_version_variable_review_required';END IF;
 EXECUTE after;
END $tier_primary_routes$;

-- Reviewed new tables enter the existing GC catalog/fence, not an unknown schema
-- exception or a wildcard ignore. Existing unrelated table contracts are retained.
INSERT INTO mem.gc_reference_contracts(schema_name,table_name,kind,uuid_fields,json_fields,shape_hash)
VALUES('mem','storage_primary_locations','mutation',ARRAY['object_id','version_id'],'{}',mem.gc_relation_shape('mem.storage_primary_locations'::regclass)),
 ('mem','storage_physical_retirements','ledger','{}','{}',mem.gc_relation_shape('mem.storage_physical_retirements'::regclass))
ON CONFLICT(schema_name,table_name)DO UPDATE SET kind=excluded.kind,uuid_fields=excluded.uuid_fields,json_fields=excluded.json_fields,shape_hash=excluded.shape_hash;
UPDATE mem.gc_reference_contracts SET shape_hash=mem.gc_relation_shape(format('%I.%I',schema_name,table_name)::regclass)
 WHERE schema_name='mem'AND table_name IN('storage_tier_operations','storage_tier_copies');
CREATE TRIGGER gc_reference_fence BEFORE INSERT OR UPDATE OR DELETE ON mem.storage_primary_locations FOR EACH ROW EXECUTE FUNCTION mem.gc_reference_fence();
CREATE TRIGGER gc_reference_fence BEFORE INSERT OR UPDATE OR DELETE ON mem.storage_tier_copies FOR EACH ROW EXECUTE FUNCTION mem.gc_reference_fence();
CREATE FUNCTION mem.storage_retirement_gc_fence()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
BEGIN IF NEW.state<>'open'AND EXISTS(SELECT FROM mem.storage_physical_retirements WHERE object_id=NEW.object_id AND state IN('dispatched','unknown'))
 THEN RAISE EXCEPTION 'unreconciled_locator_retirement_holds_gc' USING ERRCODE='40001';END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION mem.storage_retirement_gc_fence()FROM PUBLIC;
CREATE TRIGGER storage_retirement_gc_fence BEFORE INSERT OR UPDATE ON mem.gc_objects FOR EACH ROW EXECUTE FUNCTION mem.storage_retirement_gc_fence();

-- Future logical reuse of a physically retired fixed object must inherit a valid
-- cold location, never resurrect the original hot key. This grants no read rights.
CREATE FUNCTION mem.storage_inherit_retired_location()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE p mem.fixed_object_copies;r mem.storage_physical_retirements;
BEGIN
 SELECT q.* INTO r FROM mem.storage_physical_retirements q JOIN mem.verified_objects o ON o.id=q.object_id
 WHERE q.object_id=NEW.object_id AND q.state IN('dispatched','unknown','retired')
 AND q.hot=jsonb_build_object('provider',o.provider,'bucket',o.bucket,'key',o.object_key,'version_id',o.provider_version_id)
 ORDER BY q.created_at DESC,q.id DESC LIMIT 1;
 IF r.id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO p FROM mem.fixed_object_copies cp WHERE cp.object_id=NEW.object_id AND cp.sha256=NEW.sha256 AND cp.size=NEW.size
 AND jsonb_build_object('provider',cp.provider,'bucket',cp.bucket,'key',cp.object_key,'version_id',cp.provider_version_id)=r.cold;
 IF p.id IS NULL THEN RAISE EXCEPTION 'retired_object_cold_location_missing';END IF;
 INSERT INTO mem.storage_primary_locations VALUES(NEW.id,NEW.object_id,p.id,r.operation_id,'reuse_retired_fixed_identity',clock_timestamp());RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mem.storage_inherit_retired_location()FROM PUBLIC;
CREATE TRIGGER storage_inherit_retired_location AFTER INSERT ON mem.content_versions FOR EACH ROW EXECUTE FUNCTION mem.storage_inherit_retired_location();

-- Existing gc_reference_fence serializes object facts; retirement also fences
-- new *physical hot* dependencies while a source deletion is dispatched/unknown.
-- UUID logical version references remain valid and are not rejected.
CREATE FUNCTION mem.storage_hot_reference_fence()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE k text;
BEGIN
 FOR k IN SELECT *FROM mem.gc_fact_keys(TG_TABLE_SCHEMA,TG_TABLE_NAME,to_jsonb(NEW))LOOP
  IF EXISTS(SELECT FROM mem.storage_physical_retirements q WHERE q.state IN('dispatched','unknown','retired')
   AND k='locator:'||jsonb_build_array(q.hot->>'provider',q.hot->>'bucket',q.hot->>'key',q.hot->>'version_id')::text)
  THEN RAISE EXCEPTION 'hot_locator_retiring_use_current_fixed_location' USING ERRCODE='40001';END IF;
 END LOOP;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mem.storage_hot_reference_fence()FROM PUBLIC;
RESET ROLE;
DO $physical_reference_fences$DECLARE r record;BEGIN
 FOR r IN SELECT schema_name,table_name FROM mem.gc_reference_contracts WHERE kind='reference'LOOP
  EXECUTE format('CREATE TRIGGER storage_hot_reference_fence BEFORE INSERT OR UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION mem.storage_hot_reference_fence()',r.schema_name,r.table_name);
 END LOOP;
END $physical_reference_fences$;
SET ROLE hub2_mem_owner;

-- Private queue inventory, no HTTP/MCP endpoint. Each effect still goes through
-- fresh Hufu handle in storage_tier_retirement; list access is not an action grant.
CREATE FUNCTION mem.storage_retirement_due(max_items integer)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
BEGIN
 IF NOT pg_has_role(session_user,'hub2_mem','MEMBER')OR coalesce(max_items,0) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'forbidden';END IF;
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(t))FROM(SELECT project_id,material_id,version_id,operation_id
  FROM mem.storage_physical_retirements WHERE state IN('held','pending','dispatched','unknown')ORDER BY created_at,id LIMIT max_items)t),'[]');
END $$;
REVOKE ALL ON FUNCTION mem.storage_retirement_due(integer)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.storage_retirement_due(integer)TO hub2_mem;

CREATE FUNCTION mem.storage_tier_retirement(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
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
   OR(b->'server_evidence'->>'size')::bigint IS DISTINCT FROM o.size OR b->'server_evidence'->>'storage_class'IS DISTINCT FROM(CASE t.tier WHEN 'archive'THEN 'ARCHIVE'ELSE 'DEEP_ARCHIVE'END)
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
  IF q.state NOT IN('dispatched','unknown')THEN RAISE EXCEPTION 'retirement_state_changed';END IF;
  IF b->>'outcome'='retired' THEN
   IF b->'receipt'->'hot'IS DISTINCT FROM q.hot OR b->'receipt'->'cold'IS DISTINCT FROM q.cold OR b->'receipt'->'hot_absent'IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'exact_hot_absence_receipt_required';END IF;
   UPDATE mem.storage_physical_retirements SET state='retired',receipt=b->'receipt',reason=NULL WHERE id=q.id RETURNING * INTO q;
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
END $$;
REVOKE ALL ON FUNCTION mem.storage_tier_retirement(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.storage_tier_retirement(uuid,text,text)TO hub2_mem;
RESET ROLE;
