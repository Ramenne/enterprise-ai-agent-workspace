BEGIN;
SET ROLE hub2_v8_owner;
CREATE OR REPLACE FUNCTION v8.query_attribute_values(doc jsonb,path text[]) RETURNS SETOF jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $attr$
DECLARE v jsonb;
BEGIN
 IF jsonb_typeof(doc)='array' THEN
  FOR v IN SELECT value FROM jsonb_array_elements(doc) LOOP RETURN QUERY SELECT * FROM v8.query_attribute_values(v,path); END LOOP;
 ELSIF coalesce(array_length(path,1),0)=0 THEN RETURN NEXT doc;
 ELSIF jsonb_typeof(doc)='object' AND doc?path[1] THEN RETURN QUERY SELECT * FROM v8.query_attribute_values(doc->path[1],path[2:]);END IF;
END $attr$;
CREATE OR REPLACE FUNCTION v8.query_attribute_matches(doc jsonb,filters jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $attr$
DECLARE f record;
BEGIN
 IF jsonb_typeof(filters) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOR f IN SELECT key,value FROM jsonb_each(filters) LOOP
  IF NOT EXISTS(SELECT FROM v8.query_attribute_values(doc,string_to_array(f.key,'.')) v WHERE v=f.value) THEN RETURN false; END IF;
 END LOOP; RETURN true;
END $attr$;

-- Mobile list metadata is independent of historical narrative/results expansion.
-- Every call still uses the member's native decision handle and current sources.
CREATE OR REPLACE FUNCTION v8.work_catalog(h uuid,d text,p text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb;item jsonb;known jsonb;unchanged jsonb:='[]';visited integer:=0;last_key jsonb;page_mode boolean:=false;c jsonb;w record;items jsonb:='[]';lim integer;last_id uuid;more boolean:=false;decision jsonb;visibility_cache jsonb:='{}';refs jsonb:='[]';part jsonb;count integer:=0;note record;stage_summary jsonb;part_time timestamptz;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;
 IF EXISTS(SELECT FROM jsonb_object_keys(b)k WHERE k NOT IN('project_id','cursor','limit','work_item_ids','revisions_only','page_mode','q','attributes','after','known'))THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 lim:=coalesce((b->>'limit')::integer,40);
 IF lim NOT BETWEEN 1 AND 100 OR b?'work_item_ids'AND(jsonb_typeof(b->'work_item_ids')<>'array'OR jsonb_array_length(b->'work_item_ids')>100)THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 page_mode:=coalesce((b->>'page_mode')::boolean,false);known:=coalesce(b->'known','{}');
 IF jsonb_typeof(coalesce(b->'attributes','{}'))<>'object' OR jsonb_typeof(known)<>'object' OR length(coalesce(b->>'q',''))>512 OR (SELECT count(*) FROM jsonb_object_keys(known))>100 THEN RAISE EXCEPTION 'invalid_input';END IF;
 c:=v8.guard(h,'v8.work.read',d,b);
 FOR w IN SELECT i.*,a.activity_at,CASE WHEN i.state IN('active','in_progress')THEN 0 WHEN i.state='completed'THEN 1 ELSE 2 END query_rank
 FROM v8.work_items i CROSS JOIN LATERAL(SELECT greatest(i.updated_at,coalesce(max(u.created_at),i.updated_at))activity_at FROM v8.work_updates u WHERE page_mode AND u.work_item_id=i.id)a
 WHERE i.project_id=(c->>'project_id')::uuid
 AND v8.query_attribute_matches(jsonb_build_object('name',i.goal,'short_no',i.short_no,'state',i.state,'created_at',i.created_at),
  (SELECT coalesce(jsonb_object_agg(key,value),'{}')FROM jsonb_each(coalesce(b->'attributes','{}'))WHERE key IN('name','short_no','state','created_at')))
 AND(b->>'cursor'IS NULL OR i.id>(b->>'cursor')::uuid)
 AND(NOT b?'work_item_ids'OR i.id IN(SELECT value::uuid FROM jsonb_array_elements_text(b->'work_item_ids')))
 AND(NOT page_mode OR NOT b?'after'OR(
  CASE WHEN i.state IN('active','in_progress')THEN 0 WHEN i.state='completed'THEN 1 ELSE 2 END,
  -round(extract(epoch FROM a.activity_at)*1000000),i.id
 )>((b#>>'{after,rank}')::integer,-(b#>>'{after,time_us}')::numeric,(b#>>'{after,id}')::uuid))
 ORDER BY CASE WHEN page_mode THEN CASE WHEN i.state IN('active','in_progress')THEN 0 WHEN i.state='completed'THEN 1 ELSE 2 END ELSE 0 END,
 CASE WHEN page_mode THEN a.activity_at ELSE NULL END DESC,i.id
 LIMIT CASE WHEN b?'work_item_ids'THEN 101 WHEN page_mode THEN 101 ELSE lim+1 END LOOP
  IF (page_mode AND visited=100)OR(NOT b?'work_item_ids'AND count=lim)THEN more:=true;EXIT;END IF;
  visited:=visited+1;last_id:=w.id;last_key:=jsonb_build_object('rank',w.query_rank,'time_us',round(extract(epoch FROM w.activity_at)*1000000)::text,'id',w.id);
  IF coalesce((b->>'revisions_only')::boolean,false) THEN
   items:=items||jsonb_build_array(jsonb_build_object('work_item_id',w.id,'revision',w.revision));
   count:=count+1;last_id:=w.id;CONTINUE;
  END IF;
  decision:=v8.work_search_statement_visible(c,w.explanation,visibility_cache);visibility_cache:=decision->'cache';
  part:='{}';part_time:=w.updated_at;
  IF(decision->>'visible')::boolean THEN
   FOR note IN SELECT payload,created_at FROM v8.work_updates WHERE work_item_id=w.id AND jsonb_typeof(payload->'properties')='object' ORDER BY created_at DESC,id DESC LOOP
    decision:=v8.work_search_statement_visible(c,note.payload,visibility_cache);visibility_cache:=decision->'cache';
    IF(decision->>'visible')::boolean THEN part:=note.payload->'properties';part_time:=note.created_at;SELECT refs||coalesce(jsonb_agg(value),'[]')INTO refs FROM v8.ref_inputs(note.payload)value;EXIT;END IF;
   END LOOP;
   SELECT refs||coalesce(jsonb_agg(value),'[]')INTO refs FROM v8.ref_inputs(w.explanation)value;
  END IF;
  stage_summary:=NULL;
  FOR note IN SELECT payload,work_revision,id,created_at FROM v8.work_updates WHERE work_item_id=w.id AND jsonb_typeof(payload->'summary')='string'AND length(payload->>'summary')>0 ORDER BY created_at DESC,id DESC LOOP
   decision:=v8.work_search_statement_visible(c,note.payload,visibility_cache);visibility_cache:=decision->'cache';
   IF(decision->>'visible')::boolean THEN stage_summary:=jsonb_build_object('text',left(note.payload->>'summary',2000),'work_revision',note.work_revision,'update_id',note.id,'created_at',note.created_at,'coverage','latest_currently_authorized_declared_summary');SELECT refs||coalesce(jsonb_agg(value),'[]')INTO refs FROM v8.ref_inputs(note.payload)value;EXIT;END IF;
  END LOOP;
  item:=jsonb_build_object('work_item_id',w.id,'short_no',w.short_no,'project_id',w.project_id,
   'goal',w.goal,'summary',stage_summary->>'text','current_summary',stage_summary,'state',w.state,'revision',w.revision,'created_at',w.created_at,'updated_at',greatest(w.updated_at,part_time,coalesce((stage_summary->>'created_at')::timestamptz,w.updated_at)),'properties',part);
  item:=item||jsonb_build_object('projection_revision',encode(public.digest(item::text,'sha256'),'hex'));
  IF page_mode AND(NOT v8.query_attribute_matches(item||jsonb_build_object('name',w.goal,'project',(SELECT jsonb_build_object('attributes',coalesce(properties->'attributes','{}')) FROM v8.projects WHERE id=w.project_id)),coalesce(b->'attributes','{}'))
   OR coalesce(b->>'q','')<>''AND position(lower(b->>'q')IN lower(concat_ws(' ',w.goal,'#'||w.short_no::text,item->>'summary',part::text)))=0)THEN CONTINUE;END IF;
  IF known->>w.id::text=item->>'projection_revision'THEN unchanged:=unchanged||to_jsonb(w.id);ELSE items:=items||jsonb_build_array(item);END IF;
  count:=count+1;last_id:=w.id;
 END LOOP;
 SELECT coalesce(jsonb_agg(value),'[]')INTO refs FROM(SELECT DISTINCT value FROM jsonb_array_elements(refs))r;
 IF jsonb_array_length(refs)>0 THEN PERFORM mem.bind_search_result_sources(h,refs,(c->>'actor_id')::uuid);END IF;
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','read','items',items,'next_cursor',CASE WHEN more AND NOT page_mode THEN last_id ELSE NULL END,'next_scan_cursor',CASE WHEN more AND page_mode THEN last_key ELSE NULL END,'unchanged_ids',unchanged,'project_attributes',(SELECT coalesce(properties->'attributes','{}')FROM v8.projects WHERE id=(c->>'project_id')::uuid),
  'coverage',jsonb_build_object('complete',NOT more,'scope','current_authorized_work_metadata_only','history','read_on_detail'));
END $$;
REVOKE ALL ON FUNCTION v8.work_catalog(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.work_catalog(uuid,text,text)TO hub2_v8;
RESET ROLE;
COMMIT;
