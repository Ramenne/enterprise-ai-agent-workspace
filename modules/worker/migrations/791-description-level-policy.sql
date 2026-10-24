BEGIN;
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.description_index_eligible(mid uuid)RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,mem AS $$SELECT coalesce(importance_level IN(1,2),false)FROM mem.materials WHERE id=mid$$;
REVOKE ALL ON FUNCTION mem.description_index_eligible(uuid)FROM PUBLIC;
DO $patch$
DECLARE s text;
BEGIN
 s:=pg_get_functiondef('mem.description_vector_register(uuid,text,text)'::regprocedure);
 s:=replace(s,'IF (m.properties #>> ''{governance,important}'') IS DISTINCT FROM ''true'' THEN','IF NOT mem.description_index_eligible(m.id) THEN');
 s:=replace(s,'importance_not_marked_by_Agent','importance_level_1_or_2_required');EXECUTE s;
 s:=pg_get_functiondef('mem.description_vector_search(uuid,text,text)'::regprocedure);
 s:=replace(s,'(m.properties #>> ''{governance,important}'') IS DISTINCT FROM ''false''','mem.description_index_eligible(m.id)');
 s:=replace(s,'explicit_unimportant_excluded;legacy_unassessed_indices_retained_for_review','levels_1_and_2_only;level_3_and_unassessed_vectors_retained_but_not_searched');EXECUTE s;
END $patch$;
RESET ROLE;
COMMIT;
