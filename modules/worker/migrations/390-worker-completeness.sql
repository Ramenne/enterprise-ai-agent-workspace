-- Deterministic transport/index completeness. No member grants or semantic policy.
GRANT SELECT ON v8.work_items,v8.work_updates,v8.operations TO hub2_evidence_owner;
SET ROLE hub2_evidence_owner;
CREATE TABLE evidence.transport_recovery_receipts (
 event_id uuid PRIMARY KEY REFERENCES evidence.outbox(id),domain text NOT NULL,aggregate_id uuid NOT NULL,
 aggregate_revision bigint NOT NULL,source_operation_id uuid NOT NULL,source_update_id uuid NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256~'^[a-f0-9]{64}$'),basis text NOT NULL,
 recovered_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(domain,aggregate_id,aggregate_revision)
);
REVOKE ALL ON evidence.transport_recovery_receipts FROM PUBLIC,hub2_worker,hub2_mem,hub2_v8,hub2_hufu;
CREATE FUNCTION evidence.derived_event_kind(domain_name text,event_name text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN domain_name='mem' AND event_name IN('material.published','material.restored') THEN 'index'
 WHEN event_name LIKE '%invalidat%' OR event_name LIKE '%revok%' OR event_name LIKE '%convert%'
  OR(domain_name='v8' AND event_name IN('work.recorded','work.committed','adoption.changed')) THEN 'projection_invalidation' ELSE NULL END $$;
CREATE FUNCTION evidence.task_priority(kind_name text) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE kind_name WHEN 'index' THEN 100 WHEN 'projection_invalidation' THEN 90 WHEN 'verification_compensation' THEN 80 ELSE 0 END $$;
CREATE OR REPLACE FUNCTION evidence.ready_tasks(n integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
DECLARE r jsonb;BEGIN
 IF n IS NULL OR n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_limit';END IF;PERFORM evidence.worker_guard('worker.maintenance');
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO r FROM (
  SELECT id,kind,attempt,evidence.task_priority(kind) broker_priority FROM jobs.tasks
  WHERE(state IN('pending','retry')AND run_after<=clock_timestamp())OR(state='running'AND lease_until<=clock_timestamp())
  ORDER BY evidence.task_priority(kind) DESC,run_after,created_at,id LIMIT n)x;
 RETURN r;
END $$;
CREATE FUNCTION evidence.ack_transport_tasks(n integer DEFAULT 500) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
DECLARE t jobs.tasks;eid uuid;total integer:=0;
BEGIN
 IF n IS NULL OR n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_limit';END IF;PERFORM evidence.worker_guard('worker.maintenance');
 FOR t IN SELECT task.* FROM jobs.tasks task JOIN evidence.outbox e ON task.dedupe_key='event:'||e.id
  JOIN evidence.delivery d ON d.event_id=e.id JOIN evidence.inbox i ON i.event_id=e.id AND i.consumer='worker-projection'
  JOIN evidence.projection p ON p.consumer=i.consumer AND p.domain=e.domain AND p.aggregate_id=e.aggregate_id
  WHERE task.kind='maintenance' AND task.state IN('pending','retry') AND task.attempt=0
   AND task.payload->>'event_id'=e.id::text AND task.payload->>'domain'=e.domain
   AND task.payload->>'aggregate_id'=e.aggregate_id::text
   AND task.payload->>'project_id' IS NOT DISTINCT FROM e.project_id::text
   AND task.payload->>'revision'=e.aggregate_revision::text
   AND evidence.derived_event_kind(e.domain,e.event_type) IS NULL
   AND p.state='current' AND p.revision>=e.aggregate_revision
  ORDER BY task.created_at,task.id LIMIT n FOR UPDATE OF task SKIP LOCKED LOOP
  PERFORM evidence.worker_guard('worker.maintenance');
  UPDATE jobs.tasks SET state='done',result=jsonb_build_object('state','transport_acknowledged','coverage','actual_delivered_event_already_in_current_projection;no_domain_effect_required','semantic_work','not_inferred'),error_code=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=t.id;
  total:=total+1;
 END LOOP;
 RETURN jsonb_build_object('acknowledged',total,'coverage','verified_transport_only');
END $$;
CREATE FUNCTION evidence.backfill_derived_tasks(n integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
DECLARE e evidence.outbox;total integer:=0;added integer;desired text;current_task jobs.tasks;
BEGIN
 IF n IS NULL OR n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_limit';END IF;PERFORM evidence.worker_guard('worker.maintenance');
 FOR e IN SELECT o.* FROM evidence.outbox o JOIN evidence.delivery d ON d.event_id=o.id
  WHERE evidence.derived_event_kind(o.domain,o.event_type) IS NOT NULL
   AND NOT EXISTS(SELECT FROM jobs.tasks t WHERE t.payload->>'event_id'=o.id::text AND t.kind=evidence.derived_event_kind(o.domain,o.event_type))
   AND NOT EXISTS(SELECT FROM evidence.outbox part WHERE part.domain=o.domain AND part.aggregate_id=o.aggregate_id AND part.aggregate_revision=o.aggregate_revision AND part.delivered_at IS NULL)
   AND (SELECT count(*)=min(group_size) AND min(group_size)=max(group_size) AND count(DISTINCT event_group)=1 AND min(group_index)=1 AND max(group_index)=max(group_size) FROM evidence.outbox parts WHERE parts.domain=o.domain AND parts.aggregate_id=o.aggregate_id AND parts.aggregate_revision=o.aggregate_revision)
  ORDER BY d.seq LIMIT n LOOP
  PERFORM evidence.worker_guard('worker.maintenance');
  desired:=evidence.derived_event_kind(e.domain,e.event_type);
  SELECT * INTO current_task FROM jobs.tasks WHERE dedupe_key='event:'||e.id FOR UPDATE;
  IF current_task.id IS NULL THEN
   INSERT INTO jobs.tasks(kind,dedupe_key,payload) VALUES(desired,'event:'||e.id,jsonb_build_object('event_id',e.id,'domain',e.domain,'aggregate_id',e.aggregate_id,'project_id',e.project_id,'revision',e.aggregate_revision)) ON CONFLICT(dedupe_key) DO NOTHING;
   GET DIAGNOSTICS added=ROW_COUNT;
  ELSIF current_task.kind='maintenance' AND current_task.state IN('pending','retry') AND current_task.attempt=0 THEN
   UPDATE jobs.tasks SET kind=desired,updated_at=clock_timestamp() WHERE id=current_task.id;added:=1;
  ELSIF current_task.kind='maintenance' AND current_task.state='done' THEN
   INSERT INTO jobs.tasks(kind,dedupe_key,payload) VALUES(desired,'derive390:'||e.id,jsonb_build_object('event_id',e.id,'domain',e.domain,'aggregate_id',e.aggregate_id,'project_id',e.project_id,'revision',e.aggregate_revision)) ON CONFLICT(dedupe_key) DO NOTHING;
   GET DIAGNOSTICS added=ROW_COUNT;
  ELSE added:=0;END IF;
  total:=total+added;
 END LOOP;
 RETURN jsonb_build_object('enqueued',total,'coverage','real_complete_delivered_event_groups_only');
END $$;
CREATE FUNCTION evidence.recover_compound_creation(n integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
DECLARE source record;eid uuid;total integer:=0;
BEGIN
 IF n IS NULL OR n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_limit';END IF;PERFORM evidence.worker_guard('worker.maintenance');
 -- The committed create-command receipt and first immutable update prove creation.
 -- Do not reset arbitrary gaps or invent an original creation narrative/snapshot.
 FOR source IN SELECT w.id,w.project_id,u.id update_id,u.sha256,o.id operation_id FROM v8.work_items w
  JOIN v8.work_updates u ON u.work_item_id=w.id AND u.work_revision=2
  JOIN v8.operations o ON o.id=u.id AND o.action='work_save' AND o.state='committed'
  WHERE u.payload->>'previous_revision'='1' AND NOT(u.payload?'work_item_id')
   AND u.payload->>'project_id'=w.project_id::text AND o.project_id=w.project_id
   AND o.result->>'work_item_id'=w.id::text AND o.actor_id=w.actor_id AND o.client_id=w.client_id
   AND u.actor_id=w.actor_id AND u.client_id=w.client_id
   AND encode(public.digest(u.canonical_text,'sha256'),'hex')=u.sha256
   AND u.canonical_text::jsonb=u.payload
   AND NOT EXISTS(SELECT FROM evidence.outbox e WHERE e.domain='v8' AND e.aggregate_id=w.id AND e.aggregate_revision=1)
  ORDER BY w.created_at,w.id LIMIT n LOOP
  PERFORM evidence.worker_guard('worker.maintenance');eid:=NULL;
  INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload)
   VALUES('v8',source.id,1,'work.creation_recovered',source.project_id,jsonb_build_object('recovery_basis','committed_create_receipt_and_first_fixed_update','original_creation_event_missing',true,'source_operation_id',source.operation_id,'source_update_id',source.update_id,'source_sha256',source.sha256,'semantic_impact','not_assessed'))
   ON CONFLICT DO NOTHING RETURNING id INTO eid;
  IF eid IS NOT NULL THEN
   INSERT INTO evidence.transport_recovery_receipts(event_id,domain,aggregate_id,aggregate_revision,source_operation_id,source_update_id,source_sha256,basis) VALUES(eid,'v8',source.id,1,source.operation_id,source.update_id,source.sha256,'committed_create_receipt_and_first_fixed_update');total:=total+1;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('recovered',total,'coverage','only_proved_missing_compound_creation;other_gaps_preserved');
END $$;
REVOKE ALL ON FUNCTION evidence.derived_event_kind(text,text),evidence.task_priority(text),evidence.ack_transport_tasks(integer),evidence.backfill_derived_tasks(integer),evidence.recover_compound_creation(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.ack_transport_tasks(integer),evidence.backfill_derived_tasks(integer),evidence.recover_compound_creation(integer),evidence.ready_tasks(integer) TO hub2_worker;
RESET ROLE;

SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.index_publication_scope(event_body jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,mem AS $$
DECLARE e evidence.outbox;v mem.content_versions;m mem.materials;o mem.verified_objects;op mem.operations;ref jsonb;version uuid;
BEGIN
 SELECT * INTO e FROM jsonb_populate_record(NULL::evidence.outbox,event_body);
 IF e.id IS NULL OR e.domain IS DISTINCT FROM 'mem' OR e.event_type NOT IN('material.published','material.restored') THEN RAISE EXCEPTION 'index_publication_not_delivered' USING ERRCODE='42501';END IF;
 version:=coalesce(e.payload->>'version_id',e.payload->'fixed_refs'->0->>'version_id')::uuid;
 SELECT * INTO v FROM mem.content_versions WHERE id=version AND material_id=e.aggregate_id;
 SELECT * INTO m FROM mem.materials WHERE id=e.aggregate_id;
 IF v.id IS NULL OR m.id IS NULL OR m.project_id IS DISTINCT FROM e.project_id THEN RAISE EXCEPTION 'index_publication_scope_mismatch' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM mem.verified_objects WHERE id=v.object_id AND sha256=v.sha256 AND size=v.size AND availability='available';
 IF o.id IS NULL THEN RAISE EXCEPTION 'index_object_unavailable' USING ERRCODE='42501';END IF;
 IF e.event_type='material.published' THEN
  ref:=e.payload->'fixed_refs'->0;
  SELECT * INTO op FROM mem.operations WHERE id=(e.payload->>'operation_id')::uuid AND state='published' AND result_version_id=v.id AND material_id=m.id AND project_id=m.project_id AND actor_id=v.actor_id AND object_id=o.id AND expected_hash=v.sha256 AND expected_size=v.size;
  IF op.id IS NULL OR ref->>'material_id' IS DISTINCT FROM m.id::text OR ref->>'version_id' IS DISTINCT FROM v.id::text OR ref->>'sha256' IS DISTINCT FROM v.sha256 OR ref->>'size' IS DISTINCT FROM v.size::text OR op.receipt IS DISTINCT FROM e.payload THEN RAISE EXCEPTION 'index_publication_fixed_ref_mismatch' USING ERRCODE='42501';END IF;
 ELSE
  IF v.reason<>'compensating_restore' OR NOT EXISTS(SELECT FROM mem.command_receipts r WHERE r.action='restore_content' AND r.actor_id=v.actor_id AND r.result->>'domain_revision'=e.aggregate_revision::text AND r.result->'fixed_refs'->0->>'material_id'=m.id::text AND r.result->'fixed_refs'->0->>'version_id'=v.id::text AND r.result->'fixed_refs'->0->>'sha256'=v.sha256 AND r.result->'fixed_refs'->0->>'size'=v.size::text) THEN RAISE EXCEPTION 'index_restore_receipt_missing' USING ERRCODE='42501';END IF;
 END IF;
 RETURN jsonb_build_object('project_id',m.project_id,'material_id',m.id,'version_id',v.id,'sha256',v.sha256,'size',v.size,'object',jsonb_build_object('provider',o.provider,'bucket',o.bucket,'key',o.object_key,'versionId',o.provider_version_id),'scope_basis','real_delivered_publication_and_committed_fixed_ref');
END $$;
CREATE OR REPLACE FUNCTION mem.worker_index_input(id uuid,attempt bigint,fence uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE p jsonb;e jsonb;
BEGIN
 p:=evidence.assert_task(id,attempt,fence);e:=evidence.task_event(id,attempt,fence,'mem');
 IF p->>'kind'<>'index' OR p->'payload'->>'domain' IS DISTINCT FROM 'mem' OR p->'payload'->>'project_id' IS DISTINCT FROM e->>'project_id' THEN RAISE EXCEPTION 'index_task_scope_mismatch' USING ERRCODE='42501';END IF;
 RETURN mem.index_publication_scope(e);
END $$;
REVOKE ALL ON FUNCTION mem.index_publication_scope(jsonb) FROM PUBLIC,hub2_worker,hub2_mem,hub2_v8,hub2_hufu;
REVOKE ALL ON FUNCTION mem.worker_index_input(uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.worker_index_input(uuid,bigint,uuid) TO hub2_worker;
RESET ROLE;

SET ROLE hub2_evidence_owner;
CREATE OR REPLACE FUNCTION evidence.consume_batch(c text,n integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
DECLARE e record;r record;p evidence.projection;applied integer:=0;replayed integer:=0;water bigint;floor bigint;g record;
BEGIN
 IF c IS NULL OR n IS NULL OR n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_consumer_input';END IF;
 PERFORM evidence.worker_guard('worker.consume');
 IF NOT EXISTS(SELECT FROM evidence.consumers WHERE name=c AND active) THEN RAISE EXCEPTION 'unknown_consumer' USING ERRCODE='42501';END IF;
 SELECT scanned_seq INTO water FROM evidence.consumer_progress WHERE consumer=c FOR UPDATE;
 SELECT retained_after INTO floor FROM evidence.stream_state WHERE id;
 IF water<floor THEN UPDATE evidence.projection SET state='resync_required' WHERE consumer=c;RETURN jsonb_build_object('state','resync_required','retained_state','projection_preserved');END IF;
 FOR e IN SELECT d.seq,o.* FROM evidence.delivery d JOIN evidence.outbox o ON o.id=d.event_id WHERE d.seq>water ORDER BY d.seq LIMIT n LOOP
  INSERT INTO evidence.projection(consumer,domain,aggregate_id,project_id) VALUES(c,e.domain,e.aggregate_id,e.project_id) ON CONFLICT DO NOTHING;
  IF EXISTS(SELECT FROM evidence.projection pp WHERE pp.consumer=c AND pp.domain=e.domain AND pp.aggregate_id=e.aggregate_id AND pp.revision>=e.aggregate_revision) THEN INSERT INTO evidence.inbox(consumer,event_id) VALUES(c,e.id) ON CONFLICT DO NOTHING;replayed:=replayed+1;END IF;
  water:=e.seq;
 END LOOP;
 -- Revisit every pending aggregate, including rows behind scanned_seq. Cursor is not aggregate causality.
 FOR p IN SELECT * FROM evidence.projection WHERE consumer=c ORDER BY domain,aggregate_id FOR UPDATE LOOP
  FOR r IN SELECT o.aggregate_revision,count(*) count,min(o.group_size) size,max(o.group_size) max_size,count(DISTINCT o.event_group) groups,min(o.group_index) first,max(o.group_index) last,array_agg(o.event_type ORDER BY o.group_index) types,max(d.seq) seq FROM evidence.delivery d JOIN evidence.outbox o ON o.id=d.event_id WHERE o.domain=p.domain AND o.aggregate_id=p.aggregate_id AND d.seq<=water AND o.aggregate_revision>p.revision GROUP BY o.aggregate_revision ORDER BY o.aggregate_revision LOOP
   IF r.aggregate_revision<>p.revision+1 THEN UPDATE evidence.projection SET state='gap' WHERE consumer=c AND domain=p.domain AND aggregate_id=p.aggregate_id;EXIT;END IF;
   IF r.count<>r.size OR r.size<>r.max_size OR r.groups<>1 OR r.first<>1 OR r.last<>r.size THEN UPDATE evidence.projection SET state='incomplete_group' WHERE consumer=c AND domain=p.domain AND aggregate_id=p.aggregate_id;EXIT;END IF;
   PERFORM evidence.worker_guard('worker.consume');
   FOR g IN SELECT o.id,o.event_type FROM evidence.delivery d JOIN evidence.outbox o ON o.id=d.event_id WHERE o.domain=p.domain AND o.aggregate_id=p.aggregate_id AND o.aggregate_revision=r.aggregate_revision AND d.seq<=water LOOP
    INSERT INTO evidence.inbox(consumer,event_id) VALUES(c,g.id) ON CONFLICT DO NOTHING;
    IF FOUND THEN applied:=applied+1; ELSE replayed:=replayed+1; END IF;
    IF evidence.derived_event_kind(p.domain,g.event_type) IS NOT NULL THEN
     INSERT INTO jobs.tasks(kind,dedupe_key,payload) VALUES(evidence.derived_event_kind(p.domain,g.event_type),'event:'||g.id,jsonb_build_object('event_id',g.id,'domain',p.domain,'aggregate_id',p.aggregate_id,'project_id',p.project_id,'revision',r.aggregate_revision)) ON CONFLICT(dedupe_key) DO NOTHING;
    END IF;
   END LOOP;
   UPDATE evidence.projection SET revision=r.aggregate_revision,state='current',event_types=r.types,last_seq=r.seq,updated_at=clock_timestamp() WHERE consumer=c AND domain=p.domain AND aggregate_id=p.aggregate_id;
   p.revision:=r.aggregate_revision;
  END LOOP;
 END LOOP;
 UPDATE evidence.consumer_progress SET scanned_seq=water,replay_count=replay_count+replayed,gap_count=(SELECT count(*) FROM evidence.projection WHERE consumer=c AND state IN ('gap','incomplete_group')) WHERE consumer=c;
 RETURN jsonb_build_object('state','consumed','applied',applied,'replayed',replayed,'scanned_seq',water);
END $$;
RESET ROLE;
SET ROLE hub2_v8_owner;
CREATE OR REPLACE FUNCTION v8.write_work(h uuid,d text,b jsonb,c jsonb,command text,allow_create boolean) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,v8 AS $$
DECLARE r jsonb;o uuid:=gen_random_uuid();w v8.work_items;target v8.work_items;ref jsonb;rel jsonb;basis jsonb;delivery jsonb;source jsonb;outputs jsonb;facts jsonb;artifacts jsonb:='[]';warnings jsonb:='[]';assessment text;enrichment jsonb:='[]';claim text;is_new boolean:=false;mode text;note jsonb;prior jsonb;hash text;context_result jsonb:='{}';BEGIN
 r:=v8.replay(c,command,b,d);IF r IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN r;END IF;
 IF b->>'work_item_id' IS NULL THEN
  IF NOT allow_create THEN RAISE EXCEPTION 'work_item_required';END IF;is_new:=true;PERFORM authz.assert_effect(h);
  INSERT INTO v8.work_items(id,project_id,actor_id,client_id,source_context_id,goal,description) VALUES(gen_random_uuid(),(c->>'project_id')::uuid,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'source_context_id')::uuid,COALESCE(b->>'goal',b->>'summary','目标尚未说明'),COALESCE(b->>'description','')) RETURNING * INTO w;
  INSERT INTO v8.work_executions(work_item_id,actor_id,client_id,source_context_id) VALUES(w.id,w.actor_id,w.client_id,w.source_context_id);
  -- Creation and first update are two real revisions in this same guarded transaction.
  PERFORM v8.emit(c,'work.opened',w.id,w.event_revision,o,jsonb_build_object('short_no',w.short_no,'creation_route','compound_work_save'));
 ELSE w:=v8.lock_work(c,(b->>'work_item_id')::uuid);END IF;
 IF b->>'expected_revision' IS NOT NULL AND w.revision<>(b->>'expected_revision')::bigint THEN RETURN v8.remember(c,command,b,d,o,jsonb_build_object('state','conflict','domain_revision',w.revision,'error_code','revision_conflict','candidate',b,'retained_state','candidate_and_originals_preserved','next_step','compare_current_updates_or_rebase'));END IF;
 mode:=CASE WHEN is_new OR b->>'expected_revision' IS NOT NULL THEN 'cas' ELSE 'append_only' END;
 IF mode='cas' AND NOT is_new THEN prior:=to_jsonb(w)||jsonb_build_object('fixed_refs',(SELECT COALESCE(jsonb_agg(jsonb_build_object('material_id',material_id,'version_id',version_id,'sha256',sha256,'role',role)),'[]') FROM v8.results WHERE work_item_id=w.id));PERFORM authz.assert_effect(h);INSERT INTO v8.work_snapshots(work_item_id,work_revision,record,canonical_text,sha256) VALUES(w.id,w.revision,prior,v8.canonical_json(prior),encode(public.digest(v8.canonical_json(prior),'sha256'),'hex')) ON CONFLICT DO NOTHING;END IF;
 outputs:=COALESCE(b->'outputs','[]');assessment:=COALESCE(b->>'related_assessment',CASE WHEN b->'related_evaluated'='true'::jsonb THEN 'assessed' ELSE 'unassessed' END);IF assessment NOT IN('assessed','partial','unassessed') THEN RAISE EXCEPTION 'invalid_assessment_state';END IF;
 claim:=COALESCE(b->>'completion_state',CASE WHEN command='work_commit' THEN 'completed' ELSE 'in_progress' END);IF claim NOT IN('open','in_progress','completed','cancelled') THEN RAISE EXCEPTION 'invalid_completion_claim';END IF;
 IF b->'explanation' IS NULL OR b->'explanation'='{}'::jsonb THEN enrichment:=enrichment||jsonb_build_array('explanation');END IF;IF assessment<>'assessed' THEN enrichment:=enrichment||jsonb_build_array('relationship_assessment');END IF;IF COALESCE(b->>'goal','')='' AND is_new THEN enrichment:=enrichment||jsonb_build_array('goal');END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(outputs) LOOP PERFORM v8.assert_ref(c,ref);facts:=v8.reference_facts(ref);artifacts:=artifacts||jsonb_build_array(facts);IF facts->>'artifact_availability'<>'available' THEN IF NOT enrichment ? 'artifact_availability' THEN enrichment:=enrichment||jsonb_build_array('artifact_availability');END IF;warnings:=warnings||jsonb_build_array(jsonb_build_object('code','fixed_artifact_current_bytes_unavailable','version_id',ref->'version_id','artifact_availability',facts->'artifact_availability','next_step','agent_may_use_known_copy_or_restore_object_without_changing_fixed_reference'));END IF;IF EXISTS(SELECT 1 FROM mem.content_versions WHERE id=(ref->>'version_id')::uuid AND provenance_state='pending') AND NOT enrichment ? 'source_provenance' THEN enrichment:=enrichment||jsonb_build_array('source_provenance');END IF;PERFORM authz.assert_effect(h);INSERT INTO v8.results(work_item_id,material_id,version_id,sha256,role,explanation,created_by) VALUES(w.id,(ref->>'material_id')::uuid,(ref->>'version_id')::uuid,ref->>'sha256',COALESCE(ref->>'role','result'),COALESCE(b->'explanation','{}'),(c->>'actor_id')::uuid);END LOOP;
 FOR ref IN SELECT value FROM v8.ref_inputs(b->'explanation') AS input(value) LOOP PERFORM v8.assert_ref(c,ref);END LOOP;
 FOR rel IN SELECT value FROM jsonb_array_elements(COALESCE(b->'related','[]')) LOOP
  SELECT * INTO target FROM v8.work_items WHERE id=(rel->>'work_item_id')::uuid;
  IF target.id IS NULL OR target.id=w.id OR NOT authz.can_read((c->>'actor_id')::uuid,target.project_id) THEN RAISE EXCEPTION 'relation_target_forbidden' USING ERRCODE='42501';END IF;
  basis:=COALESCE(rel->'basis','{}');delivery:=jsonb_build_object('declared_use',COALESCE(basis->>'use_origin','agent_declared'),'work_delivery',CASE WHEN basis->>'work_read_receipt_id' IS NULL THEN 'not_provided' WHEN EXISTS(SELECT 1 FROM v8.work_read_receipts receipt WHERE receipt.id=(basis->>'work_read_receipt_id')::uuid AND receipt.actor_id=(c->>'actor_id')::uuid AND receipt.client_id=(c->>'client_id')::uuid AND receipt.work_item_id=target.id AND receipt.state IN('sent','acknowledged')) THEN 'verified_service_delivery' ELSE 'unverified_claim' END,'ref_deliveries','[]'::jsonb);
  FOR source IN SELECT value FROM jsonb_array_elements(COALESCE(basis->'refs','[]')) LOOP ref:=COALESCE(source->'fixed_ref',source);PERFORM v8.assert_ref(c,ref);delivery:=jsonb_set(delivery,'{ref_deliveries}',(delivery->'ref_deliveries')||jsonb_build_array(jsonb_build_object('version_id',ref->'version_id','service_delivery',CASE WHEN source->>'read_receipt_id' IS NULL THEN 'not_provided' WHEN mem.delivered_ref((c->>'actor_id')::uuid,(c->>'client_id')::uuid,(source->>'read_receipt_id')::uuid,(ref->>'material_id')::uuid,(ref->>'version_id')::uuid,ref->>'sha256') THEN 'verified' ELSE 'unverified_claim' END)));END LOOP;
  IF rel ? 'supersedes' AND NOT EXISTS(SELECT 1 FROM v8.work_relations WHERE id=(rel->>'supersedes')::uuid AND ((from_work_id=w.id AND to_work_id=target.id) OR (to_work_id=w.id AND from_work_id=target.id))) THEN RAISE EXCEPTION 'invalid_relation_correction';END IF;
  PERFORM authz.assert_effect(h);INSERT INTO v8.work_relations(from_work_id,to_work_id,basis,actor_id,source_context_id,supersedes,state) VALUES(w.id,target.id,basis||jsonb_build_object('infrastructure_evidence',delivery),(c->>'actor_id')::uuid,(c->>'source_context_id')::uuid,(rel->>'supersedes')::uuid,COALESCE(rel->>'state','active'));
 END LOOP;
 note:=b-'idempotency_key'||jsonb_build_object('completion_claim',claim,'related_assessment',assessment,'pending_enrichment',enrichment,'write_mode',mode,'previous_revision',w.revision);
 hash:=encode(public.digest(v8.canonical_json(note),'sha256'),'hex');PERFORM authz.assert_effect(h);
 UPDATE v8.work_items SET description=CASE WHEN mode='cas' THEN COALESCE(b->>'summary',description) ELSE description END,explanation=CASE WHEN mode='cas' THEN COALESCE(b->'explanation',explanation) ELSE explanation END,goal=CASE WHEN mode='cas' THEN COALESCE(b->>'goal',goal) ELSE goal END,state=CASE WHEN mode='cas' THEN claim ELSE state END,related_assessment=CASE WHEN mode='cas' THEN assessment ELSE related_assessment END,related_evaluated=CASE WHEN mode='cas' THEN assessment='assessed' ELSE related_evaluated END,pending_enrichment=CASE WHEN mode='cas' THEN enrichment ELSE pending_enrichment END,completed_receipt_id=CASE WHEN mode='cas' AND claim='completed' THEN o ELSE completed_receipt_id END,revision=revision+1,event_revision=event_revision+1,updated_at=clock_timestamp() WHERE id=w.id RETURNING * INTO w;
 INSERT INTO v8.work_updates(id,work_item_id,work_revision,actor_id,client_id,source_context_id,payload,canonical_text,sha256) VALUES(o,w.id,w.revision,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'source_context_id')::uuid,note,v8.canonical_json(note),hash);
 IF b ? 'context' AND b->'context'<>'false'::jsonb THEN context_result:=v8.build_context(h,c,w,CASE WHEN jsonb_typeof(b->'context')='object' THEN b->'context' ELSE '{}'::jsonb END,o);END IF;
 PERFORM v8.emit(c,'work.recorded',w.id,w.event_revision,o,jsonb_build_object('work_revision',w.revision,'update_id',o,'update_hash',hash,'completion_claim',claim));
 r:=jsonb_build_object('state',CASE WHEN command='work_commit' THEN claim ELSE 'saved' END,'work_item_id',w.id,'short_no',w.short_no,'domain_revision',w.revision,'fixed_refs',outputs,'artifact_availability',artifacts,'warnings',warnings,'completion_claim',claim,'related_assessment',assessment,'pending_enrichment',enrichment,'update_id',o,'update_hash',hash,'write_mode',mode,'receipt',jsonb_build_object('receipt_id',o,'registration','committed','fixed_reference_integrity','verified_registry_identity','current_byte_delivery','not_asserted','completion','agent_declared','quality','agent_judgment','external_execution','not_asserted','formal_completion',claim='completed','statement_hash',hash))||context_result;
 RETURN v8.remember(c,command,b,d,o,r);
END $$;
RESET ROLE;

SET ROLE hub2_evidence_owner;
CREATE OR REPLACE FUNCTION evidence.task_event(id uuid,attempt bigint,fence uuid,domain text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
#variable_conflict use_variable
DECLARE proof jsonb;e evidence.outbox;
BEGIN
 IF domain IS NULL OR domain NOT IN('mem','v8','authz') THEN RAISE EXCEPTION 'invalid_domain';END IF;
 proof:=evidence.assert_task(id,attempt,fence);
 SELECT * INTO e FROM evidence.outbox event WHERE event.id=(proof->'payload'->>'event_id')::uuid AND event.domain=domain AND event.domain=proof->'payload'->>'domain' AND event.aggregate_id=(proof->'payload'->>'aggregate_id')::uuid AND event.aggregate_revision=(proof->'payload'->>'revision')::bigint AND event.project_id::text IS NOT DISTINCT FROM proof->'payload'->>'project_id';
 IF e.id IS NULL OR NOT EXISTS(SELECT FROM evidence.delivery WHERE event_id=e.id) THEN RAISE EXCEPTION 'task_event_scope_mismatch' USING ERRCODE='42501';END IF;
 IF NOT(SELECT count(*)=min(group_size) AND min(group_size)=max(group_size) AND count(DISTINCT event_group)=1 AND min(group_index)=1 AND max(group_index)=max(group_size) FROM evidence.outbox parts WHERE parts.domain=e.domain AND parts.aggregate_id=e.aggregate_id AND parts.aggregate_revision=e.aggregate_revision) OR EXISTS(SELECT FROM evidence.outbox parts WHERE parts.domain=e.domain AND parts.aggregate_id=e.aggregate_id AND parts.aggregate_revision=e.aggregate_revision AND parts.delivered_at IS NULL) THEN RAISE EXCEPTION 'task_event_group_incomplete' USING ERRCODE='42501';END IF;
 RETURN to_jsonb(e)-'delivered_at';
END $$;
RESET ROLE;
SET ROLE hub2_mem_owner;
CREATE OR REPLACE FUNCTION mem.worker_index_apply(id uuid,attempt bigint,fence uuid,prepared jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE source jsonb;old mem.text_index;
BEGIN
 source:=mem.worker_index_input(id,attempt,fence);
 IF prepared->>'version_id' IS DISTINCT FROM source->>'version_id' OR prepared->>'sha256' IS DISTINCT FROM source->>'sha256' THEN RAISE EXCEPTION 'index_fixed_version_mismatch' USING ERRCODE='42501';END IF;
 IF prepared->>'state'='awaiting_extraction' THEN RETURN jsonb_build_object('state','awaiting_extraction','version_id',source->'version_id','processing_pending',true,'coverage','unsupported_text_encoding_or_extraction_size','next_step','authorized_agent_can_extract_and_call_index_text');END IF;
 IF prepared->>'recipe' IS DISTINCT FROM 'zh-character-bigram-v1' OR prepared->>'text' IS NULL OR prepared->>'token_text' IS NULL OR length(prepared->>'text')>500000 THEN RAISE EXCEPTION 'invalid_index_input';END IF;
 IF encode(public.digest(prepared->>'text','sha256'),'hex') IS DISTINCT FROM source->>'sha256' THEN RAISE EXCEPTION 'index_object_integrity_mismatch' USING ERRCODE='42501';END IF;
 SELECT * INTO old FROM mem.text_index WHERE version_id=(source->>'version_id')::uuid;
 IF old.version_id IS NOT NULL THEN
  PERFORM evidence.assert_task(id,attempt,fence);
  RETURN jsonb_build_object('state',CASE WHEN old.coverage='complete' AND old.recipe='zh-character-bigram-v1' AND encode(public.digest(old.text_content,'sha256'),'hex')=source->>'sha256' THEN 'indexed' ELSE 'existing_declared_index_preserved' END,'version_id',source->'version_id','coverage',old.coverage,'existing_declaration','not_overridden','object_bytes_sha_verified',true);
 END IF;
 PERFORM evidence.assert_task(id,attempt,fence);
 INSERT INTO mem.text_index(version_id,recipe,text_content,tokens,coverage) VALUES((source->>'version_id')::uuid,prepared->>'recipe',prepared->>'text',to_tsvector('simple',prepared->>'token_text'),'complete') ON CONFLICT(version_id) DO NOTHING;
 RETURN jsonb_build_object('state','indexed','version_id',source->'version_id','coverage','complete_utf8_text','recipe','zh-character-bigram-v1');
END $$;
RESET ROLE;
