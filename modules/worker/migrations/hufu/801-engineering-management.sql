CREATE FUNCTION authz.engineering_manage(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;effective text;pid uuid;actor uuid;parent uuid;command text;payload jsonb;acts jsonb;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);actor:=(i->>'actor_id')::uuid;pid:=(b->>'project_id')::uuid;effective:=authz.engineering_management_proof(proof,pid);
 IF b->>'operation'='delegate' THEN
  command:='management.delegate';
  acts:='["mem.upload","mem.read","mem.write","mem.delete","mem.share","mem.process","mem.correct","v8.project.read","v8.project.update","v8.project.convert","v8.work.open","v8.work.read","v8.work.commit","v8.work.related_candidates","v8.adoption.set","v8.adoption.read","v8.context.prepare","v8.context.materialize","v8.context.read","v8.handoff.record","v8.handoff.read","v8.experience.publish","v8.experience.feedback","v8.experience.read","resource.read","resource.write","resource.deploy"]'::jsonb;
  payload:=jsonb_build_object('project_id',pid,'principal_id',(b->>'principal_id')::uuid,'actions',acts,'expires_at',(b->>'expires_at')::timestamptz);
  IF (b->>'expires_at')::timestamptz<=clock_timestamp() OR (b->>'expires_at')::timestamptz>clock_timestamp()+interval '30 days' THEN RAISE EXCEPTION 'invalid_expiry' USING ERRCODE='22023';END IF;
 ELSIF b->>'operation' IN('freeze','unfreeze','revoke') THEN
  command:='qualification.'||(b->>'operation');payload:=jsonb_build_object('project_id',pid,'qualification_id',(b->>'qualification_id')::uuid);
  IF NOT EXISTS(SELECT FROM v8.projects p JOIN authz.principals a ON a.id=actor WHERE p.id=pid AND (p.manager_id=actor OR (a.role='organization_admin' AND a.organization_id=p.organization_id))) THEN
   SELECT id INTO parent FROM authz.qualifications q WHERE q.project_id=pid AND q.principal_id=actor AND q.kind='management' AND authz.management_valid(q.id,actor,pid) ORDER BY depth LIMIT 1;
   IF parent IS NULL THEN RAISE EXCEPTION 'management_required' USING ERRCODE='42501';END IF;
   payload:=payload||jsonb_build_object('parent_id',parent);
  END IF;
 ELSE RAISE EXCEPTION 'invalid_operation' USING ERRCODE='22023';END IF;
 RETURN authz.manage(effective,command,payload,b->>'idempotency_key',encode(public.digest(payload::text,'sha256'),'hex'));
END $$;
REVOKE ALL ON FUNCTION authz.engineering_manage(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.engineering_manage(text,jsonb) TO hub2_hufu;

CREATE OR REPLACE FUNCTION authz.engineering_grant(proof text,p_project uuid,p_principal uuid,p_until timestamptz,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE effective text;i jsonb;r jsonb;qid uuid;acts jsonb;client record;parent uuid;payload jsonb;
BEGIN
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


