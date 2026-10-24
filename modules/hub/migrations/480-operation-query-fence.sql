-- 480 candidate: existing current actor/SourceClosure guard unchanged.
SET ROLE hub2_mem_owner;
DO $operation_query_active_lease_contract$
DECLARE original text;updated text;needle text:='''attempt'',o.attempt,''retained_state''';
BEGIN
 original:=pg_get_functiondef('mem.operation(uuid,text,text)'::regprocedure);
 updated:=replace(original,needle,'''attempt'',o.attempt,''fencing_token'',o.fencing_token,''lease_until'',o.lease_until,''retained_state''');
 IF original=updated THEN RAISE EXCEPTION 'reviewed_operation_query_shape_changed';END IF;
 EXECUTE updated;
END $operation_query_active_lease_contract$;
RESET ROLE;
