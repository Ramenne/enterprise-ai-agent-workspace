-- Unknown cursors are recovery states, never new permissions. Existing final authorization remains.
CREATE OR REPLACE FUNCTION evidence.project_changes(h uuid, d text, payload text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'evidence'
AS $function$ DECLARE b jsonb;c jsonb;action text;floor bigint;high bigint;cursor bigint;limit_n integer;events jsonb;next_cursor uuid;BEGIN
 IF h IS NULL OR d IS NULL OR payload IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;
 action:=CASE authz.runtime_role() WHEN 'hub2_mem' THEN 'mem.read' WHEN 'hub2_v8' THEN 'v8.project.read' ELSE NULL END;
 IF action IS NULL THEN RAISE EXCEPTION 'domain_identity_required' USING ERRCODE='42501';END IF;c:=authz.consume_handle(h,action,d);
 IF (b->>'project_id')::uuid IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 IF b-'project_id'-'cursor'-'limit'<>'{}'::jsonb OR COALESCE(c->'resource'->'resolved_resource',c->'resource')->>'material_id' IS NOT NULL OR COALESCE(c->'resource'->'resolved_resource',c->'resource')->>'collection_id' IS NOT NULL OR COALESCE(c->'resource'->'resolved_resource',c->'resource')->>'area_id' IS NOT NULL OR COALESCE(c->'resource'->'resolved_resource',c->'resource')->>'version_id' IS NOT NULL THEN RAISE EXCEPTION 'project_scope_required' USING ERRCODE='42501';END IF;
 SELECT seq INTO cursor FROM evidence.feed_cursors WHERE id=(b->>'cursor')::uuid AND actor_id=(c->>'actor_id')::uuid AND client_id=(c->>'client_id')::uuid AND project_id=(c->>'project_id')::uuid;limit_n:=coalesce((b->>'limit')::integer,100);
 IF limit_n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_limit' USING ERRCODE='22023';END IF;
 IF cursor IS NULL OR cursor<0 THEN PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','resync_required','reason','cursor_unavailable_for_current_binding','next_step','hub.changes.snapshot','retained_state','preserve_previous_projection');END IF;
 SELECT retained_after INTO floor FROM evidence.stream_state WHERE id;SELECT value INTO high FROM evidence.delivery_counter WHERE id;
 PERFORM authz.assert_effect(h);
 IF cursor<floor THEN RETURN jsonb_build_object('state','resync_required','retained_state','preserve_previous_projection');END IF;
 IF cursor>high THEN RETURN jsonb_build_object('state','resync_required','reason','cursor_outside_current_stream','next_step','hub.changes.snapshot','retained_state','preserve_previous_projection');END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.delivery_seq),'[]') INTO events FROM (SELECT dd.seq delivery_seq,o.id event_id,o.domain,o.aggregate_id,o.aggregate_revision,o.event_type,o.event_group,o.group_index,o.group_size FROM evidence.delivery dd JOIN evidence.outbox o ON o.id=dd.event_id WHERE dd.seq>cursor AND o.project_id=(c->>'project_id')::uuid AND (o.event_type='material.scope_removed' OR o.domain<>'mem' OR NOT EXISTS(SELECT FROM mem.materials mm WHERE mm.id=o.aggregate_id) OR EXISTS(SELECT FROM mem.materials mm WHERE mm.id=o.aggregate_id AND (mm.current_version_id IS NULL OR mem.version_visible((c->>'actor_id')::uuid,mm.current_version_id)))) ORDER BY dd.seq LIMIT limit_n) x;
 PERFORM authz.assert_effect(h);
 INSERT INTO evidence.feed_cursors(actor_id,client_id,project_id,seq) VALUES((c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'project_id')::uuid,CASE WHEN jsonb_array_length(events)=limit_n THEN (events->-1->>'delivery_seq')::bigint ELSE high END) RETURNING id INTO next_cursor;
 SELECT coalesce(jsonb_agg(value-'delivery_seq'),'[]') INTO events FROM jsonb_array_elements(events);
 RETURN jsonb_build_object('state','current','events',events,'cursor',next_cursor,'coverage','current_authorized_project_metadata_only');
END $function$

