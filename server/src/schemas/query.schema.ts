import { z } from 'zod';

export const QueryRequestSchema = z.object({
  question: z
    .string({ required_error: 'Question is required' })
    .trim()
    .min(1, 'Question cannot be empty or whitespace only')
    .max(1000, 'Question must not exceed 1000 characters'),
  topK: z
    .number()
    .int('topK must be an integer')
    .min(1, 'topK must be at least 1')
    .max(20, 'topK cannot exceed 20')
    .optional()
    .default(5),
  /**
   * Optional item ID to scope retrieval to a single knowledge item.
   * When provided, Qdrant search and relational fallback are both filtered
   * to chunks belonging to that item only.
   */
  item_id: z
    .string()
    .uuid('item_id must be a valid UUID')
    .optional(),
});

export type QueryRequestInput = z.infer<typeof QueryRequestSchema>;
