BEGIN;
SET ROLE hub2_v8_owner;
DO $$BEGIN IF md5((SELECT prosrc FROM pg_proc WHERE oid='v8.related_candidates(uuid,text,text)'::regprocedure)) <> 'cff8e32107c04cb77699b0ed8945b0b6' THEN RAISE EXCEPTION 'related_candidates_source_changed_review_required'; END IF;END$$;
CREATE OR REPLACE FUNCTION v8.related_candidates(h uuid, d text, p text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'v8'
AS $function$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); ref jsonb;
BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.work.related_candidates',d,b);
FOR ref IN SELECT value FROM jsonb_array_elements(coalesce(b->'fixed_refs','[]'::jsonb)) LOOP PERFORM v8.assert_ref(c,ref);END LOOP;
 SELECT COALESCE(jsonb_agg(to_jsonb(candidate_row)),'[]') INTO r FROM (
 SELECT w.id AS work_item_id,w.short_no,w.goal,w.revision,
 EXISTS(SELECT 1 FROM v8.results rr JOIN jsonb_array_elements(coalesce(b->'fixed_refs','[]'::jsonb)) f ON rr.material_id=(f->>'material_id')::uuid AND rr.version_id=(f->>'version_id')::uuid AND rr.sha256=f->>'sha256' WHERE rr.work_item_id=w.id AND mem.version_visible((c->>'actor_id')::uuid,rr.version_id)) AS shared_fixed_reference,
 EXISTS(SELECT 1 FROM v8.work_relations rel WHERE ((rel.from_work_id=w.id AND rel.to_work_id=(b->>'work_item_id')::uuid) OR (rel.to_work_id=w.id AND rel.from_work_id=(b->>'work_item_id')::uuid)) AND rel.state IN ('active','corrected') AND NOT EXISTS(SELECT 1 FROM v8.work_relations n WHERE n.supersedes=rel.id AND n.from_work_id=rel.from_work_id)) AS direct_relation
 FROM v8.work_items w WHERE w.project_id=(c->>'project_id')::uuid AND w.id IS DISTINCT FROM (b->>'work_item_id')::uuid AND authz.can_read((c->>'actor_id')::uuid,w.project_id)
 AND (b->>'since' IS NULL OR w.created_at>=(b->>'since')::timestamptz) AND (b->>'until' IS NULL OR w.created_at<=(b->>'until')::timestamptz)
 AND (jsonb_array_length(coalesce(b->'participants','[]'::jsonb))=0 OR w.actor_id IN(SELECT value::uuid FROM jsonb_array_elements_text(coalesce(b->'participants','[]'::jsonb))))
 AND (COALESCE(b->>'query','')='' OR w.goal ILIKE '%'||(b->>'query')||'%')
 ORDER BY shared_fixed_reference DESC,direct_relation DESC,w.updated_at DESC,w.id LIMIT LEAST(COALESCE((b->>'limit')::integer,10),50) OFFSET COALESCE((b->>'cursor')::integer,0)) candidate_row;
 PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','candidates','items',r,'next_cursor',CASE WHEN jsonb_array_length(r)=COALESCE((b->>'limit')::integer,10) THEN COALESCE((b->>'cursor')::integer,0)+jsonb_array_length(r) ELSE NULL END,'coverage','current_authorized_candidates','next_step','agent_select_and_supply_direct_basis');
END $function$;
REVOKE ALL ON FUNCTION v8.related_candidates(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.related_candidates(uuid,text,text) TO hub2_v8;
RESET ROLE;
COMMIT;
