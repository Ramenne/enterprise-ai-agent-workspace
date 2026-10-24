BEGIN;
CREATE TABLE IF NOT EXISTS authz.database_effects(
 actor_id uuid NOT NULL,client_id uuid NOT NULL,idempotency_key text NOT NULL,
 request_hash text NOT NULL,permission_id uuid NOT NULL REFERENCES authz.database_permissions(id),
 result jsonb,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 PRIMARY KEY(actor_id,client_id,idempotency_key));
REVOKE ALL ON authz.database_effects FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON authz.database_effects TO hub2_hufu;
CREATE OR REPLACE FUNCTION authz.database_audit(proof text,b jsonb,p_action text,p_count integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE a jsonb;
BEGIN
 a:=authz.database_access(proof,b,p_action);
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((a->>'actor_id')::uuid,(a->>'client_id')::uuid,'database',p_action,(a->>'permission_id')::uuid,jsonb_build_object('schema',b->>'schema','table',b->>'table','affected_rows',p_count));
END $$;
REVOKE ALL ON FUNCTION authz.database_audit(text,jsonb,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.database_audit(text,jsonb,text,integer) TO hub2_hufu;
COMMIT;
