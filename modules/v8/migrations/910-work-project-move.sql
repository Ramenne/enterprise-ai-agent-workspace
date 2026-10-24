BEGIN;
SET ROLE hub2_v8_owner;
CREATE OR REPLACE FUNCTION v8.work_project_move(h uuid,target_h uuid,d text,p text,target_d text,target_p text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb:=p::jsonb;tb jsonb:=target_p::jsonb;c jsonb;tc jsonb;r jsonb;source v8.projects;target v8.projects;w v8.work_items;o uuid:=gen_random_uuid();note jsonb;canonical text;prior jsonb;
BEGIN
 IF p IS NULL OR target_p IS NULL OR d IS NULL OR target_d IS NULL OR encode(public.digest(p,'sha256'),'hex')IS DISTINCT FROM d OR encode(public.digest(target_p,'sha256'),'hex')IS DISTINCT FROM target_d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 IF b->>'expected_revision'IS NULL OR (b->>'expected_revision')::bigint<1 OR b-ARRAY['project_id','target_project_id','work_item_id','expected_revision','idempotency_key','reason']<>'{}'::jsonb OR (b->>'project_id')::uuid=(b->>'target_project_id')::uuid OR tb<>jsonb_build_object('project_id',b->'target_project_id','idempotency_key',b->'idempotency_key')THEN RAISE EXCEPTION 'invalid_move_target' USING ERRCODE='22023';END IF;
 c:=v8.guard(h,'v8.work.commit',d,b);tc:=v8.guard(target_h,'v8.work.commit',target_d,tb);
 IF c->>'actor_id'IS DISTINCT FROM tc->>'actor_id' OR c->>'client_id'IS DISTINCT FROM tc->>'client_id' THEN RAISE EXCEPTION 'move_identity_mismatch' USING ERRCODE='42501';END IF;
 r:=v8.replay(c,'work_project_move',b,d);IF r IS NOT NULL THEN PERFORM authz.assert_effect(h);PERFORM authz.assert_effect(target_h);RETURN r;END IF;
 PERFORM 1 FROM v8.projects WHERE id IN((b->>'project_id')::uuid,(b->>'target_project_id')::uuid)ORDER BY id FOR UPDATE;
 SELECT * INTO source FROM v8.projects WHERE id=(b->>'project_id')::uuid;SELECT * INTO target FROM v8.projects WHERE id=(b->>'target_project_id')::uuid;
 -- This route is a narrow correction within one personal audience. Team or
 -- different-owner moves require a separate explicit disclosure decision.
 IF source.id IS NULL OR target.id IS NULL OR source.organization_id<>target.organization_id OR source.visibility<>'personal'OR target.visibility<>'personal'OR source.owner_id<>target.owner_id OR source.owner_id<>(c->>'actor_id')::uuid THEN RAISE EXCEPTION 'same_personal_owner_scope_required' USING ERRCODE='42501';END IF;
 w:=v8.lock_work(c,(b->>'work_item_id')::uuid);
 IF w.revision<>(b->>'expected_revision')::bigint THEN RETURN v8.remember(c,'work_project_move',b,d,o,jsonb_build_object('state','conflict','error_code','revision_conflict','work_item_id',w.id,'domain_revision',w.revision,'retained_state','association_unchanged'));END IF;
 PERFORM authz.assert_effect(h);PERFORM authz.assert_effect(target_h);
 prior:=to_jsonb(w)||jsonb_build_object('fixed_refs',(SELECT coalesce(jsonb_agg(jsonb_build_object('material_id',material_id,'version_id',version_id,'sha256',sha256,'role',role)),'[]')FROM v8.results WHERE work_item_id=w.id));
 INSERT INTO v8.work_snapshots(work_item_id,work_revision,record,canonical_text,sha256)VALUES(w.id,w.revision,prior,v8.canonical_json(prior),encode(public.digest(v8.canonical_json(prior),'sha256'),'hex'))ON CONFLICT DO NOTHING;
 UPDATE v8.work_items SET project_id=target.id,revision=revision+1,event_revision=event_revision+1,updated_at=clock_timestamp()WHERE id=w.id RETURNING * INTO w;
 note:=jsonb_build_object('work_item_id',w.id,'project_id',target.id,'previous_project_id',source.id,'previous_revision',w.revision-1,'work_revision',w.revision,'kind','project_association_correction','reason',b->'reason','properties',jsonb_build_object('governance',jsonb_build_object('purpose','business','association_state','corrected_same_personal_scope')),'history_semantics','prior_statements_and_fixed_refs_retained_with_original_scope');canonical:=v8.canonical_json(note);
 INSERT INTO v8.work_updates(id,work_item_id,work_revision,actor_id,client_id,source_context_id,payload,canonical_text,sha256)VALUES(o,w.id,w.revision,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'source_context_id')::uuid,note,canonical,encode(public.digest(canonical,'sha256'),'hex'));
 PERFORM v8.emit(tc,'work.project_association_changed',w.id,w.event_revision,o,jsonb_build_object('previous_project_id',source.id,'target_project_id',target.id,'short_no',w.short_no));
 RETURN v8.remember(c,'work_project_move',b,d,o,jsonb_build_object('state','moved','work_item',to_jsonb(w),'work_item_id',w.id,'short_no',w.short_no,'project_id',target.id,'domain_revision',w.revision,'receipt',note,'coverage','same_owner_personal_scope;historical_original_statements_and_fixed_refs_retained'));
END $$;
REVOKE ALL ON FUNCTION v8.work_project_move(uuid,uuid,text,text,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.work_project_move(uuid,uuid,text,text,text,text)TO hub2_v8;
RESET ROLE;
COMMIT;
