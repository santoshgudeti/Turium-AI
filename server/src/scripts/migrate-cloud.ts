import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config/env';
import { createDatabaseClient, isTursoConfigured, resolveDatabasePath } from '../db/connection';
import { QdrantService, QDRANT_COLLECTION_NAME, QdrantPointInput } from '../services/qdrant.service';
import { GeminiEmbeddingProvider } from '../services/embedding.service';
import { performOnlineBackup } from './reindex';
import { logger } from '../utils/logger';
import { Item, SourceType, ItemStatus } from '../types/database.types';

export interface SqliteItemRow {
  id: string;
  source_type: SourceType;
  title: string | null;
  source_url: string | null;
  raw_content: string;
  status: ItemStatus;
  created_at: string;
  updated_at: string;
}

export interface SqliteChunkRow {
  id: string;
  item_id: string;
  chunk_index: number;
  content: string;
  embedding: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  created_at: string;
}

export interface MigrationOptions {
  sqlitePath?: string;
  dryRun?: boolean;
  execute?: boolean;
}

export interface MigrationPlan {
  sourceItemsCount: number;
  sourceChunksCount: number;
  itemsGrouped: { source_type: string; status: string; count: number }[];
  validExistingEmbeddingsCount: number;
  missingEmbeddingsCount: number;
  invalidEmbeddingsCount: number;
  tursoCurrentItemsCount: number;
  tursoCurrentChunksCount: number;
  qdrantCurrentPointsCount: number;
  itemsToInsert: SqliteItemRow[];
  itemsToSkip: string[];
  chunksToInsert: SqliteChunkRow[];
  chunksToSkip: string[];
  chunksNeedingEmbedding: SqliteChunkRow[];
  qdrantPointsToUpsert: { id: string; item_id: string; source_type: SourceType }[];
  backupPath: string | null;
  backupVerified: boolean;
  dryRun: boolean;
}

/**
 * Validates whether an embedding JSON string represents a valid 1536-dimensional array of finite numbers.
 */
export function validateEmbeddingVector(
  embeddingJson: string | null,
  modelName: string | null,
  expectedDim = 1536
): { isValid: boolean; vector?: number[]; reason?: string } {
  if (!embeddingJson || embeddingJson.trim() === '') {
    return { isValid: false, reason: 'NULL_OR_EMPTY' };
  }

  try {
    const parsed = JSON.parse(embeddingJson);
    if (!Array.isArray(parsed)) {
      return { isValid: false, reason: 'NOT_AN_ARRAY' };
    }

    if (parsed.length !== expectedDim) {
      return { isValid: false, reason: `DIMENSION_MISMATCH (expected ${expectedDim}, got ${parsed.length})` };
    }

    const allFinite = parsed.every((n) => typeof n === 'number' && Number.isFinite(n));
    if (!allFinite) {
      return { isValid: false, reason: 'NON_FINITE_NUMBERS' };
    }

    if (modelName && modelName !== config.GEMINI_EMBEDDING_MODEL) {
      return { isValid: false, reason: `MODEL_MISMATCH (expected ${config.GEMINI_EMBEDDING_MODEL}, got ${modelName})` };
    }

    return { isValid: true, vector: parsed as number[] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isValid: false, reason: `JSON_PARSE_ERROR: ${msg}` };
  }
}

/**
 * Main cloud migration orchestration function.
 */
export async function runCloudMigration(options?: MigrationOptions): Promise<MigrationPlan> {
  const isExplicitDryRun = options?.dryRun ?? true;
  const isExecuteAllowed = options?.execute ?? false;
  // Defensive default: If --execute is not explicitly provided, force dry-run mode
  const dryRun = isExplicitDryRun || !isExecuteAllowed;

  const rawPath = options?.sqlitePath || config.DATABASE_PATH;
  const sqlitePath = resolveDatabasePath(rawPath);

  logger.info(
    { sqlitePath, dryRun, execute: isExecuteAllowed },
    'Starting SQLite to Turso + Qdrant migration pipeline'
  );

  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`Source SQLite database not found at path: ${sqlitePath}`);
  }

  // 1. Connect to Source SQLite in READ-ONLY mode
  const sqliteDb = new DatabaseSync(sqlitePath, { readOnly: true });

  // 2. Perform safe pre-migration backup
  let backupPath: string | null = null;
  let backupVerified = false;

  try {
    const now = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${sqlitePath}.bak-${now}`;
    // Copy file safely while source is in read-only mode
    fs.copyFileSync(sqlitePath, backupPath);

    const verifyDb = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const integrity = verifyDb.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
      if (integrity?.integrity_check === 'ok') {
        backupVerified = true;
        logger.info({ backupPath }, 'SQLite pre-migration backup verified with PRAGMA integrity_check = ok');
      } else {
        throw new Error(`Backup failed integrity check: ${integrity?.integrity_check}`);
      }
    } finally {
      verifyDb.close();
    }
  } catch (backupErr: unknown) {
    sqliteDb.close();
    throw new Error(`Failed to create or verify pre-migration backup: ${backupErr instanceof Error ? backupErr.message : String(backupErr)}`);
  }

  // 3. Inspect Source SQLite Data
  const sourceItems = sqliteDb
    .prepare('SELECT id, source_type, title, source_url, raw_content, status, created_at, updated_at FROM items ORDER BY created_at ASC')
    .all() as unknown as SqliteItemRow[];

  const sourceChunks = sqliteDb
    .prepare('SELECT id, item_id, chunk_index, content, embedding, embedding_model, embedding_dimensions, created_at FROM chunks ORDER BY item_id, chunk_index ASC')
    .all() as unknown as SqliteChunkRow[];

  const itemsGroupedRaw = sqliteDb
    .prepare('SELECT source_type, status, count(*) as count FROM items GROUP BY source_type, status')
    .all() as { source_type: string; status: string; count: number }[];

  const itemMap = new Map<string, SqliteItemRow>();
  for (const item of sourceItems) {
    itemMap.set(item.id, item);
  }

  // 4. Validate Vector Embeddings
  let validExistingEmbeddingsCount = 0;
  let missingEmbeddingsCount = 0;
  let invalidEmbeddingsCount = 0;

  const validVectorMap = new Map<string, number[]>();
  const chunksNeedingEmbedding: SqliteChunkRow[] = [];

  for (const chunk of sourceChunks) {
    const validation = validateEmbeddingVector(chunk.embedding, chunk.embedding_model, config.GEMINI_EMBEDDING_DIMENSIONS);
    if (validation.isValid && validation.vector) {
      validExistingEmbeddingsCount++;
      validVectorMap.set(chunk.id, validation.vector);
    } else if (validation.reason === 'NULL_OR_EMPTY') {
      missingEmbeddingsCount++;
      chunksNeedingEmbedding.push(chunk);
    } else {
      invalidEmbeddingsCount++;
      chunksNeedingEmbedding.push(chunk);
      logger.warn(
        { chunkId: chunk.id, reason: validation.reason, model: chunk.embedding_model },
        'Chunk has invalid embedding; flagged for fresh generation'
      );
    }
  }

  // 5. Inspect Destination Cloud Infrastructure (Turso + Qdrant)
  const tursoClient = createDatabaseClient();
  const qdrantService = new QdrantService();

  let tursoCurrentItemsCount = 0;
  let tursoCurrentChunksCount = 0;
  const existingTursoItemIds = new Set<string>();
  const existingTursoChunkIds = new Set<string>();

  try {
    const tursoItemsRes = await tursoClient.execute('SELECT id FROM items');
    tursoCurrentItemsCount = tursoItemsRes.rows.length;
    for (const row of tursoItemsRes.rows) {
      existingTursoItemIds.add(String(row.id));
    }

    const tursoChunksRes = await tursoClient.execute('SELECT id FROM chunks');
    tursoCurrentChunksCount = tursoChunksRes.rows.length;
    for (const row of tursoChunksRes.rows) {
      existingTursoChunkIds.add(String(row.id));
    }
  } catch (tursoErr: unknown) {
    sqliteDb.close();
    throw new Error(`Failed to query Turso destination state: ${tursoErr instanceof Error ? tursoErr.message : String(tursoErr)}`);
  }

  let qdrantCurrentPointsCount = 0;
  const qdrantClient = qdrantService.getClient();
  if (qdrantClient) {
    try {
      const col = await qdrantClient.getCollection(QDRANT_COLLECTION_NAME);
      qdrantCurrentPointsCount = col.points_count || 0;
    } catch (qdrantErr: unknown) {
      logger.warn({ error: String(qdrantErr) }, 'Could not retrieve Qdrant points count; collection may be empty');
    }
  }

  // 6. Calculate Plan Diffs
  const itemsToInsert: SqliteItemRow[] = [];
  const itemsToSkip: string[] = [];

  for (const item of sourceItems) {
    if (existingTursoItemIds.has(item.id)) {
      itemsToSkip.push(item.id);
    } else {
      itemsToInsert.push(item);
    }
  }

  const chunksToInsert: SqliteChunkRow[] = [];
  const chunksToSkip: string[] = [];

  for (const chunk of sourceChunks) {
    if (existingTursoChunkIds.has(chunk.id)) {
      chunksToSkip.push(chunk.id);
    } else {
      chunksToInsert.push(chunk);
    }
  }

  const qdrantPointsToUpsert: { id: string; item_id: string; source_type: SourceType }[] = [];
  for (const chunk of sourceChunks) {
    const parent = itemMap.get(chunk.item_id);
    const sourceType = parent?.source_type || 'note';
    qdrantPointsToUpsert.push({
      id: chunk.id,
      item_id: chunk.item_id,
      source_type: sourceType,
    });
  }

  const plan: MigrationPlan = {
    sourceItemsCount: sourceItems.length,
    sourceChunksCount: sourceChunks.length,
    itemsGrouped: itemsGroupedRaw,
    validExistingEmbeddingsCount,
    missingEmbeddingsCount,
    invalidEmbeddingsCount,
    tursoCurrentItemsCount,
    tursoCurrentChunksCount,
    qdrantCurrentPointsCount,
    itemsToInsert,
    itemsToSkip,
    chunksToInsert,
    chunksToSkip,
    chunksNeedingEmbedding,
    qdrantPointsToUpsert,
    backupPath,
    backupVerified,
    dryRun,
  };

  // Close read-only SQLite database connection
  sqliteDb.close();

  // If DRY RUN, return plan immediately without performing any writes
  if (dryRun) {
    logger.info(
      {
        itemsToInsert: itemsToInsert.length,
        itemsToSkip: itemsToSkip.length,
        chunksToInsert: chunksToInsert.length,
        chunksToSkip: chunksToSkip.length,
        embeddingsToReuse: validExistingEmbeddingsCount,
        embeddingsToGenerate: chunksNeedingEmbedding.length,
      },
      'Migration dry-run completed. Zero writes made to Turso or Qdrant.'
    );
    return plan;
  }

  // 7. ACTUAL MIGRATION EXECUTION (Only reached when dryRun === false)
  logger.info('Proceeding with live cloud migration...');

  // A. Insert Items to Turso
  if (itemsToInsert.length > 0) {
    logger.info({ count: itemsToInsert.length }, 'Copying items to Turso...');
    const itemStatements = itemsToInsert.map((item) => ({
      sql: `INSERT INTO items (id, source_type, title, source_url, raw_content, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING;`,
      args: [
        item.id,
        item.source_type,
        item.title,
        item.source_url,
        item.raw_content,
        item.status,
        item.created_at,
        item.updated_at,
      ],
    }));

    await tursoClient.batch(itemStatements, 'write');
    logger.info({ count: itemsToInsert.length }, 'Successfully copied items to Turso');
  }

  // B. Generate missing embeddings if needed
  if (chunksNeedingEmbedding.length > 0) {
    logger.info({ count: chunksNeedingEmbedding.length }, 'Generating missing embeddings with Google Gemini...');
    const embeddingProvider = new GeminiEmbeddingProvider();
    const textsToEmbed = chunksNeedingEmbedding.map((c) => c.content);
    const newVectors = await embeddingProvider.generateEmbeddings(textsToEmbed);

    for (let i = 0; i < chunksNeedingEmbedding.length; i++) {
      const chunk = chunksNeedingEmbedding[i];
      const vector = newVectors[i];
      validVectorMap.set(chunk.id, vector);
      chunk.embedding = JSON.stringify(vector);
      chunk.embedding_model = config.GEMINI_EMBEDDING_MODEL;
      chunk.embedding_dimensions = config.GEMINI_EMBEDDING_DIMENSIONS;
    }
    logger.info({ count: chunksNeedingEmbedding.length }, 'Successfully generated missing embeddings');
  }

  // C. Insert Chunks to Turso
  if (chunksToInsert.length > 0) {
    logger.info({ count: chunksToInsert.length }, 'Copying chunks to Turso...');
    const chunkStatements = chunksToInsert.map((chunk) => {
      const vector = validVectorMap.get(chunk.id);
      const embeddingStr = vector ? JSON.stringify(vector) : chunk.embedding;
      return {
        sql: `INSERT INTO chunks (id, item_id, chunk_index, content, embedding, embedding_model, embedding_dimensions, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                embedding = COALESCE(excluded.embedding, chunks.embedding),
                embedding_model = COALESCE(excluded.embedding_model, chunks.embedding_model),
                embedding_dimensions = COALESCE(excluded.embedding_dimensions, chunks.embedding_dimensions);`,
        args: [
          chunk.id,
          chunk.item_id,
          chunk.chunk_index,
          chunk.content,
          embeddingStr,
          chunk.embedding_model || config.GEMINI_EMBEDDING_MODEL,
          chunk.embedding_dimensions || config.GEMINI_EMBEDDING_DIMENSIONS,
          chunk.created_at,
        ],
      };
    });

    await tursoClient.batch(chunkStatements, 'write');
    logger.info({ count: chunksToInsert.length }, 'Successfully copied chunks to Turso');
  }

  // D. Upsert Vector Points into Qdrant Cloud
  const qdrantPoints: QdrantPointInput[] = [];
  for (const chunk of sourceChunks) {
    const vector = validVectorMap.get(chunk.id);
    if (!vector) {
      continue;
    }
    const parent = itemMap.get(chunk.item_id);
    qdrantPoints.push({
      id: chunk.id,
      vector,
      payload: {
        item_id: chunk.item_id,
        chunk_index: chunk.chunk_index,
        source_type: parent?.source_type || 'note',
        embedding_model: chunk.embedding_model || config.GEMINI_EMBEDDING_MODEL,
        created_at: chunk.created_at,
      },
    });
  }

  if (qdrantPoints.length > 0) {
    logger.info({ count: qdrantPoints.length }, 'Upserting vectors into Qdrant Cloud...');
    await qdrantService.upsertChunks(qdrantPoints);
    logger.info({ count: qdrantPoints.length }, 'Successfully upserted vectors into Qdrant Cloud');
  }

  return plan;
}

// CLI Entry point
async function cli() {
  const args = process.argv.slice(2);
  const isDryRunArg = args.includes('--dry-run');
  const isExecuteArg = args.includes('--execute');

  const dryRun = isDryRunArg || !isExecuteArg;

  console.log('======================================================================');
  console.log('Turium AI Knowledge Inbox — SQLite to Turso + Qdrant Cloud Migration');
  console.log('======================================================================');
  console.log(`Execution Mode:     ${dryRun ? 'DRY-RUN (Safe, No Writes)' : 'LIVE EXECUTION'}`);
  console.log(`Target Relational:  Turso Cloud (${isTursoConfigured() ? 'Configured' : 'NOT Configured'})`);
  console.log(`Target Vector DB:   Qdrant Cloud (${QDRANT_COLLECTION_NAME}, 1536 Cosine)`);
  console.log('======================================================================\n');

  try {
    const plan = await runCloudMigration({ dryRun, execute: isExecuteArg });

    console.log('--- Phase 1: Source SQLite Database Statistics ---');
    console.log(`Source Database:      ${resolveDatabasePath()}`);
    console.log(`Total Items:          ${plan.sourceItemsCount}`);
    console.log(`Total Chunks:         ${plan.sourceChunksCount}`);
    console.log('Items by Status:     ', JSON.stringify(plan.itemsGrouped));
    console.log(`Valid 1536d Vectors:  ${plan.validExistingEmbeddingsCount}`);
    console.log(`Missing Embeddings:   ${plan.missingEmbeddingsCount}`);
    console.log(`Invalid Embeddings:   ${plan.invalidEmbeddingsCount}`);

    console.log('\n--- Phase 2: Backup Verification ---');
    console.log(`Backup File:          ${plan.backupPath}`);
    console.log(`Integrity Check:      ${plan.backupVerified ? 'PASSED (PRAGMA integrity_check = ok)' : 'FAILED'}`);

    console.log('\n--- Phase 3: Destination State & Planned Diffs ---');
    console.log(`Turso Existing Items: ${plan.tursoCurrentItemsCount}`);
    console.log(`Turso Existing Chunks:${plan.tursoCurrentChunksCount}`);
    console.log(`Qdrant Points Count:  ${plan.qdrantCurrentPointsCount}`);
    console.log(`Items to Insert:      ${plan.itemsToInsert.length}`);
    console.log(`Items to Skip:        ${plan.itemsToSkip.length}`);
    console.log(`Chunks to Insert:     ${plan.chunksToInsert.length}`);
    console.log(`Chunks to Skip:       ${plan.chunksToSkip.length}`);
    console.log(`Embeddings to Reuse:  ${plan.validExistingEmbeddingsCount}`);
    console.log(`Embeddings to Generate: ${plan.chunksNeedingEmbedding.length}`);
    console.log(`Qdrant Points to Upsert: ${plan.qdrantPointsToUpsert.length}`);

    if (plan.dryRun) {
      console.log('\n======================================================================');
      console.log('DRY-RUN COMPLETE. Zero writes made to Turso or Qdrant Cloud.');
      console.log('Awaiting explicit approval before actual live execution.');
      console.log('======================================================================');
    } else {
      console.log('\n======================================================================');
      console.log('LIVE MIGRATION COMPLETE. All items and vectors successfully transferred.');
      console.log('======================================================================');
    }
  } catch (err: unknown) {
    console.error('\nMigration Failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Only execute cli if run directly
if (process.argv[1] && process.argv[1].includes('migrate-cloud')) {
  cli();
}
