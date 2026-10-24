BEGIN;
SET LOCAL ROLE hub2_mem_owner;
CREATE FUNCTION mem.material_classification_pending(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;n integer:=coalesce((b->>'limit')::integer,20);raw_items jsonb;items jsonb;next_no text;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d OR n NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_input';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY file_no),'[]'::jsonb) INTO raw_items FROM (
 SELECT m.file_no,m.id material_id,m.current_version_id version_id,m.properties,m.metadata_revision
 FROM mem.materials m WHERE m.project_id=(c->>'project_id')::uuid AND m.state='active' AND m.importance_level IS NULL
 AND m.file_no>coalesce((b->>'after_file_no')::bigint,0) ORDER BY m.file_no LIMIT n)x;
 SELECT coalesce(jsonb_agg(x ORDER BY (x->>'file_no')::bigint),'[]'::jsonb) INTO items FROM jsonb_array_elements(raw_items)x
 WHERE mem.version_visible((c->>'actor_id')::uuid,(x->>'version_id')::uuid);
 IF jsonb_array_length(raw_items)=n THEN next_no:=raw_items->(n-1)->>'file_no';END IF;
 RETURN jsonb_build_object('state','classification_pending','project_id',c->>'project_id','items',items,'next_after_file_no',next_no,
 'levels',jsonb_build_array('special','1','2','3'),'assessment','Agent_or_member_reads_content_and_records_level_reason_and_coverage;special_requires_explicit_human_instruction',
 'coverage','bounded_unclassified_metadata;source_permissions_filtered;cursor_may_advance_over_hidden_items','original_access_blocked',false,'storage_independent',true);
END $$;
REVOKE ALL ON FUNCTION mem.material_classification_pending(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.material_classification_pending(uuid,text,text) TO hub2_mem;
RESET ROLE;
COMMIT;
