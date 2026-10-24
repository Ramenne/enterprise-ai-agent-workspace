-- Authority epochs are invalidation fences, not dense event ordinals.
-- Only consume real committed authority events; do not grant, recreate, or reset authority.
GRANT SELECT(principal_id,request_digest,result) ON authz.operations TO hub2_evidence_owner;
GRANT SELECT(id,project_id,epoch) ON authz.qualifications TO hub2_evidence_owner;
GRANT SELECT(id,client_id,epoch) ON authz.credentials TO hub2_evidence_owner;
GRANT SELECT(id,principal_id) ON authz.clients TO hub2_evidence_owner;
SET ROLE hub2_evidence_owner;
ALTER TABLE evidence.projection ADD coverage text NOT NULL DEFAULT 'received_domain_revision_groups';
UPDATE evidence.projection SET coverage='latest_observed_security_fence_epoch;not_dense_authority_history' WHERE domain='authz';
CREATE TABLE evidence.authority_epoch_observations (
 consumer text NOT NULL REFERENCES evidence.consumers(name),event_id uuid NOT NULL REFERENCES evidence.outbox(id),
 aggregate_id uuid NOT NULL,previous_observed_epoch bigint NOT NULL,security_epoch bigint NOT NULL,
 source_operation_id uuid NOT NULL,request_digest text NOT NULL CHECK(request_digest~'^[a-f0-9]{64}$'),
 coverage text NOT NULL CHECK(coverage='committed_authority_event;security_epochs_are_not_dense_transport_history'),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(consumer,event_id)
);
REVOKE ALL ON evidence.authority_epoch_observations FROM PUBLIC,hub2_worker,hub2_hufu,hub2_mem,hub2_v8;
CREATE FUNCTION evidence.proved_authority_epoch(eid uuid) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,evidence AS $$
DECLARE e evidence.outbox;o record;target uuid;
BEGIN
 SELECT * INTO e FROM evidence.outbox WHERE id=eid AND domain='authz';
 IF e.id IS NULL OR e.payload->>'state' IS DISTINCT FROM 'committed' OR e.payload->>'operation_id' IS NULL THEN RETURN false;END IF;
 IF e.event_type NOT IN('qualification.grant','qualification.revoke','qualification.freeze','qualification.unfreeze','management.delegate','credential.create','credential.rotate','credential.revoke') THEN RETURN false;END IF;
 SELECT principal_id,request_digest,result INTO o FROM authz.operations WHERE result=e.payload;
 IF o.principal_id IS NULL OR NOT EXISTS(SELECT FROM evidence.audit a WHERE a.domain='authz' AND a.action=e.event_type AND a.actor_id=o.principal_id AND a.details=o.result AND a.aggregate_id=coalesce(e.project_id,e.aggregate_id)) THEN RETURN false;END IF;
 IF e.event_type LIKE 'qualification.%' OR e.event_type='management.delegate' THEN
  target:=(e.payload->>'qualification_id')::uuid;
  RETURN target=e.aggregate_id AND EXISTS(SELECT FROM authz.qualifications q WHERE q.id=target AND q.project_id IS NOT DISTINCT FROM e.project_id AND q.epoch>=e.aggregate_revision);
 END IF;
 target:=(e.payload->>'credential_id')::uuid;
 RETURN target=e.aggregate_id AND EXISTS(SELECT FROM authz.credentials k JOIN authz.clients c ON c.id=k.client_id WHERE k.id=target AND c.principal_id=o.principal_id AND k.epoch>=e.aggregate_revision);
END $$;
REVOKE ALL ON FUNCTION evidence.proved_authority_epoch(uuid) FROM PUBLIC,hub2_worker,hub2_hufu,hub2_mem,hub2_v8;
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
   IF r.aggregate_revision<>p.revision+1 THEN
    IF p.domain<>'authz' OR EXISTS(SELECT FROM evidence.delivery d JOIN evidence.outbox actual ON actual.id=d.event_id WHERE actual.domain=p.domain AND actual.aggregate_id=p.aggregate_id AND actual.aggregate_revision=r.aggregate_revision AND d.seq<=water AND NOT evidence.proved_authority_epoch(actual.id)) THEN
     UPDATE evidence.projection SET state='gap' WHERE consumer=c AND domain=p.domain AND aggregate_id=p.aggregate_id;EXIT;
    END IF;
   END IF;
   IF r.count<>r.size OR r.size<>r.max_size OR r.groups<>1 OR r.first<>1 OR r.last<>r.size THEN UPDATE evidence.projection SET state='incomplete_group' WHERE consumer=c AND domain=p.domain AND aggregate_id=p.aggregate_id;EXIT;END IF;
   PERFORM evidence.worker_guard('worker.consume');
   FOR g IN SELECT o.id,o.event_type FROM evidence.delivery d JOIN evidence.outbox o ON o.id=d.event_id WHERE o.domain=p.domain AND o.aggregate_id=p.aggregate_id AND o.aggregate_revision=r.aggregate_revision AND d.seq<=water LOOP
    IF p.domain='authz' AND evidence.proved_authority_epoch(g.id) THEN
     INSERT INTO evidence.authority_epoch_observations(consumer,event_id,aggregate_id,previous_observed_epoch,security_epoch,source_operation_id,request_digest,coverage)
     SELECT c,g.id,p.aggregate_id,p.revision,r.aggregate_revision,(actual.payload->>'operation_id')::uuid,op.request_digest,'committed_authority_event;security_epochs_are_not_dense_transport_history'
     FROM evidence.outbox actual JOIN authz.operations op ON op.result=actual.payload WHERE actual.id=g.id
     ON CONFLICT(consumer,event_id) DO NOTHING;
    END IF;
    INSERT INTO evidence.inbox(consumer,event_id) VALUES(c,g.id) ON CONFLICT DO NOTHING;
    IF FOUND THEN applied:=applied+1; ELSE replayed:=replayed+1; END IF;
    IF evidence.derived_event_kind(p.domain,g.event_type) IS NOT NULL THEN
     INSERT INTO jobs.tasks(kind,dedupe_key,payload) VALUES(evidence.derived_event_kind(p.domain,g.event_type),'event:'||g.id,jsonb_build_object('event_id',g.id,'domain',p.domain,'aggregate_id',p.aggregate_id,'project_id',p.project_id,'revision',r.aggregate_revision)) ON CONFLICT(dedupe_key) DO NOTHING;
    END IF;
   END LOOP;
   UPDATE evidence.projection SET revision=r.aggregate_revision,state='current',event_types=r.types,last_seq=r.seq,coverage=CASE WHEN p.domain='authz' THEN 'latest_observed_security_fence_epoch;not_dense_authority_history' ELSE 'received_domain_revision_groups' END,updated_at=clock_timestamp() WHERE consumer=c AND domain=p.domain AND aggregate_id=p.aggregate_id;
   p.revision:=r.aggregate_revision;
  END LOOP;
 END LOOP;
 UPDATE evidence.consumer_progress SET scanned_seq=water,replay_count=replay_count+replayed,gap_count=(SELECT count(*) FROM evidence.projection WHERE consumer=c AND state IN ('gap','incomplete_group')) WHERE consumer=c;
 RETURN jsonb_build_object('state','consumed','applied',applied,'replayed',replayed,'scanned_seq',water);
END $$;
RESET ROLE;

SET ROLE hub2_evidence_owner;
CREATE OR REPLACE FUNCTION evidence.seed_consumer(c text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$ DECLARE high bigint;BEGIN
 IF c IS NULL OR current_setting('transaction_isolation') IS DISTINCT FROM 'repeatable read' THEN RAISE EXCEPTION 'repeatable_read_required';END IF;PERFORM evidence.worker_guard('worker.consume');
 IF NOT EXISTS(SELECT FROM evidence.consumers WHERE name=c AND active) THEN RAISE EXCEPTION 'unknown_consumer' USING ERRCODE='42501';END IF;
 INSERT INTO evidence.consumer_progress(consumer) VALUES(c) ON CONFLICT DO NOTHING;
 PERFORM consumer FROM evidence.consumer_progress WHERE consumer=c FOR UPDATE;
 SELECT value INTO high FROM evidence.delivery_counter WHERE id;
 PERFORM evidence.worker_guard('worker.consume');
 -- Complete committed groups provide the deterministic projection snapshot. Incomplete groups remain repairable.
 INSERT INTO evidence.projection(consumer,domain,aggregate_id,project_id,revision,state,last_seq)
 SELECT c,x.domain,x.aggregate_id,x.project_id,max(x.aggregate_revision),'current',high FROM (
 SELECT domain,aggregate_id,project_id,aggregate_revision FROM evidence.outbox WHERE domain<>'authz' GROUP BY domain,aggregate_id,project_id,aggregate_revision HAVING count(*)=min(group_size) AND min(group_size)=max(group_size) AND count(DISTINCT event_group)=1 AND min(group_index)=1 AND max(group_index)=max(group_size)) x GROUP BY x.domain,x.aggregate_id,x.project_id
 ON CONFLICT(consumer,domain,aggregate_id) DO UPDATE SET revision=EXCLUDED.revision,state='current',last_seq=high;
 UPDATE evidence.consumer_progress SET scanned_seq=high,gap_count=0 WHERE consumer=c;
 -- Authority projections are not seeded from undelivered/non-proved security epochs.
 INSERT INTO evidence.projection(consumer,domain,aggregate_id,project_id,coverage)
 SELECT DISTINCT c,o.domain,o.aggregate_id,o.project_id,'latest_observed_security_fence_epoch;not_dense_authority_history' FROM evidence.delivery d JOIN evidence.outbox o ON o.id=d.event_id WHERE o.domain='authz' AND d.seq<=high
 ON CONFLICT(consumer,domain,aggregate_id) DO NOTHING;
 PERFORM evidence.consume_batch(c,100);
 RETURN jsonb_build_object('state','snapshot_seeded','delivery_highwater',high,'coverage','Mem_V8_committed_group_snapshot;authz_actual_delivered_proved_epoch_observations_only','authority_history_complete',false);END $$;
RESET ROLE;
