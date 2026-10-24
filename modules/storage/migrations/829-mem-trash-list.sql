SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.trash_list(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;items jsonb;n integer:=coalesce((b->>'limit')::integer,200);more boolean;cursor_id uuid;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 IF b-ARRAY['project_id','cursor','limit']<>'{}'::jsonb OR n NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_input';END IF;
 c:=mem.guard(h,'mem.read',d,b);
 SELECT coalesce(jsonb_agg(to_jsonb(x)ORDER BY x.material_id),'[]')INTO items FROM(
 SELECT m.id material_id,m.project_id,m.current_version_id version_id,v.sha256,v.size,m.event_revision,m.state,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('placement_id',p.id,'logical_path',p.logical_path,'revision',p.revision)),'[]')FROM mem.placements p WHERE p.material_id=m.id AND p.project_id=m.project_id)placements
 FROM mem.materials m JOIN mem.content_versions v ON v.id=m.current_version_id
 WHERE m.project_id=(c->>'project_id')::uuid AND m.state='trashed'AND(b->>'cursor'IS NULL OR m.id>(b->>'cursor')::uuid)
 AND mem.version_visible((c->>'actor_id')::uuid,m.current_version_id)
 AND authz.can_read_resource((c->>'actor_id')::uuid,m.project_id,jsonb_build_object('project_id',m.project_id,'material_id',m.id))
 ORDER BY m.id LIMIT n+1)x;
 more:=jsonb_array_length(items)>n;IF more THEN items:=items-(-1);cursor_id:=(items->-1->>'material_id')::uuid;END IF;
 PERFORM mem.bind_request_sources(h,jsonb_build_object('fixed_refs',items),(c->>'actor_id')::uuid,'mem.read');PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','read','items',items,'next_cursor',cursor_id,'returned_count',jsonb_array_length(items),'coverage','current_authorized_trash_page','physical_delete',false);
END $$;
REVOKE ALL ON FUNCTION mem.trash_list(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.trash_list(uuid,text,text)TO hub2_mem;
RESET ROLE;
