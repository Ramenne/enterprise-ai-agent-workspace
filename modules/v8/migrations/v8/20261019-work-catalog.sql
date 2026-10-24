BEGIN;
SET ROLE hub2_v8_owner;
-- Mobile list metadata is independent of historical narrative/results expansion.
-- Every call still uses the member's native decision handle and current sources.
CREATE OR REPLACE FUNCTION v8.work_catalog(h uuid,d text,p text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb;c jsonb;w record;items jsonb:='[]';lim integer;last_id uuid;more boolean:=false;decision jsonb;visibility_cache jsonb:='{}';refs jsonb:='[]';part jsonb;count integer:=0;note record;stage_summary jsonb;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;
 IF EXISTS(SELECT FROM jsonb_object_keys(b)k WHERE k NOT IN('project_id','cursor','limit','work_item_ids','revisions_only'))THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 lim:=coalesce((b->>'limit')::integer,40);
 IF lim NOT BETWEEN 1 AND 100 OR b?'work_item_ids'AND(jsonb_typeof(b->'work_item_ids')<>'array'OR jsonb_array_length(b->'work_item_ids')>100)THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 c:=v8.guard(h,'v8.work.read',d,b);
 FOR w IN SELECT * FROM v8.work_items i WHERE i.project_id=(c->>'project_id')::uuid
 AND(b->>'cursor'IS NULL OR i.id>(b->>'cursor')::uuid)
 AND(NOT b?'work_item_ids'OR i.id IN(SELECT value::uuid FROM jsonb_array_elements_text(b->'work_item_ids')))
 ORDER BY i.id LIMIT CASE WHEN b?'work_item_ids'THEN 101 ELSE lim+1 END LOOP
  IF NOT b?'work_item_ids'AND count=lim THEN more:=true;EXIT;END IF;
  IF coalesce((b->>'revisions_only')::boolean,false) THEN
   items:=items||jsonb_build_array(jsonb_build_object('work_item_id',w.id,'revision',w.revision));
   count:=count+1;last_id:=w.id;CONTINUE;
  END IF;
  decision:=v8.work_search_statement_visible(c,w.explanation,visibility_cache);visibility_cache:=decision->'cache';
  part:='{}';
  IF(decision->>'visible')::boolean THEN
   FOR note IN SELECT payload FROM v8.work_updates WHERE work_item_id=w.id AND work_revision<=w.revision AND jsonb_typeof(payload->'properties')='object' ORDER BY work_revision DESC LOOP
    decision:=v8.work_search_statement_visible(c,note.payload,visibility_cache);visibility_cache:=decision->'cache';
    IF(decision->>'visible')::boolean THEN part:=note.payload->'properties';SELECT refs||coalesce(jsonb_agg(value),'[]')INTO refs FROM v8.ref_inputs(note.payload)value;EXIT;END IF;
   END LOOP;
   SELECT refs||coalesce(jsonb_agg(value),'[]')INTO refs FROM v8.ref_inputs(w.explanation)value;
  END IF;
  stage_summary:=NULL;
  FOR note IN SELECT payload,work_revision,id FROM v8.work_updates WHERE work_item_id=w.id AND work_revision<=w.revision AND jsonb_typeof(payload->'summary')='string'AND length(payload->>'summary')>0 ORDER BY work_revision DESC LOOP
   decision:=v8.work_search_statement_visible(c,note.payload,visibility_cache);visibility_cache:=decision->'cache';
   IF(decision->>'visible')::boolean THEN stage_summary:=jsonb_build_object('text',left(note.payload->>'summary',2000),'work_revision',note.work_revision,'update_id',note.id,'coverage','latest_currently_authorized_declared_summary');SELECT refs||coalesce(jsonb_agg(value),'[]')INTO refs FROM v8.ref_inputs(note.payload)value;EXIT;END IF;
  END LOOP;
  items:=items||jsonb_build_array(jsonb_build_object('work_item_id',w.id,'short_no',w.short_no,'project_id',w.project_id,
   'goal',w.goal,'summary',stage_summary->>'text','current_summary',stage_summary,'state',w.state,'revision',w.revision,'created_at',w.created_at,'updated_at',w.updated_at,'properties',part));
  count:=count+1;last_id:=w.id;
 END LOOP;
 SELECT coalesce(jsonb_agg(value),'[]')INTO refs FROM(SELECT DISTINCT value FROM jsonb_array_elements(refs))r;
 IF jsonb_array_length(refs)>0 THEN PERFORM mem.bind_search_result_sources(h,refs,(c->>'actor_id')::uuid);END IF;
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','read','items',items,'next_cursor',CASE WHEN more THEN last_id ELSE NULL END,
  'coverage',jsonb_build_object('complete',NOT more,'scope','current_authorized_work_metadata_only','history','read_on_detail'));
END $$;
REVOKE ALL ON FUNCTION v8.work_catalog(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.work_catalog(uuid,text,text)TO hub2_v8;
RESET ROLE;
COMMIT;