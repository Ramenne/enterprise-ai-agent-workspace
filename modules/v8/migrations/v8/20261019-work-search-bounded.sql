-- Preserve the actual installed wrappers and all unrelated source statements.
SET ROLE hub2_v8_owner;
DO $migration$ DECLARE target record;definition text;needle text;replacement text;BEGIN
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='v8' AND position('stage_summary:=NULL;stage_match:=false;stage_refs' in p.prosrc)>0 AND position('IF n=lim THEN more:=true;EXIT;END IF;' in p.prosrc)>0)<>1 THEN RAISE EXCEPTION 'work_search_unique_core_precondition_failed';END IF;
 SELECT p.oid,pg_get_functiondef(p.oid) AS definition INTO STRICT target FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='v8' AND position('stage_summary:=NULL;stage_match:=false;stage_refs' in p.prosrc)>0 AND position('IF n=lim THEN more:=true;EXIT;END IF;' in p.prosrc)>0;
 definition:=target.definition;
 needle:=$old$n integer:=0;lim integer;$old$;replacement:=$new$n integer:=0;scanned integer:=0;lim integer;$new$;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'work_search_fragment_changed_review_required';END IF;
 definition:=replace(definition,needle,replacement);
needle:=$old$number_match bigint;$old$;replacement:=$new$number_match numeric;$new$;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'work_search_fragment_changed_review_required';END IF;
 definition:=replace(definition,needle,replacement);
needle:=$old$regexp_replace(q,'^(W-|#)','','i')::bigint$old$;replacement:=$new$regexp_replace(q,'^(W-|#)','','i')::numeric$new$;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'work_search_fragment_changed_review_required';END IF;
 definition:=replace(definition,needle,replacement);
needle:=$old$ORDER BY w.id LOOP$old$;replacement:=$new$ORDER BY w.id LIMIT 101 LOOP
  IF scanned=100 THEN more:=true;EXIT;END IF;
  scanned:=scanned+1;last_id:=item.id;$new$;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'work_search_fragment_changed_review_required';END IF;
 definition:=replace(definition,needle,replacement);
needle:=$old$IF n=lim THEN more:=true;EXIT;END IF;
  n:=n+1;last_id:=item.id;$old$;replacement:=$new$n:=n+1;$new$;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'work_search_fragment_changed_review_required';END IF;
 definition:=replace(definition,needle,replacement);
needle:=$old$ORDER BY u.work_revision DESC LOOP$old$;replacement:=$new$ORDER BY u.created_at DESC,u.id DESC LOOP$new$;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'work_search_fragment_changed_review_required';END IF;
 definition:=replace(definition,needle,replacement);
needle:=$old$'work_revision',note.work_revision,'update_id'$old$;replacement:=$new$'work_revision',note.work_revision,'created_at',note.created_at,'update_id'$new$;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'work_search_fragment_changed_review_required';END IF;
 definition:=replace(definition,needle,replacement);
needle:=$old$ END LOOP;
 SELECT coalesce(jsonb_agg(value),'[]')INTO page_refs$old$;replacement:=$new$  IF n=lim THEN
   SELECT EXISTS(SELECT 1 FROM v8.work_items WHERE project_id=(c->>'project_id')::uuid AND id>last_id) INTO more;
   EXIT;
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value),'[]')INTO page_refs$new$;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'work_search_fragment_changed_review_required';END IF;
 definition:=replace(definition,needle,replacement);
needle:=$old$'returned_count',n,$old$;replacement:=$new$'returned_count',n,'scanned_count',scanned,$new$;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'work_search_fragment_changed_review_required';END IF;
 definition:=replace(definition,needle,replacement);
 EXECUTE definition;
END $migration$;
RESET ROLE;
SET ROLE hub2_v8_owner;
CREATE INDEX IF NOT EXISTS work_search_project_order ON v8.work_items(project_id,id);
CREATE INDEX IF NOT EXISTS work_search_stage_recent ON v8.work_updates(work_item_id,created_at DESC,id DESC);
RESET ROLE;
