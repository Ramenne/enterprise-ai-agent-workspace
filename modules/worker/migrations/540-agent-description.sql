-- Independent candidate over combined-url-search54. No legacy index mutation.
SET ROLE hub2_mem_owner;
CREATE TABLE mem.agent_description_revisions (
 material_id uuid NOT NULL,version_id uuid NOT NULL,sha256 text NOT NULL,object_id uuid NOT NULL,size bigint NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),text_content text NOT NULL,
 text_sha256 text GENERATED ALWAYS AS (encode(public.digest(text_content,'sha256'),'hex')) STORED,
 state text NOT NULL CHECK(state IN('active','draft','withdrawn')),
 source_declaration jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(source_declaration)='object'),
 reason jsonb,evidence jsonb,actor_id uuid NOT NULL,client_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(version_id,revision),
 UNIQUE(version_id,revision,text_sha256),
 FOREIGN KEY(material_id,version_id,object_id,sha256,size) REFERENCES mem.content_versions(material_id,id,object_id,sha256,size)
);
CREATE TABLE mem.agent_description_heads (
 version_id uuid PRIMARY KEY REFERENCES mem.content_versions(id),revision bigint NOT NULL,
 FOREIGN KEY(version_id,revision) REFERENCES mem.agent_description_revisions(version_id,revision)
);
CREATE TABLE mem.agent_description_vectors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),version_id uuid NOT NULL,description_revision bigint NOT NULL,
 description_sha256 text NOT NULL,space_key text NOT NULL CHECK(space_key~'^[0-9a-f]{64}$'),
 space jsonb NOT NULL,embedding public.vector(512) NOT NULL CHECK(public.vector_norm(embedding)>0),
 actor_id uuid NOT NULL,client_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(version_id,description_revision,description_sha256) REFERENCES mem.agent_description_revisions(version_id,revision,text_sha256),
 UNIQUE(version_id,description_revision,space_key)
);
CREATE INDEX agent_description_vectors_space ON mem.agent_description_vectors(space_key,version_id,description_revision);
REVOKE ALL ON mem.agent_description_revisions,mem.agent_description_heads,mem.agent_description_vectors FROM PUBLIC,hub2_mem,hub2_worker,hub2_hufu,hub2_v8;

-- Only owners have table rights; additionally reject accidental in-place history edits.
CREATE FUNCTION mem.agent_description_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'immutable_description_revision' USING ERRCODE='55000';END $$;
CREATE TRIGGER agent_description_immutable BEFORE UPDATE OR DELETE ON mem.agent_description_revisions FOR EACH ROW EXECUTE FUNCTION mem.agent_description_immutable();

CREATE FUNCTION mem.description_source_refs(material uuid,version uuid,hash text,declaration jsonb)RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,mem AS $$
 SELECT jsonb_build_array(jsonb_build_object('material_id',material,'version_id',version,'sha256',hash))||coalesce((SELECT jsonb_agg(x)FROM jsonb_path_query(coalesce(declaration,'{}'),'$.**')x WHERE jsonb_typeof(x)='object' AND x->>'material_id'~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND x->>'version_id'~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND x->>'sha256'~'^[0-9a-f]{64}$'),'[]')
$$;
RESET ROLE;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.lock_description_source_snapshot(hid uuid,resources jsonb)RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$ DECLARE h authz.handles;BEGIN SELECT * INTO h FROM authz.handles WHERE id=hid;IF h.id IS NULL OR authz.runtime_role()<>'hub2_mem'OR h.audience<>'mem'OR h.action NOT IN('mem.read','mem.write','mem.process')OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id()OR jsonb_typeof(resources)IS DISTINCT FROM'array'THEN RAISE EXCEPTION 'invalid_source_guard' USING ERRCODE='42501';END IF;PERFORM authz.lock_resources(h.principal_id,h.client_id,h.credential_id,resources);END $$;
CREATE FUNCTION authz.bind_description_sources_nowait(hid uuid,resources jsonb)RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$ DECLARE h authz.handles;BEGIN SELECT * INTO h FROM authz.handles WHERE id=hid;IF h.id IS NULL OR authz.runtime_role()<>'hub2_mem'OR h.audience<>'mem'OR h.action NOT IN('mem.read','mem.write','mem.process')OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id()OR jsonb_typeof(resources)IS DISTINCT FROM'array'THEN RAISE EXCEPTION 'invalid_source_guard' USING ERRCODE='42501';END IF;PERFORM authz.lock_resources_search_nowait(h.principal_id,h.client_id,h.credential_id,resources);PERFORM authz.assert_sources(hid,resources,'mem.read');END $$;
REVOKE ALL ON FUNCTION authz.lock_description_source_snapshot(uuid,jsonb),authz.bind_description_sources_nowait(uuid,jsonb)FROM PUBLIC,hub2_mem,hub2_worker,hub2_hufu,hub2_v8;
GRANT EXECUTE ON FUNCTION authz.lock_description_source_snapshot(uuid,jsonb),authz.bind_description_sources_nowait(uuid,jsonb)TO hub2_mem_owner;
RESET ROLE;
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.description_bind_sources(h uuid,refs jsonb,actor uuid)RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE a jsonb;b jsonb;fullresources jsonb;effective jsonb;beforeids jsonb;afterids jsonb;disclosures jsonb;
BEGIN
 IF jsonb_typeof(refs)IS DISTINCT FROM'array'OR EXISTS(SELECT FROM jsonb_array_elements(refs)r LEFT JOIN mem.content_versions v ON v.id=(r->>'version_id')::uuid AND v.material_id=(r->>'material_id')::uuid AND v.sha256=r->>'sha256' LEFT JOIN mem.materials m ON m.id=v.material_id WHERE v.id IS NULL OR m.id IS NULL OR(v.provenance_state='pending'AND v.actor_id IS DISTINCT FROM actor AND m.owner_id IS DISTINCT FROM actor))THEN RAISE EXCEPTION 'unknown_source' USING ERRCODE='42501';END IF;
 a:=mem.search_source_snapshot(refs);
 SELECT coalesce(jsonb_agg(d.id ORDER BY d.id),'[]')INTO beforeids FROM mem.disclosures d WHERE d.output_version_id IN(SELECT(g->'resource'->>'version_id')::uuid FROM jsonb_array_elements(a)g);
 SELECT coalesce(jsonb_agg(resource ORDER BY resource::text),'[]')INTO fullresources FROM(SELECT DISTINCT value->'resource' resource FROM jsonb_array_elements(a))q;
 PERFORM authz.lock_description_source_snapshot(h,fullresources);
 PERFORM m.id FROM mem.materials m WHERE m.id IN(SELECT(g->>'pending_material_id')::uuid FROM jsonb_array_elements(a)g WHERE g->>'pending_material_id'IS NOT NULL)ORDER BY m.id FOR SHARE OF m NOWAIT;
 b:=mem.search_source_snapshot(refs);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'output_version_id',d.output_version_id,'state',d.state,'not_required',d.manifest->>'continued_source_access'='not_required')ORDER BY d.id),'[]')INTO disclosures FROM mem.disclosures d WHERE d.output_version_id IN(SELECT(g->'resource'->>'version_id')::uuid FROM jsonb_array_elements(b)g);
 SELECT coalesce(jsonb_agg(x->'id'ORDER BY x->>'id'),'[]')INTO afterids FROM jsonb_array_elements(disclosures)x;
 IF a IS DISTINCT FROM b OR beforeids IS DISTINCT FROM afterids THEN RAISE EXCEPTION 'description_source_changed_retry' USING ERRCODE='55P03';END IF;
 SELECT coalesce(jsonb_agg(resource ORDER BY resource::text),'[]')INTO effective FROM(SELECT DISTINCT g->'resource' resource FROM jsonb_array_elements(b)g WHERE g->>'root_version_id'=g->'resource'->>'version_id'OR NOT EXISTS(SELECT FROM jsonb_array_elements(disclosures)d WHERE d->>'output_version_id'=g->>'root_version_id'AND d->>'state'='active'AND d->>'not_required'='true'))q;
 PERFORM authz.bind_description_sources_nowait(h,effective);
END $$;
CREATE FUNCTION mem.description_candidate_visible(h uuid,actor uuid,version uuid,rev bigint) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,mem AS $$
DECLARE dr mem.agent_description_revisions;ref jsonb;
BEGIN
 SELECT * INTO dr FROM mem.agent_description_revisions WHERE version_id=version AND revision=rev;
 IF dr.revision IS NULL THEN RETURN true;END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(mem.description_source_refs(dr.material_id,dr.version_id,dr.sha256,jsonb_build_object('declaration',dr.source_declaration,'evidence',dr.evidence))) LOOP
  IF NOT EXISTS(SELECT FROM mem.content_versions cv WHERE cv.id=(ref->>'version_id')::uuid AND cv.material_id=(ref->>'material_id')::uuid AND cv.sha256=ref->>'sha256') OR NOT mem.version_visible(actor,(ref->>'version_id')::uuid) OR NOT authz.vector_candidate_readable(h,(ref->>'version_id')::uuid) THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;
CREATE FUNCTION mem.description_revision_refs(version uuid,rev bigint) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,mem AS $$
 SELECT mem.description_source_refs(dr.material_id,dr.version_id,dr.sha256,jsonb_build_object('declaration',dr.source_declaration,'evidence',dr.evidence)) FROM mem.agent_description_revisions dr WHERE dr.version_id=version AND dr.revision=rev
$$;
CREATE FUNCTION mem.description_fixed(c jsonb,b jsonb) RETURNS mem.content_versions
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,mem AS $$
DECLARE v mem.content_versions;
BEGIN
 IF (b->>'project_id')::uuid IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 SELECT cv.* INTO v FROM mem.content_versions cv JOIN mem.materials m ON m.id=cv.material_id
 WHERE cv.id=(b->>'version_id')::uuid AND cv.material_id=(b->>'material_id')::uuid AND cv.sha256=b->>'sha256'
 AND m.project_id=(c->>'project_id')::uuid AND mem.version_visible((c->>'actor_id')::uuid,cv.id);
 IF v.id IS NULL THEN RAISE EXCEPTION 'fixed_reference_or_authority_mismatch' USING ERRCODE='42501';END IF;
 RETURN v;
END $$;
CREATE FUNCTION mem.description_result(v mem.content_versions,revision_requested bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,mem AS $$
DECLARE r mem.agent_description_revisions;current_id uuid;latest_revision bigint;
BEGIN
 SELECT current_version_id INTO current_id FROM mem.materials WHERE id=v.material_id;
 SELECT revision INTO latest_revision FROM mem.agent_description_heads WHERE version_id=v.id;
 SELECT * INTO r FROM mem.agent_description_revisions WHERE version_id=v.id AND revision=coalesce(revision_requested,latest_revision);
 IF revision_requested IS NOT NULL AND r.revision IS NULL THEN RAISE EXCEPTION 'description_revision_missing' USING ERRCODE='P0002';END IF;
 RETURN jsonb_build_object('state',CASE WHEN r.revision IS NULL OR r.state<>'active' OR btrim(r.text_content)='' THEN 'needs_agent_description' ELSE 'ready' END,
 'description',CASE WHEN r.revision IS NULL THEN NULL ELSE jsonb_build_object('revision',r.revision,'text',r.text_content,'text_sha256',r.text_sha256,'state',r.state,'source_declaration',r.source_declaration,'reason',r.reason,'evidence',r.evidence,'actor_id',r.actor_id,'created_at',r.created_at) END,
 'fixed_ref',jsonb_build_object('material_id',v.material_id,'version_id',v.id,'sha256',v.sha256),
 'freshness',CASE WHEN current_id=v.id AND (r.revision IS NULL OR r.revision=latest_revision) AND NOT mem.version_stale(v.id) AND NOT (r.revision IS NULL AND EXISTS(SELECT FROM mem.agent_description_revisions old WHERE old.material_id=v.material_id AND old.version_id<>v.id)) THEN 'current' ELSE 'needs_refresh' END,
 'current_version_id',current_id,'latest_description_revision',coalesce(latest_revision,0));
END $$;
CREATE FUNCTION mem.description_read(h uuid,d text,payload text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;v mem.content_versions;r jsonb;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.read',d,b);v:=mem.description_fixed(c,b);
 r:=mem.description_result(v,(b->>'description_revision')::bigint);
 IF r->'description' IS NOT NULL AND r->'description'<>'null'::jsonb THEN PERFORM mem.description_bind_sources(h,mem.description_revision_refs(v.id,(r->'description'->>'revision')::bigint),(c->>'actor_id')::uuid);END IF;
 PERFORM authz.assert_effect(h);RETURN r;
END $$;
CREATE FUNCTION mem.description_save(h uuid,d text,payload text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;v mem.content_versions;previous bigint;r jsonb;replay jsonb;m mem.materials;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.write',d,b);v:=mem.description_fixed(c,b);
 PERFORM mem.description_bind_sources(h,mem.description_source_refs(v.material_id,v.id,v.sha256,jsonb_build_object('declaration',b->'source_declaration','evidence',b->'evidence')),(c->>'actor_id')::uuid);
 replay:=mem.replay_command(c,'description_save',b,d);IF replay IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN replay;END IF;
 IF jsonb_typeof(b->'text') IS DISTINCT FROM 'string' OR char_length(b->>'text')>1500000 OR coalesce(b->>'state','active') NOT IN('active','draft','withdrawn') OR jsonb_typeof(coalesce(b->'source_declaration','{}')) IS DISTINCT FROM 'object' OR coalesce((b->>'expected_revision')::bigint,0)<0 THEN RAISE EXCEPTION 'invalid_input';END IF;
 -- Serializes first save too; no global lock. Guard authority locks precede this lock.
 SELECT * INTO m FROM mem.materials WHERE id=v.material_id FOR UPDATE;
 SELECT revision INTO previous FROM mem.agent_description_heads WHERE version_id=v.id;
 previous:=coalesce(previous,0);
 IF previous IS DISTINCT FROM coalesce((b->>'expected_revision')::bigint,0) THEN RAISE EXCEPTION 'description_revision_conflict' USING ERRCODE='40001';END IF;
 PERFORM authz.assert_effect(h);
 INSERT INTO mem.agent_description_revisions(material_id,version_id,sha256,object_id,size,revision,text_content,state,source_declaration,reason,evidence,actor_id,client_id)
 VALUES(v.material_id,v.id,v.sha256,v.object_id,v.size,previous+1,b->>'text',coalesce(b->>'state','active'),coalesce(b->'source_declaration','{}'),b->'reason',b->'evidence',(c->>'actor_id')::uuid,(c->>'client_id')::uuid);
 INSERT INTO mem.agent_description_heads VALUES(v.id,previous+1) ON CONFLICT(version_id) DO UPDATE SET revision=EXCLUDED.revision;
 UPDATE mem.materials SET event_revision=event_revision+1 WHERE id=m.id RETURNING * INTO m;
 r:=mem.description_result(v,NULL)||jsonb_build_object('saved',true);
 PERFORM mem.emit(c,'description.saved',m.id,m.event_revision,NULL,r-'description');
 PERFORM authz.assert_effect(h);RETURN mem.remember_command(c,'description_save',b,d,r);
END $$;
CREATE FUNCTION mem.description_vector_register(h uuid,d text,payload text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;v mem.content_versions;dr mem.agent_description_revisions;replay jsonb;definition jsonb;space_key_value text;vec public.vector;entry mem.agent_description_vectors;r jsonb;m mem.materials;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.process',d,b);v:=mem.description_fixed(c,b);
 replay:=mem.replay_command(c,'description_vector_register',b,d);IF replay IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN replay;END IF;
 IF jsonb_typeof(b->'embedding') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'embedding')<>512 OR EXISTS(SELECT FROM jsonb_array_elements(b->'embedding')x WHERE jsonb_typeof(x)<>'number') OR (b->'space'->>'dimension')::integer IS DISTINCT FROM 512 THEN RAISE EXCEPTION 'invalid_description_vector';END IF;
 vec:=(b->'embedding')::text::public.vector;IF public.vector_norm(vec)=0 THEN RAISE EXCEPTION 'cosine_vector_zero_norm';END IF;
 definition:=mem.vector_space_definition(b->'space',512)||jsonb_build_object('purpose','agent_description','representation_version',1);
 IF NOT mem.vector_space_known(definition) THEN RAISE EXCEPTION 'space_definition_required';END IF;
 space_key_value:=encode(public.digest(definition::text,'sha256'),'hex');
 PERFORM mem.description_bind_sources(h,coalesce(mem.description_revision_refs(v.id,(b->>'description_revision')::bigint),'[]'),(c->>'actor_id')::uuid);
 SELECT * INTO m FROM mem.materials WHERE id=v.material_id FOR UPDATE;
 SELECT dr0.* INTO dr FROM mem.agent_description_revisions dr0 JOIN mem.agent_description_heads dh ON dh.version_id=dr0.version_id AND dh.revision=dr0.revision
 WHERE dr0.version_id=v.id AND dr0.revision=(b->>'description_revision')::bigint AND dr0.text_sha256=b->>'description_sha256' AND dr0.state='active' AND btrim(dr0.text_content)<>'';
 IF dr.revision IS NULL THEN RAISE EXCEPTION 'description_revision_or_hash_conflict' USING ERRCODE='40001';END IF;
 PERFORM authz.assert_effect(h);
 -- One immutable vector per description revision and space; different payload cannot silently replace it.
 INSERT INTO mem.agent_description_vectors(version_id,description_revision,description_sha256,space_key,space,embedding,actor_id,client_id)
 VALUES(v.id,dr.revision,dr.text_sha256,space_key_value,definition,vec,(c->>'actor_id')::uuid,(c->>'client_id')::uuid) ON CONFLICT(version_id,description_revision,space_key) DO NOTHING RETURNING * INTO entry;
 IF entry.id IS NULL THEN
  SELECT * INTO entry FROM mem.agent_description_vectors WHERE version_id=v.id AND description_revision=dr.revision AND space_key=space_key_value;
  IF entry.embedding::text IS DISTINCT FROM vec::public.vector(512)::text THEN RAISE EXCEPTION 'description_vector_conflict' USING ERRCODE='40001';END IF;
 END IF;
 r:=jsonb_build_object('state','indexed','vector_id',entry.id,'space_key',space_key_value,'space',definition,'description_revision',dr.revision,'description_sha256',dr.text_sha256,'fixed_ref',jsonb_build_object('material_id',v.material_id,'version_id',v.id,'sha256',v.sha256),'representation','agent_description_only','semantic_validity','agent_supplied_not_verified');
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((c->>'actor_id')::uuid,(c->>'client_id')::uuid,'mem','description.vector_registered',entry.id,r);
 PERFORM authz.assert_effect(h);RETURN mem.remember_command(c,'description_vector_register',b,d,r);
END $$;
CREATE FUNCTION mem.description_vector_search(h uuid,d text,payload text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;definition jsonb;space_key_value text;q public.vector;k integer;items jsonb;refs jsonb;requested text;
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
 -- Description ANN is not prepared in this migration. Always use authorized exact fallback.
 WITH eligible AS MATERIALIZED(
  SELECT e.*,dr.material_id,dr.sha256,dr.text_content,dr.state,dr.source_declaration,dr.reason,dr.evidence,m.current_version_id,
  (e.embedding OPERATOR(public.<=>) q) distance
  FROM mem.agent_description_vectors e JOIN mem.agent_description_revisions dr ON dr.version_id=e.version_id AND dr.revision=e.description_revision
  JOIN mem.agent_description_heads dh ON dh.version_id=dr.version_id AND dh.revision=dr.revision JOIN mem.materials m ON m.id=dr.material_id
  WHERE e.space_key=space_key_value AND m.project_id=(c->>'project_id')::uuid AND m.state='active' AND dr.state='active' AND btrim(dr.text_content)<>''
  AND (coalesce((b->>'include_historical')::boolean,false) OR m.current_version_id=e.version_id)
  AND mem.version_visible((c->>'actor_id')::uuid,e.version_id) AND authz.vector_candidate_readable(h,e.version_id) AND mem.description_candidate_visible(h,(c->>'actor_id')::uuid,e.version_id,dr.revision)
 ),ranked AS(SELECT * FROM eligible ORDER BY distance,id LIMIT k)
 SELECT coalesce(jsonb_agg(jsonb_build_object('vector_id',id,'material_id',material_id,'version_id',version_id,'sha256',sha256,
 'fixed_ref',jsonb_build_object('material_id',material_id,'version_id',version_id,'sha256',sha256),
 'description',jsonb_build_object('revision',description_revision,'text',text_content,'text_sha256',description_sha256,'state',state,'source_declaration',source_declaration,'reason',reason,'evidence',evidence),
 'distance',distance,'similarity',1-distance,'current_version_id',current_version_id,'freshness',CASE WHEN current_version_id=version_id AND NOT mem.version_stale(version_id) THEN 'current' ELSE 'needs_refresh' END) ORDER BY distance,id),'[]') INTO items FROM ranked;
 SELECT coalesce(jsonb_agg(ref),'[]') INTO refs FROM jsonb_array_elements(items)item CROSS JOIN LATERAL jsonb_array_elements(coalesce(mem.description_revision_refs((item->>'version_id')::uuid,coalesce((item->'description'->>'revision')::bigint,(item->>'description_revision')::bigint)),jsonb_build_array(item->'fixed_ref')))ref;
 PERFORM mem.bind_search_result_sources(h,refs,(c->>'actor_id')::uuid);PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','ranked_candidates','items',items,'returned_count',jsonb_array_length(items),'mode','exact','requested_mode',requested,'ann_index_used',false,'fallback_reason',CASE WHEN requested<>'exact' THEN 'description_ann_not_prepared' END,'space_key',space_key_value,'space',definition,'coverage',jsonb_build_object('complete_for_requested_top_k',true,'candidate_scope','current_authorized_active_description_heads','include_historical',coalesce((b->>'include_historical')::boolean,false)),'semantic_validity','candidate_only_Agent_decides');
END $$;
CREATE FUNCTION mem.description_pending(h uuid,d text,payload text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;n integer;items jsonb;refs jsonb;more boolean;next_cursor uuid;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 IF (b->>'project_id')::uuid IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 n:=coalesce((b->>'limit')::integer,20);IF n NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_limit';END IF;
 WITH eligible AS MATERIALIZED(
 SELECT m.id material_id,cv.id version_id,cv.sha256,m.current_version_id,coalesce(dr.revision,0) description_revision,
 CASE WHEN dr.revision IS NULL AND EXISTS(SELECT FROM mem.agent_description_revisions old WHERE old.material_id=m.id AND old.version_id<>cv.id) THEN 'needs_refresh'
 WHEN dr.revision IS NULL OR dr.state<>'active' OR btrim(dr.text_content)='' THEN 'needs_agent_description'
 WHEN mem.version_stale(cv.id) THEN 'needs_refresh' ELSE 'needs_description_vector' END maintenance_state
 FROM mem.materials m JOIN mem.content_versions cv ON cv.material_id=m.id
 LEFT JOIN mem.agent_description_heads dh ON dh.version_id=cv.id LEFT JOIN mem.agent_description_revisions dr ON dr.version_id=dh.version_id AND dr.revision=dh.revision
 WHERE m.project_id=(c->>'project_id')::uuid AND m.state='active' AND (coalesce((b->>'include_historical')::boolean,false) OR cv.id=m.current_version_id)
 AND (b->>'cursor' IS NULL OR cv.id>(b->>'cursor')::uuid)
 AND (dr.revision IS NULL OR dr.state<>'active' OR btrim(dr.text_content)='' OR mem.version_stale(cv.id) OR NOT EXISTS(SELECT FROM mem.agent_description_vectors e WHERE e.version_id=cv.id AND e.description_revision=dr.revision))
 AND mem.version_visible((c->>'actor_id')::uuid,cv.id) AND authz.vector_candidate_readable(h,cv.id) AND mem.description_candidate_visible(h,(c->>'actor_id')::uuid,cv.id,dr.revision)
 ),page AS(SELECT * FROM eligible ORDER BY version_id LIMIT n+1)
 SELECT coalesce(jsonb_agg(to_jsonb(page)||jsonb_build_object('fixed_ref',jsonb_build_object('material_id',material_id,'version_id',version_id,'sha256',sha256),'freshness',CASE WHEN current_version_id=version_id AND maintenance_state<>'needs_refresh' THEN 'current' ELSE 'needs_refresh' END,'maintenance',jsonb_build_object('state',maintenance_state)) ORDER BY version_id),'[]') INTO items FROM page;
 more:=jsonb_array_length(items)>n;IF more THEN items:=items-(-1);next_cursor:=(items->-1->>'version_id')::uuid;END IF;
 SELECT coalesce(jsonb_agg(ref),'[]') INTO refs FROM jsonb_array_elements(items)item CROSS JOIN LATERAL jsonb_array_elements(coalesce(mem.description_revision_refs((item->>'version_id')::uuid,coalesce((item->'description'->>'revision')::bigint,(item->>'description_revision')::bigint)),jsonb_build_array(item->'fixed_ref')))ref;
 PERFORM mem.bind_search_result_sources(h,refs,(c->>'actor_id')::uuid);PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','maintenance_candidates','items',items,'returned_count',jsonb_array_length(items),'next_cursor',next_cursor,'coverage','current_visible_pending_page');
END $$;
REVOKE ALL ON FUNCTION mem.description_source_refs(uuid,uuid,text,jsonb),mem.description_bind_sources(uuid,jsonb,uuid),mem.description_candidate_visible(uuid,uuid,uuid,bigint),mem.description_revision_refs(uuid,bigint) FROM PUBLIC,hub2_mem,hub2_worker,hub2_hufu,hub2_v8;
REVOKE ALL ON FUNCTION mem.agent_description_immutable(),mem.description_fixed(jsonb,jsonb),mem.description_result(mem.content_versions,bigint),mem.description_read(uuid,text,text),mem.description_save(uuid,text,text),mem.description_vector_register(uuid,text,text),mem.description_vector_search(uuid,text,text),mem.description_pending(uuid,text,text) FROM PUBLIC,hub2_mem,hub2_worker,hub2_hufu,hub2_v8;
GRANT EXECUTE ON FUNCTION mem.description_read(uuid,text,text),mem.description_save(uuid,text,text),mem.description_vector_register(uuid,text,text),mem.description_vector_search(uuid,text,text),mem.description_pending(uuid,text,text) TO hub2_mem;
-- Runtime cannot append legacy full-text candidates. Operational rollback requires
-- deployment configuration restoring this private retained function's entrypoint.
ALTER FUNCTION mem.vector_register(uuid,text,text) RENAME TO vector_register_legacy_retained;
REVOKE ALL ON FUNCTION mem.vector_register_legacy_retained(uuid,text,text) FROM PUBLIC,hub2_mem,hub2_worker,hub2_hufu,hub2_v8;
CREATE FUNCTION mem.vector_register(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 IF b ? 'representation' OR b ? 'mode' OR b ? 'rollback' THEN RAISE EXCEPTION 'deployment_configuration_required' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.process',d,b);PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','fulltext_index_disabled_use_agent_description','legacy_rows_retained',true,'next_step','description_vector_index');
END $$;
REVOKE ALL ON FUNCTION mem.vector_register(uuid,text,text) FROM PUBLIC,hub2_worker,hub2_hufu,hub2_v8;
GRANT EXECUTE ON FUNCTION mem.vector_register(uuid,text,text) TO hub2_mem;
CREATE FUNCTION mem.description_maintenance(ref jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,mem AS $$
DECLARE v mem.content_versions;dr mem.agent_description_revisions;current_id uuid;maintenance text;
BEGIN
 SELECT cv.* INTO v FROM mem.content_versions cv WHERE cv.id=(ref->>'version_id')::uuid AND cv.material_id=(ref->>'material_id')::uuid AND cv.sha256=ref->>'sha256';
 IF v.id IS NULL THEN RAISE EXCEPTION 'fixed_reference_mismatch' USING ERRCODE='42501';END IF;
 SELECT current_version_id INTO current_id FROM mem.materials WHERE id=v.material_id;
 SELECT r.* INTO dr FROM mem.agent_description_heads dh JOIN mem.agent_description_revisions r ON r.version_id=dh.version_id AND r.revision=dh.revision WHERE dh.version_id=v.id;
 maintenance:=CASE WHEN v.id<>current_id OR mem.version_stale(v.id) THEN 'needs_update'
 WHEN dr.revision IS NULL OR dr.state<>'active' OR btrim(dr.text_content)='' THEN 'needs_update'
 WHEN NOT EXISTS(SELECT FROM mem.agent_description_vectors e WHERE e.version_id=v.id AND e.description_revision=dr.revision) THEN 'needs_index' ELSE 'current' END;
 RETURN jsonb_build_object('fixed_ref',ref,'current_version_id',current_id,'freshness',CASE WHEN current_id=v.id AND NOT mem.version_stale(v.id) THEN 'current' ELSE 'needs_refresh' END,'description_revision',coalesce(dr.revision,0),'maintenance',jsonb_build_object('state',maintenance,'description_state',CASE WHEN dr.revision IS NULL OR dr.state<>'active' OR btrim(dr.text_content)='' THEN 'needs_agent_description' ELSE 'ready' END));
END $$;
CREATE FUNCTION mem.description_publish_receipt(r jsonb) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog,mem AS $$
 SELECT CASE WHEN r->>'state'='published' AND jsonb_typeof(r->'fixed_refs')='array' THEN r||jsonb_build_object('description_maintenance',coalesce((SELECT jsonb_agg(mem.description_maintenance(ref)) FROM jsonb_array_elements(r->'fixed_refs')ref),'[]')) ELSE r END
$$;
ALTER FUNCTION mem.publish_upload(uuid,text,text) RENAME TO publish_upload_description_base;
ALTER FUNCTION mem.publish_text_upload(uuid,text,text) RENAME TO publish_text_upload_description_base;
REVOKE ALL ON FUNCTION mem.publish_upload_description_base(uuid,text,text),mem.publish_text_upload_description_base(uuid,text,text) FROM PUBLIC,hub2_mem,hub2_worker,hub2_hufu,hub2_v8;
CREATE FUNCTION mem.publish_upload(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE r jsonb;BEGIN r:=mem.description_publish_receipt(mem.publish_upload_description_base(h,d,payload));PERFORM authz.assert_effect(h);RETURN r;END $$;
CREATE FUNCTION mem.publish_text_upload(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE r jsonb;BEGIN r:=mem.description_publish_receipt(mem.publish_text_upload_description_base(h,d,payload));PERFORM authz.assert_effect(h);RETURN r;END $$;
REVOKE ALL ON FUNCTION mem.description_maintenance(jsonb),mem.description_publish_receipt(jsonb),mem.publish_upload(uuid,text,text),mem.publish_text_upload(uuid,text,text) FROM PUBLIC,hub2_mem,hub2_worker,hub2_hufu,hub2_v8;
GRANT EXECUTE ON FUNCTION mem.publish_upload(uuid,text,text),mem.publish_text_upload(uuid,text,text) TO hub2_mem;
RESET ROLE;
