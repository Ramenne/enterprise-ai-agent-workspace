SET ROLE hub2_v8_owner;
DO $$DECLARE r jsonb;candidate jsonb;b text;BEGIN
 r:=v8.work_read('00000000-0000-4000-8000-000000000001','','{}');
 IF r->>'current_summary'<>'kept' OR r->>'read_receipt_id'<>'kept' THEN RAISE EXCEPTION 'original_read_changed';END IF;
 IF r#>>'{relations,0,to_project_id}'<>'00000000-0000-4000-8000-000000000012' THEN RAISE EXCEPTION 'cross_project_locator_missing';END IF;
 IF jsonb_array_length(r#>'{relations,0,history,items}')<>1 OR r#>>'{relations,0,history,complete}'<>'true' THEN RAISE EXCEPTION 'history_missing';END IF;
 -- Same-project corrected edge must be a direct relation in candidate reads.
 b:='{"project_id":"00000000-0000-4000-8000-000000000011","work_item_id":"00000000-0000-4000-8000-000000000021","limit":10}';
 candidate:=v8.related_candidates('00000000-0000-4000-8000-000000000001',encode(public.digest(b,'sha256'),'hex'),b);
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(candidate->'items')i WHERE i->>'work_item_id'='00000000-0000-4000-8000-000000000023' AND i->>'direct_relation'='true') THEN RAISE EXCEPTION 'corrected_candidate_false';END IF;
 -- A real withdrawal suppresses that edge.
 INSERT INTO v8.work_relations VALUES('00000000-0000-4000-8000-000000000034','00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000023','{}','withdrawn','00000000-0000-4000-8000-000000000033');
 candidate:=v8.related_candidates('00000000-0000-4000-8000-000000000001',encode(public.digest(b,'sha256'),'hex'),b);
 IF EXISTS(SELECT FROM jsonb_array_elements(candidate->'items')i WHERE i->>'work_item_id'='00000000-0000-4000-8000-000000000023' AND i->>'direct_relation'='true') THEN RAISE EXCEPTION 'withdrawal_ignored';END IF;
 -- Inaccessible predecessor body never enters history.
 UPDATE v8.work_relations SET basis='{"denied":true,"explanation":"private predecessor"}' WHERE id='00000000-0000-4000-8000-000000000031';
 r:=v8.work_read('00000000-0000-4000-8000-000000000001','','{}');
 IF r::text LIKE '%private predecessor%' OR r#>>'{relations,0,history,complete}'<>'false' THEN RAISE EXCEPTION 'hidden_history_leaked';END IF;
 UPDATE v8.work_relations SET basis='{"explanation":"old"}' WHERE id='00000000-0000-4000-8000-000000000031';
 DELETE FROM v8.fixture_access WHERE project_id='00000000-0000-4000-8000-000000000012';
 r:=v8.work_read('00000000-0000-4000-8000-000000000001','','{}');
 IF r#>'{relations,0}' ? 'to_project_id' OR jsonb_array_length(r#>'{relations,0,history,items}')<>0 THEN RAISE EXCEPTION 'revoked_target_navigation_leaked';END IF;
 INSERT INTO v8.fixture_access VALUES('00000000-0000-4000-8000-000000000012');
 -- Corrupt/cyclic histories are bounded and declared incomplete.
 UPDATE v8.work_relations SET supersedes='00000000-0000-4000-8000-000000000032' WHERE id='00000000-0000-4000-8000-000000000031';
 r:=v8.work_read('00000000-0000-4000-8000-000000000001','','{}');
 IF r#>>'{relations,0,history,complete}'<>'false' THEN RAISE EXCEPTION 'cycle_not_bounded';END IF;
 UPDATE v8.work_relations SET supersedes=NULL,basis=jsonb_build_object('explanation',repeat('x',140000)) WHERE id='00000000-0000-4000-8000-000000000031';
 r:=v8.work_read('00000000-0000-4000-8000-000000000001','','{}');
 IF octet_length((r#>'{relations,0,history}')::text)>131072 OR r#>>'{relations,0,history,complete}'<>'false' THEN RAISE EXCEPTION 'history_bytes_unbounded';END IF;
 -- Original authorization failure still aborts the wrapper.
 BEGIN PERFORM v8.work_read(NULL,'','{}');RAISE EXCEPTION 'original_guard_bypassed';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'fixture_revoked' THEN RAISE;END IF;END;
END$$;
RESET ROLE;
