-- Original candidate. Root assigns final migration number; no snapshot rollback.
SET ROLE hub2_mem_owner;
CREATE TABLE mem.causal_operations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL,client_id uuid NOT NULL,project_id uuid NOT NULL,action text NOT NULL,idempotency_key text NOT NULL,fingerprint text NOT NULL,request jsonb NOT NULL,batch_id uuid REFERENCES mem.batch_operations,batch_index integer,result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(actor_id,action,idempotency_key));
CREATE TABLE mem.causal_transaction(xid xid8 PRIMARY KEY,operation_id uuid NOT NULL REFERENCES mem.causal_operations,property_key text);
CREATE TABLE mem.field_effects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sequence bigint GENERATED ALWAYS AS IDENTITY,operation_id uuid REFERENCES mem.causal_operations,entity_type text NOT NULL CHECK(entity_type IN('material','placement')),entity_id uuid NOT NULL,material_id uuid NOT NULL,field_key text NOT NULL,before_exists boolean NOT NULL,after_exists boolean NOT NULL,before_value jsonb,after_value jsonb,source_version_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE mem.field_last_effect(entity_type text NOT NULL,entity_id uuid NOT NULL,field_key text NOT NULL,effect_id uuid NOT NULL REFERENCES mem.field_effects,PRIMARY KEY(entity_type,entity_id,field_key));
REVOKE ALL ON mem.causal_operations,mem.causal_transaction,mem.field_effects,mem.field_last_effect FROM PUBLIC,hub2_mem,hub2_worker;
CREATE TABLE mem.batch_item_outcomes(batch_id uuid NOT NULL REFERENCES mem.batch_operations,item_index integer NOT NULL,outcome jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(batch_id,item_index));
REVOKE ALL ON mem.batch_item_outcomes FROM PUBLIC,hub2_mem,hub2_worker;
CREATE FUNCTION mem.batch_outcome(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;batch mem.batch_operations;items jsonb;n bigint;
BEGIN IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch';END IF;c:=mem.guard(h,'mem.read',d,b);SELECT * INTO batch FROM mem.batch_operations WHERE id=(b->>'batch_id')::uuid AND actor_id=(c->>'actor_id')::uuid AND manifest->>'project_id'=c->>'project_id';IF batch.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF b?'outcome'THEN IF (b->>'item_index')::integer NOT BETWEEN 0 AND jsonb_array_length(batch.manifest->'items')-1 THEN RAISE EXCEPTION 'invalid_batch_index';END IF;INSERT INTO mem.batch_item_outcomes VALUES(batch.id,(b->>'item_index')::integer,b->'outcome',clock_timestamp())ON CONFLICT DO NOTHING;END IF;
 SELECT count(*),coalesce(jsonb_agg(outcome ORDER BY item_index),'[]')INTO n,items FROM mem.batch_item_outcomes WHERE batch_id=batch.id;
 PERFORM authz.assert_effect(h);RETURN jsonb_build_object('operation_id',batch.id,'state',CASE WHEN n<>jsonb_array_length(batch.manifest->'items')THEN'pending'WHEN EXISTS(SELECT FROM jsonb_array_elements(items)x WHERE x->>'state'='failed')THEN'partial'ELSE'completed'END,'items',items,'complete',n=jsonb_array_length(batch.manifest->'items'),'coverage','all_original_item_outcomes_preserved');
END $$;
REVOKE ALL ON FUNCTION mem.batch_outcome(uuid,text,text)FROM PUBLIC;GRANT EXECUTE ON FUNCTION mem.batch_outcome(uuid,text,text)TO hub2_mem;
CREATE FUNCTION mem.causal_start(c jsonb,a text,b jsonb,d text) RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,mem AS $$
DECLARE op uuid;batch mem.batch_operations;
BEGIN
 IF b->>'batch_operation_id' IS NOT NULL THEN SELECT * INTO batch FROM mem.batch_operations WHERE id=(b->>'batch_operation_id')::uuid AND actor_id=(c->>'actor_id')::uuid AND manifest->>'project_id'=c->>'project_id';IF batch.id IS NULL OR (b->>'batch_item_index')::integer NOT BETWEEN 0 AND jsonb_array_length(batch.manifest->'items')-1 OR b->>'idempotency_key' IS DISTINCT FROM batch.idempotency_key||':'||(b->>'batch_item_index') THEN RAISE EXCEPTION 'untrusted_batch_item' USING ERRCODE='42501';END IF;END IF;
 INSERT INTO mem.causal_operations(actor_id,client_id,project_id,action,idempotency_key,fingerprint,request,batch_id,batch_index)VALUES((c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'project_id')::uuid,a,b->>'idempotency_key',d,b,batch.id,(b->>'batch_item_index')::integer)RETURNING id INTO op;
 INSERT INTO mem.causal_transaction(xid,operation_id)VALUES(pg_current_xact_id(),op)ON CONFLICT(xid)DO UPDATE SET operation_id=EXCLUDED.operation_id;RETURN op;
END $$;
CREATE FUNCTION mem.remember_causal_command(c jsonb,a text,b jsonb,d text,r jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,mem AS $$
DECLARE op uuid;final_result jsonb;
BEGIN SELECT operation_id INTO op FROM mem.causal_transaction WHERE xid=pg_current_xact_id();IF op IS NULL THEN RAISE EXCEPTION 'causal_context_required';END IF;final_result:=r||jsonb_build_object('operation_id',op);UPDATE mem.causal_operations SET result=final_result WHERE id=op;DELETE FROM mem.causal_transaction WHERE xid=pg_current_xact_id();RETURN mem.remember_command(c,a,b,d,final_result);END $$;
CREATE FUNCTION mem.capture_field_effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE op mem.causal_operations;key text;keys text[];eid uuid;mid uuid;before jsonb;after jsonb;exists_before boolean;exists_after boolean;source uuid;entity text:=CASE TG_TABLE_NAME WHEN 'materials' THEN 'material' ELSE 'placement' END;
BEGIN
 SELECT o.* INTO op FROM mem.causal_transaction tx JOIN mem.causal_operations o ON o.id=tx.operation_id WHERE tx.xid=pg_current_xact_id();
 IF entity='material'THEN mid:=NEW.id;source:=OLD.current_version_id;ELSE mid:=NEW.material_id;SELECT current_version_id INTO source FROM mem.materials WHERE id=mid;END IF;
 IF TG_ARGV[0]='properties' THEN
  IF op.id IS NOT NULL AND op.action='patch_metadata' THEN SELECT array_agg('properties:'||k)INTO keys FROM jsonb_object_keys(coalesce(op.request->'properties','{}'))k;
  ELSIF op.id IS NOT NULL AND op.action='causal_compensate' THEN SELECT ARRAY['properties:'||property_key]INTO keys FROM mem.causal_transaction WHERE xid=pg_current_xact_id()AND property_key IS NOT NULL;
  ELSE SELECT array_agg('properties:'||k)INTO keys FROM(SELECT jsonb_object_keys(OLD.properties)k UNION SELECT jsonb_object_keys(NEW.properties)k)s;END IF;
 ELSE keys:=ARRAY[TG_ARGV[0]];END IF;
 FOREACH key IN ARRAY coalesce(keys,ARRAY[]::text[])LOOP
  IF key LIKE'properties:%'THEN before:=OLD.properties->substring(key FROM 12);after:=NEW.properties->substring(key FROM 12);exists_before:=OLD.properties?substring(key FROM 12);exists_after:=NEW.properties?substring(key FROM 12);
  ELSE before:=to_jsonb(OLD)->key;after:=to_jsonb(NEW)->key;exists_before:=true;exists_after:=true;END IF;
  INSERT INTO mem.field_effects(operation_id,entity_type,entity_id,material_id,field_key,before_exists,after_exists,before_value,after_value,source_version_id)VALUES(op.id,entity,NEW.id,mid,key,exists_before,exists_after,before,after,source)RETURNING id INTO eid;
  INSERT INTO mem.field_last_effect VALUES(entity,NEW.id,key,eid)ON CONFLICT(entity_type,entity_id,field_key)DO UPDATE SET effect_id=EXCLUDED.effect_id;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER causal_properties AFTER UPDATE OF properties ON mem.materials FOR EACH ROW EXECUTE FUNCTION mem.capture_field_effect('properties');
CREATE TRIGGER causal_state AFTER UPDATE OF state ON mem.materials FOR EACH ROW EXECUTE FUNCTION mem.capture_field_effect('state');
CREATE TRIGGER causal_content AFTER UPDATE OF current_version_id ON mem.materials FOR EACH ROW EXECUTE FUNCTION mem.capture_field_effect('current_version_id');
CREATE TRIGGER causal_path AFTER UPDATE OF logical_path ON mem.placements FOR EACH ROW EXECUTE FUNCTION mem.capture_field_effect('logical_path');
CREATE TRIGGER causal_collection AFTER UPDATE OF collection_id ON mem.placements FOR EACH ROW EXECUTE FUNCTION mem.capture_field_effect('collection_id');
CREATE TRIGGER causal_active AFTER UPDATE OF active ON mem.placements FOR EACH ROW EXECUTE FUNCTION mem.capture_field_effect('active');
-- Preserve every existing guard, writer epoch, CAS, source check and outbox path.
DO $capture_original_mutators$
DECLARE a text;before text;after text;needle text:='IF replay IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN replay;END IF;';
BEGIN FOREACH a IN ARRAY ARRAY['patch_metadata','patch_placement','trash_material','restore_content']LOOP
 before:=pg_get_functiondef(('mem.'||a||'(uuid,text,text)')::regprocedure);
 after:=replace(before,needle,needle||'PERFORM mem.causal_start(c,'''||a||''',b,d);');
 IF after=before THEN RAISE EXCEPTION 'reviewed_mutator_replay_shape_changed %',a;END IF;
 after:=replace(after,'mem.remember_command(c,'''||a||'''','mem.remember_causal_command(c,'''||a||'''');EXECUTE after;
END LOOP;END $capture_original_mutators$;
CREATE FUNCTION mem.compensation_plan(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;op mem.causal_operations;e mem.field_effects;m mem.materials;items jsonb:='[]';fields jsonb;last uuid;
BEGIN IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch';END IF;c:=mem.guard(h,'mem.read',d,b);
 FOR op IN SELECT * FROM mem.causal_operations WHERE(id=(b->>'operation_id')::uuid OR batch_id=(b->>'operation_id')::uuid)AND project_id=(c->>'project_id')::uuid ORDER BY created_at,id LOOP
  BEGIN
  fields:='[]';FOR e IN SELECT * FROM mem.field_effects WHERE operation_id=op.id ORDER BY sequence LOOP
   SELECT * INTO m FROM mem.materials WHERE id=e.material_id AND project_id=(c->>'project_id')::uuid;IF m.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
   PERFORM authz.assert_sources(h,jsonb_build_array(jsonb_build_object('project_id',m.project_id,'material_id',m.id)),'mem.read');IF m.current_version_id IS NOT NULL THEN PERFORM mem.assert_version_sources(h,m.current_version_id,'mem.read');END IF;IF e.source_version_id IS NOT NULL THEN PERFORM mem.assert_version_sources(h,e.source_version_id,'mem.read');END IF;
   SELECT effect_id INTO last FROM mem.field_last_effect WHERE entity_type=e.entity_type AND entity_id=e.entity_id AND field_key=e.field_key;
   fields:=fields||jsonb_build_array(jsonb_build_object('effect_id',e.id,'entity_type',e.entity_type,'entity_id',e.entity_id,'material_id',e.material_id,'field',e.field_key,'before_exists',e.before_exists,'before',e.before_value,'after_exists',e.after_exists,'after',e.after_value,'state',CASE WHEN e.field_key='current_version_id'AND(e.before_value='null'::jsonb OR e.before_value IS NULL)THEN'needs_choice'WHEN last=e.id THEN'eligible'ELSE'later_write_preserved'END,'choice','agent_selects'));
  END LOOP;
  items:=items||jsonb_build_array(jsonb_build_object('operation_id',op.id,'batch_index',op.batch_index,'action',op.action,'required_action',CASE WHEN op.action='trash_material'THEN'mem.delete'ELSE'mem.write'END,'state',CASE WHEN jsonb_array_length(fields)>0 THEN'assessed_physical_causality'ELSE'needs_choice'END,'fields',fields));
  EXCEPTION WHEN insufficient_privilege THEN items:=items||jsonb_build_array(jsonb_build_object('operation_id',op.id,'batch_index',op.batch_index,'state','current_access_unavailable','fields','[]'::jsonb));END;
 END LOOP;
 SELECT items||coalesce(jsonb_agg(jsonb_build_object('batch_index',item_index,'state','not_applied','original_outcome',outcome,'fields','[]'::jsonb)ORDER BY item_index),'[]')INTO items FROM mem.batch_item_outcomes WHERE batch_id=(b->>'operation_id')::uuid AND outcome->>'state'='failed';
 IF jsonb_array_length(items)=0 THEN IF NOT EXISTS(SELECT FROM mem.batch_operations WHERE id=(b->>'operation_id')::uuid AND manifest->>'project_id'=c->>'project_id')THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;items:=jsonb_build_array(jsonb_build_object('operation_id',b->>'operation_id','state','unassessed','reason','historical_before_state_not_recorded','next_step','needs_choice'));END IF;
 PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','plan','operation_id',b->>'operation_id','items',items,'execution','agent_selects_effects_not_automatic');
END $$;
CREATE FUNCTION mem.compensation_apply(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;op mem.causal_operations;e mem.field_effects;m mem.materials;p mem.placements;old mem.content_versions;v mem.content_versions;replay jsonb;applied jsonb:='[]';conflicts jsonb:='[]';last uuid;now_value jsonb;now_exists boolean;undo uuid;final_result jsonb;action text;selected uuid[];lifecycle boolean;target uuid;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch';END IF;
 SELECT * INTO op FROM mem.causal_operations WHERE id=(b->>'operation_id')::uuid;IF op.id IS NULL THEN RAISE EXCEPTION 'needs_choice_missing_before_state';END IF;action:=CASE WHEN op.action='trash_material'THEN'mem.delete'ELSE'mem.write'END;c:=mem.guard(h,action,d,b);IF op.project_id IS DISTINCT FROM(c->>'project_id')::uuid THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 replay:=mem.replay_command(c,'causal_compensate',b,d);IF replay IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN replay;END IF;
 SELECT array_agg(value::uuid)INTO selected FROM jsonb_array_elements_text(b->'effect_ids');IF cardinality(selected)IS NULL OR cardinality(selected)=0 OR EXISTS(SELECT FROM unnest(selected)id WHERE NOT EXISTS(SELECT FROM mem.field_effects WHERE field_effects.id=id AND operation_id=op.id))THEN RAISE EXCEPTION 'invalid_effect_selection';END IF;
 lifecycle:=op.action='trash_material';IF lifecycle THEN SELECT array_agg(id)INTO selected FROM mem.field_effects WHERE operation_id=op.id;END IF;
 SELECT material_id INTO target FROM mem.field_effects WHERE id=selected[1];IF EXISTS(SELECT FROM mem.field_effects WHERE id=ANY(selected)AND material_id<>target)THEN RAISE EXCEPTION 'cross_material_selection';END IF;
 IF target IS DISTINCT FROM(b->>'material_id')::uuid THEN RAISE EXCEPTION 'target_scope_mismatch' USING ERRCODE='42501';END IF;SELECT * INTO m FROM mem.materials WHERE id=target AND project_id=op.project_id FOR UPDATE;IF m.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;IF m.current_version_id IS NOT NULL THEN PERFORM mem.assert_version_sources(h,m.current_version_id,'mem.read');END IF;
 FOR e IN SELECT * FROM mem.field_effects WHERE id=ANY(selected)ORDER BY sequence LOOP
  IF e.entity_type='placement'THEN SELECT * INTO p FROM mem.placements WHERE id=e.entity_id AND material_id=m.id FOR UPDATE;now_value:=to_jsonb(p)->e.field_key;now_exists:=true;
  ELSIF e.field_key LIKE'properties:%'THEN now_value:=m.properties->substring(e.field_key FROM 12);now_exists:=m.properties?substring(e.field_key FROM 12);
  ELSE now_value:=to_jsonb(m)->e.field_key;now_exists:=true;END IF;
  SELECT effect_id INTO last FROM mem.field_last_effect WHERE entity_type=e.entity_type AND entity_id=e.entity_id AND field_key=e.field_key FOR UPDATE;
  IF last IS DISTINCT FROM e.id OR now_exists IS DISTINCT FROM e.after_exists OR now_value IS DISTINCT FROM e.after_value THEN conflicts:=conflicts||jsonb_build_array(jsonb_build_object('effect_id',e.id,'field',e.field_key,'state','later_write_preserved'));END IF;
  IF e.source_version_id IS NOT NULL THEN PERFORM mem.assert_version_sources(h,e.source_version_id,'mem.read');END IF;
 END LOOP;
 IF lifecycle AND jsonb_array_length(conflicts)>0 THEN RETURN mem.remember_command(c,'causal_compensate',b,d,jsonb_build_object('state','conflict','reason','lifecycle_later_write_preserved','items',conflicts));END IF;
 BEGIN
  undo:=mem.causal_start(c,'causal_compensate',b,d);
  FOR e IN SELECT * FROM mem.field_effects WHERE id=ANY(selected)ORDER BY sequence LOOP
   IF EXISTS(SELECT FROM jsonb_array_elements(conflicts)x WHERE x->>'effect_id'=e.id::text)THEN CONTINUE;END IF;
   IF e.entity_type='placement'THEN
    IF e.field_key='logical_path'THEN UPDATE mem.placements SET logical_path=e.before_value#>>'{}',revision=revision+1 WHERE id=e.entity_id;
    ELSIF e.field_key='collection_id'THEN UPDATE mem.placements SET collection_id=(e.before_value#>>'{}')::uuid,revision=revision+1 WHERE id=e.entity_id;
    ELSIF e.field_key='active'THEN UPDATE mem.placements SET active=(e.before_value#>>'{}')::boolean,revision=revision+1 WHERE id=e.entity_id;END IF;
   ELSIF e.field_key LIKE'properties:%'THEN UPDATE mem.causal_transaction SET property_key=substring(e.field_key FROM 12)WHERE xid=pg_current_xact_id();UPDATE mem.materials SET properties=CASE WHEN e.before_exists THEN jsonb_set(properties,ARRAY[substring(e.field_key FROM 12)],e.before_value,true)ELSE properties-substring(e.field_key FROM 12)END WHERE id=m.id;
   ELSIF e.field_key='state'THEN UPDATE mem.materials SET state=e.before_value#>>'{}'WHERE id=m.id;
   ELSIF e.field_key='current_version_id'THEN
    IF e.before_value='null'::jsonb OR e.before_value IS NULL THEN RAISE EXCEPTION 'needs_choice_missing_prior_content';END IF;
    SELECT * INTO old FROM mem.content_versions WHERE id=(e.before_value#>>'{}')::uuid AND material_id=m.id;IF old.id IS NULL THEN RAISE EXCEPTION 'needs_choice_missing_prior_content';END IF;PERFORM mem.assert_version_sources(h,old.id,'mem.read');
    INSERT INTO mem.content_versions(material_id,object_id,sha256,size,actor_id,reason,provenance_state)VALUES(m.id,old.object_id,old.sha256,old.size,(c->>'actor_id')::uuid,'compensating_restore',old.provenance_state)RETURNING * INTO v;
    INSERT INTO mem.source_edges(output_version_id,input_version_id,derivation_kind)VALUES(v.id,old.id,'causal_compensating_restore');UPDATE mem.materials SET current_version_id=v.id,content_revision=content_revision+1,provenance_state=v.provenance_state WHERE id=m.id;
   ELSE RAISE EXCEPTION 'needs_choice_unsupported_field';END IF;
   applied:=applied||jsonb_build_array(jsonb_build_object('effect_id',e.id,'field',e.field_key,'state','compensated'));
  END LOOP;
  IF jsonb_array_length(applied)>0 THEN UPDATE mem.materials SET metadata_revision=metadata_revision+CASE WHEN op.action='restore_content'THEN 0 ELSE 1 END,event_revision=event_revision+1 WHERE id=m.id RETURNING * INTO m;END IF;
  final_result:=jsonb_build_object('operation_id',undo,'compensates',op.id,'state',CASE WHEN jsonb_array_length(conflicts)>0 THEN'partial'ELSE'compensated'END,'items',applied||conflicts,'domain_revision',m.event_revision,'content_revision',m.content_revision,'metadata_revision',m.metadata_revision);
  IF v.id IS NOT NULL THEN final_result:=final_result||jsonb_build_object('fixed_refs',jsonb_build_array(jsonb_build_object('material_id',m.id,'version_id',v.id,'sha256',v.sha256,'size',v.size)));PERFORM mem.remember_command(c,'restore_content',b||jsonb_build_object('idempotency_key','causal-content:'||(b->>'idempotency_key')),d,final_result);END IF;
  IF jsonb_array_length(applied)>0 THEN PERFORM mem.emit(c,CASE WHEN v.id IS NOT NULL THEN'material.restored'ELSE'material.causal_compensated'END,m.id,m.event_revision,undo,final_result);END IF;
  UPDATE mem.causal_operations SET result=final_result WHERE id=undo;DELETE FROM mem.causal_transaction WHERE xid=pg_current_xact_id();PERFORM authz.assert_effect(h);RETURN mem.remember_command(c,'causal_compensate',b,d,final_result);
 EXCEPTION WHEN unique_violation THEN RETURN mem.remember_command(c,'causal_compensate',b,d,jsonb_build_object('state','conflict','reason','name_in_use','original_operation_id',op.id,'selected_effects',to_jsonb(selected)));END;
END $$;
REVOKE ALL ON FUNCTION mem.causal_start(jsonb,text,jsonb,text),mem.remember_causal_command(jsonb,text,jsonb,text,jsonb),mem.capture_field_effect(),mem.compensation_plan(uuid,text,text),mem.compensation_apply(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.compensation_plan(uuid,text,text),mem.compensation_apply(uuid,text,text)TO hub2_mem;
RESET ROLE;

-- Batch/index serialization covers effect or definite failure and durable outcome in one transaction.
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.batch_outcomes_snapshot(batch uuid) RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog,mem AS $$
 SELECT jsonb_build_object('operation_id',b.id,'state',CASE WHEN count(o.item_index)<>jsonb_array_length(b.manifest->'items')THEN'pending'WHEN bool_or(o.outcome->>'state'='failed')THEN'partial'ELSE'completed'END,'items',coalesce(jsonb_agg(o.outcome ORDER BY o.item_index)FILTER(WHERE o.item_index IS NOT NULL),'[]'),'complete',count(o.item_index)=jsonb_array_length(b.manifest->'items'),'coverage','all_original_item_outcomes_preserved') FROM mem.batch_operations b LEFT JOIN mem.batch_item_outcomes o ON o.batch_id=b.id WHERE b.id=batch GROUP BY b.id;
$$;
CREATE FUNCTION mem.batch_item_execute(h_read uuid,d_read text,scope_payload text,h_effect uuid,d_effect text,effect_payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=scope_payload::jsonb;c jsonb;batch mem.batch_operations;idx integer;entry jsonb;expected jsonb;actual jsonb;result jsonb;outcome jsonb;code text;message text;
BEGIN
 IF encode(public.digest(scope_payload,'sha256'),'hex')IS DISTINCT FROM d_read THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 idx:=(b->>'item_index')::integer;IF idx IS NULL OR idx NOT BETWEEN 0 AND 99 THEN RAISE EXCEPTION 'invalid_batch_index';END IF;
 -- Bounded wait, local to this index; no authority row locks or external I/O held while waiting.
 PERFORM set_config('lock_timeout','1500ms',true);
 PERFORM pg_advisory_xact_lock(hashtextextended('mem.batch-item:'||(b->>'batch_id')||':'||idx,0));
 c:=mem.guard(h_read,'mem.read',d_read,b);
 SELECT * INTO batch FROM mem.batch_operations WHERE id=(b->>'batch_id')::uuid AND actor_id=(c->>'actor_id')::uuid AND manifest->>'project_id'=c->>'project_id';
 IF batch.id IS NULL OR idx>=jsonb_array_length(batch.manifest->'items')THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 SELECT o.outcome INTO outcome FROM mem.batch_item_outcomes o WHERE o.batch_id=batch.id AND o.item_index=idx;
 IF outcome IS NOT NULL THEN PERFORM authz.assert_effect(h_read);RETURN mem.batch_outcomes_snapshot(batch.id);END IF;
 entry:=batch.manifest->'items'->idx;
 expected:=(entry-'kind')||jsonb_build_object('project_id',batch.manifest->'project_id','idempotency_key',batch.idempotency_key||':'||idx,'batch_operation_id',batch.id,'batch_item_index',idx);
 IF b?'decision_failure' THEN
  IF h_effect IS NOT NULL OR b->>'decision_failure' IS DISTINCT FROM 'forbidden' THEN RAISE EXCEPTION 'invalid_batch_decision_failure';END IF;
  outcome:=jsonb_build_object('index',idx,'state','failed','error_code','forbidden','retained_state','prior_successful_items_retained','next_step','inspect_item_and_compensate_with_current_revision');
 ELSE
  actual:=effect_payload::jsonb;
  IF h_effect IS NULL OR actual IS DISTINCT FROM expected OR encode(public.digest(effect_payload,'sha256'),'hex')IS DISTINCT FROM d_effect THEN RAISE EXCEPTION 'untrusted_batch_item' USING ERRCODE='42501';END IF;
  BEGIN
   CASE entry->>'kind'
    WHEN 'metadata'THEN result:=mem.patch_metadata(h_effect,d_effect,effect_payload);
    WHEN 'placement'THEN result:=mem.patch_placement(h_effect,d_effect,effect_payload);
    WHEN 'trash'THEN result:=mem.trash_material(h_effect,d_effect,effect_payload);
    WHEN 'restore_content'THEN result:=mem.restore_content(h_effect,d_effect,effect_payload);
    ELSE RAISE EXCEPTION 'invalid_batch_item_kind';
   END CASE;
   outcome:=jsonb_build_object('index',idx)||result;
  EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
   -- Expired decisions and transient/unknown failures require a fresh decision, not a durable fabricated failure.
   IF code NOT IN('40001','42501','P0001')AND code!~'^(22|23)[0-9A-Z]{3}$' OR message~'(handle|authority_expired|effect_project_changed|writer_epoch)'THEN RAISE;END IF;
   outcome:=jsonb_build_object('index',idx,'state','failed','error_code',CASE code WHEN '40001'THEN'revision_conflict'WHEN '42501'THEN'forbidden'ELSE'item_failed'END,'retained_state','prior_successful_items_retained','next_step','inspect_item_and_compensate_with_current_revision');
  END;
 END IF;
 PERFORM authz.assert_effect(h_read);
 INSERT INTO mem.batch_item_outcomes(batch_id,item_index,outcome)VALUES(batch.id,idx,outcome);
 RETURN mem.batch_outcomes_snapshot(batch.id);
END $$;
REVOKE ALL ON FUNCTION mem.batch_outcomes_snapshot(uuid),mem.batch_item_execute(uuid,text,text,uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.batch_item_execute(uuid,text,text,uuid,text,text)TO hub2_mem;
-- Direct use of an existing mutator with batch fields must obey the same index fence.
DO $batch_causal_fence$
DECLARE before text;after text;needle text:='INSERT INTO mem.causal_operations(actor_id';
BEGIN
 before:=pg_get_functiondef('mem.causal_start(jsonb,text,jsonb,text)'::regprocedure);
 after:=replace(before,needle,'IF batch.id IS NOT NULL THEN PERFORM set_config(''lock_timeout'',''1500ms'',true);PERFORM pg_advisory_xact_lock(hashtextextended(''mem.batch-item:''||batch.id||'':''||(b->>''batch_item_index''),0));IF EXISTS(SELECT FROM mem.batch_item_outcomes WHERE batch_id=batch.id AND item_index=(b->>''batch_item_index'')::integer)THEN RAISE EXCEPTION ''batch_item_already_completed'' USING ERRCODE=''42501'';END IF;END IF;'||needle);
 IF after=before THEN RAISE EXCEPTION 'causal_start_base_changed';END IF;EXECUTE after;
END $batch_causal_fence$;
RESET ROLE;
