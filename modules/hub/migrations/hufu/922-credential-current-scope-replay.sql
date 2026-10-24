-- Response enrichment only. Keep current issuance/family/issuer/replay rules,
-- raw request digest, immutable operation receipt and delivered logical key.
DO $current_scope$
DECLARE definition text;old_return text;new_return text;
BEGIN
 definition:=pg_get_functiondef('authz.manage(text,text,jsonb,text,text)'::regprocedure);
 IF position('current_effective_scope_filters' in definition)>0 THEN RETURN;END IF;
 old_return:=$old$RETURN old.result||jsonb_build_object('credential_delivery','available');$old$;
 new_return:=$new$IF p_command='credential.create' THEN
    RETURN old.result||jsonb_build_object('credential_delivery','available','current_effective_scope_filters',coalesce((SELECT clauses FROM authz.client_filters745 WHERE client_id=q_credential.client_id),'[]'::jsonb),'scope_metadata_source','current_client_filters');
   END IF;
   RETURN old.result||jsonb_build_object('credential_delivery','available');$new$;
 IF position(old_return in definition)=0 OR position('RETURN result;' in definition)=0 THEN RAISE EXCEPTION 'manage_source_changed_read_current_definition' USING ERRCODE='40001';END IF;
 definition:=replace(definition,old_return,new_return);
 definition:=replace(definition,'RETURN result;',$new$IF p_command='credential.create' THEN RETURN result||jsonb_build_object('current_effective_scope_filters',coalesce((SELECT clauses FROM authz.client_filters745 WHERE client_id=cid),'[]'::jsonb),'scope_metadata_source','current_client_filters');END IF;
 RETURN result;$new$);
 EXECUTE definition;
END $current_scope$;
