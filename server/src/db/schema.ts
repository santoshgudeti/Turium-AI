import { Client } from '@libsql/client';
import { DatabaseSync } from 'node:sqlite';
import { logger } from '../utils/logger';

export const SCHEMA_SQL = `
-- Items table: Stores raw notes and scraped URLs
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK(source_type IN ('note', 'url')),
  title TEXT,
  source_url TEXT,
  raw_content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Chunks table: Stores text chunks extracted from items
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding TEXT,
  embedding_model TEXT,
  embedding_dimensions INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  UNIQUE(item_id, chunk_index)
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_chunks_item_id ON chunks(item_id);
CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);

-- Pending vector cleanups table for durable, restart-resilient Qdrant cleanup
CREATE TABLE IF NOT EXISTS pending_vector_cleanups (
  point_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_vector_cleanups_item_id ON pending_vector_cleanups(item_id);
`;

export const initSchema = async (clientOrDb: Client | DatabaseSync): Promise<void> => {
  logger.info('Initializing database schema...');
  if ('executeMultiple' in clientOrDb) {
    // libSQL / Turso Client
    try {
      await clientOrDb.execute('PRAGMA foreign_keys = ON;');
    } catch {
      // Remote providers may enforce foreign keys automatically
    }
    await clientOrDb.executeMultiple(SCHEMA_SQL);
  } else {
    // node:sqlite DatabaseSync
    clientOrDb.exec('PRAGMA foreign_keys = ON;');
    clientOrDb.exec('PRAGMA journal_mode = WAL;');
    clientOrDb.exec('PRAGMA busy_timeout = 5000;');
    clientOrDb.exec(SCHEMA_SQL);
  }
  logger.info('Database schema initialized successfully.');
};
