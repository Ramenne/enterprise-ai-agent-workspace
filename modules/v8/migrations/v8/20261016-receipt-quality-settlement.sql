SET ROLE hub2_v8_owner;
DO $patch$
DECLARE body text;
BEGIN
 body:=pg_get_functiondef('v8.board_call(text,text,jsonb,text)'::regprocedure);
 IF position('quality_after_base_v1' in body)=0 THEN
  IF position($old$    IF EXISTS(SELECT FROM v8.points_entries WHERE claim_id=cl.id AND category='base') THEN RAISE EXCEPTION 'claim_already_settled' USING ERRCODE='23505';END IF;
    eid:=v8.board_entry(org,member,cfg.debtor_id,t.id,cl.id,rc.id,'base',base,cash,0,actor,client,coalesce(b->>'note',''));
    IF bonus>0 THEN PERFORM v8.board_entry(org,member,cfg.debtor_id,t.id,cl.id,rc.id,'quality',bonus,0,0,actor,client,coalesce(b->>'note',''));END IF;$old$ in body)=0 THEN RAISE EXCEPTION 'award_source_changed';END IF;
  body:=replace(body,$old$    IF EXISTS(SELECT FROM v8.points_entries WHERE claim_id=cl.id AND category='base') THEN RAISE EXCEPTION 'claim_already_settled' USING ERRCODE='23505';END IF;
    eid:=v8.board_entry(org,member,cfg.debtor_id,t.id,cl.id,rc.id,'base',base,cash,0,actor,client,coalesce(b->>'note',''));
    IF bonus>0 THEN PERFORM v8.board_entry(org,member,cfg.debtor_id,t.id,cl.id,rc.id,'quality',bonus,0,0,actor,client,coalesce(b->>'note',''));END IF;$old$,$new$    -- quality_after_base_v1: base uniqueness does not forbid a later supervisor bonus.
    eid:=NULL;
    IF base+cash>0 THEN
     IF EXISTS(SELECT FROM v8.points_entries WHERE claim_id=cl.id AND category='base') THEN RAISE EXCEPTION 'claim_already_settled' USING ERRCODE='23505';END IF;
     eid:=v8.board_entry(org,member,cfg.debtor_id,t.id,cl.id,rc.id,'base',base,cash,0,actor,client,coalesce(b->>'note',''));
    END IF;
    IF bonus>0 THEN
     IF eid IS NULL THEN eid:=v8.board_entry(org,member,cfg.debtor_id,t.id,cl.id,rc.id,'quality',bonus,0,0,actor,client,coalesce(b->>'note',''));
     ELSE PERFORM v8.board_entry(org,member,cfg.debtor_id,t.id,cl.id,rc.id,'quality',bonus,0,0,actor,client,coalesce(b->>'note',''));END IF;
    END IF;$new$);
 END IF;
 IF position('current_claim_ledger;not_per_receipt_payment' in body)=0 THEN
  IF position($old$SELECT rr.* FROM v8.board_receipts rr JOIN v8.board_tasks tt ON tt.id=rr.task_id$old$ in body)=0 THEN RAISE EXCEPTION 'receipts_source_changed';END IF;
  body:=replace(body,$old$SELECT rr.* FROM v8.board_receipts rr JOIN v8.board_tasks tt ON tt.id=rr.task_id$old$,$new$SELECT rr.*,
     (SELECT jsonb_build_object('scope','current_claim_ledger;not_per_receipt_payment',
       'base_posted',count(*) FILTER(WHERE e.category='base')>0,
       'base_points_cents',coalesce(sum(e.debt_delta_cents) FILTER(WHERE e.category='base'),0),
       'quality_points_cents',coalesce(sum(e.debt_delta_cents) FILTER(WHERE e.category='quality'),0),
       'debt_cents',coalesce(sum(e.debt_delta_cents),0),
       'cash_due_cents',coalesce(sum(e.cash_due_delta_cents),0),
       'cash_paid_cents',coalesce(sum(e.cash_paid_delta_cents),0))
      FROM v8.points_entries e WHERE e.organization_id=rr.organization_id AND e.claim_id=rr.claim_id) AS settlement
    FROM v8.board_receipts rr JOIN v8.board_tasks tt ON tt.id=rr.task_id$new$);
 END IF;
 EXECUTE body;
END $patch$;
RESET ROLE;
