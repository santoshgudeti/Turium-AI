import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../utils/logger';

// Deterministically locate the repository root .env file relative to this module
// From server/src/config or server/dist/config, repo root is 3 levels up
const rootEnvPath = path.resolve(__dirname, '../../../.env');

if (fs.existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath, override: false });
} else {
  // Fallback to process.cwd() .env only if root .env is not present
  dotenv.config({ override: false });
}

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_PATH: z.string().default('./data/knowledge_inbox.db'),

  // Turso Cloud / libSQL Configuration
  TURSO_DATABASE_URL: z.string().optional(),
  TURSO_AUTH_TOKEN: z.string().optional(),

  // Qdrant Cloud Vector Database Configuration
  QDRANT_URL: z.string().optional(),
  QDRANT_API_KEY: z.string().optional(),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_CHAT_MODEL: z.string().default('gemini-3.5-flash-lite'),
  GEMINI_EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
  GEMINI_EMBEDDING_DIMENSIONS: z.coerce.number().default(1536),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  logger.error(
    { errors: parsed.error.format() },
    'Configuration validation failed. Check your environment variables.'
  );
  process.exit(1);
}

export const config = parsed.data;
