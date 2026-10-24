SET ROLE hub2_v8_owner;
CREATE FUNCTION v8.canonical_json(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,v8 AS $$ DECLARE result text;BEGIN
 CASE jsonb_typeof(value)
 WHEN 'object' THEN SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||v8.canonical_json(val),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(value) e(key,val);
 WHEN 'array' THEN SELECT '['||COALESCE(string_agg(v8.canonical_json(val),',' ORDER BY ord),'')||']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY e(val,ord);
 ELSE result:=value::text; END CASE;RETURN result;END $$;
CREATE FUNCTION v8.guard(h uuid,a text,d text,b jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,v8 AS $$
DECLARE c jsonb; BEGIN IF session_user<>'hub2_v8' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 c:=authz.consume_handle(h,a,d);PERFORM authz.assert_request_resource(h,b);PERFORM mem.bind_request_sources(h,b,(c->>'actor_id')::uuid,a);IF (b->>'project_id')::uuid IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;RETURN c;END $$;
CREATE FUNCTION v8.replay(c jsonb,a text,b jsonb,d text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,v8 AS $$ DECLARE op v8.operations; BEGIN
 IF COALESCE(b->>'idempotency_key','')='' THEN RAISE EXCEPTION 'idempotency_key_required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended((c->>'actor_id')||'v8'||(b->>'idempotency_key'),0));
 SELECT * INTO op FROM v8.operations WHERE actor_id=(c->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key';
 IF FOUND THEN IF op.fingerprint<>d OR op.action<>a THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;RETURN op.result;END IF;RETURN NULL;END $$;
CREATE FUNCTION v8.remember(c jsonb,a text,b jsonb,d text,o uuid,r jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,v8 AS $$ BEGIN
 r:=jsonb_build_object('operation_id',o,'retryable',false,'retained_state','registered','next_step','continue_with_fixed_refs')||r;
 INSERT INTO v8.operations(id,actor_id,client_id,project_id,idempotency_key,fingerprint,action,state,result) VALUES(o,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'project_id')::uuid,b->>'idempotency_key',d,a,CASE WHEN r->>'state' IN ('conflict','rejected') THEN r->>'state' ELSE 'committed' END,r);IF r->>'state' IN ('conflict','rejected') THEN PERFORM v8.emit(c,'operation.'||(r->>'state'),o,1,o,jsonb_build_object('action',a,'error_code',r->>'error_code','retained_state',r->>'retained_state'));END IF;IF c->>'action' NOT IN('v8.project.create','v8.project.convert') THEN PERFORM authz.assert_effect((c->>'handle_id')::uuid);END IF;RETURN r;END $$;
CREATE FUNCTION v8.emit(c jsonb,a text,id uuid,rev bigint,o uuid,details jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,v8 AS $$ BEGIN
 INSERT INTO evidence.audit(actor_id,client_id,source_context_id,domain,action,aggregate_id,revision,operation_id,details) VALUES((c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'source_context_id')::uuid,'v8',a,id,rev,o,details);
 INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload) VALUES('v8',id,rev,a,(c->>'project_id')::uuid,details);IF c->>'action' NOT IN('v8.project.create','v8.project.convert') THEN PERFORM authz.assert_effect((c->>'handle_id')::uuid);END IF;END $$;
CREATE FUNCTION v8.assert_ref(c jsonb,ref jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,v8 AS $$ BEGIN PERFORM mem.assert_version_sources((c->>'handle_id')::uuid,(ref->>'version_id')::uuid,'mem.read');
 IF NOT EXISTS(SELECT 1 FROM mem.content_versions cv JOIN mem.materials m ON m.id=cv.material_id JOIN mem.verified_objects verified ON verified.id=cv.object_id AND verified.sha256=cv.sha256 AND verified.size=cv.size AND verified.availability='available' WHERE cv.id=(ref->>'version_id')::uuid AND cv.material_id=(ref->>'material_id')::uuid AND cv.sha256=ref->>'sha256' AND m.state='active' ) OR NOT mem.version_visible((c->>'actor_id')::uuid,(ref->>'version_id')::uuid) THEN RAISE EXCEPTION 'fixed_ref_forbidden' USING ERRCODE='42501';END IF;END $$;
CREATE FUNCTION v8.lock_work(c jsonb,p_id uuid) RETURNS v8.work_items LANGUAGE plpgsql SET search_path=pg_catalog,v8 AS $$ DECLARE w v8.work_items;BEGIN SELECT * INTO w FROM v8.work_items WHERE work_items.id=p_id AND project_id=(c->>'project_id')::uuid FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;RETURN w;END $$;

CREATE FUNCTION v8.project_create(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); pr v8.projects;manager uuid;
BEGIN
 IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501'; END IF;
 b:=p::jsonb;c:=v8.guard(h,'v8.project.create',d,b);
 r:=v8.replay(c,'project_create',b,d);IF r IS NOT NULL THEN RETURN r;END IF;
 IF (b->>'owner_id')::uuid IS DISTINCT FROM (c->>'actor_id')::uuid OR (b->>'organization_id')::uuid IS DISTINCT FROM (c->>'organization_id')::uuid THEN RAISE EXCEPTION 'identity_override' USING ERRCODE='42501';END IF;
 manager:=(c->>'actor_id')::uuid;
 IF b->>'visibility'='team' THEN manager:=authz.organization_manager(c);END IF;
 PERFORM authz.assert_effect(h);INSERT INTO v8.projects(id,organization_id,kind,visibility,owner_id,manager_id,title) VALUES((c->>'project_id')::uuid,(c->>'organization_id')::uuid,b->>'kind',b->>'visibility',(c->>'actor_id')::uuid,manager,b->>'title') RETURNING * INTO pr;
 IF pr.visibility='team' THEN PERFORM authz.project_scope_transition(c,pr.id,pr.revision,pr.visibility,pr.kind,pr.manager_id);END IF;
 PERFORM v8.emit(c,'project.created',pr.id,1,o,jsonb_build_object('kind',pr.kind,'visibility',pr.visibility));RETURN v8.remember(c,'project_create',b,d,o,jsonb_build_object('state','created','project',to_jsonb(pr),'domain_revision',pr.revision));
END $$;
CREATE FUNCTION v8.project_convert(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); pr v8.projects;manager uuid;
BEGIN
 IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501'; END IF;
 b:=p::jsonb;c:=v8.guard(h,'v8.project.convert',d,b);
 r:=v8.replay(c,'project_convert',b,d);IF r IS NOT NULL THEN RETURN r;END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=(c->>'project_id')::uuid;manager:=CASE WHEN b->>'visibility'='team' THEN COALESCE((b->>'manager_id')::uuid,authz.organization_manager(c)) ELSE pr.owner_id END;
 PERFORM authz.assert_effect(h);r:=authz.project_scope_transition(c,(c->>'project_id')::uuid,(b->>'expected_revision')::bigint,b->>'visibility',b->>'kind',manager);
 SELECT * INTO pr FROM v8.projects WHERE id=(c->>'project_id')::uuid FOR UPDATE;
 UPDATE v8.projects SET visibility=b->>'visibility',kind=b->>'kind',manager_id=(r->>'manager_id')::uuid,revision=revision+1,epoch=epoch+1,event_revision=event_revision+1 WHERE id=pr.id RETURNING * INTO pr;
 PERFORM v8.emit(c,'project.scope_changed',pr.id,pr.event_revision,o,jsonb_build_object('revision',pr.revision,'visibility',pr.visibility,'kind',pr.kind));RETURN v8.remember(c,'project_convert',b,d,o,jsonb_build_object('state','converted','project',to_jsonb(pr),'domain_revision',pr.revision));
END $$;
CREATE FUNCTION v8.project_read(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); 
BEGIN
 IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501'; END IF;
 b:=p::jsonb;c:=v8.guard(h,'v8.project.read',d,b);
 SELECT to_jsonb(pr) INTO r FROM v8.projects pr WHERE id=(c->>'project_id')::uuid;PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','read','project',r);
END $$;
CREATE FUNCTION v8.work_open(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); w v8.work_items;
BEGIN
 IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501'; END IF;
 b:=p::jsonb;c:=v8.guard(h,'v8.work.open',d,b);
 r:=v8.replay(c,'work_open',b,d);IF r IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN r;END IF;
 PERFORM authz.assert_effect(h);INSERT INTO v8.work_items(id,project_id,actor_id,client_id,source_context_id,goal,description) VALUES(gen_random_uuid(),(c->>'project_id')::uuid,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'source_context_id')::uuid,b->>'goal',COALESCE(b->>'description','')) RETURNING * INTO w;
 PERFORM authz.assert_effect(h);INSERT INTO v8.work_executions(work_item_id,actor_id,client_id,source_context_id) VALUES(w.id,w.actor_id,w.client_id,w.source_context_id);
 PERFORM v8.emit(c,'work.opened',w.id,w.event_revision,o,jsonb_build_object('short_no',w.short_no));PERFORM authz.assert_effect(h);RETURN v8.remember(c,'work_open',b,d,o,jsonb_build_object('state','open','work_item_id',w.id,'short_no',w.short_no,'domain_revision',w.revision,'source_context_id',c->'source_context_id'));
END $$;
CREATE FUNCTION v8.work_commit(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); w v8.work_items;target v8.work_items;ref jsonb;rel jsonb;
BEGIN
 IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501'; END IF;
 b:=p::jsonb;c:=v8.guard(h,'v8.work.commit',d,b);
 r:=v8.replay(c,'work_commit',b,d);IF r IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN r;END IF;
 w:=v8.lock_work(c,(b->>'work_item_id')::uuid);
 IF w.revision<>(b->>'expected_revision')::bigint THEN PERFORM authz.assert_effect(h);RETURN v8.remember(c,'work_commit',b,d,o,jsonb_build_object('state','conflict','domain_revision',w.revision,'error_code','revision_conflict','retained_state','published_outputs_preserved','next_step','explicit_rebase'));END IF;
 IF b->'related_evaluated' IS DISTINCT FROM 'true'::jsonb OR COALESCE(jsonb_typeof(b->'outputs'),'null')<>'array' OR COALESCE(jsonb_array_length(b->'outputs'),0)<1 OR COALESCE(b->>'summary','')='' OR COALESCE(jsonb_typeof(b->'related'),'null')<>'array' OR COALESCE(b->'explanation'->>'problem','')='' OR COALESCE(b->'explanation'->>'result','')='' OR COALESCE(jsonb_typeof(b->'explanation'->'inputs'),'null')<>'array' OR COALESCE(jsonb_typeof(b->'explanation'->'limitations'),'null')<>'array' OR COALESCE(jsonb_typeof(b->'explanation'->'next_steps'),'null')<>'array' THEN RAISE EXCEPTION 'completion_evidence_required';END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(b->'outputs') LOOP PERFORM v8.assert_ref(c,ref);PERFORM authz.assert_effect(h);INSERT INTO v8.results(work_item_id,material_id,version_id,sha256,role,explanation,created_by) VALUES(w.id,(ref->>'material_id')::uuid,(ref->>'version_id')::uuid,ref->>'sha256',ref->>'role',b->'explanation',(c->>'actor_id')::uuid);END LOOP;
 FOR ref IN SELECT value FROM jsonb_array_elements(b->'explanation'->'inputs') LOOP PERFORM v8.assert_ref(c,ref);END LOOP;
 FOR rel IN SELECT value FROM jsonb_array_elements(b->'related') LOOP
 IF COALESCE(rel->'basis'->>'explanation','')='' OR COALESCE(jsonb_typeof(rel->'basis'->'refs'),'null')<>'array' THEN RAISE EXCEPTION 'relation_basis_required';END IF;
 SELECT * INTO target FROM v8.work_items WHERE id=(rel->>'work_item_id')::uuid;
 IF target.id IS NULL OR target.id=w.id OR NOT authz.can_read((c->>'actor_id')::uuid,target.project_id) OR NOT EXISTS(SELECT 1 FROM v8.work_read_receipts rr WHERE rr.id=(rel->'basis'->>'work_read_receipt_id')::uuid AND rr.actor_id=(c->>'actor_id')::uuid AND rr.client_id=(c->>'client_id')::uuid AND rr.work_item_id=target.id AND rr.state IN ('sent','acknowledged')) THEN RAISE EXCEPTION 'relation_basis_forbidden' USING ERRCODE='42501';END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(rel->'basis'->'refs') LOOP PERFORM v8.assert_ref(c,ref->'fixed_ref');IF NOT mem.delivered_ref((c->>'actor_id')::uuid,(c->>'client_id')::uuid,(ref->>'read_receipt_id')::uuid,(ref->'fixed_ref'->>'material_id')::uuid,(ref->'fixed_ref'->>'version_id')::uuid,ref->'fixed_ref'->>'sha256') THEN RAISE EXCEPTION 'undelivered_basis' USING ERRCODE='42501';END IF;END LOOP;
 IF rel ? 'supersedes' AND NOT EXISTS(SELECT 1 FROM v8.work_relations WHERE id=(rel->>'supersedes')::uuid AND ((from_work_id=w.id AND to_work_id=target.id) OR (to_work_id=w.id AND from_work_id=target.id))) THEN RAISE EXCEPTION 'invalid_relation_correction';END IF;
 PERFORM authz.assert_effect(h);INSERT INTO v8.work_relations(from_work_id,to_work_id,basis,actor_id,source_context_id,supersedes,state) VALUES(w.id,target.id,rel->'basis',(c->>'actor_id')::uuid,(c->>'source_context_id')::uuid,(rel->>'supersedes')::uuid,COALESCE(rel->>'state','active'));
 END LOOP;
 PERFORM authz.assert_effect(h);UPDATE v8.work_items SET description=b->>'summary',explanation=b->'explanation',state='completed',related_evaluated=true,completed_receipt_id=o,revision=revision+1,event_revision=event_revision+1,updated_at=clock_timestamp() WHERE id=w.id RETURNING * INTO w;
 PERFORM v8.emit(c,'work.completed',w.id,w.event_revision,o,jsonb_build_object('work_revision',w.revision,'fixed_refs',b->'outputs','related_evaluated',true));PERFORM authz.assert_effect(h);RETURN v8.remember(c,'work_commit',b,d,o,jsonb_build_object('state','completed','work_item_id',w.id,'short_no',w.short_no,'domain_revision',w.revision,'fixed_refs',b->'outputs','receipt',jsonb_build_object('receipt_id',o,'formal_completion',true,'quality_status','not_asserted')));
END $$;
CREATE FUNCTION v8.adoption_set(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); w v8.work_items;old v8.adoptions;adopted v8.adoptions;ref jsonb;
BEGIN
 IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501'; END IF;
 b:=p::jsonb;c:=v8.guard(h,'v8.adoption.set',d,b);
 r:=v8.replay(c,'adoption_set',b,d);IF r IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN r;END IF;w:=v8.lock_work(c,(b->>'work_item_id')::uuid);
 SELECT * INTO old FROM v8.adoptions WHERE work_item_id=w.id AND role=b->>'role' ORDER BY revision DESC LIMIT 1;
 IF w.revision<>(b->>'expected_work_revision')::bigint OR COALESCE(old.revision,0)<>(b->>'expected_adoption_revision')::bigint THEN PERFORM authz.assert_effect(h);RETURN v8.remember(c,'adoption_set',b,d,o,jsonb_build_object('state','conflict','domain_revision',w.revision,'adoption_revision',COALESCE(old.revision,0),'error_code','revision_conflict','retained_state','published_candidate_and_reason_preserved','next_step','explicit_rebase'));END IF;
 ref:=b->'fixed_ref';PERFORM v8.assert_ref(c,ref);IF NOT mem.delivered_ref((c->>'actor_id')::uuid,(c->>'client_id')::uuid,(b->>'read_receipt_id')::uuid,(ref->>'material_id')::uuid,(ref->>'version_id')::uuid,ref->>'sha256') THEN RAISE EXCEPTION 'undelivered_basis' USING ERRCODE='42501';END IF;
 PERFORM authz.assert_effect(h);INSERT INTO v8.adoptions(work_item_id,material_id,version_id,sha256,role,reason,revision,actor_id,source_context_id,supersedes) VALUES(w.id,(ref->>'material_id')::uuid,(ref->>'version_id')::uuid,ref->>'sha256',b->>'role',b->>'reason',COALESCE(old.revision,0)+1,(c->>'actor_id')::uuid,(c->>'source_context_id')::uuid,old.id) RETURNING * INTO adopted;
 PERFORM authz.assert_effect(h);UPDATE v8.work_items SET revision=revision+1,event_revision=event_revision+1,updated_at=clock_timestamp() WHERE id=w.id RETURNING * INTO w;
 PERFORM v8.emit(c,'adoption.changed',w.id,w.event_revision,o,jsonb_build_object('adoption_id',adopted.id,'revision',adopted.revision,'fixed_ref',ref));PERFORM authz.assert_effect(h);RETURN v8.remember(c,'adoption_set',b,d,o,jsonb_build_object('state','adopted','adoption_id',adopted.id,'adoption_revision',adopted.revision,'domain_revision',w.revision,'fixed_refs',jsonb_build_array(ref)));
END $$;

CREATE FUNCTION v8.work_read(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); w v8.work_items;rr uuid;blocked boolean;rels jsonb;refs jsonb;
BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.work.read',d,b);
SELECT * INTO w FROM v8.work_items WHERE id=(b->>'work_item_id')::uuid AND project_id=(c->>'project_id')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 blocked:=EXISTS(SELECT 1 FROM v8.results rr WHERE rr.work_item_id=w.id AND NOT mem.version_visible((c->>'actor_id')::uuid,rr.version_id)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(w.explanation->'inputs','[]')) x WHERE NOT mem.version_visible((c->>'actor_id')::uuid,(x->>'version_id')::uuid));
 FOR r IN SELECT to_jsonb(visible_ref) FROM (SELECT version_id FROM v8.results WHERE work_item_id=w.id UNION SELECT (item->>'version_id')::uuid FROM jsonb_array_elements(COALESCE(w.explanation->'inputs','[]')) item) visible_ref LOOP IF mem.version_visible((c->>'actor_id')::uuid,(r->>'version_id')::uuid) THEN PERFORM mem.assert_version_sources(h,(r->>'version_id')::uuid,'mem.read');END IF;END LOOP;PERFORM authz.assert_effect(h);INSERT INTO v8.work_read_receipts(work_item_id,work_revision,actor_id,client_id,source_context_id) VALUES(w.id,w.revision,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'source_context_id')::uuid) RETURNING id INTO rr;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',rel.id,'from_work_id',rel.from_work_id,'to_work_id',rel.to_work_id,'state',rel.state,'supersedes',rel.supersedes,'basis',CASE WHEN blocked OR EXISTS(SELECT 1 FROM jsonb_array_elements(rel.basis->'refs') rf WHERE NOT mem.version_visible((c->>'actor_id')::uuid,(rf->'fixed_ref'->>'version_id')::uuid)) THEN NULL ELSE rel.basis END)),'[]') INTO rels FROM v8.work_relations rel JOIN v8.work_items other ON other.id=CASE WHEN rel.from_work_id=w.id THEN rel.to_work_id ELSE rel.from_work_id END WHERE (rel.from_work_id=w.id OR rel.to_work_id=w.id) AND authz.can_read((c->>'actor_id')::uuid,other.project_id) AND NOT EXISTS(SELECT 1 FROM v8.work_relations newer WHERE newer.supersedes=rel.id);
 SELECT COALESCE(jsonb_agg(jsonb_build_object('material_id',material_id,'version_id',version_id,'sha256',sha256,'role',role)),'[]') INTO refs FROM v8.results WHERE work_item_id=w.id AND mem.version_visible((c->>'actor_id')::uuid,version_id);
 PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','read','work_item',CASE WHEN blocked THEN to_jsonb(w)-'explanation'-'description' ELSE to_jsonb(w) END,'read_receipt_id',rr,'relations',rels,'fixed_refs',refs,'coverage',jsonb_build_object('complete',NOT blocked,'host_visible','unknown'));
END $$;

CREATE FUNCTION v8.related_candidates(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); ref jsonb;
BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.work.related_candidates',d,b);
FOR ref IN SELECT value FROM jsonb_array_elements(b->'fixed_refs') LOOP PERFORM v8.assert_ref(c,ref);END LOOP;
 SELECT COALESCE(jsonb_agg(to_jsonb(found)),'[]') INTO r FROM (
 SELECT w.id AS work_item_id,w.short_no,w.goal,w.revision,
 EXISTS(SELECT 1 FROM v8.results rr JOIN jsonb_array_elements(b->'fixed_refs') f ON rr.material_id=(f->>'material_id')::uuid AND rr.version_id=(f->>'version_id')::uuid AND rr.sha256=f->>'sha256' WHERE rr.work_item_id=w.id AND mem.version_visible((c->>'actor_id')::uuid,rr.version_id)) AS shared_fixed_reference,
 EXISTS(SELECT 1 FROM v8.work_relations rel WHERE ((rel.from_work_id=w.id AND rel.to_work_id=(b->>'work_item_id')::uuid) OR (rel.to_work_id=w.id AND rel.from_work_id=(b->>'work_item_id')::uuid)) AND rel.state='active' AND NOT EXISTS(SELECT 1 FROM v8.work_relations n WHERE n.supersedes=rel.id)) AS direct_relation
 FROM v8.work_items w WHERE w.project_id=(c->>'project_id')::uuid AND w.id IS DISTINCT FROM (b->>'work_item_id')::uuid AND authz.can_read((c->>'actor_id')::uuid,w.project_id)
 AND (b->>'since' IS NULL OR w.created_at>=(b->>'since')::timestamptz) AND (b->>'until' IS NULL OR w.created_at<=(b->>'until')::timestamptz)
 AND (jsonb_array_length(b->'participants')=0 OR w.actor_id IN(SELECT value::uuid FROM jsonb_array_elements_text(b->'participants')))
 AND (COALESCE(b->>'query','')='' OR w.goal ILIKE '%'||(b->>'query')||'%')
 ORDER BY shared_fixed_reference DESC,direct_relation DESC,w.updated_at DESC,w.id LIMIT LEAST((b->>'limit')::integer,50) OFFSET (b->>'cursor')::integer) found;
 PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','candidates','items',r,'next_cursor',CASE WHEN jsonb_array_length(r)=(b->>'limit')::integer THEN (b->>'cursor')::integer+jsonb_array_length(r) ELSE NULL END,'coverage','current_authorized_candidates','next_step','agent_select_and_supply_direct_basis');
END $$;

CREATE FUNCTION v8.context_prepare(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); w v8.work_items;pr v8.projects;ref jsonb;item jsonb;cid uuid;expiry timestamptz;manifest jsonb;hash text;op_receipt jsonb;pending jsonb:='[]';
BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.context.prepare',d,b);
r:=v8.replay(c,'context_prepare',b,d);IF r IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN r;END IF;w:=v8.lock_work(c,(b->>'work_item_id')::uuid);
 IF w.revision<>(b->>'expected_work_revision')::bigint THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001';END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(b->'fixed_refs') LOOP PERFORM v8.assert_ref(c,ref);END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements((b->'effective_decisions')||(b->'dissenting_views')||(b->'rejected_explanations')) LOOP
 PERFORM v8.assert_ref(c,item->'reason_ref');IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'fixed_refs') rf WHERE rf->>'material_id'=item->'reason_ref'->>'material_id' AND rf->>'version_id'=item->'reason_ref'->>'version_id' AND rf->>'sha256'=item->'reason_ref'->>'sha256') THEN RAISE EXCEPTION 'reason_ref_not_in_manifest';END IF;END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(b->'pending_operations') LOOP
 SELECT result INTO op_receipt FROM v8.operations WHERE id=(item->>'operation_id')::uuid AND actor_id=(c->>'actor_id')::uuid AND project_id=w.project_id AND state IN ('conflict','rejected');
 IF op_receipt IS NULL THEN op_receipt:=mem.operation_evidence((c->>'actor_id')::uuid,w.project_id,(item->>'operation_id')::uuid);END IF;
 IF op_receipt IS NULL OR op_receipt->>'state' IN ('published','cancelled','expired') THEN RAISE EXCEPTION 'pending_operation_receipt_required';END IF;
 pending:=pending||jsonb_build_array(item||jsonb_build_object('actual_receipt',op_receipt));END LOOP;
 IF b ? 'refreshes_context_id' AND NOT EXISTS(SELECT 1 FROM v8.context_manifests WHERE id=(b->>'refreshes_context_id')::uuid AND work_item_id=w.id) THEN RAISE EXCEPTION 'invalid_refresh';END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=w.project_id;cid:=gen_random_uuid();expiry:=clock_timestamp()+make_interval(secs=>LEAST((b->>'ttl_seconds')::integer,900));
 manifest:=jsonb_build_object('schema_version','context.v1','context_id',cid,'project_id',w.project_id,'project_revision',pr.revision,'project_epoch',pr.epoch,'work_item_id',w.id,'work_revision',w.revision,'snapshot_watermark',w.event_revision,'goal',w.goal,'effective_decisions',b->'effective_decisions','dissenting_views',b->'dissenting_views','rejected_explanations',b->'rejected_explanations','fixed_refs',b->'fixed_refs','limitations',b->'limitations','pending_operations',pending,'next_steps',b->'next_steps','source_coverage',b->'source_coverage','coverage',jsonb_build_object('complete',b->'complete','host_visible','unknown'),'estimated_tokens',b->'estimated_tokens','token_budget',b->'token_budget','created_at',clock_timestamp(),'expires_at',expiry,'qualification_epoch_reference',c->'qualification_epoch','source_context_id',c->'source_context_id','refreshes_context_id',b->'refreshes_context_id','trust','source_material_not_execution_authority');
 hash:=encode(public.digest(v8.canonical_json(manifest),'sha256'),'hex');
 PERFORM authz.assert_effect(h);INSERT INTO v8.context_manifests(id,project_id,work_item_id,work_revision,actor_id,source_context_id,manifest,sha256,source_coverage,expires_at,refreshes_context_id) VALUES(cid,w.project_id,w.id,w.revision,(c->>'actor_id')::uuid,(c->>'source_context_id')::uuid,manifest,hash,b->>'source_coverage',expiry,(b->>'refreshes_context_id')::uuid);
 FOR ref IN SELECT value FROM jsonb_array_elements(b->'fixed_refs') LOOP PERFORM authz.assert_effect(h);INSERT INTO v8.context_sources(context_id,material_id,version_id,sha256,role) VALUES(cid,(ref->>'material_id')::uuid,(ref->>'version_id')::uuid,ref->>'sha256',ref->>'role');END LOOP;
 PERFORM v8.emit(c,'context.prepared',cid,1,o,jsonb_build_object('manifest_hash',hash,'work_item_id',w.id));PERFORM authz.assert_effect(h);RETURN v8.remember(c,'context_prepare',b,d,o,jsonb_build_object('state','prepared','context_id',cid,'manifest_hash',hash,'expires_at',expiry,'domain_revision',w.revision,'coverage',manifest->'coverage'));
END $$;

CREATE FUNCTION v8.context_materialize(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); ctx v8.context_manifests;w v8.work_items;blocked boolean;view jsonb;refs jsonb;vid uuid;
BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.context.materialize',d,b);
r:=v8.replay(c,'context_materialize',b,d);IF r IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN r;END IF;
 SELECT * INTO ctx FROM v8.context_manifests WHERE id=(b->>'context_id')::uuid AND project_id=(c->>'project_id')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 SELECT * INTO w FROM v8.work_items WHERE id=ctx.work_item_id;
 IF ctx.expires_at<=clock_timestamp() OR ctx.state<>'current' OR ctx.work_revision<>w.revision OR EXISTS(SELECT 1 FROM v8.projects WHERE id=ctx.project_id AND (revision<>(ctx.manifest->>'project_revision')::bigint OR epoch<>(ctx.manifest->>'project_epoch')::bigint)) OR EXISTS(SELECT 1 FROM v8.context_sources WHERE context_id=ctx.id AND mem.version_stale(version_id)) THEN PERFORM authz.assert_effect(h);RETURN v8.remember(c,'context_materialize',b,d,o,jsonb_build_object('state','rejected','error_code','context_requires_refresh','retained_state','immutable_manifest_preserved','next_step','prepare_new_context_with_refreshes_context_id'));END IF;
 blocked:=EXISTS(SELECT 1 FROM v8.context_sources src WHERE src.context_id=ctx.id AND NOT mem.version_visible((c->>'actor_id')::uuid,src.version_id));
 IF blocked AND b->>'mode'='complete' THEN PERFORM authz.assert_effect(h);RETURN v8.remember(c,'context_materialize',b,d,o,jsonb_build_object('state','rejected','error_code','source_access_required','retained_state','immutable_manifest_preserved','coverage',jsonb_build_object('returned_view','none','host_visible','unknown'),'next_step','request_explicit_clipped_view'));END IF;
 IF blocked THEN
 SELECT COALESCE(jsonb_agg(jsonb_build_object('material_id',material_id,'version_id',version_id,'sha256',sha256,'role',role)),'[]') INTO refs FROM v8.context_sources WHERE context_id=ctx.id AND mem.version_visible((c->>'actor_id')::uuid,version_id);
 view:=jsonb_build_object('schema_version','context.v1','context_id',ctx.id,'project_id',ctx.project_id,'work_item_id',w.id,'work_revision',w.revision,'goal',w.goal,'fixed_refs',refs,'limitations',jsonb_build_array('restricted_evidence_and_dependent_narrative_omitted'),'next_steps',jsonb_build_array('read_allowed_fixed_sources_and_prepare_authorized_continuation'),'coverage',jsonb_build_object('complete',false,'returned_view','clipped','host_visible','unknown'));
 ELSE view:=ctx.manifest||jsonb_build_object('manifest_hash',ctx.sha256);END IF;
 PERFORM authz.assert_effect(h);INSERT INTO v8.context_views(context_id,actor_id,client_id,source_context_id,returned_view,coverage) VALUES(ctx.id,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'source_context_id')::uuid,view,jsonb_build_object('manifest','frozen','returned_view',CASE WHEN blocked THEN 'clipped' ELSE 'complete_as_manifest' END,'host_visible','unknown')) RETURNING id INTO vid;
 PERFORM authz.assert_effect(h);INSERT INTO v8.work_executions(work_item_id,actor_id,client_id,source_context_id,context_view_id) VALUES(w.id,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'source_context_id')::uuid,vid);
 PERFORM v8.emit(c,'context.materialized',vid,1,o,jsonb_build_object('context_id',ctx.id,'coverage',CASE WHEN blocked THEN 'clipped' ELSE 'complete_as_manifest' END));PERFORM authz.assert_effect(h);RETURN v8.remember(c,'context_materialize',b,d,o,jsonb_build_object('state','materialized','context_id',ctx.id,'view_id',vid,'returned_view',view,'coverage',jsonb_build_object('manifest','frozen','returned_view',CASE WHEN blocked THEN 'clipped' ELSE 'complete_as_manifest' END,'host_visible','unknown')));
END $$;

CREATE FUNCTION v8.context_current(p_context uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,v8 AS $$
 SELECT EXISTS(SELECT 1 FROM v8.context_manifests ctx JOIN v8.work_items work ON work.id=ctx.work_item_id JOIN v8.projects project ON project.id=ctx.project_id
 WHERE ctx.id=p_context AND ctx.state='current' AND ctx.expires_at>clock_timestamp() AND ctx.work_revision=work.revision AND project.revision=(ctx.manifest->>'project_revision')::bigint AND project.epoch=(ctx.manifest->>'project_epoch')::bigint
 AND NOT EXISTS(SELECT 1 FROM v8.context_sources source WHERE source.context_id=ctx.id AND mem.version_stale(source.version_id))) $$;
CREATE FUNCTION v8.handoff_record(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); w v8.work_items;
BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.handoff.record',d,b);
r:=v8.replay(c,'handoff_record',b,d);IF r IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN r;END IF;w:=v8.lock_work(c,(b->>'work_item_id')::uuid);
 IF NOT v8.context_current((b->>'context_id')::uuid) OR NOT EXISTS(SELECT 1 FROM v8.context_manifests WHERE id=(b->>'context_id')::uuid AND work_item_id=w.id AND work_revision=w.revision AND expires_at>clock_timestamp() AND state='current') OR NOT authz.can_read((b->>'to_actor_id')::uuid,w.project_id) THEN RAISE EXCEPTION 'handoff_forbidden' USING ERRCODE='42501';END IF;
 PERFORM authz.assert_effect(h);INSERT INTO v8.handoffs(id,work_item_id,context_id,from_actor_id,to_actor_id,from_source_context_id,rationale,next_actions) VALUES(o,w.id,(b->>'context_id')::uuid,(c->>'actor_id')::uuid,(b->>'to_actor_id')::uuid,(c->>'source_context_id')::uuid,b->>'rationale',b->'next_actions');
 PERFORM v8.emit(c,'handoff.prepared',o,1,o,jsonb_build_object('work_item_id',w.id,'context_id',b->'context_id'));PERFORM authz.assert_effect(h);RETURN v8.remember(c,'handoff_record',b,d,o,jsonb_build_object('state','prepared','handoff_id',o,'work_item_id',w.id,'next_step','recipient_materializes_with_own_identity_then_accepts'));
END $$;

CREATE FUNCTION v8.handoff_accept(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); hh v8.handoffs;
BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.handoff.record',d,b);
r:=v8.replay(c,'handoff_accept',b,d);IF r IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN r;END IF;
 SELECT handoff.* INTO hh FROM v8.handoffs handoff JOIN v8.work_items wi ON wi.id=handoff.work_item_id WHERE handoff.id=(b->>'handoff_id')::uuid AND wi.project_id=(c->>'project_id')::uuid AND handoff.to_actor_id=(c->>'actor_id')::uuid FOR UPDATE OF handoff;
 IF NOT FOUND OR NOT v8.context_current(hh.context_id) OR NOT EXISTS(SELECT 1 FROM v8.context_views cv JOIN v8.context_manifests ctx ON ctx.id=cv.context_id JOIN v8.work_items ww ON ww.id=ctx.work_item_id WHERE cv.id=(b->>'context_view_id')::uuid AND cv.context_id=hh.context_id AND cv.actor_id=(c->>'actor_id')::uuid AND cv.client_id=(c->>'client_id')::uuid AND ctx.expires_at>clock_timestamp() AND ctx.work_revision=ww.revision AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(cv.returned_view->'fixed_refs') rf WHERE NOT mem.version_visible((c->>'actor_id')::uuid,(rf->>'version_id')::uuid) OR mem.version_stale((rf->>'version_id')::uuid))) THEN RAISE EXCEPTION 'recipient_context_required' USING ERRCODE='42501';END IF;
 IF (hh.state='prepared' AND b->>'state' NOT IN ('accepted','declined')) OR (hh.state='accepted' AND b->>'state'<>'continued') OR hh.state IN ('continued','declined') THEN RAISE EXCEPTION 'handoff_state_conflict' USING ERRCODE='40001';END IF;
 PERFORM authz.assert_effect(h);UPDATE v8.handoffs SET state=b->>'state',to_source_context_id=(c->>'source_context_id')::uuid WHERE id=hh.id;
 PERFORM authz.assert_effect(h);UPDATE v8.context_views SET acknowledged_at=clock_timestamp() WHERE id=(b->>'context_view_id')::uuid;
 PERFORM v8.emit(c,'handoff.'||(b->>'state'),hh.id,CASE WHEN b->>'state'='continued' THEN 3 ELSE 2 END,o,jsonb_build_object('work_item_id',hh.work_item_id,'context_view_id',b->'context_view_id'));PERFORM authz.assert_effect(h);RETURN v8.remember(c,'handoff_accept',b,d,o,jsonb_build_object('state',b->>'state','handoff_id',hh.id,'work_item_id',hh.work_item_id));
END $$;

CREATE FUNCTION v8.experience_publish(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); w v8.work_items;prior v8.experiences;ref jsonb;item jsonb;
BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.experience.publish',d,b);
r:=v8.replay(c,'experience_publish',b,d);IF r IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN r;END IF;w:=v8.lock_work(c,(b->>'work_item_id')::uuid);
 IF w.state<>'completed' OR w.completed_receipt_id IS NULL THEN RAISE EXCEPTION 'completed_episode_required';END IF;ref:=b->'fixed_ref';PERFORM v8.assert_ref(c,ref);
 FOR item IN SELECT value FROM jsonb_array_elements(b->'evidence') LOOP PERFORM v8.assert_ref(c,item);END LOOP;
 IF b ? 'supersedes' THEN SELECT ex.* INTO prior FROM v8.experiences ex JOIN v8.work_items ww ON ww.id=ex.work_item_id WHERE ex.id=(b->>'supersedes')::uuid AND ww.project_id=w.project_id FOR UPDATE OF ex;IF NOT FOUND THEN RAISE EXCEPTION 'invalid_experience_correction';END IF;PERFORM authz.assert_effect(h);UPDATE v8.experiences SET state='superseded',event_revision=event_revision+1 WHERE id=prior.id RETURNING * INTO prior;PERFORM v8.emit(c,'experience.superseded',prior.id,prior.event_revision,o,jsonb_build_object('replacement_id',o));END IF;
 PERFORM authz.assert_effect(h);INSERT INTO v8.experiences(id,work_item_id,material_id,version_id,sha256,conditions,evidence,state,revision,supersedes,actor_id) VALUES(o,w.id,(ref->>'material_id')::uuid,(ref->>'version_id')::uuid,ref->>'sha256',b->'conditions',b->'evidence','published',COALESCE(prior.revision,0)+1,prior.id,(c->>'actor_id')::uuid);
 PERFORM v8.emit(c,'experience.published',o,1,o,jsonb_build_object('work_item_id',w.id,'supersedes',prior.id));PERFORM authz.assert_effect(h);RETURN v8.remember(c,'experience_publish',b,d,o,jsonb_build_object('state','published','experience_id',o,'fixed_refs',jsonb_build_array(ref),'domain_revision',COALESCE(prior.revision,0)+1,'coverage','publisher_claim_with_fixed_evidence'));
END $$;

CREATE FUNCTION v8.experience_feedback(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); w v8.work_items;ex v8.experiences;ref jsonb;item jsonb;
BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.experience.feedback',d,b);
r:=v8.replay(c,'experience_feedback',b,d);IF r IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN r;END IF;w:=v8.lock_work(c,(b->>'work_item_id')::uuid);
 SELECT claim.* INTO ex FROM v8.experiences claim JOIN v8.work_items wi ON wi.id=claim.work_item_id WHERE claim.id=(b->>'experience_id')::uuid AND authz.can_read((c->>'actor_id')::uuid,wi.project_id);
 IF NOT FOUND OR NOT mem.version_visible((c->>'actor_id')::uuid,ex.version_id) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 ref:=b->'body_ref';PERFORM v8.assert_ref(c,ref);FOR item IN SELECT value FROM jsonb_array_elements(b->'evidence') LOOP PERFORM v8.assert_ref(c,item);END LOOP;
 PERFORM authz.assert_effect(h);INSERT INTO v8.experience_feedback(id,experience_id,work_item_id,actor_id,source_context_id,kind,explanation,evidence,material_id,version_id,sha256) VALUES(o,ex.id,w.id,(c->>'actor_id')::uuid,(c->>'source_context_id')::uuid,b->>'kind','fixed_mem_body',b->'evidence',(ref->>'material_id')::uuid,(ref->>'version_id')::uuid,ref->>'sha256');
 PERFORM v8.emit(c,'experience.feedback',o,1,o,jsonb_build_object('experience_id',ex.id,'kind',b->'kind','body_ref',ref));PERFORM authz.assert_effect(h);RETURN v8.remember(c,'experience_feedback',b,d,o,jsonb_build_object('state','recorded','feedback_id',o,'experience_id',ex.id,'fixed_refs',jsonb_build_array(ref)));
END $$;

CREATE FUNCTION v8.operation_read(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); 
BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.work.read',d,b);
SELECT result INTO r FROM v8.operations WHERE id=(b->>'operation_id')::uuid AND project_id=(c->>'project_id')::uuid AND actor_id=(c->>'actor_id')::uuid;IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;PERFORM authz.assert_effect(h);RETURN r;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA v8 FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.project_create(uuid,text,text) TO hub2_v8;
GRANT EXECUTE ON FUNCTION v8.project_convert(uuid,text,text) TO hub2_v8;
GRANT EXECUTE ON FUNCTION v8.project_read(uuid,text,text) TO hub2_v8;
GRANT EXECUTE ON FUNCTION v8.work_open(uuid,text,text) TO hub2_v8;
GRANT EXECUTE ON FUNCTION v8.work_commit(uuid,text,text) TO hub2_v8;
GRANT EXECUTE ON FUNCTION v8.work_read(uuid,text,text) TO hub2_v8;
GRANT EXECUTE ON FUNCTION v8.related_candidates(uuid,text,text) TO hub2_v8;
GRANT EXECUTE ON FUNCTION v8.adoption_set(uuid,text,text) TO hub2_v8;
GRANT EXECUTE ON FUNCTION v8.context_prepare(uuid,text,text) TO hub2_v8;
GRANT EXECUTE ON FUNCTION v8.context_materialize(uuid,text,text) TO hub2_v8;
GRANT EXECUTE ON FUNCTION v8.handoff_record(uuid,text,text) TO hub2_v8;
GRANT EXECUTE ON FUNCTION v8.handoff_accept(uuid,text,text) TO hub2_v8;
GRANT EXECUTE ON FUNCTION v8.experience_publish(uuid,text,text) TO hub2_v8;
GRANT EXECUTE ON FUNCTION v8.experience_feedback(uuid,text,text) TO hub2_v8;
GRANT EXECUTE ON FUNCTION v8.operation_read(uuid,text,text) TO hub2_v8;

CREATE FUNCTION v8.work_mark_read(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$ DECLARE b jsonb;c jsonb;r jsonb;rr v8.work_read_receipts; BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.work.read',d,b);SELECT * INTO rr FROM v8.work_read_receipts WHERE id=(b->>'read_receipt_id')::uuid AND actor_id=(c->>'actor_id')::uuid AND client_id=(c->>'client_id')::uuid FOR UPDATE;IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM v8.work_items WHERE id=rr.work_item_id AND project_id=(c->>'project_id')::uuid) OR b->>'state' NOT IN ('sent','acknowledged') OR (b->>'state'='acknowledged' AND rr.state='prepared') THEN RAISE EXCEPTION 'read_receipt_conflict' USING ERRCODE='40001';END IF;PERFORM authz.assert_effect(h);UPDATE v8.work_read_receipts SET state=b->>'state' WHERE id=rr.id;PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state',b->>'state','read_receipt_id',rr.id); END $$;
GRANT EXECUTE ON FUNCTION v8.work_mark_read(uuid,text,text) TO hub2_v8;

CREATE FUNCTION v8.adoption_read(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$ DECLARE b jsonb;c jsonb;r jsonb; BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.adoption.read',d,b);SELECT COALESCE(jsonb_agg(jsonb_build_object('adoption_id',a.id,'material_id',a.material_id,'version_id',a.version_id,'sha256',a.sha256,'role',a.role,'reason',a.reason,'revision',a.revision,'supersedes',a.supersedes)),'[]') INTO r FROM v8.adoptions a JOIN v8.work_items w ON w.id=a.work_item_id WHERE w.id=(b->>'work_item_id')::uuid AND w.project_id=(c->>'project_id')::uuid AND mem.version_visible((c->>'actor_id')::uuid,a.version_id);PERFORM mem.bind_request_sources(h,jsonb_build_object('fixed_refs',r),(c->>'actor_id')::uuid,'v8.adoption.read');PERFORM authz.assert_effect(h);PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','read','adoptions',r,'coverage','current_authorized_fixed_history'); END $$;
GRANT EXECUTE ON FUNCTION v8.adoption_read(uuid,text,text) TO hub2_v8;

CREATE FUNCTION v8.experience_read(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$ DECLARE b jsonb;c jsonb;r jsonb; BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.experience.read',d,b);SELECT COALESCE(jsonb_agg(jsonb_build_object('experience_id',ex.id,'work_item_id',ex.work_item_id,'fixed_ref',jsonb_build_object('material_id',ex.material_id,'version_id',ex.version_id,'sha256',ex.sha256),'conditions',ex.conditions,'evidence',ex.evidence,'state',CASE WHEN mem.version_stale(ex.version_id) THEN 'stale' ELSE ex.state END,'revision',ex.revision,'supersedes',ex.supersedes)),'[]') INTO r FROM v8.experiences ex JOIN v8.work_items w ON w.id=ex.work_item_id WHERE w.project_id=(c->>'project_id')::uuid AND (b->>'experience_id' IS NULL OR ex.id=(b->>'experience_id')::uuid) AND mem.version_visible((c->>'actor_id')::uuid,ex.version_id) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ex.evidence) rf WHERE NOT mem.version_visible((c->>'actor_id')::uuid,(rf->>'version_id')::uuid));PERFORM mem.bind_request_sources(h,jsonb_build_object('fixed_refs',r),(c->>'actor_id')::uuid,'v8.experience.read');PERFORM authz.assert_effect(h);PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','read','items',r,'coverage','current_authorized_claims'); END $$;
GRANT EXECUTE ON FUNCTION v8.experience_read(uuid,text,text) TO hub2_v8;

CREATE FUNCTION v8.handoff_read(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$ DECLARE b jsonb;c jsonb;r jsonb; BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.handoff.read',d,b);SELECT jsonb_build_object('handoff_id',hh.id,'work_item_id',hh.work_item_id,'context_id',hh.context_id,'state',hh.state,'from_actor_id',hh.from_actor_id,'to_actor_id',hh.to_actor_id,'next_step','materialize_context_with_own_identity') INTO r FROM v8.handoffs hh JOIN v8.work_items w ON w.id=hh.work_item_id WHERE hh.id=(b->>'handoff_id')::uuid AND w.project_id=(c->>'project_id')::uuid;IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','read','items',jsonb_build_array(r)); END $$;
GRANT EXECUTE ON FUNCTION v8.handoff_read(uuid,text,text) TO hub2_v8;

CREATE FUNCTION v8.context_read(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$ DECLARE b jsonb;c jsonb;r jsonb;ctx v8.context_manifests; BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.context.read',d,b);SELECT * INTO ctx FROM v8.context_manifests WHERE id=(b->>'context_id')::uuid AND project_id=(c->>'project_id')::uuid;IF NOT FOUND OR EXISTS(SELECT 1 FROM v8.context_sources WHERE context_id=ctx.id AND NOT mem.version_visible((c->>'actor_id')::uuid,version_id)) THEN RAISE EXCEPTION 'history_source_forbidden' USING ERRCODE='42501';END IF;PERFORM authz.assert_effect(h);PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','historical','context_id',ctx.id,'manifest_hash',ctx.sha256,'returned_view',ctx.manifest,'coverage',jsonb_build_object('manifest','immutable_history','host_visible','unknown'),'next_step','prepare_fresh_context_before_continuation'); END $$;
GRANT EXECUTE ON FUNCTION v8.context_read(uuid,text,text) TO hub2_v8;
CREATE FUNCTION v8.pending_registration(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb;c jsonb;items jsonb; BEGIN
 IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.work.read',d,b);
 SELECT COALESCE(jsonb_agg(to_jsonb(candidate)),'[]') INTO items FROM (
 SELECT cv.material_id,cv.id AS version_id,cv.sha256,cv.size,'published_unregistered_candidate' AS state
 FROM mem.content_versions cv JOIN mem.materials material ON material.id=cv.material_id
 WHERE material.project_id=(c->>'project_id')::uuid AND material.state='active' AND cv.actor_id=(c->>'actor_id')::uuid 
 AND mem.version_visible((c->>'actor_id')::uuid,cv.id) AND NOT EXISTS(SELECT 1 FROM v8.results registered WHERE registered.material_id=cv.material_id AND registered.version_id=cv.id AND registered.sha256=cv.sha256)
 ORDER BY cv.material_id,cv.id LIMIT LEAST((b->>'limit')::integer,100) OFFSET (b->>'cursor')::integer) candidate;
 PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','pending_registration','items',items,'coverage','current_actor_current_authorized_published_versions','next_cursor',CASE WHEN jsonb_array_length(items)=(b->>'limit')::integer THEN (b->>'cursor')::integer+jsonb_array_length(items) ELSE NULL END,'next_step','classify_output_and_commit_fixed_result_with_explanation');
END $$;
GRANT EXECUTE ON FUNCTION v8.pending_registration(uuid,text,text) TO hub2_v8;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA v8 FROM PUBLIC;
RESET ROLE;
