-- Keep existing claim visibility; expose only currently authorized feedback.
CREATE OR REPLACE FUNCTION v8.experience_read(h uuid, d text, p text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'v8'
AS $function$ DECLARE b jsonb;c jsonb;r jsonb; BEGIN IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=p::jsonb;c:=v8.guard(h,'v8.experience.read',d,b);SELECT COALESCE(jsonb_agg(jsonb_build_object('experience_id',ex.id,'work_item_id',ex.work_item_id,'fixed_ref',jsonb_build_object('material_id',ex.material_id,'version_id',ex.version_id,'sha256',ex.sha256),'conditions',ex.conditions,'evidence',ex.evidence,'state',CASE WHEN mem.version_stale(ex.version_id) THEN 'stale' ELSE ex.state END,'revision',ex.revision,'supersedes',ex.supersedes,'feedback',COALESCE((
 SELECT jsonb_agg(jsonb_build_object('feedback_id',f.id,'work_item_id',f.work_item_id,'actor_id',f.actor_id,'kind',f.kind,'created_at',f.created_at,'body_ref',jsonb_build_object('material_id',f.material_id,'version_id',f.version_id,'sha256',f.sha256),'evidence',f.evidence) ORDER BY f.created_at,f.id)
 FROM v8.experience_feedback f JOIN v8.work_items fw ON fw.id=f.work_item_id
 WHERE f.experience_id=ex.id
  AND authz.can_read((c->>'actor_id')::uuid,fw.project_id)
  AND mem.version_visible((c->>'actor_id')::uuid,f.version_id)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f.evidence) fr WHERE NOT mem.version_visible((c->>'actor_id')::uuid,(fr->>'version_id')::uuid))
),'[]'::jsonb),'feedback_coverage','current_authorized_feedback_only;not_global_absence')),'[]') INTO r FROM v8.experiences ex JOIN v8.work_items w ON w.id=ex.work_item_id WHERE w.project_id=(c->>'project_id')::uuid AND (b->>'experience_id' IS NULL OR ex.id=(b->>'experience_id')::uuid) AND mem.version_visible((c->>'actor_id')::uuid,ex.version_id) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ex.evidence) rf WHERE NOT mem.version_visible((c->>'actor_id')::uuid,(rf->>'version_id')::uuid));PERFORM mem.bind_request_sources(h,jsonb_build_object('fixed_refs',r),(c->>'actor_id')::uuid,'v8.experience.read');PERFORM authz.assert_effect(h);PERFORM authz.assert_effect(h);RETURN jsonb_build_object('state','read','items',r,'coverage','current_authorized_claims'); END $function$;
