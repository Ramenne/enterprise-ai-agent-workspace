SET ROLE hub2_v8_owner;
-- Stateless projection: no new task, state, receipt or money tables.
CREATE OR REPLACE FUNCTION v8.member_work_read(proof text,op text,b jsonb,service_proof text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE i jsonb;actor uuid;org uuid;member uuid;manager boolean;lim int;cur text;items jsonb:='[]';r record;n int:=0;lastkey text;more boolean:=false;c v8.board_claims;t v8.board_tasks;receipt jsonb;rev bigint;
BEGIN
 IF op NOT IN('list','detail','activity') THEN RAISE EXCEPTION 'unknown_operation' USING ERRCODE='22023';END IF;
 IF service_proof IS NULL THEN i:=authz.board_identity(proof,false,false);ELSE i:=authz.taskhall_service_context(service_proof,proof,'member_work_read');END IF;actor:=(i->>'actor_id')::uuid;org:=(i->>'organization_id')::uuid;manager:=i->>'role'='organization_admin';member:=coalesce((b->>'member_id')::uuid,actor);
 IF member<>actor AND NOT manager AND NOT coalesce((i->>'named_member_scope')::boolean,false) THEN RAISE EXCEPTION 'member_scope_forbidden' USING ERRCODE='42501';END IF;
 PERFORM authz.board_member(org,member);lim:=coalesce((b->>'limit')::int,30);cur:=coalesce(b->>'cursor','');
 IF lim NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_limit' USING ERRCODE='22023';END IF;
 IF op='list' THEN
  FOR r IN WITH claims AS (
   SELECT cc.*,tt.title,tt.project_id,tt.work_item_id,tt.state publication_state,tt.revision current_task_revision,rr.declared_state,rr.id receipt_id,rr.created_at receipt_at,(SELECT count(*) FROM v8.board_receipts rc WHERE rc.claim_id=cc.id) receipt_count
   FROM v8.board_claims cc JOIN v8.board_tasks tt ON tt.id=cc.task_id
   LEFT JOIN LATERAL(SELECT rc.* FROM v8.board_receipts rc WHERE rc.claim_id=cc.id AND NOT EXISTS(SELECT FROM v8.board_receipts newer WHERE newer.supersedes_id=rc.id) ORDER BY rc.created_at DESC,rc.id DESC LIMIT 1)rr ON true
   WHERE cc.organization_id=org AND (NOT coalesce((i->>'named_member_scope')::boolean,false) OR tt.project_id IS NULL OR authz.can_read(actor,tt.project_id)) AND cc.member_id=member AND (coalesce((b->>'include_history')::boolean,false) OR tt.state='published') AND (b->>'project_id' IS NULL OR tt.project_id=(b->>'project_id')::uuid)
  ), projected AS (
   SELECT 'board:'||cl.id k,coalesce(cl.declared_state,'no_receipt') s,jsonb_build_object('ref',jsonb_build_object('source','board','id',cl.id,'task_id',cl.task_id),'member_id',member,'role','claimant','title',cl.title,'project_id',cl.project_id,'publication_state',cl.publication_state,'declared_state',cl.declared_state,'progress_basis',CASE WHEN cl.receipt_id IS NULL THEN 'no_receipt;actual_progress_unknown' ELSE 'member_receipt_declaration' END,'latest_receipt_id',cl.receipt_id,'source_revision',cl.current_task_revision+cl.receipt_count,'updated_at',coalesce(cl.receipt_at,cl.claimed_at),'linked_work',CASE WHEN cl.work_item_id IS NOT NULL THEN jsonb_build_object('source','v8','id',cl.work_item_id,'project_id',cl.project_id) ELSE NULL END) data FROM claims cl
   UNION ALL
   SELECT 'v8:'||w.id,w.state,jsonb_build_object('ref',jsonb_build_object('source','v8','id',w.id,'project_id',w.project_id),'member_id',member,'role','registered_author','execution_attribution','not_inferred','title',w.goal,'project_id',w.project_id,'engineering_state',w.state,'source_revision',w.revision,'updated_at',w.updated_at)
   FROM v8.work_items w JOIN v8.projects p ON p.id=w.project_id WHERE w.actor_id=member AND p.organization_id=org AND authz.can_read(actor,p.id) AND (coalesce((b->>'include_history')::boolean,false) OR (p.state='active' AND coalesce(p.properties#>>'{governance,purpose}','unknown') NOT IN('test','migrated_history') AND coalesce(p.properties#>>'{governance,lifecycle}','active')<>'archive'))
    AND(b->>'project_id' IS NULL OR w.project_id=(b->>'project_id')::uuid) AND NOT EXISTS(SELECT FROM claims cl WHERE cl.work_item_id=w.id)
  ) SELECT * FROM projected WHERE k>cur AND (b->>'state' IS NULL OR s=b->>'state') ORDER BY k LIMIT lim+1 LOOP
   IF n=lim THEN more:=true;EXIT;END IF;items:=items||jsonb_build_array(r.data);lastkey:=r.k;n:=n+1;
  END LOOP;
  RETURN jsonb_build_object('state','read','items',items,'next_cursor',CASE WHEN more THEN lastkey ELSE NULL END,'coverage','current_authorized_registered_claims_and_authored_work;not_all_actual_activity','observed_at',clock_timestamp(),'authority','source_records;read_only_projection');
 END IF;
 SELECT * INTO c FROM v8.board_claims WHERE id=(b->'ref'->>'id')::uuid AND organization_id=org;
 IF c.id IS NULL THEN RAISE EXCEPTION 'work_not_found' USING ERRCODE='22023';END IF;
 IF c.member_id<>actor AND NOT manager AND NOT coalesce((i->>'named_member_scope')::boolean,false) THEN RAISE EXCEPTION 'member_scope_forbidden' USING ERRCODE='42501';END IF;
 IF b->>'member_id' IS NOT NULL AND c.member_id<>member THEN RAISE EXCEPTION 'member_scope_mismatch' USING ERRCODE='22023';END IF;
 SELECT * INTO t FROM v8.board_tasks WHERE id=c.task_id;
 IF coalesce((i->>'named_member_scope')::boolean,false) AND (t.id IS NULL OR (t.project_id IS NOT NULL AND NOT authz.can_read(actor,t.project_id))) THEN RAISE EXCEPTION 'task_scope_forbidden' USING ERRCODE='42501';END IF;
 SELECT to_jsonb(rr) INTO receipt FROM v8.board_receipts rr WHERE rr.claim_id=c.id AND NOT EXISTS(SELECT FROM v8.board_receipts newer WHERE newer.supersedes_id=rr.id) ORDER BY rr.created_at DESC,rr.id DESC LIMIT 1;
 SELECT t.revision+count(*) INTO rev FROM v8.board_receipts WHERE claim_id=c.id;
 IF op='detail' THEN RETURN jsonb_build_object('state','read','ref',jsonb_build_object('source','board','id',c.id,'task_id',t.id),'task',to_jsonb(t),'claim',to_jsonb(c),'latest_receipt',receipt,'source_revision',rev,'progress_basis','member_receipt_declaration;no_review_gate','maintenance_owners',jsonb_build_object('definition','board_tasks','claim','board_claims','declaration','board_receipts','understanding','xingxiu'),'observed_at',clock_timestamp());END IF;
 FOR r IN SELECT * FROM (
  SELECT to_char(c.claimed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')||':'||c.id k,jsonb_build_object('kind','claim','ref',jsonb_build_object('source','board_claims','id',c.id),'record',to_jsonb(c)) data
  UNION ALL SELECT to_char(rr.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')||':'||rr.id,jsonb_build_object('kind',CASE WHEN rr.supersedes_id IS NULL THEN 'receipt' ELSE 'receipt_correction' END,'ref',jsonb_build_object('source','board_receipts','id',rr.id),'record',to_jsonb(rr)) FROM v8.board_receipts rr WHERE rr.claim_id=c.id
 ) x WHERE k>cur ORDER BY k LIMIT lim+1 LOOP
  IF n=lim THEN more:=true;EXIT;END IF;items:=items||jsonb_build_array(r.data);lastkey:=r.k;n:=n+1;
 END LOOP;
 RETURN jsonb_build_object('state','read','items',items,'next_cursor',CASE WHEN more THEN lastkey ELSE NULL END,'coverage','claim_and_original_receipts;linked_engineering_history_via_linked_ref','observed_at',clock_timestamp());
END $$;
REVOKE ALL ON FUNCTION v8.member_work_read(text,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.member_work_read(text,text,jsonb,text) TO hub2_v8;
CREATE OR REPLACE FUNCTION v8.member_work_read(proof text,op text,b jsonb) RETURNS jsonb
LANGUAGE SQL SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$SELECT v8.member_work_read(proof,op,b,NULL::text)$$;
REVOKE ALL ON FUNCTION v8.member_work_read(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.member_work_read(text,text,jsonb) TO hub2_v8;
RESET ROLE;
