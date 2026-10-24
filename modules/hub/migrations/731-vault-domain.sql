-- Original 2.0 additive module. No users, credentials, grants or secret values are seeded.
-- Root assigns canonical migration number; parent authz/v8 APIs remain unchanged.
BEGIN;
DO $$BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='hub2_authz_owner'AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)THEN RAISE EXCEPTION 'existing_restricted_authz_owner_required';END IF;END$$;
CREATE SCHEMA vault2 AUTHORIZATION hub2_authz_owner;
GRANT REFERENCES(id) ON v8.projects TO hub2_authz_owner;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.vault_current_identity(proof text,pid uuid DEFAULT NULL)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$DECLARE i jsonb;BEGIN
 IF authz.runtime_role()<>'hub2_hufu'THEN RAISE EXCEPTION 'vault_runtime_forbidden' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals WHERE id=(i->>'actor_id')::uuid OR id IN(SELECT owner_id FROM v8.projects WHERE id=pid)OR id IN(SELECT manager_id FROM v8.projects WHERE id=pid)ORDER BY id FOR SHARE;
 PERFORM id FROM authz.clients WHERE id=(i->>'client_id')::uuid FOR SHARE;PERFORM id FROM authz.credentials WHERE id=(i->>'credential_id')::uuid FOR SHARE;
 IF pid IS NOT NULL THEN PERFORM id FROM v8.projects WHERE id=pid FOR SHARE;PERFORM id FROM authz.qualifications WHERE project_id=pid AND(principal_id=(i->>'actor_id')::uuid OR id IN(SELECT parent_id FROM authz.qualifications WHERE principal_id=(i->>'actor_id')::uuid AND project_id=pid))ORDER BY id FOR SHARE;END IF;
 RETURN authz.authenticate(proof);
END$$;
REVOKE ALL ON FUNCTION authz.vault_current_identity(text,uuid)FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
GRANT EXECUTE ON FUNCTION authz.vault_current_identity(text,uuid)TO hub2_authz_owner;
RESET ROLE;
SET ROLE hub2_authz_owner;
CREATE TABLE vault2.entries(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,project_id uuid NOT NULL REFERENCES v8.projects,area_id uuid,
 name text NOT NULL CHECK(length(name)BETWEEN 1 AND 200),label text NOT NULL,description text NOT NULL DEFAULT '',
 kind text NOT NULL CHECK(kind IN('model_api','service_login','generic','server_manage','dns_manage','cos_manage')),
 visibility text NOT NULL DEFAULT 'organization' CHECK(visibility IN('organization','project','owner')),owner_id uuid NOT NULL REFERENCES authz.principals,
 secret_ref text NOT NULL CHECK(secret_ref LIKE 'bao:hub2/hufu/vault2/%'AND position('..'in secret_ref)=0),value_field text NOT NULL DEFAULT 'value',
 execution_channel jsonb NOT NULL DEFAULT '{}',revision bigint NOT NULL DEFAULT 1,active boolean NOT NULL DEFAULT true,
 provider_expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(organization_id,name));
CREATE TABLE vault2.grants(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),entry_id uuid NOT NULL REFERENCES vault2.entries,principal_id uuid NOT NULL REFERENCES authz.principals,
 client_id uuid REFERENCES authz.clients,issued_by uuid NOT NULL REFERENCES authz.principals,
 until_revoked boolean NOT NULL DEFAULT false,expires_at timestamptz,revoked_at timestamptz,revision bigint NOT NULL DEFAULT 1,
 reason jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(until_revoked OR expires_at IS NOT NULL));
CREATE TABLE vault2.applications(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),entry_id uuid NOT NULL REFERENCES vault2.entries,applicant_id uuid NOT NULL REFERENCES authz.principals,
 applicant_client_id uuid NOT NULL REFERENCES authz.clients,idempotency_key text NOT NULL,fingerprint text NOT NULL,
 purpose jsonb,requested_until_revoked boolean NOT NULL DEFAULT false,requested_expires_at timestamptz,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','approved','rejected','withdrawn')),revision bigint NOT NULL DEFAULT 1,
 decided_by uuid REFERENCES authz.principals,grant_id uuid REFERENCES vault2.grants,decision jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(applicant_id,idempotency_key));
CREATE TABLE vault2.audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,actor_id uuid NOT NULL,client_id uuid NOT NULL,action text NOT NULL,entry_id uuid,application_id uuid,grant_id uuid,details jsonb NOT NULL DEFAULT '{}',at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE vault2.commands(actor_id uuid NOT NULL,key text NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(actor_id,key));
CREATE TABLE vault2.reveal_tickets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL,client_id uuid NOT NULL,credential_id uuid NOT NULL,entry_id uuid NOT NULL REFERENCES vault2.entries,entry_revision bigint NOT NULL,grant_id uuid NOT NULL REFERENCES vault2.grants,grant_revision bigint NOT NULL,expires_at timestamptz NOT NULL,state text NOT NULL DEFAULT 'prepared'CHECK(state IN('prepared','released','failed')));
REVOKE ALL ON ALL TABLES IN SCHEMA vault2 FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
DO $vault_rls$DECLARE item record;BEGIN FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='vault2'LOOP EXECUTE format('ALTER TABLE vault2.%I ENABLE ROW LEVEL SECURITY',item.tablename);END LOOP;END $vault_rls$;
CREATE FUNCTION vault2.identity(proof text)RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$SELECT authz.vault_current_identity(proof,NULL)$$;
CREATE FUNCTION vault2.manager_deadline(i jsonb,e vault2.entries)RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$DECLARE p authz.principals;pr v8.projects;q authz.qualifications;root authz.qualifications;deadline timestamptz;best timestamptz;BEGIN
 BEGIN PERFORM authz.require_client_capability(i,'hufu.credential.manage');EXCEPTION WHEN insufficient_privilege THEN RETURN NULL;END;SELECT * INTO p FROM authz.principals WHERE id=(i->>'actor_id')::uuid;SELECT * INTO pr FROM v8.projects WHERE id=e.project_id;
 IF p.active IS DISTINCT FROM true OR pr.state IS DISTINCT FROM 'active'OR p.organization_id IS DISTINCT FROM e.organization_id OR pr.organization_id IS DISTINCT FROM e.organization_id OR NOT EXISTS(SELECT FROM authz.clients WHERE id=(i->>'client_id')::uuid AND active AND principal_id=p.id AND 'hufu.credential.manage'=ANY(actions))THEN RETURN NULL;END IF;
 IF p.role='organization_admin'OR pr.manager_id=p.id OR(pr.visibility='personal'AND pr.owner_id=p.id)THEN RETURN'infinity'::timestamptz;END IF;
 FOR q IN SELECT * FROM authz.qualifications WHERE principal_id=p.id AND project_id=e.project_id AND 'credential.manage'=ANY(actions)LOOP
  IF authz.management_valid(q.id,p.id,e.project_id)AND authz.selector_matches(q.resource_selector,e.project_id,jsonb_build_object('project_id',e.project_id,'area_id',e.area_id))THEN
   deadline:=CASE WHEN q.until_revoked THEN'infinity'::timestamptz ELSE q.expires_at END;
   IF q.parent_id IS NOT NULL THEN SELECT * INTO root FROM authz.qualifications WHERE id=q.parent_id;deadline:=least(deadline,CASE WHEN root.until_revoked THEN'infinity'::timestamptz ELSE root.expires_at END);END IF;
   best:=greatest(best,deadline);
  END IF;
 END LOOP;RETURN best;
END$$;
CREATE FUNCTION vault2.manager(i jsonb,e vault2.entries)RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$SELECT coalesce(vault2.manager_deadline(i,e)>clock_timestamp(),false)$$;
CREATE FUNCTION vault2.visible(i jsonb,e vault2.entries)RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$SELECT e.active AND e.organization_id=(i->>'organization_id')::uuid AND(e.visibility='organization'OR e.owner_id=(i->>'actor_id')::uuid OR vault2.manager(i,e)OR EXISTS(SELECT FROM vault2.grants g WHERE g.entry_id=e.id AND g.principal_id=(i->>'actor_id')::uuid AND(g.client_id IS NULL OR g.client_id=(i->>'client_id')::uuid)AND g.revoked_at IS NULL AND(g.until_revoked OR g.expires_at>clock_timestamp()))OR(e.visibility='project'AND EXISTS(SELECT FROM v8.projects WHERE id=e.project_id AND state='active'AND organization_id=e.organization_id AND visibility='team')))$$;
CREATE FUNCTION vault2.high_sensitive(e vault2.entries)RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$SELECT e.kind IN('server_manage','dns_manage','cos_manage')OR lower(e.name)LIKE'server.%'OR lower(e.name)LIKE'dns.%'OR lower(e.name)LIKE'storage.cos.manage%'$$;
CREATE FUNCTION vault2.allowed_grant(i jsonb,e vault2.entries)RETURNS vault2.grants LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$DECLARE g vault2.grants;BEGIN
 IF NOT e.active OR e.organization_id IS DISTINCT FROM(i->>'organization_id')::uuid OR(e.provider_expires_at IS NOT NULL AND e.provider_expires_at<=clock_timestamp())THEN RAISE EXCEPTION 'vault_access_required' USING ERRCODE='42501';END IF;
 PERFORM authz.require_client_capability(i,'hufu.vault.read');SELECT * INTO g FROM vault2.grants WHERE entry_id=e.id AND principal_id=(i->>'actor_id')::uuid AND(client_id IS NULL OR client_id=(i->>'client_id')::uuid)AND revoked_at IS NULL AND(until_revoked OR expires_at>clock_timestamp())ORDER BY created_at DESC LIMIT 1;
 IF g.id IS NULL THEN RAISE EXCEPTION 'vault_access_required' USING ERRCODE='42501';END IF;RETURN g;
END$$;
CREATE FUNCTION vault2.resolve_entry(i jsonb,b jsonb)RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$SELECT id FROM vault2.entries WHERE organization_id=(i->>'organization_id')::uuid AND ((b->>'entry_id'IS NOT NULL AND id=(b->>'entry_id')::uuid)OR(b->>'entry_id'IS NULL AND name=b->>'key'))$$;
CREATE FUNCTION vault2.directory(proof text,b jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$DECLARE i jsonb;n integer;items jsonb;BEGIN
 i:=vault2.identity(proof);n:=coalesce((b->>'limit')::integer,50);IF n NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_input';END IF;
 SELECT coalesce(jsonb_agg(x),'[]')INTO items FROM(SELECT e.id,e.name,e.label,e.description,e.kind,e.revision,e.project_id,vault2.high_sensitive(e)execution_channel_only,
 EXISTS(SELECT FROM vault2.grants g WHERE g.entry_id=e.id AND g.principal_id=(i->>'actor_id')::uuid AND(g.client_id IS NULL OR g.client_id=(i->>'client_id')::uuid)AND g.revoked_at IS NULL AND(g.until_revoked OR g.expires_at>clock_timestamp()))has_current_grant
 FROM vault2.entries e WHERE vault2.visible(i,e)AND(b->>'cursor'IS NULL OR e.id>(b->>'cursor')::uuid)AND(coalesce(b->>'query','')=''OR position(lower(b->>'query')in lower(e.name||' '||e.label))>0)ORDER BY e.id LIMIT n)x;
 RETURN jsonb_build_object('state','directory','items',items,'next_cursor',CASE WHEN jsonb_array_length(items)=n THEN items->(n-1)->'id'ELSE NULL END,'coverage','authorized_metadata_page','secrets_included',false);
END$$;
CREATE FUNCTION vault2.apply(proof text,b jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$DECLARE i jsonb;e vault2.entries;a vault2.applications;fp text:=encode(public.digest(b::text,'sha256'),'hex');BEGIN
 i:=vault2.identity(proof);SELECT * INTO e FROM vault2.entries WHERE id=vault2.resolve_entry(i,b) FOR SHARE;IF e.id IS NULL OR NOT vault2.visible(i,e)THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 IF coalesce(length(b->>'idempotency_key'),0)NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_input';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended((i->>'actor_id')||':vaultapply:'||(b->>'idempotency_key'),0));SELECT * INTO a FROM vault2.applications WHERE applicant_id=(i->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key';
 IF a.id IS NOT NULL THEN IF a.fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;ELSE
 INSERT INTO vault2.applications(entry_id,applicant_id,applicant_client_id,idempotency_key,fingerprint,purpose,requested_until_revoked,requested_expires_at)VALUES(e.id,(i->>'actor_id')::uuid,(i->>'client_id')::uuid,b->>'idempotency_key',fp,b->'purpose',coalesce((b->>'until_revoked')::boolean,false),(b->>'expires_at')::timestamptz)RETURNING * INTO a;
 INSERT INTO vault2.audit(actor_id,client_id,action,entry_id,application_id)VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'apply',e.id,a.id);END IF;
 RETURN jsonb_build_object('state',a.state,'application_id',a.id,'revision',a.revision,'entry_id',e.id,'next_step','authorized_manager_decides');END$$;
CREATE FUNCTION vault2.applications(proof text,b jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$DECLARE i jsonb;items jsonb;BEGIN i:=vault2.identity(proof);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'entry_id',a.entry_id,'applicant_id',a.applicant_id,'applicant_client_id',a.applicant_client_id,'purpose',a.purpose,'state',a.state,'revision',a.revision,'requested_expires_at',a.requested_expires_at,'requested_until_revoked',a.requested_until_revoked)ORDER BY a.id),'[]')INTO items FROM(SELECT a.* FROM vault2.applications a JOIN vault2.entries e ON e.id=a.entry_id WHERE((b->>'entry_id'IS NULL AND b->>'key'IS NULL)OR e.id=vault2.resolve_entry(i,b))AND(a.applicant_id=(i->>'actor_id')::uuid OR vault2.manager(i,e))AND(coalesce(b->>'state','pending')=a.state)AND(b->>'cursor'IS NULL OR a.id>(b->>'cursor')::uuid)ORDER BY a.id LIMIT 100)a;
 RETURN jsonb_build_object('state','applications','items',items,'next_cursor',CASE WHEN jsonb_array_length(items)=100 THEN items->99->'id'ELSE NULL END,'coverage','bounded_current_scope_page');END$$;
CREATE FUNCTION vault2.decide(proof text,b jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$DECLARE i jsonb;e vault2.entries;a vault2.applications;g vault2.grants;result jsonb;old vault2.commands;command_key text:=b->>'idempotency_key';fp text:=encode(public.digest(b::text,'sha256'),'hex');expiry timestamptz;unlimited boolean;ceiling timestamptz;BEGIN
 i:=vault2.identity(proof);SELECT * INTO a FROM vault2.applications WHERE id=(b->>'application_id')::uuid;SELECT * INTO e FROM vault2.entries WHERE id=a.entry_id FOR SHARE;
 i:=authz.vault_current_identity(proof,e.project_id);
 IF a.id IS NULL OR NOT vault2.manager(i,e)THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;IF coalesce(length(command_key),0)NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_input';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended((i->>'actor_id')||':vaultdecide:'||command_key,0));SELECT * INTO old FROM vault2.commands WHERE actor_id=(i->>'actor_id')::uuid AND vault2.commands.key=command_key;
 IF old.key IS NOT NULL THEN IF old.fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;RETURN old.result;END IF;
 SELECT * INTO a FROM vault2.applications WHERE id=a.id FOR UPDATE;i:=authz.vault_current_identity(proof,e.project_id);IF NOT vault2.manager(i,e)THEN RAISE EXCEPTION 'current_manager_required' USING ERRCODE='42501';END IF;IF a.revision IS DISTINCT FROM(b->>'expected_revision')::bigint OR a.state<>'pending'THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001';END IF;
 IF b->>'decision'IS NULL OR b->>'decision'NOT IN('approve','reject')THEN RAISE EXCEPTION 'invalid_input';END IF;
 IF b->>'decision'='approve'THEN
  unlimited:=coalesce((b->>'until_revoked')::boolean,a.requested_until_revoked);expiry:=coalesce((b->>'expires_at')::timestamptz,a.requested_expires_at);IF NOT unlimited AND(expiry IS NULL OR expiry<=clock_timestamp())THEN RAISE EXCEPTION 'finite_expiry_or_until_revoked_required';END IF;
  ceiling:=least(vault2.manager_deadline(i,e),coalesce(e.provider_expires_at,'infinity'::timestamptz));expiry:=least(CASE WHEN unlimited THEN'infinity'::timestamptz ELSE expiry END,ceiling);unlimited:=NOT isfinite(expiry);IF unlimited THEN expiry:=NULL;END IF;
  IF NOT EXISTS(SELECT FROM authz.principals p JOIN authz.clients c ON c.principal_id=p.id WHERE p.id=a.applicant_id AND p.active AND p.organization_id=e.organization_id AND c.id=a.applicant_client_id AND c.active)THEN RAISE EXCEPTION 'current_applicant_required' USING ERRCODE='42501';END IF;
  INSERT INTO vault2.grants(entry_id,principal_id,client_id,issued_by,until_revoked,expires_at,reason)VALUES(e.id,a.applicant_id,a.applicant_client_id,(i->>'actor_id')::uuid,unlimited,expiry,b->'reason')RETURNING * INTO g;
 END IF;
 UPDATE vault2.applications SET state=CASE WHEN b->>'decision'='approve'THEN'approved'ELSE'rejected'END,revision=revision+1,decided_by=(i->>'actor_id')::uuid,grant_id=g.id,decision=b->'reason'WHERE id=a.id RETURNING * INTO a;
 result:=jsonb_build_object('state',a.state,'application_id',a.id,'revision',a.revision,'grant_id',g.id,'entry_id',e.id);
 INSERT INTO vault2.audit(actor_id,client_id,action,entry_id,application_id,grant_id,details)VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'decide',e.id,a.id,g.id,jsonb_build_object('decision',a.state));INSERT INTO vault2.commands VALUES((i->>'actor_id')::uuid,command_key,fp,result);PERFORM vault2.identity(proof);IF NOT vault2.manager(i,e)THEN RAISE EXCEPTION 'current_manager_required' USING ERRCODE='42501';END IF;RETURN result;
END$$;
CREATE FUNCTION vault2.grants(proof text,b jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$DECLARE i jsonb;items jsonb;BEGIN i:=vault2.identity(proof);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',g.id,'entry_id',g.entry_id,'principal_id',g.principal_id,'client_id',g.client_id,'until_revoked',g.until_revoked,'expires_at',g.expires_at,'revoked_at',g.revoked_at,'revision',g.revision)ORDER BY g.id),'[]')INTO items FROM(SELECT g.* FROM vault2.grants g JOIN vault2.entries e ON e.id=g.entry_id WHERE(g.principal_id=(i->>'actor_id')::uuid OR vault2.manager(i,e))AND((b->>'entry_id'IS NULL AND b->>'key'IS NULL)OR g.entry_id=vault2.resolve_entry(i,b))AND(b->>'cursor'IS NULL OR g.id>(b->>'cursor')::uuid)ORDER BY g.id LIMIT 100)g;
 RETURN jsonb_build_object('state','grants','items',items,'next_cursor',CASE WHEN jsonb_array_length(items)=100 THEN items->99->'id'ELSE NULL END,'coverage','bounded_current_scope_page');END$$;
CREATE FUNCTION vault2.revoke(proof text,b jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$DECLARE i jsonb;e vault2.entries;g vault2.grants;BEGIN i:=vault2.identity(proof);SELECT * INTO g FROM vault2.grants WHERE id=(b->>'grant_id')::uuid;SELECT * INTO e FROM vault2.entries WHERE id=g.entry_id FOR SHARE;
 i:=authz.vault_current_identity(proof,e.project_id);IF g.id IS NULL OR NOT vault2.manager(i,e)THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;SELECT * INTO g FROM vault2.grants WHERE id=g.id FOR UPDATE;IF g.revision IS DISTINCT FROM(b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001';END IF;
 i:=authz.vault_current_identity(proof,e.project_id);IF NOT vault2.manager(i,e)THEN RAISE EXCEPTION 'current_manager_required' USING ERRCODE='42501';END IF;UPDATE vault2.grants SET revoked_at=coalesce(revoked_at,clock_timestamp()),revision=revision+1 WHERE id=g.id RETURNING * INTO g;INSERT INTO vault2.audit(actor_id,client_id,action,entry_id,grant_id)VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'revoke',e.id,g.id);RETURN jsonb_build_object('state','revoked','grant_id',g.id,'revision',g.revision);END$$;
CREATE FUNCTION vault2.reveal_prepare(proof text,b jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$DECLARE i jsonb;e vault2.entries;g vault2.grants;t vault2.reveal_tickets;BEGIN
 i:=vault2.identity(proof);SELECT * INTO e FROM vault2.entries WHERE id=vault2.resolve_entry(i,b) FOR SHARE;g:=vault2.allowed_grant(i,e);SELECT * INTO g FROM vault2.grants WHERE id=g.id FOR SHARE;i:=vault2.identity(proof);PERFORM vault2.allowed_grant(i,e);IF g.revoked_at IS NOT NULL OR(NOT g.until_revoked AND g.expires_at<=clock_timestamp())THEN RAISE EXCEPTION 'vault_access_required' USING ERRCODE='42501';END IF;
 IF vault2.high_sensitive(e)THEN INSERT INTO vault2.audit(actor_id,client_id,action,entry_id,grant_id)VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'execution_channel',e.id,g.id);RETURN jsonb_build_object('state','use_execution_channel','entry_id',e.id,'channel',e.execution_channel,'plaintext_returned',false);END IF;
 INSERT INTO vault2.reveal_tickets(actor_id,client_id,credential_id,entry_id,entry_revision,grant_id,grant_revision,expires_at)VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,(i->>'credential_id')::uuid,e.id,e.revision,g.id,g.revision,least(clock_timestamp()+interval'30 seconds',CASE WHEN g.until_revoked THEN'infinity'::timestamptz ELSE g.expires_at END))RETURNING * INTO t;
 INSERT INTO vault2.audit(actor_id,client_id,action,entry_id,grant_id,details)VALUES(t.actor_id,t.client_id,'reveal_prepare',e.id,g.id,jsonb_build_object('ticket_id',t.id));RETURN jsonb_build_object('state','authorized_prepare','ticket_id',t.id,'entry_id',e.id,'secret_ref',e.secret_ref,'value_field',e.value_field,'entry_revision',e.revision);
END$$;
CREATE FUNCTION vault2.reveal_finish(proof text,b jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$DECLARE i jsonb;e vault2.entries;g vault2.grants;t vault2.reveal_tickets;BEGIN
 i:=vault2.identity(proof);SELECT * INTO t FROM vault2.reveal_tickets WHERE id=(b->>'ticket_id')::uuid;SELECT * INTO e FROM vault2.entries WHERE id=t.entry_id FOR SHARE;SELECT * INTO g FROM vault2.grants WHERE id=t.grant_id FOR SHARE;SELECT * INTO t FROM vault2.reveal_tickets WHERE id=t.id FOR UPDATE;
 IF b->>'result'IS NULL OR b->>'result'NOT IN('released','failed')THEN RAISE EXCEPTION 'invalid_input';END IF;IF t.id IS NULL OR t.actor_id IS DISTINCT FROM(i->>'actor_id')::uuid OR t.client_id IS DISTINCT FROM(i->>'client_id')::uuid OR t.credential_id IS DISTINCT FROM(i->>'credential_id')::uuid OR t.state<>'prepared'OR t.expires_at<=clock_timestamp()OR e.revision IS DISTINCT FROM t.entry_revision OR g.revision IS DISTINCT FROM t.grant_revision OR vault2.high_sensitive(e)THEN RAISE EXCEPTION 'current_vault_release_required' USING ERRCODE='42501';END IF;
 i:=vault2.identity(proof);PERFORM vault2.allowed_grant(i,e);IF g.revoked_at IS NOT NULL OR(NOT g.until_revoked AND g.expires_at<=clock_timestamp())THEN RAISE EXCEPTION 'current_vault_release_required' USING ERRCODE='42501';END IF;
 UPDATE vault2.reveal_tickets SET state=CASE WHEN b->>'result'='released'THEN'released'ELSE'failed'END WHERE id=t.id;INSERT INTO vault2.audit(actor_id,client_id,action,entry_id,grant_id,details)VALUES(t.actor_id,t.client_id,CASE WHEN b->>'result'='released'THEN'reveal_released'ELSE'reveal_failed'END,e.id,g.id,jsonb_build_object('ticket_id',t.id));RETURN jsonb_build_object('state',CASE WHEN b->>'result'='released'THEN'authorized_release'ELSE'failed'END,'entry_id',e.id);
END$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA vault2 FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
GRANT USAGE ON SCHEMA vault2 TO hub2_hufu;
GRANT EXECUTE ON FUNCTION vault2.directory(text,jsonb),vault2.apply(text,jsonb),vault2.applications(text,jsonb),vault2.decide(text,jsonb),vault2.grants(text,jsonb),vault2.revoke(text,jsonb),vault2.reveal_prepare(text,jsonb),vault2.reveal_finish(text,jsonb)TO hub2_hufu;
RESET ROLE;
COMMIT;
