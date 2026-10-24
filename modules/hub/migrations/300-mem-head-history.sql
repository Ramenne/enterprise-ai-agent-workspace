-- Original latest-at-request navigation. Fixed references remain immutable.
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.material_head(h uuid,d text,payload text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;m mem.materials;v mem.content_versions;result jsonb;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 IF b-'project_id'-'material_id'<>'{}'::jsonb OR b->>'material_id' IS NULL THEN RAISE EXCEPTION 'invalid_input';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 SELECT * INTO m FROM mem.materials WHERE id=(b->>'material_id')::uuid AND project_id=(c->>'project_id')::uuid;
 IF m.id IS NULL OR (m.current_version_id IS NULL AND m.owner_id IS DISTINCT FROM (c->>'actor_id')::uuid) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF m.current_version_id IS NOT NULL THEN
  SELECT * INTO v FROM mem.content_versions WHERE id=m.current_version_id AND material_id=m.id;
  IF v.id IS NULL THEN RAISE EXCEPTION 'fixed_reference_missing';END IF;
  PERFORM mem.assert_version_sources(h,v.id,'mem.read');
 END IF;
 result:=jsonb_build_object('state',CASE WHEN m.state='trashed' THEN 'trashed' WHEN v.id IS NULL THEN 'unpublished' ELSE 'available' END,
   'material_id',m.id,'content_revision',m.content_revision,'metadata_revision',m.metadata_revision,'event_revision',m.event_revision,
   'fixed_ref',CASE WHEN v.id IS NULL THEN NULL ELSE jsonb_build_object('material_id',m.id,'version_id',v.id,'sha256',v.sha256,'size',v.size) END,
   'selection','latest_at_request','source_stale',CASE WHEN v.id IS NULL THEN false ELSE mem.version_stale(v.id) END,
   'coverage','current_authorized_material_head','observed_at',clock_timestamp());
 PERFORM authz.assert_effect(h);RETURN result;
END $$;
CREATE FUNCTION mem.material_history(h uuid,d text,payload text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;m mem.materials;before_no bigint;n integer;items jsonb;entry record;next_id uuid;more boolean;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 IF b-'project_id'-'material_id'-'cursor'-'limit'<>'{}'::jsonb OR b->>'material_id' IS NULL THEN RAISE EXCEPTION 'invalid_input';END IF;
 n:=COALESCE((b->>'limit')::integer,50);IF n NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_limit';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 SELECT * INTO m FROM mem.materials WHERE id=(b->>'material_id')::uuid AND project_id=(c->>'project_id')::uuid;
 IF m.id IS NULL OR (m.current_version_id IS NULL AND m.owner_id IS DISTINCT FROM (c->>'actor_id')::uuid) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF b->>'cursor' IS NOT NULL THEN
  SELECT version_no INTO before_no FROM mem.content_versions WHERE id=(b->>'cursor')::uuid AND material_id=m.id;
  IF before_no IS NULL THEN RAISE EXCEPTION 'invalid_cursor';END IF;
 END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.version_ordinal DESC),'[]') INTO items FROM (
   SELECT id version_id,material_id,sha256,size,version_no version_ordinal,created_at,provenance_state,
     mem.version_stale(id) source_stale,(id=m.current_version_id) is_current
   FROM mem.content_versions WHERE material_id=m.id AND (before_no IS NULL OR version_no<before_no)
     AND mem.version_visible((c->>'actor_id')::uuid,id) ORDER BY version_no DESC LIMIT n+1
 ) x;
 more:=jsonb_array_length(items)>n;
 IF more THEN items:=items-(-1);next_id:=(items->-1->>'version_id')::uuid;END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(items) LOOP PERFORM mem.assert_version_sources(h,(entry.value->>'version_id')::uuid,'mem.read');END LOOP;
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','available','material_id',m.id,'items',items,'returned_count',jsonb_array_length(items),'next_cursor',next_id,
   'coverage','current_authorized_history_page','version_ordinal','native_order_not_legacy_version_number','snapshot_complete',false);
END $$;
REVOKE ALL ON FUNCTION mem.material_head(uuid,text,text),mem.material_history(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.material_head(uuid,text,text),mem.material_history(uuid,text,text) TO hub2_mem;
RESET ROLE;
