-- Original 2.0 metadata workflow. No content, keys, new Actor or truth score.
SET ROLE hub2_v8_owner;
CREATE TABLE v8.governance_candidates(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES v8.projects,
 source_event_id text NOT NULL UNIQUE,kind text NOT NULL CHECK(kind IN('completed_episode','experience_feedback','experience_revision','important_description')),
 source_id uuid NOT NULL,source_revision bigint NOT NULL DEFAULT 1,evidence_refs jsonb NOT NULL DEFAULT '[]',
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','claimed','deferred','resolved')),
 revision bigint NOT NULL DEFAULT 1,claimed_by uuid,claim_until timestamptz,defer_until timestamptz,
 conclusion jsonb,revision_links jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX governance_project_page ON v8.governance_candidates(project_id,id);
CREATE TABLE v8.governance_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),candidate_id uuid NOT NULL REFERENCES v8.governance_candidates,actor_id uuid NOT NULL,client_id uuid NOT NULL,source_context_id uuid,kind text NOT NULL,revision bigint NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON v8.governance_candidates,v8.governance_events FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
ALTER TABLE v8.governance_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE v8.governance_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY governance_owner ON v8.governance_candidates TO hub2_v8_owner USING(true) WITH CHECK(true);
CREATE POLICY governance_owner ON v8.governance_events TO hub2_v8_owner USING(true) WITH CHECK(true);
RESET ROLE;
GRANT SELECT ON mem.materials,mem.content_versions,mem.agent_description_heads,mem.agent_description_revisions,mem.agent_description_vectors TO hub2_v8_owner;
SET ROLE hub2_v8_owner;
CREATE FUNCTION v8.governance_generate(p_project uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
BEGIN
 INSERT INTO v8.governance_candidates(project_id,source_event_id,kind,source_id,source_revision,evidence_refs)
 SELECT w.project_id,'work:'||w.id||':'||w.revision,'completed_episode',w.id,w.revision,
 coalesce((SELECT jsonb_agg(jsonb_build_object('material_id',r.material_id,'version_id',r.version_id,'sha256',r.sha256))FROM v8.results r WHERE r.work_item_id=w.id),'[]')||
 coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.explanation->'inputs')='array' THEN w.explanation->'inputs' ELSE '[]' END)x WHERE x ? 'material_id' AND x ? 'version_id' AND x ? 'sha256' AND x->>'material_id'~'^[a-f0-9-]{36}$' AND x->>'version_id'~'^[a-f0-9-]{36}$' AND x->>'sha256'~'^[a-f0-9]{64}$' AND EXISTS(SELECT FROM mem.content_versions cv WHERE cv.id::text=x->>'version_id' AND cv.material_id::text=x->>'material_id' AND cv.sha256=x->>'sha256')),'[]')
 FROM v8.work_items w WHERE w.project_id=p_project AND w.state='completed' ON CONFLICT(source_event_id) DO NOTHING;
 INSERT INTO v8.governance_candidates(project_id,source_event_id,kind,source_id,source_revision,evidence_refs)
 SELECT w.project_id,'feedback:'||f.id,'experience_feedback',f.id,1,
 jsonb_build_array(jsonb_build_object('material_id',f.material_id,'version_id',f.version_id,'sha256',f.sha256),jsonb_build_object('material_id',e.material_id,'version_id',e.version_id,'sha256',e.sha256))||coalesce(f.evidence,'[]')
 FROM v8.experience_feedback f JOIN v8.experiences e ON e.id=f.experience_id JOIN v8.work_items w ON w.id=e.work_item_id WHERE w.project_id=p_project ON CONFLICT(source_event_id) DO NOTHING;
 INSERT INTO v8.governance_candidates(project_id,source_event_id,kind,source_id,source_revision,evidence_refs)
 SELECT w.project_id,'experience:'||e.id||':'||e.revision,'experience_revision',e.id,e.revision,
 jsonb_build_array(jsonb_build_object('material_id',e.material_id,'version_id',e.version_id,'sha256',e.sha256))||coalesce(e.evidence,'[]')
 FROM v8.experiences e JOIN v8.work_items w ON w.id=e.work_item_id WHERE w.project_id=p_project AND (e.supersedes IS NOT NULL OR e.state IN('stale','superseded')) ON CONFLICT(source_event_id) DO NOTHING;
 INSERT INTO v8.governance_candidates(project_id,source_event_id,kind,source_id,source_revision,evidence_refs)
 SELECT m.project_id,'description:'||m.id||':'||v.id||':'||coalesce(h.revision,0)||':'||m.metadata_revision,'important_description',m.id,coalesce(h.revision,0),jsonb_build_array(jsonb_build_object('material_id',m.id,'version_id',v.id,'sha256',v.sha256))
 FROM mem.materials m JOIN mem.content_versions v ON v.id=m.current_version_id LEFT JOIN mem.agent_description_heads h ON h.version_id=v.id LEFT JOIN mem.agent_description_revisions d ON d.version_id=h.version_id AND d.revision=h.revision
 WHERE m.project_id=p_project AND m.state='active' AND m.properties#>>'{governance,important}'='true' AND (d.version_id IS NULL OR d.state<>'active' OR length(btrim(d.text_content))=0 OR NOT EXISTS(SELECT FROM mem.agent_description_vectors z WHERE z.version_id=v.id AND z.description_revision=d.revision AND z.description_sha256=d.text_sha256)) ON CONFLICT(source_event_id) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION v8.governance_generate(uuid) FROM PUBLIC,hub2_v8,hub2_mem,hub2_hufu,hub2_worker;
-- No trigger calls can block the original work: authorized discovery repairs missed events.
CREATE FUNCTION v8.governance_event_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE pid uuid;
BEGIN
 IF TG_TABLE_NAME='work_items' THEN pid:=NEW.project_id;
 ELSIF TG_TABLE_NAME='experiences' THEN SELECT project_id INTO pid FROM v8.work_items WHERE id=NEW.work_item_id;
 ELSIF TG_TABLE_NAME='experience_feedback' THEN SELECT w.project_id INTO pid FROM v8.experiences e JOIN v8.work_items w ON w.id=e.work_item_id WHERE e.id=NEW.experience_id;
 ELSIF TG_TABLE_NAME='materials' THEN pid:=NEW.project_id;
 ELSE SELECT m.project_id INTO pid FROM mem.content_versions v JOIN mem.materials m ON m.id=v.material_id WHERE v.id=NEW.version_id;
 END IF;
 IF pid IS NOT NULL THEN PERFORM v8.governance_generate(pid); END IF;RETURN NEW;
EXCEPTION WHEN OTHERS THEN RAISE WARNING 'governance_event_generation_pending SQLSTATE=%',SQLSTATE;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION v8.governance_event_notice() FROM PUBLIC,hub2_v8,hub2_hufu,hub2_mem,hub2_worker;
CREATE TRIGGER governance_work AFTER INSERT OR UPDATE ON v8.work_items FOR EACH ROW WHEN(NEW.state='completed') EXECUTE FUNCTION v8.governance_event_notice();
CREATE TRIGGER governance_feedback AFTER INSERT ON v8.experience_feedback FOR EACH ROW EXECUTE FUNCTION v8.governance_event_notice();
CREATE TRIGGER governance_experience AFTER INSERT OR UPDATE ON v8.experiences FOR EACH ROW EXECUTE FUNCTION v8.governance_event_notice();
RESET ROLE;
CREATE TRIGGER governance_material AFTER INSERT OR UPDATE ON mem.materials FOR EACH ROW EXECUTE FUNCTION v8.governance_event_notice();
CREATE TRIGGER governance_description AFTER INSERT OR UPDATE ON mem.agent_description_heads FOR EACH ROW EXECUTE FUNCTION v8.governance_event_notice();
SET ROLE hub2_v8_owner;
CREATE FUNCTION v8.governance_visible(c jsonb,item v8.governance_candidates) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,v8 AS $$
DECLARE ref jsonb;m mem.materials;head_revision bigint;
BEGIN
 IF item.project_id IS DISTINCT FROM (c->>'project_id')::uuid THEN RETURN false;END IF;
 IF item.kind='important_description' THEN
  SELECT * INTO m FROM mem.materials WHERE id=item.source_id;
  IF m.id IS NULL OR m.project_id<>item.project_id OR m.state<>'active' OR m.properties#>>'{governance,important}' IS DISTINCT FROM 'true' OR m.current_version_id::text IS DISTINCT FROM item.evidence_refs->0->>'version_id' THEN RETURN false;END IF;
  SELECT revision INTO head_revision FROM mem.agent_description_heads WHERE version_id=m.current_version_id;
  IF item.source_event_id IS DISTINCT FROM 'description:'||m.id||':'||m.current_version_id||':'||coalesce(head_revision,0)||':'||m.metadata_revision THEN RETURN false;END IF;
  IF EXISTS(SELECT FROM mem.agent_description_revisions d JOIN mem.agent_description_vectors z ON z.version_id=d.version_id AND z.description_revision=d.revision AND z.description_sha256=d.text_sha256 WHERE d.version_id=m.current_version_id AND d.revision=head_revision AND d.state='active' AND length(btrim(d.text_content))>0) THEN RETURN false;END IF;
 END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(item.evidence_refs||item.revision_links) LOOP
  IF NOT(ref ? 'material_id' AND ref ? 'version_id' AND ref ? 'sha256') THEN RETURN false;END IF;
  PERFORM v8.assert_ref(c,ref);
 END LOOP;
 RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION v8.governance_visible(jsonb,v8.governance_candidates) FROM PUBLIC,hub2_v8,hub2_mem,hub2_hufu,hub2_worker;
CREATE FUNCTION v8.governance_view(item v8.governance_candidates) RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog,v8 AS $$
 SELECT jsonb_build_object('candidate_id',item.id,'project_id',item.project_id,'source_event_id',item.source_event_id,'kind',item.kind,'source_id',item.source_id,'source_revision',item.source_revision,'state',item.state,'revision',item.revision,'claimed_by',item.claimed_by,'claim_until',item.claim_until,'defer_until',item.defer_until,'conclusion',item.conclusion,'revision_links',item.revision_links,'fixed_refs',item.evidence_refs,'created_at',item.created_at,'updated_at',item.updated_at,'semantic_status','Agent_or_member_judgment;not_auto_truth');
$$;
REVOKE ALL ON FUNCTION v8.governance_view(v8.governance_candidates) FROM PUBLIC,hub2_v8,hub2_mem,hub2_hufu,hub2_worker;
CREATE FUNCTION v8.governance_inbox(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb:=p::jsonb;c jsonb;item v8.governance_candidates;items jsonb:='[]';k integer:=coalesce((b->>'limit')::integer,20);last_id uuid;more boolean:=false;
BEGIN
 IF encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=v8.guard(h,'v8.work.read',d,b);IF k NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_limit' USING ERRCODE='22023';END IF;
 PERFORM v8.governance_generate((c->>'project_id')::uuid);
 FOR item IN SELECT * FROM v8.governance_candidates WHERE project_id=(c->>'project_id')::uuid AND (b->>'cursor' IS NULL OR id>(b->>'cursor')::uuid) AND (coalesce(b->>'state','open')='all' OR CASE WHEN coalesce(b->>'state','open')='open' THEN state<>'resolved' ELSE state=b->>'state' END) AND (b->>'kind' IS NULL OR kind=b->>'kind') AND (defer_until IS NULL OR defer_until<=clock_timestamp() OR coalesce((b->>'include_deferred')::boolean,false)) ORDER BY id LOOP
  IF NOT v8.governance_visible(c,item) THEN CONTINUE;END IF;
  IF jsonb_array_length(items)=k THEN more:=true;EXIT;END IF;
  items:=items||jsonb_build_array(v8.governance_view(item));last_id:=item.id;
 END LOOP;
 PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','listed','items',items,'next_cursor',CASE WHEN more THEN last_id ELSE NULL END,'coverage','current_authorized_project_candidates;filtered_before_pagination','decision_owner','current_qualified_Agent_or_member');
END $$;
CREATE FUNCTION v8.governance_claim(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb:=p::jsonb;c jsonb;item v8.governance_candidates;replay jsonb;expiry timestamptz;ttl integer:=coalesce((p::jsonb->>'lease_seconds')::integer,900);
BEGIN
 IF encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=v8.guard(h,'v8.work.commit',d,b);SELECT * INTO item FROM v8.governance_candidates WHERE id=(b->>'candidate_id')::uuid FOR UPDATE;
 IF item.id IS NULL OR NOT v8.governance_visible(c,item) THEN RAISE EXCEPTION 'candidate_forbidden' USING ERRCODE='42501';END IF;
 replay:=v8.replay(c,'governance_claim',b,d);IF replay IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN replay;END IF;
 IF item.revision IS DISTINCT FROM (b->>'expected_revision')::bigint OR item.state='resolved' OR (item.claimed_by IS NOT NULL AND item.claimed_by<>(c->>'actor_id')::uuid AND item.claim_until>clock_timestamp()) THEN PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','conflict','domain_revision',item.revision,'items',jsonb_build_array(v8.governance_view(item)));END IF;
 IF ttl NOT BETWEEN 30 AND 86400 THEN RAISE EXCEPTION 'invalid_claim_lease' USING ERRCODE='22023';END IF;expiry:=clock_timestamp()+make_interval(secs=>ttl);
 PERFORM authz.assert_effect(h);UPDATE v8.governance_candidates SET state='claimed',claimed_by=(c->>'actor_id')::uuid,claim_until=expiry,defer_until=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE id=item.id RETURNING * INTO item;
 INSERT INTO v8.governance_events(candidate_id,actor_id,client_id,source_context_id,kind,revision,payload) VALUES(item.id,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'source_context_id')::uuid,'claimed',item.revision,b);
 PERFORM authz.assert_effect(h);RETURN v8.remember(c,'governance_claim',b,d,gen_random_uuid(),jsonb_build_object('state','claimed','domain_revision',item.revision,'items',jsonb_build_array(v8.governance_view(item))));
END $$;
CREATE FUNCTION v8.governance_resolve(h uuid,d text,p text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb:=p::jsonb;c jsonb;item v8.governance_candidates;replay jsonb;ref jsonb;mode text:=b->>'disposition';links jsonb:=coalesce(b->'revision_links','[]');
BEGIN
 IF encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=v8.guard(h,'v8.work.commit',d,b);SELECT * INTO item FROM v8.governance_candidates WHERE id=(b->>'candidate_id')::uuid FOR UPDATE;
 IF item.id IS NULL OR NOT v8.governance_visible(c,item) THEN RAISE EXCEPTION 'candidate_forbidden' USING ERRCODE='42501';END IF;
 replay:=v8.replay(c,'governance_resolve',b,d);IF replay IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN replay;END IF;
 IF item.revision IS DISTINCT FROM (b->>'expected_revision')::bigint OR item.claimed_by IS DISTINCT FROM (c->>'actor_id')::uuid OR item.state<>'claimed' OR item.claim_until IS NULL OR item.claim_until<=clock_timestamp() THEN PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','conflict','domain_revision',item.revision);END IF;
 IF mode IS NULL OR mode NOT IN('resolved','deferred','needs_revision','dismissed','reused') OR jsonb_typeof(links)<>'array' THEN RAISE EXCEPTION 'invalid_disposition' USING ERRCODE='22023';END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(links) LOOP PERFORM v8.assert_ref(c,ref);END LOOP;
 IF mode='deferred' AND b->>'defer_until' IS NOT NULL AND (b->>'defer_until')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'invalid_defer_until' USING ERRCODE='22023';END IF;
 PERFORM authz.assert_effect(h);UPDATE v8.governance_candidates SET state=CASE WHEN mode IN('deferred','needs_revision') THEN 'deferred' ELSE 'resolved' END,claimed_by=NULL,claim_until=NULL,defer_until=CASE WHEN mode='deferred' THEN (b->>'defer_until')::timestamptz ELSE NULL END,conclusion=b->'conclusion',revision_links=links,revision=revision+1,updated_at=clock_timestamp() WHERE id=item.id RETURNING * INTO item;
 INSERT INTO v8.governance_events(candidate_id,actor_id,client_id,source_context_id,kind,revision,payload) VALUES(item.id,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'source_context_id')::uuid,mode,item.revision,b);
 PERFORM authz.assert_effect(h);RETURN v8.remember(c,'governance_resolve',b,d,gen_random_uuid(),jsonb_build_object('state',item.state,'domain_revision',item.revision,'items',jsonb_build_array(v8.governance_view(item))));
END $$;
REVOKE ALL ON FUNCTION v8.governance_inbox(uuid,text,text),v8.governance_claim(uuid,text,text),v8.governance_resolve(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.governance_inbox(uuid,text,text),v8.governance_claim(uuid,text,text),v8.governance_resolve(uuid,text,text) TO hub2_v8;
RESET ROLE;
