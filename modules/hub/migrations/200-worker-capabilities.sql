-- Additive maintenance capabilities. Current service authority and attempt fences remain required.
SET ROLE hub2_evidence_owner;
CREATE OR REPLACE FUNCTION evidence.task_receipt(id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
#variable_conflict use_variable
BEGIN
 IF id IS NULL THEN RAISE EXCEPTION 'task_required';END IF;
 PERFORM evidence.worker_guard('worker.maintenance');
 RETURN (SELECT jsonb_build_object('task_id',t.id,'state',t.state,'attempt',t.attempt,'result',t.result,'error_code',t.error_code) FROM jobs.tasks t WHERE t.id=id);
END $$;
CREATE FUNCTION evidence.renew_task(id uuid,attempt bigint,fence uuid,seconds integer DEFAULT 60) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
#variable_conflict use_variable
DECLARE proof jsonb;expiry timestamptz;
BEGIN
 IF seconds IS NULL OR seconds NOT BETWEEN 1 AND 600 THEN RAISE EXCEPTION 'invalid_lease';END IF;
 proof:=evidence.assert_task(id,attempt,fence);
 PERFORM evidence.worker_guard('worker.maintenance');
 UPDATE jobs.tasks t SET lease_until=clock_timestamp()+make_interval(secs=>seconds),updated_at=clock_timestamp() WHERE t.id=id RETURNING lease_until INTO expiry;
 RETURN proof||jsonb_build_object('lease_until',expiry);
END $$;
CREATE FUNCTION evidence.cancel_task(id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
#variable_conflict use_variable
DECLARE t jobs.tasks;
BEGIN
 IF id IS NULL THEN RAISE EXCEPTION 'task_required';END IF;
 PERFORM evidence.worker_guard('worker.maintenance');SELECT * INTO t FROM jobs.tasks x WHERE x.id=id FOR UPDATE;
 PERFORM evidence.worker_guard('worker.maintenance');
 IF t.id IS NULL THEN RETURN jsonb_build_object('state','absent');END IF;
 IF t.state IN ('done','dead') THEN RETURN evidence.task_receipt(id);END IF;
 UPDATE jobs.tasks x SET state='dead',error_code='task_cancelled',fencing_token=gen_random_uuid(),lease_until=NULL,updated_at=clock_timestamp() WHERE x.id=id;
 UPDATE jobs.attempts x SET state='dead',error_code='task_cancelled',finished_at=clock_timestamp() WHERE x.task_id=id AND x.attempt=t.attempt AND x.state='running';
 RETURN jsonb_build_object('task_id',id,'state','cancelled','retained_state','prior_committed_effects_preserved');
END $$;
CREATE FUNCTION evidence.task_scope(id uuid,attempt bigint,fence uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
DECLARE p jsonb;e evidence.outbox;
BEGIN
 p:=evidence.assert_task(id,attempt,fence);
 SELECT * INTO e FROM evidence.outbox o WHERE o.id=(p->'payload'->>'event_id')::uuid AND o.domain=p->'payload'->>'domain' AND o.aggregate_id=(p->'payload'->>'aggregate_id')::uuid AND o.aggregate_revision=(p->'payload'->>'revision')::bigint;
 IF e.id IS NULL THEN RAISE EXCEPTION 'task_event_scope_mismatch' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('kind',p->'kind','domain',e.domain,'event_type',e.event_type,'project_id',e.project_id,'aggregate_id',e.aggregate_id,'event_id',e.id,'revision',e.aggregate_revision);
END $$;
REVOKE ALL ON FUNCTION evidence.renew_task(uuid,bigint,uuid,integer),evidence.cancel_task(uuid),evidence.task_scope(uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.renew_task(uuid,bigint,uuid,integer),evidence.cancel_task(uuid),evidence.task_scope(uuid,bigint,uuid) TO hub2_worker;
GRANT EXECUTE ON FUNCTION evidence.task_scope(uuid,bigint,uuid),evidence.enqueue_task(text,text,jsonb) TO hub2_mem_owner,hub2_v8_owner;
RESET ROLE;

SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.worker_index_input(id uuid,attempt bigint,fence uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE p jsonb;e jsonb;v mem.content_versions;o mem.verified_objects;
BEGIN
 p:=evidence.assert_task(id,attempt,fence);e:=evidence.task_event(id,attempt,fence,'mem');
 IF p->>'kind'<>'index' OR e->>'event_type' NOT IN ('material.published','material.restored') THEN RAISE EXCEPTION 'index_event_required' USING ERRCODE='42501';END IF;
 SELECT * INTO v FROM mem.content_versions cv WHERE cv.id=COALESCE(e->'payload'->>'version_id',e->'payload'->'fixed_refs'->0->>'version_id')::uuid AND cv.material_id=(e->>'aggregate_id')::uuid;
 IF v.id IS NULL THEN RAISE EXCEPTION 'index_version_required' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM mem.verified_objects obj WHERE obj.id=v.object_id AND obj.sha256=v.sha256 AND obj.size=v.size;
 IF o.id IS NULL OR o.availability<>'available' THEN RAISE EXCEPTION 'index_object_unavailable';END IF;
 RETURN jsonb_build_object('version_id',v.id,'sha256',v.sha256,'size',v.size,'object',jsonb_build_object('provider',o.provider,'bucket',o.bucket,'key',o.object_key,'versionId',o.provider_version_id));
END $$;
CREATE FUNCTION mem.worker_index_apply(id uuid,attempt bigint,fence uuid,prepared jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE source jsonb;
BEGIN
 source:=mem.worker_index_input(id,attempt,fence);
 IF prepared->>'version_id' IS DISTINCT FROM source->>'version_id' OR prepared->>'sha256' IS DISTINCT FROM source->>'sha256' THEN RAISE EXCEPTION 'index_fixed_version_mismatch' USING ERRCODE='42501';END IF;
 IF prepared->>'state'='awaiting_extraction' THEN RETURN jsonb_build_object('state','awaiting_extraction','version_id',source->'version_id','processing_pending',true,'coverage','unsupported_text_encoding_or_extraction_size','next_step','authorized_agent_can_extract_and_call_index_text');END IF;
 IF prepared->>'recipe' IS DISTINCT FROM 'zh-character-bigram-v1' OR prepared->>'text' IS NULL OR prepared->>'token_text' IS NULL OR length(prepared->>'text')>500000 THEN RAISE EXCEPTION 'invalid_index_input';END IF;
 IF encode(public.digest(prepared->>'text','sha256'),'hex') IS DISTINCT FROM source->>'sha256' THEN RAISE EXCEPTION 'index_object_integrity_mismatch' USING ERRCODE='42501';END IF;
 PERFORM evidence.assert_task(id,attempt,fence);
 INSERT INTO mem.text_index(version_id,recipe,text_content,tokens,coverage) VALUES((source->>'version_id')::uuid,prepared->>'recipe',prepared->>'text',to_tsvector('simple',prepared->>'token_text'),'complete') ON CONFLICT(version_id) DO NOTHING;
 RETURN jsonb_build_object('state','indexed','version_id',source->'version_id','coverage','complete_utf8_text','recipe','zh-character-bigram-v1');
END $$;
CREATE FUNCTION mem.worker_enqueue_recovery(n integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE o mem.operations;total integer:=0;
BEGIN
 IF n IS NULL OR n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_limit';END IF;
 -- This guard runs even if there are no candidates.
 PERFORM evidence.ready_tasks(1);
 FOR o IN SELECT * FROM mem.operations WHERE state='verifying' AND lease_until<=clock_timestamp() AND object_id IS NULL ORDER BY lease_until,id LIMIT n LOOP
  PERFORM evidence.enqueue_task('verification_compensation','verify-recovery:'||o.id||':'||o.attempt,jsonb_build_object('operation_id',o.id,'expected_attempt',o.attempt,'expected_fence',o.fencing_token));total:=total+1;
 END LOOP;
 RETURN jsonb_build_object('enqueued',total);
END $$;
CREATE FUNCTION mem.worker_recover_verification(id uuid,attempt bigint,fence uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE p jsonb;o mem.operations;
BEGIN
 p:=evidence.assert_task(id,attempt,fence);
 IF p->>'kind'<>'verification_compensation' THEN RAISE EXCEPTION 'verification_task_required' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM mem.operations WHERE operations.id=(p->'payload'->>'operation_id')::uuid FOR UPDATE;
 IF o.id IS NULL THEN RAISE EXCEPTION 'verification_operation_required';END IF;
 PERFORM evidence.assert_task(id,attempt,fence);
 IF o.state='verifying' AND o.lease_until<=clock_timestamp() AND o.object_id IS NULL AND o.attempt=(p->'payload'->>'expected_attempt')::bigint AND o.fencing_token=(p->'payload'->>'expected_fence')::uuid THEN
  UPDATE mem.operations SET state='prepared',fencing_token=gen_random_uuid(),lease_until=NULL WHERE operations.id=o.id;
  RETURN jsonb_build_object('operation_id',o.id,'state','prepared','retained_state','staging_and_operation_preserved','next_step','authorized_caller_can_resume_publish');
 END IF;
 RETURN jsonb_build_object('operation_id',o.id,'state','already_current','operation_state',o.state,'retained_state','operation_and_fixed_objects_preserved');
END $$;
REVOKE ALL ON FUNCTION mem.worker_index_input(uuid,bigint,uuid),mem.worker_index_apply(uuid,bigint,uuid,jsonb),mem.worker_enqueue_recovery(integer),mem.worker_recover_verification(uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.worker_index_input(uuid,bigint,uuid),mem.worker_index_apply(uuid,bigint,uuid,jsonb),mem.worker_enqueue_recovery(integer),mem.worker_recover_verification(uuid,bigint,uuid) TO hub2_worker;
RESET ROLE;
GRANT EXECUTE ON FUNCTION evidence.ready_tasks(integer) TO hub2_mem_owner;

SET ROLE hub2_v8_owner;
CREATE FUNCTION v8.worker_invalidate_views(id uuid,attempt bigint,fence uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE p jsonb;n integer;
BEGIN
 p:=evidence.task_scope(id,attempt,fence);
 IF p->>'kind'<>'projection_invalidation' THEN RAISE EXCEPTION 'invalidation_task_required' USING ERRCODE='42501';END IF;
 -- Expire cached returned views; preserve manifests and narratives. Reads already refresh actual authorization and source warnings.
 UPDATE v8.context_views cv SET expires_at=least(cv.expires_at,clock_timestamp()) FROM v8.context_manifests cm WHERE cv.context_id=cm.id AND cm.project_id=(p->>'project_id')::uuid AND cv.expires_at>clock_timestamp();GET DIAGNOSTICS n=ROW_COUNT;
 PERFORM evidence.assert_task(id,attempt,fence);
 RETURN jsonb_build_object('state','refresh_required','affected_views',n,'retained_state','historical_views_and_manifests_preserved','coverage','event_project_cached_views_only','semantic_impact','agent_assessment_pending');
END $$;
REVOKE ALL ON FUNCTION v8.worker_invalidate_views(uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.worker_invalidate_views(uuid,bigint,uuid) TO hub2_worker;
RESET ROLE;
