-- Processing remains caller/Agent work. Missing fixed inputs are durable pending drafts, never placeholder objects.
SET ROLE hub2_mem_owner;
ALTER TABLE mem.processing_runs DROP CONSTRAINT processing_runs_inputs_check;
ALTER TABLE mem.processing_runs ADD CONSTRAINT processing_inputs_array CHECK(jsonb_typeof(inputs)='array' AND jsonb_array_length(inputs)<=100);
ALTER TABLE mem.processing_runs ADD COLUMN source_state text NOT NULL DEFAULT 'fixed_inputs_bound' CHECK(source_state IN ('pending','fixed_inputs_bound'));
ALTER TABLE mem.processing_runs ADD COLUMN semantic_kind text;
ALTER TABLE mem.processing_runs ADD COLUMN declaration jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(declaration)='object');
ALTER TABLE mem.processing_runs ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE mem.processing_runs ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE mem.processing_runs ADD CONSTRAINT processing_fixed_inputs_for_execution CHECK(technical_state NOT IN ('prepared','succeeded') OR jsonb_array_length(inputs)>0);
ALTER TABLE mem.processing_runs ADD CONSTRAINT processing_source_state CHECK(source_state<>'fixed_inputs_bound' OR jsonb_array_length(inputs)>0);
CREATE TABLE mem.processing_attempt_history(run_id uuid NOT NULL REFERENCES mem.processing_runs(id),attempt bigint NOT NULL,fencing_token uuid NOT NULL,inputs jsonb NOT NULL,recipe jsonb NOT NULL,technical_state text NOT NULL,reason text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(run_id,attempt,fencing_token));
REVOKE ALL ON mem.processing_attempt_history FROM PUBLIC,hub2_mem;

CREATE FUNCTION mem.processing_mask_json(value jsonb,denied text[]) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,mem AS $$
DECLARE item jsonb;key text;result jsonb;
BEGIN
 IF jsonb_typeof(value)='string' THEN RETURN CASE WHEN value#>>'{}'=ANY(denied) THEN 'null'::jsonb ELSE value END;END IF;
 IF jsonb_typeof(value)='object' THEN
  IF value->>'version_id'=ANY(denied) OR value->>'material_id'=ANY(denied) THEN RETURN jsonb_build_object('state','source_access_restricted');END IF;
  result:='{}';FOR key,item IN SELECT * FROM jsonb_each(value) LOOP result:=result||jsonb_build_object(key,mem.processing_mask_json(item,denied));END LOOP;RETURN result;
 END IF;
 IF jsonb_typeof(value)='array' THEN result:='[]';FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP result:=result||jsonb_build_array(mem.processing_mask_json(item,denied));END LOOP;RETURN result;END IF;
 RETURN value;
END $$;
CREATE FUNCTION mem.processing_safe_json(h uuid,value jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,mem AS $$
DECLARE candidate text;vid uuid;pid uuid;mid uuid;denied text[]:='{}';
BEGIN
 -- Only real IDs receive source authorization treatment; Agent semantic IDs and arbitrary JSON remain data.
 FOR candidate IN SELECT DISTINCT item#>>'{}' FROM jsonb_path_query(value,'$.**') item WHERE jsonb_typeof(item)='string' AND item#>>'{}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' LOOP
  SELECT id INTO vid FROM mem.content_versions WHERE id=candidate::uuid;
  BEGIN
   IF vid IS NOT NULL THEN PERFORM mem.assert_version_sources(h,vid,'mem.read');
   ELSE SELECT id,project_id INTO mid,pid FROM mem.materials WHERE id=candidate::uuid;
    IF mid IS NOT NULL THEN PERFORM authz.assert_sources(h,jsonb_build_array(jsonb_build_object('project_id',pid,'material_id',mid)),'mem.read');END IF;
   END IF;
  EXCEPTION WHEN insufficient_privilege THEN denied:=array_append(denied,candidate);END;
 END LOOP;
 RETURN mem.processing_mask_json(value,denied);
END $$;

CREATE FUNCTION mem.processing_view(h uuid,c jsonb,r mem.processing_runs) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,mem AS $$
DECLARE ref jsonb;inputs jsonb:='[]';outputs jsonb:='[]';hidden_inputs integer:=0;hidden_outputs integer:=0;
BEGIN
 FOR ref IN SELECT value FROM jsonb_array_elements(r.inputs) LOOP
  BEGIN PERFORM mem.assert_version_sources(h,(ref->>'version_id')::uuid,'mem.read');inputs:=inputs||jsonb_build_array(ref||jsonb_build_object('source_stale',mem.version_stale((ref->>'version_id')::uuid)));
  EXCEPTION WHEN insufficient_privilege THEN hidden_inputs:=hidden_inputs+1;END;
 END LOOP;
 FOR ref IN SELECT value FROM jsonb_array_elements(r.outputs) LOOP
  BEGIN PERFORM mem.assert_version_sources(h,(ref->>'version_id')::uuid,'mem.read');outputs:=outputs||jsonb_build_array(ref||jsonb_build_object('source_stale',mem.version_stale((ref->>'version_id')::uuid)));
  EXCEPTION WHEN insufficient_privilege THEN hidden_outputs:=hidden_outputs+1;END;
 END LOOP;
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('operation_id',r.id,'run_id',r.id,'state',r.technical_state,'technical_state',r.technical_state,'source_state',r.source_state,'revision',r.revision,'attempt',r.attempt,'fencing_token',CASE WHEN r.technical_state='prepared' THEN r.fencing_token ELSE NULL END,'lease_until',CASE WHEN r.technical_state='prepared' THEN r.lease_until ELSE NULL END,'recipe',mem.processing_safe_json(h,r.recipe),'inputs',inputs,'outputs',outputs,'coverage',r.coverage,'output_kind',r.output_kind,'semantic_kind',r.semantic_kind,'declaration',mem.processing_safe_json(h,r.declaration),'idempotency_key',r.idempotency_key,'semantic_status','agent_assessment_not_inferred','source_completeness','not_inferred_from_fixed_input_count','reference_access',jsonb_build_object('hidden_inputs',hidden_inputs,'hidden_outputs',hidden_outputs),'processing_pending',r.technical_state<>'succeeded','retained_state','run_and_declaration_preserved','receipt',CASE WHEN r.technical_state='succeeded' THEN jsonb_build_object('run_id',r.id,'state','succeeded','semantic_status','not_asserted','coverage',r.coverage) ELSE NULL END,'next_step',CASE WHEN r.technical_state='draft' THEN 'resume_same_run_with_actual_fixed_inputs_when_available' WHEN r.technical_state='cancelled' THEN 'resume_same_run_when_authorized' WHEN r.technical_state='prepared' AND r.lease_until<=clock_timestamp() THEN 'resume_same_run_to_recover_attempt' WHEN r.technical_state='prepared' THEN 'process_authorized_fixed_inputs_and_finish_or_renew' ELSE 'inspect_outputs_and_assess_semantics' END);
END $$;

CREATE OR REPLACE FUNCTION mem.begin_processing(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb;c jsonb;r mem.processing_runs;ref jsonb;inputs jsonb;recipe jsonb;rf text;kind text;coverage text;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;
 inputs:=COALESCE(b->'inputs','[]');recipe:=jsonb_build_object('name','unknown','version','unknown','parameters','{}'::jsonb,'provider','unknown','model','unknown')||COALESCE(b->'recipe','{}');kind:=COALESCE(b->>'output_kind','other');coverage:=COALESCE(b->>'coverage','unknown');
 IF jsonb_typeof(inputs) IS DISTINCT FROM 'array' OR jsonb_array_length(inputs)>100 OR jsonb_typeof(recipe) IS DISTINCT FROM 'object' OR jsonb_typeof(recipe->'parameters') IS DISTINCT FROM 'object' OR kind NOT IN ('transcript','experience','skill','context','summary','other') OR coverage NOT IN ('raw_export','user_attachment','agent_summary','partial','unknown') OR COALESCE(length(b->>'idempotency_key'),0) NOT BETWEEN 1 AND 200 OR (b ? 'declaration' AND jsonb_typeof(b->'declaration') IS DISTINCT FROM 'object') THEN RAISE EXCEPTION 'invalid_processing_input';END IF;
 c:=mem.guard(h,'mem.process',d,b);
 FOR ref IN SELECT value FROM jsonb_array_elements(inputs) LOOP
  IF NOT EXISTS(SELECT FROM mem.content_versions v WHERE v.id=(ref->>'version_id')::uuid AND v.material_id=(ref->>'material_id')::uuid AND v.sha256=ref->>'sha256') THEN RAISE EXCEPTION 'source_reference_mismatch' USING ERRCODE='42501';END IF;
  PERFORM mem.assert_version_sources(h,(ref->>'version_id')::uuid,'mem.read');
 END LOOP;
 PERFORM pg_advisory_xact_lock(hashtextextended((c->>'actor_id')||'processing-create'||(b->>'idempotency_key'),0));
 SELECT * INTO r FROM mem.processing_runs WHERE actor_id=(c->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key';
 IF FOUND THEN IF r.fingerprint IS DISTINCT FROM d THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;RETURN mem.processing_view(h,c,r);END IF;
 rf:=encode(public.digest(jsonb_build_object('inputs',inputs,'recipe',recipe,'output_kind',kind,'semantic_kind',b->>'semantic_kind')::text,'sha256'),'hex');
 -- Reuse is explicit: the caller chooses reuse=true. Declared drafts are never a reuse candidate.
 IF b->>'reuse'='true' AND jsonb_array_length(inputs)>0 THEN
  SELECT * INTO r FROM mem.processing_runs WHERE project_id=(c->>'project_id')::uuid AND reuse_fingerprint=rf AND technical_state='succeeded' AND NOT EXISTS(SELECT FROM jsonb_array_elements(outputs) outref WHERE NOT mem.version_visible((c->>'actor_id')::uuid,(outref->>'version_id')::uuid) OR mem.version_stale((outref->>'version_id')::uuid)) ORDER BY id LIMIT 1;
  IF FOUND THEN
   BEGIN
    FOR ref IN SELECT value FROM jsonb_array_elements(r.outputs) LOOP PERFORM mem.assert_version_sources(h,(ref->>'version_id')::uuid,'mem.read');END LOOP;
    PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','reused','run_id',r.id,'fixed_refs',r.outputs,'coverage',r.coverage,'semantic_status','agent_assessment_not_inferred');
   EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  END IF;
 END IF;
 PERFORM authz.assert_effect(h);
 INSERT INTO mem.processing_runs(project_id,actor_id,client_id,idempotency_key,fingerprint,reuse_fingerprint,output_kind,recipe,inputs,coverage,technical_state,attempt,lease_until,source_state,semantic_kind,declaration)
 VALUES((c->>'project_id')::uuid,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,b->>'idempotency_key',d,rf,kind,recipe,inputs,coverage,CASE WHEN jsonb_array_length(inputs)=0 THEN 'draft' ELSE 'prepared' END,CASE WHEN jsonb_array_length(inputs)=0 THEN 0 ELSE 1 END,CASE WHEN jsonb_array_length(inputs)=0 THEN clock_timestamp() ELSE clock_timestamp()+interval '10 minutes' END,CASE WHEN jsonb_array_length(inputs)=0 THEN 'pending' ELSE 'fixed_inputs_bound' END,b->>'semantic_kind',COALESCE(b->'declaration','{}')) RETURNING * INTO r;
 PERFORM mem.emit(c,'processing.created',r.id,r.revision,r.id,jsonb_build_object('run_id',r.id,'technical_state',r.technical_state,'source_state',r.source_state));
 RETURN mem.processing_view(h,c,r);
END $$;

CREATE FUNCTION mem.processing_run(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb;c jsonb;r mem.processing_runs;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;c:=mem.guard(h,'mem.read',d,b);
 SELECT * INTO r FROM mem.processing_runs WHERE id=(b->>'processing_run_id')::uuid AND project_id=(c->>'project_id')::uuid AND actor_id=(c->>'actor_id')::uuid;
 IF r.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 RETURN mem.processing_view(h,c,r);
END $$;

CREATE FUNCTION mem.resume_processing(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
#variable_conflict use_variable
DECLARE b jsonb;c jsonb;r mem.processing_runs;ref jsonb;inputs jsonb;recipe jsonb;decl jsonb;coverage text;semantic text;changed boolean;restart boolean;replay jsonb;result jsonb;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;c:=mem.guard(h,'mem.process',d,b);
 replay:=mem.replay_command(c,'resume_processing',b,d);IF replay IS NOT NULL THEN result:=mem.processing_safe_json(h,replay);PERFORM authz.assert_effect(h);RETURN result;END IF;
 SELECT * INTO r FROM mem.processing_runs WHERE id=(b->>'processing_run_id')::uuid AND project_id=(c->>'project_id')::uuid AND actor_id=(c->>'actor_id')::uuid FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF b->>'expected_revision' IS NOT NULL AND r.revision IS DISTINCT FROM (b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001';END IF;
 IF r.technical_state='succeeded' THEN RETURN mem.processing_view(h,c,r);END IF;
 inputs:=COALESCE(b->'inputs',r.inputs);recipe:=r.recipe||COALESCE(b->'recipe','{}');decl:=r.declaration||COALESCE(b->'declaration','{}');coverage:=COALESCE(b->>'coverage',r.coverage);semantic:=COALESCE(b->>'semantic_kind',r.semantic_kind);
 IF jsonb_typeof(inputs) IS DISTINCT FROM 'array' OR jsonb_array_length(inputs)>100 OR jsonb_typeof(recipe) IS DISTINCT FROM 'object' OR jsonb_typeof(recipe->'parameters') IS DISTINCT FROM 'object' OR jsonb_typeof(decl) IS DISTINCT FROM 'object' OR coverage NOT IN ('raw_export','user_attachment','agent_summary','partial','unknown') THEN RAISE EXCEPTION 'invalid_processing_input';END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(inputs) LOOP
  IF NOT EXISTS(SELECT FROM mem.content_versions v WHERE v.id=(ref->>'version_id')::uuid AND v.material_id=(ref->>'material_id')::uuid AND v.sha256=ref->>'sha256') THEN RAISE EXCEPTION 'source_reference_mismatch' USING ERRCODE='42501';END IF;
  PERFORM mem.assert_version_sources(h,(ref->>'version_id')::uuid,'mem.read');
 END LOOP;
 changed:=(inputs,recipe,decl,coverage,semantic) IS DISTINCT FROM (r.inputs,r.recipe,r.declaration,r.coverage,r.semantic_kind);
 IF r.technical_state='prepared' AND r.lease_until>clock_timestamp() AND (inputs IS DISTINCT FROM r.inputs OR recipe IS DISTINCT FROM r.recipe) AND COALESCE(b->>'reclaim','false')<>'true' THEN
  RETURN mem.processing_view(h,c,r)||jsonb_build_object('state','reclaim_required','next_step','set_reclaim_true_to_replace_active_execution_inputs_or_recipe');
 END IF;
 restart:=r.technical_state<>'prepared' OR r.lease_until<=clock_timestamp() OR inputs IS DISTINCT FROM r.inputs OR recipe IS DISTINCT FROM r.recipe OR b->>'reclaim'='true';
 PERFORM authz.assert_effect(h);
 IF restart OR jsonb_array_length(inputs)=0 THEN INSERT INTO mem.processing_attempt_history(run_id,attempt,fencing_token,inputs,recipe,technical_state,reason) VALUES(r.id,r.attempt,r.fencing_token,r.inputs,r.recipe,r.technical_state,'resume_replacement') ON CONFLICT DO NOTHING;END IF;
 UPDATE mem.processing_runs SET inputs=inputs,recipe=recipe,declaration=decl,coverage=coverage,semantic_kind=semantic,
  technical_state=CASE WHEN jsonb_array_length(inputs)=0 THEN 'draft' ELSE 'prepared' END,source_state=CASE WHEN jsonb_array_length(inputs)=0 THEN 'pending' ELSE 'fixed_inputs_bound' END,
  attempt=CASE WHEN jsonb_array_length(inputs)>0 AND restart THEN attempt+1 ELSE attempt END,
  fencing_token=CASE WHEN restart OR jsonb_array_length(inputs)=0 THEN gen_random_uuid() ELSE fencing_token END,
  lease_until=CASE WHEN jsonb_array_length(inputs)=0 THEN clock_timestamp() ELSE clock_timestamp()+interval '10 minutes' END,
  revision=revision+1,updated_at=clock_timestamp(),reuse_fingerprint=encode(public.digest(jsonb_build_object('inputs',inputs,'recipe',recipe,'output_kind',output_kind,'semantic_kind',semantic)::text,'sha256'),'hex') WHERE id=r.id RETURNING * INTO r;
 PERFORM mem.emit(c,'processing.resumed',r.id,r.revision,r.id,jsonb_build_object('run_id',r.id,'technical_state',r.technical_state,'attempt',r.attempt,'inputs_changed',changed,'previous_external_attempt_stopped','not_asserted'));
 result:=mem.processing_view(h,c,r);
 RETURN mem.remember_command(c,'resume_processing',b,d,result);
END $$;

CREATE FUNCTION mem.cancel_processing(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb;c jsonb;r mem.processing_runs;replay jsonb;result jsonb;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;c:=mem.guard(h,'mem.process',d,b);
 replay:=mem.replay_command(c,'cancel_processing',b,d);IF replay IS NOT NULL THEN result:=mem.processing_safe_json(h,replay);PERFORM authz.assert_effect(h);RETURN result;END IF;
 SELECT * INTO r FROM mem.processing_runs WHERE id=(b->>'processing_run_id')::uuid AND project_id=(c->>'project_id')::uuid AND actor_id=(c->>'actor_id')::uuid FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF r.technical_state='succeeded' THEN RETURN mem.processing_view(h,c,r);END IF;
 IF r.technical_state NOT IN ('succeeded','cancelled') THEN
  INSERT INTO mem.processing_attempt_history(run_id,attempt,fencing_token,inputs,recipe,technical_state,reason) VALUES(r.id,r.attempt,r.fencing_token,r.inputs,r.recipe,r.technical_state,'cancelled') ON CONFLICT DO NOTHING;
  PERFORM authz.assert_effect(h);UPDATE mem.processing_runs SET technical_state='cancelled',fencing_token=gen_random_uuid(),lease_until=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
  PERFORM mem.emit(c,'processing.cancelled',r.id,r.revision,r.id,jsonb_build_object('run_id',r.id,'reason',b->>'reason','external_work_stopped','not_asserted'));
 END IF;
 result:=mem.processing_view(h,c,r)||jsonb_build_object('external_work_state','not_confirmed_stopped');
 RETURN mem.remember_command(c,'cancel_processing',b,d,result);
END $$;

-- Existing retry entry may not turn an empty-input draft into a provenance-bearing execution.
CREATE OR REPLACE FUNCTION mem.retry_processing(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb;c jsonb;r mem.processing_runs;ref jsonb;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;c:=mem.guard(h,'mem.process',d,b);
 SELECT * INTO r FROM mem.processing_runs WHERE id=(b->>'run_id')::uuid AND project_id=(c->>'project_id')::uuid AND actor_id=(c->>'actor_id')::uuid FOR UPDATE;
 IF r.id IS NULL OR r.attempt IS DISTINCT FROM (b->>'expected_attempt')::bigint OR r.technical_state='succeeded' THEN RAISE EXCEPTION 'lease_conflict' USING ERRCODE='40001';END IF;
 IF jsonb_array_length(r.inputs)=0 THEN RETURN mem.processing_view(h,c,r);END IF;
 IF r.lease_until>clock_timestamp() THEN RAISE EXCEPTION 'lease_conflict' USING ERRCODE='40001';END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(r.inputs) LOOP PERFORM mem.assert_version_sources(h,(ref->>'version_id')::uuid,'mem.read');END LOOP;
 PERFORM authz.assert_effect(h);UPDATE mem.processing_runs SET attempt=attempt+1,fencing_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '10 minutes',technical_state='prepared',revision=revision+1,updated_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
 PERFORM mem.emit(c,'processing.retried',r.id,r.revision,r.id,jsonb_build_object('run_id',r.id,'attempt',r.attempt));RETURN mem.processing_view(h,c,r);
END $$;
REVOKE ALL ON FUNCTION mem.processing_mask_json(jsonb,text[]),mem.processing_safe_json(uuid,jsonb),mem.processing_view(uuid,jsonb,mem.processing_runs),mem.begin_processing(uuid,text,text),mem.processing_run(uuid,text,text),mem.resume_processing(uuid,text,text),mem.cancel_processing(uuid,text,text),mem.retry_processing(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.begin_processing(uuid,text,text),mem.processing_run(uuid,text,text),mem.resume_processing(uuid,text,text),mem.cancel_processing(uuid,text,text),mem.retry_processing(uuid,text,text) TO hub2_mem;
RESET ROLE;
