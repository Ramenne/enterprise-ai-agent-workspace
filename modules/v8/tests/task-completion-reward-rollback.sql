BEGIN;
SET ROLE hub2_v8_owner;
-- Only the authenticated completion path calls this internal function.
-- Amounts come from the supervisor-confirmed claim snapshot, never receipt input.
CREATE OR REPLACE FUNCTION v8.board_complete_reward(claim uuid,receipt uuid,actor uuid,client uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,v8 AS $reward$
DECLARE c v8.board_claims; t v8.board_tasks; r v8.board_receipts; cfg v8.board_settings;
 a v8.points_accounts; base bigint; cash bigint; eid uuid;
BEGIN
 SELECT * INTO c FROM v8.board_claims WHERE id=claim;
 IF c.id IS NULL THEN RAISE EXCEPTION 'claim_not_found' USING ERRCODE='22023'; END IF;
 SELECT * INTO t FROM v8.board_tasks WHERE id=c.task_id FOR UPDATE;
 SELECT * INTO c FROM v8.board_claims WHERE id=claim FOR UPDATE;
 SELECT * INTO r FROM v8.board_receipts WHERE id=receipt AND claim_id=c.id AND task_id=t.id
   AND organization_id=c.organization_id AND member_id=c.member_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'matching_receipt_required' USING ERRCODE='22023'; END IF;
 IF c.participation_role<>'owner' OR r.declared_state<>'completed' THEN
  RETURN jsonb_build_object('state','not_applicable');
 END IF;
 IF t.completion_receipt_id IS NULL THEN RAISE EXCEPTION 'completion_anchor_required' USING ERRCODE='22023'; END IF;
 IF c.terms->>'price_state' IS DISTINCT FROM 'confirmed'
    OR jsonb_typeof(c.terms->'base_points_cents') IS DISTINCT FROM 'number'
    OR coalesce(c.terms->>'base_points_cents','') !~ '^[0-9]{1,11}$'
    OR (c.terms ? 'cash_cents' AND (jsonb_typeof(c.terms->'cash_cents') IS DISTINCT FROM 'number'
       OR coalesce(c.terms->>'cash_cents','') !~ '^[0-9]{1,11}$')) THEN
  RETURN jsonb_build_object('state','pending_reward','reason','confirmed_claim_reward_missing');
 END IF;
 base:=(c.terms->>'base_points_cents')::bigint; cash:=coalesce((c.terms->>'cash_cents')::bigint,0);
 IF greatest(base,cash)>10000000000 THEN RETURN jsonb_build_object('state','pending_reward','reason','invalid_confirmed_reward'); END IF;
 IF base+cash=0 THEN RETURN jsonb_build_object('state','no_reward','base_points_cents',0); END IF;
 SELECT * INTO cfg FROM v8.board_settings WHERE organization_id=c.organization_id FOR SHARE;
 IF cfg.debtor_id IS NULL THEN RETURN jsonb_build_object('state','pending_configuration'); END IF;
 INSERT INTO v8.points_accounts(organization_id,member_id,debtor_id)
 VALUES(c.organization_id,c.member_id,cfg.debtor_id) ON CONFLICT DO NOTHING;
 SELECT * INTO a FROM v8.points_accounts WHERE organization_id=c.organization_id AND member_id=c.member_id FOR UPDATE;
 IF a.debtor_id<>cfg.debtor_id THEN RAISE EXCEPTION 'debtor_mismatch' USING ERRCODE='22023'; END IF;
 SELECT id INTO eid FROM v8.points_entries WHERE claim_id=c.id AND category='base';
 IF eid IS NOT NULL THEN RETURN jsonb_build_object('state','already_posted','entry_id',eid); END IF;
 eid:=v8.board_entry(c.organization_id,c.member_id,cfg.debtor_id,t.id,c.id,t.completion_receipt_id,
  'base',base,cash,0,actor,client,'自动入账：负责人已完成，按接取时已确认的报酬；未执行实际付款');
 RETURN jsonb_build_object('state','posted','entry_id',eid,'base_points_cents',base,
  'cash_due_cents',cash,'payment_effect','no_payment_asserted');
END $reward$;
REVOKE ALL ON FUNCTION v8.board_complete_reward(uuid,uuid,uuid,uuid) FROM PUBLIC,hub2_v8;
DO $patch$
DECLARE body text; anchor text;
BEGIN
 body:=pg_get_functiondef('v8.board_call(text,text,jsonb,text)'::regprocedure);
 anchor:='result:=jsonb_build_object(''state'',''retained'',''receipt'',to_jsonb(rc),''task_id'',t.id,''review_required'',false,''completion_applied'',cl.participation_role=''owner'' AND rc.declared_state=''completed'',''completion_basis'',''member_declaration;not_terminal_acceptance'');';
 IF position('v8.board_complete_reward(cl.id,rc.id,actor,client)' in body)=0 THEN
  IF position(anchor in body)=0 THEN RAISE EXCEPTION 'completion_source_changed'; END IF;
  body:=replace(body,anchor,anchor||E'\n   result:=result||jsonb_build_object(''reward_settlement'',v8.board_complete_reward(cl.id,rc.id,actor,client));');
 END IF;
 IF position('publish_reward_snapshot_v1' in body)=0 THEN
  anchor:='ELSIF op=''task_publish'' THEN';
  IF position(anchor in body)=0 THEN RAISE EXCEPTION 'publish_source_changed'; END IF;
  body:=replace(body,anchor,anchor||$publish$
  -- publish_reward_snapshot_v1: authenticated supervisor publication confirms prices.
  IF b ? 'terms' THEN
   IF jsonb_typeof(b->'terms')<>'object' THEN RAISE EXCEPTION 'invalid_terms' USING ERRCODE='22023'; END IF;
   IF EXISTS(SELECT FROM jsonb_each(b->'terms') x WHERE x.key IN('base_points_cents','cash_cents')
    AND (jsonb_typeof(x.value)<>'number' OR x.value::text !~ '^[0-9]{1,11}$'
    OR CASE WHEN x.value::text ~ '^[0-9]{1,11}$' THEN x.value::text::numeric>10000000000 ELSE false END)) THEN
    RAISE EXCEPTION 'invalid_confirmed_reward' USING ERRCODE='22023';
   END IF;
   IF NOT (b->'terms' ? 'base_points_cents') AND b#>>'{terms,price_state}'='confirmed' THEN
    RAISE EXCEPTION 'confirmed_reward_required' USING ERRCODE='22023';
   END IF;
  END IF;
$publish$);
  body:=replace(body,'coalesce(b->''terms'',''{}'')',
   '(CASE WHEN b->''terms'' ? ''base_points_cents'' THEN b->''terms''||jsonb_build_object(''price_state'',''confirmed'') ELSE coalesce(b->''terms'',''{}'') END)');
  body:=replace(body,'terms=coalesce(b->''terms'',terms)',
   'terms=CASE WHEN b->''terms'' ? ''base_points_cents'' THEN b->''terms''||jsonb_build_object(''price_state'',''confirmed'') ELSE coalesce(b->''terms'',terms) END');
 END IF;
 EXECUTE body;
END $patch$;
CREATE OR REPLACE FUNCTION v8.employeeclient_member_balance(proof text,target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $fn$
DECLARE i jsonb; actor uuid; org uuid; balance bigint; qn constant uuid:='ad44cc0e-159e-4e0f-a5ca-73d3920240d9';
BEGIN
 IF target IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.board_identity(proof,false,false);actor:=(i->>'actor_id')::uuid;org:=(i->>'organization_id')::uuid;
 IF NOT authz.can_read(actor,qn) OR NOT authz.can_read(target,qn) THEN RAISE EXCEPTION 'member_balance_forbidden' USING ERRCODE='42501';END IF;
 PERFORM authz.board_member(org,target);
 SELECT greatest(0,a.debt_cents-coalesce((SELECT sum(r.amount_cents) FROM v8.points_redemptions r
 WHERE r.organization_id=org AND r.member_id=target AND r.state IN('requested','agreed','postponement_proposed','postponed')),0))
 INTO balance FROM v8.points_accounts a WHERE a.organization_id=org AND a.member_id=target;
 RETURN jsonb_build_object('member_id',target,'balance_points',coalesce(balance,0)/100.0,'unit','point;1 point=1 CNY');
END $fn$;
REVOKE ALL ON FUNCTION v8.employeeclient_member_balance(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.employeeclient_member_balance(text,uuid) TO hub2_v8;

RESET ROLE;
SET ROLE hub2_v8_owner;
DO $tests$
DECLARE org uuid:=gen_random_uuid(); member uuid:=gen_random_uuid(); manager uuid:=gen_random_uuid(); client uuid:=gen_random_uuid();
 task uuid; claim uuid; receipt uuid; r jsonb; total bigint; n int;
BEGIN
 INSERT INTO v8.board_settings(organization_id,debtor_id) VALUES(org,manager);
 FOR n IN 1..3 LOOP
  INSERT INTO v8.board_tasks(organization_id,title,description,publisher_id,terms)
  VALUES(org,'自动入账隔离测试','事务回滚，不留存真实任务',manager,
    CASE WHEN n<3 THEN jsonb_build_object('price_state','confirmed','base_points_cents',CASE WHEN n=1 THEN 1000 ELSE 500 END,'cash_cents',0)
    ELSE '{"price_state":"not_provided"}'::jsonb END) RETURNING id INTO task;
  INSERT INTO v8.board_claims(task_id,organization_id,member_id,recorded_by,terms,task_revision,participation_role)
   SELECT id,org,member,member,terms,revision,'owner' FROM v8.board_tasks WHERE id=task RETURNING id INTO claim;
  INSERT INTO v8.board_receipts(task_id,claim_id,organization_id,member_id,submitted_by,text,declared_state)
   VALUES(task,claim,org,member,member,'隔离测试部分完成','partial') RETURNING id INTO receipt;
  r:=v8.board_complete_reward(claim,receipt,member,client);
  IF r->>'state'<>'not_applicable' THEN RAISE EXCEPTION 'partial_must_not_pay'; END IF;
  INSERT INTO v8.board_receipts(task_id,claim_id,organization_id,member_id,submitted_by,text,declared_state)
   VALUES(task,claim,org,member,member,'隔离测试完成','completed') RETURNING id INTO receipt;
  r:=v8.board_complete_reward(claim,receipt,member,client);
  IF r->>'state'<>(CASE WHEN n<3 THEN 'posted' ELSE 'pending_reward' END) THEN RAISE EXCEPTION 'settlement_state_wrong'; END IF;
  IF n<3 THEN
   r:=v8.board_complete_reward(claim,receipt,member,client);
   IF r->>'state'<>'already_posted' THEN RAISE EXCEPTION 'duplicate_must_not_pay'; END IF;
  END IF;
 END LOOP;
 SELECT debt_cents INTO total FROM v8.points_accounts WHERE organization_id=org AND member_id=member;
 IF total<>1500 THEN RAISE EXCEPTION 'balance_wrong'; END IF;
 IF (SELECT count(*) FROM v8.points_entries WHERE organization_id=org)<>2 THEN RAISE EXCEPTION 'duplicate_entry'; END IF;
 IF has_function_privilege('hub2_v8','v8.board_complete_reward(uuid,uuid,uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'public_reward_bypass'; END IF;
 IF position('v8.board_complete_reward(cl.id,rc.id,actor,client)' in pg_get_functiondef('v8.board_call(text,text,jsonb,text)'::regprocedure))=0 THEN RAISE EXCEPTION 'completion_chain_missing'; END IF;
END $tests$;
RESET ROLE;

ROLLBACK;
