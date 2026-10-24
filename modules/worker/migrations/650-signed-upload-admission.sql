-- Signed direct upload admission: work intent vs surviving URL capability.
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.upload_signature_deadline(hid uuid)RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;src authz.handle_sources;until_at timestamptz;credential_until timestamptz;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF authz.runtime_role()IS DISTINCT FROM'hub2_mem'OR h.id IS NULL OR h.action IS DISTINCT FROM'mem.upload'OR h.audience IS DISTINCT FROM'mem'OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id()THEN RAISE EXCEPTION 'upload_deadline_guard_required' USING ERRCODE='42501';END IF;
 PERFORM authz.assert_effect(hid);
 until_at:=authz.resource_deadline(h.principal_id,h.client_id,h.project_id,h.action,coalesce(h.resource->'resolved_resource',h.resource));
 WITH RECURSIVE family AS(SELECT id,parent_credential_id,expires_at,until_revoked FROM authz.credentials WHERE id=h.credential_id UNION SELECT p.id,p.parent_credential_id,p.expires_at,p.until_revoked FROM authz.credentials p JOIN family f ON p.id=f.parent_credential_id)SELECT min(CASE WHEN until_revoked THEN'infinity'::timestamptz ELSE expires_at END)INTO credential_until FROM family;
 IF credential_until IS NULL THEN RAISE EXCEPTION 'upload_credential_deadline_unknown' USING ERRCODE='42501';END IF;
 until_at:=least(until_at,credential_until);
 FOR src IN SELECT * FROM authz.handle_sources WHERE handle_id=hid LOOP until_at:=least(until_at,authz.resource_deadline(h.principal_id,h.client_id,src.project_id,src.action,src.resource));END LOOP;
 RETURN until_at;
END $$;
REVOKE ALL ON FUNCTION authz.upload_signature_deadline(uuid)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.upload_signature_deadline(uuid)TO hub2_mem_owner;
RESET ROLE;
SET ROLE hub2_mem_owner;
CREATE TABLE mem.signed_upload_policy(id boolean PRIMARY KEY DEFAULT true CHECK(id),operation_active_parts integer NOT NULL DEFAULT 8 CHECK(operation_active_parts>0),client_active_parts integer NOT NULL DEFAULT 32 CHECK(client_active_parts>0),ticket_ttl_seconds integer NOT NULL DEFAULT 300 CHECK(ticket_ttl_seconds BETWEEN 1 AND 300),operation_live_capabilities integer CHECK(operation_live_capabilities>0),client_live_capabilities integer CHECK(client_live_capabilities>0));
INSERT INTO mem.signed_upload_policy DEFAULT VALUES;
ALTER TABLE mem.upload_tickets ADD actor_id uuid,ADD admission_generation uuid NOT NULL DEFAULT gen_random_uuid(),ADD intent_epoch uuid NOT NULL DEFAULT gen_random_uuid(),ADD intent_active boolean NOT NULL DEFAULT true,ADD intent_until timestamptz,ADD capability_state text NOT NULL DEFAULT'legacy_possibly_issued',ADD signature_issued_at timestamptz,ADD signature_requests bigint NOT NULL DEFAULT 0,ADD observed_at timestamptz,ADD provider_part_etag text,ADD provider_terminal boolean NOT NULL DEFAULT false;
UPDATE mem.upload_tickets t SET actor_id=o.actor_id,intent_until=t.expires_at,intent_active=(t.expires_at>clock_timestamp())FROM mem.operations o WHERE o.id=t.operation_id;
ALTER TABLE mem.upload_tickets ALTER intent_until SET NOT NULL;
CREATE TABLE mem.upload_ticket_clients(operation_id uuid NOT NULL,part_number integer NOT NULL,grant_generation uuid NOT NULL,intent_epoch uuid NOT NULL,client_id uuid NOT NULL,requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),signature_issued_at timestamptz,PRIMARY KEY(operation_id,part_number,grant_generation,intent_epoch,client_id),FOREIGN KEY(operation_id,part_number)REFERENCES mem.upload_tickets(operation_id,part_number));
REVOKE ALL ON mem.signed_upload_policy,mem.upload_ticket_clients FROM PUBLIC,hub2_mem,hub2_hufu,hub2_worker,hub2_v8;
CREATE FUNCTION mem.upload_ticket_result(o mem.operations,s mem.upload_sessions,caller uuid)RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,mem AS $$
DECLARE policy mem.signed_upload_policy;workparts bigint;workbytes bigint;liveparts bigint;livebytes bigint;clientparts bigint;
BEGIN
 SELECT * INTO policy FROM mem.signed_upload_policy WHERE id;
 SELECT count(*),coalesce(sum(t.size),0)INTO workparts,workbytes FROM mem.upload_tickets t WHERE t.operation_id=o.id AND t.intent_active AND t.intent_until>clock_timestamp();
 SELECT count(*),coalesce(sum(t.size),0)INTO liveparts,livebytes FROM mem.upload_tickets t WHERE t.operation_id=o.id AND t.expires_at>clock_timestamp()AND NOT t.provider_terminal AND t.capability_state IN('issued','legacy_possibly_issued');
 SELECT count(*)INTO clientparts FROM mem.upload_ticket_clients x JOIN mem.upload_tickets t ON t.operation_id=x.operation_id AND t.part_number=x.part_number AND t.admission_generation=x.grant_generation AND t.intent_epoch=x.intent_epoch WHERE x.client_id=caller AND t.intent_active AND t.intent_until>clock_timestamp();
 RETURN jsonb_build_object('operation_id',o.id,'state',s.state,'mode',s.mode,'staging_key',o.staging_key,'size',o.expected_size,'sha256',o.expected_hash,'part_size',s.part_size,'upload_id',s.upload_id,'lease_token',s.lease_token,'lease_until',s.lease_until,'receipt',s.provider_receipt,'admission',jsonb_build_object('operation_active_parts',workparts,'client_active_parts',clientparts,'operation_active_declared_bytes',workbytes,'unexpired_possible_url_parts',liveparts,'unexpired_url_declared_bytes',livebytes,'operation_limit',policy.operation_active_parts,'client_limit',policy.client_active_parts,'wire_concurrency_absolute',false,'actual_wire_bytes',NULL,'invoice_bytes',NULL,'observed_parts_do_not_revoke_urls',true));
END $$;
REVOKE ALL ON FUNCTION mem.upload_ticket_result(mem.operations,mem.upload_sessions,uuid)FROM PUBLIC;
CREATE OR REPLACE FUNCTION mem.upload_control(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb:=payload::jsonb;c jsonb;o mem.operations;s mem.upload_sessions;command text:=b->>'command';n integer;partsize bigint;countparts bigint; policy mem.signed_upload_policy; ticket mem.upload_tickets; caller uuid; stamp timestamptz; deadline timestamptz; activeop bigint; activeclient bigint; capop bigint; capclient bigint; needwork boolean; newclient boolean; newcapclient boolean; waitepoch timestamptz; BEGIN
IF payload IS NULL OR d IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;c:=mem.guard(h,'mem.upload',d);IF (b->>'project_id')::uuid IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
caller:=(c->>'client_id')::uuid;IF command IN('ticket','ticket_issued','parts_seen','put_seen','finish')THEN PERFORM pg_advisory_xact_lock(hashtextextended('signed_upload_client:'||caller::text,0));END IF;
SELECT * INTO o FROM mem.operations WHERE id=(b->>'operation_id')::uuid AND actor_id=(c->>'actor_id')::uuid AND project_id=(c->>'project_id')::uuid FOR UPDATE;IF NOT FOUND OR (o.state NOT IN ('prepared','uploading') AND command NOT IN ('list','resume','abort')) THEN RAISE EXCEPTION 'upload_state_conflict' USING ERRCODE='40001';END IF;
SELECT * INTO s FROM mem.upload_sessions WHERE operation_id=o.id FOR UPDATE;
IF command='begin' THEN
IF s.operation_id IS NOT NULL THEN IF s.mode<>b->>'mode' OR (s.mode='multipart' AND s.part_size IS DISTINCT FROM (b->>'part_size')::bigint) THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;IF s.state='starting' THEN IF s.lease_until>clock_timestamp() THEN RAISE EXCEPTION 'upload_lease_busy' USING ERRCODE='55P03';END IF;PERFORM authz.assert_effect(h); UPDATE mem.upload_sessions SET lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '1 minute' WHERE operation_id=o.id RETURNING * INTO s;END IF;
ELSE IF b->>'mode'='multipart' THEN partsize:=(b->>'part_size')::bigint;IF partsize IS NULL OR partsize<5242880 OR partsize>5368709120 OR o.expected_size<=0 OR ceil(o.expected_size::numeric/partsize)>10000 THEN RAISE EXCEPTION 'invalid_part_size';END IF;END IF;PERFORM authz.assert_effect(h); INSERT INTO mem.upload_sessions(operation_id,mode,part_size) VALUES(o.id,b->>'mode',partsize) RETURNING * INTO s;PERFORM authz.assert_effect(h); UPDATE mem.operations SET state='uploading' WHERE id=o.id;END IF;
ELSIF command='bind' THEN IF s.state<>'starting' OR s.lease_token IS DISTINCT FROM (b->>'lease_token')::uuid OR s.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'upload_lease_conflict' USING ERRCODE='40001';END IF;PERFORM authz.assert_effect(h); UPDATE mem.upload_sessions SET upload_id=b->>'upload_id',state='open',lease_until=clock_timestamp()+interval '1 hour' WHERE operation_id=o.id RETURNING * INTO s;
ELSIF command='ticket' THEN
IF s.operation_id IS NULL OR s.state IS DISTINCT FROM 'open' OR s.lease_until<=clock_timestamp()THEN RAISE EXCEPTION 'upload_lease_conflict' USING ERRCODE='40001';END IF;
n:=COALESCE((b->>'part_number')::integer,0);partsize:=(b->>'size')::bigint;
IF s.mode='put'THEN IF n<>0 OR partsize IS NULL OR partsize<>o.expected_size OR partsize>5368709120 THEN RAISE EXCEPTION 'invalid_upload_size';END IF;
ELSE countparts:=ceil(o.expected_size::numeric/s.part_size);IF n<1 OR n>countparts OR partsize IS NULL OR partsize<>(CASE WHEN n=countparts THEN o.expected_size-(n-1)*s.part_size ELSE s.part_size END)THEN RAISE EXCEPTION 'invalid_part_size';END IF;END IF;
SELECT * INTO policy FROM mem.signed_upload_policy WHERE id FOR SHARE;
SELECT * INTO ticket FROM mem.upload_tickets t WHERE t.operation_id=o.id AND t.part_number=n FOR UPDATE;
deadline:=least(clock_timestamp()+make_interval(secs=>policy.ticket_ttl_seconds),s.lease_until,authz.upload_signature_deadline(h));
IF deadline<=clock_timestamp()+interval '1 second'THEN RETURN mem.upload_ticket_result(o,s,caller)||jsonb_build_object('state','ticket_wait','reason','current_credential_deadline','retryable',true,'next_step','refresh_current_credential_then_resume_same_part');END IF;
needwork:=ticket.operation_id IS NULL OR NOT ticket.intent_active OR ticket.intent_until<=clock_timestamp();
newclient:=ticket.operation_id IS NULL OR ticket.expires_at<=clock_timestamp()OR needwork OR NOT EXISTS(SELECT FROM mem.upload_ticket_clients x WHERE x.operation_id=o.id AND x.part_number=n AND x.grant_generation=ticket.admission_generation AND x.intent_epoch=ticket.intent_epoch AND x.client_id=caller);
SELECT count(*)INTO activeop FROM mem.upload_tickets t WHERE t.operation_id=o.id AND t.intent_active AND t.intent_until>clock_timestamp();
SELECT count(*)INTO activeclient FROM mem.upload_ticket_clients x JOIN mem.upload_tickets t ON t.operation_id=x.operation_id AND t.part_number=x.part_number AND t.admission_generation=x.grant_generation AND t.intent_epoch=x.intent_epoch WHERE x.client_id=caller AND t.intent_active AND t.intent_until>clock_timestamp();
newcapclient:=ticket.operation_id IS NULL OR ticket.expires_at<=clock_timestamp()OR NOT EXISTS(SELECT FROM mem.upload_ticket_clients x WHERE x.operation_id=o.id AND x.part_number=n AND x.grant_generation=ticket.admission_generation AND x.client_id=caller);
SELECT count(*)INTO capop FROM mem.upload_tickets t WHERE t.operation_id=o.id AND t.expires_at>clock_timestamp()AND NOT t.provider_terminal;
SELECT count(*)INTO capclient FROM(SELECT DISTINCT x.operation_id,x.part_number FROM mem.upload_ticket_clients x JOIN mem.upload_tickets t ON t.operation_id=x.operation_id AND t.part_number=x.part_number AND t.admission_generation=x.grant_generation WHERE x.client_id=caller AND t.expires_at>clock_timestamp()AND NOT t.provider_terminal)u;
IF(needwork AND activeop>=policy.operation_active_parts)OR(newclient AND activeclient>=policy.client_active_parts)OR((ticket.operation_id IS NULL OR ticket.expires_at<=clock_timestamp())AND policy.operation_live_capabilities IS NOT NULL AND capop>=policy.operation_live_capabilities)OR(newcapclient AND policy.client_live_capabilities IS NOT NULL AND capclient>=policy.client_live_capabilities)THEN
 SELECT min(t.intent_until)INTO waitepoch FROM mem.upload_tickets t WHERE t.intent_active AND t.intent_until>clock_timestamp()AND(t.operation_id=o.id OR EXISTS(SELECT FROM mem.upload_ticket_clients x WHERE x.operation_id=t.operation_id AND x.part_number=t.part_number AND x.grant_generation=t.admission_generation AND x.intent_epoch=t.intent_epoch AND x.client_id=caller));
 IF policy.operation_live_capabilities IS NOT NULL AND capop>=policy.operation_live_capabilities OR policy.client_live_capabilities IS NOT NULL AND capclient>=policy.client_live_capabilities THEN SELECT min(t.expires_at)INTO waitepoch FROM mem.upload_tickets t WHERE t.expires_at>clock_timestamp()AND NOT t.provider_terminal AND(t.operation_id=o.id OR EXISTS(SELECT FROM mem.upload_ticket_clients x WHERE x.operation_id=t.operation_id AND x.part_number=t.part_number AND x.grant_generation=t.admission_generation AND x.client_id=caller));END IF;
RETURN mem.upload_ticket_result(o,s,caller)||jsonb_build_object('state','ticket_wait','reason',CASE WHEN needwork AND activeop>=policy.operation_active_parts THEN 'operation_active_parts'WHEN newclient AND activeclient>=policy.client_active_parts THEN 'client_active_parts'ELSE'optional_live_capability_policy'END,'retryable',true,'retry_after_ms',greatest(1,coalesce(ceil(extract(epoch FROM(waitepoch-clock_timestamp()))*1000),1000)),'next_step','observe_existing_provider_parts_then_retry_same_part');END IF;
PERFORM authz.assert_effect(h);
IF ticket.operation_id IS NULL OR ticket.expires_at<=clock_timestamp()THEN
 INSERT INTO mem.upload_tickets(operation_id,part_number,size,expires_at,actor_id,admission_generation,intent_epoch,intent_active,intent_until,capability_state,provider_terminal)
 VALUES(o.id,n,partsize,deadline,o.actor_id,gen_random_uuid(),gen_random_uuid(),true,least(deadline,clock_timestamp()+interval '30 seconds'),'reserved',false)
 ON CONFLICT(operation_id,part_number)DO UPDATE SET size=excluded.size,expires_at=excluded.expires_at,actor_id=excluded.actor_id,admission_generation=excluded.admission_generation,intent_epoch=excluded.intent_epoch,intent_active=true,intent_until=excluded.intent_until,capability_state='reserved',provider_terminal=false,observed_at=NULL,provider_part_etag=NULL,signature_issued_at=NULL
 RETURNING * INTO ticket;
ELSIF needwork THEN UPDATE mem.upload_tickets SET intent_epoch=gen_random_uuid(),intent_active=true,intent_until=least(expires_at,deadline,clock_timestamp()+interval '30 seconds')WHERE operation_id=o.id AND part_number=n RETURNING * INTO ticket;
ELSE UPDATE mem.upload_tickets SET intent_until=greatest(intent_until,least(expires_at,deadline,clock_timestamp()+interval '30 seconds'))WHERE operation_id=o.id AND part_number=n RETURNING * INTO ticket;END IF;
INSERT INTO mem.upload_ticket_clients(operation_id,part_number,grant_generation,intent_epoch,client_id)VALUES(o.id,n,ticket.admission_generation,ticket.intent_epoch,caller)ON CONFLICT DO NOTHING;
PERFORM authz.assert_effect(h);UPDATE mem.upload_sessions SET lease_until=clock_timestamp()+interval '1 hour'WHERE operation_id=o.id RETURNING * INTO s;
RETURN mem.upload_ticket_result(o,s,caller)||jsonb_build_object('ticket_generation',ticket.admission_generation,'intent_epoch',ticket.intent_epoch,'ticket_expires_at',least(ticket.expires_at,deadline),'reissued_same_part',ticket.signature_issued_at IS NOT NULL,'ticket_semantics','signed_capability_not_uploaded;intent_not_absolute_wire_concurrency');
ELSIF command='ticket_issued'THEN
n:=COALESCE((b->>'part_number')::integer,0);SELECT * INTO ticket FROM mem.upload_tickets t WHERE t.operation_id=o.id AND t.part_number=n FOR UPDATE;
IF s.state IS DISTINCT FROM'open'OR ticket.operation_id IS NULL OR ticket.admission_generation IS DISTINCT FROM(b->>'ticket_generation')::uuid OR ticket.intent_epoch IS DISTINCT FROM(b->>'intent_epoch')::uuid OR NOT ticket.intent_active OR ticket.intent_until<=clock_timestamp()OR(b->>'signed_expires_at')::timestamptz>least(ticket.expires_at,authz.upload_signature_deadline(h))OR(b->>'signed_expires_at')::timestamptz<=clock_timestamp()THEN RAISE EXCEPTION 'upload_ticket_changed_retry' USING ERRCODE='40001';END IF;
PERFORM authz.assert_effect(h);UPDATE mem.upload_tickets SET expires_at=CASE WHEN signature_issued_at IS NULL AND capability_state='reserved'THEN least(expires_at,(b->>'signed_expires_at')::timestamptz)ELSE expires_at END,signature_issued_at=coalesce(signature_issued_at,clock_timestamp()),signature_requests=signature_requests+1,capability_state='issued',intent_until=CASE WHEN signature_issued_at IS NULL AND capability_state='reserved'THEN least(expires_at,(b->>'signed_expires_at')::timestamptz)ELSE expires_at END WHERE operation_id=o.id AND part_number=n;
UPDATE mem.upload_ticket_clients SET signature_issued_at=coalesce(signature_issued_at,clock_timestamp())WHERE operation_id=o.id AND part_number=n AND grant_generation=ticket.admission_generation AND intent_epoch=ticket.intent_epoch AND client_id=caller;
ELSIF command='parts_seen' THEN
IF s.mode IS DISTINCT FROM'multipart'OR s.state IS DISTINCT FROM'open'OR jsonb_typeof(b->'parts')IS DISTINCT FROM'array'THEN RAISE EXCEPTION 'upload_state_conflict' USING ERRCODE='40001';END IF;
IF EXISTS(SELECT FROM jsonb_array_elements(b->'parts')p WHERE(p->>'part_number')::integer<1 OR(p->>'part_number')::integer>ceil(o.expected_size::numeric/s.part_size)OR nullif(p->>'etag','')IS NULL OR(p->>'size')::bigint IS DISTINCT FROM CASE WHEN(p->>'part_number')::integer=ceil(o.expected_size::numeric/s.part_size)THEN o.expected_size-((p->>'part_number')::bigint-1)*s.part_size ELSE s.part_size END)THEN RAISE EXCEPTION 'provider_part_observation_mismatch';END IF;
PERFORM authz.assert_effect(h);UPDATE mem.upload_tickets t SET intent_active=false,observed_at=clock_timestamp(),provider_part_etag=p->>'etag'FROM jsonb_array_elements(b->'parts')p WHERE t.operation_id=o.id AND t.part_number=(p->>'part_number')::integer;
ELSIF command='put_seen'THEN
IF s.mode IS DISTINCT FROM'put'OR s.state IS DISTINCT FROM'open'OR(b->'receipt'->>'size')::bigint IS DISTINCT FROM o.expected_size THEN RAISE EXCEPTION 'provider_put_observation_mismatch';END IF;
PERFORM authz.assert_effect(h);UPDATE mem.upload_tickets SET intent_active=false,observed_at=clock_timestamp()WHERE operation_id=o.id;
ELSIF command IN ('list','resume') THEN IF s.state NOT IN ('open','completing','completed','aborted') THEN RAISE EXCEPTION 'upload_state_conflict' USING ERRCODE='40001';END IF;IF command='resume' AND s.state='open' THEN PERFORM authz.assert_effect(h); UPDATE mem.upload_sessions SET lease_until=clock_timestamp()+interval '1 hour' WHERE operation_id=o.id RETURNING * INTO s;END IF;
ELSIF command IN ('complete','abort') THEN IF s.state IN ('completed','aborted') THEN RETURN jsonb_build_object('operation_id',o.id,'state',s.state,'receipt',s.provider_receipt);END IF;IF s.state IN ('completing','aborting') AND s.lease_until>clock_timestamp() THEN RAISE EXCEPTION 'upload_lease_busy' USING ERRCODE='55P03';END IF;PERFORM authz.assert_effect(h); UPDATE mem.upload_sessions SET state=CASE WHEN command='complete' THEN 'completing' ELSE 'aborting' END,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '1 minute' WHERE operation_id=o.id RETURNING * INTO s;
ELSIF command='finish' THEN IF s.lease_token IS DISTINCT FROM (b->>'lease_token')::uuid OR s.lease_until<=clock_timestamp() OR s.state NOT IN ('completing','aborting') THEN RAISE EXCEPTION 'upload_lease_conflict' USING ERRCODE='40001';END IF;PERFORM authz.assert_effect(h); UPDATE mem.upload_sessions SET state=CASE WHEN state='completing' OR b->'receipt'->>'state'='already_completed' THEN 'completed' ELSE 'aborted' END,provider_receipt=b->'receipt' WHERE operation_id=o.id RETURNING * INTO s;IF s.state='aborted' THEN PERFORM authz.assert_effect(h); UPDATE mem.operations SET state='cancelled' WHERE id=o.id;END IF;UPDATE mem.upload_tickets SET intent_active=false,provider_terminal=(s.mode='multipart'),capability_state=CASE WHEN s.mode='multipart'THEN'terminal'ELSE capability_state END WHERE operation_id=o.id;
ELSE RAISE EXCEPTION 'invalid_upload_command';END IF;
RETURN mem.upload_ticket_result(o,s,caller);END $$;
REVOKE ALL ON FUNCTION mem.upload_control(uuid,text,text)FROM PUBLIC;GRANT EXECUTE ON FUNCTION mem.upload_control(uuid,text,text)TO hub2_mem;
RESET ROLE;
-- New tables are explicit infrastructure facts, not byte dependencies. Keep the
-- original scanner's unknown-catalog safeguards rather than excluding schemas.
SET ROLE hub2_mem_owner;
DO $$DECLARE name text;BEGIN
 FOREACH name IN ARRAY ARRAY['signed_upload_policy','upload_ticket_clients']LOOP
  EXECUTE format('CREATE TRIGGER gc_reference_fence BEFORE INSERT OR UPDATE OR DELETE ON mem.%I FOR EACH ROW EXECUTE FUNCTION mem.gc_reference_fence()',name);
  INSERT INTO mem.gc_reference_contracts(schema_name,table_name,kind,shape_hash)VALUES('mem',name,'ledger',mem.gc_relation_shape(('mem.'||name)::regclass));
 END LOOP;
 UPDATE mem.gc_reference_contracts SET shape_hash=mem.gc_relation_shape('mem.upload_tickets'::regclass)WHERE schema_name='mem'AND table_name='upload_tickets';
END $$;
RESET ROLE;
