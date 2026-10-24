-- Generated from migrations/mem/20261018-description-search-ranked-authorization.sql; production body MD5 cd2702a73460bfa3d3701353e9234268.
-- Isolated pg_temp fixtures test candidate order/NULL refusal/final fence; no production rows are written.
SET ROLE hub2_mem_owner;DO $guard$BEGIN IF md5((SELECT prosrc FROM pg_proc WHERE oid='mem.description_vector_search(uuid,text,text)'::regprocedure))IS DISTINCT FROM 'cd2702a73460bfa3d3701353e9234268'THEN RAISE EXCEPTION 'description_search_test_fixture_not_current';END IF;END $guard$;
CREATE TEMP TABLE materials(id uuid PRIMARY KEY,project_id uuid,state text,current_version_id uuid)ON COMMIT DROP;
CREATE TEMP TABLE agent_description_heads(version_id uuid,revision bigint)ON COMMIT DROP;
CREATE TEMP TABLE agent_description_revisions(version_id uuid,revision bigint,material_id uuid,sha256 text,text_content text,state text,source_declaration jsonb,reason jsonb,evidence jsonb)ON COMMIT DROP;
CREATE TEMP TABLE agent_description_vectors(id uuid,version_id uuid,description_revision bigint,description_sha256 text,space_key text,embedding public.vector(512))ON COMMIT DROP;
CREATE TEMP TABLE candidate_policy(version_id uuid,visible boolean,resource_allowed boolean,description_allowed boolean,eligible boolean)ON COMMIT DROP;
CREATE TEMP TABLE final_policy(revoked boolean)ON COMMIT DROP;
INSERT INTO final_policy VALUES(false);
CREATE FUNCTION pg_temp.guard(uuid,text,text,jsonb)RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $$SELECT jsonb_build_object('project_id','16f05f01-4a43-4e96-a16b-d8ed69eff77d','actor_id','cbd510d3-162f-4a62-a3e3-9648cd067297')$$;
CREATE FUNCTION pg_temp.vector_space_definition(jsonb,integer)RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$SELECT '{"dimension":512}'::jsonb$$;
CREATE FUNCTION pg_temp.vector_space_known(jsonb)RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$SELECT true$$;
CREATE FUNCTION pg_temp.version_visible(uuid,uuid)RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$SELECT visible FROM pg_temp.candidate_policy WHERE version_id=$2$$;
CREATE FUNCTION pg_temp.vector_candidate_readable(uuid,uuid)RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$SELECT resource_allowed FROM pg_temp.candidate_policy WHERE version_id=$2$$;
CREATE FUNCTION pg_temp.description_candidate_visible(uuid,uuid,uuid,bigint)RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$SELECT description_allowed FROM pg_temp.candidate_policy WHERE version_id=$3$$;
CREATE FUNCTION pg_temp.description_index_eligible(uuid)RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$SELECT eligible FROM pg_temp.candidate_policy WHERE version_id=$1$$;
CREATE FUNCTION pg_temp.version_stale(uuid)RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$SELECT false$$;
CREATE FUNCTION pg_temp.description_revision_refs(uuid,bigint)RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$SELECT jsonb_build_array(jsonb_build_object('material_id',material_id,'version_id',version_id,'sha256',sha256))FROM pg_temp.agent_description_revisions WHERE version_id=$1 AND revision=$2$$;
CREATE FUNCTION pg_temp.bind_search_result_sources(uuid,jsonb,uuid)RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$BEGIN IF EXISTS(SELECT FROM jsonb_array_elements($2)r JOIN pg_temp.candidate_policy p ON p.version_id=(r->>'version_id')::uuid WHERE(p.visible AND p.resource_allowed AND p.description_allowed)IS DISTINCT FROM true)THEN RAISE EXCEPTION 'unauthorized_reference_bound';END IF;END$$;
CREATE FUNCTION pg_temp.assert_effect(uuid)RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$BEGIN IF(SELECT revoked FROM pg_temp.final_policy)THEN RAISE EXCEPTION 'synthetic_current_authority_lost' USING ERRCODE='42501';END IF;END$$;
DO $seed$DECLARE n integer;id uuid;embedding jsonb;definition jsonb:='{"dimension":512,"purpose":"agent_description","representation_version":1}';BEGIN
 FOR n IN 1..9 LOOP
  id:=('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  SELECT jsonb_agg(CASE WHEN i=1 THEN 1::numeric WHEN i=2 THEN n::numeric/10 ELSE 0::numeric END ORDER BY i)INTO embedding FROM generate_series(1,512)i;
  INSERT INTO pg_temp.materials VALUES(id,CASE WHEN n=9 THEN '2ece6509-dc82-4d2b-a43b-4e1f04f9ba60'::uuid ELSE '16f05f01-4a43-4e96-a16b-d8ed69eff77d'::uuid END,'active',id);
  INSERT INTO pg_temp.agent_description_heads VALUES(id,1);
  INSERT INTO pg_temp.agent_description_revisions VALUES(id,1,id,repeat('a',64),'synthetic-'||n,'active','{}','{}','{}');
  INSERT INTO pg_temp.agent_description_vectors VALUES(id,id,1,repeat('b',64),encode(public.digest(definition::text,'sha256'),'hex'),embedding::text::public.vector);
  INSERT INTO pg_temp.candidate_policy VALUES(id,CASE WHEN n=1 THEN false WHEN n=4 THEN NULL ELSE true END,n<>2,n<>5,n<>8);
 END LOOP;
END$seed$;
CREATE FUNCTION pg_temp.description_search(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $function$
DECLARE b jsonb:=payload::jsonb;c jsonb;definition jsonb;space_key_value text;q public.vector;k integer;items jsonb:='[]';refs jsonb;requested text;candidate record;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=pg_temp.guard(h,'pg_temp.read',d,b);
 IF (b->>'project_id')::uuid IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(b->'embedding') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'embedding')<>512 OR EXISTS(SELECT FROM jsonb_array_elements(b->'embedding')x WHERE jsonb_typeof(x)<>'number') OR (b->'space'->>'dimension')::integer IS DISTINCT FROM 512 THEN RAISE EXCEPTION 'invalid_description_vector';END IF;
 q:=(b->'embedding')::text::public.vector;IF public.vector_norm(q)=0 THEN RAISE EXCEPTION 'cosine_query_zero_norm';END IF;
 definition:=pg_temp.vector_space_definition(b->'space',512)||jsonb_build_object('purpose','agent_description','representation_version',1);
 IF NOT pg_temp.vector_space_known(definition) THEN RAISE EXCEPTION 'space_definition_required';END IF;
 space_key_value:=encode(public.digest(definition::text,'sha256'),'hex');k:=coalesce((b->>'top_k')::integer,10);requested:=coalesce(b->>'mode','exact');
 IF k NOT BETWEEN 1 AND 100 OR requested NOT IN('exact','hnsw','ivfflat') THEN RAISE EXCEPTION 'invalid_input';END IF;
 -- Exact distance order. Evaluate current eligibility until k authorized results exist;
 -- do not truncate raw candidates before permission checks.
 FOR candidate IN
  SELECT e.*,dr.material_id,dr.sha256,dr.text_content,dr.state,dr.source_declaration,dr.reason,dr.evidence,m.current_version_id,
   (e.embedding OPERATOR(public.<=>) q) distance
  FROM pg_temp.agent_description_vectors e JOIN pg_temp.agent_description_revisions dr ON dr.version_id=e.version_id AND dr.revision=e.description_revision
  JOIN pg_temp.agent_description_heads dh ON dh.version_id=dr.version_id AND dh.revision=dr.revision JOIN pg_temp.materials m ON m.id=dr.material_id
  WHERE e.space_key=space_key_value AND m.project_id=(c->>'project_id')::uuid AND m.state='active' AND pg_temp.description_index_eligible(m.id) AND dr.state='active' AND btrim(dr.text_content)<>''
   AND (coalesce((b->>'include_historical')::boolean,false) OR m.current_version_id=e.version_id)
  ORDER BY (e.embedding OPERATOR(public.<=>) q),e.id
 LOOP
  IF (pg_temp.version_visible((c->>'actor_id')::uuid,candidate.version_id) AND pg_temp.vector_candidate_readable(h,candidate.version_id) AND pg_temp.description_candidate_visible(h,(c->>'actor_id')::uuid,candidate.version_id,candidate.description_revision))IS DISTINCT FROM true THEN CONTINUE;END IF;
  items:=items||jsonb_build_array(jsonb_build_object('vector_id',candidate.id,'material_id',candidate.material_id,'version_id',candidate.version_id,'sha256',candidate.sha256,
   'fixed_ref',jsonb_build_object('material_id',candidate.material_id,'version_id',candidate.version_id,'sha256',candidate.sha256),
   'description',jsonb_build_object('revision',candidate.description_revision,'text',candidate.text_content,'text_sha256',candidate.description_sha256,'state',candidate.state,'source_declaration',candidate.source_declaration,'reason',candidate.reason,'evidence',candidate.evidence),
   'distance',candidate.distance,'similarity',1-candidate.distance,'current_version_id',candidate.current_version_id,'freshness',CASE WHEN candidate.current_version_id=candidate.version_id AND NOT pg_temp.version_stale(candidate.version_id)THEN 'current' ELSE 'needs_refresh'END));
  EXIT WHEN jsonb_array_length(items)>=k;
 END LOOP;
 SELECT coalesce(jsonb_agg(ref),'[]') INTO refs FROM jsonb_array_elements(items)item CROSS JOIN LATERAL jsonb_array_elements(coalesce(pg_temp.description_revision_refs((item->>'version_id')::uuid,coalesce((item->'description'->>'revision')::bigint,(item->>'description_revision')::bigint)),jsonb_build_array(item->'fixed_ref')))ref;
 PERFORM pg_temp.bind_search_result_sources(h,refs,(c->>'actor_id')::uuid);PERFORM pg_temp.assert_effect(h);
 RETURN jsonb_build_object('state','ranked_candidates','items',items,'returned_count',jsonb_array_length(items),'mode','exact','requested_mode',requested,'ann_index_used',false,'fallback_reason',CASE WHEN requested<>'exact' THEN 'description_ann_not_prepared' END,'space_key',space_key_value,'space',definition,'coverage',jsonb_build_object('complete_for_requested_top_k',true,'candidate_scope','current_authorized_active_description_heads','include_historical',coalesce((b->>'include_historical')::boolean,false)),'governance','levels_1_and_2_only;level_3_and_unassessed_vectors_retained_but_not_searched','semantic_validity','candidate_only_Agent_decides');
END $function$;
DO $checks$DECLARE q jsonb;b jsonb;r jsonb;ids jsonb;denied boolean:=false;BEGIN
 SELECT jsonb_agg(CASE WHEN i=1 THEN 1 ELSE 0 END ORDER BY i)INTO q FROM generate_series(1,512)i;
 b:=jsonb_build_object('project_id','16f05f01-4a43-4e96-a16b-d8ed69eff77d','embedding',q,'space',jsonb_build_object('dimension',512),'top_k',2);
 r:=pg_temp.description_search('3abab7bb-9b0e-49b3-a9d0-b15ac4032708',encode(public.digest(b::text,'sha256'),'hex'),b::text);
 SELECT jsonb_agg(value->>'material_id' ORDER BY ordinality)INTO ids FROM jsonb_array_elements(r->'items')WITH ORDINALITY;
 IF ids IS DISTINCT FROM '["dbfbecbd-badf-45c9-a7c9-b3e5f24fd39c","69e838eb-ae90-483a-af33-08822e86b30d"]'::jsonb THEN RAISE EXCEPTION 'ordered_authorized_topk_or_null_denial_failed';END IF;
 b:=b||'{"top_k":100}'::jsonb;r:=pg_temp.description_search('3abab7bb-9b0e-49b3-a9d0-b15ac4032708',encode(public.digest(b::text,'sha256'),'hex'),b::text);
 IF(r->>'returned_count')::integer<>3 THEN RAISE EXCEPTION 'raw_limit_scope_or_importance_filter_failed';END IF;
 UPDATE pg_temp.candidate_policy SET visible=false;
 r:=pg_temp.description_search('3abab7bb-9b0e-49b3-a9d0-b15ac4032708',encode(public.digest(b::text,'sha256'),'hex'),b::text);
 IF r->'items'<>'[]'::jsonb THEN RAISE EXCEPTION 'empty_authorized_result_failed';END IF;
 UPDATE pg_temp.final_policy SET revoked=true;
 BEGIN PERFORM pg_temp.description_search('3abab7bb-9b0e-49b3-a9d0-b15ac4032708',encode(public.digest(b::text,'sha256'),'hex'),b::text);EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'final_authority_fence_missing';END IF;
END$checks$;
RESET ROLE;
