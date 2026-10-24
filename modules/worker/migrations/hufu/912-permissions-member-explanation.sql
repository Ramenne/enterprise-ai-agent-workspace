-- Change explanatory output only; preserve the CURRENT deployed function body,
-- authority checks, signature, search_path, privileges and owner.
DO $permission_note$
DECLARE definition text;
 old_note constant text := 'member_qualification_and_software_ceiling_are_both_required;target_operation_rechecks';
 new_note constant text := 'ordinary_member_qualification_is_authority;legacy_software_metadata_is_informational;explicit_restricted_controller_service_and_special_resource_fences_still_apply;target_operation_rechecks';
BEGIN
 definition:=pg_get_functiondef('authz.authorization_permissions(text,jsonb)'::regprocedure);
 IF position(new_note in definition)>0 THEN RETURN; END IF;
 IF position(old_note in definition)=0 THEN RAISE EXCEPTION 'current_permission_note_changed_read_current_source' USING ERRCODE='40001'; END IF;
 EXECUTE replace(definition,old_note,new_note);
END $permission_note$;
