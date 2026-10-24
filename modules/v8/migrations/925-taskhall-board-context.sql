SET ROLE hub2_v8_owner;
-- Extend existing operations with a separately authenticated product service; real actor remains member.
CREATE OR REPLACE FUNCTION v8.board_call(proof text, op text, b jsonb, service_proof text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'v8'
AS $function$
DECLARE i jsonb;org uuid;actor uuid;client uuid;member uuid;manager boolean;writing boolean;must_manage boolean;result jsonb;oldcmd v8.board_commands;t v8.board_tasks;cl v8.board_claims;rc v8.board_receipts;cfg v8.board_settings;acc v8.points_accounts;cv v8.points_conversions;red v8.points_redemptions;oldentry v8.points_entries;allocation record;eid uuid;amount bigint;cash bigint;bonus bigint;base bigint;reserved bigint;available bigint;remaining bigint;deadline timestamptz;lim int;cur uuid;
BEGIN
 writing:=op NOT IN('tasks_lookup','receipts_read','wallet_read','settings_read','operations_read','proposals_read','proposal_history_read');
 must_manage:=op IN('task_decide','task_publish','settings_save','award','cash_pay','conversion_confirm','redemption_agree','redemption_postpone','redemption_pay','redemption_reject','entry_correct');
 IF op NOT IN('task_propose','task_decide','proposals_read','proposal_history_read','tasks_lookup','task_publish','claim','receipt_save','receipts_read','settings_read','settings_save','wallet_read','award','cash_pay','conversion_request','conversion_confirm','conversion_cancel','redemption_request','redemption_agree','redemption_postpone','redemption_confirm_postpone','redemption_pay','redemption_reject','redemption_cancel','entry_correct','operations_read') THEN RAISE EXCEPTION 'unknown_operation' USING ERRCODE='22023';END IF;
 IF service_proof IS NULL THEN i:=authz.board_identity(proof,writing,must_manage);ELSE i:=authz.taskhall_service_context(service_proof,proof,op);END IF;org:=(i->>'organization_id')::uuid;actor:=(i->>'actor_id')::uuid;client:=(i->>'client_id')::uuid;manager:=i->>'role'='organization_admin';
 member:=coalesce((b->>'member_id')::uuid,actor);
 IF member<>actor AND NOT manager AND NOT coalesce((i->>'named_member_scope')::boolean,false) THEN RAISE EXCEPTION 'member_scope_forbidden' USING ERRCODE='42501';END IF;
 PERFORM authz.board_member(org,member);
 IF writing THEN
  IF length(coalesce(b->>'idempotency_key','')) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE='22023';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(org::text||actor::text||(b->>'idempotency_key'),0));
  SELECT * INTO oldcmd FROM v8.board_commands WHERE organization_id=org AND actor_id=actor AND idempotency_key=b->>'idempotency_key';
  IF FOUND THEN IF oldcmd.operation<>op OR oldcmd.body<>b THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;RETURN oldcmd.result||jsonb_build_object('replayed',true);END IF;
 END IF;
 lim:=greatest(1,least(100,coalesce((b->>'limit')::int,30)));cur:=(b->>'cursor')::uuid;
 SELECT * INTO cfg FROM v8.board_settings WHERE organization_id=org FOR SHARE;
 IF op='tasks_lookup' THEN
  SELECT jsonb_build_object('state','found','items',coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]'::jsonb),'next_cursor',CASE WHEN count(*)=lim THEN max(x.id::text) ELSE NULL END,'selection','exact_title_first;duplicates_require_project_or_task_id') INTO result FROM (
   SELECT tt.*,(SELECT to_jsonb(cc) FROM v8.board_claims cc WHERE cc.task_id=tt.id AND cc.member_id=actor) AS my_claim FROM v8.board_tasks tt WHERE tt.organization_id=org AND (NOT coalesce((i->>'named_member_scope')::boolean,false) OR tt.project_id IS NULL OR authz.can_read(actor,tt.project_id)) AND (b->>'task_id' IS NULL OR tt.id=(b->>'task_id')::uuid) AND (b->>'project_name' IS NULL OR tt.project_name=b->>'project_name') AND (b->>'title' IS NULL OR lower(tt.title)=lower(b->>'title') OR (NOT EXISTS(SELECT FROM v8.board_tasks z WHERE z.organization_id=org AND z.state='published' AND lower(z.title)=lower(b->>'title') AND (b->>'project_name' IS NULL OR z.project_name=b->>'project_name')) AND position(lower(b->>'title') in lower(tt.title))>0)) AND (cur IS NULL OR tt.id>cur) AND (tt.state IN('published','archived') OR manager OR tt.proposed_by=actor) AND (b->>'task_id' IS NOT NULL OR tt.state='published') ORDER BY tt.id LIMIT lim
  )x;
 ELSIF op IN('proposals_read','proposal_history_read') THEN
  IF op='proposals_read' THEN
   SELECT jsonb_build_object('state','read','items',coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]'),'next_cursor',CASE WHEN count(*)=lim THEN max(x.id::text) ELSE NULL END) INTO result FROM (
    SELECT tt.* FROM v8.board_tasks tt WHERE tt.organization_id=org AND tt.proposed_by IS NOT NULL AND(manager OR tt.proposed_by=actor) AND (b->>'member_id' IS NULL OR tt.proposed_by=member) AND(b->>'state' IS NULL OR tt.state=b->>'state') AND(cur IS NULL OR tt.id>cur) ORDER BY tt.id LIMIT lim)x;
  ELSE
   SELECT * INTO t FROM v8.board_tasks WHERE id=(b->>'task_id')::uuid AND organization_id=org;
   IF t.id IS NULL OR t.proposed_by IS NULL THEN RAISE EXCEPTION 'proposal_not_found' USING ERRCODE='22023';END IF;
   IF NOT manager AND t.proposed_by<>actor THEN RAISE EXCEPTION 'proposal_forbidden' USING ERRCODE='42501';END IF;
   SELECT jsonb_build_object('state','read','task_id',t.id,'items',coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.revision),'[]'),'next_revision',CASE WHEN count(*)=lim THEN max(x.revision) ELSE NULL END) INTO result FROM (SELECT * FROM v8.board_task_history WHERE task_id=t.id AND revision>coalesce((b->>'after_revision')::bigint,0) ORDER BY revision LIMIT lim)x;
  END IF;
 ELSIF op IN('task_propose','task_decide') THEN
  IF EXISTS(SELECT FROM jsonb_each(b) x WHERE x.key IN('suggested_cash_cents','suggested_points_cents','cash_cents','base_points_cents') AND (jsonb_typeof(x.value)<>'number' OR x.value::text !~ '^[0-9]{1,11}$' OR CASE WHEN x.value::text ~ '^[0-9]{1,11}$' THEN x.value::text::numeric>10000000000 ELSE false END)) THEN RAISE EXCEPTION 'invalid_amount' USING ERRCODE='22023';END IF;
  IF b->>'project_id' IS NOT NULL AND NOT EXISTS(SELECT FROM v8.projects WHERE id=(b->>'project_id')::uuid AND organization_id=org AND authz.can_read(actor,id)) THEN RAISE EXCEPTION 'project_scope_mismatch' USING ERRCODE='42501';END IF;
  IF b->>'task_id' IS NOT NULL THEN
   SELECT * INTO t FROM v8.board_tasks WHERE id=(b->>'task_id')::uuid AND organization_id=org FOR UPDATE;
   IF t.id IS NULL OR t.proposed_by IS NULL THEN RAISE EXCEPTION 'proposal_not_found' USING ERRCODE='22023';END IF;
   IF t.revision<>coalesce((b->>'expected_revision')::bigint,-1) THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001';END IF;
   IF t.state NOT IN('proposed','changes_requested','rejected') THEN RAISE EXCEPTION 'proposal_already_decided' USING ERRCODE='40001';END IF;
   IF op='task_propose' AND t.proposed_by<>actor THEN RAISE EXCEPTION 'proposal_forbidden' USING ERRCODE='42501';END IF;
   PERFORM v8.board_task_snapshot(t,NULL,NULL,'prior_observed',NULL);
  ELSIF op='task_decide' THEN RAISE EXCEPTION 'task_id_required' USING ERRCODE='22023';
  END IF;
  IF op='task_propose' THEN
   IF t.id IS NULL THEN
    INSERT INTO v8.board_tasks(organization_id,title,project_name,project_id,description,direction,materials,terms,publisher_id,state,proposed_by,proposed_at)
    VALUES(org,b->>'title',coalesce(b->>'project_name',''),(b->>'project_id')::uuid,b->>'description',coalesce(b->>'direction',''),coalesce(b->'materials','[]'),jsonb_strip_nulls(jsonb_build_object('cash_cents',b->'suggested_cash_cents','base_points_cents',b->'suggested_points_cents','price_state','suggested')),NULL,'proposed',actor,clock_timestamp()) RETURNING * INTO t;
   ELSE
    UPDATE v8.board_tasks SET title=coalesce(b->>'title',title),description=coalesce(b->>'description',description),direction=coalesce(b->>'direction',direction),project_name=coalesce(b->>'project_name',project_name),project_id=coalesce((b->>'project_id')::uuid,project_id),materials=coalesce(b->'materials',materials),terms=terms||jsonb_strip_nulls(jsonb_build_object('cash_cents',b->'suggested_cash_cents','base_points_cents',b->'suggested_points_cents','price_state','suggested')),state='proposed',revision=revision+1,updated_at=clock_timestamp() WHERE id=t.id RETURNING * INTO t;
   END IF;
   PERFORM v8.board_task_snapshot(t,actor,client,'proposed',b->>'note');
   result:=jsonb_build_object('state','proposed','task',to_jsonb(t),'task_id',t.id,'proposal_id',t.id,'formal_task',false);
  ELSE
   IF b->>'decision' NOT IN('approve','request_changes','reject') OR b->>'decision' IS NULL THEN RAISE EXCEPTION 'invalid_decision' USING ERRCODE='22023';END IF;
   IF b->>'decision'<>'approve' AND length(btrim(coalesce(b->>'reason','')))=0 THEN RAISE EXCEPTION 'decision_reason_required' USING ERRCODE='22023';END IF;
   IF b->>'decision'='approve' AND NOT((b ? 'cash_cents' AND b ? 'base_points_cents') OR (b->>'confirm_suggested_terms'='true' AND t.terms ? 'cash_cents' AND t.terms ? 'base_points_cents')) THEN RAISE EXCEPTION 'confirmed_reward_required' USING ERRCODE='22023';END IF;
   UPDATE v8.board_tasks SET title=coalesce(b->>'title',title),description=coalesce(b->>'description',description),direction=coalesce(b->>'direction',direction),materials=coalesce(b->'materials',materials),
    terms=CASE WHEN b->>'decision'='approve' THEN terms||jsonb_build_object('cash_cents',coalesce(b->'cash_cents',terms->'cash_cents'),'base_points_cents',coalesce(b->'base_points_cents',terms->'base_points_cents'),'price_state','confirmed') ELSE terms END,
    state=CASE b->>'decision' WHEN 'approve' THEN 'published' WHEN 'request_changes' THEN 'changes_requested' ELSE 'rejected' END,
    publisher_id=CASE WHEN b->>'decision'='approve' THEN actor ELSE publisher_id END,
    approved_from_revision=CASE WHEN b->>'decision'='approve' THEN revision ELSE approved_from_revision END,
    confirmed_revision=CASE WHEN b->>'decision'='approve' THEN revision+1 ELSE confirmed_revision END,
    revision=revision+1,updated_at=clock_timestamp() WHERE id=t.id RETURNING * INTO t;
   PERFORM v8.board_task_snapshot(t,actor,client,b->>'decision',b->>'reason');
   result:=jsonb_build_object('state',t.state,'task',to_jsonb(t),'task_id',t.id,'proposal_id',t.id,'formal_task',t.state='published','claimed',false,'points_posted',false);
  END IF;
 ELSIF op='settings_read' THEN result:=jsonb_build_object('state','read','settings',to_jsonb(cfg),'points_exchange_rate','1 point = 1 CNY personal debt','daily_budget_basis','unset_unless_supervisor_configured');
 ELSIF op='settings_save' THEN
  PERFORM authz.board_member(org,(b->>'debtor_id')::uuid);
  IF cfg.organization_id IS NOT NULL AND cfg.revision<>coalesce((b->>'expected_revision')::bigint,0) THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001';END IF;
  IF cfg.organization_id IS NOT NULL AND cfg.debtor_id<>(b->>'debtor_id')::uuid AND EXISTS(SELECT FROM v8.points_entries WHERE organization_id=org) THEN RAISE EXCEPTION 'debtor_change_requires_explicit_migration' USING ERRCODE='22023';END IF;
  INSERT INTO v8.board_settings VALUES(org,(b->>'debtor_id')::uuid,coalesce(b->'settings','{}'),1,clock_timestamp()) ON CONFLICT(organization_id) DO UPDATE SET debtor_id=excluded.debtor_id,settings=excluded.settings,revision=v8.board_settings.revision+1,updated_at=clock_timestamp() RETURNING * INTO cfg;
  result:=jsonb_build_object('state','saved','settings',to_jsonb(cfg));
 ELSIF op='task_publish' THEN
  IF b->>'project_id' IS NOT NULL AND NOT EXISTS(SELECT FROM v8.projects WHERE id=(b->>'project_id')::uuid AND organization_id=org) THEN RAISE EXCEPTION 'project_scope_mismatch' USING ERRCODE='22023';END IF;
  IF b->>'work_item_id' IS NOT NULL AND NOT EXISTS(SELECT FROM v8.work_items WHERE id=(b->>'work_item_id')::uuid AND project_id=(b->>'project_id')::uuid) THEN RAISE EXCEPTION 'work_scope_mismatch' USING ERRCODE='22023';END IF;
  IF b->>'task_id' IS NULL THEN INSERT INTO v8.board_tasks(organization_id,title,project_name,project_id,work_item_id,description,direction,materials,terms,publisher_id) VALUES(org,b->>'title',coalesce(b->>'project_name',''),(b->>'project_id')::uuid,(b->>'work_item_id')::uuid,b->>'description',coalesce(b->>'direction',''),coalesce(b->'materials','[]'),coalesce(b->'terms','{}'),actor) RETURNING * INTO t;
  ELSE SELECT * INTO t FROM v8.board_tasks WHERE id=(b->>'task_id')::uuid AND organization_id=org FOR UPDATE;IF t.id IS NULL THEN RAISE EXCEPTION 'task_not_found' USING ERRCODE='22023';END IF;IF t.proposed_by IS NOT NULL AND t.state NOT IN('published','archived') THEN RAISE EXCEPTION 'use_proposal_decision' USING ERRCODE='22023';END IF;PERFORM v8.board_task_snapshot(t,NULL,NULL,'prior_observed',NULL);IF t.revision<>(b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001';END IF;
   UPDATE v8.board_tasks SET title=coalesce(b->>'title',title),description=coalesce(b->>'description',description),direction=coalesce(b->>'direction',direction),project_name=coalesce(b->>'project_name',project_name),materials=coalesce(b->'materials',materials),terms=coalesce(b->'terms',terms),confirmed_revision=CASE WHEN proposed_by IS NOT NULL THEN revision+1 ELSE confirmed_revision END,state=coalesce(b->>'state',state),revision=revision+1,updated_at=clock_timestamp() WHERE id=t.id RETURNING * INTO t;
  END IF;PERFORM v8.board_task_snapshot(t,actor,client,'task_publish',NULL);result:=jsonb_build_object('state','published','task',to_jsonb(t),'task_id',t.id);
 ELSIF op='operations_read' THEN
  SELECT jsonb_build_object('state','found','operation',bc.operation,'result',bc.result) INTO result FROM v8.board_commands bc WHERE bc.organization_id=org AND bc.actor_id=actor AND bc.idempotency_key=b->>'idempotency_key';IF result IS NULL THEN result:=jsonb_build_object('state','not_found');END IF;
 ELSE
  IF b->>'task_id' IS NOT NULL THEN SELECT * INTO t FROM v8.board_tasks WHERE id=(b->>'task_id')::uuid AND organization_id=org FOR SHARE;END IF;
  IF b->>'claim_id' IS NOT NULL THEN SELECT * INTO cl FROM v8.board_claims WHERE id=(b->>'claim_id')::uuid AND organization_id=org FOR UPDATE;
   IF cl.id IS NULL OR (cl.member_id<>actor AND NOT manager AND NOT coalesce((i->>'named_member_scope')::boolean,false)) THEN RAISE EXCEPTION 'claim_forbidden' USING ERRCODE='42501';END IF;member:=cl.member_id;SELECT * INTO t FROM v8.board_tasks WHERE id=cl.task_id;
  END IF;
  IF coalesce((i->>'named_member_scope')::boolean,false) AND op IN('claim','receipt_save') AND (t.id IS NULL OR (t.project_id IS NOT NULL AND NOT authz.can_read(actor,t.project_id))) THEN RAISE EXCEPTION 'task_scope_forbidden' USING ERRCODE='42501';END IF;
  IF op IN('claim','receipt_save') AND cl.id IS NULL THEN
   IF t.id IS NULL THEN RAISE EXCEPTION 'task_required' USING ERRCODE='22023';END IF;
   IF t.state<>'published' AND NOT EXISTS(SELECT FROM v8.board_claims WHERE task_id=t.id AND member_id=member) THEN RAISE EXCEPTION 'task_not_published' USING ERRCODE='22023';END IF;
   INSERT INTO v8.board_claims(task_id,organization_id,member_id,recorded_by,source,note,terms,task_revision,claimed_at) VALUES(t.id,org,member,actor,coalesce(b->>'source','offline'),coalesce(b->>'note',''),t.terms,t.revision,coalesce((b->>'claimed_at')::timestamptz,clock_timestamp())) ON CONFLICT(task_id,member_id) DO NOTHING;
   SELECT * INTO cl FROM v8.board_claims WHERE task_id=t.id AND member_id=member FOR UPDATE;
  END IF;
  IF op='claim' THEN result:=jsonb_build_object('state','recorded','claim',to_jsonb(cl),'offline_claim_is_valid',true);
  ELSIF op='receipt_save' THEN
   IF b->>'supersedes_id' IS NOT NULL AND NOT EXISTS(SELECT FROM v8.board_receipts WHERE id=(b->>'supersedes_id')::uuid AND claim_id=cl.id) THEN RAISE EXCEPTION 'receipt_scope_mismatch' USING ERRCODE='22023';END IF;
   INSERT INTO v8.board_receipts(claim_id,task_id,organization_id,member_id,submitted_by,text,result_refs,declared_state,supersedes_id) VALUES(cl.id,t.id,org,member,actor,b->>'text',coalesce(b->'result_refs','[]'),coalesce(b->>'declared_state','completed'),(b->>'supersedes_id')::uuid) RETURNING * INTO rc;
   result:=jsonb_build_object('state','retained','receipt',to_jsonb(rc),'review_required',false,'completion_basis','member_declaration;not_terminal_acceptance');
  ELSIF op='receipts_read' THEN
   SELECT jsonb_build_object('state','read','items',coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]'),'next_cursor',CASE WHEN count(*)=lim THEN max(x.id::text) ELSE NULL END) INTO result FROM (
    SELECT rr.* FROM v8.board_receipts rr JOIN v8.board_tasks tt ON tt.id=rr.task_id WHERE rr.organization_id=org AND (manager OR rr.member_id=actor OR coalesce((i->>'named_member_scope')::boolean,false)) AND (NOT coalesce((i->>'named_member_scope')::boolean,false) OR tt.project_id IS NULL OR authz.can_read(actor,tt.project_id)) AND (b->>'member_id' IS NULL OR rr.member_id=member) AND (b->>'task_id' IS NULL OR rr.task_id=(b->>'task_id')::uuid) AND (b->>'title' IS NULL OR lower(tt.title)=lower(b->>'title')) AND (b->>'project_name' IS NULL OR tt.project_name=b->>'project_name') AND (b->>'since' IS NULL OR rr.created_at>=(b->>'since')::timestamptz) AND (b->>'until' IS NULL OR rr.created_at<=(b->>'until')::timestamptz) AND (cur IS NULL OR rr.id>cur) ORDER BY rr.id LIMIT lim)x;
  ELSE
   IF cfg.organization_id IS NULL AND op<>'wallet_read' THEN RAISE EXCEPTION 'debtor_not_configured' USING ERRCODE='22023';END IF;
   IF b->>'conversion_id' IS NOT NULL THEN SELECT * INTO cv FROM v8.points_conversions WHERE id=(b->>'conversion_id')::uuid AND organization_id=org FOR UPDATE;IF cv.id IS NULL OR (cv.member_id<>actor AND NOT manager) THEN RAISE EXCEPTION 'conversion_forbidden' USING ERRCODE='42501';END IF;member:=cv.member_id;SELECT * INTO cl FROM v8.board_claims WHERE id=cv.claim_id;SELECT * INTO t FROM v8.board_tasks WHERE id=cv.task_id;END IF;
   IF b->>'redemption_id' IS NOT NULL THEN SELECT * INTO red FROM v8.points_redemptions WHERE id=(b->>'redemption_id')::uuid AND organization_id=org FOR UPDATE;IF red.id IS NULL OR (red.member_id<>actor AND NOT manager) THEN RAISE EXCEPTION 'redemption_forbidden' USING ERRCODE='42501';END IF;member:=red.member_id;END IF;
   IF b->>'entry_id' IS NOT NULL THEN SELECT * INTO oldentry FROM v8.points_entries WHERE id=(b->>'entry_id')::uuid AND organization_id=org;IF oldentry.id IS NULL THEN RAISE EXCEPTION 'entry_not_found' USING ERRCODE='22023';END IF;member:=oldentry.member_id;END IF;
   IF op<>'wallet_read' THEN INSERT INTO v8.points_accounts(organization_id,member_id,debtor_id) VALUES(org,member,cfg.debtor_id) ON CONFLICT DO NOTHING;END IF;
   SELECT * INTO acc FROM v8.points_accounts WHERE organization_id=org AND member_id=member FOR UPDATE;
   SELECT coalesce(sum(amount_cents),0) INTO reserved FROM v8.points_redemptions WHERE organization_id=org AND member_id=member AND state IN('requested','agreed','postponement_proposed','postponed');available:=coalesce(acc.debt_cents,0)-reserved;
   amount:=coalesce((b->>'amount_cents')::bigint,0);
   IF amount<0 OR amount>10000000000 THEN RAISE EXCEPTION 'invalid_amount' USING ERRCODE='22023';END IF;
   IF op='wallet_read' THEN
    result:=jsonb_build_object('state','read','member',authz.board_member(org,member),'debtor_id',cfg.debtor_id,'balance_points',coalesce(acc.debt_cents,0)/100.0,'debt_cny',coalesce(acc.debt_cents,0)/100.0,'reserved_cny',reserved/100.0,'available_cny',available/100.0,'cash_due_cny',coalesce(acc.cash_due_cents,0)/100.0,'cash_paid_cny',coalesce(acc.cash_paid_cents,0)/100.0,'unit','API amounts are integer cents;1 point=1 CNY','next_cursor',(SELECT CASE WHEN count(*)=lim THEN max(x.id::text) ELSE NULL END FROM(SELECT id FROM v8.points_entries WHERE organization_id=org AND member_id=member AND(cur IS NULL OR id>cur) ORDER BY id LIMIT lim)x),'history_coverage','entries_paginated;requests_latest_100;balance_includes_all_entries','entries',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM(SELECT e.*,tt.title AS task_title,tt.project_name FROM v8.points_entries e JOIN v8.board_tasks tt ON tt.id=e.task_id WHERE e.organization_id=org AND e.member_id=member AND(cur IS NULL OR e.id>cur) ORDER BY e.id LIMIT lim)x),'[]'),'redemptions',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT * FROM v8.points_redemptions WHERE organization_id=org AND member_id=member ORDER BY requested_at DESC LIMIT 100)x),'[]'),'conversions',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT * FROM v8.points_conversions WHERE organization_id=org AND member_id=member ORDER BY created_at DESC LIMIT 100)x),'[]'));
   ELSIF op='award' THEN
    SELECT * INTO rc FROM v8.board_receipts WHERE id=(b->>'receipt_id')::uuid AND organization_id=org;IF rc.id IS NULL OR rc.member_id<>member OR rc.claim_id<>cl.id THEN RAISE EXCEPTION 'matching_receipt_required' USING ERRCODE='22023';END IF;
    base:=coalesce((b->>'base_points_cents')::bigint,0);cash:=coalesce((b->>'cash_cents')::bigint,0);bonus:=coalesce((b->>'quality_points_cents')::bigint,0);
    IF least(base,cash,bonus)<0 OR greatest(base,cash,bonus)>10000000000 OR base+cash+bonus=0 THEN RAISE EXCEPTION 'invalid_award' USING ERRCODE='22023';END IF;
    IF EXISTS(SELECT FROM v8.points_entries WHERE claim_id=cl.id AND category='base') THEN RAISE EXCEPTION 'claim_already_settled' USING ERRCODE='23505';END IF;
    eid:=v8.board_entry(org,member,cfg.debtor_id,t.id,cl.id,rc.id,'base',base,cash,0,actor,client,coalesce(b->>'note',''));
    IF bonus>0 THEN PERFORM v8.board_entry(org,member,cfg.debtor_id,t.id,cl.id,rc.id,'quality',bonus,0,0,actor,client,coalesce(b->>'note',''));END IF;
    result:=jsonb_build_object('state','posted','entry_id',eid,'base_points_cents',base,'quality_points_cents',bonus,'cash_due_cents',cash,'payment_effect','no_payment_asserted');
   ELSIF op='cash_pay' THEN
    IF cl.id IS NULL OR amount<=0 OR b->>'actual_payment_confirmed'<>'true' THEN RAISE EXCEPTION 'actual_cash_payment_required' USING ERRCODE='22023';END IF;
    SELECT coalesce(sum(cash_due_delta_cents),0) INTO remaining FROM v8.points_entries WHERE claim_id=cl.id;
    IF amount>remaining THEN RAISE EXCEPTION 'cash_due_exceeded' USING ERRCODE='22023';END IF;
    eid:=v8.board_entry(org,member,cfg.debtor_id,t.id,cl.id,NULL,'cash_payment',0,-amount,amount,actor,client,coalesce(b->>'note',''));result:=jsonb_build_object('state','posted','entry_id',eid);
   ELSIF op='conversion_request' THEN
    IF member<>actor OR cl.id IS NULL OR cl.member_id<>actor OR amount<=0 THEN RAISE EXCEPTION 'member_voluntary_request_required' USING ERRCODE='42501';END IF;
    INSERT INTO v8.points_conversions(organization_id,member_id,claim_id,task_id,amount_cents,mode,note) VALUES(org,member,cl.id,t.id,amount,b->>'mode',coalesce(b->>'note','')) RETURNING * INTO cv;
    result:=jsonb_build_object('state','requested','conversion',to_jsonb(cv),'debt_changed',false);
   ELSIF op='conversion_confirm' THEN
    IF cv.state<>'requested' OR cv.revision<>(b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'conversion_state_conflict' USING ERRCODE='40001';END IF;
    amount:=cv.amount_cents;
    SELECT coalesce(sum(CASE WHEN cv.mode='unpaid' THEN cash_due_delta_cents ELSE cash_paid_delta_cents END),0) INTO remaining FROM v8.points_entries WHERE claim_id=cl.id;
    IF amount>remaining THEN RAISE EXCEPTION 'cash_amount_exceeded' USING ERRCODE='22023';END IF;
    IF cv.mode='returned' AND b->>'cash_return_received'<>'true' THEN RAISE EXCEPTION 'actual_cash_return_required' USING ERRCODE='22023';END IF;
    eid:=v8.board_entry(org,member,cfg.debtor_id,t.id,cl.id,NULL,CASE WHEN cv.mode='unpaid' THEN 'cash_conversion_unpaid' ELSE 'cash_conversion_returned' END,amount,CASE WHEN cv.mode='unpaid' THEN -amount ELSE 0 END,CASE WHEN cv.mode='returned' THEN -amount ELSE 0 END,actor,client,coalesce(b->>'note',''),cv.id);
    UPDATE v8.points_conversions SET state='confirmed',revision=revision+1,confirmed_at=clock_timestamp(),confirmed_by=actor WHERE id=cv.id RETURNING * INTO cv;result:=jsonb_build_object('state','posted','entry_id',eid,'conversion',to_jsonb(cv),'quality_multiplier_applied',false);
   ELSIF op='conversion_cancel' THEN
    IF actor<>cv.member_id OR cv.state<>'requested' OR cv.revision<>(b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'conversion_state_conflict' USING ERRCODE='40001';END IF;UPDATE v8.points_conversions SET state='cancelled',revision=revision+1 WHERE id=cv.id RETURNING * INTO cv;result:=jsonb_build_object('state','cancelled','conversion',to_jsonb(cv));
   ELSIF op='redemption_request' THEN
    IF actor<>member OR amount<=0 OR amount>available THEN RAISE EXCEPTION 'available_balance_exceeded' USING ERRCODE='22023';END IF;
    INSERT INTO v8.points_redemptions(organization_id,member_id,debtor_id,amount_cents,note) VALUES(org,member,cfg.debtor_id,amount,coalesce(b->>'note','')) RETURNING * INTO red;result:=jsonb_build_object('state','requested','redemption',to_jsonb(red),'debt_reduced',false);
   ELSIF op IN('redemption_agree','redemption_postpone','redemption_confirm_postpone','redemption_pay','redemption_reject','redemption_cancel') THEN
    IF red.revision<>(b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001';END IF;
    IF op='redemption_agree' THEN
     IF red.state<>'requested' THEN RAISE EXCEPTION 'redemption_state_conflict' USING ERRCODE='40001';END IF;UPDATE v8.points_redemptions SET state='agreed',agreed_at=clock_timestamp(),due_at=clock_timestamp()+interval '7 days',revision=revision+1,acted_by=actor WHERE id=red.id RETURNING * INTO red;
    ELSIF op='redemption_postpone' THEN
     deadline:=(b->>'proposed_due_at')::timestamptz;IF red.state NOT IN('agreed','postponed','postponement_proposed') OR deadline<=clock_timestamp() THEN RAISE EXCEPTION 'postponement_input_invalid' USING ERRCODE='22023';END IF;
     UPDATE v8.points_redemptions SET state='postponement_proposed',proposed_due_at=deadline,revision=revision+1,acted_by=actor,note=coalesce(b->>'note',note) WHERE id=red.id RETURNING * INTO red;
    ELSIF op='redemption_confirm_postpone' THEN
     IF actor<>red.member_id OR red.state<>'postponement_proposed' OR (b->>'amount_cents')::bigint<>red.amount_cents OR (b->>'proposed_due_at')::timestamptz IS DISTINCT FROM red.proposed_due_at THEN RAISE EXCEPTION 'matching_member_agreement_required' USING ERRCODE='22023';END IF;
     UPDATE v8.points_redemptions SET state='postponed',due_at=proposed_due_at,proposed_due_at=NULL,member_confirmed_at=clock_timestamp(),revision=revision+1 WHERE id=red.id RETURNING * INTO red;
    ELSIF op='redemption_pay' THEN
     IF red.state NOT IN('agreed','postponed','postponement_proposed') OR b->>'actual_payment_confirmed'<>'true' THEN RAISE EXCEPTION 'actual_redemption_payment_required' USING ERRCODE='22023';END IF;
     remaining:=red.amount_cents;
     FOR allocation IN SELECT e.claim_id,e.task_id,min(e.receipt_id::text)::uuid AS receipt_id FROM v8.points_entries e WHERE e.organization_id=org AND e.member_id=member GROUP BY e.claim_id,e.task_id HAVING sum(e.debt_delta_cents)>0 ORDER BY e.claim_id LOOP
      SELECT least(remaining,sum(debt_delta_cents)) INTO amount FROM v8.points_entries WHERE claim_id=allocation.claim_id AND member_id=member;
      PERFORM v8.board_entry(org,member,cfg.debtor_id,allocation.task_id,allocation.claim_id,allocation.receipt_id,'redemption',-amount,0,0,actor,client,coalesce(b->>'note',''),red.id);remaining:=remaining-amount;EXIT WHEN remaining=0;
     END LOOP;IF remaining<>0 THEN RAISE EXCEPTION 'redemption_allocation_failed' USING ERRCODE='22023';END IF;
     UPDATE v8.points_redemptions SET state='paid',paid_at=clock_timestamp(),revision=revision+1,acted_by=actor WHERE id=red.id RETURNING * INTO red;
    ELSIF op='redemption_reject' THEN
     IF red.state<>'requested' THEN RAISE EXCEPTION 'redemption_state_conflict' USING ERRCODE='40001';END IF;UPDATE v8.points_redemptions SET state='rejected',revision=revision+1,acted_by=actor,note=coalesce(b->>'note',note) WHERE id=red.id RETURNING * INTO red;
    ELSE
     IF actor<>red.member_id OR red.state NOT IN('requested','agreed','postponement_proposed','postponed') THEN RAISE EXCEPTION 'member_cancellation_required' USING ERRCODE='42501';END IF;UPDATE v8.points_redemptions SET state='cancelled',revision=revision+1,acted_by=actor WHERE id=red.id RETURNING * INTO red;
    END IF;result:=jsonb_build_object('state',red.state,'redemption',to_jsonb(red),'original_due_preserved_until_both_agree',true);
   ELSIF op='entry_correct' THEN
    IF oldentry.category IN('redemption','correction') OR b->>'reason' IS NULL THEN RAISE EXCEPTION 'correction_reason_required' USING ERRCODE='22023';END IF;
    IF EXISTS(SELECT FROM v8.points_entries WHERE source_id=oldentry.id AND category='correction') THEN RAISE EXCEPTION 'already_corrected' USING ERRCODE='23505';END IF;
    IF EXISTS(SELECT FROM v8.points_entries WHERE claim_id=oldentry.claim_id GROUP BY claim_id HAVING sum(debt_delta_cents)-oldentry.debt_delta_cents<0 OR sum(cash_due_delta_cents)-oldentry.cash_due_delta_cents<0 OR sum(cash_paid_delta_cents)-oldentry.cash_paid_delta_cents<0) THEN RAISE EXCEPTION 'claim_amount_already_consumed' USING ERRCODE='22023';END IF;
    IF oldentry.debt_delta_cents>available THEN RAISE EXCEPTION 'reserved_or_spent_debt_cannot_reverse' USING ERRCODE='22023';END IF;
    eid:=v8.board_entry(org,member,cfg.debtor_id,oldentry.task_id,oldentry.claim_id,oldentry.receipt_id,'correction',-oldentry.debt_delta_cents,-oldentry.cash_due_delta_cents,-oldentry.cash_paid_delta_cents,actor,client,b->>'reason',oldentry.id);result:=jsonb_build_object('state','corrected','entry_id',eid,'original_entry_preserved',true);
   ELSE RAISE EXCEPTION 'invalid_operation' USING ERRCODE='22023';END IF;
  END IF;
 END IF;
 IF writing THEN
  result:=result||jsonb_build_object('idempotency_key',b->>'idempotency_key');
  INSERT INTO v8.board_commands VALUES(org,actor,b->>'idempotency_key',op,b,result,clock_timestamp());
  INSERT INTO v8.board_events(organization_id,actor_id,client_id,operation,entity_id,body,result) VALUES(org,actor,client,op,coalesce(t.id,red.id,cv.id),b,result);
 END IF;
 RETURN result;
END $function$;
REVOKE ALL ON FUNCTION v8.board_call(text,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.board_call(text,text,jsonb,text) TO hub2_v8;
CREATE OR REPLACE FUNCTION v8.board_call(proof text,op text,b jsonb) RETURNS jsonb
LANGUAGE SQL SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$SELECT v8.board_call(proof,op,b,NULL::text)$$;
REVOKE ALL ON FUNCTION v8.board_call(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.board_call(text,text,jsonb) TO hub2_v8;
RESET ROLE;
