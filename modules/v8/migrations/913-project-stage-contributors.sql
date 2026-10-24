-- Current stage contributors come from platform columns, never Agent source_context claims.
-- Qualification definitions and work creator/owner identity remain separate.
BEGIN;
SET ROLE hub2_v8_owner;
CREATE OR REPLACE FUNCTION v8.project_governance_projection(pid uuid, work_visible boolean, viewer uuid, h uuid, c jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'v8'
AS $function$
DECLARE pr v8.projects;q record;act text;deadline timestamptz;takeovers jsonb:='[]';participants jsonb:='[]';g jsonb;responsible uuid;eligible boolean:=false;all_members boolean:=false;owner_label text;manager_label text;responsible_label text;stage_access boolean:=false;stage_stats jsonb:='[]';stage_coverage text;
BEGIN
 SELECT * INTO pr FROM v8.projects WHERE id=pid;
 stage_access:=coalesce(work_visible AND h IS NOT NULL AND c IS NOT NULL AND (c->>'project_id')::uuid=pid AND (c->>'actor_id')::uuid=viewer,false);
 stage_coverage:=CASE WHEN NOT work_visible THEN 'work_read_permission_unavailable;not_an_empty_activity_claim'WHEN NOT stage_access THEN 'stage_authorization_context_unavailable;not_an_empty_activity_claim'ELSE 'currently_authorized_stage_submissions;source_restricted_statements_excluded;not_global_activity'END;
 IF stage_access THEN
  WITH scoped AS MATERIALIZED(SELECT u.actor_id,u.work_item_id,u.created_at,u.payload,w.state FROM v8.work_updates u JOIN v8.work_items w ON w.id=u.work_item_id WHERE w.project_id=pid AND u.work_revision<=w.revision),
  authorized AS MATERIALIZED(SELECT actor_id,work_item_id,created_at,state FROM scoped WHERE v8.authorized_statement(h,c,payload)),
  grouped AS(SELECT actor_id,max(created_at)last_reported_work_at,count(DISTINCT work_item_id)FILTER(WHERE state IN('open','in_progress'))work_count,count(*)FILTER(WHERE state IN('open','in_progress'))stage_count,max(created_at)FILTER(WHERE state IN('open','in_progress'))last_work_update FROM authorized GROUP BY actor_id)
  SELECT coalesce(jsonb_agg(to_jsonb(grouped)),'[]')INTO stage_stats FROM grouped;
 END IF;

 all_members:=viewer IN(pr.owner_id,pr.manager_id)OR EXISTS(SELECT FROM authz.principals a WHERE a.id=viewer AND a.active AND a.role='organization_admin'AND a.organization_id=pr.organization_id)OR EXISTS(SELECT FROM authz.qualifications mq WHERE mq.project_id=pid AND mq.principal_id=viewer AND mq.kind='management'AND authz.v8_management_valid(mq.id,viewer,pid));
 g:=coalesce(pr.properties->'governance','{}');responsible:=(g->>'responsible_actor_id')::uuid;
 SELECT nullif(btrim(a.display_name),'')INTO owner_label FROM authz.principals a WHERE a.id=pr.owner_id AND a.organization_id=pr.organization_id AND a.kind='member';
 SELECT nullif(btrim(a.display_name),'')INTO manager_label FROM authz.principals a WHERE a.id=pr.manager_id AND a.organization_id=pr.organization_id AND a.kind='member';
 SELECT nullif(btrim(a.display_name),'')INTO responsible_label FROM authz.principals a WHERE a.id=responsible AND a.organization_id=pr.organization_id AND a.kind='member';
 FOR q IN SELECT qu.* FROM authz.qualifications qu JOIN authz.principals member ON member.id=qu.principal_id AND member.kind='member'AND member.active WHERE qu.project_id=pid AND qu.kind='work' AND qu.active AND NOT qu.frozen AND qu.resource_selector->>'kind'='project' AND(all_members OR qu.principal_id=viewer)ORDER BY qu.principal_id,qu.id LOOP
  FOR act IN SELECT unnest(q.actions)INTERSECT SELECT unnest(ARRAY['resource.write','resource.deploy','v8.work.commit','v8.work.open','mem.write','mem.upload','mem.process']) LOOP
   deadline:=authz.v8_qualification_deadline(q.id,q.principal_id,pid,act,jsonb_build_object('project_id',pid));
   IF deadline IS NOT NULL AND deadline>clock_timestamp()THEN
    takeovers:=takeovers||jsonb_build_array(jsonb_build_object('actor_id',q.principal_id,'qualification_id',q.id,'actions',to_jsonb(q.actions),'takeover_kind',CASE WHEN 'resource.write'=ANY(q.actions)OR 'resource.deploy'=ANY(q.actions)THEN 'engineering_project_work'WHEN 'v8.work.commit'=ANY(q.actions)OR 'v8.work.open'=ANY(q.actions)THEN 'project_work'ELSE 'material_work'END,'authorized_action',act,'source_actor_id',q.source_actor_id,'source_basis',q.source_basis,'expires_at',CASE WHEN deadline='infinity'::timestamptz THEN NULL ELSE deadline END,'until_revoked',deadline='infinity'::timestamptz,'scope','whole_project','responsibility_semantics','authorized_takeover_not_automatic_designated_responsible'));
    IF q.principal_id=responsible THEN eligible:=true;END IF;EXIT;
   END IF;
  END LOOP;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('actor_id',actor,'display_name',role_label,'label',role_label,'qualifications',qualifications,'last_reported_work_at',last_report,'progress_state',CASE WHEN NOT stage_access THEN 'stage_authorization_context_unavailable'WHEN last_report IS NULL THEN 'authorized_takeover;no_currently_visible_stage_submission'ELSE 'recorded_work_progress;see_timestamp_without_assuming_current_activity'END)ORDER BY actor),'[]')INTO takeovers FROM(SELECT x->>'actor_id'actor,jsonb_agg(x)qualifications FROM jsonb_array_elements(takeovers)x GROUP BY x->>'actor_id')grouped CROSS JOIN LATERAL(SELECT CASE WHEN stage_access THEN(SELECT (x->>'last_reported_work_at')::timestamptz FROM jsonb_array_elements(stage_stats)x WHERE x->>'actor_id'=grouped.actor)ELSE NULL END last_report)progress CROSS JOIN LATERAL(SELECT(SELECT nullif(btrim(a.display_name),'')FROM authz.principals a WHERE a.id=grouped.actor::uuid AND a.organization_id=pr.organization_id AND a.kind='member')role_label)member_label;
 IF responsible IS NOT NULL AND NOT eligible THEN eligible:=EXISTS(SELECT FROM authz.qualifications rq CROSS JOIN LATERAL unnest(rq.actions)allowed_action(value) WHERE rq.project_id=pid AND rq.principal_id=responsible AND rq.kind='work'AND rq.active AND NOT rq.frozen AND rq.resource_selector->>'kind'='project'AND allowed_action.value IN('resource.write','resource.deploy','v8.work.commit','v8.work.open','mem.write','mem.upload','mem.process')AND authz.v8_qualification_deadline(rq.id,responsible,pid,allowed_action.value,jsonb_build_object('project_id',pid))>clock_timestamp());END IF;
 IF responsible IS NOT NULL AND responsible IN(pr.owner_id,pr.manager_id)THEN eligible:=EXISTS(SELECT FROM authz.principals a WHERE a.id=responsible AND a.active AND a.organization_id=pr.organization_id);END IF;
 IF stage_access THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('actor_id',x->>'actor_id','work_count',(x->>'work_count')::bigint,'stage_count',(x->>'stage_count')::bigint,'last_work_update',x->'last_work_update','last_stage_submitted_at',x->'last_work_update','display_name',nullif(btrim(a.display_name),''),'label',nullif(btrim(a.display_name),''))ORDER BY(x->>'last_work_update')::timestamptz DESC,x->>'actor_id'),'[]')INTO participants FROM jsonb_array_elements(stage_stats)x LEFT JOIN authz.principals a ON a.id=(x->>'actor_id')::uuid AND a.organization_id=pr.organization_id AND a.kind='member'WHERE(x->>'work_count')::bigint>0;
 END IF;
 RETURN jsonb_build_object('purpose',g->'purpose','lifecycle',g->'lifecycle','classification_coverage',CASE WHEN g->>'purpose'IS NULL OR g->>'lifecycle'IS NULL THEN 'partially_unassessed;runtime_state_does_not_fill_missing_governance'ELSE 'declared_agent_or_member_judgment'END,'owner_id',pr.owner_id,'owner_label',owner_label,'owner_display_name',owner_label,'manager_id',pr.manager_id,'manager_label',manager_label,'manager_display_name',manager_label,'responsible_actor_id',responsible,'responsible_label',responsible_label,'responsible_display_name',responsible_label,'responsible_record_state',CASE WHEN responsible IS NULL THEN 'not_designated'WHEN eligible THEN 'designated_with_current_authority'ELSE 'designation_authority_needs_review'END,'authorized_takeovers',takeovers,'work_participants',participants,'participant_coverage',CASE WHEN stage_access THEN 'currently_authorized_stage_submitters_for_open_or_in_progress_work;not_all_members_or_creators'ELSE stage_coverage END,'participant_actor_basis','platform_work_updates.actor_id;work_items.actor_id_retains_creator_identity','participant_time_basis','platform_work_updates.created_at;not_work_item_updated_at','reported_work_coverage',stage_coverage,'reported_work_time_basis','platform_work_updates.created_at','takeover_coverage',CASE WHEN all_members THEN 'effective_whole_project_write_qualifications;excludes_read_only_expired_frozen_and_scoped_permissions'ELSE 'requester_qualifications_only;management_roster_permission_unavailable'END,'responsibility_status',CASE WHEN NOT all_members THEN 'authority_coverage_limited;not_a_claim_of_no_responsible_person'WHEN NOT stage_access AND jsonb_array_length(takeovers)>0 THEN 'authorized_takeover;progress_visibility_unavailable'WHEN jsonb_array_length(takeovers)>0 AND NOT EXISTS(SELECT FROM jsonb_array_elements(takeovers)t WHERE t->>'last_reported_work_at'IS NOT NULL) THEN 'authorized_takeover;no_currently_visible_stage_submission'WHEN jsonb_array_length(takeovers)>0 THEN 'authorized_takeover;work_activity_available'WHEN responsible IS NOT NULL THEN 'explicit_responsibility_record'WHEN jsonb_array_length(participants)>0 THEN 'work_participants_present;responsible_not_designated'ELSE 'responsibility_unassessed;not_a_claim_of_no_responsible_person'END,'approval_details_source','existing_qualification_source_basis_and_hufu_authorization_overview');
END $function$;

-- Existing three-argument internal consumers have no stage source-authorization handle.
-- Preserve roles/qualification metadata and make unavailable stage coverage explicit.
CREATE OR REPLACE FUNCTION v8.project_governance_projection(pid uuid,work_visible boolean,viewer uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
 SELECT v8.project_governance_projection(pid,work_visible,viewer,NULL::uuid,NULL::jsonb)
$$;
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
 r:=r||jsonb_build_object('governance',coalesce(r->'properties'->'governance','{}'),'responsible_actor_id',r->'properties'->'governance'->'responsible_actor_id','responsibility',v8.project_governance_projection((c->>'project_id')::uuid,allowed,(c->>'actor_id')::uuid,h,c));
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','read','project',r,'recent_work',recent,'activity_coverage',CASE WHEN allowed THEN 'latest_three_updated_work_items;currently_authorized_stage_summaries' ELSE 'work_read_permission_unavailable;not_an_empty_project_claim' END);
END $function$;

REVOKE ALL ON FUNCTION v8.project_governance_projection(uuid,boolean,uuid,uuid,jsonb),v8.project_governance_projection(uuid,boolean,uuid) FROM PUBLIC,hub2_v8,hub2_hufu,hub2_mem;
GRANT EXECUTE ON FUNCTION v8.project_governance_projection(uuid,boolean,uuid,uuid,jsonb),v8.project_governance_projection(uuid,boolean,uuid) TO hub2_v8_owner;
REVOKE ALL ON FUNCTION v8.project_read(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.project_read(uuid,text,text) TO hub2_v8;
RESET ROLE;
COMMIT;
