import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config/env';
import { getDatabase } from '../db/connection';
import { initSchema } from '../db/schema';
import { GeminiEmbeddingProvider } from '../services/embedding.service';
import { logger } from '../utils/logger';

interface ChunkRow {
  id: string;
  item_id: string;
  chunk_index: number;
  content: string;
  embedding: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
}

/**
 * Genuine SQLite Online Backup Utility
 * Uses SQLite's native VACUUM INTO online backup command to create a clean,
 * defragmented, self-contained backup that includes all committed WAL data.
 * Verifies that the backup is readable and passes PRAGMA integrity_check.
 */
export function performOnlineBackup(db: DatabaseSync, dbPath: string): string | null {
  if (dbPath === ':memory:') {
    return null;
  }

  const resolvedPath = path.resolve(process.cwd(), dbPath);
  if (!fs.existsSync(resolvedPath)) {
    logger.info({ path: resolvedPath }, 'Database file does not exist yet; skipping pre-migration backup');
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${resolvedPath}.bak-${timestamp}`;

  try {
    // 1. Execute SQLite's native online backup command
    // Escapes single quotes in the filepath
    const escapedBackupPath = backupPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escapedBackupPath}';`);

    logger.info({ original: resolvedPath, backup: backupPath }, 'Native SQLite online backup generated');

    // 2. Independently verify the backup file can be opened and passes integrity check
    const verifyDb = new DatabaseSync(backupPath);
    try {
      const integrity = verifyDb.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
      if (integrity?.integrity_check !== 'ok') {
        throw new Error(`Integrity check failed: ${integrity?.integrity_check}`);
      }
      // Verify tables and data are queryable
      verifyDb.prepare('SELECT COUNT(*) FROM chunks').get();
    } finally {
      verifyDb.close();
    }

    logger.info({ backup: backupPath }, 'Backup successfully verified with PRAGMA integrity_check = ok');
    return backupPath;
  } catch (err) {
    logger.error({ err, backupPath }, 'Failed to create or verify SQLite backup');
    // Clean up failed partial backup file if created
    if (fs.existsSync(backupPath)) {
      try {
        fs.unlinkSync(backupPath);
      } catch {
        // ignore
      }
    }
    throw new Error(`SQLite online backup failed and aborted re-indexing: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Migration & Re-indexing runner for Google Gemini
 */
export async function runReindexMigration(options?: {
  db?: DatabaseSync;
  dbPath?: string;
  batchSize?: number;
  dryRun?: boolean;
}): Promise<{
  totalChunks: number;
  migratedCount: number;
  alreadyValidCount: number;
  failedCount: number;
  backupPath: string | null;
}> {
  const dbPath = options?.dbPath || config.DATABASE_PATH;
  const batchSize = options?.batchSize || 50;
  const targetModel = config.GEMINI_EMBEDDING_MODEL;
  const targetDimensions = config.GEMINI_EMBEDDING_DIMENSIONS;

  console.log('='.repeat(70));
  console.log('Turium AI Knowledge Inbox — Vector Re-indexing Migration');
  console.log('='.repeat(70));
  console.log(`Database:          ${dbPath}`);
  console.log(`Target Model:      ${targetModel}`);
  console.log(`Target Dimensions: ${targetDimensions}`);
  console.log(`Batch Size:        ${batchSize}`);
  console.log(`Dry Run:           ${options?.dryRun ? 'YES (No changes will be saved)' : 'NO'}`);
  console.log('='.repeat(70));

  // 1. Verify API Key
  const rawKey =
    process.env.GEMINI_API_KEY !== undefined
      ? process.env.GEMINI_API_KEY
      : config.GEMINI_API_KEY;
  const apiKey = rawKey?.trim();

  if (!apiKey || apiKey === 'your_gemini_api_key_here' || apiKey.startsWith('sk-dummy')) {
    throw new Error(
      'GEMINI_API_KEY is not configured with a valid key. Please set GEMINI_API_KEY in your .env file before running re-indexing.'
    );
  }

  // 2. Connect to database
  const shouldClose = !options?.db;
  const db: DatabaseSync = options?.db || new DatabaseSync(dbPath);
  await initSchema(db);

  // 3. Perform verified native SQLite online backup (unless dry run)
  let backupPath: string | null = null;
  if (!options?.dryRun) {
    backupPath = performOnlineBackup(db, dbPath);
  }

  try {
    // 4. Query all chunks
    const totalStmt = db.prepare('SELECT COUNT(*) as count FROM chunks');
    const totalRow = totalStmt.get() as { count: number };
    const totalChunks = Number(totalRow?.count || 0);

    if (totalChunks === 0) {
      console.log('Database contains 0 chunks. Nothing to re-index.');
      return {
        totalChunks: 0,
        migratedCount: 0,
        alreadyValidCount: 0,
        failedCount: 0,
        backupPath,
      };
    }

    // 5. Query chunks needing re-indexing (different model or missing embedding)
    const candidateStmt = db.prepare(`
      SELECT id, item_id, chunk_index, content, embedding, embedding_model, embedding_dimensions
      FROM chunks
      WHERE embedding_model != ? OR embedding IS NULL OR embedding_dimensions != ?
      ORDER BY item_id, chunk_index ASC
    `);
    const candidates = candidateStmt.all(targetModel, targetDimensions) as unknown as ChunkRow[];

    const alreadyValidCount = totalChunks - candidates.length;
    console.log(`Total Chunks:           ${totalChunks}`);
    console.log(`Already on ${targetModel}: ${alreadyValidCount}`);
    console.log(`Chunks Needing Update:  ${candidates.length}`);

    if (candidates.length === 0) {
      console.log('\nAll chunks are already up-to-date with Google Gemini. No migration needed.');
      return {
        totalChunks,
        migratedCount: 0,
        alreadyValidCount,
        failedCount: 0,
        backupPath,
      };
    }

    if (options?.dryRun) {
      console.log('\nDry run complete. No vectors were modified.');
      return {
        totalChunks,
        migratedCount: 0,
        alreadyValidCount,
        failedCount: 0,
        backupPath,
      };
    }

    // 6. Execute batch re-embedding using GeminiEmbeddingProvider
    const provider = new GeminiEmbeddingProvider({
      apiKey,
      modelName: targetModel,
      dimensions: targetDimensions,
    });

    const updateStmt = db.prepare(`
      UPDATE chunks
      SET embedding = ?, embedding_model = ?, embedding_dimensions = ?
      WHERE id = ?
    `);

    let migratedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const batchTexts = batch.map((c) => c.content);

      console.log(
        `Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(candidates.length / batchSize)} (${batch.length} chunks)...`
      );

      try {
        const vectors = await provider.generateEmbeddings(batchTexts);

        // Atomic per-batch update
        db.exec('BEGIN IMMEDIATE');
        try {
          for (let j = 0; j < batch.length; j++) {
            const chunk = batch[j];
            const vector = vectors[j];
            updateStmt.run(
              JSON.stringify(vector),
              targetModel,
              targetDimensions,
              chunk.id
            );
          }
          db.exec('COMMIT');
          migratedCount += batch.length;
          console.log(`✓ Batch successfully migrated (${migratedCount}/${candidates.length})`);
        } catch (dbErr) {
          db.exec('ROLLBACK');
          console.error(`✗ Failed to commit batch to SQLite:`, dbErr);
          failedCount += batch.length;
        }
      } catch (apiErr) {
        console.error(
          `✗ Failed to generate Gemini embeddings for batch starting at index ${i}:`,
          apiErr instanceof Error ? apiErr.message : String(apiErr)
        );
        failedCount += batch.length;
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log('Migration Completed Summary:');
    console.log(`  Total Chunks:           ${totalChunks}`);
    console.log(`  Successfully Migrated:  ${migratedCount}`);
    console.log(`  Previously Valid:       ${alreadyValidCount}`);
    console.log(`  Failed / Skipped:       ${failedCount}`);
    if (backupPath) {
      console.log(`  Verified Backup Saved:  ${backupPath}`);
    }
    console.log('='.repeat(70));

    return {
      totalChunks,
      migratedCount,
      alreadyValidCount,
      failedCount,
      backupPath,
    };
  } finally {
    if (shouldClose) {
      db.close();
    }
  }
}

// Script direct CLI execution
if (require.main === module) {
  runReindexMigration()
    .then((result) => {
      if (result.failedCount > 0) {
        console.warn(`\nWarning: ${result.failedCount} chunks failed to migrate. Check logs and retry.`);
        process.exit(1);
      }
      console.log('\nRe-indexing completed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\nFatal migration error:', err.message);
      process.exit(1);
    });
}
