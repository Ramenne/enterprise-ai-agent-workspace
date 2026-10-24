-- Scope transition preserves material/version/object identity. No provider effect or new grants.
GRANT EXECUTE ON FUNCTION mem.source_closure(uuid)TO hub2_authz_owner;
SET ROLE hub2_authz_owner;
GRANT SELECT ON authz.resource_areas TO hub2_mem_owner;
GRANT REFERENCES ON authz.resource_areas TO hub2_mem_owner;
CREATE TABLE authz.material_move_fences(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),transaction_id xid8 NOT NULL,source_handle uuid NOT NULL,share_handle uuid NOT NULL,target_handle uuid NOT NULL,material_id uuid NOT NULL,source_project uuid NOT NULL,target_project uuid NOT NULL,deadline timestamptz NOT NULL,closure_facts jsonb NOT NULL,used boolean NOT NULL DEFAULT false);
REVOKE ALL ON authz.material_move_fences FROM PUBLIC,hub2_mem,hub2_v8,hub2_worker,hub2_hufu;
CREATE FUNCTION authz.material_move_capture(source_handle uuid,share_handle uuid,target_handle uuid,material uuid,digest text)RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE s authz.handles;sh authz.handles;t authz.handles;fid uuid;facts jsonb;resources jsonb;
BEGIN
 IF authz.runtime_role()IS DISTINCT FROM'hub2_mem'THEN RAISE EXCEPTION 'move_runtime_forbidden' USING ERRCODE='42501';END IF;
 SELECT * INTO s FROM authz.handles WHERE id=source_handle;SELECT * INTO sh FROM authz.handles WHERE id=share_handle;SELECT * INTO t FROM authz.handles WHERE id=target_handle;
 IF s.consumed_xid IS DISTINCT FROM pg_current_xact_id()OR sh.consumed_xid IS DISTINCT FROM s.consumed_xid OR t.consumed_xid IS DISTINCT FROM s.consumed_xid OR s.action IS DISTINCT FROM'mem.write'OR sh.action IS DISTINCT FROM'mem.share'OR t.action IS DISTINCT FROM'mem.write'OR s.request_digest IS DISTINCT FROM digest OR sh.request_digest IS DISTINCT FROM digest OR t.request_digest IS DISTINCT FROM digest OR(s.principal_id,s.client_id,s.credential_id)IS DISTINCT FROM(sh.principal_id,sh.client_id,sh.credential_id)OR(s.principal_id,s.client_id,s.credential_id)IS DISTINCT FROM(t.principal_id,t.client_id,t.credential_id)OR s.project_id IS DISTINCT FROM sh.project_id OR s.project_id=t.project_id OR NOT EXISTS(SELECT FROM mem.materials WHERE id=material AND project_id=s.project_id)THEN RAISE EXCEPTION 'exact_current_move_handles_required' USING ERRCODE='42501';END IF;
 SELECT jsonb_agg(resource)INTO resources FROM(SELECT resource FROM authz.handle_sources WHERE handle_id=ANY(ARRAY[s.id,sh.id,t.id])UNION SELECT coalesce(resource->'resolved_resource',resource)FROM authz.handles WHERE id=ANY(ARRAY[s.id,sh.id,t.id]))rr;PERFORM authz.lock_resources(s.principal_id,s.client_id,s.credential_id,resources);PERFORM ar.id FROM authz.resource_areas ar WHERE ar.id IN(SELECT p.area_id FROM mem.placements p WHERE p.material_id=material AND p.active)OR ar.id IN(SELECT p.area_id FROM authz.handle_sources hs JOIN mem.placements p ON p.material_id=(hs.resource->>'material_id')::uuid WHERE hs.handle_id=ANY(ARRAY[s.id,sh.id,t.id])AND p.active)ORDER BY ar.id FOR SHARE;
 PERFORM authz.assert_effect(s.id);PERFORM authz.assert_effect(sh.id);PERFORM authz.assert_effect(t.id);
 SELECT coalesce(jsonb_agg(jsonb_build_object('version_id',v.id,'sha256',v.sha256,'size',v.size,'material_id',m.id,'project_id',m.project_id)ORDER BY v.id),'[]')INTO facts FROM mem.content_versions v JOIN mem.materials m ON m.id=v.material_id WHERE v.id IN(SELECT closure.version_id FROM mem.content_versions root CROSS JOIN LATERAL mem.source_closure(root.id)closure WHERE root.material_id=material);
 INSERT INTO authz.material_move_fences(transaction_id,source_handle,share_handle,target_handle,material_id,source_project,target_project,deadline,closure_facts)VALUES(pg_current_xact_id(),s.id,sh.id,t.id,material,s.project_id,t.project_id,least(s.expires_at,sh.expires_at,t.expires_at),facts)RETURNING id INTO fid;RETURN fid;
END $$;
CREATE FUNCTION authz.material_move_final(fid uuid)RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE f authz.material_move_fences;h authz.handles;c authz.credentials;p authz.principals;cl authz.clients;r record;facts jsonb;
BEGIN
 SELECT * INTO f FROM authz.material_move_fences WHERE id=fid FOR UPDATE;
 IF authz.runtime_role()IS DISTINCT FROM'hub2_mem'OR f.id IS NULL OR f.used OR f.transaction_id IS DISTINCT FROM pg_current_xact_id()OR f.deadline<=clock_timestamp()OR NOT EXISTS(SELECT FROM mem.materials WHERE id=f.material_id AND project_id=f.target_project)THEN RAISE EXCEPTION 'move_transaction_fence_expired' USING ERRCODE='42501';END IF;
 FOR h IN SELECT * FROM authz.handles WHERE id=ANY(ARRAY[f.source_handle,f.share_handle,f.target_handle])LOOP
  SELECT * INTO c FROM authz.credentials WHERE id=h.credential_id;SELECT * INTO p FROM authz.principals WHERE id=h.principal_id;SELECT * INTO cl FROM authz.clients WHERE id=h.client_id;
  IF h.consumed_xid IS DISTINCT FROM f.transaction_id OR h.expires_at<=clock_timestamp()OR h.security_era IS DISTINCT FROM(SELECT era FROM authz.security_state)OR p.active IS DISTINCT FROM true OR cl.active IS DISTINCT FROM true OR c.revoked_at IS NOT NULL OR NOT authz.family_valid(c.id)OR p.epoch IS DISTINCT FROM h.principal_epoch OR cl.epoch IS DISTINCT FROM h.client_epoch OR c.epoch IS DISTINCT FROM h.credential_epoch OR(NOT c.until_revoked AND c.expires_at<=clock_timestamp())OR h.project_revision IS DISTINCT FROM authz.check_access(p.id,cl.id,h.project_id,h.action)THEN RAISE EXCEPTION 'move_current_authority_changed' USING ERRCODE='42501';END IF;
  -- Only the intentional self membership transition uses the already checked/locked Source qualification path.
  -- Upstream resources remain current; none are reclassified or made public by this move.
  FOR r IN SELECT * FROM authz.handle_sources WHERE handle_id=h.id LOOP
   IF(r.resource->>'material_id')::uuid IS DISTINCT FROM f.material_id THEN IF r.deadline<=clock_timestamp()OR r.project_revision IS DISTINCT FROM(SELECT revision FROM v8.projects WHERE id=r.project_id)THEN RAISE EXCEPTION 'move_upstream_epoch_changed' USING ERRCODE='42501';END IF;PERFORM authz.resource_deadline(h.principal_id,h.client_id,r.project_id,r.action,r.resource);END IF;
  END LOOP;
 END LOOP;
 PERFORM authz.assert_effect(f.target_handle);
 SELECT coalesce(jsonb_agg(jsonb_build_object('version_id',v.id,'sha256',v.sha256,'size',v.size,'material_id',m.id,'project_id',CASE WHEN m.id=f.material_id THEN f.source_project ELSE m.project_id END)ORDER BY v.id),'[]')INTO facts FROM mem.content_versions v JOIN mem.materials m ON m.id=v.material_id WHERE v.id IN(SELECT closure.version_id FROM mem.content_versions root CROSS JOIN LATERAL mem.source_closure(root.id)closure WHERE root.material_id=f.material_id);
 IF facts IS DISTINCT FROM f.closure_facts THEN RAISE EXCEPTION 'move_fixed_closure_changed' USING ERRCODE='40001';END IF;UPDATE authz.material_move_fences SET used=true WHERE id=f.id;
END $$;
REVOKE ALL ON FUNCTION authz.material_move_capture(uuid,uuid,uuid,uuid,text),authz.material_move_final(uuid)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.material_move_capture(uuid,uuid,uuid,uuid,text),authz.material_move_final(uuid)TO hub2_mem_owner;
RESET ROLE;
SET ROLE hub2_mem_owner;
ALTER TABLE mem.materials ADD scope_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE mem.placements ADD area_id uuid REFERENCES authz.resource_areas(id);
CREATE TABLE mem.scope_move_commands(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL,client_id uuid NOT NULL,material_id uuid NOT NULL REFERENCES mem.materials,source_project uuid NOT NULL,target_project uuid NOT NULL,idempotency_key text NOT NULL,fingerprint text NOT NULL,body jsonb NOT NULL,observed_source jsonb NOT NULL,state text NOT NULL,receipt jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(actor_id,idempotency_key));
REVOKE ALL ON mem.scope_move_commands FROM PUBLIC,hub2_mem,hub2_worker,hub2_v8,hub2_hufu;
CREATE FUNCTION mem.move_scope(h uuid,share_h uuid,target_h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;sc jsonb;tc jsonb;m mem.materials;placement mem.placements;old mem.scope_move_commands;fid uuid;oid uuid:=gen_random_uuid();result jsonb;v record;src uuid;dest uuid;reason text;group_id uuid:=gen_random_uuid();resources jsonb;observed jsonb;
BEGIN
 IF payload IS NULL OR encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d OR b-ARRAY['project_id','material_id','target_project_id','placement_id','expected_scope_revision','expected_content_revision','expected_version_id','expected_metadata_revision','expected_placement_revision','expected_target_project_revision','target_collection_id','target_area_id','logical_path','idempotency_key','mode','judgment']<>'{}'::jsonb OR coalesce(length(b->>'idempotency_key'),0)NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_move_scope';END IF;
 c:=mem.guard(h,'mem.write',d,b);src:=(c->>'project_id')::uuid;dest:=(b->>'target_project_id')::uuid;IF dest IS NULL OR dest=src THEN RAISE EXCEPTION 'distinct_target_scope_required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended((c->>'actor_id')||'mem.move_scope'||(b->>'idempotency_key'),0));SELECT * INTO old FROM mem.scope_move_commands WHERE actor_id=(c->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key';IF old.id IS NOT NULL THEN IF old.fingerprint IS DISTINCT FROM d THEN RAISE EXCEPTION 'move_logical_input_changed' USING ERRCODE='40001';END IF;IF old.state='moved'THEN PERFORM authz.assert_effect(h);RETURN old.receipt;END IF;oid:=old.id;END IF;
 SELECT * INTO m FROM mem.materials WHERE id=(b->>'material_id')::uuid AND project_id=src FOR UPDATE;IF m.id IS NULL THEN RAISE EXCEPTION 'move_source_scope_forbidden' USING ERRCODE='42501';END IF;
 SELECT * INTO placement FROM mem.placements WHERE id=(b->>'placement_id')::uuid AND material_id=m.id AND project_id=src AND active FOR UPDATE;IF placement.id IS NULL THEN RAISE EXCEPTION 'current_source_placement_required';END IF;
 observed:=coalesce(old.observed_source,jsonb_build_object('scope_revision',m.scope_revision,'content_revision',m.content_revision,'version_id',m.current_version_id,'metadata_revision',m.metadata_revision,'placement_revision',placement.revision,'logical_path',placement.logical_path,'collection_id',placement.collection_id,'area_id',placement.area_id,'target_project_revision',(SELECT revision FROM v8.projects WHERE id=dest)));
 IF m.scope_revision IS DISTINCT FROM coalesce((b->>'expected_scope_revision')::bigint,(observed->>'scope_revision')::bigint) OR m.content_revision IS DISTINCT FROM coalesce((b->>'expected_content_revision')::bigint,(observed->>'content_revision')::bigint) OR m.current_version_id IS DISTINCT FROM (CASE WHEN b?'expected_version_id'THEN(b->>'expected_version_id')::uuid ELSE(observed->>'version_id')::uuid END) OR m.metadata_revision IS DISTINCT FROM coalesce((b->>'expected_metadata_revision')::bigint,(observed->>'metadata_revision')::bigint) OR placement.revision IS DISTINCT FROM coalesce((b->>'expected_placement_revision')::bigint,(observed->>'placement_revision')::bigint) THEN reason:='source_CAS_changed';
 ELSIF EXISTS(SELECT FROM mem.operations WHERE material_id=m.id AND state NOT IN('published','cancelled','expired','rejected','conflict'))THEN reason:='active_upload_preserved';
 ELSIF EXISTS(SELECT FROM mem.processing_runs pr WHERE technical_state NOT IN('succeeded','cancelled')AND EXISTS(SELECT FROM jsonb_array_elements(pr.outputs||pr.inputs)x WHERE x->>'material_id'=m.id::text))THEN reason:='active_processing_preserved';
 ELSIF EXISTS(SELECT FROM mem.content_versions WHERE material_id=m.id AND provenance_state='pending')THEN reason:='unknown_source_draft';
 ELSIF coalesce(b->>'mode','execute')='proposal'THEN reason:='Agent_scope_proposal';
 ELSIF share_h IS NULL OR target_h IS NULL THEN reason:='current_share_and_destination_scope_needed';END IF;
 IF reason IS NOT NULL THEN result:=jsonb_build_object('operation_id',oid,'material_id',m.id,'state','draft','reason_code',reason,'source_scope_unchanged',true,'bytes_changed',false);INSERT INTO mem.scope_move_commands VALUES(oid,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,m.id,src,dest,b->>'idempotency_key',d,b,observed,'draft',result,clock_timestamp())ON CONFLICT(actor_id,idempotency_key)DO UPDATE SET receipt=excluded.receipt;PERFORM authz.assert_effect(h);RETURN result;END IF;
 sc:=authz.consume_handle(share_h,'mem.share',d);tc:=authz.consume_handle(target_h,'mem.write',d);IF(tc->>'project_id')::uuid IS DISTINCT FROM dest OR coalesce(tc->'resource'->'resolved_resource',tc->'resource')->>'collection_id'IS DISTINCT FROM b->>'target_collection_id'OR coalesce(tc->'resource'->'resolved_resource',tc->'resource')->>'area_id'IS DISTINCT FROM b->>'target_area_id'THEN RAISE EXCEPTION 'destination_handle_mismatch' USING ERRCODE='42501';END IF;
 -- Actual destination membership/region, not a caller label, controls placement authority.
 IF(b->>'target_collection_id'IS NOT NULL AND NOT EXISTS(SELECT FROM mem.collections WHERE id=(b->>'target_collection_id')::uuid AND project_id=dest))OR(b->>'target_area_id'IS NOT NULL AND NOT EXISTS(SELECT FROM authz.resource_areas WHERE id=(b->>'target_area_id')::uuid AND project_id=dest AND active))THEN RAISE EXCEPTION 'destination_location_forbidden' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT FROM v8.projects WHERE id=dest AND revision=coalesce((b->>'expected_target_project_revision')::bigint,(observed->>'target_project_revision')::bigint,revision))THEN RAISE EXCEPTION 'target_project_CAS_changed' USING ERRCODE='40001';END IF;
 PERFORM id FROM mem.materials WHERE id IN(SELECT cv.material_id FROM mem.content_versions root CROSS JOIN LATERAL mem.source_closure(root.id)closure JOIN mem.content_versions cv ON cv.id=closure.version_id WHERE root.material_id=m.id)ORDER BY id FOR SHARE;
 PERFORM id FROM mem.content_versions WHERE id IN(SELECT closure.version_id FROM mem.content_versions root CROSS JOIN LATERAL mem.source_closure(root.id)closure WHERE root.material_id=m.id)ORDER BY id FOR UPDATE;
 BEGIN
 FOR v IN SELECT id FROM mem.content_versions WHERE material_id=m.id ORDER BY id LOOP PERFORM mem.assert_version_sources(share_h,v.id,'mem.share');END LOOP;
 EXCEPTION WHEN insufficient_privilege THEN
 result:=jsonb_build_object('operation_id',oid,'material_id',m.id,'state','draft','reason_code','upstream_current_share_scope_needed','source_scope_unchanged',true,'bytes_changed',false);
 INSERT INTO mem.scope_move_commands VALUES(oid,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,m.id,src,dest,b->>'idempotency_key',d,b,observed,'draft',result,clock_timestamp())ON CONFLICT(actor_id,idempotency_key)DO UPDATE SET receipt=excluded.receipt;
 PERFORM authz.assert_effect(h);RETURN result;
 END;
 fid:=authz.material_move_capture(h,share_h,target_h,m.id,d);
 PERFORM pg_advisory_xact_lock(hashtextextended('mem-placement:'||dest::text||':'||coalesce(b->>'logical_path',placement.logical_path),0));IF EXISTS(SELECT FROM mem.placements WHERE project_id=dest AND logical_path=coalesce(b->>'logical_path',placement.logical_path)AND active AND material_id<>m.id)THEN result:=jsonb_build_object('operation_id',oid,'material_id',m.id,'state','conflict','reason_code','target_name_conflict','source_scope_unchanged',true);INSERT INTO mem.scope_move_commands VALUES(oid,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,m.id,src,dest,b->>'idempotency_key',d,b,observed,'conflict',result,clock_timestamp())ON CONFLICT(actor_id,idempotency_key)DO UPDATE SET receipt=excluded.receipt;PERFORM authz.assert_effect(h);RETURN result;END IF;
 -- One stable material scope. Other old active placements are retired; selected placement keeps its identity.
 UPDATE mem.placements SET active=false,revision=revision+1 WHERE material_id=m.id AND active AND id<>placement.id;
 UPDATE mem.placements SET project_id=dest,collection_id=(b->>'target_collection_id')::uuid,area_id=(b->>'target_area_id')::uuid,logical_path=coalesce(b->>'logical_path',logical_path),revision=revision+1 WHERE id=placement.id;
 UPDATE mem.gc_objects SET project_id=dest,revision=revision+1 WHERE material_id=m.id AND project_id=src AND state='open';
 UPDATE mem.materials SET project_id=dest,scope_revision=scope_revision+1,metadata_revision=metadata_revision+1,event_revision=event_revision+2 WHERE id=m.id RETURNING * INTO m;
 result:=jsonb_build_object('operation_id',oid,'material_id',m.id,'state','moved','source_project_id',src,'target_project_id',dest,'domain_revision',m.event_revision,'scope_revision',m.scope_revision,'metadata_revision',m.metadata_revision,'content_revision',m.content_revision,'placement_id',placement.id,'bytes_changed',false,'adoptions_changed',false,'public_disclosure',false);
 INSERT INTO mem.scope_move_commands VALUES(oid,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,m.id,src,dest,b->>'idempotency_key',d,b,observed,'moved',result,clock_timestamp())ON CONFLICT(actor_id,idempotency_key)DO UPDATE SET state='moved',receipt=excluded.receipt;
 INSERT INTO evidence.audit(actor_id,client_id,source_context_id,domain,action,aggregate_id,revision,operation_id,details)VALUES((c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'source_context_id')::uuid,'mem','material.scope_moved',m.id,m.event_revision,oid,result);
 -- Separate safe old-scope tombstone and current target-placement event; no target name/body in old feed.
 INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload)VALUES('mem',m.id,m.event_revision-1,'material.scope_removed',src,jsonb_build_object('material_id',m.id,'state','removed')),('mem',m.id,m.event_revision,'material.scope_placed',dest,jsonb_build_object('material_id',m.id,'state','active'));
 PERFORM authz.material_move_final(fid);RETURN result;
END $$;
REVOKE ALL ON FUNCTION mem.move_scope(uuid,uuid,uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.move_scope(uuid,uuid,uuid,text,text)TO hub2_mem;
INSERT INTO mem.gc_reference_contracts(schema_name,table_name,kind,shape_hash)VALUES('mem','scope_move_commands','ledger',mem.gc_relation_shape('mem.scope_move_commands'::regclass));UPDATE mem.gc_reference_contracts SET shape_hash=mem.gc_relation_shape((schema_name||'.'||table_name)::regclass)WHERE schema_name='mem'AND table_name IN('materials','placements');
RESET ROLE;
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.move_scope_status(h uuid,d text,payload text)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;o mem.scope_move_commands;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;c:=authz.consume_handle(h,'mem.write',d);IF(c->>'project_id')::uuid NOT IN((b->>'project_id')::uuid,(b->>'target_project_id')::uuid)THEN RAISE EXCEPTION 'source_scope_mismatch' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM mem.scope_move_commands WHERE actor_id=(c->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key';PERFORM authz.assert_effect(h);
 IF o.id IS NULL THEN RETURN NULL;END IF;IF o.fingerprint IS DISTINCT FROM d THEN RAISE EXCEPTION 'move_original_input_changed' USING ERRCODE='40001';END IF;IF o.state='moved'THEN RETURN o.receipt;END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION mem.move_scope_status(uuid,text,text)FROM PUBLIC;GRANT EXECUTE ON FUNCTION mem.move_scope_status(uuid,text,text)TO hub2_mem;
RESET ROLE;
-- Area selector now uses actual active placement membership; caller area labels do not confer material access.
SET ROLE hub2_authz_owner;
DO $$DECLARE def text;anchor text:='RETURN EXISTS(SELECT FROM mem.placements p JOIN jsonb_array_elements_text(COALESCE(s->''collections'',''[]'')) x ON x.value=p.collection_id::text WHERE p.material_id=mid AND p.project_id=p_project AND p.active);';BEGIN
 def:=pg_get_functiondef('authz.selector_matches(jsonb,uuid,jsonb)'::regprocedure);IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'selector_move_extension_anchor_missing';END IF;
 EXECUTE replace(def,anchor,'RETURN EXISTS(SELECT FROM mem.placements p WHERE p.material_id=mid AND p.project_id=p_project AND p.active AND (p.collection_id::text IN(SELECT jsonb_array_elements_text(COALESCE(s->''collections'',''[]'')))OR(p.area_id::text IN(SELECT jsonb_array_elements_text(COALESCE(s->''areas'',''[]'')))AND EXISTS(SELECT FROM authz.resource_areas ar WHERE ar.id=p.area_id AND ar.project_id=p_project AND ar.active))));');
END $$;
RESET ROLE;
-- Retirements are safe old-project IDs only; they must be delivered even after current scope becomes private.
SET ROLE hub2_evidence_owner;
DO $$DECLARE def text;anchor text:='o.domain<>''mem'' OR NOT EXISTS';BEGIN
 def:=pg_get_functiondef('evidence.project_changes(uuid,text,text)'::regprocedure);IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'changes_move_extension_anchor_missing';END IF;EXECUTE replace(def,anchor,'o.event_type=''material.scope_removed'' OR o.domain<>''mem'' OR NOT EXISTS');
END $$;
RESET ROLE;
-- A moved object retains all actual source-scope restore windows. No history ledger permanently pins bytes.
SET ROLE hub2_mem_owner;
DO $$DECLARE def text;anchor text:='project_id=p.project_id AND(object_id=p.object_id OR object_id IS NULL)';BEGIN
 def:=pg_get_functiondef('mem.gc_scan(uuid,text,text)'::regprocedure);IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'gc_move_protection_anchor_missing';END IF;
 EXECUTE replace(def,anchor,'(object_id=p.object_id OR(object_id IS NULL AND(project_id=p.project_id OR project_id IN(SELECT source_project FROM mem.scope_move_commands WHERE material_id=p.material_id AND state=''moved''))))');
END $$;
RESET ROLE;
SET ROLE hub2_mem_owner;
DO $$DECLARE def text;anchor text:='''event_revision'',m.event_revision,';BEGIN
 def:=pg_get_functiondef('mem.material_head(uuid,text,text)'::regprocedure);IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'head_scope_extension_anchor_missing';END IF;EXECUTE replace(def,anchor,anchor||'''scope_revision'',m.scope_revision,''placements'',(SELECT coalesce(jsonb_agg(jsonb_build_object(''placement_id'',p.id,''logical_path'',p.logical_path,''revision'',p.revision,''collection_id'',p.collection_id,''area_id'',p.area_id)),''[]'')FROM mem.placements p WHERE p.material_id=m.id AND p.active),');
END $$;
RESET ROLE;
-- A stable aggregate can change project. Projection bookkeeping follows the latest factual placement event.
SET ROLE hub2_evidence_owner;
DO $$DECLARE def text;anchor text:='SET revision=r.aggregate_revision,state=''current'',event_types=r.types';BEGIN
 def:=pg_get_functiondef('evidence.consume_batch(text,integer)'::regprocedure);IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'worker_scope_projection_anchor_missing';END IF;
 def:=replace(def,anchor,'SET project_id=CASE WHEN ''material.scope_placed''=ANY(r.types)THEN(SELECT o.project_id FROM evidence.outbox o WHERE o.domain=p.domain AND o.aggregate_id=p.aggregate_id AND o.aggregate_revision=r.aggregate_revision AND o.event_type=''material.scope_placed'' LIMIT 1)ELSE project_id END,revision=r.aggregate_revision,state=''current'',event_types=r.types');
 def:=replace(def,'SELECT o.id,o.event_type FROM evidence.delivery','SELECT o.id,o.event_type,o.project_id FROM evidence.delivery');
 def:=replace(def,'''project_id'',p.project_id,''revision'',r.aggregate_revision','''project_id'',CASE WHEN g.event_type=''material.scope_placed''THEN g.project_id ELSE p.project_id END,''revision'',r.aggregate_revision');
 def:=replace(def,'p.revision:=r.aggregate_revision;','p.revision:=r.aggregate_revision;SELECT project_id INTO p.project_id FROM evidence.projection WHERE consumer=c AND domain=p.domain AND aggregate_id=p.aggregate_id;');EXECUTE def;
 def:=pg_get_functiondef('evidence.seed_consumer(text)'::regprocedure);
 def:=replace(def,'SELECT c,x.domain,x.aggregate_id,x.project_id,max(x.aggregate_revision),''current'',high FROM (','SELECT DISTINCT ON(x.domain,x.aggregate_id)c,x.domain,x.aggregate_id,x.project_id,x.aggregate_revision,''current'',high FROM (');
 def:=replace(def,') x GROUP BY x.domain,x.aggregate_id,x.project_id',') x ORDER BY x.domain,x.aggregate_id,x.aggregate_revision DESC');
 def:=replace(def,'revision=EXCLUDED.revision,state=''current'',last_seq=high','project_id=EXCLUDED.project_id,revision=EXCLUDED.revision,state=''current'',last_seq=high');EXECUTE def;
END $$;
RESET ROLE;
SET ROLE hub2_mem_owner;
DO $$DECLARE def text;anchor text:='project_id=p.project_id AND(object_id=p.object_id OR object_id IS NULL)';BEGIN
 def:=pg_get_functiondef('mem.gc_destroy(uuid,text,text)'::regprocedure);IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'gc_move_seal_protection_anchor_missing';END IF;
 EXECUTE replace(def,anchor,'(object_id=p.object_id OR(object_id IS NULL AND(project_id=p.project_id OR project_id IN(SELECT source_project FROM mem.scope_move_commands WHERE material_id=p.material_id AND state=''moved''))))');
 def:=pg_get_functiondef('mem.gc_recovery_fence()'::regprocedure);anchor:='WHERE project_id=NEW.project_id ORDER BY object_id FOR UPDATE';IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'gc_move_recovery_fence_anchor_missing';END IF;
 EXECUTE replace(def,anchor,'WHERE project_id=NEW.project_id OR EXISTS(SELECT FROM mem.scope_move_commands sm JOIN mem.content_versions cv ON cv.material_id=sm.material_id WHERE cv.object_id=gc_objects.object_id AND sm.state=''moved''AND NEW.project_id IN(sm.source_project,sm.target_project))ORDER BY object_id FOR UPDATE');
END $$;
RESET ROLE;
-- Binding ownership is historical metadata; the material's current scope supplies the usable fixed-ref address.
SET ROLE hub2_mem_owner;
DO $$DECLARE def text;anchor text:='jsonb_build_object(''project_id'',r.project_id,''material_id'',v.material_id';BEGIN
 def:=pg_get_functiondef('mem.legacy_reference_resolve(uuid,text,text)'::regprocedure);IF position(anchor IN def)=0 THEN RAISE EXCEPTION 'legacy_current_scope_extension_anchor_missing';END IF;
 EXECUTE replace(def,anchor,'jsonb_build_object(''project_id'',(SELECT project_id FROM mem.materials WHERE id=v.material_id),''material_id'',v.material_id');
END $$;
RESET ROLE;
