-- Only the existing progress route calls this directed-member reply function.
SET ROLE hub2_v8_owner;
CREATE OR REPLACE FUNCTION v8.handoff_reply_binding(hid uuid)
 RETURNS TABLE(from_actor_id uuid,to_actor_id uuid,project_id uuid)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $binding$
 SELECT h.from_actor_id,h.to_actor_id,w.project_id FROM v8.handoffs h JOIN v8.work_items w ON w.id=h.work_item_id WHERE h.id=hid
 $binding$;
REVOKE ALL ON FUNCTION v8.handoff_reply_binding(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.handoff_reply_binding(uuid) TO hub2_authz_owner,hub2_evidence_owner;

CREATE OR REPLACE FUNCTION v8.handoff_progress_member(proof text,d text,p text,source jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $fn$
DECLARE b jsonb:=p::jsonb;c jsonb;fresh jsonb;r jsonb;hh v8.handoffs;o uuid:=gen_random_uuid();phase text;ev bigint;f jsonb;gen bigint;details jsonb;
BEGIN
 IF encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 IF b-ARRAY['project_id','handoff_id','expected_revision','handling_state','summary','outputs','limitations','idempotency_key']<>'{}'::jsonb
    OR NOT b?&ARRAY['project_id','handoff_id','expected_revision','handling_state','idempotency_key']
    OR length(coalesce(b->>'idempotency_key','')) NOT BETWEEN 1 AND 200
    OR length(coalesce(b->>'summary',''))>8000
    OR jsonb_typeof(coalesce(b->'outputs','[]'))<>'array'
    OR jsonb_array_length(coalesce(b->'outputs','[]'))>100
    OR jsonb_typeof(coalesce(b->'limitations','[]'))<>'array' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 c:=authz.handoff_reply_context(proof,(b->>'project_id')::uuid,(b->>'handoff_id')::uuid,b);
 gen:=coord.handoff_reply_writer((c->>'project_id')::uuid,(b->>'handoff_id')::uuid,(c->>'actor_id')::uuid);
 r:=v8.replay(c,'handoff_progress',b,d);IF r IS NOT NULL THEN RETURN r;END IF;
 SELECT h.* INTO hh FROM v8.handoffs h JOIN v8.work_items w ON w.id=h.work_item_id
  WHERE h.id=(b->>'handoff_id')::uuid AND w.project_id=(c->>'project_id')::uuid FOR UPDATE OF h;
 -- Same locks and relationship are rechecked at effect; no authority from body UUIDs.
 fresh:=authz.handoff_reply_context(proof,(b->>'project_id')::uuid,hh.id,b);
 IF fresh->>'actor_id' IS DISTINCT FROM c->>'actor_id' OR fresh->>'client_id' IS DISTINCT FROM c->>'client_id'
    OR fresh->>'project_revision' IS DISTINCT FROM c->>'project_revision' THEN RAISE EXCEPTION 'handoff_reply_authority_changed' USING ERRCODE='42501';END IF;
 IF hh.event_revision IS DISTINCT FROM (b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'handoff_revision_conflict' USING ERRCODE='40001';END IF;
 phase:=b->>'handling_state';
 IF phase IN('withdrawn','confirmed') THEN
  IF hh.from_actor_id<>(c->>'actor_id')::uuid THEN RAISE EXCEPTION 'sender_required' USING ERRCODE='42501';END IF;
 ELSIF phase IN('in_progress','needs_information','waiting_external','delivered','declined') THEN
  IF hh.to_actor_id<>(c->>'actor_id')::uuid THEN RAISE EXCEPTION 'recipient_required' USING ERRCODE='42501';END IF;
 ELSE RAISE EXCEPTION 'handling_state_required' USING ERRCODE='22023';END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(coalesce(b->'outputs','[]')) LOOP
  IF NOT EXISTS(SELECT FROM mem.content_versions v WHERE v.id=(f->>'version_id')::uuid
       AND v.material_id=(f->>'material_id')::uuid AND v.sha256=f->>'sha256') THEN
   RAISE EXCEPTION 'invalid_fixed_reference' USING ERRCODE='22023';END IF;
 END LOOP;
 UPDATE v8.handoffs SET handling_state=phase,handling_result=hh.handling_result||jsonb_build_object(
  'summary',coalesce(b->>'summary',''),'outputs',coalesce(nullif(b->'outputs','[]'::jsonb),hh.handling_result->'outputs','[]'::jsonb),
  'limitations',coalesce(nullif(b->'limitations','[]'::jsonb),hh.handling_result->'limitations','[]'::jsonb),
  'delivery_result',CASE WHEN phase='delivered' THEN jsonb_build_object('summary',b->>'summary','outputs',b->'outputs','limitations',b->'limitations') ELSE hh.handling_result->'delivery_result' END,
  'actor_id',c->>'actor_id','client_id',c->>'client_id','judgment','agent_declared;not_automatic_external_verification'),
  updated_at=clock_timestamp(),event_revision=event_revision+1 WHERE id=hh.id RETURNING event_revision INTO ev;
 details:=jsonb_build_object('work_item_id',hh.work_item_id,'summary',b->>'summary','outputs',b->'outputs','handling_state',phase,
  'authority','current_handoff_participant_reply_only','writer_generation',gen,'source_context_declared',source);
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,revision,operation_id,details)
  VALUES((c->>'actor_id')::uuid,(c->>'client_id')::uuid,'v8','handoff.handling.'||phase,hh.id,ev,o,details);
 INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload)
  VALUES('v8',hh.id,ev,'handoff.handling.'||phase,(c->>'project_id')::uuid,details);
 r:=jsonb_build_object('state','saved','handoff_id',hh.id,'work_item_id',hh.work_item_id,'handling_state',phase,'revision',ev,'operation_id',o,
  'effect','coordination_status_only;no_authorization_or_deployment','retryable',false,'retained_state','registered','next_step','continue_with_fixed_refs');
 INSERT INTO v8.operations(id,actor_id,client_id,project_id,idempotency_key,fingerprint,action,state,result)
  VALUES(o,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'project_id')::uuid,b->>'idempotency_key',d,'handoff_progress','committed',r);
 PERFORM authz.handoff_reply_context(proof,(b->>'project_id')::uuid,hh.id,b);
 RETURN r;
END $fn$;
REVOKE ALL ON FUNCTION v8.handoff_progress_member(text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.handoff_progress_member(text,text,text,jsonb) TO hub2_v8;
RESET ROLE;
