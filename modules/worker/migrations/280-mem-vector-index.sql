-- Optional Agent-supplied embedding candidates. No model service or auto adoption.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
SET ROLE hub2_mem_owner;
CREATE TABLE mem.embedding_spaces(space_key text PRIMARY KEY CHECK(space_key~'^[0-9a-f]{64}$'),definition jsonb NOT NULL,dimension integer NOT NULL CHECK(dimension BETWEEN 1 AND 16000),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE mem.vector_embeddings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL,material_id uuid NOT NULL,version_id uuid NOT NULL,sha256 text NOT NULL,space_key text REFERENCES mem.embedding_spaces,dimension integer,embedding public.vector,segment jsonb NOT NULL,coverage text NOT NULL CHECK(coverage IN('complete','partial','unknown')),technical_state text NOT NULL CHECK(technical_state IN('indexed','pending_enrichment','unrankable_zero_norm')),metadata jsonb NOT NULL,actor_id uuid NOT NULL,client_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(material_id,version_id) REFERENCES mem.content_versions(material_id,id),CHECK(embedding IS NULL OR dimension=public.vector_dims(embedding)),CHECK(technical_state<>'indexed' OR (embedding IS NOT NULL AND space_key IS NOT NULL)));
CREATE INDEX vector_space_project ON mem.vector_embeddings(space_key,project_id,id);
CREATE TABLE mem.vector_ann_indexes(space_key text PRIMARY KEY REFERENCES mem.embedding_spaces,method text NOT NULL CHECK(method IN('hnsw','ivfflat')),index_name text NOT NULL UNIQUE,dimension integer NOT NULL,prepared_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON mem.embedding_spaces,mem.vector_embeddings,mem.vector_ann_indexes FROM PUBLIC,hub2_mem,hub2_worker,hub2_v8,hub2_hufu;

CREATE FUNCTION mem.vector_space_definition(value jsonb,dim integer) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('provider',COALESCE(value->>'provider','unknown'),'model',COALESCE(value->>'model','unknown'),'dimension',dim,'recipe',jsonb_build_object('name',COALESCE(value->'recipe'->>'name','unknown'),'version',COALESCE(value->'recipe'->>'version','unknown'),'parameters',COALESCE(value->'recipe'->'parameters','{}'::jsonb)),'distance','cosine')
$$;
CREATE FUNCTION mem.vector_space_known(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(value->>'provider','') NOT IN('','unknown') AND COALESCE(value->>'model','') NOT IN('','unknown') AND COALESCE(value->'recipe'->>'name','') NOT IN('','unknown') AND COALESCE(value->'recipe'->>'version','') NOT IN('','unknown') AND (value->>'dimension')::integer>0
$$;

RESET ROLE;
SET ROLE hub2_authz_owner;
-- Boolean-only owner capability; no direct authz table grant to Mem runtime.
CREATE FUNCTION authz.vector_candidate_readable(hid uuid,vid uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF session_user<>'hub2_mem' OR h.id IS NULL OR h.audience<>'mem' OR h.action<>'mem.read' OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() THEN RETURN false;END IF;
 RETURN authz.resource_set_readable(h.principal_id,h.client_id,authz.version_resources(vid,'mem.read',h.principal_id),'mem.read');
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION authz.vector_candidate_readable(uuid,uuid) FROM PUBLIC,hub2_hufu,hub2_mem,hub2_worker,hub2_v8;
GRANT EXECUTE ON FUNCTION authz.vector_candidate_readable(uuid,uuid) TO hub2_mem_owner;
RESET ROLE;
SET ROLE hub2_mem_owner;

CREATE FUNCTION mem.vector_register(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;v mem.content_versions;m mem.materials;replay jsonb;vec public.vector;dim integer;definition jsonb;space text;row mem.vector_embeddings;status text;segment jsonb;start_byte bigint;end_byte bigint;result jsonb;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.process',d,b);
 SELECT cv.* INTO v FROM mem.content_versions cv JOIN mem.materials mm ON mm.id=cv.material_id WHERE cv.id=(b->>'version_id')::uuid AND cv.material_id=(b->>'material_id')::uuid AND cv.sha256=b->>'sha256' AND mm.project_id=(c->>'project_id')::uuid;
 IF v.id IS NULL OR NOT mem.version_visible((c->>'actor_id')::uuid,v.id) THEN RAISE EXCEPTION 'fixed_reference_or_authority_mismatch' USING ERRCODE='42501';END IF;
 replay:=mem.replay_command(c,'vector_register',b,d);IF replay IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN replay;END IF;
 IF b->'embedding' IS NOT NULL AND b->'embedding'<>'null'::jsonb THEN
  IF b->'embedding' IS NULL OR jsonb_typeof(b->'embedding') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'embedding') NOT BETWEEN 1 AND 16000 OR EXISTS(SELECT FROM jsonb_array_elements(b->'embedding') x WHERE jsonb_typeof(x)<>'number') THEN RAISE EXCEPTION 'invalid_vector';END IF;
  vec:=(b->'embedding')::text::public.vector;dim:=public.vector_dims(vec);
 ELSE dim:=(b->'space'->>'dimension')::integer;END IF;
 IF dim IS NOT NULL AND dim NOT BETWEEN 1 AND 16000 THEN RAISE EXCEPTION 'invalid_vector_dimension';END IF;
 IF b->'space'->>'dimension' IS NOT NULL AND (b->'space'->>'dimension')::integer IS DISTINCT FROM dim THEN RAISE EXCEPTION 'vector_dimension_mismatch';END IF;
 definition:=mem.vector_space_definition(COALESCE(b->'space','{}'),dim);
 IF vec IS NULL OR NOT mem.vector_space_known(definition) THEN status:='pending_enrichment';
 ELSIF public.vector_norm(vec)=0 THEN status:='unrankable_zero_norm';
 ELSE status:='indexed';space:=encode(public.digest(definition::text,'sha256'),'hex');END IF;
 segment:=COALESCE(b->'segment',jsonb_build_object('byte_start',0,'byte_end',v.size));start_byte:=(segment->>'byte_start')::bigint;end_byte:=(segment->>'byte_end')::bigint;
 IF start_byte IS NULL OR end_byte IS NULL OR start_byte<0 OR end_byte<start_byte OR end_byte>v.size THEN RAISE EXCEPTION 'invalid_fixed_segment_range';END IF;
 PERFORM authz.assert_effect(h);
 IF space IS NOT NULL THEN INSERT INTO mem.embedding_spaces VALUES(space,definition,dim,clock_timestamp()) ON CONFLICT(space_key) DO NOTHING;END IF;
 INSERT INTO mem.vector_embeddings(project_id,material_id,version_id,sha256,space_key,dimension,embedding,segment,coverage,technical_state,metadata,actor_id,client_id)
 VALUES((c->>'project_id')::uuid,v.material_id,v.id,v.sha256,space,dim,vec,segment,COALESCE(b->>'coverage','unknown'),status,definition,(c->>'actor_id')::uuid,(c->>'client_id')::uuid) RETURNING * INTO row;
 result:=jsonb_build_object('state',status,'vector_id',row.id,'space_key',space,'space',definition,'fixed_ref',jsonb_build_object('material_id',v.material_id,'version_id',v.id,'sha256',v.sha256),'segment',segment,'coverage',row.coverage,'semantic_validity','agent_supplied_not_verified','next_step',CASE WHEN status='indexed' THEN 'optional_candidate_search_Agent_decides' ELSE 'enrich_metadata_or_supply_rankable_vector_no_business_block' END);
 PERFORM authz.assert_effect(h);INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((c->>'actor_id')::uuid,(c->>'client_id')::uuid,'mem','vector.register',row.id,result-'space');
 RETURN mem.remember_command(c,'vector_register',b,d,result);
END $$;

-- Exact baseline materializes ONLY current-authorized rows before distance sort.
CREATE FUNCTION mem.vector_exact_rows(h uuid,actor uuid,project uuid,space text,q public.vector,k integer) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,mem AS $$
 WITH eligible AS MATERIALIZED(SELECT e.* FROM mem.vector_embeddings e WHERE e.project_id=project AND e.space_key=space AND e.technical_state='indexed' AND EXISTS(SELECT FROM mem.materials m WHERE m.id=e.material_id AND m.state='active') AND mem.version_visible(actor,e.version_id) AND authz.vector_candidate_readable(h,e.version_id)), ranked AS(SELECT e.id vector_id,e.material_id,e.version_id,e.sha256,e.segment,e.coverage,e.metadata space,e.embedding OPERATOR(public.<=>) q distance FROM eligible e ORDER BY e.embedding OPERATOR(public.<=>) q,e.id LIMIT k)
 SELECT COALESCE(jsonb_agg(to_jsonb(ranked) ORDER BY distance,vector_id),'[]'::jsonb) FROM ranked
$$;

CREATE FUNCTION mem.vector_search(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;q public.vector;dim integer;definition jsonb;space text;k integer;requested text;mode text;ann mem.vector_ann_indexes;items jsonb;exact jsonb;recall double precision;old_jit text;old_hnsw text;old_ivf text;plan jsonb;sql text;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 IF b->'embedding' IS NULL OR jsonb_typeof(b->'embedding') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'embedding') NOT BETWEEN 1 AND 16000 OR EXISTS(SELECT FROM jsonb_array_elements(b->'embedding') x WHERE jsonb_typeof(x)<>'number') THEN RAISE EXCEPTION 'invalid_vector';END IF;
 q:=(b->'embedding')::text::public.vector;dim:=public.vector_dims(q);
 IF public.vector_norm(q)=0 THEN RAISE EXCEPTION 'cosine_query_zero_norm';END IF;
 IF b->'space'->>'dimension' IS NOT NULL AND (b->'space'->>'dimension')::integer<>dim THEN RAISE EXCEPTION 'vector_dimension_mismatch';END IF;
 definition:=mem.vector_space_definition(COALESCE(b->'space','{}'),dim);space:=encode(public.digest(definition::text,'sha256'),'hex');k:=LEAST(100,GREATEST(1,COALESCE((b->>'top_k')::integer,10)));requested:=COALESCE(b->>'mode','exact');
 IF requested NOT IN('exact','hnsw','ivfflat') THEN RAISE EXCEPTION 'invalid_vector_search_mode';END IF;
 IF NOT mem.vector_space_known(definition) THEN RETURN jsonb_build_object('state','space_definition_required','items','[]'::jsonb,'returned_count',0,'coverage',jsonb_build_object('complete',false,'reason','unknown_space_not_mixed'),'next_step','provide_consistent_space_metadata_optional_to_business');END IF;
 SELECT * INTO ann FROM mem.vector_ann_indexes WHERE space_key=space AND method=requested AND dimension=dim;
 mode:=CASE WHEN requested='exact' OR ann.space_key IS NULL THEN 'exact' ELSE requested END;
 IF mode='exact' THEN items:=mem.vector_exact_rows(h,(c->>'actor_id')::uuid,(c->>'project_id')::uuid,space,q,k);
 ELSE
  old_jit:=current_setting('jit');PERFORM set_config('jit','off',true);old_hnsw:=current_setting('hnsw.iterative_scan',true);old_ivf:=current_setting('ivfflat.iterative_scan',true);PERFORM set_config('hnsw.iterative_scan','strict_order',true);PERFORM set_config('ivfflat.iterative_scan','relaxed_order',true);
  sql:=format('SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY distance,vector_id),''[]''::jsonb) FROM (SELECT e.id vector_id,e.material_id,e.version_id,e.sha256,e.segment,e.coverage,e.metadata space,(e.embedding::public.vector(%s)) OPERATOR(public.<=>) ($1::public.vector(%s)) distance FROM mem.vector_embeddings e WHERE e.space_key=%L AND e.project_id=$2 AND e.technical_state=''indexed'' AND EXISTS(SELECT FROM mem.materials m WHERE m.id=e.material_id AND m.state=''active'') AND mem.version_visible($3,e.version_id) AND authz.vector_candidate_readable($4,e.version_id) ORDER BY e.embedding::public.vector(%s) OPERATOR(public.<=>) $1::public.vector(%s) LIMIT $5) r',dim,dim,space,dim,dim);
  EXECUTE 'EXPLAIN (FORMAT JSON) '||sql INTO plan USING q,(c->>'project_id')::uuid,(c->>'actor_id')::uuid,h,k;
  IF EXISTS(SELECT FROM jsonb_path_query(plan,'$.**."Index Name"') n WHERE n #>> '{}' =ann.index_name) THEN
   EXECUTE sql INTO items USING q,(c->>'project_id')::uuid,(c->>'actor_id')::uuid,h,k;
  ELSE mode:='exact';items:=mem.vector_exact_rows(h,(c->>'actor_id')::uuid,(c->>'project_id')::uuid,space,q,k);END IF;
  PERFORM set_config('jit',old_jit,true);PERFORM set_config('hnsw.iterative_scan',COALESCE(old_hnsw,'off'),true);PERFORM set_config('ivfflat.iterative_scan',COALESCE(old_ivf,'off'),true);
 END IF;
 IF COALESCE((b->>'compare_exact')::boolean,false) AND mode<>'exact' THEN
  exact:=mem.vector_exact_rows(h,(c->>'actor_id')::uuid,(c->>'project_id')::uuid,space,q,k);
  IF jsonb_array_length(exact)>0 THEN SELECT count(*)::double precision/jsonb_array_length(exact) INTO recall FROM jsonb_array_elements(items) a JOIN jsonb_array_elements(exact) e ON a->>'vector_id'=e->>'vector_id';END IF;
 END IF;
 PERFORM mem.bind_request_sources(h,jsonb_build_object('fixed_refs',items),(c->>'actor_id')::uuid,'mem.read');PERFORM authz.assert_effect(h);
 -- Current authorized stale/fixed status is information, never automatic adopt.
 SELECT COALESCE(jsonb_agg(item||jsonb_build_object('similarity',1-(item->>'distance')::double precision,'source_stale',mem.version_stale((item->>'version_id')::uuid),'is_current_version',EXISTS(SELECT FROM mem.materials m WHERE m.id=(item->>'material_id')::uuid AND m.current_version_id=(item->>'version_id')::uuid))),'[]') INTO items FROM jsonb_array_elements(items) item;
 RETURN jsonb_build_object('state','ranked_candidates','items',items,'returned_count',jsonb_array_length(items),'space_key',space,'space',definition,'mode',mode,'requested_mode',requested,'ann_index_used',mode<>'exact','recall_at_k',recall,'coverage',jsonb_build_object('candidate_scope','current_authorized_indexed_rows_in_requested_project_and_space','complete_for_requested_top_k',mode='exact','not_material_enumeration',true,'unindexed_scope','unknown','recall',CASE WHEN mode='exact' THEN 'exact_mathematical_top_k' WHEN recall IS NULL THEN 'not_measured' ELSE 'measured_against_authorized_exact_same_query' END),'semantic_validity','candidate_only_Agent_decides_no_threshold_no_auto_adoption');
END $$;

-- Optional per-space physical index preparation by migration/owner only.
CREATE FUNCTION mem.vector_prepare_ann(space text,method text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE definition mem.embedding_spaces;old mem.vector_ann_indexes;name text;
BEGIN
 IF method NOT IN('hnsw','ivfflat') OR space !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_ann_configuration';END IF;
 SELECT * INTO definition FROM mem.embedding_spaces WHERE space_key=space;
 IF definition.space_key IS NULL THEN RAISE EXCEPTION 'unknown_space';END IF;
 IF definition.dimension>2000 THEN RETURN jsonb_build_object('state','exact_only_dimension','dimension',definition.dimension);END IF;
 SELECT * INTO old FROM mem.vector_ann_indexes WHERE space_key=space;
 IF old.space_key IS NOT NULL THEN EXECUTE format('DROP INDEX mem.%I',old.index_name);DELETE FROM mem.vector_ann_indexes WHERE space_key=space;END IF;
 name:='vec_'||method||'_'||replace(gen_random_uuid()::text,'-','');
 EXECUTE format('CREATE INDEX %I ON mem.vector_embeddings USING %s ((embedding::public.vector(%s)) public.vector_cosine_ops) %s WHERE space_key=%L AND technical_state=''indexed''',name,method,definition.dimension,CASE WHEN method='ivfflat' THEN 'WITH (lists=1)' ELSE '' END,space);
 INSERT INTO mem.vector_ann_indexes(space_key,method,index_name,dimension) VALUES(space,method,name,definition.dimension);
 RETURN jsonb_build_object('state','ann_prepared','space_key',space,'method',method,'dimension',definition.dimension,'index_name',name,'recall','not_measured_yet');
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mem FROM PUBLIC;
REVOKE ALL ON FUNCTION mem.vector_prepare_ann(text,text),mem.vector_exact_rows(uuid,uuid,uuid,text,public.vector,integer),mem.vector_space_definition(jsonb,integer),mem.vector_space_known(jsonb) FROM hub2_mem,hub2_worker,hub2_hufu,hub2_v8;
GRANT EXECUTE ON FUNCTION mem.vector_register(uuid,text,text),mem.vector_search(uuid,text,text) TO hub2_mem;
RESET ROLE;
