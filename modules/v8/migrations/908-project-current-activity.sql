-- Shared project view for current work. Project metadata permission alone is
-- not silently expanded to another person's private work statements.
SET ROLE hub2_authz_owner;
GRANT EXECUTE ON FUNCTION authz.resource_deadline(uuid,uuid,uuid,text,jsonb) TO hub2_v8_owner;
RESET ROLE;
SET ROLE hub2_v8_owner;
CREATE OR REPLACE FUNCTION v8.project_read(h uuid,d text,p text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $fn$
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
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','read','project',r,'recent_work',recent,'activity_coverage',CASE WHEN allowed THEN 'latest_three_updated_work_items;currently_authorized_stage_summaries' ELSE 'work_read_permission_unavailable;not_an_empty_project_claim' END);
END $fn$;
REVOKE ALL ON FUNCTION v8.project_read(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.project_read(uuid,text,text) TO hub2_v8;
RESET ROLE;
