DO $tests$
DECLARE p text:='__PROOF__'; org uuid; actor uuid; client uuid; ident jsonb;
 t uuid; c uuid; rc uuid; b jsonb; r jsonb; before_commands bigint; before_entries bigint;
 key text:='receipt-settlement-test-'||gen_random_uuid()::text; total bigint; basecount int;
BEGIN
 ident:=authz.board_identity(p,true,true); org:=(ident->>'organization_id')::uuid;
 actor:=(ident->>'actor_id')::uuid; client:=(ident->>'client_id')::uuid;
 SELECT count(*) INTO before_entries FROM v8.points_entries WHERE organization_id=org;
 SELECT count(*) INTO before_commands FROM v8.board_commands WHERE organization_id=org;
 r:=v8.board_call(p,'task_publish',jsonb_build_object('title','事务回滚夹具','description','仅验证现有回执结算，无实际任务或付款','terms',jsonb_build_object('cash_cents',1000,'base_points_cents',1000),'idempotency_key',key||'-publish'),NULL);
 t:=(r->>'task_id')::uuid;
 r:=v8.board_call(p,'claim',jsonb_build_object('task_id',t,'idempotency_key',key||'-claim'),NULL); c:=(r#>>'{claim,id}')::uuid;
 r:=v8.board_call(p,'receipt_save',jsonb_build_object('claim_id',c,'text','实际结果：已完成一部分。经验：本次无新经验。','declared_state','partial','idempotency_key',key||'-partial'),NULL);
 IF r#>>'{reward_settlement,state}'<>'not_applicable' OR EXISTS(SELECT FROM v8.points_entries WHERE claim_id=c) THEN RAISE EXCEPTION 'partial_paid';END IF;
 -- Changes to publication after claim must not replace the accepted reward.
 r:=v8.board_call(p,'task_publish',jsonb_build_object('task_id',t,'expected_revision',1,'terms',jsonb_build_object('cash_cents',2000,'base_points_cents',2000),'idempotency_key',key||'-reprice'),NULL);
 b:=jsonb_build_object('claim_id',c,'text','实际结果：夹具完成。未确认：无。经验：本次无新经验。','declared_state','completed','idempotency_key',key||'-complete');
 r:=v8.board_call(p,'receipt_save',b,NULL); rc:=(r#>>'{receipt,id}')::uuid;
 IF r#>>'{reward_settlement,state}'<>'posted' OR (r#>>'{reward_settlement,base_points_cents}')::bigint<>1000 OR (r#>>'{reward_settlement,cash_due_cents}')::bigint<>1000 THEN RAISE EXCEPTION 'snapshot_or_completion_failed';END IF;
 r:=v8.board_call(p,'receipt_save',b,NULL);IF r->>'replayed'<>'true' THEN RAISE EXCEPTION 'completion_not_replayed';END IF;
 r:=v8.board_call(p,'receipt_save',b||jsonb_build_object('idempotency_key',key||'-supplement','text','补充成果说明；无新经验。'),NULL);
 IF r#>>'{reward_settlement,state}'<>'already_posted' THEN RAISE EXCEPTION 'supplement_paid_again';END IF;
 b:=jsonb_build_object('claim_id',c,'receipt_id',rc,'quality_points_cents',500,'note','隔离夹具：追加5分，无真实发放','idempotency_key',key||'-bonus');
 r:=v8.board_call(p,'award',b,NULL);IF r->>'state'<>'posted' OR r->>'entry_id' IS NULL THEN RAISE EXCEPTION 'quality_after_base_failed';END IF;
 r:=v8.board_call(p,'award',b,NULL);IF r->>'replayed'<>'true' THEN RAISE EXCEPTION 'bonus_not_replayed';END IF;
 SELECT sum(debt_delta_cents),count(*) FILTER(WHERE category='base') INTO total,basecount FROM v8.points_entries WHERE claim_id=c;
 IF total<>1500 OR basecount<>1 THEN RAISE EXCEPTION 'base_bonus_not_15';END IF;
 -- A deliberate later reward is a separate supervisor decision, not a replay.
 r:=v8.board_call(p,'award',b||jsonb_build_object('quality_points_cents',200,'idempotency_key',key||'-later-bonus'),NULL);
 BEGIN
  r:=v8.board_call(p,'award',jsonb_build_object('claim_id',c,'receipt_id',rc,'base_points_cents',1000,'idempotency_key',key||'-duplicate-base'),NULL);
  RAISE EXCEPTION 'duplicate_base_accepted';
 EXCEPTION WHEN unique_violation THEN NULL;END;
 BEGIN
  r:=v8.board_call(p,'cash_pay',jsonb_build_object('claim_id',c,'amount_cents',500,'actual_payment_confirmed',false,'idempotency_key',key||'-not-paid'),NULL);
  RAISE EXCEPTION 'unconfirmed_cash_accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 r:=v8.board_call(p,'cash_pay',jsonb_build_object('claim_id',c,'amount_cents',500,'actual_payment_confirmed',true,'note','回滚夹具，无实际转账','idempotency_key',key||'-cash'),NULL);
 r:=v8.board_call(p,'receipts_read',jsonb_build_object('task_id',t,'limit',100),NULL);
 IF jsonb_array_length(r->'items')<>3 THEN RAISE EXCEPTION 'receipt_query_wrong';END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(r->'items') LOOP
  IF b#>>'{settlement,base_posted}'<>'true' OR (b#>>'{settlement,base_points_cents}')::bigint<>1000 OR (b#>>'{settlement,quality_points_cents}')::bigint<>700 OR (b#>>'{settlement,debt_cents}')::bigint<>1700 OR (b#>>'{settlement,cash_due_cents}')::bigint<>500 OR (b#>>'{settlement,cash_paid_cents}')::bigint<>500 THEN RAISE EXCEPTION 'receipt_ledger_projection_wrong';END IF;
 END LOOP;
 r:=v8.board_call(p,'task_publish',jsonb_build_object('title','未定价回滚夹具','description','不猜报酬','idempotency_key',key||'-unpriced'),NULL);t:=(r->>'task_id')::uuid;
 r:=v8.board_call(p,'receipt_save',jsonb_build_object('task_id',t,'text','成果已完成，无新经验。','declared_state','completed','idempotency_key',key||'-unpriced-complete'),NULL);
 IF r#>>'{reward_settlement,state}'<>'pending_reward' OR r->>'state'<>'retained' THEN RAISE EXCEPTION 'missing_price_not_retained';END IF;
 IF EXISTS(SELECT FROM v8.points_entries WHERE task_id=t) THEN RAISE EXCEPTION 'unpriced_paid';END IF;
 RAISE NOTICE 'PASS: authenticated completion, claim snapshot, replay, supplement, post-completion bonus 10+5=15, later bonus, base duplicate rejection, cash confirmation, receipt ledger read, no-experience completion, unpriced retention. Entire transaction rolls back.';
END $tests$;
