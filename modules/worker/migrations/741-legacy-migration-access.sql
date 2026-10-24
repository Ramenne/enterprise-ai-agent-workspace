-- Shared legacy migration lookup and internal scoped inventory.
-- Minimal glue for current670; Root assigns final migration number.
-- Internal trusted connector only, no MCP/public endpoint for raw proof booleans.
-- Its active scope was registered under current actor/project/source authority.
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.legacy_inventory_item(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;s mem.legacy_import_scopes;x jsonb:=b->'item';v mem.content_versions;
BEGIN
 IF payload IS NULL OR encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch';END IF;
 c:=mem.guard(h,'mem.process',d,b);
 SELECT *INTO s FROM mem.legacy_import_scopes WHERE id=(b->>'import_scope_id')::uuid FOR UPDATE;
 IF s.id IS NULL OR NOT s.active OR s.expires_at<=clock_timestamp()OR s.actor_id IS DISTINCT FROM(c->>'actor_id')::uuid
 OR s.project_id IS DISTINCT FROM(c->>'project_id')::uuid OR s.source_system IS DISTINCT FROM b->>'source_system'
 OR NOT(coalesce(x->>'category','')=ANY(s.categories))THEN RAISE EXCEPTION 'current_legacy_import_scope_required';END IF;
 SELECT cv.*INTO v FROM mem.content_versions cv JOIN mem.materials m ON m.id=cv.material_id WHERE cv.material_id=(x->>'target_material_id')::uuid
 AND cv.id=(b->'fixed_ref'->>'version_id')::uuid AND m.project_id=s.project_id AND cv.sha256=b->'fixed_ref'->>'sha256'AND cv.size=(b->'fixed_ref'->>'size')::bigint;
 IF v.id IS NULL OR coalesce(x->>'source_id','')='' OR coalesce(x->>'field_path','')='' OR coalesce(x->>'source_record_sha256','')!~'^[a-f0-9]{64}$'
 OR(x->>'original_content_sha256'IS NOT NULL AND x->>'original_content_sha256'IS DISTINCT FROM v.sha256)THEN RAISE EXCEPTION 'published_original_identity_required';END IF;
 PERFORM mem.assert_version_sources(h,v.id,'mem.read');PERFORM authz.assert_effect(h);
 UPDATE mem.legacy_import_scopes SET source_inventory=coalesce((SELECT jsonb_agg(e)FROM jsonb_array_elements(source_inventory)e
  WHERE NOT(e->>'category'=x->>'category'AND e->>'source_id'=x->>'source_id'AND e->>'field_path'=x->>'field_path')),'[]')||jsonb_build_array(x),revision=revision+1 WHERE id=s.id;
 RETURN jsonb_build_object('import_scope_id',s.id,'source_inventory_item_registered',true,'whole_snapshot_claimed',false);
END $$;
REVOKE ALL ON FUNCTION mem.legacy_inventory_item(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.legacy_inventory_item(uuid,text,text)TO hub2_mem;
RESET ROLE;

-- Original current670 extension. Root assigns migration number; no imported rows.
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.legacy_binding_lookup(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;r mem.legacy_reference_bindings;v mem.content_versions;
BEGIN
 IF payload IS NULL OR encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch';END IF;c:=mem.guard(h,'mem.read',d,b);
 SELECT *INTO r FROM mem.legacy_reference_bindings WHERE project_id=(c->>'project_id')::uuid AND source_system=b->>'source_system'
 AND category=coalesce(b->>'category','file_alias')AND source_id=b->>'source_id'AND field_path=b->>'field_path'
 AND(actor_id=(c->>'actor_id')::uuid OR(b->'actor_namespace'='false'::jsonb AND visibility='project'))
 ORDER BY(actor_id=(c->>'actor_id')::uuid)DESC,updated_at DESC,id LIMIT 1;
 IF r.id IS NULL THEN RETURN jsonb_build_object('state','not_bound');END IF;
 SELECT cv.*INTO v FROM mem.content_versions cv WHERE cv.material_id=r.target_material_id AND cv.id=CASE WHEN r.reference_kind='fixed'THEN r.target_version_id ELSE(SELECT current_version_id FROM mem.materials WHERE id=r.target_material_id)END;
 IF v.id IS NOT NULL THEN PERFORM mem.description_bind_sources(h,jsonb_build_array(jsonb_build_object('material_id',v.material_id,'version_id',v.id,'sha256',v.sha256)),(c->>'actor_id')::uuid);END IF;
 PERFORM authz.assert_effect(h);RETURN jsonb_build_object('binding_id',r.id,'revision',r.revision,'reference_kind',r.reference_kind,
 'fixed_ref',CASE WHEN v.id IS NOT NULL THEN jsonb_build_object('material_id',v.material_id,'version_id',v.id,'sha256',v.sha256,'size',v.size)END);
END $$;
CREATE FUNCTION mem.legacy_import_receipt(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;r mem.command_receipts;x jsonb;
BEGIN
 IF payload IS NULL OR encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch';END IF;c:=mem.guard(h,'mem.process',d,b);
 SELECT *INTO r FROM mem.command_receipts WHERE actor_id=(c->>'actor_id')::uuid AND action='legacy_reference_import'AND idempotency_key=b->>'original_idempotency_key';
 IF r.actor_id IS NULL THEN RETURN jsonb_build_object('state','receipt_not_observed','no_effect_proven',false);END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(r.result->'items')LOOP
  IF NOT EXISTS(SELECT FROM mem.legacy_reference_bindings WHERE id=(x->>'binding_id')::uuid AND project_id=(c->>'project_id')::uuid AND actor_id=(c->>'actor_id')::uuid)THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 END LOOP;
 PERFORM authz.assert_effect(h);RETURN r.result;
END $$;
REVOKE ALL ON FUNCTION mem.legacy_binding_lookup(uuid,text,text),mem.legacy_import_receipt(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.legacy_binding_lookup(uuid,text,text),mem.legacy_import_receipt(uuid,text,text)TO hub2_mem;
RESET ROLE;
