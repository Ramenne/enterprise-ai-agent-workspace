BEGIN;
DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='hubxingxiu') THEN CREATE ROLE hubxingxiu LOGIN; END IF; END $$;
CREATE SCHEMA IF NOT EXISTS xingxiu;
CREATE TABLE IF NOT EXISTS xingxiu.agents(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid NOT NULL UNIQUE REFERENCES authz.principals(id),
 actor_id uuid NOT NULL UNIQUE REFERENCES authz.principals(id), client_id uuid NOT NULL UNIQUE REFERENCES authz.clients(id),
 credential_id uuid NOT NULL UNIQUE REFERENCES authz.credentials(id), source_actor_id uuid NOT NULL REFERENCES authz.principals(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), active boolean NOT NULL DEFAULT true
);
-- This is a source-bound read-scope test, not an assumed member identity.
CREATE OR REPLACE FUNCTION xingxiu.member_can_read(member uuid,pid uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE m authz.principals;pr v8.projects;
BEGIN
 SELECT * INTO m FROM authz.principals WHERE id=member;
 SELECT * INTO pr FROM v8.projects WHERE id=pid;
 IF m.active IS DISTINCT FROM true OR m.kind<>'member' OR pr.state<>'active' OR pr.visibility<>'team' OR m.organization_id<>pr.organization_id THEN RETURN false;END IF;
 -- Matches the live ordinary team-read policy in authz.resource_deadline.
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION xingxiu.agent_scope(actor uuid,pid uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a xingxiu.agents;m authz.principals;
BEGIN
 SELECT * INTO a FROM xingxiu.agents WHERE actor_id=actor;
 IF a.id IS NULL THEN RETURN true;END IF;
 SELECT * INTO m FROM authz.principals WHERE id=a.member_id;
 IF NOT a.active OR m.active IS DISTINCT FROM true THEN RETURN false;END IF;
 -- Star project is the explicitly authorized model/derived-data home.
 RETURN pid='de7a588a-480c-4c90-ad67-fbdf0a1d5637'::uuid OR xingxiu.member_can_read(a.member_id,pid);
END $$;
CREATE OR REPLACE FUNCTION xingxiu.members(proof text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i jsonb;
BEGIN
 i:=authz.authenticate(proof);
 IF i->>'member_role'<>'organization_admin' OR NOT (i->'client_actions'?'hufu.principal.manage') THEN RAISE EXCEPTION 'supervisor_required' USING ERRCODE='42501';END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('member_id',id,'display_name',display_name)),'[]') FROM authz.principals WHERE kind='member' AND active AND organization_id=(i->>'organization_id')::uuid);
END $$;
CREATE OR REPLACE FUNCTION xingxiu.register(proof text,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i jsonb;m authz.principals;a xingxiu.agents;pid uuid;cid uuid;cred uuid;aid uuid;pr v8.projects;
 read_actions text[]:=ARRAY['mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.context.read','v8.context.materialize'];
 star_actions text[]:=ARRAY['mem.read','mem.process','v8.project.read','v8.work.read'];
BEGIN
 i:=authz.authenticate(proof);
 IF i->>'member_role'<>'organization_admin' OR NOT(i->'client_actions'?'hufu.principal.manage') OR b->>'token_hash'!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'supervisor_required' USING ERRCODE='42501';END IF;
 SELECT * INTO m FROM authz.principals WHERE id=(b->>'member_id')::uuid;
 IF m.kind<>'member' OR NOT m.active OR m.organization_id<>(i->>'organization_id')::uuid THEN RAISE EXCEPTION 'active_member_required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('xingxiu:'||m.id::text,0));
 SELECT * INTO a FROM xingxiu.agents WHERE member_id=m.id;
 IF a.id IS NULL THEN
  INSERT INTO authz.principals(organization_id,kind,display_name,role,trusted_source)
   VALUES(m.organization_id,'service','星宿·'||m.display_name||'工作理解Agent','member','xingxiu-supervisor-authorized-v1') RETURNING id INTO aid;
  INSERT INTO authz.clients(principal_id,label,actions) VALUES(aid,'星宿常驻维护/15分钟',read_actions||ARRAY['mem.process']) RETURNING id INTO cid;
  INSERT INTO authz.credentials(client_id,token_hash,until_revoked,authority_source) VALUES(cid,b->>'token_hash',true,'xingxiu_internal_agent') RETURNING id INTO cred;
  INSERT INTO xingxiu.agents(member_id,actor_id,client_id,credential_id,source_actor_id) VALUES(m.id,aid,cid,cred,(i->>'actor_id')::uuid) RETURNING * INTO a;
 ELSE
  IF NOT EXISTS(SELECT FROM authz.credentials WHERE id=a.credential_id AND token_hash=b->>'token_hash' AND revoked_at IS NULL) THEN RAISE EXCEPTION 'agent_credential_changed;no_implicit_rotation';END IF;
 END IF;
 -- Refresh only this Agent's derived grants. Existing unrelated grants are untouched.
 UPDATE authz.qualifications SET active=false,epoch=epoch+1 WHERE principal_id=a.actor_id AND source_basis='management_appointment' AND active AND NOT xingxiu.agent_scope(a.actor_id,project_id);
 FOR pr IN SELECT * FROM v8.projects WHERE id='de7a588a-480c-4c90-ad67-fbdf0a1d5637'::uuid OR xingxiu.member_can_read(m.id,id) LOOP
  IF NOT EXISTS(SELECT FROM authz.qualifications q WHERE q.principal_id=a.actor_id AND q.project_id=pr.id AND q.source_basis='management_appointment' AND q.active) THEN
   INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,kind,depth,until_revoked,source_project_revision,source_basis)
    VALUES(a.actor_id,pr.id,CASE WHEN pr.id='de7a588a-480c-4c90-ad67-fbdf0a1d5637'::uuid THEN star_actions ELSE read_actions END,(i->>'actor_id')::uuid,'work',0,true,pr.revision,'management_appointment');
  END IF;
 END LOOP;
 RETURN to_jsonb(a)||jsonb_build_object('display_name',m.display_name,'state','registered','credential_value_returned',false);
END $$;
CREATE OR REPLACE FUNCTION xingxiu.heads(proof text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i jsonb;a xingxiu.agents;
BEGIN
 i:=authz.authenticate(proof);SELECT * INTO a FROM xingxiu.agents WHERE actor_id=(i->>'actor_id')::uuid;
 IF a.id IS NULL OR NOT a.active OR NOT(i->'client_actions'?'v8.work.read') THEN RAISE EXCEPTION 'xingxiu_agent_required' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('agent',to_jsonb(a),'projects',(SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',p.id,'title',p.title)),'[]') FROM v8.projects p WHERE xingxiu.agent_scope(a.actor_id,p.id) AND p.visibility='team' AND p.state='active' AND EXISTS(SELECT FROM authz.qualifications q WHERE q.principal_id=a.actor_id AND q.project_id=p.id AND authz.qualification_deadline(q.id,a.actor_id,p.id,'v8.work.read',jsonb_build_object('project_id',p.id))>clock_timestamp())),
 'works',(SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',w.project_id,'work_item_id',w.id,'revision',w.revision,'record_actor_id',w.actor_id,'updated_at',w.updated_at) ORDER BY w.updated_at DESC,w.id),'[]') FROM v8.work_items w JOIN v8.projects p ON p.id=w.project_id WHERE p.visibility='team' AND p.state='active' AND xingxiu.agent_scope(a.actor_id,p.id) AND EXISTS(SELECT FROM authz.qualifications q WHERE q.principal_id=a.actor_id AND q.project_id=p.id AND authz.qualification_deadline(q.id,a.actor_id,p.id,'v8.work.read',jsonb_build_object('project_id',p.id))>clock_timestamp())));
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA xingxiu FROM PUBLIC;
REVOKE ALL ON FUNCTION xingxiu.member_can_read(uuid,uuid),xingxiu.agent_scope(uuid,uuid),xingxiu.members(text),xingxiu.register(text,jsonb),xingxiu.heads(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA xingxiu TO hubxingxiu;
GRANT CONNECT ON DATABASE hub_core TO hubxingxiu;
GRANT EXECUTE ON FUNCTION xingxiu.members(text),xingxiu.register(text,jsonb),xingxiu.heads(text) TO hubxingxiu;
COMMIT;
