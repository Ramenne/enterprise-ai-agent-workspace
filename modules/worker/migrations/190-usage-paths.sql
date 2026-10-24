SET ROLE hub2_evidence_owner;
CREATE OR REPLACE FUNCTION evidence.record_usage(request uuid,action text,schema_version text,source uuid,traffic text,success boolean,coverage text,result_count bigint,duration_ms double precision,paths jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
#variable_conflict use_variable
DECLARE service text;item jsonb;existing evidence.logical_requests;
BEGIN
 service:=CASE session_user WHEN 'hub2_mem' THEN 'mem' WHEN 'hub2_v8' THEN 'v8' WHEN 'hub2_hufu' THEN 'hufu' ELSE NULL END;
 IF service IS NULL OR request IS NULL OR action IS NULL OR length(action) NOT BETWEEN 1 AND 100 OR schema_version IS NULL OR length(schema_version) NOT BETWEEN 1 AND 100 OR traffic IS NULL OR success IS NULL OR coverage IS NULL OR paths IS NULL OR jsonb_typeof(paths)<>'array' OR jsonb_array_length(paths)>200 THEN RAISE EXCEPTION 'invalid_usage_input' USING ERRCODE='42501';END IF;
 INSERT INTO evidence.logical_requests(request_id,service,action,schema_version,source_context_id,traffic_kind,success,coverage,result_count,duration_ms) VALUES(request,service,action,schema_version,source,traffic,success,coverage,result_count,duration_ms) ON CONFLICT DO NOTHING;
 SELECT * INTO existing FROM evidence.logical_requests r WHERE r.request_id=request AND r.service=service AND r.action=action;
 IF existing.schema_version IS DISTINCT FROM schema_version OR existing.source_context_id IS DISTINCT FROM source OR existing.traffic_kind IS DISTINCT FROM traffic THEN RAISE EXCEPTION 'logical_request_identity_conflict' USING ERRCODE='23505';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(paths) LOOP
  IF jsonb_typeof(item)<>'object' OR item-'path'-'purpose'<>'{}'::jsonb OR item->>'purpose' IS NULL OR item->>'purpose' NOT IN ('filter','sort','return','write') OR item->>'path' IS NULL OR length(item->>'path') NOT BETWEEN 1 AND 240 OR item->>'path' ~ '[[:cntrl:]]' OR item->>'path' ~ '\[[0-9]+\]' THEN RAISE EXCEPTION 'invalid_canonical_field_path';END IF;
  INSERT INTO evidence.field_usage(request_id,service,action,path,purpose,schema_version,source_context_id,occurred_at) VALUES(request,service,action,item->>'path',item->>'purpose',schema_version,source,existing.occurred_at) ON CONFLICT DO NOTHING;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION evidence.record_usage(uuid,text,text,uuid,text,boolean,text,bigint,double precision,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.record_usage(uuid,text,text,uuid,text,boolean,text,bigint,double precision,jsonb) TO hub2_mem_owner,hub2_v8_owner,hub2_authz_owner,hub2_mem,hub2_v8,hub2_hufu;
RESET ROLE;
