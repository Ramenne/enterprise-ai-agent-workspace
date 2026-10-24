BEGIN;
SET ROLE hub2_v8_owner;
DO $$BEGIN
 IF to_regprocedure('v8.authorized_ref_uncached_v141(uuid,jsonb,jsonb)') IS NULL THEN
  ALTER FUNCTION v8.authorized_ref(uuid,jsonb,jsonb) RENAME TO authorized_ref_uncached_v141;
 END IF;
END$$;
-- Memoization is scoped to one transaction and exact handle/context/reference.
-- The original function still binds each distinct source; final assert_effect
-- rechecks its live authority. No permission/result is retained across requests.
CREATE OR REPLACE FUNCTION v8.authorized_ref(handle uuid,context jsonb,reference jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE memo jsonb;key text;answer boolean;
BEGIN
 key:=encode(public.digest(jsonb_build_array(handle,context,reference)::text,'sha256'),'hex');
 memo:=coalesce(nullif(current_setting('employeeclient.authorized_refs_v141',true),''),'{}')::jsonb;
 IF memo?key THEN RETURN (memo->>key)::boolean;END IF;
 answer:=v8.authorized_ref_uncached_v141(handle,context,reference);
 IF length(memo::text)<131072 THEN PERFORM set_config('employeeclient.authorized_refs_v141',(memo||jsonb_build_object(key,answer))::text,true);END IF;
 RETURN answer;
END$$;
REVOKE ALL ON FUNCTION v8.authorized_ref(uuid,jsonb,jsonb) FROM PUBLIC,hub2_v8,hub2_hufu,hub2_mem;
GRANT EXECUTE ON FUNCTION v8.authorized_ref(uuid,jsonb,jsonb) TO hub2_v8_owner;
RESET ROLE;
COMMIT;