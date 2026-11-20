import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../src/db/schema';
import { ItemRepository } from '../src/repositories/item.repository';
import { ChunkRepository } from '../src/repositories/chunk.repository';

describe('Database Architecture & Persistence Test Suite', () => {
  let db: DatabaseSync;
  let itemRepo: ItemRepository;
  let chunkRepo: ChunkRepository;

  beforeEach(async () => {
    // Isolated in-memory database for each test run
    db = new DatabaseSync(':memory:');
    await initSchema(db);
    itemRepo = new ItemRepository(db);
    chunkRepo = new ChunkRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // Test 1: Database initialization
  test('1. Database initialization creates items and chunks tables and indexes', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('items', 'chunks')")
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name).sort();
    assert.deepEqual(tableNames, ['chunks', 'items']);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as { name: string }[];

    const indexNames = indexes.map((i) => i.name).sort();
    assert.deepEqual(indexNames, [
      'idx_chunks_item_id',
      'idx_items_created_at',
      'idx_items_status',
      'idx_pending_vector_cleanups_item_id',
    ]);
  });

  // Test 2: Item creation
  test('2. Item creation persists plain text note and URL items with default status', async () => {
    const note = await itemRepo.create({
      source_type: 'note',
      title: 'Meeting Notes',
      raw_content: 'Review Turium AI architecture roadmap.',
    });

    assert.ok(note.id);
    assert.equal(note.source_type, 'note');
    assert.equal(note.title, 'Meeting Notes');
    assert.equal(note.status, 'pending');
    assert.equal(note.source_url, null);
    assert.ok(note.created_at);
    assert.ok(note.updated_at);

    const urlItem = await itemRepo.create({
      source_type: 'url',
      title: 'Documentation',
      source_url: 'https://docs.turium.ai',
      raw_content: 'Turium AI platform overview.',
    });

    assert.ok(urlItem.id);
    assert.equal(urlItem.source_type, 'url');
    assert.equal(urlItem.source_url, 'https://docs.turium.ai');
  });

  // Test 3: Item retrieval
  test('3. Item retrieval retrieves item by ID and lists all items ordered by date', async () => {
    const item1 = await itemRepo.create({
      source_type: 'note',
      title: 'First Item',
      raw_content: 'Content 1',
    });

    // Ensure distinct created_at millisecond timestamp
    await new Promise((r) => setTimeout(r, 10));

    const item2 = await itemRepo.create({
      source_type: 'url',
      title: 'Second Item',
      source_url: 'https://example.com/2',
      raw_content: 'Content 2',
    });

    const fetched = await itemRepo.findById(item1.id);
    assert.ok(fetched);
    assert.equal(fetched.id, item1.id);
    assert.equal(fetched.title, 'First Item');

    const nonExistent = await itemRepo.findById('non-existent-id');
    assert.equal(nonExistent, null);

    const all = await itemRepo.findAll();
    assert.equal(all.length, 2);
    // Ordered by created_at DESC
    assert.equal(all[0].id, item2.id);
    assert.equal(all[1].id, item1.id);
  });

  // Test 4: Item updates
  test('4. Item status updates modify status and update updated_at timestamp', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      raw_content: 'Task in progress',
      status: 'pending',
    });

    const updated = await itemRepo.updateStatus(item.id, 'processing');
    assert.equal(updated, true);

    const retrieved = await itemRepo.findById(item.id);
    assert.ok(retrieved);
    assert.equal(retrieved.status, 'processing');

    const completed = await itemRepo.updateStatus(item.id, 'completed');
    assert.equal(completed, true);
    assert.equal((await itemRepo.findById(item.id))?.status, 'completed');

    const nonExistentUpdate = await itemRepo.updateStatus('random-id', 'completed');
    assert.equal(nonExistentUpdate, false);
  });

  // Test 5: Item deletion
  test('5. Item deletion removes the item from the items table', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      raw_content: 'To be deleted',
    });

    const deleted = await itemRepo.delete(item.id);
    assert.equal(deleted, true);

    const notFound = await itemRepo.findById(item.id);
    assert.equal(notFound, null);

    const deleteAgain = await itemRepo.delete(item.id);
    assert.equal(deleteAgain, false);
  });

  // Test 6: Chunk insertion
  test('6. Chunk insertion saves ordered chunks linked to an item', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      raw_content: 'Full document text to be chunked',
    });

    const chunks = await chunkRepo.createMany([
      { item_id: item.id, chunk_index: 0, content: 'Chunk 0: Full document' },
      { item_id: item.id, chunk_index: 1, content: 'Chunk 1: text to be chunked' },
    ]);

    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].chunk_index, 0);
    assert.equal(chunks[1].chunk_index, 1);

    const retrieved = await chunkRepo.findByItemId(item.id);
    assert.equal(retrieved.length, 2);
    assert.equal(retrieved[0].content, 'Chunk 0: Full document');
    assert.equal(retrieved[1].content, 'Chunk 1: text to be chunked');
  });

  // Test 7: Foreign key enforcement
  test('7. Foreign key enforcement prevents inserting chunks for non-existent items', async () => {
    await assert.rejects(
      async () => {
        await chunkRepo.createMany([
          {
            item_id: 'non-existent-parent-item-id',
            chunk_index: 0,
            content: 'Orphan chunk content',
          },
        ]);
      },
      (err: Error) => {
        return err.message.includes('FOREIGN KEY constraint failed');
      }
    );
  });

  // Test 8: Cascade deletion
  test('8. Cascade deletion automatically removes chunks when the parent item is deleted', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      raw_content: 'Parent item with chunks',
    });

    await chunkRepo.createMany([
      { item_id: item.id, chunk_index: 0, content: 'Chunk 1' },
      { item_id: item.id, chunk_index: 1, content: 'Chunk 2' },
      { item_id: item.id, chunk_index: 2, content: 'Chunk 3' },
    ]);

    assert.equal((await chunkRepo.findByItemId(item.id)).length, 3);

    // Delete parent item
    const deleted = await itemRepo.delete(item.id);
    assert.equal(deleted, true);

    // Verify all chunks were cascade deleted
    const chunksAfterDelete = await chunkRepo.findByItemId(item.id);
    assert.equal(chunksAfterDelete.length, 0);
  });

  // Test 9: Unique chunk index constraint
  test('9. Unique chunk index constraint prevents duplicate chunk indices for the same item', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      raw_content: 'Item for unique constraint test',
    });

    await assert.rejects(
      async () => {
        await chunkRepo.createMany([
          { item_id: item.id, chunk_index: 0, content: 'First chunk index 0' },
          { item_id: item.id, chunk_index: 0, content: 'Duplicate chunk index 0' },
        ]);
      },
      (err: Error) => {
        return err.message.includes('UNIQUE constraint failed');
      }
    );
  });

  // Test 10: Transaction rollback when a write fails
  test('10. Transaction rollback ensures all-or-nothing insertion when a write fails', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      raw_content: 'Item for transaction rollback test',
    });

    // Attempt inserting 3 chunks, where the 3rd violates unique index
    try {
      await chunkRepo.createMany([
        { item_id: item.id, chunk_index: 0, content: 'Valid chunk 0' },
        { item_id: item.id, chunk_index: 1, content: 'Valid chunk 1' },
        { item_id: item.id, chunk_index: 0, content: 'Duplicate chunk 0 (causes failure)' },
      ]);
      assert.fail('Expected createMany to throw an error');
    } catch (err: unknown) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('UNIQUE constraint failed'));
    }

    // Verify rollback: zero chunks should have been inserted
    const chunks = await chunkRepo.findByItemId(item.id);
    assert.equal(chunks.length, 0);
  });
});
