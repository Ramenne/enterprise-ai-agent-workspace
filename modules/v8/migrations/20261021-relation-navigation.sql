BEGIN;
SET ROLE hub2_v8_owner;

-- Decorate the already-authorized result; never reimplement work_read or widen it.
CREATE OR REPLACE FUNCTION v8.relation_navigation(h uuid, raw jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE c jsonb;edge jsonb;entry jsonb;history jsonb;items jsonb:='[]';r v8.work_relations;
 from_work v8.work_items;to_work v8.work_items;seen uuid[];previous uuid;complete boolean;depth integer;budget integer:=256;
 part jsonb;bytes_left integer:=131072;
BEGIN
 IF raw->>'state' IS DISTINCT FROM 'read' OR jsonb_typeof(raw->'relations') IS DISTINCT FROM 'array' THEN RETURN raw;END IF;
 SELECT to_jsonb(i) INTO c FROM authz.effect_identity(h)i;
 c:=c||jsonb_build_object('project_id',raw->'work_item'->'project_id');
 FOR edge IN SELECT value FROM jsonb_array_elements(raw->'relations') LOOP
  entry:=edge;history:='[]';complete:=true;seen:=ARRAY[(edge->>'id')::uuid];depth:=0;
  SELECT * INTO from_work FROM v8.work_items WHERE id=(edge->>'from_work_id')::uuid;
  SELECT * INTO to_work FROM v8.work_items WHERE id=(edge->>'to_work_id')::uuid;
  -- Locate both endpoints only when each remains readable to this member.
  IF from_work.id IS NOT NULL AND to_work.id IS NOT NULL
    AND authz.can_read((c->>'actor_id')::uuid,from_work.project_id)
    AND authz.can_read((c->>'actor_id')::uuid,to_work.project_id) THEN
   entry:=entry||jsonb_build_object('from_project_id',from_work.project_id,'to_project_id',to_work.project_id,
     'from_short_no',from_work.short_no,'to_short_no',to_work.short_no);
  END IF;
  previous:=(edge->>'supersedes')::uuid;
  WHILE previous IS NOT NULL LOOP
   IF depth>=32 OR budget<=0 OR previous=ANY(seen) THEN complete:=false;EXIT;END IF;
   seen:=array_append(seen,previous);depth:=depth+1;budget:=budget-1;
   SELECT * INTO r FROM v8.work_relations WHERE id=previous AND from_work_id=(edge->>'from_work_id')::uuid;
   IF r.id IS NULL THEN complete:=false;EXIT;END IF;
   SELECT * INTO from_work FROM v8.work_items WHERE id=r.from_work_id;
   SELECT * INTO to_work FROM v8.work_items WHERE id=r.to_work_id;
   IF from_work.id IS NULL OR to_work.id IS NULL
    OR authz.can_read((c->>'actor_id')::uuid,from_work.project_id) IS DISTINCT FROM true
    OR authz.can_read((c->>'actor_id')::uuid,to_work.project_id) IS DISTINCT FROM true
    OR v8.authorized_statement(h,c,r.basis) IS DISTINCT FROM true THEN complete:=false;EXIT;END IF;
   part:=jsonb_build_object('id',r.id,'from_work_id',r.from_work_id,'to_work_id',r.to_work_id,
     'basis',r.basis,'state',r.state,'supersedes',r.supersedes,
     'from_project_id',from_work.project_id,'to_project_id',to_work.project_id,
     'from_short_no',from_work.short_no,'to_short_no',to_work.short_no);
   IF octet_length(part::text)>bytes_left THEN complete:=false;EXIT;END IF;
   bytes_left:=bytes_left-octet_length(part::text);history:=history||jsonb_build_array(part);
   previous:=r.supersedes;
  END LOOP;
  entry:=entry||jsonb_build_object('history',jsonb_build_object('items',history,'complete',complete,
    'scope','currently_authorized_predecessors','max_depth',32,
    'next',CASE WHEN NOT complete AND previous IS NOT NULL AND from_work.project_id IS NOT NULL
      AND authz.can_read((c->>'actor_id')::uuid,from_work.project_id) THEN
     jsonb_build_object('tool','v8.statement.read_chunk','arguments',jsonb_build_object('project_id',from_work.project_id,
       'kind','work_relation','statement_id',previous)) ELSE NULL END));
  items:=items||jsonb_build_array(entry);
 END LOOP;
 PERFORM authz.assert_effect(h);
 RETURN raw||jsonb_build_object('relations',items);
END $$;
REVOKE ALL ON FUNCTION v8.relation_navigation(uuid,jsonb) FROM PUBLIC,hub2_v8;

-- Preserve the complete installed read (including current wrappers and ACLs).
-- Refuse a second installation rather than stacking another wrapper.
DO $$BEGIN
 IF to_regprocedure('v8.work_read_before_relation_navigation_20261021(uuid,text,text)') IS NOT NULL THEN
  RAISE EXCEPTION 'relation_navigation_already_installed';
 END IF;
 IF NOT EXISTS(SELECT FROM pg_proc WHERE oid='v8.work_read(uuid,text,text)'::regprocedure
   AND prorettype='jsonb'::regtype AND prosecdef) THEN RAISE EXCEPTION 'work_read_contract_changed';END IF;
END$$;
ALTER FUNCTION v8.work_read(uuid,text,text) RENAME TO work_read_before_relation_navigation_20261021;
CREATE FUNCTION v8.work_read(h uuid,d text,p text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE raw jsonb;BEGIN
 raw:=v8.work_read_before_relation_navigation_20261021(h,d,p);
 RETURN v8.relation_navigation(h,raw);
END $$;
REVOKE ALL ON FUNCTION v8.work_read(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.work_read(uuid,text,text) TO hub2_v8;
RESET ROLE;
COMMIT;
