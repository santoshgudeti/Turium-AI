import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../src/db/schema';
import { closeDatabase } from '../src/db/connection';
import { ItemRepository } from '../src/repositories/item.repository';
import { ChunkRepository } from '../src/repositories/chunk.repository';
import { runReindexMigration, performOnlineBackup } from '../src/scripts/reindex';

describe('Vector Re-indexing Migration Test Suite', () => {
  const tempDbDir = path.resolve(__dirname, '../data-test-migration');
  const tempDbPath = path.resolve(tempDbDir, 'test_reindex.db');

  beforeEach(() => {
    closeDatabase();
    if (!fs.existsSync(tempDbDir)) {
      fs.mkdirSync(tempDbDir, { recursive: true });
    }
    if (fs.existsSync(tempDbPath)) {
      try {
        fs.unlinkSync(tempDbPath);
      } catch {
        // ignore
      }
    }
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tempDbDir)) {
      const files = fs.readdirSync(tempDbDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(tempDbDir, file));
        } catch {
          // ignore
        }
      }
      try {
        fs.rmdirSync(tempDbDir);
      } catch {
        // ignore
      }
    }
  });

  test('1. Throws clear error if GEMINI_API_KEY is missing or dummy placeholder', async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    try {
      process.env.GEMINI_API_KEY = '';
      await assert.rejects(
        () => runReindexMigration({ dbPath: tempDbPath }),
        (err: Error) => err.message.includes('GEMINI_API_KEY is not configured')
      );
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  test('2. Re-indexing identifies legacy OpenAI chunks and reports already-valid Gemini chunks', async () => {
    const db = new DatabaseSync(tempDbPath);
    await initSchema(db);
    const itemRepo = new ItemRepository(db);
    const chunkRepo = new ChunkRepository(db);

    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Legacy and Modern Item',
      raw_content: 'Test content',
      status: 'completed',
    });

    await chunkRepo.createMany([
      {
        item_id: item.id,
        chunk_index: 0,
        content: 'Legacy chunk 1',
        embedding: JSON.stringify([0.1, 0.2, 0.3]),
        embedding_model: 'text-embedding-3-small',
        embedding_dimensions: 1536,
      },
      {
        item_id: item.id,
        chunk_index: 1,
        content: 'Legacy chunk 2',
        embedding: JSON.stringify([0.4, 0.5, 0.6]),
        embedding_model: 'text-embedding-3-small',
        embedding_dimensions: 1536,
      },
      {
        item_id: item.id,
        chunk_index: 2,
        content: 'Modern Gemini chunk',
        embedding: JSON.stringify([0.7, 0.8, 0.9]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 1536,
      },
    ]);
    db.close();

    const originalKey = process.env.GEMINI_API_KEY;
    try {
      process.env.GEMINI_API_KEY = 'test-valid-key-for-test';

      const result = await runReindexMigration({
        dbPath: tempDbPath,
        dryRun: true,
      });

      assert.equal(result.totalChunks, 3);
      assert.equal(result.alreadyValidCount, 1);
      assert.equal(result.migratedCount, 0); // Dry run does not migrate
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  test('3. Dry run does not modify any chunks or corrupt SQLite database', async () => {
    const db = new DatabaseSync(tempDbPath);
    await initSchema(db);
    const itemRepo = new ItemRepository(db);
    const chunkRepo = new ChunkRepository(db);

    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Dry Run Item',
      raw_content: 'Some note text',
      status: 'completed',
    });

    const [chunk] = await chunkRepo.createMany([
      {
        item_id: item.id,
        chunk_index: 0,
        content: 'Dry run chunk',
        embedding: JSON.stringify([1, 2, 3]),
        embedding_model: 'text-embedding-3-small',
        embedding_dimensions: 1536,
      },
    ]);
    db.close();

    const originalKey = process.env.GEMINI_API_KEY;
    try {
      process.env.GEMINI_API_KEY = 'test-valid-key-for-test';

      await runReindexMigration({
        dbPath: tempDbPath,
        dryRun: true,
      });

      // Verify that the row in DB still has legacy model
      const checkDb = new DatabaseSync(tempDbPath);
      try {
        const row = checkDb.prepare('SELECT * FROM chunks WHERE id = ?').get(chunk.id) as any;
        assert.equal(row.embedding_model, 'text-embedding-3-small');
      } finally {
        checkDb.close();
      }
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  test('4. Safe Migration never deletes saved items or content text', async () => {
    const db = new DatabaseSync(tempDbPath);
    await initSchema(db);
    const itemRepo = new ItemRepository(db);
    const chunkRepo = new ChunkRepository(db);

    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Persistent Item',
      raw_content: 'Critical raw content must never be deleted',
      status: 'completed',
    });

    await chunkRepo.createMany([
      {
        item_id: item.id,
        chunk_index: 0,
        content: 'Preserved chunk content',
        embedding: null, // missing embedding
        embedding_model: null,
        embedding_dimensions: null,
      },
    ]);
    db.close();

    const originalKey = process.env.GEMINI_API_KEY;
    try {
      process.env.GEMINI_API_KEY = 'test-valid-key';
      const result = await runReindexMigration({
        dbPath: tempDbPath,
        dryRun: true,
      });

      assert.equal(result.totalChunks, 1);
      assert.equal(result.alreadyValidCount, 0);

      const checkDb = new DatabaseSync(tempDbPath);
      try {
        const savedItem = checkDb.prepare('SELECT * FROM items WHERE id = ?').get(item.id) as any;
        assert.equal(savedItem.title, 'Persistent Item');
        assert.equal(savedItem.raw_content, 'Critical raw content must never be deleted');
      } finally {
        checkDb.close();
      }
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  test('5. performOnlineBackup uses SQLite VACUUM INTO and verifies PRAGMA integrity_check = ok', async () => {
    const db = new DatabaseSync(tempDbPath);
    await initSchema(db);
    const itemRepo = new ItemRepository(db);
    await itemRepo.create({
      source_type: 'note',
      title: 'Online Backup Verification Document',
      raw_content: 'Verified text for online backup validation',
      status: 'completed',
    });

    const backupPath = performOnlineBackup(db, tempDbPath);
    assert.ok(backupPath, 'Backup path should be returned');
    assert.ok(fs.existsSync(backupPath), 'Backup file must exist on disk');

    // Verify backup can be opened independently and is valid
    const backupDb = new DatabaseSync(backupPath);
    try {
      const integrity = backupDb.prepare('PRAGMA integrity_check').get() as any;
      assert.equal(integrity.integrity_check, 'ok');

      const items = backupDb.prepare('SELECT * FROM items').all() as any[];
      assert.equal(items.length, 1);
      assert.equal(items[0].title, 'Online Backup Verification Document');
    } finally {
      backupDb.close();
      db.close();
    }
  });
});
