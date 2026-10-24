BEGIN;
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.material_display_info(h uuid,c jsonb,item jsonb)RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,mem AS $$
DECLARE m mem.materials;v mem.content_versions;p mem.storage_primary_locations;t mem.storage_tier_copies;dr mem.agent_description_revisions;dh mem.agent_description_heads;writable boolean:=false;intro jsonb;indexed boolean:=false;restore_state text;
BEGIN
 SELECT *INTO m FROM mem.materials WHERE id=(item->>'material_id')::uuid;SELECT *INTO v FROM mem.content_versions WHERE id=(item->>'version_id')::uuid;
 IF m.id IS NULL OR v.id IS NULL THEN RETURN item;END IF;
 BEGIN PERFORM authz.resource_deadline((c->>'actor_id')::uuid,(c->>'client_id')::uuid,m.project_id,'mem.write',jsonb_build_object('project_id',m.project_id,'material_id',m.id));writable:=true;EXCEPTION WHEN insufficient_privilege THEN writable:=false;END;
 SELECT *INTO p FROM mem.storage_primary_locations WHERE version_id=v.id;SELECT *INTO t FROM mem.storage_tier_copies WHERE copy_id=p.copy_id;
 SELECT state INTO restore_state FROM mem.storage_tier_operations WHERE version_id=v.id AND command='restore'ORDER BY created_at DESC,id DESC LIMIT 1;
 SELECT *INTO dh FROM mem.agent_description_heads WHERE version_id=v.id;SELECT *INTO dr FROM mem.agent_description_revisions WHERE version_id=v.id AND revision=dh.revision;
 IF dr.version_id IS NOT NULL THEN
  BEGIN
   PERFORM mem.description_bind_sources(h,coalesce(mem.description_revision_refs(v.id,dr.revision),'[]'),(c->>'actor_id')::uuid,'mem.read');
   intro:=jsonb_build_object('state',dr.state,'text',left(dr.text_content,6000),'revision',dr.revision,'truncated',length(dr.text_content)>6000);
   SELECT EXISTS(SELECT FROM mem.agent_description_vectors WHERE version_id=v.id AND description_revision=dr.revision AND description_sha256=dr.text_sha256)INTO indexed;
  EXCEPTION WHEN insufficient_privilege THEN intro:=jsonb_build_object('state','restricted');END;
 ELSE intro:=jsonb_build_object('state','missing');END IF;
 RETURN item||jsonb_build_object('file_no',m.file_no::text,'importance_level',m.importance_level,'file_format',m.file_format,'created_at',m.created_at,'version_created_at',v.created_at,'can_write',writable,'description',intro,'index_state',CASE WHEN m.importance_level=3 THEN 'not_required'WHEN intro->>'state'='restricted'THEN 'restricted'WHEN m.importance_level IS NULL THEN 'unassessed'WHEN indexed THEN 'indexed'WHEN dr.version_id IS NULL THEN 'missing_description'ELSE 'pending_index'END,'storage',jsonb_build_object('primary_tier',CASE WHEN p.basis LIKE 'standard_copy:%'THEN 'standard'ELSE coalesce(t.tier,'standard')END,'restore_state',restore_state,'basis','registered_primary_location','retirement_state',(SELECT state FROM mem.storage_physical_retirements WHERE operation_id=p.operation_id)));
END $$;
REVOKE ALL ON FUNCTION mem.material_display_info(uuid,jsonb,jsonb)FROM PUBLIC;
DO $patch$
DECLARE s text;
BEGIN
 s:=pg_get_functiondef('mem.enumeration_page(uuid,text,text)'::regprocedure);
 s:=replace(s,'PERFORM mem.bind_request_sources(h,jsonb_build_object(''fixed_refs'',items),(c->>''actor_id'')::uuid,''mem.read'');','PERFORM mem.bind_request_sources(h,jsonb_build_object(''fixed_refs'',items),(c->>''actor_id'')::uuid,''mem.read''); SELECT coalesce(jsonb_agg(mem.material_display_info(h,c,value)ORDER BY ordinality),''[]'')INTO items FROM jsonb_array_elements(items)WITH ORDINALITY;');
 EXECUTE s;
END $patch$;
RESET ROLE;
COMMIT;
