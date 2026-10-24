-- Isolated temporary-table regression, not a production authority test.

CREATE TEMP TABLE work_items(id uuid,project_id uuid,short_no bigint,revision bigint,goal text,description text,explanation jsonb,state text,related_assessment text) ON COMMIT DROP;
CREATE TEMP TABLE work_updates(id uuid,work_item_id uuid,work_revision bigint,created_at timestamptz,payload jsonb,actor_id uuid) ON COMMIT DROP;
CREATE TEMP TABLE results(work_item_id uuid,material_id uuid,version_id uuid,sha256 text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.guard(uuid,text,text,jsonb) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('project_id',$4->>'project_id','actor_id','00000000-0000-4000-8000-000000000001')$$;
CREATE FUNCTION pg_temp.statement_visible(jsonb,jsonb,jsonb) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('cache',$3,'visible',NOT coalesce(($2->>'denied')::boolean,false))$$;
CREATE FUNCTION pg_temp.ref_inputs(jsonb) RETURNS SETOF jsonb LANGUAGE sql AS $$SELECT value FROM jsonb_array_elements(coalesce($1->'outputs','[]'))$$;
CREATE FUNCTION pg_temp.bind_sources(uuid,jsonb,uuid) RETURNS void LANGUAGE plpgsql AS $$BEGIN END$$;
CREATE FUNCTION pg_temp.assert_effect(uuid) RETURNS void LANGUAGE plpgsql AS $$BEGIN END$$;
CREATE OR REPLACE FUNCTION pg_temp.search(h uuid,d text,p text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb;c jsonb;item record;ref record;items jsonb:='[]';n integer:=0;scanned integer:=0;lim integer;last_id uuid;more boolean:=false;q text;blocked boolean;note record;stage_summary jsonb;stage_match boolean;number_match numeric;page_refs jsonb:='[]';item_refs jsonb;stage_refs jsonb;visible boolean;visibility_cache jsonb:='{}';decision jsonb;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;IF EXISTS(SELECT FROM jsonb_object_keys(b)key WHERE key NOT IN('project_id','query','limit','cursor'))THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 lim:=coalesce((b->>'limit')::integer,20);q:=coalesce(b->>'query','');IF lim NOT BETWEEN 1 AND 100 OR length(q)>200 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 IF q~*'^(W-|#)[0-9]{1,19}$'THEN number_match:=regexp_replace(q,'^(W-|#)','','i')::numeric;END IF;
 c:=pg_temp.guard(h,'v8.work.read',d,b);
 FOR item IN SELECT w.* FROM pg_temp.work_items w WHERE w.project_id=(c->>'project_id')::uuid AND(b->>'cursor'IS NULL OR w.id>(b->>'cursor')::uuid)
 AND((number_match IS NOT NULL AND w.short_no=number_match)OR(number_match IS NULL AND(q=''OR strpos(lower(w.goal),lower(q))>0 OR strpos(lower(w.description),lower(q))>0 OR EXISTS(SELECT FROM pg_temp.work_updates stage WHERE stage.work_item_id=w.id AND stage.work_revision<=w.revision AND strpos(lower(coalesce(stage.payload->>'summary','')),lower(q))>0))))ORDER BY w.id LIMIT 101 LOOP
  IF scanned=100 THEN more:=true;EXIT;END IF;
  scanned:=scanned+1;last_id:=item.id;
  decision:=pg_temp.statement_visible(c,item.explanation,visibility_cache);visibility_cache:=decision->'cache';blocked:=NOT(decision->>'visible')::boolean;
  SELECT coalesce(jsonb_agg(value),'[]')INTO item_refs FROM(SELECT DISTINCT jsonb_build_object('material_id',material_id,'version_id',version_id,'sha256',sha256)AS value FROM pg_temp.results WHERE work_item_id=item.id)refs;
  IF NOT blocked THEN decision:=pg_temp.statement_visible(c,jsonb_build_object('outputs',item_refs),visibility_cache);visibility_cache:=decision->'cache';blocked:=NOT(decision->>'visible')::boolean;END IF;
  stage_summary:=NULL;stage_match:=false;stage_refs:='[]';
  FOR note IN SELECT u.* FROM pg_temp.work_updates u WHERE u.work_item_id=item.id AND u.work_revision<=item.revision AND jsonb_typeof(u.payload->'summary')='string'AND length(u.payload->>'summary')>0 ORDER BY u.created_at DESC,u.id DESC LOOP
   decision:=pg_temp.statement_visible(c,note.payload,visibility_cache);visibility_cache:=decision->'cache';
   IF(decision->>'visible')::boolean THEN
    stage_match:=strpos(lower(note.payload->>'summary'),lower(q))>0;
    stage_summary:=jsonb_build_object('text',left(note.payload->>'summary',2000),'work_revision',note.work_revision,'created_at',note.created_at,'update_id',note.id,'actor_id',note.actor_id,'coverage','latest_currently_authorized_declared_summary_at_view_revision','truncated',length(note.payload->>'summary')>2000);
    SELECT coalesce(jsonb_agg(value),'[]')INTO stage_refs FROM pg_temp.ref_inputs(note.payload)value;EXIT;
   END IF;
  END LOOP;
  IF number_match IS NULL AND q<>''AND strpos(lower(item.goal),lower(q))=0 AND(blocked OR strpos(lower(item.description),lower(q))=0)AND NOT stage_match THEN CONTINUE;END IF;
  n:=n+1;
  IF NOT blocked THEN SELECT item_refs||coalesce(jsonb_agg(value),'[]')INTO item_refs FROM pg_temp.ref_inputs(item.explanation)value;page_refs:=page_refs||item_refs;END IF;
  page_refs:=page_refs||stage_refs;
  items:=items||jsonb_build_array(jsonb_build_object('work_item_id',item.id,'short_no',item.short_no,'goal',item.goal,'summary',CASE WHEN blocked THEN NULL ELSE item.description END,'work_description',CASE WHEN blocked THEN NULL ELSE item.description END,'current_summary',stage_summary,'summary_semantics','legacy_summary_is_work_description;current_summary_is_latest_authorized_stage','state',item.state,'revision',item.revision,'related_assessment',item.related_assessment,'narrative_coverage',CASE WHEN blocked THEN'restricted_and_omitted'ELSE'current_authorized'END));
  IF n=lim THEN
   SELECT EXISTS(SELECT 1 FROM pg_temp.work_items WHERE project_id=(c->>'project_id')::uuid AND id>last_id) INTO more;
   EXIT;
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value),'[]')INTO page_refs FROM(SELECT DISTINCT value FROM jsonb_array_elements(page_refs))unique_refs;
 IF jsonb_array_length(page_refs)>0 THEN PERFORM pg_temp.bind_sources(h,page_refs,(c->>'actor_id')::uuid);END IF;
 PERFORM pg_temp.assert_effect(h);
 RETURN jsonb_build_object('state','read','items',items,'returned_count',n,'scanned_count',scanned,'next_cursor',CASE WHEN more THEN last_id ELSE NULL END,'summary_semantics','legacy_summary_is_work_description;current_summary_is_latest_authorized_stage','coverage',jsonb_build_object('complete',NOT more,'scope','current_authorized_matching_work_after_cursor','snapshot',false,'truncated',more,'narrative','current_authorized_only'),'next_step',CASE WHEN more THEN'continue_with_next_cursor'ELSE'read_selected_work_item'END);
END $$;

INSERT INTO pg_temp.work_items SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'ad44cc0e-159e-4e0f-a5ca-73d3920240d9',i,1,'goal','description','{}','in_progress','unassessed' FROM generate_series(1,151)i;
INSERT INTO pg_temp.work_updates SELECT id,id,1,'2026-10-18'::timestamptz,'{"summary":"needle old"}',null FROM pg_temp.work_items;
INSERT INTO pg_temp.work_updates SELECT ('10000000-0000-4000-8000-'||lpad(short_no::text,12,'0'))::uuid,id,1,'2026-10-19'::timestamptz,jsonb_build_object('summary',CASE WHEN short_no=151 THEN 'needle current' ELSE 'current unrelated' END),null FROM pg_temp.work_items;
DO $cases$ DECLARE b jsonb;r jsonb;cursor text;BEGIN
 b:='{"project_id":"ad44cc0e-159e-4e0f-a5ca-73d3920240d9","query":"needle","limit":20}';
 r:=pg_temp.search(null,encode(public.digest(b::text,'sha256'),'hex'),b::text);
 IF (r->>'scanned_count')::int<>100 OR jsonb_array_length(r->'items')<>0 OR r->>'next_cursor'IS NULL THEN RAISE EXCEPTION 'bounded_empty_page_failed';END IF;
 b:=b||jsonb_build_object('cursor',r->>'next_cursor');
 r:=pg_temp.search(null,encode(public.digest(b::text,'sha256'),'hex'),b::text);
 IF jsonb_array_length(r->'items')<>1 OR r->'items'->0->'current_summary'->>'text'<>'needle current' OR r->>'next_cursor'IS NOT NULL THEN RAISE EXCEPTION 'latest_stage_or_continuation_failed';END IF;
 b:='{"project_id":"ad44cc0e-159e-4e0f-a5ca-73d3920240d9","query":"#9999999999999999999"}';
 r:=pg_temp.search(null,encode(public.digest(b::text,'sha256'),'hex'),b::text);
 IF jsonb_array_length(r->'items')<>0 THEN RAISE EXCEPTION 'large_number_failed';END IF;
 b:='{"project_id":"ad44cc0e-159e-4e0f-a5ca-73d3920240d9","query":"","limit":1}';
 r:=pg_temp.search(null,encode(public.digest(b::text,'sha256'),'hex'),b::text);
 IF jsonb_array_length(r->'items')<>1 OR r->>'next_cursor'IS NULL THEN RAISE EXCEPTION 'normal_page_failed';END IF;
END $cases$;
