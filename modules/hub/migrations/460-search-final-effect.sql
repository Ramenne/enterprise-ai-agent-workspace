SET ROLE hub2_mem_owner;
CREATE OR REPLACE FUNCTION mem.search_materials(h uuid,d text,payload text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;items jsonb:='[]';candidate record;maximum integer;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 IF (b->>'project_id')::uuid IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 maximum:=LEAST(500,GREATEST(1,COALESCE((b->>'limit')::integer,100)));
 FOR candidate IN SELECT m.id material_id,m.current_version_id version_id,m.content_revision,m.metadata_revision,p.logical_path FROM mem.materials m JOIN mem.placements p ON p.material_id=m.id AND p.active
  WHERE m.project_id=(c->>'project_id')::uuid AND m.state='active'
   AND (m.provenance_state<>'pending' OR EXISTS(SELECT 1 FROM mem.content_versions own WHERE own.id=m.current_version_id AND (own.actor_id=(c->>'actor_id')::uuid OR m.owner_id=(c->>'actor_id')::uuid)))
   AND m.current_version_id IS NOT NULL
   AND (COALESCE(b->>'query','')='' OR position(lower(b->>'query') IN lower(p.logical_path))>0 OR EXISTS(SELECT 1 FROM mem.text_index ti WHERE ti.version_id=m.current_version_id AND ti.recipe='zh-character-bigram-v1' AND ti.tokens @@ plainto_tsquery('simple',b->>'token_text')))
   AND m.properties @> COALESCE(b->'properties','{}') ORDER BY m.id LOOP
  IF mem.search_version_visible((c->>'actor_id')::uuid,candidate.version_id) THEN items:=items||jsonb_build_array(to_jsonb(candidate));IF jsonb_array_length(items)>=maximum THEN EXIT;END IF;END IF;
 END LOOP;
 PERFORM mem.bind_request_sources(h,jsonb_build_object('fixed_refs',items),(c->>'actor_id')::uuid,'mem.read');
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('items',items,'coverage','ranked_query_not_enumeration','recipe','literal-name-json-zh-character-bigram-v1','processing_pending',true);
END $$;
REVOKE ALL ON FUNCTION mem.search_materials(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.search_materials(uuid,text,text) TO hub2_mem;
RESET ROLE;
