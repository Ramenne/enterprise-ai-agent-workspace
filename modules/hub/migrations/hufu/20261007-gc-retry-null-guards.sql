-- SQL IF treats NULL as false: missing no-effect evidence must explicitly reject retry.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $patch$ DECLARE definition text;old_condition text;new_condition text; BEGIN
 definition:=pg_get_functiondef('mem.gc_retry(uuid,text,text)'::regprocedure);
 old_condition:='p.state<>''failed''OR p.receipt->>''code''NOT IN(''provider_denied'',''lease_expired_before_provider_dispatch'') OR NOT cov.complete OR cov.valid_until<=clock_timestamp()OR cov.retain_until>clock_timestamp()';
 new_condition:='p.state IS DISTINCT FROM ''failed''OR p.receipt->>''code'' IS NULL OR p.receipt->>''code''NOT IN(''provider_denied'',''lease_expired_before_provider_dispatch'') OR cov.project_id IS NULL OR cov.complete IS DISTINCT FROM true OR cov.valid_until IS NULL OR cov.valid_until<=clock_timestamp()OR cov.retain_until IS NULL OR cov.retain_until>clock_timestamp()';
 IF position(new_condition in definition)=0 THEN
  IF position(old_condition in definition)=0 THEN RAISE EXCEPTION 'gc_retry_guard_anchor_changed';END IF;
  EXECUTE replace(definition,old_condition,new_condition);
 END IF;
 -- Real PostgreSQL three-valued logic regression, no fake failed plan and no provider dispatch.
 IF (false OR NULL::text NOT IN('provider_denied','lease_expired_before_provider_dispatch')OR NOT NULL::boolean) IS NOT NULL THEN RAISE EXCEPTION 'baseline_null_behavior_changed';END IF;
 IF (false OR NULL::text IS NULL OR NULL::text NOT IN('provider_denied','lease_expired_before_provider_dispatch')OR NULL::boolean IS DISTINCT FROM true) IS DISTINCT FROM true THEN RAISE EXCEPTION 'missing_evidence_not_rejected';END IF;
 IF (false OR 'unexpected'::text IS NULL OR 'unexpected'::text NOT IN('provider_denied','lease_expired_before_provider_dispatch')OR true IS DISTINCT FROM true) IS DISTINCT FROM true THEN RAISE EXCEPTION 'unknown_code_not_rejected';END IF;
 IF (false OR 'provider_denied'::text IS NULL OR 'provider_denied'::text NOT IN('provider_denied','lease_expired_before_provider_dispatch')OR true IS DISTINCT FROM true) IS DISTINCT FROM false THEN RAISE EXCEPTION 'valid_evidence_spuriously_rejected';END IF;
END $patch$;
COMMIT;
