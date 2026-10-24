-- Agent-chosen material identity navigation. Original material/version/hash/bytes/adoptions remain untouched.
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.assert_alias_write_scope(hid uuid,source uuid,target uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;r jsonb;resources jsonb;deadline timestamptz;revision bigint;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF session_user<>'hub2_mem' OR h.id IS NULL OR h.audience<>'mem' OR h.action<>'mem.write' OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() OR source IS NULL OR target IS NULL THEN RAISE EXCEPTION 'invalid_alias_guard' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT FROM mem.materials WHERE id=source AND project_id=h.project_id) OR NOT EXISTS(SELECT FROM mem.materials WHERE id=target AND project_id=h.project_id) THEN RAISE EXCEPTION 'same_project_materials_required' USING ERRCODE='42501';END IF;
 resources:=jsonb_build_array(jsonb_build_object('project_id',h.project_id,'material_id',source),jsonb_build_object('project_id',h.project_id,'material_id',target));PERFORM authz.lock_resources(h.principal_id,h.client_id,h.credential_id,resources);
 SELECT p.revision INTO revision FROM v8.projects p WHERE p.id=h.project_id;
 FOR r IN SELECT * FROM jsonb_array_elements(resources) LOOP
  deadline:=least(h.expires_at,authz.resource_deadline(h.principal_id,h.client_id,h.project_id,'mem.write',r));
  INSERT INTO authz.handle_sources(handle_id,project_id,action,resource,project_revision,deadline) VALUES(hid,h.project_id,'mem.write',r,revision,deadline) ON CONFLICT(handle_id,project_id,action,resource) DO UPDATE SET deadline=least(handle_sources.deadline,EXCLUDED.deadline);
  UPDATE authz.handles SET expires_at=least(expires_at,deadline) WHERE id=hid;
 END LOOP;PERFORM authz.assert_effect(hid);
END $$;
REVOKE ALL ON FUNCTION authz.assert_alias_write_scope(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.assert_alias_write_scope(uuid,uuid,uuid) TO hub2_mem_owner;
RESET ROLE;

SET ROLE hub2_mem_owner;
CREATE TABLE mem.material_equivalence_judgments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL,material_id uuid,canonical_material_id uuid,actor_id uuid NOT NULL,client_id uuid NOT NULL,source_context_id uuid,requested_mode text NOT NULL CHECK(requested_mode IN ('alias','proposal','undo')),technical_state text NOT NULL CHECK(technical_state IN ('proposed','established','conflict','withdrawn')),reason jsonb NOT NULL DEFAULT '{}',basis jsonb NOT NULL DEFAULT '{}',claim jsonb NOT NULL DEFAULT '{}',source_fixed_ref jsonb NOT NULL DEFAULT '{}',canonical_fixed_ref jsonb NOT NULL DEFAULT '{}',alias_revision bigint NOT NULL DEFAULT 0,supersedes uuid REFERENCES mem.material_equivalence_judgments(id),reason_code text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE mem.material_alias_heads(material_id uuid PRIMARY KEY REFERENCES mem.materials(id),project_id uuid NOT NULL,canonical_material_id uuid REFERENCES mem.materials(id),current_judgment_id uuid NOT NULL REFERENCES mem.material_equivalence_judgments(id),revision bigint NOT NULL CHECK(revision>0),active boolean NOT NULL DEFAULT true,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(material_id IS DISTINCT FROM canonical_material_id));
CREATE INDEX material_equivalence_history ON mem.material_equivalence_judgments(project_id,material_id,created_at,id);
REVOKE ALL ON mem.material_equivalence_judgments,mem.material_alias_heads FROM PUBLIC,hub2_mem,hub2_worker;

CREATE FUNCTION mem.equivalence_fixed_ref(m mem.materials) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,mem AS $$
 SELECT COALESCE((SELECT jsonb_build_object('material_id',v.material_id,'version_id',v.id,'sha256',v.sha256,'size',v.size) FROM mem.content_versions v WHERE v.id=m.current_version_id AND v.material_id=m.id),'{}'::jsonb) $$;
CREATE FUNCTION mem.equivalence_ack(j mem.material_equivalence_judgments) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,mem AS $$
 SELECT jsonb_build_object('operation_id',j.id,'equivalence_id',j.id,'material_id',j.material_id,'state',j.technical_state,'alias_revision',j.alias_revision,'reason_code',j.reason_code,'semantic_status','agent_asserted_not_platform_inferred','retained_state','both_original_ids_versions_hashes_bytes_and_adoptions_preserved','bytes_changed',false,'next_step',CASE WHEN j.technical_state='established' THEN 'query_current_authorized_alias_navigation' WHEN j.technical_state='conflict' THEN 'inspect_current_alias_revision_and_correct_with_new_judgment' ELSE 'supplement_same_material_identity_judgment_when_facts_and_authority_are_available' END) $$;

CREATE FUNCTION mem.equivalence_create(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb;c jsonb;s mem.materials;t mem.materials;head mem.material_alias_heads;j mem.material_equivalence_judgments;expected bigint;mode text;state text:='proposed';code text:='identity_claim_pending';replay jsonb;cursor_id uuid;visited uuid[]:='{}';steps integer:=0;
BEGIN
 IF payload IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;c:=mem.guard(h,'mem.write',d,b);mode:=COALESCE(b->>'mode',CASE WHEN b->>'material_id' IS NOT NULL AND b->>'canonical_material_id' IS NOT NULL THEN 'alias' ELSE 'proposal' END);expected:=COALESCE((b->>'expected_alias_revision')::bigint,0);
 IF mode NOT IN ('alias','proposal') OR expected<0 THEN RAISE EXCEPTION 'invalid_equivalence_input';END IF;
 replay:=mem.replay_command(c,'equivalence_create',b,d);IF replay IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN replay;END IF;
 -- Only topology mutations in this one project serialize; ordinary uploads/metadata/content writes use their own CAS.
 IF mode='alias' THEN PERFORM pg_advisory_xact_lock(hashtextextended('mem-alias-topology:'||(c->>'project_id'),0));END IF;
 PERFORM id FROM mem.materials WHERE id IN ((b->>'material_id')::uuid,(b->>'canonical_material_id')::uuid) ORDER BY id FOR UPDATE;
 SELECT * INTO s FROM mem.materials WHERE id=(b->>'material_id')::uuid AND project_id=(c->>'project_id')::uuid;
 SELECT * INTO t FROM mem.materials WHERE id=(b->>'canonical_material_id')::uuid;
 SELECT * INTO head FROM mem.material_alias_heads WHERE material_id=s.id FOR UPDATE;
 IF mode='alias' AND s.id IS NOT NULL AND t.id IS NOT NULL AND t.project_id=s.project_id AND t.id<>s.id THEN
  -- No whole-source reading requirement is manufactured for a write-only navigation judgment.
  PERFORM authz.assert_alias_write_scope(h,s.id,t.id);
  IF COALESCE(head.revision,0)<>expected THEN state:='conflict';code:='alias_revision_conflict';
  ELSE
   cursor_id:=t.id;
   WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id=s.id OR cursor_id=ANY(visited) THEN state:='conflict';code:='alias_navigation_cycle';EXIT;END IF;
    visited:=array_append(visited,cursor_id);steps:=steps+1;
    IF steps>64 THEN state:='proposed';code:='canonical_chain_inspection_pending';EXIT;END IF;
    SELECT canonical_material_id INTO cursor_id FROM mem.material_alias_heads WHERE material_id=cursor_id AND active;
   END LOOP;
   IF cursor_id IS NULL THEN state:='established';code:='agent_chosen_alias';END IF;
  END IF;
 ELSIF mode='alias' THEN code:='existing_same_project_distinct_material_facts_required';END IF;
 PERFORM authz.assert_effect(h);
 INSERT INTO mem.material_equivalence_judgments(project_id,material_id,canonical_material_id,actor_id,client_id,source_context_id,requested_mode,technical_state,reason,basis,claim,source_fixed_ref,canonical_fixed_ref,alias_revision,supersedes,reason_code)
 VALUES((c->>'project_id')::uuid,(b->>'material_id')::uuid,(b->>'canonical_material_id')::uuid,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'source_context_id')::uuid,mode,state,COALESCE(b->'reason','{}'),COALESCE(b->'basis','{}'),COALESCE(b->'claim','{}'),CASE WHEN s.id IS NOT NULL THEN mem.equivalence_fixed_ref(s) ELSE '{}' END,CASE WHEN t.id IS NOT NULL AND t.project_id=s.project_id THEN mem.equivalence_fixed_ref(t) ELSE '{}' END,CASE WHEN state='established' THEN COALESCE(head.revision,0)+1 ELSE COALESCE(head.revision,0) END,head.current_judgment_id,code) RETURNING * INTO j;
 IF state='established' THEN
  INSERT INTO mem.material_alias_heads(material_id,project_id,canonical_material_id,current_judgment_id,revision) VALUES(s.id,s.project_id,t.id,j.id,j.alias_revision) ON CONFLICT(material_id) DO UPDATE SET canonical_material_id=EXCLUDED.canonical_material_id,current_judgment_id=EXCLUDED.current_judgment_id,revision=EXCLUDED.revision,active=true,updated_at=clock_timestamp();
  UPDATE mem.materials SET event_revision=event_revision+1 WHERE id=s.id RETURNING * INTO s;
  PERFORM mem.emit(c,'material.alias_changed',s.id,s.event_revision,j.id,jsonb_build_object('equivalence_id',j.id,'alias_revision',j.alias_revision,'original_material_identity_preserved',true));
 ELSE PERFORM mem.emit(c,'material.equivalence_proposed',j.id,1,j.id,jsonb_build_object('equivalence_id',j.id,'state',state));END IF;
 RETURN mem.remember_command(c,'equivalence_create',b,d,mem.equivalence_ack(j));
END $$;

CREATE FUNCTION mem.equivalence_query(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb;c jsonb;s mem.materials;t mem.materials;head mem.material_alias_heads;j mem.material_equivalence_judgments;result jsonb;visible boolean;details boolean;
BEGIN
 IF payload IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;c:=mem.guard(h,'mem.read',d,b);
 IF b->>'equivalence_id' IS NOT NULL THEN SELECT * INTO j FROM mem.material_equivalence_judgments WHERE id=(b->>'equivalence_id')::uuid AND project_id=(c->>'project_id')::uuid;
 ELSE SELECT * INTO head FROM mem.material_alias_heads WHERE material_id=(b->>'material_id')::uuid AND project_id=(c->>'project_id')::uuid;SELECT * INTO j FROM mem.material_equivalence_judgments WHERE id=head.current_judgment_id;END IF;
 IF j.id IS NOT NULL AND b->>'material_id' IS NOT NULL AND j.material_id IS DISTINCT FROM (b->>'material_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 IF j.id IS NOT NULL AND j.technical_state IN ('proposed','conflict') AND j.actor_id IS DISTINCT FROM (c->>'actor_id')::uuid THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 SELECT * INTO s FROM mem.materials WHERE id=COALESCE(j.material_id,(b->>'material_id')::uuid) AND project_id=(c->>'project_id')::uuid;
 IF s.id IS NOT NULL AND NOT mem.governance_resource_visible(h,c,jsonb_build_object('project_id',s.project_id,'material_id',s.id)) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF j.id IS NULL THEN PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','no_alias','material_id',s.id,'navigation_only',true,'original_read','use_original_material_and_fixed_version');END IF;
 SELECT * INTO head FROM mem.material_alias_heads WHERE material_id=j.material_id;
 SELECT * INTO t FROM mem.materials WHERE id=j.canonical_material_id;
 visible:=t.id IS NOT NULL AND mem.governance_resource_visible(h,c,jsonb_build_object('project_id',t.project_id,'material_id',t.id));
 details:=visible AND mem.governance_json_visible(h,jsonb_build_object('reason',j.reason,'basis',j.basis,'claim',j.claim));
 result:=jsonb_build_object('state',j.technical_state,'equivalence_id',j.id,'material_id',s.id,'alias_revision',COALESCE(head.revision,0),'judgment_alias_revision',j.alias_revision,'current_equivalence_id',head.current_judgment_id,'active',COALESCE(head.active,false) AND head.current_judgment_id=j.id,'navigation_only',true,'original_read','use_original_material_and_fixed_version','target_visibility',CASE WHEN visible THEN 'current_authorized' WHEN t.id IS NULL THEN 'unresolved_claim' ELSE 'access_restricted' END,'retained_state','both_original_material_ids_versions_and_bytes_preserved','semantic_status','agent_asserted_not_platform_inferred');
 IF s.id IS NOT NULL THEN result:=result||jsonb_build_object('original_fixed_ref',mem.equivalence_fixed_ref(s));END IF;
 IF visible THEN result:=result||jsonb_build_object(CASE WHEN COALESCE(head.active,false) AND head.current_judgment_id=j.id THEN 'canonical_target' ELSE 'historical_target' END,jsonb_build_object('project_id',t.project_id,'material_id',t.id,'fixed_ref',mem.equivalence_fixed_ref(t),'material_state',t.state));END IF;
 IF details OR (t.id IS NULL AND j.actor_id=(c->>'actor_id')::uuid AND mem.governance_json_visible(h,jsonb_build_object('reason',j.reason,'basis',j.basis,'claim',j.claim))) THEN result:=result||jsonb_build_object('reason',mem.processing_safe_json(h,j.reason),'basis',mem.processing_safe_json(h,j.basis),'claim',mem.processing_safe_json(h,j.claim));END IF;
 PERFORM authz.assert_effect(h);RETURN result;
END $$;

CREATE FUNCTION mem.equivalence_undo(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb;c jsonb;s mem.materials;old mem.material_equivalence_judgments;head mem.material_alias_heads;j mem.material_equivalence_judgments;replay jsonb;
BEGIN
 IF payload IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;c:=mem.guard(h,'mem.write',d,b);
 replay:=mem.replay_command(c,'equivalence_undo',b,d);IF replay IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN replay;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('mem-alias-topology:'||(c->>'project_id'),0));
 SELECT * INTO old FROM mem.material_equivalence_judgments WHERE id=(b->>'equivalence_id')::uuid AND project_id=(c->>'project_id')::uuid AND material_id=(b->>'material_id')::uuid;
 IF old.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 PERFORM id FROM mem.materials WHERE id IN (old.material_id,old.canonical_material_id) ORDER BY id FOR UPDATE;
 SELECT * INTO s FROM mem.materials WHERE id=old.material_id;
 SELECT * INTO head FROM mem.material_alias_heads WHERE material_id=s.id FOR UPDATE;
 PERFORM authz.assert_alias_write_scope(h,old.material_id,old.canonical_material_id);
 IF head.current_judgment_id IS DISTINCT FROM old.id OR head.revision IS DISTINCT FROM old.alias_revision OR NOT head.active THEN
  PERFORM authz.assert_effect(h);RETURN mem.remember_command(c,'equivalence_undo',b,d,jsonb_build_object('state','conflict','equivalence_id',old.id,'material_id',s.id,'alias_revision',head.revision,'reason_code','newer_alias_judgment_preserved','retained_state','current_alias_and_all_later_material_writes_preserved','next_step','query_current_alias_and_choose_explicit_current_judgment'));
 END IF;
 PERFORM authz.assert_effect(h);
 INSERT INTO mem.material_equivalence_judgments(project_id,material_id,canonical_material_id,actor_id,client_id,source_context_id,requested_mode,technical_state,reason,basis,alias_revision,supersedes,reason_code)
 VALUES(s.project_id,s.id,old.canonical_material_id,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'source_context_id')::uuid,'undo','withdrawn',COALESCE(b->'reason','{}'),COALESCE(b->'basis','{}'),head.revision+1,old.id,'explicit_alias_withdrawal') RETURNING * INTO j;
 UPDATE mem.material_alias_heads SET canonical_material_id=NULL,active=false,current_judgment_id=j.id,revision=j.alias_revision,updated_at=clock_timestamp() WHERE material_id=s.id;
 UPDATE mem.materials SET event_revision=event_revision+1 WHERE id=s.id RETURNING * INTO s;
 PERFORM mem.emit(c,'material.alias_withdrawn',s.id,s.event_revision,j.id,jsonb_build_object('equivalence_id',j.id,'alias_revision',j.alias_revision));
 RETURN mem.remember_command(c,'equivalence_undo',b,d,mem.equivalence_ack(j));
END $$;
REVOKE ALL ON FUNCTION mem.equivalence_fixed_ref(mem.materials),mem.equivalence_ack(mem.material_equivalence_judgments),mem.equivalence_create(uuid,text,text),mem.equivalence_query(uuid,text,text),mem.equivalence_undo(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.equivalence_create(uuid,text,text),mem.equivalence_query(uuid,text,text),mem.equivalence_undo(uuid,text,text) TO hub2_mem;
RESET ROLE;
