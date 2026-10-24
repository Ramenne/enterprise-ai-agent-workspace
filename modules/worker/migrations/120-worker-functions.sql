-- Authorized shared service capability. Current authz rows remain the sole authority.
GRANT SELECT, UPDATE(active) ON evidence.service_binding TO hub2_authz_owner;
GRANT USAGE ON SCHEMA authz,mem,v8 TO hub2_evidence_owner;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.assert_service(a text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE b evidence.service_binding;p authz.principals;c authz.clients;k authz.credentials;era uuid;
BEGIN
 IF session_user IS DISTINCT FROM 'hub2_worker' OR a IS NULL OR a NOT IN ('worker.dispatch','worker.consume','worker.maintenance','worker.metrics','worker.governance') THEN RAISE EXCEPTION 'internal_service_required' USING ERRCODE='42501';END IF;
 SELECT * INTO b FROM evidence.service_binding WHERE db_role=session_user AND active FOR SHARE;
 IF b.db_role IS NULL THEN RAISE EXCEPTION 'unbound_service' USING ERRCODE='42501';END IF;
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals ORDER BY id FOR SHARE;
 SELECT * INTO p FROM authz.principals WHERE id=b.principal_id;
 SELECT * INTO c FROM authz.clients WHERE id=b.client_id FOR SHARE;
 SELECT * INTO k FROM authz.credentials WHERE id=b.credential_id FOR SHARE;
 SELECT security_state.era INTO era FROM authz.security_state WHERE id;
 IF p.id IS NULL OR c.id IS NULL OR k.id IS NULL OR p.kind IS DISTINCT FROM 'service' OR NOT p.active OR NOT c.active OR c.principal_id IS DISTINCT FROM p.id OR k.client_id IS DISTINCT FROM c.id OR k.revoked_at IS NOT NULL OR authz.family_valid(k.id) IS DISTINCT FROM true OR (NOT k.until_revoked AND k.expires_at<=clock_timestamp()) OR era IS DISTINCT FROM b.security_era OR (a=ANY(c.actions)) IS DISTINCT FROM true THEN RAISE EXCEPTION 'service_authority_expired' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('actor_id',p.id,'client_id',c.id,'security_era',era);
END $$;
REVOKE ALL ON FUNCTION authz.assert_service(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.assert_service(text) TO hub2_evidence_owner;
RESET ROLE;
SET ROLE hub2_evidence_owner;
-- authz.assert_service is the sole current service authority; binding stores no independent grants.
CREATE FUNCTION evidence.worker_guard(a text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$ BEGIN IF session_user IS DISTINCT FROM 'hub2_worker' OR a IS NULL THEN RAISE EXCEPTION 'worker_identity_required' USING ERRCODE='42501';END IF;PERFORM authz.assert_service(a);END $$;
CREATE FUNCTION evidence.dispatch_batch(n integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
DECLARE e evidence.outbox;s bigint;total integer:=0;
BEGIN
 IF n IS NULL OR n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_limit';END IF;
 PERFORM evidence.worker_guard('worker.dispatch');
 SELECT value INTO s FROM evidence.delivery_counter WHERE id FOR UPDATE;
 -- Read only committed rows. The counter remains locked through COMMIT; no network in this transaction.
 FOR e IN SELECT * FROM evidence.outbox WHERE delivered_at IS NULL ORDER BY occurred_at,id LIMIT n FOR UPDATE LOOP
  PERFORM evidence.worker_guard('worker.dispatch');s:=s+1;
  INSERT INTO evidence.delivery(seq,event_id) VALUES(s,e.id);
  UPDATE evidence.outbox SET delivered_at=clock_timestamp() WHERE id=e.id;total:=total+1;
 END LOOP;
 UPDATE evidence.delivery_counter SET value=s WHERE id;
 RETURN jsonb_build_object('delivered',total,'highwater',s);
END $$;
CREATE FUNCTION evidence.consume_batch(c text,n integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
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
    INSERT INTO jobs.tasks(kind,dedupe_key,payload) VALUES(CASE WHEN g.event_type LIKE '%invalidat%' OR g.event_type LIKE '%revok%' OR g.event_type LIKE '%convert%' THEN 'projection_invalidation' WHEN g.event_type LIKE '%published%' THEN 'index' ELSE 'maintenance' END,'event:'||g.id,jsonb_build_object('event_id',g.id,'domain',p.domain,'aggregate_id',p.aggregate_id,'project_id',p.project_id,'revision',r.aggregate_revision)) ON CONFLICT(dedupe_key) DO NOTHING;
   END LOOP;
   UPDATE evidence.projection SET revision=r.aggregate_revision,state='current',event_types=r.types,last_seq=r.seq,updated_at=clock_timestamp() WHERE consumer=c AND domain=p.domain AND aggregate_id=p.aggregate_id;
   p.revision:=r.aggregate_revision;
  END LOOP;
 END LOOP;
 UPDATE evidence.consumer_progress SET scanned_seq=water,replay_count=replay_count+replayed,gap_count=(SELECT count(*) FROM evidence.projection WHERE consumer=c AND state IN ('gap','incomplete_group')) WHERE consumer=c;
 RETURN jsonb_build_object('state','consumed','applied',applied,'replayed',replayed,'scanned_seq',water);
END $$;
CREATE FUNCTION evidence.enqueue_task(k text,key text,b jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$ DECLARE t jobs.tasks;BEGIN
 IF k IS NULL OR key IS NULL OR length(key) NOT BETWEEN 1 AND 200 OR b IS NULL OR jsonb_typeof(b)<>'object' THEN RAISE EXCEPTION 'invalid_task';END IF;
 PERFORM evidence.worker_guard('worker.maintenance');
 INSERT INTO jobs.tasks(kind,dedupe_key,payload) VALUES(k,key,b) ON CONFLICT(dedupe_key) DO NOTHING;
 SELECT * INTO t FROM jobs.tasks WHERE dedupe_key=key;
 IF t.kind IS DISTINCT FROM k OR t.payload IS DISTINCT FROM b THEN RAISE EXCEPTION 'task_idempotency_conflict' USING ERRCODE='23505';END IF;RETURN t.id;
END $$;
CREATE FUNCTION evidence.claim_task(seconds integer DEFAULT 60,task uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$ DECLARE t jobs.tasks;BEGIN
 IF seconds IS NULL OR seconds NOT BETWEEN 1 AND 600 THEN RAISE EXCEPTION 'invalid_lease';END IF;
 PERFORM evidence.worker_guard('worker.maintenance');
 SELECT * INTO t FROM jobs.tasks WHERE (task IS NULL OR id=task) AND ((state IN ('pending','retry') AND run_after<=clock_timestamp()) OR (state='running' AND lease_until<=clock_timestamp())) ORDER BY run_after,created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM evidence.worker_guard('worker.maintenance');
 IF t.state='running' THEN UPDATE jobs.attempts SET state='expired',finished_at=clock_timestamp(),error_code='lease_expired' WHERE task_id=t.id AND attempt=t.attempt;END IF;
 IF t.attempt>=t.max_attempts THEN UPDATE jobs.tasks SET state='dead',error_code='attempts_exhausted',lease_until=NULL WHERE id=t.id;RETURN NULL;END IF;
 UPDATE jobs.tasks SET state='running',attempt=attempt+1,fencing_token=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>seconds),updated_at=clock_timestamp() WHERE id=t.id RETURNING * INTO t;
 INSERT INTO jobs.attempts(task_id,attempt,fencing_token,state) VALUES(t.id,t.attempt,t.fencing_token,'running');RETURN to_jsonb(t);
END $$;
CREATE FUNCTION evidence.finish_task(id uuid,attempt bigint,fence uuid,result jsonb,error text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
#variable_conflict use_variable
DECLARE t jobs.tasks;next_state text;
BEGIN
 IF id IS NULL OR attempt IS NULL OR fence IS NULL OR result IS NULL OR jsonb_typeof(result)<>'object' OR (error IS NOT NULL AND error !~ '^[a-z0-9_]{1,80}$') THEN RAISE EXCEPTION 'invalid_finish';END IF;
 PERFORM evidence.worker_guard('worker.maintenance');SELECT * INTO t FROM jobs.tasks x WHERE x.id=id FOR UPDATE;
 IF t.id IS NULL OR t.state<>'running' OR t.attempt IS DISTINCT FROM attempt OR t.fencing_token IS DISTINCT FROM fence OR t.lease_until IS NULL OR t.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'stale_worker_attempt' USING ERRCODE='40001';END IF;
 PERFORM evidence.worker_guard('worker.maintenance'); -- After the final business lock and immediately before effects.
 next_state:=CASE WHEN error IS NULL THEN 'done' WHEN t.attempt>=t.max_attempts THEN 'dead' ELSE 'retry' END;
 UPDATE jobs.tasks x SET state=next_state,result=result,error_code=error,lease_until=NULL,run_after=clock_timestamp()+make_interval(secs=>least(300,(power(2,t.attempt))::integer)),updated_at=clock_timestamp() WHERE x.id=id;
 UPDATE jobs.attempts x SET state=next_state,error_code=error,finished_at=clock_timestamp() WHERE x.task_id=id AND x.attempt=attempt;
 RETURN jsonb_build_object('task_id',id,'state',next_state,'attempt',attempt);
END $$;
CREATE FUNCTION evidence.plan_task(id uuid,attempt bigint,fence uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
#variable_conflict use_variable
DECLARE t jobs.tasks;r jsonb;
BEGIN
 IF id IS NULL OR attempt IS NULL OR fence IS NULL THEN RAISE EXCEPTION 'invalid_plan';END IF;
 PERFORM evidence.worker_guard('worker.maintenance');SELECT * INTO t FROM jobs.tasks x WHERE x.id=id FOR UPDATE;
 IF t.id IS NULL OR t.state<>'running' OR t.attempt IS DISTINCT FROM attempt OR t.fencing_token IS DISTINCT FROM fence OR t.lease_until IS NULL OR t.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'stale_worker_attempt' USING ERRCODE='40001';END IF;
 PERFORM evidence.worker_guard('worker.maintenance');
 INSERT INTO jobs.maintenance_plans(task_id,kind,domain,aggregate_id,state,reason_code) VALUES(t.id,t.kind,t.payload->>'domain',(t.payload->>'aggregate_id')::uuid,CASE WHEN t.kind='mem_gc_dry_run' THEN 'held' WHEN t.kind IN ('index','verification_compensation','projection_invalidation') THEN 'awaiting_domain_capability' ELSE 'completed' END,CASE WHEN t.kind='mem_gc_dry_run' THEN 'recovery_window_unknown_no_object_deletion' WHEN t.kind IN ('index','verification_compensation','projection_invalidation') THEN 'domain_effect_requires_domain_capability' ELSE 'maintenance_recorded' END) ON CONFLICT(task_id) DO NOTHING;
 SELECT jsonb_build_object('state',p.state,'reason_code',p.reason_code) INTO r FROM jobs.maintenance_plans p WHERE task_id=id;
 RETURN r;
END $$;
-- Prune only delivery transport, never ledger/outbox facts. Retained floor expires cursors explicitly.
CREATE FUNCTION evidence.retain_stream(before_seq bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$ DECLARE high bigint;BEGIN
 IF before_seq IS NULL OR before_seq<0 THEN RAISE EXCEPTION 'invalid_retention';END IF;PERFORM evidence.worker_guard('worker.maintenance');
 SELECT value INTO high FROM evidence.delivery_counter WHERE id FOR UPDATE;
 IF before_seq>high THEN RAISE EXCEPTION 'future_retention';END IF;
 PERFORM evidence.worker_guard('worker.maintenance');UPDATE evidence.stream_state SET retained_after=greatest(retained_after,before_seq) WHERE id RETURNING retained_after INTO before_seq;DELETE FROM evidence.delivery WHERE seq<=before_seq;
 RETURN jsonb_build_object('retained_after',before_seq,'ledger','preserved');END $$;
CREATE FUNCTION evidence.worker_metrics() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$ BEGIN PERFORM evidence.worker_guard('worker.metrics');RETURN jsonb_build_object('outbox_backlog',(SELECT count(*) FROM evidence.outbox WHERE delivered_at IS NULL),'outbox_oldest_age_seconds',(SELECT extract(epoch FROM clock_timestamp()-min(occurred_at)) FROM evidence.outbox WHERE delivered_at IS NULL),'pending_tasks',(SELECT count(*) FROM jobs.tasks WHERE state IN ('pending','retry')),'expired_leases',(SELECT count(*) FROM jobs.tasks WHERE state='running' AND lease_until<=clock_timestamp()),'dead_tasks',(SELECT count(*) FROM jobs.tasks WHERE state='dead'),'projection_gaps',(SELECT count(*) FROM evidence.projection WHERE state<>'current'),'unknown_source_requests',(SELECT count(*) FROM evidence.logical_requests WHERE source_context_id IS NULL),'replay_count',(SELECT coalesce(sum(replay_count),0) FROM evidence.consumer_progress));END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA evidence FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.dispatch_batch(integer),evidence.consume_batch(text,integer),evidence.enqueue_task(text,text,jsonb),evidence.claim_task(integer,uuid),evidence.finish_task(uuid,bigint,uuid,jsonb,text),evidence.plan_task(uuid,bigint,uuid),evidence.retain_stream(bigint),evidence.worker_metrics() TO hub2_worker;
RESET ROLE;
SET ROLE hub2_evidence_owner;
CREATE FUNCTION evidence.record_usage(request uuid,action text,schema_version text,source uuid,traffic text,success boolean,coverage text,result_count bigint,duration_ms double precision,paths jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
#variable_conflict use_variable
DECLARE service text;item jsonb;existing evidence.logical_requests;
BEGIN
 service:=CASE session_user WHEN 'hub2_mem' THEN 'mem' WHEN 'hub2_v8' THEN 'v8' WHEN 'hub2_hufu' THEN 'hufu' ELSE NULL END;
 IF service IS NULL OR request IS NULL OR action IS NULL OR length(action) NOT BETWEEN 1 AND 100 OR schema_version IS NULL OR length(schema_version) NOT BETWEEN 1 AND 100 OR traffic IS NULL OR success IS NULL OR coverage IS NULL OR paths IS NULL OR jsonb_typeof(paths)<>'array' OR jsonb_array_length(paths)>200 THEN RAISE EXCEPTION 'invalid_usage_input' USING ERRCODE='42501';END IF;
 INSERT INTO evidence.logical_requests(request_id,service,action,schema_version,source_context_id,traffic_kind,success,coverage,result_count,duration_ms) VALUES(request,service,action,schema_version,source,traffic,success,coverage,result_count,duration_ms) ON CONFLICT DO NOTHING;
 SELECT * INTO existing FROM evidence.logical_requests r WHERE r.request_id=request AND r.service=service AND r.action=action;
 IF existing.schema_version IS DISTINCT FROM schema_version OR existing.source_context_id IS DISTINCT FROM source OR existing.traffic_kind IS DISTINCT FROM traffic THEN RAISE EXCEPTION 'logical_request_identity_conflict' USING ERRCODE='23505';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(paths) LOOP
  IF jsonb_typeof(item)<>'object' OR item-'path'-'purpose'<>'{}'::jsonb OR item->>'purpose' IS NULL OR item->>'purpose' NOT IN ('filter','sort','return','write') OR item->>'path' IS NULL OR length(item->>'path') NOT BETWEEN 1 AND 240 OR item->>'path' !~ '^[a-zA-Z_$][a-zA-Z0-9_.$*\[\]-]*$' OR item->>'path' ~ '\[[0-9]+\]' THEN RAISE EXCEPTION 'invalid_canonical_field_path';END IF;
  INSERT INTO evidence.field_usage(request_id,service,action,path,purpose,schema_version,source_context_id,occurred_at) VALUES(request,service,action,item->>'path',item->>'purpose',schema_version,source,existing.occurred_at) ON CONFLICT DO NOTHING;
 END LOOP;
END $$;
CREATE FUNCTION evidence.record_property_snapshot(service text,schema_version text,observed bigint,unknown bigint,counts jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
#variable_conflict use_variable
DECLARE key text;value jsonb;id uuid;
BEGIN
 PERFORM evidence.worker_guard('worker.governance');
 IF service IS NULL OR schema_version IS NULL OR observed IS NULL OR unknown IS NULL OR observed<0 OR unknown<0 OR counts IS NULL OR jsonb_typeof(counts)<>'object' THEN RAISE EXCEPTION 'invalid_property_snapshot';END IF;
 FOR key,value IN SELECT * FROM jsonb_each(counts) LOOP IF length(key) NOT BETWEEN 1 AND 240 OR key !~ '^[a-zA-Z_$][a-zA-Z0-9_.$*\[\]-]*$' OR jsonb_typeof(value)<>'number' OR value::text !~ '^[0-9]+$' OR value::text::bigint>observed THEN RAISE EXCEPTION 'invalid_property_count';END IF;END LOOP;
 PERFORM evidence.worker_guard('worker.governance');INSERT INTO evidence.property_snapshots(service,schema_version,observed_objects,unknown_objects,counts) VALUES(service,schema_version,observed,unknown,counts) RETURNING property_snapshots.id INTO id;RETURN id;
END $$;
CREATE FUNCTION evidence.rollup_usage(start_at timestamptz,end_at timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$ DECLARE report jsonb;rows jsonb;coverage jsonb;BEGIN
 IF start_at IS NULL OR end_at IS NULL OR end_at<=start_at THEN RAISE EXCEPTION 'invalid_period';END IF;PERFORM evidence.worker_guard('worker.governance');
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.service,x.action,x.schema_version,x.traffic_kind,x.path,x.purpose),'[]') INTO rows FROM (
 SELECT u.service,u.action,r.schema_version,r.traffic_kind,u.path,u.purpose,count(*) used_requests,(SELECT count(*) FROM evidence.logical_requests denominator WHERE denominator.service=u.service AND denominator.action=u.action AND denominator.schema_version=r.schema_version AND denominator.traffic_kind=r.traffic_kind AND denominator.occurred_at>=start_at AND denominator.occurred_at<end_at) observed_requests FROM evidence.field_usage u JOIN evidence.logical_requests r USING(request_id,service,action) WHERE r.occurred_at>=start_at AND r.occurred_at<end_at GROUP BY u.service,u.action,r.schema_version,r.traffic_kind,u.path,u.purpose) x;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO coverage FROM (SELECT lr.service,lr.schema_version,lr.coverage,count(*) requests,count(*) FILTER(WHERE lr.source_context_id IS NULL) unknown_source_requests FROM evidence.logical_requests lr WHERE lr.occurred_at>=start_at AND lr.occurred_at<end_at GROUP BY lr.service,lr.schema_version,lr.coverage) x;
 report:=jsonb_build_object('period_start',start_at,'period_end',end_at,'field_request_usage',rows,'coverage',coverage,'denominator','recorded_logical_requests_only','unobserved_direct_sql','unknown','property_occurrence','separate_snapshot_measure','adoption_effect','not_measured_by_field_usage');
 PERFORM evidence.worker_guard('worker.governance');INSERT INTO evidence.usage_reports(period_start,period_end,report) VALUES(start_at,end_at,report) ON CONFLICT(period_start,period_end) DO UPDATE SET report=EXCLUDED.report;RETURN report;
END $$;
REVOKE ALL ON FUNCTION evidence.record_usage(uuid,text,text,uuid,text,boolean,text,bigint,double precision,jsonb),evidence.record_property_snapshot(text,text,bigint,bigint,jsonb),evidence.rollup_usage(timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.record_usage(uuid,text,text,uuid,text,boolean,text,bigint,double precision,jsonb) TO hub2_mem_owner,hub2_v8_owner,hub2_authz_owner,hub2_mem,hub2_v8,hub2_hufu;
GRANT EXECUTE ON FUNCTION evidence.record_property_snapshot(text,text,bigint,bigint,jsonb),evidence.rollup_usage(timestamptz,timestamptz) TO hub2_worker;
RESET ROLE;
-- Current project feed is a capability consumed by existing domain wrappers. Payloads never cross this boundary.
GRANT SELECT(id,project_id,current_version_id,content_revision,metadata_revision,event_revision,state) ON mem.materials TO hub2_evidence_owner;
GRANT SELECT(id,project_id,event_revision,state) ON v8.work_items TO hub2_evidence_owner;
GRANT EXECUTE ON FUNCTION authz.consume_handle(uuid,text,text),authz.assert_effect(uuid) TO hub2_evidence_owner;
GRANT EXECUTE ON FUNCTION public.digest(text,text) TO hub2_evidence_owner;
GRANT EXECUTE ON FUNCTION mem.version_visible(uuid,uuid) TO hub2_evidence_owner;
SET ROLE hub2_evidence_owner;
CREATE FUNCTION evidence.project_changes(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$ DECLARE b jsonb;c jsonb;action text;floor bigint;high bigint;cursor bigint;limit_n integer;events jsonb;next_cursor uuid;BEGIN
 IF h IS NULL OR d IS NULL OR payload IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;
 action:=CASE session_user WHEN 'hub2_mem' THEN 'mem.read' WHEN 'hub2_v8' THEN 'v8.project.read' ELSE NULL END;
 IF action IS NULL THEN RAISE EXCEPTION 'domain_identity_required' USING ERRCODE='42501';END IF;c:=authz.consume_handle(h,action,d);
 IF (b->>'project_id')::uuid IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 IF b-'project_id'-'cursor'-'limit'<>'{}'::jsonb OR COALESCE(c->'resource'->'resolved_resource',c->'resource')->>'material_id' IS NOT NULL OR COALESCE(c->'resource'->'resolved_resource',c->'resource')->>'collection_id' IS NOT NULL OR COALESCE(c->'resource'->'resolved_resource',c->'resource')->>'area_id' IS NOT NULL OR COALESCE(c->'resource'->'resolved_resource',c->'resource')->>'version_id' IS NOT NULL THEN RAISE EXCEPTION 'project_scope_required' USING ERRCODE='42501';END IF;
 SELECT seq INTO cursor FROM evidence.feed_cursors WHERE id=(b->>'cursor')::uuid AND actor_id=(c->>'actor_id')::uuid AND client_id=(c->>'client_id')::uuid AND project_id=(c->>'project_id')::uuid;limit_n:=coalesce((b->>'limit')::integer,100);
 IF cursor IS NULL OR cursor<0 OR limit_n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_cursor';END IF;
 SELECT retained_after INTO floor FROM evidence.stream_state WHERE id;SELECT value INTO high FROM evidence.delivery_counter WHERE id;
 PERFORM authz.assert_effect(h);
 IF cursor<floor THEN RETURN jsonb_build_object('state','resync_required','retained_state','preserve_previous_projection');END IF;
 IF cursor>high THEN RAISE EXCEPTION 'future_cursor';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.delivery_seq),'[]') INTO events FROM (SELECT dd.seq delivery_seq,o.id event_id,o.domain,o.aggregate_id,o.aggregate_revision,o.event_type,o.event_group,o.group_index,o.group_size FROM evidence.delivery dd JOIN evidence.outbox o ON o.id=dd.event_id WHERE dd.seq>cursor AND o.project_id=(c->>'project_id')::uuid AND (o.domain<>'mem' OR NOT EXISTS(SELECT FROM mem.materials mm WHERE mm.id=o.aggregate_id) OR EXISTS(SELECT FROM mem.materials mm WHERE mm.id=o.aggregate_id AND (mm.current_version_id IS NULL OR mem.version_visible((c->>'actor_id')::uuid,mm.current_version_id)))) ORDER BY dd.seq LIMIT limit_n) x;
 PERFORM authz.assert_effect(h);
 INSERT INTO evidence.feed_cursors(actor_id,client_id,project_id,seq) VALUES((c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'project_id')::uuid,CASE WHEN jsonb_array_length(events)=limit_n THEN (events->-1->>'delivery_seq')::bigint ELSE high END) RETURNING id INTO next_cursor;
 SELECT coalesce(jsonb_agg(value-'delivery_seq'),'[]') INTO events FROM jsonb_array_elements(events);
 RETURN jsonb_build_object('state','current','events',events,'cursor',next_cursor,'coverage','current_authorized_project_metadata_only');
END $$;
CREATE FUNCTION evidence.project_snapshot(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$ DECLARE b jsonb;c jsonb;action text;high bigint;items jsonb;snapshot_cursor uuid;BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'repeatable read' THEN RAISE EXCEPTION 'repeatable_read_required';END IF;
 IF h IS NULL OR d IS NULL OR payload IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;
 action:=CASE session_user WHEN 'hub2_mem' THEN 'mem.read' WHEN 'hub2_v8' THEN 'v8.project.read' ELSE NULL END;
 IF action IS NULL THEN RAISE EXCEPTION 'domain_identity_required' USING ERRCODE='42501';END IF;c:=authz.consume_handle(h,action,d);
 IF (b->>'project_id')::uuid IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 IF b-'project_id'-'cursor'-'limit'<>'{}'::jsonb OR COALESCE(c->'resource'->'resolved_resource',c->'resource')->>'material_id' IS NOT NULL OR COALESCE(c->'resource'->'resolved_resource',c->'resource')->>'collection_id' IS NOT NULL OR COALESCE(c->'resource'->'resolved_resource',c->'resource')->>'area_id' IS NOT NULL OR COALESCE(c->'resource'->'resolved_resource',c->'resource')->>'version_id' IS NOT NULL THEN RAISE EXCEPTION 'project_scope_required' USING ERRCODE='42501';END IF;
 SELECT value INTO high FROM evidence.delivery_counter WHERE id;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO items FROM (SELECT 'mem' domain,id aggregate_id,event_revision aggregate_revision,state FROM mem.materials WHERE project_id=(c->>'project_id')::uuid AND (current_version_id IS NULL OR mem.version_visible((c->>'actor_id')::uuid,current_version_id)) UNION ALL SELECT 'v8',id,event_revision,state FROM v8.work_items WHERE project_id=(c->>'project_id')::uuid) x;
 PERFORM authz.assert_effect(h);
 INSERT INTO evidence.feed_cursors(actor_id,client_id,project_id,seq) VALUES((c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'project_id')::uuid,high) RETURNING id INTO snapshot_cursor;
 RETURN jsonb_build_object('snapshot_id',gen_random_uuid(),'delivery_highwater',snapshot_cursor,'aggregates',items,'coverage','project_material_and_work_revisions','late_delivery_policy','deduplicate_by_snapshot_revision_and_event_group');
END $$;
REVOKE ALL ON FUNCTION evidence.project_changes(uuid,text,text),evidence.project_snapshot(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.project_changes(uuid,text,text),evidence.project_snapshot(uuid,text,text) TO hub2_mem,hub2_v8,hub2_mem_owner,hub2_v8_owner;
RESET ROLE;
SET ROLE hub2_evidence_owner;
CREATE FUNCTION evidence.ready_tasks(n integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$ DECLARE r jsonb;BEGIN
 IF n IS NULL OR n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_limit';END IF;PERFORM evidence.worker_guard('worker.maintenance');
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO r FROM (SELECT id,kind,attempt FROM jobs.tasks WHERE (state IN ('pending','retry') AND run_after<=clock_timestamp()) OR (state='running' AND lease_until<=clock_timestamp()) ORDER BY run_after,created_at LIMIT n) x;RETURN r;END $$;
REVOKE ALL ON FUNCTION evidence.ready_tasks(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.ready_tasks(integer) TO hub2_worker;
RESET ROLE;
SET ROLE hub2_evidence_owner;
CREATE FUNCTION evidence.seed_consumer(c text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$ DECLARE high bigint;BEGIN
 IF c IS NULL OR current_setting('transaction_isolation') IS DISTINCT FROM 'repeatable read' THEN RAISE EXCEPTION 'repeatable_read_required';END IF;PERFORM evidence.worker_guard('worker.consume');
 IF NOT EXISTS(SELECT FROM evidence.consumers WHERE name=c AND active) THEN RAISE EXCEPTION 'unknown_consumer' USING ERRCODE='42501';END IF;
 INSERT INTO evidence.consumer_progress(consumer) VALUES(c) ON CONFLICT DO NOTHING;
 PERFORM consumer FROM evidence.consumer_progress WHERE consumer=c FOR UPDATE;
 SELECT value INTO high FROM evidence.delivery_counter WHERE id;
 PERFORM evidence.worker_guard('worker.consume');
 -- Complete committed groups provide the deterministic projection snapshot. Incomplete groups remain repairable.
 INSERT INTO evidence.projection(consumer,domain,aggregate_id,project_id,revision,state,last_seq)
 SELECT c,x.domain,x.aggregate_id,x.project_id,max(x.aggregate_revision),'current',high FROM (
 SELECT domain,aggregate_id,project_id,aggregate_revision FROM evidence.outbox GROUP BY domain,aggregate_id,project_id,aggregate_revision HAVING count(*)=min(group_size) AND min(group_size)=max(group_size) AND count(DISTINCT event_group)=1 AND min(group_index)=1 AND max(group_index)=max(group_size)) x GROUP BY x.domain,x.aggregate_id,x.project_id
 ON CONFLICT(consumer,domain,aggregate_id) DO UPDATE SET revision=EXCLUDED.revision,state='current',last_seq=high;
 UPDATE evidence.consumer_progress SET scanned_seq=high,gap_count=0 WHERE consumer=c;
 RETURN jsonb_build_object('state','snapshot_seeded','delivery_highwater',high,'coverage','complete_committed_event_groups_only');END $$;
REVOKE ALL ON FUNCTION evidence.seed_consumer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.seed_consumer(text) TO hub2_worker;
RESET ROLE;
SET ROLE hub2_evidence_owner;
CREATE FUNCTION evidence.assert_task(id uuid,attempt bigint,fence uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
#variable_conflict use_variable
DECLARE t jobs.tasks;
BEGIN
 IF id IS NULL OR attempt IS NULL OR fence IS NULL THEN RAISE EXCEPTION 'invalid_attempt';END IF;
 PERFORM evidence.worker_guard('worker.maintenance');SELECT * INTO t FROM jobs.tasks x WHERE x.id=id FOR UPDATE;
 IF t.id IS NULL OR t.state<>'running' OR t.attempt IS DISTINCT FROM attempt OR t.fencing_token IS DISTINCT FROM fence OR t.lease_until IS NULL OR t.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'stale_worker_attempt' USING ERRCODE='40001';END IF;
 PERFORM evidence.worker_guard('worker.maintenance');RETURN jsonb_build_object('task_id',t.id,'kind',t.kind,'payload',t.payload);
END $$;
REVOKE ALL ON FUNCTION evidence.assert_task(uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.assert_task(uuid,bigint,uuid) TO hub2_worker,hub2_mem_owner,hub2_v8_owner;
RESET ROLE;
SET ROLE hub2_evidence_owner;
CREATE FUNCTION evidence.task_receipt(id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$ BEGIN IF id IS NULL THEN RAISE EXCEPTION 'task_required';END IF;PERFORM evidence.worker_guard('worker.maintenance');RETURN (SELECT jsonb_build_object('task_id',t.id,'state',t.state,'attempt',t.attempt,'result',t.result,'error_code',t.error_code) FROM jobs.tasks t WHERE t.id=id);END $$;
REVOKE ALL ON FUNCTION evidence.task_receipt(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.task_receipt(uuid) TO hub2_worker;
RESET ROLE;
SET ROLE hub2_evidence_owner;
CREATE FUNCTION evidence.task_event(id uuid,attempt bigint,fence uuid,domain text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
#variable_conflict use_variable
DECLARE proof jsonb;e evidence.outbox;
BEGIN
 IF domain IS NULL OR domain NOT IN ('mem','v8','authz') THEN RAISE EXCEPTION 'invalid_domain';END IF;
 proof:=evidence.assert_task(id,attempt,fence);
 SELECT * INTO e FROM evidence.outbox o WHERE o.id=(proof->'payload'->>'event_id')::uuid AND o.domain=domain AND o.aggregate_id=(proof->'payload'->>'aggregate_id')::uuid AND o.aggregate_revision=(proof->'payload'->>'revision')::bigint;
 IF e.id IS NULL THEN RAISE EXCEPTION 'task_event_scope_mismatch' USING ERRCODE='42501';END IF;
 RETURN to_jsonb(e)-'delivered_at';END $$;
REVOKE ALL ON FUNCTION evidence.task_event(uuid,bigint,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.task_event(uuid,bigint,uuid,text) TO hub2_mem_owner,hub2_v8_owner;
RESET ROLE;
