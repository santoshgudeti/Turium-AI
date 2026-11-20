import { z } from 'zod';

export const ItemIdParamSchema = z.object({
  id: z
    .string({ required_error: 'Item ID is required' })
    .uuid('Invalid item ID format. Expected a valid UUID.'),
});

export type ItemIdParamInput = z.infer<typeof ItemIdParamSchema>;
