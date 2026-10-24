BEGIN;
DO $$ BEGIN
 IF to_regprocedure('authz.database_scope_subset_before_sqlite(jsonb,jsonb)') IS NULL THEN ALTER FUNCTION authz.database_scope_subset(jsonb,jsonb) RENAME TO database_scope_subset_before_sqlite;END IF;
END $$;
CREATE OR REPLACE FUNCTION authz.database_scope_subset(chosen jsonb,requested jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,authz AS $$
 SELECT CASE WHEN EXISTS(SELECT FROM jsonb_array_elements(chosen) x WHERE x->>'backend'='sqlite') THEN
 jsonb_array_length(chosen)>0 AND NOT EXISTS(SELECT FROM jsonb_array_elements(chosen) c WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(requested) r WHERE c->>'backend'='sqlite' AND r->>'backend'='sqlite' AND c->>'target_id'=r->>'target_id' AND c->>'schema'=r->>'schema' AND c->>'table'=r->>'table' AND c->>'fingerprint'=r->>'fingerprint'  AND (c->'actions')<@(r->'actions') AND (c->>'data_scope'='structure_only' OR c->>'data_scope'=r->>'data_scope')))
 ELSE authz.database_scope_subset_before_sqlite(chosen,requested) END
$$;
REVOKE ALL ON FUNCTION authz.database_scope_subset(jsonb,jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION authz.database_sqlite_effect_prepare(proof text,b jsonb,digest_ text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE permit jsonb;r authz.database_effects;created_count int;
BEGIN
 permit:=authz.database_sqlite_permit(proof,b);
 IF length(coalesce(b->>'idempotency_key','')) NOT BETWEEN 1 AND 200 OR digest_ !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE='22023';END IF;
 INSERT INTO authz.database_effects(actor_id,client_id,idempotency_key,request_hash,permission_id) VALUES((permit->>'actor_id')::uuid,(permit->>'client_id')::uuid,b->>'idempotency_key',digest_,(permit->>'permission_id')::uuid) ON CONFLICT DO NOTHING;GET DIAGNOSTICS created_count=ROW_COUNT;
 SELECT * INTO r FROM authz.database_effects WHERE actor_id=(permit->>'actor_id')::uuid AND client_id=(permit->>'client_id')::uuid AND idempotency_key=b->>'idempotency_key';
 IF r.request_hash<>digest_ THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;
 RETURN jsonb_build_object('state',CASE WHEN created_count>0 THEN 'dispatch_once' WHEN r.result IS NOT NULL THEN 'known' ELSE 'effect_unknown' END,'result',r.result,'permit',permit,'operation_id',r.idempotency_key);
END $$;
CREATE OR REPLACE FUNCTION authz.database_sqlite_effect_finish(proof text,b jsonb,digest_ text,meta jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;clean jsonb;r authz.database_effects;
BEGIN
 i:=authz.authenticate(proof);
 clean:=jsonb_build_object('state',meta->>'state','error_code',meta->>'error_code','affected_rows',meta->'affected_rows','actions',meta->'actions','coverage',meta->'coverage','result_rows_omitted',true,'operation_id',b->>'idempotency_key');
 UPDATE authz.database_effects SET result=clean,finished_at=clock_timestamp() WHERE actor_id=(i->>'actor_id')::uuid AND client_id=(i->>'client_id')::uuid AND idempotency_key=b->>'idempotency_key' AND request_hash=digest_ AND result IS NULL RETURNING * INTO r;
 IF r.idempotency_key IS NULL THEN RAISE EXCEPTION 'effect_record_required' USING ERRCODE='40001';END IF;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','database.sqlite.execute',r.permission_id,jsonb_build_object('query_hash',digest_,'schema',b->>'schema','affected_rows',clean->'affected_rows','actions',clean->'actions','operation_id',r.idempotency_key));
 RETURN clean;
END $$;
REVOKE ALL ON FUNCTION authz.database_sqlite_effect_prepare(text,jsonb,text),authz.database_sqlite_effect_finish(text,jsonb,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.database_sqlite_effect_prepare(text,jsonb,text),authz.database_sqlite_effect_finish(text,jsonb,text,jsonb) TO hub2_hufu;
-- Keep the existing authorization owner and private call chain. No PUBLIC/superuser grants.
ALTER FUNCTION authz.database_scope_subset(jsonb,jsonb) OWNER TO hub2_authz_owner;
ALTER FUNCTION authz.database_sqlite_effect_prepare(text,jsonb,text) OWNER TO hub2_authz_owner;
ALTER FUNCTION authz.database_sqlite_effect_finish(text,jsonb,text,jsonb) OWNER TO hub2_authz_owner;
GRANT EXECUTE ON FUNCTION authz.database_scope_subset_before_sqlite(jsonb,jsonb) TO hub2_authz_owner;
GRANT SELECT,INSERT,UPDATE ON authz.database_effects TO hub2_authz_owner;
COMMIT;
