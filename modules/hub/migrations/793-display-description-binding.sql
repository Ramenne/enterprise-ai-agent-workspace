BEGIN;
SET ROLE hub2_mem_owner;
DO $patch$
DECLARE s text;
BEGIN
 s:=pg_get_functiondef('mem.material_display_info(uuid,jsonb,jsonb)'::regprocedure);
 s:=replace(s,'mem.description_bind_sources(h,coalesce(mem.description_revision_refs(v.id,dr.revision),''[]''),(c->>''actor_id'')::uuid,''mem.read'')','mem.description_bind_sources(h,coalesce(mem.description_revision_refs(v.id,dr.revision),''[]''),(c->>''actor_id'')::uuid)');
 s:=replace(s,'SELECT EXISTS(SELECT FROM mem.agent_description_vectors','SELECT dr.state=''active'' AND EXISTS(SELECT FROM mem.agent_description_vectors');EXECUTE s;
END $patch$;
RESET ROLE;
COMMIT;
