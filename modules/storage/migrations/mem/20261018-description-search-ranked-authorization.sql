SET ROLE hub2_mem_owner;DO $$BEGIN IF md5((SELECT prosrc FROM pg_proc WHERE oid='mem.description_vector_search(uuid,text,text)'::regprocedure)) IS DISTINCT FROM 'eefee95a8cb755f0569160b5ce5c9084'THEN RAISE EXCEPTION 'description_search_current_source_changed_review_required';END IF;END $$;CREATE OR REPLACE FUNCTION mem.description_vector_search(h uuid,d text,payload text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $function$
DECLARE b jsonb:=payload::jsonb;c jsonb;definition jsonb;space_key_value text;q public.vector;k integer;items jsonb:='[]';refs jsonb;requested text;candidate record;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 IF (b->>'project_id')::uuid IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(b->'embedding') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'embedding')<>512 OR EXISTS(SELECT FROM jsonb_array_elements(b->'embedding')x WHERE jsonb_typeof(x)<>'number') OR (b->'space'->>'dimension')::integer IS DISTINCT FROM 512 THEN RAISE EXCEPTION 'invalid_description_vector';END IF;
 q:=(b->'embedding')::text::public.vector;IF public.vector_norm(q)=0 THEN RAISE EXCEPTION 'cosine_query_zero_norm';END IF;
 definition:=mem.vector_space_definition(b->'space',512)||jsonb_build_object('purpose','agent_description','representation_version',1);
 IF NOT mem.vector_space_known(definition) THEN RAISE EXCEPTION 'space_definition_required';END IF;
 space_key_value:=encode(public.digest(definition::text,'sha256'),'hex');k:=coalesce((b->>'top_k')::integer,10);requested:=coalesce(b->>'mode','exact');
 IF k NOT BETWEEN 1 AND 100 OR requested NOT IN('exact','hnsw','ivfflat') THEN RAISE EXCEPTION 'invalid_input';END IF;
 -- Exact distance order. Evaluate current eligibility until k authorized results exist;
 -- do not truncate raw candidates before permission checks.
 FOR candidate IN
  SELECT e.*,dr.material_id,dr.sha256,dr.text_content,dr.state,dr.source_declaration,dr.reason,dr.evidence,m.current_version_id,
   (e.embedding OPERATOR(public.<=>) q) distance
  FROM mem.agent_description_vectors e JOIN mem.agent_description_revisions dr ON dr.version_id=e.version_id AND dr.revision=e.description_revision
  JOIN mem.agent_description_heads dh ON dh.version_id=dr.version_id AND dh.revision=dr.revision JOIN mem.materials m ON m.id=dr.material_id
  WHERE e.space_key=space_key_value AND m.project_id=(c->>'project_id')::uuid AND m.state='active' AND mem.description_index_eligible(m.id) AND dr.state='active' AND btrim(dr.text_content)<>''
   AND (coalesce((b->>'include_historical')::boolean,false) OR m.current_version_id=e.version_id)
  ORDER BY (e.embedding OPERATOR(public.<=>) q),e.id
 LOOP
  IF (mem.version_visible((c->>'actor_id')::uuid,candidate.version_id) AND authz.vector_candidate_readable(h,candidate.version_id) AND mem.description_candidate_visible(h,(c->>'actor_id')::uuid,candidate.version_id,candidate.description_revision))IS DISTINCT FROM true THEN CONTINUE;END IF;
  items:=items||jsonb_build_array(jsonb_build_object('vector_id',candidate.id,'material_id',candidate.material_id,'version_id',candidate.version_id,'sha256',candidate.sha256,
   'fixed_ref',jsonb_build_object('material_id',candidate.material_id,'version_id',candidate.version_id,'sha256',candidate.sha256),
   'description',jsonb_build_object('revision',candidate.description_revision,'text',candidate.text_content,'text_sha256',candidate.description_sha256,'state',candidate.state,'source_declaration',candidate.source_declaration,'reason',candidate.reason,'evidence',candidate.evidence),
   'distance',candidate.distance,'similarity',1-candidate.distance,'current_version_id',candidate.current_version_id,'freshness',CASE WHEN candidate.current_version_id=candidate.version_id AND NOT mem.version_stale(candidate.version_id)THEN 'current' ELSE 'needs_refresh'END));
  EXIT WHEN jsonb_array_length(items)>=k;
 END LOOP;
 SELECT coalesce(jsonb_agg(ref),'[]') INTO refs FROM jsonb_array_elements(items)item CROSS JOIN LATERAL jsonb_array_elements(coalesce(mem.description_revision_refs((item->>'version_id')::uuid,coalesce((item->'description'->>'revision')::bigint,(item->>'description_revision')::bigint)),jsonb_build_array(item->'fixed_ref')))ref;
 PERFORM mem.bind_search_result_sources(h,refs,(c->>'actor_id')::uuid);PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','ranked_candidates','items',items,'returned_count',jsonb_array_length(items),'mode','exact','requested_mode',requested,'ann_index_used',false,'fallback_reason',CASE WHEN requested<>'exact' THEN 'description_ann_not_prepared' END,'space_key',space_key_value,'space',definition,'coverage',jsonb_build_object('complete_for_requested_top_k',true,'candidate_scope','current_authorized_active_description_heads','include_historical',coalesce((b->>'include_historical')::boolean,false)),'governance','levels_1_and_2_only;level_3_and_unassessed_vectors_retained_but_not_searched','semantic_validity','candidate_only_Agent_decides');
END $function$;
DO $$BEGIN IF md5((SELECT prosrc FROM pg_proc WHERE oid='mem.description_vector_search(uuid,text,text)'::regprocedure))IS DISTINCT FROM 'cd2702a73460bfa3d3701353e9234268'THEN RAISE EXCEPTION 'description_search_new_source_mismatch';END IF;END $$;RESET ROLE;
