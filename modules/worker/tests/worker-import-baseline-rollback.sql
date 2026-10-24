-- Run only inside the enclosing rollback transaction; synthetic objects never commit.
SET LOCAL ROLE hub2_evidence_owner;
DO $test$
DECLARE c text:='baseline-test-'||gen_random_uuid();base bigint;mid uuid:=gen_random_uuid();pid uuid:=gen_random_uuid();
 eid uuid:=gen_random_uuid();bad uuid:=gen_random_uuid();missing uuid:=gen_random_uuid();v8event uuid:=gen_random_uuid();
 ref jsonb;body jsonb;actor uuid:=gen_random_uuid();client uuid:=gen_random_uuid();result jsonb;water_before bigint;task_before bigint;
BEGIN
 SELECT value INTO base FROM evidence.delivery_counter WHERE id FOR UPDATE;
 UPDATE evidence.delivery_counter SET value=base+10 WHERE id;
 INSERT INTO evidence.consumers(name)VALUES(c);
 INSERT INTO evidence.consumer_progress(consumer,scanned_seq)VALUES(c,base+10);
 ref:=jsonb_build_array(jsonb_build_object('material_id',mid,'version_id',gen_random_uuid(),'sha256',repeat('a',64),'size',42));
 body:=jsonb_build_object('material_id',mid,'fixed_refs',ref,'execution_authority','authorized_operational_import');
 INSERT INTO evidence.outbox(id,domain,aggregate_id,aggregate_revision,event_type,project_id,payload,delivered_at,occurred_at)
 VALUES(eid,'mem',mid,2,'material.legacy_migrated',pid,body,clock_timestamp(),clock_timestamp()-interval '1 minute');
 INSERT INTO evidence.delivery(seq,event_id)VALUES(base+1,eid);
 INSERT INTO evidence.projection(consumer,domain,aggregate_id,project_id,state)VALUES(c,'mem',mid,pid,'gap');
 IF evidence.proved_import_baseline(eid) THEN RAISE EXCEPTION 'unaudited import accepted';END IF;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,revision,operation_id,details)
 VALUES(actor,client,'mem','material.legacy_migrated',mid,2,gen_random_uuid(),
 jsonb_build_object('material_id',mid,'fixed_refs',ref,'execution_authority','explicitly_authorized_OS_root_migration','ordinary_handle_claimed',false));
 IF NOT evidence.proved_import_baseline(eid) THEN RAISE EXCEPTION 'audited import rejected';END IF;
 UPDATE evidence.outbox SET group_size=2 WHERE id=eid;
 IF evidence.proved_import_baseline(eid) THEN RAISE EXCEPTION 'partial group accepted';END IF;
 UPDATE evidence.outbox SET group_size=1 WHERE id=eid;
 INSERT INTO evidence.outbox(id,domain,aggregate_id,aggregate_revision,event_type,project_id,payload)VALUES(missing,'mem',mid,1,'material.created',pid,'{}');
 IF evidence.proved_import_baseline(eid) THEN RAISE EXCEPTION 'real revision1 skipped';END IF;
 DELETE FROM evidence.outbox WHERE id=missing;
 INSERT INTO evidence.outbox(id,domain,aggregate_id,aggregate_revision,event_type,project_id,payload,delivered_at)
 VALUES(bad,'mem',gen_random_uuid(),2,'material.published',pid,'{}',clock_timestamp());
 INSERT INTO evidence.delivery(seq,event_id)VALUES(base+2,bad);
 IF evidence.proved_import_baseline(bad) THEN RAISE EXCEPTION 'ordinary missing creation accepted';END IF;
 -- A project created by the operational importer has no creation event either.
 INSERT INTO evidence.outbox(id,domain,aggregate_id,aggregate_revision,event_type,project_id,payload,delivered_at)
 VALUES(v8event,'v8',pid,2,'project.governance_saved',pid,'{"revision":2,"governance":{}}',clock_timestamp());
 INSERT INTO evidence.delivery(seq,event_id)VALUES(base+3,v8event);
 IF evidence.proved_import_baseline(v8event) THEN RAISE EXCEPTION 'unaudited project accepted';END IF;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,revision,operation_id,details)
 VALUES(actor,client,'v8','project.governance_saved',pid,2,gen_random_uuid(),'{"revision":2,"governance":{}}');
 IF NOT evidence.proved_import_baseline(v8event) THEN RAISE EXCEPTION 'import project proof rejected';END IF;
 INSERT INTO evidence.projection(consumer,domain,aggregate_id,project_id,state)VALUES(c,'v8',pid,pid,'gap');
 SELECT scanned_seq INTO water_before FROM evidence.consumer_progress WHERE consumer=c;
 SELECT count(*)INTO task_before FROM jobs.tasks;
 result:=evidence.establish_import_baselines(c,1,base+10);
 IF result->>'applied'<>'1' THEN RAISE EXCEPTION 'batch bound failed';END IF;
 result:=evidence.establish_import_baselines(c,1,base+10);
 IF result->>'applied'<>'1' THEN RAISE EXCEPTION 'second baseline not repaired';END IF;
 result:=evidence.establish_import_baselines(c,1,base+10);
 IF result->>'applied'<>'0' THEN RAISE EXCEPTION 'repair not idempotent';END IF;
 IF (SELECT scanned_seq FROM evidence.consumer_progress WHERE consumer=c)<>water_before THEN RAISE EXCEPTION 'stream cursor changed';END IF;
 IF (SELECT count(*)FROM jobs.tasks)<>task_before THEN RAISE EXCEPTION 'unexpected derived effects';END IF;
 IF (SELECT count(*)FROM evidence.import_baseline_observations WHERE consumer=c)<>2
 OR (SELECT count(*)FROM evidence.inbox WHERE consumer=c)<>2 THEN RAISE EXCEPTION 'baseline audit or actual event ack missing';END IF;
 -- Proven initial baseline must never authorize skipping a later missing version3.
 INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload,delivered_at)
 VALUES('mem',mid,4,'metadata.changed',pid,'{}',clock_timestamp()) RETURNING id INTO missing;
 INSERT INTO evidence.delivery(seq,event_id)VALUES(base+4,missing);
 PERFORM evidence.establish_import_baselines(c,500,base+10);
 IF (SELECT revision FROM evidence.projection WHERE consumer=c AND domain='mem' AND aggregate_id=mid)<>2 THEN RAISE EXCEPTION 'intermediate gap skipped';END IF;
 IF has_function_privilege('hub2_worker','evidence.establish_import_baselines(text,integer,bigint)','EXECUTE')
 OR has_function_privilege('hub2_mem','evidence.proved_import_baseline(uuid)','EXECUTE') THEN RAISE EXCEPTION 'private repair exposed';END IF;
 RAISE NOTICE 'import-baseline rollback regression passed: audit proof, incomplete group, real creation, generic gap, project proof, bounded batches, idempotency, preserved cursor/tasks, later gap, ACL';
END $test$;
RESET ROLE;
