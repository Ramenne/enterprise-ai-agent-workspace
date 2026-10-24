BEGIN;
SET ROLE hub2_v8_owner;
ALTER TABLE v8.projects ADD COLUMN IF NOT EXISTS properties jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE OR REPLACE FUNCTION v8.project_governance_projection(pid uuid,work_visible boolean,viewer uuid)RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE pr v8.projects;q record;act text;deadline timestamptz;takeovers jsonb:='[]';participants jsonb:='[]';g jsonb;responsible uuid;eligible boolean:=false;all_members boolean:=false;
BEGIN
 SELECT * INTO pr FROM v8.projects WHERE id=pid;
 all_members:=viewer IN(pr.owner_id,pr.manager_id)OR EXISTS(SELECT FROM authz.principals a WHERE a.id=viewer AND a.active AND a.role='organization_admin'AND a.organization_id=pr.organization_id)OR EXISTS(SELECT FROM authz.qualifications mq WHERE mq.project_id=pid AND mq.principal_id=viewer AND mq.kind='management'AND authz.v8_management_valid(mq.id,viewer,pid));
 g:=coalesce(pr.properties->'governance','{}');responsible:=(g->>'responsible_actor_id')::uuid;
 FOR q IN SELECT qu.* FROM authz.qualifications qu JOIN authz.principals member ON member.id=qu.principal_id AND member.kind='member'AND member.active WHERE qu.project_id=pid AND qu.kind='work' AND qu.active AND NOT qu.frozen AND qu.resource_selector->>'kind'='project' AND(all_members OR qu.principal_id=viewer)ORDER BY qu.principal_id,qu.id LOOP
  FOR act IN SELECT unnest(q.actions)INTERSECT SELECT unnest(ARRAY['resource.write','resource.deploy','v8.work.commit','v8.work.open','mem.write','mem.upload','mem.process']) LOOP
   deadline:=authz.v8_qualification_deadline(q.id,q.principal_id,pid,act,jsonb_build_object('project_id',pid));
   IF deadline IS NOT NULL AND deadline>clock_timestamp()THEN
    takeovers:=takeovers||jsonb_build_array(jsonb_build_object('actor_id',q.principal_id,'qualification_id',q.id,'authorized_action',act,'source_actor_id',q.source_actor_id,'source_basis',q.source_basis,'expires_at',CASE WHEN deadline='infinity'::timestamptz THEN NULL ELSE deadline END,'until_revoked',deadline='infinity'::timestamptz,'scope','whole_project','responsibility_semantics','authorized_takeover_not_automatic_designated_responsible'));
    IF q.principal_id=responsible THEN eligible:=true;END IF;EXIT;
   END IF;
  END LOOP;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('actor_id',actor,'qualifications',qualifications,'last_reported_work_at',last_report,'progress_state',CASE WHEN NOT work_visible THEN 'work_read_permission_unavailable'WHEN last_report IS NULL THEN 'authorized_takeover;progress_not_reported'ELSE 'recorded_work_progress;see_timestamp_without_assuming_current_activity'END)ORDER BY actor),'[]')INTO takeovers FROM(SELECT x->>'actor_id'actor,jsonb_agg(x)qualifications FROM jsonb_array_elements(takeovers)x GROUP BY x->>'actor_id')grouped CROSS JOIN LATERAL(SELECT CASE WHEN work_visible THEN(SELECT max(u.created_at)FROM v8.work_updates u JOIN v8.work_items w ON w.id=u.work_item_id WHERE w.project_id=pid AND u.actor_id=grouped.actor::uuid)ELSE NULL END last_report)progress;
 IF responsible IS NOT NULL AND NOT eligible THEN eligible:=EXISTS(SELECT FROM authz.qualifications rq CROSS JOIN LATERAL unnest(rq.actions)act WHERE rq.project_id=pid AND rq.principal_id=responsible AND rq.kind='work'AND rq.active AND NOT rq.frozen AND rq.resource_selector->>'kind'='project'AND act IN('resource.write','resource.deploy','v8.work.commit','v8.work.open','mem.write','mem.upload','mem.process')AND authz.v8_qualification_deadline(rq.id,responsible,pid,act,jsonb_build_object('project_id',pid))>clock_timestamp());END IF;
 IF responsible IS NOT NULL AND responsible IN(pr.owner_id,pr.manager_id)THEN eligible:=EXISTS(SELECT FROM authz.principals a WHERE a.id=responsible AND a.active AND a.organization_id=pr.organization_id);END IF;
 IF work_visible THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x)ORDER BY x.last_work_update DESC),'[]')INTO participants FROM(SELECT actor_id,count(*)work_count,max(updated_at)last_work_update FROM v8.work_items WHERE project_id=pid AND state IN('open','in_progress')GROUP BY actor_id)x;
 END IF;
 RETURN jsonb_build_object('purpose',g->'purpose','lifecycle',g->'lifecycle','classification_coverage',CASE WHEN g->>'purpose'IS NULL OR g->>'lifecycle'IS NULL THEN 'partially_unassessed;runtime_state_does_not_fill_missing_governance'ELSE 'declared_agent_or_member_judgment'END,'owner_id',pr.owner_id,'manager_id',pr.manager_id,'responsible_actor_id',responsible,'responsible_record_state',CASE WHEN responsible IS NULL THEN 'not_designated'WHEN eligible THEN 'designated_with_current_authority'ELSE 'designation_authority_needs_review'END,'authorized_takeovers',takeovers,'work_participants',participants,'participant_coverage',CASE WHEN work_visible THEN 'current_open_or_in_progress_work_authors;not_all_project_members'ELSE 'work_read_permission_unavailable'END,'takeover_coverage',CASE WHEN all_members THEN 'effective_whole_project_write_qualifications;excludes_read_only_expired_frozen_and_scoped_permissions'ELSE 'requester_qualifications_only;management_roster_permission_unavailable'END,'responsibility_status',CASE WHEN NOT all_members THEN 'authority_coverage_limited;not_a_claim_of_no_responsible_person'WHEN NOT work_visible AND jsonb_array_length(takeovers)>0 THEN 'authorized_takeover;progress_visibility_unavailable'WHEN jsonb_array_length(takeovers)>0 AND NOT EXISTS(SELECT FROM jsonb_array_elements(takeovers)t WHERE t->>'last_reported_work_at'IS NOT NULL) THEN 'authorized_takeover;progress_not_reported'WHEN jsonb_array_length(takeovers)>0 THEN 'authorized_takeover;work_activity_available'WHEN responsible IS NOT NULL THEN 'explicit_responsibility_record'WHEN jsonb_array_length(participants)>0 THEN 'work_participants_present;responsible_not_designated'ELSE 'responsibility_unassessed;not_a_claim_of_no_responsible_person'END,'approval_details_source','existing_qualification_source_basis_and_hufu_authorization_overview');
END $$;
-- Project metadata updates assert against the locked pre-change project once,
-- then bump its revision; shared receipt/audit helpers must not reject their own bump.
CREATE OR REPLACE FUNCTION v8.remember(c jsonb, a text, b jsonb, d text, o uuid, r jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'v8'
AS $function$ BEGIN
 r:=jsonb_build_object('operation_id',o,'retryable',false,'retained_state','registered','next_step','continue_with_fixed_refs')||r;
 INSERT INTO v8.operations(id,actor_id,client_id,project_id,idempotency_key,fingerprint,action,state,result) VALUES(o,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'project_id')::uuid,b->>'idempotency_key',d,a,CASE WHEN r->>'state' IN ('conflict','rejected') THEN r->>'state' ELSE 'committed' END,r);IF r->>'state' IN ('conflict','rejected') THEN PERFORM v8.emit(c,'operation.'||(r->>'state'),o,1,o,jsonb_build_object('action',a,'error_code',r->>'error_code','retained_state',r->>'retained_state'));END IF;IF c->>'action' NOT IN('v8.project.create','v8.project.convert','v8.project.update') THEN PERFORM authz.assert_effect((c->>'handle_id')::uuid);END IF;RETURN r;END $function$;


CREATE OR REPLACE FUNCTION v8.emit(c jsonb, a text, id uuid, rev bigint, o uuid, details jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'v8'
AS $function$ BEGIN
 INSERT INTO evidence.audit(actor_id,client_id,source_context_id,domain,action,aggregate_id,revision,operation_id,details) VALUES((c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'source_context_id')::uuid,'v8',a,id,rev,o,details);
 INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload) VALUES('v8',id,rev,a,(c->>'project_id')::uuid,details);IF c->>'action' NOT IN('v8.project.create','v8.project.convert','v8.project.update') THEN PERFORM authz.assert_effect((c->>'handle_id')::uuid);END IF;END $function$;


CREATE OR REPLACE FUNCTION v8.project_governance_save(h uuid,d text,p text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb:=p::jsonb;c jsonb;r jsonb;pr v8.projects;g jsonb;a uuid;o uuid:=gen_random_uuid();eligible boolean;projection jsonb;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 IF b->>'expected_revision'IS NULL OR (b->>'expected_revision')::bigint<1 OR b-ARRAY['project_id','expected_revision','idempotency_key','governance']<>'{}'::jsonb OR jsonb_typeof(b->'governance')IS DISTINCT FROM 'object' OR (b->'governance')-ARRAY['purpose','lifecycle','responsible_actor_id','reason','evidence','uncertainty']<>'{}'::jsonb OR (b->'governance'->>'purpose'IS NOT NULL AND b->'governance'->>'purpose'NOT IN('business','migrated_history','test'))OR(b->'governance'->>'lifecycle'IS NOT NULL AND b->'governance'->>'lifecycle'NOT IN('active','paused','archive'))THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 c:=v8.guard(h,'v8.project.update',d,b);r:=v8.replay(c,'project_governance_save',b,d);IF r IS NOT NULL THEN RETURN r;END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=(c->>'project_id')::uuid FOR UPDATE;
 IF pr.revision<>(b->>'expected_revision')::bigint THEN RETURN v8.remember(c,'project_governance_save',b,d,o,jsonb_build_object('state','conflict','error_code','revision_conflict','retained_state','project_unchanged','project',to_jsonb(pr),'domain_revision',pr.revision));END IF;
 g:=coalesce(pr.properties->'governance','{}')||(b->'governance');a:=(g->>'responsible_actor_id')::uuid;
 IF a IS NOT NULL THEN
  IF NOT EXISTS(SELECT FROM authz.principals x WHERE x.id=a AND x.active AND x.organization_id=pr.organization_id)THEN RAISE EXCEPTION 'responsible_actor_unavailable' USING ERRCODE='42501';END IF;
  eligible:=a IN(pr.owner_id,pr.manager_id)OR EXISTS(SELECT FROM authz.qualifications q CROSS JOIN LATERAL unnest(q.actions)act WHERE q.project_id=pr.id AND q.principal_id=a AND q.kind='work'AND q.active AND NOT q.frozen AND q.resource_selector->>'kind'='project'AND act IN('resource.write','resource.deploy','v8.work.commit','v8.work.open','mem.write','mem.upload','mem.process')AND authz.v8_qualification_deadline(q.id,a,pr.id,act,jsonb_build_object('project_id',pr.id))>clock_timestamp());
  IF NOT eligible THEN RAISE EXCEPTION 'responsible_requires_existing_work_or_management_authority' USING ERRCODE='42501';END IF;
 END IF;
 g:=g||jsonb_build_object('judged_by',(c->>'actor_id')::uuid,'judged_at',clock_timestamp(),'judgment_kind','agent_or_member_declared');PERFORM authz.assert_effect(h);
 UPDATE v8.projects SET properties=jsonb_set(properties,'{governance}',g,true),revision=revision+1,event_revision=event_revision+1 WHERE id=pr.id RETURNING * INTO pr;
 PERFORM v8.emit(c,'project.governance_saved',pr.id,pr.event_revision,o,jsonb_build_object('governance',g,'revision',pr.revision));
 RETURN v8.remember(c,'project_governance_save',b,d,o,jsonb_build_object('state','saved','project',to_jsonb(pr),'domain_revision',pr.revision));
END $$;
CREATE OR REPLACE FUNCTION v8.project_read(h uuid, d text, p text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'v8'
AS $function$
DECLARE b jsonb;c jsonb;r jsonb;recent jsonb:='[]';item record;note record;stage jsonb;allowed boolean:=true;
BEGIN
 IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501'; END IF;
 b:=p::jsonb;c:=v8.guard(h,'v8.project.read',d,b);
 SELECT to_jsonb(pr) INTO r FROM v8.projects pr WHERE id=(c->>'project_id')::uuid;
 BEGIN
  PERFORM authz.resource_deadline((c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'project_id')::uuid,'v8.work.read',jsonb_build_object('project_id',c->'project_id'));
 EXCEPTION WHEN insufficient_privilege THEN allowed:=false;END;
 IF allowed THEN
  FOR item IN SELECT * FROM v8.work_items WHERE project_id=(c->>'project_id')::uuid ORDER BY updated_at DESC,id DESC LIMIT 3 LOOP
   stage:=NULL;
   FOR note IN SELECT * FROM v8.work_updates WHERE work_item_id=item.id AND work_revision<=item.revision AND jsonb_typeof(payload->'summary')='string' AND length(payload->>'summary')>0 ORDER BY work_revision DESC LOOP
    IF v8.authorized_statement(h,c,note.payload) THEN stage:=jsonb_build_object('text',left(note.payload->>'summary',2000),'update_id',note.id,'work_revision',note.work_revision,'coverage','latest_authorized_declared_stage','truncated',length(note.payload->>'summary')>2000);EXIT;END IF;
   END LOOP;
   recent:=recent||jsonb_build_array(jsonb_build_object('work_item_id',item.id,'short_no',item.short_no,'goal',item.goal,'state',item.state,'revision',item.revision,'actor_id',item.actor_id,'updated_at',item.updated_at,'current_summary',stage));
  END LOOP;
 END IF;
 r:=r||jsonb_build_object('governance',coalesce(r->'properties'->'governance','{}'),'responsible_actor_id',r->'properties'->'governance'->'responsible_actor_id','responsibility',v8.project_governance_projection((c->>'project_id')::uuid,allowed,(c->>'actor_id')::uuid));
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','read','project',r,'recent_work',recent,'activity_coverage',CASE WHEN allowed THEN 'latest_three_updated_work_items;currently_authorized_stage_summaries' ELSE 'work_read_permission_unavailable;not_an_empty_project_claim' END);
END $function$;


CREATE OR REPLACE FUNCTION v8.project_search(h uuid, d text, p text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'v8'
AS $function$
DECLARE b jsonb;c jsonb;item record;items jsonb:='[]';n integer:=0;lim integer;last_id uuid;more boolean:=false;q text;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;IF EXISTS(SELECT FROM jsonb_object_keys(b) key WHERE key NOT IN('query','limit','cursor')) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 lim:=COALESCE((b->>'limit')::integer,20);q:=COALESCE(b->>'query','');IF lim NOT BETWEEN 1 AND 100 OR length(q)>200 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 c:=authz.consume_discovery_handle(h,d);
 FOR item IN SELECT pr.* FROM v8.projects pr WHERE pr.organization_id=(c->>'organization_id')::uuid
 AND (b->>'cursor' IS NULL OR pr.id>(b->>'cursor')::uuid)
 AND (q='' OR strpos(lower(pr.title),lower(q))>0)
 AND (pr.owner_id=(c->>'actor_id')::uuid OR pr.visibility='team' OR EXISTS(SELECT FROM authz.qualifications qu WHERE qu.principal_id=(c->>'actor_id')::uuid AND qu.project_id=pr.id AND qu.active))
 ORDER BY pr.id LOOP
  IF NOT authz.discovery_project_visible(h,item.id) THEN CONTINUE;END IF;
  IF n=lim THEN more:=true;EXIT;END IF;
  n:=n+1;last_id:=item.id;
  items:=items||jsonb_build_array(jsonb_build_object('project_id',item.id,'title',item.title,'kind',item.kind,'visibility',item.visibility,'state',item.state,'revision',item.revision,'owner_id',item.owner_id,'manager_id',item.manager_id,'properties',item.properties,'governance',coalesce(item.properties->'governance','{}')));
 END LOOP;
 PERFORM authz.finish_discovery(h);
 RETURN jsonb_build_object('state','read','items',items,'returned_count',n,'next_cursor',CASE WHEN more THEN last_id ELSE NULL END,
 'coverage',jsonb_build_object('complete',NOT more,'scope','current_authorized_matching_projects_after_cursor','snapshot',false,'truncated',more),
 'next_step',CASE WHEN more THEN 'continue_with_next_cursor' ELSE 'choose_project_or_create_if_needed' END);
END $function$;


REVOKE ALL ON FUNCTION v8.project_governance_projection(uuid,boolean,uuid),v8.project_governance_save(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.project_governance_save(uuid,text,text)TO hub2_v8;
RESET ROLE;
COMMIT;
