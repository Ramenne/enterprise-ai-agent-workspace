-- Discover only currently readable nonsecret facts. Cursor is a live key, not authority.
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.provider_capabilities_enumerate(p_hash text,b jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE pid uuid;aid uuid;page_limit integer:=100;after_key text;identity jsonb;c authz.provider_capabilities62;visible jsonb:='[]';items jsonb;total bigint;remaining bigint;last_key text;ended boolean;
BEGIN
 IF b IS NULL OR jsonb_typeof(b)<>'object'OR b-ARRAY['project_id','area_id','limit','cursor']<>'{}'::jsonb OR NOT b?'project_id' THEN RAISE EXCEPTION 'provider_catalog_invalid';END IF;
 pid:=(b->>'project_id')::uuid;aid:=(b->>'area_id')::uuid;
 IF b?'limit'THEN IF jsonb_typeof(b->'limit')<>'number'OR(b->>'limit')!~'^[0-9]+$'THEN RAISE EXCEPTION 'provider_catalog_invalid';END IF;page_limit:=(b->>'limit')::integer;END IF;
 IF page_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'provider_catalog_invalid';END IF;
 IF b?'cursor'THEN IF jsonb_typeof(b->'cursor')<>'string'OR length(b->>'cursor')NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'provider_catalog_invalid';END IF;after_key:=b->>'cursor';END IF;
 -- guard62 enforces identity/family, project state and client resource.read ceiling
 -- even on empty catalogs. Project-wide denial alone does not exclude area readers.
 BEGIN identity:=authz.provider_catalog_guard62(p_hash,pid,aid,false);
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'provider_catalog_scope_denied'OR aid IS NOT NULL THEN RAISE;END IF;END;
 -- Never LIMIT before checking each candidate's current area qualification.
 FOR c IN SELECT * FROM authz.provider_capabilities62 WHERE project_id=pid AND(aid IS NULL OR area_id=aid)ORDER BY provider_id COLLATE "C" LOOP
  BEGIN
   identity:=authz.provider_catalog_guard62(p_hash,pid,c.area_id,false);
   visible:=visible||jsonb_build_array(to_jsonb(c)||jsonb_build_object('state','registered_facts','execution_permission_granted',false,'plaintext_credential_returned',false));
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
 END LOOP;
 total:=jsonb_array_length(visible);
 SELECT count(*)INTO remaining FROM jsonb_array_elements(visible)v WHERE after_key IS NULL OR(v->>'provider_id')COLLATE "C">after_key COLLATE "C";
 SELECT coalesce(jsonb_agg(v ORDER BY(v->>'provider_id')COLLATE "C"),'[]'::jsonb)INTO items FROM(SELECT v FROM jsonb_array_elements(visible)v WHERE after_key IS NULL OR(v->>'provider_id')COLLATE "C">after_key COLLATE "C" ORDER BY(v->>'provider_id')COLLATE "C" LIMIT page_limit)page;
 ended:=remaining<=page_limit;last_key:=items->(jsonb_array_length(items)-1)->>'provider_id';
 RETURN jsonb_build_object('state','enumerated','project_id',pid,'area_id',aid,'items',items,'total_visible',total,'returned',jsonb_array_length(items),'end',ended,'cursor',CASE WHEN ended THEN NULL ELSE last_key END,'consistency','current_authorized_live','coverage',jsonb_build_object('scope','currently_readable_catalog_records','total_visible',total,'complete',ended,'filtered_before_pagination',true,'snapshot',false),'execution_permission_granted',false,'plaintext_credential_returned',false);
END $$;
REVOKE ALL ON FUNCTION authz.provider_capabilities_enumerate(text,jsonb)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.provider_capabilities_enumerate(text,jsonb)TO hub2_hufu;
RESET ROLE;
