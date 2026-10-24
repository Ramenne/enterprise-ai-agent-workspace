-- A read-only client can inspect its producer's own durable draft without receiving upload authority.
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.text_draft_read(h uuid,d text,payload text,chunk boolean) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb;c jsonb;r mem.text_drafts;op mem.operations;root record;ref jsonb;candidate text;visible boolean:=true;known integer:=0;hidden integer:=0;refs uuid[]:='{}';vid uuid;receipt jsonb;source jsonb;properties jsonb;result jsonb;bytes bytea;part bytea;total bigint;start_byte bigint;end_byte bigint;limit_n integer;preview text;partial boolean;draft_hash text;
BEGIN
 IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;c:=mem.guard(h,'mem.read',d,b);
 SELECT * INTO r FROM mem.text_drafts WHERE id=(b->>'resume_id')::uuid AND actor_id=(c->>'actor_id')::uuid AND project_id=(c->>'project_id')::uuid;
 IF r.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 -- A material-scoped read handle may not be used to inspect an unrelated project-level or material draft.
 IF b->>'material_id' IS NOT NULL AND b->>'material_id' IS DISTINCT FROM r.body->>'material_id' THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 IF r.body->>'material_id' IS NOT NULL THEN PERFORM authz.assert_request_resource(h,jsonb_build_object('project_id',r.project_id,'material_id',r.body->>'material_id'));END IF;
 -- Real typed source claims are guarded. No source claims, unknown coverage and missing semantic enrichment remain readable.
 BEGIN
  FOR root IN SELECT * FROM authz.request_roots(r.body,'mem.read') LOOP refs:=array_append(refs,root.version_id);END LOOP;
 EXCEPTION WHEN insufficient_privilege THEN visible:=false;hidden:=hidden+1;END;
 -- An explicitly claimed actual source with a real version ID is still a real authority boundary,
 -- even while its material/hash enrichment is incomplete. Unresolved claims remain unknown.
 IF jsonb_typeof(r.body->'source'->'actual_inputs')='array' THEN
  FOR ref IN SELECT value FROM jsonb_array_elements(r.body->'source'->'actual_inputs') LOOP
   candidate:=CASE WHEN jsonb_typeof(ref)='object' THEN ref->>'version_id' WHEN jsonb_typeof(ref)='string' THEN ref#>>'{}' ELSE NULL END;
   IF candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT id INTO vid FROM mem.content_versions WHERE id=candidate::uuid;
    IF vid IS NOT NULL THEN refs:=array_append(refs,vid);END IF;
   END IF;
  END LOOP;
 END IF;
 IF r.body->>'base_version_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  SELECT id INTO vid FROM mem.content_versions WHERE id=(r.body->>'base_version_id')::uuid;
  IF vid IS NOT NULL THEN refs:=array_append(refs,vid);END IF;
 END IF;
 FOR vid IN SELECT DISTINCT unnest(refs) LOOP
  known:=known+1;
  BEGIN PERFORM mem.assert_version_sources(h,vid,'mem.read');
  EXCEPTION WHEN insufficient_privilege THEN visible:=false;hidden:=hidden+1;END;
 END LOOP;
 SELECT * INTO op FROM mem.operations WHERE actor_id=r.actor_id AND idempotency_key IN ('text:'||r.id,'text:'||r.id||':new') ORDER BY created_at DESC LIMIT 1;
 result:=jsonb_build_object('operation_id',r.id,'resume_id',r.id,'idempotency_key',r.idempotency_key,'state',COALESCE(op.state,'draft_retained'),'text_visibility',CASE WHEN visible THEN 'current_authorized' ELSE 'source_access_restricted' END,'source_completeness','not_inferred','source_access',jsonb_build_object('known_fixed_sources',known,'hidden_sources',hidden),'retained_state','durable_text_draft','publication_state','not_inferred_from_draft','next_step',CASE WHEN visible THEN 'read_own_draft_or_resume_with_existing_upload_authority' ELSE 'inspect_own_status_and_restore_source_authority_before_reading_original_text' END);
 IF NOT visible THEN PERFORM authz.assert_effect(h);RETURN result||jsonb_build_object('text',NULL,'source',jsonb_build_object('state','source_access_restricted'),'coverage','own_status_only_source_access_restricted');END IF;
 bytes:=convert_to(r.body->>'text','UTF8');total:=octet_length(bytes);draft_hash:=encode(public.digest(bytes,'sha256'),'hex');
 result:=result||jsonb_build_object('sha256',draft_hash,'size',total,'draft_ref',jsonb_build_object('resume_id',r.id,'sha256',draft_hash,'size',total,'kind','durable_text_draft'));
 IF chunk THEN
  start_byte:=COALESCE((b->>'offset')::bigint,0);limit_n:=COALESCE((b->>'limit')::integer,32768);
  IF start_byte<0 OR start_byte>total OR limit_n NOT BETWEEN 1 AND 32768 THEN RAISE EXCEPTION 'invalid_range';END IF;
  end_byte:=least(total,start_byte+limit_n);part:=substring(bytes FROM start_byte::integer+1 FOR (end_byte-start_byte)::integer);
  PERFORM authz.assert_effect(h);
  RETURN result||jsonb_build_object('bytes_base64',replace(encode(part,'base64'),E'\n',''),'chunk_sha256',encode(public.digest(part,'sha256'),'hex'),'range',jsonb_build_object('start',start_byte,'end_exclusive',end_byte),'next_offset',CASE WHEN end_byte<total THEN end_byte ELSE NULL END,'coverage',CASE WHEN start_byte=0 AND end_byte=total THEN 'whole_draft_original' ELSE 'partial_draft_original' END);
 END IF;
 receipt:=CASE WHEN op.receipt IS NOT NULL THEN mem.processing_safe_json(h,op.receipt) ELSE NULL END;
 properties:=mem.processing_safe_json(h,COALESCE(r.body->'properties','{}'));
 source:=mem.processing_safe_json(h,COALESCE(r.body->'source',jsonb_build_object('state','unknown')));
 partial:=octet_length(to_jsonb(r.body->>'text')::text)>131072;preview:=CASE WHEN partial THEN left(r.body->>'text',4096) ELSE r.body->>'text' END;
 result:=result||jsonb_build_object('receipt',receipt,'text',preview,'text_partial',partial,'properties',properties,'source',source,'coverage',CASE WHEN partial THEN 'partial_draft_preview' ELSE 'own_declared_draft_text' END);
 -- Leave headroom for the MCP envelope. Text expansion is always a real, same-authority byte endpoint.
 IF octet_length(result::text)>196608 THEN
  partial:=true;preview:=left(r.body->>'text',4096);
  result:=result||jsonb_build_object('text',preview,'text_partial',true,'properties','{}'::jsonb,'source',jsonb_build_object('state','large_metadata_retained'),'receipt',NULL,'metadata_partial',true,'coverage','partial_draft_preview');
 END IF;
 IF partial THEN result:=result||jsonb_build_object('range',jsonb_build_object('start',0,'end_exclusive',octet_length(convert_to(preview,'UTF8'))),'next_offset',octet_length(convert_to(preview,'UTF8')),'read_chunk',jsonb_build_object('tool','mem.write_text.read_chunk','path','/v2/materials/write-text/read-chunk','arguments',jsonb_build_object('project_id',r.project_id,'resume_id',r.id,'offset',0,'limit',32768),'max_limit',32768),'next_step','read_text_draft_chunks_for_exact_original_bytes');END IF;
 PERFORM authz.assert_effect(h);RETURN result;
END $$;
CREATE FUNCTION mem.read_text_draft(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$ BEGIN RETURN mem.text_draft_read(h,d,payload,false);END $$;
CREATE FUNCTION mem.read_text_draft_chunk(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$ BEGIN RETURN mem.text_draft_read(h,d,payload,true);END $$;
REVOKE ALL ON FUNCTION mem.text_draft_read(uuid,text,text,boolean),mem.read_text_draft(uuid,text,text),mem.read_text_draft_chunk(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.read_text_draft(uuid,text,text),mem.read_text_draft_chunk(uuid,text,text) TO hub2_mem;
RESET ROLE;
