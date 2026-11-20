import { z } from 'zod';

export const IngestNoteSchema = z.object({
  source_type: z.literal('note'),
  title: z
    .string()
    .trim()
    .max(200, { message: 'Title must not exceed 200 characters' })
    .optional(),
  content: z
    .string()
    .trim()
    .min(1, { message: 'Note content cannot be empty' })
    .max(100_000, { message: 'Note content exceeds maximum limit of 100,000 characters' }),
});

export const IngestUrlSchema = z.object({
  source_type: z.literal('url'),
  url: z
    .string()
    .trim()
    .url({ message: 'Must be a valid URL' })
    .refine((val) => val.startsWith('http://') || val.startsWith('https://'), {
      message: 'Only HTTP and HTTPS protocols are supported',
    }),
});

export const IngestRequestSchema = z.discriminatedUnion('source_type', [
  IngestNoteSchema,
  IngestUrlSchema,
]);

export type IngestNoteInput = z.infer<typeof IngestNoteSchema>;
export type IngestUrlInput = z.infer<typeof IngestUrlSchema>;
export type IngestRequestInput = z.infer<typeof IngestRequestSchema>;
