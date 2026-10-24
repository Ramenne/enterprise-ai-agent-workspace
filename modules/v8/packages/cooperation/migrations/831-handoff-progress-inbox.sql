BEGIN;
ALTER TABLE v8.handoffs ADD COLUMN IF NOT EXISTS handling_state text;
ALTER TABLE v8.handoffs ADD COLUMN IF NOT EXISTS handling_result jsonb NOT NULL DEFAULT '{}';
ALTER TABLE v8.handoffs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE OR REPLACE FUNCTION v8.handoff_inbox_for_member(proof text,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE i jsonb;out_ jsonb;lim int;off_ int;vw text;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' THEN RAISE EXCEPTION 'hufu_runtime_required' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);PERFORM authz.require_client_capability(i,'v8.handoff.read');
 lim:=coalesce((b->>'limit')::int,50);off_:=coalesce((b->>'offset')::int,0);vw:=coalesce(b->>'view','received');
 IF lim NOT BETWEEN 1 AND 100 OR off_<0 OR vw NOT IN('received','sent') THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(x.item ORDER BY x.created_at DESC,x.id DESC),'[]') INTO out_ FROM (
  SELECT hh.id,hh.created_at,jsonb_build_object('kind','cooperation','handoff_id',hh.id,'project_id',w.project_id,'project_title',pr.title,'work_item_id',w.id,'work_no',w.short_no,'from_actor_id',hh.from_actor_id,'to_actor_id',hh.to_actor_id,'rationale',hh.rationale,'next_actions',hh.next_actions,'handoff_state',hh.state,'handling_state',coalesce(hh.handling_state,CASE WHEN hh.state IN('accepted','continued') THEN 'in_progress' WHEN hh.state='declined' THEN 'declined' ELSE 'submitted' END),'result',hh.handling_result,'revision',hh.event_revision,'created_at',hh.created_at,'updated_at',hh.updated_at) item
  FROM v8.handoffs hh JOIN v8.work_items w ON w.id=hh.work_item_id JOIN v8.projects pr ON pr.id=w.project_id
  WHERE (CASE WHEN vw='sent' THEN hh.from_actor_id ELSE hh.to_actor_id END)=(i->>'actor_id')::uuid AND pr.state='active'
   AND (b->>'project_id' IS NULL OR pr.id=(b->>'project_id')::uuid)
   AND authz.can_read((i->>'actor_id')::uuid,pr.id) AND authz.client_resource_allowed745((i->>'client_id')::uuid,pr.id)
   AND (b->>'state' IS NULL OR coalesce(hh.handling_state,CASE WHEN hh.state IN('accepted','continued') THEN 'in_progress' WHEN hh.state='declined' THEN 'declined' ELSE 'submitted' END)=b->>'state')
  ORDER BY hh.created_at DESC,hh.id DESC LIMIT lim+1 OFFSET off_
 ) x;
 RETURN jsonb_build_object('state','read','view',vw,'items',CASE WHEN jsonb_array_length(out_)>lim THEN out_-lim ELSE out_ END,'next_offset',CASE WHEN jsonb_array_length(out_)>lim THEN off_+lim ELSE NULL END,'complete',jsonb_array_length(out_)<=lim,'authority','current_actor_received_or_sent;current_project_and_software_scope','effect','read_only');
END $$;
ALTER FUNCTION v8.handoff_inbox_for_member(text,jsonb) OWNER TO hub2_v8_owner;
REVOKE ALL ON FUNCTION v8.handoff_inbox_for_member(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.authenticate(text),authz.require_client_capability(jsonb,text),authz.client_resource_allowed745(uuid,uuid,uuid,text) TO hub2_v8_owner;
GRANT EXECUTE ON FUNCTION v8.handoff_inbox_for_member(text,jsonb) TO hub2_hufu;
GRANT USAGE ON SCHEMA v8 TO hub2_hufu;
CREATE OR REPLACE FUNCTION v8.handoff_progress(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb;c jsonb;r jsonb;hh v8.handoffs;o uuid:=gen_random_uuid();phase text;ev bigint;
BEGIN
 IF encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;c:=v8.guard(h,'v8.handoff.record',d,b);r:=v8.replay(c,'handoff_progress',b,d);IF r IS NOT NULL THEN RETURN r;END IF;
 SELECT t.* INTO hh FROM v8.handoffs t JOIN v8.work_items w ON w.id=t.work_item_id WHERE t.id=(b->>'handoff_id')::uuid AND w.project_id=(c->>'project_id')::uuid FOR UPDATE OF t;
 IF hh.id IS NULL OR (c->>'actor_id')::uuid NOT IN(hh.from_actor_id,hh.to_actor_id) THEN RAISE EXCEPTION 'handoff_participant_required' USING ERRCODE='42501';END IF;
 IF hh.event_revision IS DISTINCT FROM (b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'handoff_revision_conflict' USING ERRCODE='40001';END IF;
 phase:=b->>'handling_state';
 IF phase IN('withdrawn','confirmed') THEN
  IF hh.from_actor_id<>(c->>'actor_id')::uuid THEN RAISE EXCEPTION 'sender_required' USING ERRCODE='42501';END IF;
 ELSIF phase IN('in_progress','needs_information','waiting_external','delivered','declined') THEN
  IF hh.to_actor_id<>(c->>'actor_id')::uuid THEN RAISE EXCEPTION 'recipient_required' USING ERRCODE='42501';END IF;
 ELSE RAISE EXCEPTION 'handling_state_required' USING ERRCODE='22023';END IF;
 PERFORM authz.assert_effect(h);
 UPDATE v8.handoffs SET handling_state=phase,handling_result=hh.handling_result||jsonb_build_object('summary',coalesce(b->>'summary',''),'outputs',coalesce(nullif(b->'outputs','[]'::jsonb),hh.handling_result->'outputs','[]'::jsonb),'limitations',coalesce(nullif(b->'limitations','[]'::jsonb),hh.handling_result->'limitations','[]'::jsonb),'delivery_result',CASE WHEN phase='delivered' THEN jsonb_build_object('summary',b->>'summary','outputs',b->'outputs','limitations',b->'limitations') ELSE hh.handling_result->'delivery_result' END,'actor_id',c->>'actor_id','client_id',c->>'client_id','judgment','agent_declared;not_automatic_external_verification'),updated_at=clock_timestamp(),event_revision=event_revision+1 WHERE id=hh.id RETURNING event_revision INTO ev;
 PERFORM v8.emit(c,'handoff.handling.'||phase,hh.id,ev,o,jsonb_build_object('work_item_id',hh.work_item_id,'summary',b->>'summary','outputs',b->'outputs','handling_state',phase));
 RETURN v8.remember(c,'handoff_progress',b,d,o,jsonb_build_object('state','saved','handoff_id',hh.id,'work_item_id',hh.work_item_id,'handling_state',phase,'revision',ev,'operation_id',o,'effect','coordination_status_only;no_authorization_or_deployment'));
END $$;
ALTER FUNCTION v8.handoff_progress(uuid,text,text) OWNER TO hub2_v8_owner;
REVOKE ALL ON FUNCTION v8.handoff_progress(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.handoff_progress(uuid,text,text) TO hub2_v8;
COMMIT;
