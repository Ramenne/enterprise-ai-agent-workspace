import {z} from 'zod';
// Platform owner: Hufu. Consumer copies are published with origin metadata.
export const changeSchemas={
 snapshot:z.object({project_id:z.uuid()}).strict(),
 poll:z.object({project_id:z.uuid(),cursor:z.uuid(),limit:z.number().int().min(1).max(500).default(100)}).strict()
};

// The SDK presentation preserves omitted values; execution alone supplies defaults.
export const changeInputSchemas={snapshot:changeSchemas.snapshot,poll:changeSchemas.poll.extend({limit:changeSchemas.poll.shape.limit.removeDefault().optional()})};
