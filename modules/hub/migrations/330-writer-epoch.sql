-- Project-local 2.0 writer authority. This does not stop legacy SQLite writers.
-- Provisioning controls transition state; runtime can only use current authority.
CREATE TABLE coord.writer_authority (
 domain text NOT NULL CHECK(domain IN ('mem','v8')), project_id uuid NOT NULL,
 epoch bigint NOT NULL DEFAULT 1 CHECK(epoch>0), state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','frozen','retired')),
 legacy_cutover_required boolean NOT NULL DEFAULT false, preparation_id uuid,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(domain,project_id)
);
ALTER TABLE coord.writer_authority OWNER TO hub2_evidence_owner;
CREATE TABLE coord.writer_transitions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), domain text NOT NULL, project_id uuid NOT NULL,
 old_epoch bigint NOT NULL, new_epoch bigint NOT NULL, state text NOT NULL, reason jsonb NOT NULL,
 evidence jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(domain,project_id) REFERENCES coord.writer_authority(domain,project_id), UNIQUE(domain,project_id,new_epoch)
);
ALTER TABLE coord.writer_transitions OWNER TO hub2_evidence_owner;
CREATE TABLE coord.writer_preparations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL,
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'), manifest jsonb NOT NULL,
 legacy_stop jsonb, tail_reconciliation jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE coord.writer_preparations OWNER TO hub2_evidence_owner;
ALTER TABLE coord.writer_authority ADD FOREIGN KEY(preparation_id) REFERENCES coord.writer_preparations(id);
REVOKE ALL ON coord.writer_authority,coord.writer_transitions,coord.writer_preparations FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
GRANT USAGE ON SCHEMA authz,mem,public TO hub2_evidence_owner;
GRANT EXECUTE ON FUNCTION public.digest(text,text) TO hub2_evidence_owner;
GRANT SELECT ON authz.handles TO hub2_evidence_owner;
GRANT SELECT ON mem.operations,mem.text_drafts,mem.processing_runs TO hub2_evidence_owner;
ALTER TABLE mem.text_drafts ADD writer_generation bigint NOT NULL DEFAULT 1 CHECK(writer_generation>0);
ALTER TABLE mem.processing_runs ADD writer_generation bigint NOT NULL DEFAULT 1 CHECK(writer_generation>0);

SET ROLE hub2_evidence_owner;
CREATE FUNCTION coord.is_domain_write(domain text,action text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN domain='mem' AND action LIKE 'mem.%' THEN action NOT IN('mem.read','mem.discover','mem.read_history')
 WHEN domain='v8' AND action LIKE 'v8.%' THEN action NOT IN('v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read') ELSE false END $$;
CREATE FUNCTION coord.current_writer(domain_name text,pid uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,coord AS $$
DECLARE w coord.writer_authority;
BEGIN
 IF domain_name NOT IN('mem','v8') OR pid IS NULL THEN RAISE EXCEPTION 'invalid_writer_scope' USING ERRCODE='22023';END IF;
 -- No global lock. Existing rows are read under a shared transaction lock.
 IF NOT EXISTS(SELECT FROM coord.writer_authority WHERE domain=domain_name AND project_id=pid) THEN
  INSERT INTO coord.writer_authority(domain,project_id) VALUES(domain_name,pid) ON CONFLICT DO NOTHING;
 END IF;
 SELECT * INTO w FROM coord.writer_authority WHERE domain=domain_name AND project_id=pid FOR SHARE;
 IF w.state<>'active' THEN RAISE EXCEPTION 'writer_frozen' USING ERRCODE='40001';END IF;
 RETURN w.epoch;
END $$;
CREATE FUNCTION coord.stamp_writer_handle() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,coord AS $$
BEGIN
 IF coord.is_domain_write(NEW.audience,NEW.action) THEN NEW.writer_generation:=coord.current_writer(NEW.audience,NEW.project_id);
 ELSE NEW.writer_generation:=NULL;END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION coord.initialize_project_writers() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,coord AS $$
BEGIN
 INSERT INTO coord.writer_authority(domain,project_id) VALUES('mem',NEW.id),('v8',NEW.id) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE FUNCTION coord.assert_writer_handle(hid uuid,domain_name text,action_name text,body jsonb) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,coord AS $$
DECLARE h authz.handles;generation bigint;candidate mem.operations;draft_generation bigint;run_generation bigint;
BEGIN
 IF NOT coord.is_domain_write(domain_name,action_name) THEN RETURN NULL;END IF;
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF h.id IS NULL OR h.audience<>domain_name OR h.action<>action_name OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'writer_without_guard' USING ERRCODE='42501';END IF;
 generation:=coord.current_writer(domain_name,h.project_id);
 IF h.writer_generation IS DISTINCT FROM generation THEN RAISE EXCEPTION 'writer_epoch_changed' USING ERRCODE='40001';END IF;
 IF domain_name='mem' AND assert_writer_handle.body->>'operation_id' IS NOT NULL THEN
  SELECT * INTO candidate FROM mem.operations WHERE id=(assert_writer_handle.body->>'operation_id')::uuid AND project_id=h.project_id;
  IF candidate.id IS NOT NULL AND candidate.writer_generation<>generation THEN RAISE EXCEPTION 'candidate_writer_epoch_changed' USING ERRCODE='40001';END IF;
 END IF;
 IF domain_name='mem' THEN
  IF assert_writer_handle.body->>'resume_id' IS NOT NULL THEN
   SELECT writer_generation INTO draft_generation FROM mem.text_drafts WHERE id=(assert_writer_handle.body->>'resume_id')::uuid AND project_id=h.project_id;
  ELSIF action_name='mem.upload' AND assert_writer_handle.body->>'idempotency_key' IS NOT NULL THEN
   SELECT writer_generation INTO draft_generation FROM mem.text_drafts WHERE actor_id=h.principal_id AND project_id=h.project_id AND idempotency_key=assert_writer_handle.body->>'idempotency_key';
  END IF;
  IF draft_generation IS NOT NULL AND draft_generation<>generation THEN RAISE EXCEPTION 'draft_writer_epoch_changed' USING ERRCODE='40001';END IF;
  IF action_name='mem.process' AND COALESCE(assert_writer_handle.body->>'processing_run_id',assert_writer_handle.body->>'run_id') IS NOT NULL THEN
   SELECT writer_generation INTO run_generation FROM mem.processing_runs WHERE id=COALESCE(assert_writer_handle.body->>'processing_run_id',assert_writer_handle.body->>'run_id')::uuid AND project_id=h.project_id;
   IF run_generation IS NOT NULL AND run_generation<>generation THEN RAISE EXCEPTION 'processing_writer_epoch_changed' USING ERRCODE='40001';END IF;
  END IF;
 END IF;
 RETURN generation;
END $$;
CREATE FUNCTION coord.stamp_operation_writer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,coord AS $$
DECLARE generation bigint;draft_generation bigint;
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.writer_generation:=coord.current_writer('mem',NEW.project_id);
  IF left(NEW.idempotency_key,5)='text:' THEN
   SELECT d.writer_generation INTO draft_generation FROM mem.text_drafts d WHERE d.project_id=NEW.project_id AND d.actor_id=NEW.actor_id AND NEW.idempotency_key IN('text:'||d.id,'text:'||d.id||':new');
   IF draft_generation IS NOT NULL AND draft_generation<>NEW.writer_generation THEN RAISE EXCEPTION 'draft_writer_epoch_changed' USING ERRCODE='40001';END IF;
  END IF;
 ELSE
  IF NEW.writer_generation IS DISTINCT FROM OLD.writer_generation OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN RAISE EXCEPTION 'operation_writer_immutable' USING ERRCODE='42501';END IF;
  IF NEW.state='published' AND OLD.state<>'published' THEN
   generation:=coord.current_writer('mem',NEW.project_id);
   IF NEW.writer_generation<>generation THEN RAISE EXCEPTION 'candidate_writer_epoch_changed' USING ERRCODE='40001';END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION coord.stamp_durable_candidate_writer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,coord AS $$
DECLARE generation bigint;
BEGIN
 IF TG_OP='INSERT' THEN NEW.writer_generation:=coord.current_writer('mem',NEW.project_id);
 ELSE
  IF NEW.writer_generation IS DISTINCT FROM OLD.writer_generation OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN RAISE EXCEPTION 'durable_candidate_writer_immutable' USING ERRCODE='42501';END IF;
  IF TG_TABLE_NAME='processing_runs' THEN
   IF NEW.technical_state='succeeded' AND OLD.technical_state<>'succeeded' THEN
    generation:=coord.current_writer('mem',NEW.project_id);
    IF NEW.writer_generation<>generation THEN RAISE EXCEPTION 'processing_writer_epoch_changed' USING ERRCODE='40001';END IF;
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
-- These are migration/provisioning functions, not ordinary runtime capabilities.
CREATE FUNCTION coord.transition_writer(domain_name text,pid uuid,expected_epoch bigint,next_state text,reason jsonb,evidence jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,coord AS $$
DECLARE w coord.writer_authority;prep coord.writer_preparations;tid uuid;
BEGIN
 IF domain_name NOT IN('mem','v8') OR pid IS NULL OR next_state NOT IN('active','frozen','retired') OR reason IS NULL OR evidence IS NULL THEN RAISE EXCEPTION 'invalid_writer_transition' USING ERRCODE='22023';END IF;
 SELECT * INTO w FROM coord.writer_authority WHERE domain=domain_name AND project_id=pid FOR UPDATE;
 IF w.domain IS NULL OR w.epoch IS DISTINCT FROM expected_epoch THEN RAISE EXCEPTION 'writer_epoch_conflict' USING ERRCODE='40001';END IF;
 IF w.state='retired' AND next_state<>'retired' THEN RAISE EXCEPTION 'retired_writer_cannot_reactivate' USING ERRCODE='40001';END IF;
 IF next_state='active' AND w.legacy_cutover_required THEN
  SELECT * INTO prep FROM coord.writer_preparations WHERE id=w.preparation_id;
  IF prep.id IS NULL OR prep.project_id<>pid OR COALESCE(prep.legacy_stop->>'artifact_sha256' ~ '^[a-f0-9]{64}$',false) IS DISTINCT FROM true
   OR COALESCE(prep.tail_reconciliation->>'artifact_sha256' ~ '^[a-f0-9]{64}$',false) IS DISTINCT FROM true
   OR prep.legacy_stop->>'observed_at' IS NULL OR prep.tail_reconciliation->>'observed_at' IS NULL
   OR prep.legacy_stop->>'writer_stopped' IS DISTINCT FROM 'true'
   OR prep.tail_reconciliation->>'reconciled' IS DISTINCT FROM 'true'
   OR prep.tail_reconciliation->>'manifest_sha256' IS DISTINCT FROM prep.manifest_sha256 THEN
   RAISE EXCEPTION 'legacy_cutover_evidence_missing_hold' USING ERRCODE='40001';
  END IF;
 END IF;
 UPDATE coord.writer_authority SET epoch=epoch+1,state=next_state,changed_at=clock_timestamp() WHERE domain=domain_name AND project_id=pid;
 INSERT INTO coord.writer_transitions(domain,project_id,old_epoch,new_epoch,state,reason,evidence) VALUES(domain_name,pid,w.epoch,w.epoch+1,next_state,reason,evidence) RETURNING id INTO tid;
 RETURN jsonb_build_object('project_id',pid,'domain',domain_name,'epoch',w.epoch+1,'state',next_state,'transition_id',tid,'confirmed_2_0_data','preserved');
END $$;
CREATE FUNCTION coord.prepare_legacy_writer(pid uuid,manifest_sha text,manifest_text text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,coord AS $$
DECLARE prep uuid;w coord.writer_authority;domain_name text;manifest_body jsonb;
BEGIN
 manifest_body:=manifest_text::jsonb;
 IF pid IS NULL OR manifest_text IS NULL OR manifest_sha IS NULL OR encode(public.digest(manifest_text,'sha256'),'hex')<>manifest_sha THEN RAISE EXCEPTION 'manifest_digest_mismatch' USING ERRCODE='22023';END IF;
 INSERT INTO coord.writer_preparations(project_id,manifest_sha256,manifest) VALUES(pid,manifest_sha,manifest_body) RETURNING id INTO prep;
 FOREACH domain_name IN ARRAY ARRAY['mem','v8'] LOOP
  INSERT INTO coord.writer_authority(domain,project_id) VALUES(domain_name,pid) ON CONFLICT DO NOTHING;
  SELECT * INTO w FROM coord.writer_authority WHERE domain=domain_name AND project_id=pid FOR UPDATE;
  PERFORM coord.transition_writer(domain_name,pid,w.epoch,'frozen',jsonb_build_object('preparation_id',prep),'{"cutover":"hold_until_external_evidence"}');
  UPDATE coord.writer_authority SET legacy_cutover_required=true,preparation_id=prep WHERE domain=domain_name AND project_id=pid;
 END LOOP;
 RETURN jsonb_build_object('preparation_id',prep,'state','hold','legacy_writer_enforced',false,'next_step','collect_external_writer_stop_and_tail_evidence');
END $$;
REVOKE ALL ON FUNCTION coord.is_domain_write(text,text),coord.current_writer(text,uuid),coord.stamp_writer_handle(),coord.initialize_project_writers(),coord.assert_writer_handle(uuid,text,text,jsonb),coord.stamp_operation_writer(),coord.stamp_durable_candidate_writer(),coord.transition_writer(text,uuid,bigint,text,jsonb,jsonb),coord.prepare_legacy_writer(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION coord.assert_writer_handle(uuid,text,text,jsonb) TO hub2_mem_owner,hub2_v8_owner;
RESET ROLE;
-- Handle trigger stamps at issuance; guard rejects an unconsumed handle across epochs.
ALTER TABLE authz.handles ADD writer_generation bigint CHECK(writer_generation>0);
CREATE TRIGGER handle_writer_epoch BEFORE INSERT ON authz.handles FOR EACH ROW EXECUTE FUNCTION coord.stamp_writer_handle();
CREATE TRIGGER project_writer_initialize AFTER INSERT ON v8.projects FOR EACH ROW EXECUTE FUNCTION coord.initialize_project_writers();
CREATE TRIGGER operation_writer_epoch BEFORE INSERT OR UPDATE ON mem.operations FOR EACH ROW EXECUTE FUNCTION coord.stamp_operation_writer();
CREATE TRIGGER text_draft_writer_epoch BEFORE INSERT OR UPDATE ON mem.text_drafts FOR EACH ROW EXECUTE FUNCTION coord.stamp_durable_candidate_writer();
CREATE TRIGGER processing_writer_epoch BEFORE INSERT OR UPDATE ON mem.processing_runs FOR EACH ROW EXECUTE FUNCTION coord.stamp_durable_candidate_writer();
INSERT INTO coord.writer_authority(domain,project_id) SELECT d.domain,p.id FROM v8.projects p CROSS JOIN (VALUES('mem'),('v8')) d(domain) ON CONFLICT DO NOTHING;

-- 331 dynamic-role integration must keep these calls when replacing guards.
SET ROLE hub2_mem_owner;
CREATE OR REPLACE FUNCTION mem.guard(h uuid,a text,d text,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE c jsonb;BEGIN
 IF session_user NOT IN('hub2_mem','hub2_worker') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 c:=authz.consume_handle(h,a,d);PERFORM authz.assert_request_resource(h,b);PERFORM mem.bind_request_sources(h,b,(c->>'actor_id')::uuid,a);
 PERFORM coord.assert_writer_handle(h,'mem',a,b);PERFORM authz.assert_effect(h);RETURN c;
END $$;
CREATE OR REPLACE FUNCTION mem.guard(h uuid,a text,d text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE c jsonb;BEGIN
 IF session_user NOT IN('hub2_mem','hub2_worker') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 c:=authz.consume_handle(h,a,d);PERFORM authz.assert_request_resource(h,c->'resource');PERFORM mem.bind_request_sources(h,c->'resource',(c->>'actor_id')::uuid,a);
 PERFORM coord.assert_writer_handle(h,'mem',a,c->'resource');PERFORM authz.assert_effect(h);RETURN c;
END $$;
REVOKE ALL ON FUNCTION mem.guard(uuid,text,text,jsonb),mem.guard(uuid,text,text) FROM PUBLIC;
RESET ROLE;
SET ROLE hub2_v8_owner;
CREATE OR REPLACE FUNCTION v8.guard(h uuid,a text,d text,b jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,v8 AS $$
DECLARE c jsonb;BEGIN
 IF session_user<>'hub2_v8' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 c:=authz.consume_handle(h,a,d);PERFORM authz.assert_request_resource(h,b);PERFORM mem.bind_request_sources(h,b,(c->>'actor_id')::uuid,a);
 IF (b->>'project_id')::uuid IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 PERFORM coord.assert_writer_handle(h,'v8',a,b);RETURN c;
END $$;
REVOKE ALL ON FUNCTION v8.guard(uuid,text,text,jsonb) FROM PUBLIC;
RESET ROLE;
