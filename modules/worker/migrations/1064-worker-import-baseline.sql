-- Operational imports start at logical revision 1 without a creation event.
-- A real, audited revision-2 import/governance event proves the baseline.
-- No fabricated event, caller grant, stream reset, or arbitrary jump is permitted.
SET ROLE hub2_evidence_owner;
-- Proof lookups must use object identity, not rescan the entire audit log per object.
CREATE INDEX audit_event_proof ON evidence.audit(domain,aggregate_id,revision,action);
CREATE INDEX outbox_import_project ON evidence.outbox(project_id,occurred_at) WHERE domain='mem' AND event_type='material.legacy_migrated';
CREATE TABLE evidence.import_baseline_observations(
 consumer text NOT NULL REFERENCES evidence.consumers(name),
 event_id uuid NOT NULL REFERENCES evidence.outbox(id),
 domain text NOT NULL CHECK(domain IN('mem','v8')), aggregate_id uuid NOT NULL,
 previous_projection_revision bigint NOT NULL CHECK(previous_projection_revision=0),
 logical_start_revision bigint NOT NULL CHECK(logical_start_revision=1),
 consumed_revision bigint NOT NULL CHECK(consumed_revision=2),
 event_payload_sha256 text NOT NULL CHECK(event_payload_sha256~'^[a-f0-9]{64}$'),
 basis text NOT NULL CHECK(basis IN('audited_operational_material_import','audited_governance_of_operational_import_project')),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(consumer,event_id));
REVOKE ALL ON evidence.import_baseline_observations FROM PUBLIC,hub2_worker,hub2_hufu,hub2_mem,hub2_v8;
CREATE FUNCTION evidence.proved_import_baseline(eid uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,evidence AS $proof$
DECLARE e evidence.outbox;ref jsonb;
BEGIN
 SELECT * INTO e FROM evidence.outbox WHERE id=eid;
 IF e.id IS NULL OR e.aggregate_revision<>2 OR e.group_size<>1 OR e.group_index<>1
  OR NOT EXISTS(SELECT FROM evidence.delivery WHERE event_id=e.id)
  OR EXISTS(SELECT FROM evidence.outbox x WHERE x.domain=e.domain AND x.aggregate_id=e.aggregate_id AND x.aggregate_revision<2)
  OR (SELECT count(*) FROM evidence.outbox x WHERE x.domain=e.domain AND x.aggregate_id=e.aggregate_id AND x.aggregate_revision=2)<>1
  OR evidence.derived_event_kind(e.domain,e.event_type) IS NOT NULL THEN RETURN false;END IF;
 IF e.domain='mem' AND e.event_type='material.legacy_migrated' THEN
  IF e.payload->>'execution_authority' IS DISTINCT FROM 'authorized_operational_import'
   OR e.payload->>'material_id' IS DISTINCT FROM e.aggregate_id::text
   OR jsonb_typeof(e.payload->'fixed_refs') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(e.payload->'fixed_refs')<>1 THEN RETURN false;END IF;
  ref:=e.payload->'fixed_refs'->0;
  IF ref->>'material_id' IS DISTINCT FROM e.aggregate_id::text
   OR coalesce(ref->>'version_id','')!~'^[0-9a-f-]{36}$'
   OR coalesce(ref->>'sha256','')!~'^[a-f0-9]{64}$'
   OR coalesce(ref->>'size','')!~'^[0-9]+$' THEN RETURN false;END IF;
  RETURN EXISTS(SELECT FROM evidence.audit a WHERE a.domain=e.domain AND a.aggregate_id=e.aggregate_id
   AND a.revision=2 AND a.action=e.event_type
   AND a.details->>'execution_authority'='explicitly_authorized_OS_root_migration'
   AND a.details->>'ordinary_handle_claimed'='false'
   AND a.details->>'material_id'=e.aggregate_id::text
   AND a.details->'fixed_refs'=e.payload->'fixed_refs');
 ELSIF e.domain='v8' AND e.event_type='project.governance_saved'
  AND e.project_id=e.aggregate_id AND e.payload->>'revision'='2' THEN
  RETURN EXISTS(SELECT FROM evidence.audit a WHERE a.domain=e.domain AND a.aggregate_id=e.aggregate_id
    AND a.revision=2 AND a.action=e.event_type AND a.details=e.payload)
   AND EXISTS(SELECT FROM evidence.outbox i WHERE i.domain='mem'
    AND i.project_id=e.aggregate_id AND i.event_type='material.legacy_migrated'
    AND i.occurred_at<=e.occurred_at AND evidence.proved_import_baseline(i.id));
 END IF;
 RETURN false;
END $proof$;
REVOKE ALL ON FUNCTION evidence.proved_import_baseline(uuid) FROM PUBLIC,hub2_worker,hub2_hufu,hub2_mem,hub2_v8;
-- Private owner-only primitive, used by the guarded consumer and the scoped engineering migration.
CREATE FUNCTION evidence.establish_import_baselines(c text,n integer,water bigint) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,evidence AS $repair$
DECLARE x record;total integer:=0;actual_water bigint;
BEGIN
 IF c IS NULL OR n IS NULL OR n NOT BETWEEN 1 AND 500 OR water IS NULL THEN RAISE EXCEPTION 'invalid_import_baseline_input';END IF;
 SELECT scanned_seq INTO actual_water FROM evidence.consumer_progress WHERE consumer=c FOR UPDATE;
 IF actual_water IS NULL OR NOT EXISTS(SELECT FROM evidence.consumers WHERE name=c AND active)
  OR water<actual_water OR actual_water<(SELECT retained_after FROM evidence.stream_state WHERE id)
  OR water>(SELECT value FROM evidence.delivery_counter WHERE id)
  THEN RAISE EXCEPTION 'invalid_import_baseline_watermark';END IF;
 FOR x IN SELECT p.domain,p.aggregate_id,p.last_seq,e.id event_id,e.event_type,e.payload,d.seq
  FROM evidence.projection p JOIN evidence.outbox e ON e.domain=p.domain AND e.aggregate_id=p.aggregate_id AND e.aggregate_revision=2
  JOIN evidence.delivery d ON d.event_id=e.id
  WHERE p.consumer=c AND p.revision=0 AND p.state<>'resync_required' AND d.seq<=water
   AND evidence.proved_import_baseline(e.id)
  ORDER BY p.domain,p.aggregate_id LIMIT n FOR UPDATE OF p LOOP
  INSERT INTO evidence.import_baseline_observations(consumer,event_id,domain,aggregate_id,previous_projection_revision,
   logical_start_revision,consumed_revision,event_payload_sha256,basis)
  VALUES(c,x.event_id,x.domain,x.aggregate_id,0,1,2,encode(public.digest(x.payload::text,'sha256'),'hex'),
   CASE WHEN x.domain='mem' THEN 'audited_operational_material_import' ELSE 'audited_governance_of_operational_import_project' END)
  ON CONFLICT(consumer,event_id) DO NOTHING;
  INSERT INTO evidence.inbox(consumer,event_id) VALUES(c,x.event_id) ON CONFLICT DO NOTHING;
  UPDATE evidence.projection SET revision=2,state='current',event_types=ARRAY[x.event_type],
   last_seq=greatest(last_seq,x.seq),coverage='proved_operational_import_baseline;subsequent_events_require_dense_groups',
   updated_at=clock_timestamp() WHERE consumer=c AND domain=x.domain AND aggregate_id=x.aggregate_id AND revision=0;
  total:=total+1;
 END LOOP;
 UPDATE evidence.consumer_progress SET gap_count=(SELECT count(*) FROM evidence.projection WHERE consumer=c AND state IN('gap','incomplete_group')) WHERE consumer=c;
 RETURN jsonb_build_object('applied',total,'coverage','only_audited_complete_delivered_import_baselines;stream_cursor_preserved');
END $repair$;
REVOKE ALL ON FUNCTION evidence.establish_import_baselines(text,integer,bigint) FROM PUBLIC,hub2_worker,hub2_hufu,hub2_mem,hub2_v8;

CREATE OR REPLACE FUNCTION evidence.consume_batch(c text, n integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'evidence'
AS $function$
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
 -- Recognize only proved operational-import starting points; never skip a real missing intermediate revision.
 PERFORM evidence.establish_import_baselines(c,n,water);
 -- Revisit every pending aggregate, including rows behind scanned_seq. Cursor is not aggregate causality.
 FOR p IN SELECT * FROM evidence.projection WHERE consumer=c ORDER BY domain,aggregate_id FOR UPDATE LOOP
  FOR r IN SELECT o.aggregate_revision,count(*) count,min(o.group_size) size,max(o.group_size) max_size,count(DISTINCT o.event_group) groups,min(o.group_index) first,max(o.group_index) last,array_agg(o.event_type ORDER BY o.group_index) types,max(d.seq) seq FROM evidence.delivery d JOIN evidence.outbox o ON o.id=d.event_id WHERE o.domain=p.domain AND o.aggregate_id=p.aggregate_id AND d.seq<=water AND o.aggregate_revision>p.revision GROUP BY o.aggregate_revision ORDER BY o.aggregate_revision LOOP
   IF r.aggregate_revision<>p.revision+1 THEN
    IF p.domain<>'authz' OR EXISTS(SELECT FROM evidence.delivery d JOIN evidence.outbox actual ON actual.id=d.event_id WHERE actual.domain=p.domain AND actual.aggregate_id=p.aggregate_id AND actual.aggregate_revision=r.aggregate_revision AND d.seq<=water AND NOT evidence.proved_authority_epoch(actual.id)) THEN
     UPDATE evidence.projection SET state='gap' WHERE consumer=c AND domain=p.domain AND aggregate_id=p.aggregate_id;EXIT;
    END IF;
   END IF;
   IF r.count<>r.size OR r.size<>r.max_size OR r.groups<>1 OR r.first<>1 OR r.last<>r.size THEN UPDATE evidence.projection SET state='incomplete_group' WHERE consumer=c AND domain=p.domain AND aggregate_id=p.aggregate_id;EXIT;END IF;
   PERFORM evidence.worker_guard('worker.consume');
   FOR g IN SELECT o.id,o.event_type,o.project_id FROM evidence.delivery d JOIN evidence.outbox o ON o.id=d.event_id WHERE o.domain=p.domain AND o.aggregate_id=p.aggregate_id AND o.aggregate_revision=r.aggregate_revision AND d.seq<=water LOOP
    IF p.domain='authz' AND evidence.proved_authority_epoch(g.id) THEN
     INSERT INTO evidence.authority_epoch_observations(consumer,event_id,aggregate_id,previous_observed_epoch,security_epoch,source_operation_id,request_digest,coverage)
     SELECT c,g.id,p.aggregate_id,p.revision,r.aggregate_revision,(actual.payload->>'operation_id')::uuid,op.request_digest,'committed_authority_event;security_epochs_are_not_dense_transport_history'
     FROM evidence.outbox actual JOIN authz.operations op ON op.result=actual.payload WHERE actual.id=g.id
     ON CONFLICT(consumer,event_id) DO NOTHING;
    END IF;
    INSERT INTO evidence.inbox(consumer,event_id) VALUES(c,g.id) ON CONFLICT DO NOTHING;
    IF FOUND THEN applied:=applied+1; ELSE replayed:=replayed+1; END IF;
    IF evidence.derived_event_kind(p.domain,g.event_type) IS NOT NULL THEN
     INSERT INTO jobs.tasks(kind,dedupe_key,payload) VALUES(evidence.derived_event_kind(p.domain,g.event_type),'event:'||g.id,jsonb_build_object('event_id',g.id,'domain',p.domain,'aggregate_id',p.aggregate_id,'project_id',CASE WHEN g.event_type='material.scope_placed'THEN g.project_id ELSE p.project_id END,'revision',r.aggregate_revision)) ON CONFLICT(dedupe_key) DO NOTHING;
    END IF;
   END LOOP;
   UPDATE evidence.projection SET project_id=CASE WHEN 'material.scope_placed'=ANY(r.types)THEN(SELECT o.project_id FROM evidence.outbox o WHERE o.domain=p.domain AND o.aggregate_id=p.aggregate_id AND o.aggregate_revision=r.aggregate_revision AND o.event_type='material.scope_placed' LIMIT 1)ELSE project_id END,revision=r.aggregate_revision,state='current',event_types=r.types,last_seq=r.seq,coverage=CASE WHEN p.domain='authz' THEN 'latest_observed_security_fence_epoch;not_dense_authority_history' ELSE 'received_domain_revision_groups' END,updated_at=clock_timestamp() WHERE consumer=c AND domain=p.domain AND aggregate_id=p.aggregate_id;
   p.revision:=r.aggregate_revision;SELECT project_id INTO p.project_id FROM evidence.projection WHERE consumer=c AND domain=p.domain AND aggregate_id=p.aggregate_id;
  END LOOP;
 END LOOP;
 UPDATE evidence.consumer_progress SET scanned_seq=water,replay_count=replay_count+replayed,gap_count=(SELECT count(*) FROM evidence.projection WHERE consumer=c AND state IN ('gap','incomplete_group')) WHERE consumer=c;
 RETURN jsonb_build_object('state','consumed','applied',applied,'replayed',replayed,'scanned_seq',water);
END $function$;
RESET ROLE;
