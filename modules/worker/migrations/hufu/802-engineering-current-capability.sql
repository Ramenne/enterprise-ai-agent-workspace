UPDATE authz.engineering_projects SET descriptor=descriptor||'{"resource_valid_until":"2026-10-26T16:00:00Z"}'::jsonb WHERE project_id='fbe863aa-824f-4688-a24d-bc3398754704';
CREATE OR REPLACE FUNCTION authz.engineering_member_email(proof text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;email text;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);
 SELECT u.email INTO email FROM authz.member_accounts m JOIN authn."user" u ON u.id=m.authn_user_id WHERE m.principal_id=(i->>'actor_id')::uuid;
 IF email IS NULL THEN RAISE EXCEPTION 'bound_member_email_required' USING ERRCODE='42501';END IF;
 RETURN email;
END $$;
CREATE OR REPLACE FUNCTION authz.engineering_catalog(proof text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;e record;permit jsonb;access jsonb;items jsonb:='[]';
BEGIN
 i:=authz.authenticate(proof);
 FOR e IN SELECT ep.* FROM authz.engineering_projects ep JOIN v8.projects p ON p.id=ep.project_id WHERE p.organization_id=(i->>'organization_id')::uuid AND (p.visibility='team' OR p.owner_id=(i->>'actor_id')::uuid) AND authz.client_resource_allowed745((i->>'client_id')::uuid,p.id) LOOP
  BEGIN
   permit:=authz.engineering_access(proof,e.project_id,'read');
   access:=jsonb_build_object('state','enabled','expires_at',permit->'deadline','qualification_id',permit->'qualification_id');
  EXCEPTION WHEN insufficient_privilege THEN access:=jsonb_build_object('state','not_granted','next_step','apply_for_whole_project');END;
  items:=items||jsonb_build_array(jsonb_build_object('project_id',e.project_id,'title',e.title,'ready',e.ready,'resources',e.descriptor,'revision',e.revision,'current_access',access));
 END LOOP;
 RETURN jsonb_build_object('state','read','items',items);
END $$;

CREATE OR REPLACE FUNCTION authz.engineering_grant(proof text,p_project uuid,p_principal uuid,p_until timestamptz,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE effective text;i jsonb;r jsonb;qid uuid;acts jsonb;client record;parent uuid;payload jsonb;
BEGIN
 p_until:=least(p_until,(SELECT (descriptor->>'resource_valid_until')::timestamptz FROM authz.engineering_projects WHERE project_id=p_project));
 IF authz.runtime_role()<>'hub2_hufu' OR p_until<=clock_timestamp() OR p_until>clock_timestamp()+interval '30 days' THEN RAISE EXCEPTION 'invalid_engineering_grant' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);effective:=authz.engineering_management_proof(proof,p_project);
 IF NOT EXISTS(SELECT FROM authz.engineering_projects WHERE project_id=p_project AND ready) THEN RAISE EXCEPTION 'engineering_resources_not_ready' USING ERRCODE='42501';END IF;
 acts:='["mem.upload","mem.read","mem.write","mem.delete","mem.share","mem.process","mem.correct","v8.project.read","v8.work.open","v8.work.read","v8.work.commit","v8.work.related_candidates","v8.adoption.set","v8.adoption.read","v8.context.prepare","v8.context.materialize","v8.context.read","v8.handoff.record","v8.handoff.read","v8.experience.publish","v8.experience.feedback","v8.experience.read","resource.read","resource.write","resource.deploy"]'::jsonb;
 payload:=jsonb_build_object('project_id',p_project,'principal_id',p_principal,'actions',acts,'expires_at',p_until);
 IF NOT EXISTS(SELECT FROM v8.projects pr JOIN authz.principals actor ON actor.id=(i->>'actor_id')::uuid WHERE pr.id=p_project AND (pr.manager_id=actor.id OR (actor.role='organization_admin' AND pr.organization_id=actor.organization_id))) THEN
  SELECT q.id INTO parent FROM authz.qualifications q WHERE q.project_id=p_project AND q.principal_id=(i->>'actor_id')::uuid AND q.kind='management' AND authz.management_valid(q.id,(i->>'actor_id')::uuid,p_project) AND acts <@ to_jsonb(q.actions) ORDER BY q.depth LIMIT 1;
  IF parent IS NULL THEN RAISE EXCEPTION 'management_required' USING ERRCODE='42501';END IF;
  payload:=payload||jsonb_build_object('parent_id',parent);
 END IF;
 r:=authz.manage(effective,'qualification.grant',payload,p_key,encode(public.digest(payload::text,'sha256'),'hex'));
 qid:=(r->>'qualification_id')::uuid;
 FOR client IN SELECT id FROM authz.clients WHERE principal_id=p_principal AND active AND 'mem.write'=ANY(actions) AND authz.client_resource_allowed745(id,p_project) LOOP
  INSERT INTO authz.engineering_bindings VALUES(p_project,client.id,qid,p_until,(i->>'actor_id')::uuid)
  ON CONFLICT(project_id,client_id) DO UPDATE SET qualification_id=EXCLUDED.qualification_id,expires_at=EXCLUDED.expires_at,approved_actor_id=EXCLUDED.approved_actor_id;
 END LOOP;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','engineering.resources.granted',qid,jsonb_build_object('project_id',p_project,'principal_id',p_principal,'expires_at',p_until,'resources_ready',true));
 RETURN r||jsonb_build_object('resources_ready',true,'project_id',p_project,'expires_at',p_until,'qualification_scope','whole_registered_project','software_binding','current_work_capable_project_allowed_clients');
END $$;


