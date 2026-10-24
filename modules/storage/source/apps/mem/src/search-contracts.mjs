import {z} from 'zod';
export const searchLimits={query_characters:200,candidate_limit:100,properties_bytes:16384};
  const properties=z.record(z.string(),z.unknown()).refine(v=>Buffer.byteLength(JSON.stringify(v))<=searchLimits.properties_bytes,'properties_budget');
  const rawQuery=z.string(),rawName=z.string();
  const shared={project_id:z.uuid(),semantic:z.boolean().optional(),query:rawQuery.trim().max(searchLimits.query_characters).optional(),properties:properties.optional(),limit:z.number().int().min(1).max(500).optional()};
  const ordinary=z.object(shared).strict();
  const advanced=z.object({...shared,name:rawName.trim().min(1).max(searchLimits.query_characters).optional(),number:z.string().regex(/^(?:F-[0-9]+(?:-[0-9]+)?|#?[0-9]+)$/).optional(),candidate_limit:z.number().int().min(2).max(searchLimits.candidate_limit).optional(),version_created_after:z.iso.datetime({offset:true}).optional(),version_created_before:z.iso.datetime({offset:true}).optional()}).strict().refine(v=>v.query||v.name||v.number||Object.keys(v.properties??{}).length>0,'search_condition_required').refine(v=>!(v.version_created_after&&v.version_created_before)||Date.parse(v.version_created_after)<=Date.parse(v.version_created_before));

export const searchSchemas={ordinary,advanced};
// Raw transport strings must reach domain trim before normalized-length checks.
// These projections never normalize caller input or replace the domain refinements.
export const searchInputContracts=[
 ['/v2/materials/search',z.object({...ordinary.shape,query:rawQuery.optional()}).strict()],
 ['/v2/materials/retrieve',z.object({...advanced.shape,query:rawQuery.optional(),name:rawName.optional()}).strict()]
];
