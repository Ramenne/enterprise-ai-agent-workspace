-- Read a compact projection of the exact current authorized stage. No new table or history rewrite.
CREATE OR REPLACE FUNCTION v8.work_judgment_read(h uuid,d text,p text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog,v8 AS $fn$
DECLARE b jsonb;c jsonb;w record;u record;j jsonb;reason text;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;
 IF EXISTS(SELECT FROM jsonb_object_keys(b) k WHERE k NOT IN('project_id','work_item_id','expected_revision')) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 c:=v8.guard(h,'v8.work.read',d,b);
 SELECT * INTO w FROM v8.work_items WHERE id=(b->>'work_item_id')::uuid AND project_id=(c->>'project_id')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'work_not_found' USING ERRCODE='42501';END IF;
 IF w.revision IS DISTINCT FROM (b->>'expected_revision')::bigint THEN
  PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','pending','reason','view_revision_changed');
 END IF;
 SELECT * INTO u FROM v8.work_updates WHERE work_item_id=w.id AND work_revision=w.revision ORDER BY created_at DESC,id DESC LIMIT 1;
 IF NOT FOUND THEN PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','pending','reason','current_stage_not_declared');END IF;
 IF NOT v8.authorized_statement(h,c,u.payload) THEN PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','pending','reason','current_stage_restricted');END IF;
 IF encode(public.digest(u.canonical_text,'sha256'),'hex') IS DISTINCT FROM u.sha256 THEN RAISE EXCEPTION 'statement_integrity_mismatch' USING ERRCODE='XX001';END IF;
 j:=u.payload#>'{properties,work_judgment}';
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' THEN PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','pending','reason','work_boundary_not_assessed');END IF;
 -- Declared judgment shape is validated by the service. Return only its bounded known fields.
 reason:=j->>'reason';
 j:=jsonb_build_object('decision',j->'decision','reason',left(reason,600),'compared_work_ids',CASE WHEN jsonb_typeof(j->'compared_work_ids')='array' AND jsonb_array_length(j->'compared_work_ids')<=50 THEN j->'compared_work_ids' ELSE '[]'::jsonb END);
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','read','work_item_id',w.id,'work_revision',w.revision,'statement_id',u.id,'statement_sha256',u.sha256,'judgment',j,'reason_truncated',length(reason)>600,'coverage','exact_current_authorized_stage_judgment_only;not_full_report');
END $fn$;
REVOKE ALL ON FUNCTION v8.work_judgment_read(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.work_judgment_read(uuid,text,text) TO hub2_v8;
