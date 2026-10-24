-- Additive GC capability. No runtime qualifications, login, cloud policy or worker grants.
CREATE ROLE hub2_gc_executor NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA mem TO hub2_gc_executor;
SET ROLE hub2_mem_owner;
CREATE TABLE mem.gc_objects(object_id uuid PRIMARY KEY REFERENCES mem.verified_objects,project_id uuid NOT NULL,material_id uuid NOT NULL,revision bigint NOT NULL DEFAULT 0,state text NOT NULL DEFAULT 'open' CHECK(state IN('open','sealed','deleted')),sealed_at timestamptz);
CREATE TABLE mem.gc_restore_coverage(project_id uuid PRIMARY KEY,complete boolean NOT NULL DEFAULT false,retain_until timestamptz NOT NULL,valid_until timestamptz NOT NULL,manifest jsonb NOT NULL,revision bigint NOT NULL DEFAULT 1);
CREATE TABLE mem.gc_restore_protections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL,object_id uuid REFERENCES mem.verified_objects,retain_until timestamptz NOT NULL,manifest jsonb NOT NULL);
CREATE TABLE mem.gc_use_leases(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL,object_id uuid NOT NULL REFERENCES mem.verified_objects,material_id uuid NOT NULL,version_id uuid NOT NULL REFERENCES mem.content_versions,sha256 text NOT NULL,source_context_id uuid,actor_id uuid NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE mem.gc_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),object_id uuid NOT NULL REFERENCES mem.gc_objects,project_id uuid NOT NULL,actor_id uuid NOT NULL,client_id uuid NOT NULL,idempotency_key text NOT NULL,fingerprint text NOT NULL,material_id uuid NOT NULL,expected_head uuid,expected_content_revision bigint NOT NULL,expected_event_revision bigint NOT NULL,actor_context jsonb NOT NULL,judgment jsonb NOT NULL DEFAULT '{}',revision bigint,coverage_revision bigint,scan jsonb,state text NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','ready','held','sealed','succeeded','failed','unknown')),locator jsonb NOT NULL,locators jsonb NOT NULL,remaining_locators jsonb,execution_token uuid,lease_until timestamptz,receipt jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(actor_id,idempotency_key));
CREATE TABLE mem.gc_attempts(plan_id uuid PRIMARY KEY REFERENCES mem.gc_plans,execution_token uuid NOT NULL UNIQUE,started_at timestamptz NOT NULL DEFAULT clock_timestamp(),outcome text,receipt jsonb,finished_at timestamptz);
-- Explicit schema contracts. Text observations are facts, never byte dependencies.
CREATE TABLE mem.gc_schema_contracts(schema_name text PRIMARY KEY,purpose text NOT NULL CHECK(purpose IN('byte_sources','infrastructure')));
INSERT INTO mem.gc_schema_contracts VALUES('mem','byte_sources'),('v8','byte_sources'),('evidence','byte_sources'),('coord','byte_sources'),('jobs','byte_sources'),('authz','infrastructure'),('authn','infrastructure'),('public','infrastructure'),('db_secrets','infrastructure'),('worker_queue','infrastructure');
CREATE TABLE mem.gc_reference_contracts(schema_name text NOT NULL,table_name text NOT NULL,kind text NOT NULL CHECK(kind IN('reference','mutation','ledger','none')),uuid_fields text[] NOT NULL DEFAULT '{}',json_fields text[] NOT NULL DEFAULT '{}',shape_hash text NOT NULL DEFAULT '',PRIMARY KEY(schema_name,table_name));
INSERT INTO mem.gc_reference_contracts(schema_name,table_name,kind,uuid_fields)
 SELECT n.nspname,t.relname,CASE WHEN count(a.attname)>0 THEN 'reference'ELSE 'none'END,coalesce(array_agg(DISTINCT a.attname::text)FILTER(WHERE a.attname IS NOT NULL),'{}')
 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
 LEFT JOIN pg_constraint fk ON fk.conrelid=t.oid AND fk.contype='f'AND fk.confrelid IN('mem.materials'::regclass,'mem.content_versions'::regclass,'mem.verified_objects'::regclass)
 LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=ANY(fk.conkey)AND a.atttypid='uuid'::regtype
 WHERE n.nspname IN('mem','v8','evidence','coord','jobs')AND t.relkind IN('r','p')AND NOT t.relispartition AND t.relname NOT LIKE 'gc_%'GROUP BY n.nspname,t.relname;
UPDATE mem.gc_reference_contracts SET kind='ledger',uuid_fields='{}'WHERE
 schema_name='evidence' OR(schema_name='mem'AND table_name IN('placements','read_receipts','command_receipts','text_index','vector_embeddings','invalidations','stale_versions','object_observations','object_storage_state','field_effects','field_last_effect','causal_operations','causal_transaction','batch_item_outcomes','batch_operations','agent_description_heads','agent_description_revisions','agent_description_vectors','processing_attempt_history','material_equivalence_judgments','material_alias_heads','snapshots'))OR(schema_name='v8'AND table_name IN('operations','work_snapshots','read_projections','context_manifests','context_views','work_read_receipts','work_updates','impact_judgments'))OR(schema_name='jobs'AND table_name IN('attempts','maintenance_plans'));
UPDATE mem.gc_reference_contracts SET kind='mutation',uuid_fields='{}'WHERE schema_name='v8'AND table_name='context_manifests';
UPDATE mem.gc_reference_contracts SET kind='mutation',uuid_fields=ARRAY['id','current_version_id']WHERE schema_name='mem'AND table_name='materials';
UPDATE mem.gc_reference_contracts SET kind='mutation',uuid_fields=ARRAY['object_id','material_id']WHERE schema_name='mem'AND table_name IN('operations','content_versions','fixed_object_copies');
UPDATE mem.gc_reference_contracts SET kind='reference',uuid_fields='{}',json_fields=ARRAY['inputs','outputs']WHERE schema_name='mem'AND table_name='processing_runs';
UPDATE mem.gc_reference_contracts SET kind='reference',uuid_fields=ARRAY['input_version_id'],json_fields='{}'WHERE schema_name='mem'AND table_name='source_edges';
UPDATE mem.gc_reference_contracts SET kind='reference',uuid_fields='{}',json_fields=ARRAY['body']WHERE schema_name='mem'AND table_name='text_drafts';
UPDATE mem.gc_reference_contracts SET kind='reference',uuid_fields=ARRAY['output_version_id'],json_fields=ARRAY['actual_source_closure']WHERE schema_name='mem'AND table_name='disclosures';
UPDATE mem.gc_reference_contracts SET kind='reference',uuid_fields=ARRAY['target_version_id','target_material_id']WHERE schema_name='v8'AND table_name='legacy_references';
UPDATE mem.gc_reference_contracts SET kind='reference',json_fields=ARRAY['manifest']WHERE schema_name='coord'AND table_name='writer_preparations';
UPDATE mem.gc_reference_contracts SET kind='reference',json_fields=ARRAY['payload']WHERE schema_name='jobs'AND table_name='tasks';
CREATE FUNCTION mem.gc_relation_shape(relation oid)RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT md5(coalesce((SELECT string_agg(attname||':'||atttypid::text||':'||attnotnull::text,','ORDER BY attnum)FROM pg_attribute WHERE attrelid=relation AND attnum>0 AND NOT attisdropped),'')||coalesce((SELECT string_agg(pg_get_constraintdef(oid),','ORDER BY conname)FROM pg_constraint WHERE conrelid=relation),'')||coalesce((SELECT string_agg(polname||':'||pg_get_expr(polqual,polrelid)||':'||polroles::text,','ORDER BY polname)FROM pg_policy WHERE polrelid=relation),''))
$$;
REVOKE ALL ON FUNCTION mem.gc_relation_shape(oid)FROM PUBLIC;
UPDATE mem.gc_reference_contracts rc SET shape_hash=mem.gc_relation_shape(c.oid)FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE rc.schema_name=n.nspname AND rc.table_name=c.relname;
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY['evidence']WHERE schema_name='v8'AND table_name='experiences';
-- These fields represent declared fixed references only. Strings are not searched.
CREATE FUNCTION mem.gc_reference_keys(value jsonb)RETURNS SETOF text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,mem AS $$
DECLARE part jsonb;key text;id text;storage_locator boolean;
BEGIN
 IF jsonb_typeof(value)='object'THEN
  storage_locator:=value->>'provider'IS NOT NULL AND value->>'bucket'IS NOT NULL AND coalesce(value->>'object_key',value->>'key')IS NOT NULL AND coalesce(value->>'provider_version_id',value->>'version_id',value->>'versionId')IS NOT NULL;
  FOR key IN SELECT unnest(ARRAY['object_id','version_id','input_version_id','source_version_id','target_version_id','base_version_id'])LOOP IF key='version_id'AND storage_locator THEN CONTINUE;END IF;id:=value->>key;IF id~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'THEN RETURN NEXT 'uuid:'||id;END IF;END LOOP;
  IF value->>'provider'IS NOT NULL AND value->>'bucket'IS NOT NULL AND coalesce(value->>'object_key',value->>'key')IS NOT NULL AND coalesce(value->>'provider_version_id',value->>'version_id',value->>'versionId')IS NOT NULL THEN RETURN NEXT 'locator:'||jsonb_build_array(value->>'provider',value->>'bucket',coalesce(value->>'object_key',value->>'key'),coalesce(value->>'provider_version_id',value->>'version_id',value->>'versionId'))::text;END IF;
  FOR key IN SELECT unnest(ARRAY['fixed_ref','fixed_refs','inputs','outputs','source_refs','sources','actual_inputs','actual_source_closure','items','references','object','locator','locators','source','manifest'])LOOP IF value?key THEN RETURN QUERY SELECT * FROM mem.gc_reference_keys(value->key);END IF;END LOOP;
 ELSIF jsonb_typeof(value)='array'THEN
  FOR part IN SELECT * FROM jsonb_array_elements(value)LOOP
   IF jsonb_typeof(part)='string'AND (part#>>'{}')~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'THEN RETURN NEXT 'uuid:'||(part#>>'{}');ELSE RETURN QUERY SELECT * FROM mem.gc_reference_keys(part);END IF;
  END LOOP;
 END IF;
END $$;
CREATE FUNCTION mem.gc_fact_keys(sch text,tbl text,rowvalue jsonb)RETURNS SETOF text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE contract mem.gc_reference_contracts;field text;id text;hasversion boolean:=false;
BEGIN
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
END $$;
REVOKE ALL ON FUNCTION mem.gc_reference_keys(jsonb),mem.gc_fact_keys(text,text,jsonb)FROM PUBLIC;
-- Trigger-backed object fence: references added after a complete scan invalidate its CAS;
-- once sealed, the permanent fence survives crashes, expired leases and unknown cloud outcomes.
CREATE FUNCTION mem.gc_reference_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE g mem.gc_objects;refkey text;keys text[];
BEGIN
 -- Editing metadata or a note on a tombstone does not revive its bytes.
 IF TG_TABLE_SCHEMA='mem'AND TG_TABLE_NAME='materials'AND TG_OP='UPDATE'THEN IF(NEW.state,NEW.current_version_id,NEW.content_revision)IS NOT DISTINCT FROM(OLD.state,OLD.current_version_id,OLD.content_revision)THEN RETURN NEW;END IF;END IF;
 SELECT array_agg(DISTINCT k ORDER BY k)INTO keys FROM mem.gc_fact_keys(TG_TABLE_SCHEMA,TG_TABLE_NAME,to_jsonb(NEW))k;
 IF keys IS NULL THEN RETURN NEW;END IF;
 FOREACH refkey IN ARRAY keys LOOP PERFORM pg_advisory_xact_lock(hashtextextended('mem.gc.fact:'||refkey,0));END LOOP;
 FOR g IN SELECT * FROM mem.gc_objects WHERE 'uuid:'||object_id=ANY(keys)OR 'uuid:'||material_id=ANY(keys)OR EXISTS(SELECT FROM mem.content_versions cv WHERE cv.object_id=gc_objects.object_id AND 'uuid:'||cv.id=ANY(keys))OR EXISTS(SELECT FROM(SELECT provider,bucket,object_key,provider_version_id FROM mem.verified_objects WHERE id=gc_objects.object_id UNION ALL SELECT provider,bucket,object_key,provider_version_id FROM mem.fixed_object_copies WHERE object_id=gc_objects.object_id)obj WHERE 'locator:'||jsonb_build_array(obj.provider,obj.bucket,obj.object_key,obj.provider_version_id)::text=ANY(keys))ORDER BY object_id FOR UPDATE LOOP
  IF g.state<>'open'THEN RAISE EXCEPTION 'gc_object_sealed' USING ERRCODE='55000';END IF;
  UPDATE mem.gc_objects SET revision=revision+1 WHERE object_id=g.object_id;
 END LOOP;RETURN NEW;
END $$;
CREATE FUNCTION mem.gc_recovery_fence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE g mem.gc_objects;
BEGIN
 IF TG_TABLE_NAME='gc_restore_protections'THEN IF NEW.retain_until<=clock_timestamp()THEN RETURN NEW;END IF;END IF;
 FOR g IN SELECT * FROM mem.gc_objects WHERE project_id=NEW.project_id ORDER BY object_id FOR UPDATE LOOP
  IF g.state<>'open' THEN
   IF TG_TABLE_NAME='gc_restore_protections'THEN IF NEW.object_id IS NULL OR NEW.object_id=g.object_id THEN RAISE EXCEPTION 'gc_object_sealed_restore_protection_rejected' USING ERRCODE='55000';END IF;END IF;
   CONTINUE;
  END IF;
  UPDATE mem.gc_objects SET revision=revision+1 WHERE object_id=g.object_id;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER gc_use_fence BEFORE INSERT OR UPDATE ON mem.gc_use_leases FOR EACH ROW EXECUTE FUNCTION mem.gc_reference_fence();
CREATE TRIGGER gc_restore_fence BEFORE INSERT OR UPDATE ON mem.gc_restore_protections FOR EACH ROW EXECUTE FUNCTION mem.gc_recovery_fence();
CREATE TRIGGER gc_coverage_fence BEFORE INSERT OR UPDATE ON mem.gc_restore_coverage FOR EACH ROW EXECUTE FUNCTION mem.gc_recovery_fence();
CREATE FUNCTION mem.gc_plan(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;o mem.operations;obj mem.verified_objects;p mem.gc_plans;m mem.materials;v mem.content_versions;refkey text;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.delete',d,b);
 IF b->>'operation_id'IS NOT NULL THEN
  IF b->>'material_id'IS NOT NULL OR b->>'target_version_id'IS NOT NULL THEN RAISE EXCEPTION 'gc_selector_ambiguous';END IF;
  SELECT * INTO o FROM mem.operations WHERE id=(b->>'operation_id')::uuid AND project_id=(c->>'project_id')::uuid;
 ELSE
  SELECT * INTO m FROM mem.materials WHERE id=(b->>'material_id')::uuid AND project_id=(c->>'project_id')::uuid;
  SELECT * INTO v FROM mem.content_versions WHERE material_id=m.id AND id=coalesce((b->>'target_version_id')::uuid,m.current_version_id);
  o.project_id:=m.project_id;o.material_id:=m.id;o.object_id:=v.object_id;
 END IF;
 IF o.object_id IS NULL THEN RAISE EXCEPTION 'verified_candidate_required';END IF;
 SELECT * INTO obj FROM mem.verified_objects WHERE id=o.object_id;SELECT * INTO m FROM mem.materials WHERE id=o.material_id;
 FOR refkey IN SELECT DISTINCT k FROM(SELECT 'uuid:'||obj.id::text k UNION ALL SELECT 'uuid:'||m.id::text UNION ALL SELECT 'uuid:'||id::text FROM mem.content_versions WHERE object_id=obj.id UNION ALL SELECT x FROM mem.gc_reference_keys(jsonb_build_array(to_jsonb(obj))||coalesce((SELECT jsonb_agg(to_jsonb(cp))FROM mem.fixed_object_copies cp WHERE object_id=obj.id),'[]'))x)q ORDER BY k LOOP PERFORM pg_advisory_xact_lock(hashtextextended('mem.gc.fact:'||refkey,0));END LOOP;
 INSERT INTO mem.gc_objects(object_id,project_id,material_id)VALUES(obj.id,o.project_id,o.material_id)ON CONFLICT DO NOTHING;
 IF EXISTS(SELECT FROM mem.gc_objects WHERE object_id=obj.id AND(project_id<>o.project_id OR material_id<>o.material_id))THEN RAISE EXCEPTION 'gc_fixed_object_other_owner_protected';END IF;
 SELECT * INTO p FROM mem.gc_plans WHERE actor_id=(c->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key';
 IF FOUND THEN IF p.fingerprint<>d THEN RAISE EXCEPTION 'idempotency_conflict';END IF;PERFORM authz.assert_effect(h);RETURN to_jsonb(p);END IF;
 PERFORM authz.assert_effect(h);
 INSERT INTO mem.gc_plans(object_id,project_id,actor_id,client_id,idempotency_key,fingerprint,material_id,expected_head,expected_content_revision,expected_event_revision,actor_context,judgment,locator,locators)VALUES(obj.id,o.project_id,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,b->>'idempotency_key',d,m.id,m.current_version_id,m.content_revision,m.event_revision,c,coalesce(b->'judgment','{}'),jsonb_build_object('provider',obj.provider,'bucket',obj.bucket,'key',obj.object_key,'version_id',obj.provider_version_id),jsonb_build_array(jsonb_build_object('provider',obj.provider,'bucket',obj.bucket,'key',obj.object_key,'version_id',obj.provider_version_id))||coalesce((SELECT jsonb_agg(jsonb_build_object('provider',provider,'bucket',bucket,'key',object_key,'version_id',provider_version_id)ORDER BY id)FROM mem.fixed_object_copies WHERE object_id=obj.id),'[]'))RETURNING * INTO p;
 PERFORM authz.assert_effect(h);RETURN to_jsonb(p)||jsonb_build_object('irreversible',true,'deletion_performed',false,'next_step','complete_database_and_recovery_scan');
END $$;
CREATE FUNCTION mem.gc_catalog()RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
 SELECT md5(coalesce((SELECT string_agg(nspname,','ORDER BY nspname)FROM pg_namespace WHERE nspname!~'^pg_'AND nspname<>'information_schema'),'')||coalesce((SELECT string_agg(to_jsonb(x)::text,','ORDER BY schema_name)FROM mem.gc_schema_contracts x),'')||pg_get_functiondef('mem.gc_fact_keys(text,text,jsonb)'::regprocedure)||pg_get_functiondef('mem.gc_reference_keys(jsonb)'::regprocedure)||coalesce((SELECT string_agg(to_jsonb(x)::text,','ORDER BY schema_name,table_name)FROM mem.gc_reference_contracts x),'')||coalesce(string_agg(n.nspname||'.'||c.relname||':'||c.oid::text||':'||mem.gc_relation_shape(c.oid)||':'||coalesce((SELECT t.tgfoid::text||t.tgenabled::text FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='gc_reference_fence'),'missing'),','ORDER BY n.nspname,c.relname),'')) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (n.nspname IN('mem','v8','evidence','coord','jobs')OR EXISTS(SELECT FROM pg_constraint f WHERE f.conrelid=c.oid AND f.contype='f'AND f.confrelid IN('mem.materials'::regclass,'mem.content_versions'::regclass,'mem.verified_objects'::regclass)))AND c.relkind IN('r','p')AND NOT c.relispartition AND c.relname NOT LIKE 'gc_%'
$$;
REVOKE ALL ON FUNCTION mem.gc_catalog()FROM PUBLIC;
-- Full native relational scan, no index/search/pagination inference. Run without a held object lock.
CREATE FUNCTION mem.gc_scan(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;p mem.gc_plans;g mem.gc_objects;r record;n bigint;total bigint:=0;scanned jsonb:='[]';cov mem.gc_restore_coverage;rev bigint;reason text;m mem.materials;refs text[];catalog text;reference_complete boolean:=true;recovery_complete boolean:=true;unknown_reasons jsonb:='[]';
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;c:=mem.guard(h,'mem.delete',d,b);
 SELECT * INTO p FROM mem.gc_plans WHERE id=(b->>'plan_id')::uuid AND actor_id=(c->>'actor_id')::uuid AND project_id=(c->>'project_id')::uuid;
 IF p.id IS NULL OR p.state NOT IN('prepared','ready','held')THEN RAISE EXCEPTION 'gc_plan_state_conflict';END IF;
 SELECT revision INTO rev FROM mem.gc_objects WHERE object_id=p.object_id;catalog:=mem.gc_catalog();
 IF EXISTS(SELECT FROM pg_namespace n WHERE n.nspname!~'^pg_'AND n.nspname<>'information_schema'AND NOT EXISTS(SELECT FROM mem.gc_schema_contracts WHERE schema_name=n.nspname))THEN reason:='reference_schema_unknown';reference_complete:=false;unknown_reasons:=unknown_reasons||jsonb_build_array(reason);END IF;
 -- Own version/history facts survive as tombstones; reuse by another material protects bytes.
 SELECT * INTO m FROM mem.materials WHERE id=p.material_id;
 SELECT count(*) INTO total FROM mem.content_versions WHERE object_id=p.object_id AND material_id<>p.material_id;
 IF EXISTS(SELECT FROM mem.verified_objects vo CROSS JOIN jsonb_array_elements(p.locators)t WHERE vo.id<>p.object_id AND vo.provider=t->>'provider'AND vo.bucket=t->>'bucket'AND vo.object_key=t->>'key'AND vo.provider_version_id=t->>'version_id')OR EXISTS(SELECT FROM mem.fixed_object_copies cp CROSS JOIN jsonb_array_elements(p.locators)t WHERE cp.object_id<>p.object_id AND cp.provider=t->>'provider'AND cp.bucket=t->>'bucket'AND cp.object_key=t->>'key'AND cp.provider_version_id=t->>'version_id')THEN total:=total+1;END IF;
 IF EXISTS(SELECT FROM mem.content_versions WHERE object_id=p.object_id)AND m.state<>'trashed' THEN total:=total+1;END IF;
 SELECT array_agg(id::text)INTO refs FROM mem.content_versions WHERE object_id=p.object_id;refs:=coalesce(refs,'{}')||ARRAY[p.object_id::text];
 IF EXISTS(SELECT FROM mem.operations WHERE object_id=p.object_id AND (material_id<>p.material_id OR state NOT IN('published','cancelled','expired','rejected','conflict') OR lease_until>clock_timestamp()))THEN total:=total+1;END IF;
 refs:=ARRAY['uuid:'||p.object_id::text]||coalesce((SELECT array_agg('uuid:'||id::text)FROM mem.content_versions WHERE object_id=p.object_id),'{}')||coalesce((SELECT array_agg('locator:'||jsonb_build_array(t->>'provider',t->>'bucket',t->>'key',t->>'version_id')::text)FROM jsonb_array_elements(p.locators)t),'{}');
 FOR r IN SELECT n.nspname,c.relname,c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (n.nspname IN('mem','v8','evidence','coord','jobs')OR EXISTS(SELECT FROM pg_constraint f WHERE f.conrelid=c.oid AND f.contype='f'AND f.confrelid IN('mem.materials'::regclass,'mem.content_versions'::regclass,'mem.verified_objects'::regclass)))AND c.relkind IN('r','p')AND NOT c.relispartition AND c.relname NOT LIKE 'gc_%'ORDER BY 1,2 LOOP
  IF NOT EXISTS(SELECT FROM mem.gc_reference_contracts WHERE schema_name=r.nspname AND table_name=r.relname AND shape_hash=mem.gc_relation_shape(r.oid))THEN reason:='reference_contract_unknown';reference_complete:=false;unknown_reasons:=unknown_reasons||jsonb_build_array(reason||':'||r.nspname||'.'||r.relname);CONTINUE;END IF;
  IF NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid=r.oid AND tgname='gc_reference_fence'AND tgenabled IN('O','A'))AND EXISTS(SELECT FROM mem.gc_reference_contracts WHERE schema_name=r.nspname AND table_name=r.relname AND kind IN('reference','mutation'))THEN reason:='reference_fence_missing';reference_complete:=false;unknown_reasons:=unknown_reasons||jsonb_build_array(reason||':'||r.nspname||'.'||r.relname);END IF;
  IF NOT EXISTS(SELECT FROM mem.gc_reference_contracts WHERE schema_name=r.nspname AND table_name=r.relname AND kind='reference')THEN CONTINUE;END IF;
  EXECUTE format($scan$SELECT count(*)FROM %I.%I t WHERE EXISTS(SELECT FROM mem.gc_fact_keys($1,$2,to_jsonb(t))k WHERE k=ANY($3))$scan$,r.nspname,r.relname)INTO n USING r.nspname,r.relname,refs;
  total:=total+n;scanned:=scanned||jsonb_build_array(jsonb_build_object('table',r.nspname||'.'||r.relname,'references',n,'contract','typed_reference_fields'));
 END LOOP;
 IF EXISTS(SELECT FROM mem.gc_use_leases WHERE object_id=p.object_id AND expires_at>clock_timestamp())THEN total:=total+1;END IF;
 SELECT * INTO cov FROM mem.gc_restore_coverage WHERE project_id=p.project_id;
 recovery_complete:=cov.project_id IS NOT NULL AND cov.complete AND cov.valid_until>clock_timestamp();
 IF cov.project_id IS NULL OR NOT cov.complete OR cov.valid_until<=clock_timestamp() OR cov.retain_until>clock_timestamp() THEN reason:='recovery_coverage_unknown_or_window_active';END IF;
 IF EXISTS(SELECT FROM mem.gc_restore_protections WHERE project_id=p.project_id AND(object_id=p.object_id OR object_id IS NULL)AND retain_until>clock_timestamp())THEN reason:='restore_manifest_protected';END IF;
 IF total>0 THEN reason:='retained_reference_or_active_operation';END IF;
 -- Short CAS only after scan; trigger writes serialize on this object row.
 SELECT * INTO g FROM mem.gc_objects WHERE object_id=p.object_id FOR UPDATE;
 IF catalog IS DISTINCT FROM mem.gc_catalog()OR g.revision<>rev OR g.state<>'open' OR m.current_version_id IS DISTINCT FROM p.expected_head OR m.content_revision<>p.expected_content_revision OR m.event_revision<>p.expected_event_revision THEN reason:='scan_changed_replan';END IF;
 IF catalog IS DISTINCT FROM mem.gc_catalog()THEN reference_complete:=false;unknown_reasons:=unknown_reasons||jsonb_build_array('reference_catalog_changed');END IF;
 IF NOT reference_complete THEN reason:='reference_coverage_unknown';END IF;
 PERFORM authz.assert_effect(h);
 UPDATE mem.gc_plans SET revision=rev,coverage_revision=cov.revision,scan=jsonb_build_object('complete',reference_complete AND recovery_complete,'coverage_complete',reference_complete AND recovery_complete,'reference_coverage_complete',reference_complete,'recovery_coverage_complete',recovery_complete,'unknown',unknown_reasons,'next_step',CASE WHEN NOT reference_complete THEN 'complete_reference_contract_and_fence_then_rescan'WHEN NOT recovery_complete THEN 'register_current_complete_recovery_inventory_then_rescan'ELSE 'inspect_retained_references_or_seal_with_independent_authority'END,'catalog',catalog,'tables',scanned,'references',total,'reason',reason),state=CASE WHEN reason IS NULL THEN 'ready' ELSE 'held' END WHERE id=p.id RETURNING * INTO p;
 PERFORM authz.assert_effect(h);RETURN to_jsonb(p)||jsonb_build_object('deletion_performed',false);
END $$;
CREATE FUNCTION mem.gc_destroy(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;p mem.gc_plans;g mem.gc_objects;cov mem.gc_restore_coverage;m mem.materials;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;c:=mem.guard(h,'mem.destroy',d,b);
 SELECT * INTO p FROM mem.gc_plans WHERE id=(b->>'plan_id')::uuid AND actor_id=(c->>'actor_id')::uuid AND client_id=(c->>'client_id')::uuid AND project_id=(c->>'project_id')::uuid FOR UPDATE;
 IF p.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF p.state IN('sealed','succeeded','failed','unknown')THEN PERFORM authz.assert_effect(h);RETURN to_jsonb(p);END IF;
 SELECT * INTO m FROM mem.materials WHERE id=p.material_id FOR UPDATE;
 SELECT * INTO g FROM mem.gc_objects WHERE object_id=p.object_id FOR UPDATE;
 SELECT * INTO cov FROM mem.gc_restore_coverage WHERE project_id=p.project_id;
 IF b->'irreversible_confirmed' IS DISTINCT FROM 'true'::jsonb OR m.current_version_id IS DISTINCT FROM p.expected_head OR m.content_revision<>p.expected_content_revision OR m.event_revision<>p.expected_event_revision OR(EXISTS(SELECT FROM mem.content_versions WHERE object_id=p.object_id)AND m.state<>'trashed')OR p.scan->>'catalog'IS DISTINCT FROM mem.gc_catalog()OR p.state<>'ready' OR g.state<>'open' OR p.revision IS DISTINCT FROM g.revision OR cov.revision IS DISTINCT FROM p.coverage_revision OR NOT cov.complete OR cov.valid_until<=clock_timestamp()OR cov.retain_until>clock_timestamp()OR EXISTS(SELECT FROM mem.gc_use_leases WHERE object_id=p.object_id AND expires_at>clock_timestamp())OR EXISTS(SELECT FROM mem.gc_restore_protections WHERE project_id=p.project_id AND(object_id=p.object_id OR object_id IS NULL)AND retain_until>clock_timestamp())THEN RAISE EXCEPTION 'gc_destroy_precondition_changed' USING ERRCODE='40001';END IF;
 PERFORM authz.assert_effect(h);
 UPDATE mem.gc_objects SET state='sealed',sealed_at=clock_timestamp(),revision=revision+1 WHERE object_id=p.object_id;
 UPDATE mem.gc_plans SET state='sealed',execution_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes'WHERE id=p.id RETURNING * INTO p;
 PERFORM mem.emit(c,'gc.destroy.accepted',p.execution_token,1,p.id,jsonb_build_object('plan_id',p.id,'object_id',p.object_id,'material_id',p.material_id,'locators',p.locators,'state','sealed','irreversible',true));
 RETURN to_jsonb(p)||jsonb_build_object('irreversible',true,'deletion_performed',false,'next_step','dedicated_executor_exact_version_delete');
END $$;
-- Exactly one dispatch ever. Lease expiry cannot release a cloud deletion in flight.
CREATE FUNCTION mem.gc_dispatch(plan uuid,token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE p mem.gc_plans;
BEGIN
 SELECT * INTO p FROM mem.gc_plans WHERE id=plan FOR UPDATE;
 IF p.id IS NULL OR p.execution_token IS DISTINCT FROM token OR p.state<>'sealed'OR p.lease_until<=clock_timestamp()THEN RAISE EXCEPTION 'gc_dispatch_fenced';END IF;
 INSERT INTO mem.gc_attempts(plan_id,execution_token)VALUES(p.id,token)ON CONFLICT(plan_id,execution_token)DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'gc_already_dispatched_reconcile_only';END IF;
 RETURN jsonb_build_object('plan_id',p.id,'execution_token',token,'locator',p.locator,'locators',coalesce(p.remaining_locators,p.locators),'lease_until',p.lease_until);
END $$;
CREATE FUNCTION mem.gc_outcome_event(p mem.gc_plans,revision bigint)RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,mem AS $$
DECLARE result jsonb:=jsonb_build_object('plan_id',p.id,'object_id',p.object_id,'material_id',p.material_id,'state',p.state,'receipt',p.receipt,'irreversible',true);
BEGIN INSERT INTO evidence.audit(actor_id,client_id,source_context_id,domain,action,aggregate_id,revision,operation_id,details)VALUES(p.actor_id,p.client_id,(p.actor_context->>'source_context_id')::uuid,'mem','gc.destroy.'||p.state,p.execution_token,revision,p.id,result);INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload)VALUES('mem',p.execution_token,revision,'gc.destroy.'||p.state,p.project_id,result);END $$;
REVOKE ALL ON FUNCTION mem.gc_outcome_event(mem.gc_plans,bigint)FROM PUBLIC;
CREATE FUNCTION mem.gc_finish(plan uuid,token uuid,outcome text,receipt jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE p mem.gc_plans;a mem.gc_attempts;
BEGIN
 IF outcome NOT IN('succeeded','failed','unknown')OR receipt IS NULL OR jsonb_typeof(receipt)<>'object'THEN RAISE EXCEPTION 'gc_receipt_invalid';END IF;
 SELECT * INTO p FROM mem.gc_plans WHERE id=plan FOR UPDATE;
 IF outcome='succeeded'AND(jsonb_typeof(receipt->'effects')IS DISTINCT FROM 'array'OR jsonb_array_length(receipt->'effects')<>jsonb_array_length(coalesce(p.remaining_locators,p.locators))OR EXISTS(SELECT FROM jsonb_array_elements(coalesce(p.remaining_locators,p.locators))l WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(receipt->'effects')e WHERE e->'locator'=l AND e->'exact_version'='true'::jsonb AND length(e->>'request_id')>0)))THEN RAISE EXCEPTION 'gc_success_receipt_incomplete';END IF;
 SELECT * INTO a FROM mem.gc_attempts WHERE plan_id=plan AND execution_token=token;
 IF p.id IS NULL OR p.execution_token IS DISTINCT FROM token OR a.execution_token IS DISTINCT FROM token THEN RAISE EXCEPTION 'gc_receipt_fenced';END IF;
 IF p.receipt IS NOT NULL THEN IF p.state=outcome AND p.receipt=receipt THEN RETURN to_jsonb(p);END IF;RAISE EXCEPTION 'gc_receipt_conflict_reconcile_required';END IF;
 -- Late provider receipts are recorded, even after expiry; they never authorize another delete.
 UPDATE mem.gc_attempts SET outcome=gc_finish.outcome,receipt=gc_finish.receipt,finished_at=clock_timestamp()WHERE plan_id=plan AND execution_token=token;
 UPDATE mem.gc_plans SET state=outcome,receipt=gc_finish.receipt WHERE id=plan RETURNING * INTO p;
 PERFORM mem.gc_outcome_event(p,2);
 IF outcome='succeeded'THEN UPDATE mem.gc_objects SET state='deleted'WHERE object_id=p.object_id;UPDATE mem.verified_objects SET availability='unavailable'WHERE id=p.object_id;END IF;
 RETURN to_jsonb(p);
END $$;
CREATE FUNCTION mem.gc_status(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;p mem.gc_plans;
BEGIN IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;c:=mem.guard(h,'mem.delete',d,b);SELECT * INTO p FROM mem.gc_plans WHERE id=(b->>'plan_id')::uuid AND project_id=(c->>'project_id')::uuid AND actor_id=(c->>'actor_id')::uuid;IF p.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;PERFORM authz.assert_effect(h);RETURN to_jsonb(p)||jsonb_build_object('attempts',coalesce((SELECT jsonb_agg(to_jsonb(a)ORDER BY started_at)FROM mem.gc_attempts a WHERE plan_id=p.id),'[]'),'reconcile_required',p.state='unknown'OR(p.state='sealed'AND p.lease_until<=clock_timestamp()));END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA mem FROM hub2_gc_executor;
REVOKE ALL ON FUNCTION mem.gc_reference_fence(),mem.gc_recovery_fence(),mem.gc_plan(uuid,text,text),mem.gc_scan(uuid,text,text),mem.gc_destroy(uuid,text,text),mem.gc_status(uuid,text,text),mem.gc_dispatch(uuid,uuid),mem.gc_finish(uuid,uuid,text,jsonb)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.gc_plan(uuid,text,text),mem.gc_scan(uuid,text,text),mem.gc_destroy(uuid,text,text),mem.gc_status(uuid,text,text)TO hub2_mem;
GRANT EXECUTE ON FUNCTION mem.gc_dispatch(uuid,uuid),mem.gc_finish(uuid,uuid,text,jsonb)TO hub2_gc_executor;
RESET ROLE;
-- Source domains may only invoke the object fence; no direct GC table grant.
DO $$DECLARE r record;BEGIN FOR r IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (n.nspname IN('mem','v8','evidence','coord','jobs')OR EXISTS(SELECT FROM pg_constraint f WHERE f.conrelid=c.oid AND f.contype='f'AND f.confrelid IN('mem.materials'::regclass,'mem.content_versions'::regclass,'mem.verified_objects'::regclass)))AND c.relkind IN('r','p')AND NOT c.relispartition AND c.relname NOT LIKE 'gc_%'AND NOT(n.nspname='evidence'AND c.relname IN('audit','outbox','field_usage','projection','property_snapshots','usage_reports','logical_requests','transport_recovery_receipts'))AND NOT(n.nspname='mem'AND c.relname IN('verified_objects','field_effects','field_last_effect','causal_transaction'))LOOP EXECUTE format('CREATE TRIGGER gc_reference_fence BEFORE INSERT OR UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION mem.gc_reference_fence()',r.nspname,r.relname);END LOOP;END $$;

DO $$DECLARE r record;BEGIN FOR r IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('v8','evidence','coord','jobs')AND c.relkind IN('r','p')LOOP EXECUTE format('GRANT USAGE ON SCHEMA %I TO hub2_mem_owner',r.nspname);EXECUTE format('GRANT SELECT ON %I.%I TO hub2_mem_owner',r.nspname,r.relname);END LOOP;END $$;

DO $$DECLARE r record;body text;BEGIN FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz'AND p.prosrc LIKE '%p_action NOT IN%mem.delete%'LOOP body:=pg_get_functiondef(r.oid);body:=replace(body,'''mem.delete'',''mem.share''','''mem.delete'',''mem.destroy'',''mem.share''');EXECUTE body;END LOOP;END $$;
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.gc_reconcile(plan uuid,token uuid,proof jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE p mem.gc_plans;
BEGIN
 SELECT * INTO p FROM mem.gc_plans WHERE id=plan FOR UPDATE;
 IF p.id IS NULL OR p.execution_token IS DISTINCT FROM token OR proof->'locator'IS DISTINCT FROM p.locator OR(coalesce(jsonb_array_length(p.locators),1)>1 AND proof->'locators'IS DISTINCT FROM p.locators)OR proof->'scan_complete'IS DISTINCT FROM 'true'::jsonb OR proof->>'method'<>'authenticated_ListObjectVersions_all_pages'OR p.state NOT IN('sealed','unknown','failed')OR NOT EXISTS(SELECT FROM mem.gc_attempts WHERE plan_id=p.id AND execution_token=token)THEN RAISE EXCEPTION 'gc_reconciliation_rejected';END IF;
 IF proof->'present'='false'::jsonb THEN UPDATE mem.gc_plans SET state='succeeded',receipt=jsonb_build_object('previous_receipt',receipt,'reconciliation',proof)WHERE id=p.id RETURNING * INTO p;UPDATE mem.gc_objects SET state='deleted'WHERE object_id=p.object_id;UPDATE mem.verified_objects SET availability='unavailable'WHERE id=p.object_id;END IF;
 IF proof->'present'='false'::jsonb THEN PERFORM mem.gc_outcome_event(p,3);END IF;
 RETURN to_jsonb(p)||jsonb_build_object('permanent_fence_retained',true,'automatic_retry',false);
END $$;
REVOKE ALL ON FUNCTION mem.gc_reconcile(uuid,uuid,jsonb)FROM PUBLIC;GRANT EXECUTE ON FUNCTION mem.gc_reconcile(uuid,uuid,jsonb)TO hub2_gc_executor;
RESET ROLE;
SET ROLE hub2_mem_owner;
-- A source read owns a bounded lease; never require an acknowledgement as a condition for ordinary work.
CREATE FUNCTION mem.gc_read_use() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE v mem.content_versions;m mem.materials;
BEGIN
 SELECT * INTO v FROM mem.content_versions WHERE id=NEW.version_id;SELECT * INTO m FROM mem.materials WHERE id=v.material_id;
 INSERT INTO mem.gc_use_leases(id,project_id,object_id,material_id,version_id,sha256,actor_id,expires_at)VALUES(NEW.id,m.project_id,v.object_id,m.id,v.id,v.sha256,NEW.actor_id,clock_timestamp()+interval '15 minutes');RETURN NEW;
END $$;
CREATE TRIGGER gc_read_use AFTER INSERT ON mem.read_receipts FOR EACH ROW EXECUTE FUNCTION mem.gc_read_use();
REVOKE ALL ON FUNCTION mem.gc_read_use()FROM PUBLIC;
RESET ROLE;
-- Dedicated recovery inventory importer, separate from destroy client and executor.
CREATE ROLE hub2_gc_recovery NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA mem TO hub2_gc_recovery;
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.gc_restore_register(project uuid,complete boolean,retain_until timestamptz,valid_until timestamptz,manifest jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
BEGIN
 IF manifest IS NULL OR jsonb_typeof(manifest)<>'object'OR jsonb_typeof(manifest->'protected_objects')IS DISTINCT FROM 'array'OR valid_until<=clock_timestamp()OR NOT isfinite(valid_until)OR manifest->>'inventory_source'IS NULL THEN RAISE EXCEPTION 'gc_recovery_inventory_invalid';END IF;
 INSERT INTO mem.gc_restore_coverage(project_id,complete,retain_until,valid_until,manifest)VALUES(project,complete,retain_until,valid_until,manifest)ON CONFLICT(project_id)DO UPDATE SET complete=EXCLUDED.complete,retain_until=EXCLUDED.retain_until,valid_until=EXCLUDED.valid_until,manifest=EXCLUDED.manifest,revision=gc_restore_coverage.revision+1;
 DELETE FROM mem.gc_restore_protections WHERE project_id=project;
 INSERT INTO mem.gc_restore_protections(project_id,object_id,retain_until,manifest)SELECT project,(v->>'object_id')::uuid,(v->>'retain_until')::timestamptz,v FROM jsonb_array_elements(manifest->'protected_objects')v;
 RETURN jsonb_build_object('state','registered','project_id',project,'complete',complete,'valid_until',valid_until);
END $$;
REVOKE ALL ON FUNCTION mem.gc_restore_register(uuid,boolean,timestamptz,timestamptz,jsonb)FROM PUBLIC;GRANT EXECUTE ON FUNCTION mem.gc_restore_register(uuid,boolean,timestamptz,timestamptz,jsonb)TO hub2_gc_recovery;
GRANT SELECT(id,project_id,material_id)ON mem.gc_plans TO hub2_authz_owner;
RESET ROLE;
DO $$DECLARE body text;BEGIN body:=pg_get_functiondef('authz.resolve_resource(jsonb)'::regprocedure);body:=replace(body,'IF mid IS NULL AND r->>''operation_id'' IS NOT NULL THEN','IF mid IS NULL AND r->>''plan_id'' IS NOT NULL THEN SELECT material_id INTO mid FROM mem.gc_plans WHERE id=(r->>''plan_id'')::uuid AND project_id=pid;END IF; IF mid IS NULL AND r->>''operation_id'' IS NOT NULL THEN');EXECUTE body;END $$;
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.gc_read_lease(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;l mem.gc_use_leases;v mem.content_versions;ttl integer:=coalesce((b->>'ttl_seconds')::integer,900);
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;c:=mem.guard(h,'mem.read',d,b);
 SELECT * INTO l FROM mem.gc_use_leases WHERE id=(b->>'read_receipt_id')::uuid AND actor_id=(c->>'actor_id')::uuid AND project_id=(c->>'project_id')::uuid FOR UPDATE;
 IF l.id IS NULL OR l.material_id IS DISTINCT FROM(b->>'material_id')::uuid OR l.version_id IS DISTINCT FROM(b->>'version_id')::uuid OR(b->>'sha256'IS NOT NULL AND b->>'sha256'<>l.sha256)OR ttl NOT BETWEEN 5 AND 900 OR b->>'command'NOT IN('renew','release')THEN RAISE EXCEPTION 'gc_use_lease_forbidden' USING ERRCODE='42501';END IF;
 IF b->>'command'='renew'AND EXISTS(SELECT FROM mem.gc_objects WHERE object_id=l.object_id AND state<>'open')THEN RAISE EXCEPTION 'gc_object_destroying_or_destroyed' USING ERRCODE='55000';END IF;
 IF b->>'command'='renew'AND l.expires_at<=clock_timestamp()THEN RAISE EXCEPTION 'gc_use_lease_expired_new_read_required';END IF;
 PERFORM authz.assert_effect(h);UPDATE mem.gc_use_leases SET expires_at=CASE WHEN b->>'command'='renew'THEN clock_timestamp()+ttl*interval '1 second'ELSE clock_timestamp()END,source_context_id=(c->>'source_context_id')::uuid WHERE id=l.id RETURNING * INTO l;PERFORM authz.assert_effect(h);RETURN to_jsonb(l)||jsonb_build_object('state',CASE WHEN b->>'command'='renew'THEN 'leased'ELSE 'released'END,'read_receipt_id',l.id,'physical_state',mem.gc_physical_state(l.object_id));
END $$;
CREATE FUNCTION mem.gc_read_release()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
BEGIN IF NEW.state='sent'THEN UPDATE mem.gc_use_leases SET expires_at=clock_timestamp()WHERE id=NEW.id;END IF;RETURN NEW;END $$;
CREATE TRIGGER gc_read_release AFTER UPDATE OF state ON mem.read_receipts FOR EACH ROW EXECUTE FUNCTION mem.gc_read_release();
REVOKE ALL ON FUNCTION mem.gc_read_release(),mem.gc_read_lease(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.gc_read_lease(uuid,text,text)TO hub2_mem;
RESET ROLE;
SET ROLE hub2_mem_owner;
ALTER TABLE mem.gc_attempts DROP CONSTRAINT gc_attempts_pkey;
ALTER TABLE mem.gc_attempts ADD PRIMARY KEY(plan_id,execution_token);
CREATE FUNCTION mem.gc_retry(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;p mem.gc_plans;cov mem.gc_restore_coverage;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;c:=mem.guard(h,'mem.destroy',d,b);
 SELECT * INTO p FROM mem.gc_plans WHERE id=(b->>'plan_id')::uuid AND actor_id=(c->>'actor_id')::uuid AND client_id=(c->>'client_id')::uuid AND project_id=(c->>'project_id')::uuid FOR UPDATE;
 SELECT * INTO cov FROM mem.gc_restore_coverage WHERE project_id=p.project_id;
 IF p.state='sealed'AND p.lease_until<=clock_timestamp()AND NOT EXISTS(SELECT FROM mem.gc_attempts WHERE plan_id=p.id AND execution_token=p.execution_token)THEN p.state:='failed';p.receipt:=jsonb_build_object('code','lease_expired_before_provider_dispatch','deletion_attempted',false);END IF;
 IF p.id IS NULL OR b->'irreversible_confirmed'IS DISTINCT FROM 'true'::jsonb OR p.state<>'failed'OR p.receipt->>'code'NOT IN('provider_denied','lease_expired_before_provider_dispatch') OR NOT cov.complete OR cov.valid_until<=clock_timestamp()OR cov.retain_until>clock_timestamp()THEN RAISE EXCEPTION 'gc_retry_requires_definitive_no_effect_and_current_destroy_authority';END IF;
 PERFORM authz.assert_effect(h);UPDATE mem.gc_plans SET remaining_locators=coalesce((SELECT jsonb_agg(t)FROM jsonb_array_elements(coalesce(p.remaining_locators,p.locators))t WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(coalesce(p.receipt->'effects','[]'))e WHERE e->'locator'=t)),p.locators),state='sealed',execution_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes',receipt=NULL WHERE id=p.id RETURNING * INTO p;PERFORM mem.emit(c,'gc.destroy.accepted',p.execution_token,1,p.id,jsonb_build_object('plan_id',p.id,'object_id',p.object_id,'material_id',p.material_id,'locators',p.locators,'state','sealed','irreversible',true,'retry',true));RETURN to_jsonb(p)||jsonb_build_object('permanent_fence_retained',true,'accepted_irreversible_retry',true);
END $$;
REVOKE ALL ON FUNCTION mem.gc_retry(uuid,text,text)FROM PUBLIC;GRANT EXECUTE ON FUNCTION mem.gc_retry(uuid,text,text)TO hub2_mem;
RESET ROLE;
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.gc_physical_state(object uuid)RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,mem AS $$SELECT coalesce((SELECT CASE state WHEN 'sealed'THEN 'destroying'WHEN 'deleted'THEN 'destroyed'ELSE 'retained'END FROM mem.gc_objects WHERE object_id=object),'retained')$$;
REVOKE ALL ON FUNCTION mem.gc_physical_state(uuid)FROM PUBLIC;GRANT EXECUTE ON FUNCTION mem.gc_physical_state(uuid)TO hub2_mem_owner,hub2_v8_owner;
DO $$DECLARE body text;BEGIN body:=pg_get_functiondef('mem.material_history(uuid,text,text)'::regprocedure);body:=replace(body,'mem.version_stale(id) source_stale,','mem.version_stale(id) source_stale,mem.gc_physical_state(object_id) physical_state,');EXECUTE body;END $$;
RESET ROLE;
DO $$DECLARE r record;BEGIN FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='mem'AND c.relkind='r'AND c.relname LIKE 'gc_%'LOOP EXECUTE format('ALTER TABLE mem.%I ENABLE ROW LEVEL SECURITY',r.relname);EXECUTE format('CREATE POLICY guarded_domain_owner_access ON mem.%I FOR ALL TO hub2_mem_owner,hub2_authz_owner,hub2_v8_owner,hub2_evidence_owner USING(true)WITH CHECK(true)',r.relname);END LOOP;END $$;
