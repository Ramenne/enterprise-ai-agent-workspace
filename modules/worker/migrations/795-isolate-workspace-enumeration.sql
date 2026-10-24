BEGIN;
SET ROLE hub2_mem_owner;
DO $patch$
DECLARE current_def text;display_def text;basic_def text;extra text:=' SELECT coalesce(jsonb_agg(mem.material_display_info(h,c,value)ORDER BY ordinality),''[]'')INTO items FROM jsonb_array_elements(items)WITH ORDINALITY;';
BEGIN
 current_def:=pg_get_functiondef('mem.enumeration_page(uuid,text,text)'::regprocedure);
 IF position(extra IN current_def)=0 THEN RAISE EXCEPTION 'display_enrichment_location_missing';END IF;
 display_def:=replace(current_def,'FUNCTION mem.enumeration_page(', 'FUNCTION mem.enumeration_page_display(');EXECUTE display_def;
 basic_def:=replace(current_def,extra,' SELECT coalesce(jsonb_agg(value||jsonb_build_object(''file_no'',m.file_no::text,''importance_level'',m.importance_level)ORDER BY ordinality),''[]'')INTO items FROM jsonb_array_elements(items)WITH ORDINALITY JOIN mem.materials m ON m.id=(value->>''material_id'')::uuid;');EXECUTE basic_def;
END $patch$;
REVOKE ALL ON FUNCTION mem.enumeration_page_display(uuid,text,text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.enumeration_page_display(uuid,text,text)TO hub2_mem;
RESET ROLE;
COMMIT;
