-- Guarded V8 calls only these read-only Hufu predicates, not their
-- internal helper chain. Authority logic stays in the original functions.
SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.v8_qualification_deadline(qid uuid,p_actor uuid,p_project uuid,p_action text,r jsonb) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,authz AS $$ SELECT authz.qualification_deadline(qid,p_actor,p_project,p_action,r) $$;
CREATE OR REPLACE FUNCTION authz.v8_management_valid(qid uuid,p_actor uuid,p_project uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,authz AS $$ SELECT authz.management_valid(qid,p_actor,p_project) $$;
REVOKE ALL ON FUNCTION authz.v8_qualification_deadline(uuid,uuid,uuid,text,jsonb),authz.v8_management_valid(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.v8_qualification_deadline(uuid,uuid,uuid,text,jsonb),authz.v8_management_valid(uuid,uuid,uuid) TO hub2_v8_owner;
REVOKE EXECUTE ON FUNCTION authz.qualification_deadline(uuid,uuid,uuid,text,jsonb),authz.management_valid(uuid,uuid,uuid) FROM hub2_v8_owner;
RESET ROLE;
