import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../src/db/schema';
import { ItemRepository } from '../src/repositories/item.repository';
import { ChunkRepository } from '../src/repositories/chunk.repository';
import { VectorCleanupRepository } from '../src/repositories/vector-cleanup.repository';
import { MockQdrantService } from '../src/services/qdrant.service';
import { ItemController } from '../src/controllers/item.controller';
import { AppError } from '../src/middleware/error-handler.middleware';
import { ZodError } from 'zod';
import { wrapDatabaseSync } from '../src/db/connection';
import { RetrievalService } from '../src/services/retrieval.service';
import { MockEmbeddingProvider } from '../src/services/embedding.service';
import { IngestionService } from '../src/services/ingestion.service';
import { ScraperService } from '../src/services/scraper.service';
import { ChunkingService } from '../src/services/chunking.service';

describe('Phase 3: Item Deletion, Atomic Cleanup Registration & Durable Recovery Test Suite', () => {
  let sqliteDb: DatabaseSync;
  let client: any;
  let itemRepo: ItemRepository;
  let chunkRepo: ChunkRepository;
  let cleanupRepo: VectorCleanupRepository;
  let mockQdrant: MockQdrantService;
  let controller: ItemController;
  let mockEmbeddingProvider: MockEmbeddingProvider;

  beforeEach(() => {
    sqliteDb = new DatabaseSync(':memory:');
    initSchema(sqliteDb);
    client = wrapDatabaseSync(sqliteDb);
    itemRepo = new ItemRepository(client);
    chunkRepo = new ChunkRepository(client);
    cleanupRepo = new VectorCleanupRepository(client);
    mockQdrant = new MockQdrantService();
    controller = new ItemController(itemRepo, chunkRepo, mockQdrant, cleanupRepo);
    mockEmbeddingProvider = new MockEmbeddingProvider({
      modelName: 'gemini-embedding-001',
      dimensions: 4,
    });
  });

  afterEach(() => {
    sqliteDb.close();
  });

  const createMockReqRes = (params: Record<string, string>) => {
    let statusCode = 200;
    let responseBody: any = null;

    const req = { params } as any;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: any) {
        responseBody = body;
        return this;
      },
    } as any;

    return {
      req,
      res,
      getStatus: () => statusCode,
      getBody: () => responseBody,
    };
  };

  test('1. Turso transaction failure preserves item, chunks, and Qdrant vectors', async () => {
    // 1. Create item and chunks in SQLite
    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Resilience Test Note',
      raw_content: 'Content that must be preserved if Turso transaction fails.',
      status: 'completed',
    });
    const chunkId = crypto.randomUUID();
    await chunkRepo.createMany([
      {
        id: chunkId,
        item_id: item.id,
        chunk_index: 0,
        content: 'Content that must be preserved if Turso transaction fails.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    // 2. Upsert vector into Qdrant
    await mockQdrant.upsertChunks([
      {
        id: chunkId,
        vector: [1, 0, 0, 0],
        payload: { item_id: item.id, chunk_index: 0, source_type: 'note' },
      },
    ]);
    assert.equal(mockQdrant.getPointsCount(), 1);

    // 3. Subclass ItemRepository to simulate a database transaction batch failure
    class FailingItemRepository extends ItemRepository {
      override async deleteWithChunksAndRegisterCleanup(
        _itemId: string,
        _chunkPointIds: string[]
      ): Promise<boolean> {
        throw new Error('Simulated Turso libSQL transaction abort');
      }
    }
    const failingItemRepo = new FailingItemRepository(client);
    const safeController = new ItemController(failingItemRepo, chunkRepo, mockQdrant, cleanupRepo);

    const { req, res } = createMockReqRes({ id: item.id });
    let capturedError: any = null;
    await safeController.deleteItem(req, res, (err) => {
      capturedError = err;
    });

    // 4. Verify transaction failure was caught
    assert.ok(capturedError instanceof Error);
    assert.equal(capturedError.message, 'Simulated Turso libSQL transaction abort');

    // 5. CRITICAL: Parent item and chunks must remain intact in Turso
    const itemInDb = await itemRepo.findById(item.id);
    assert.notEqual(itemInDb, null, 'Parent item must not be deleted');
    const chunksInDb = await chunkRepo.findByItemId(item.id);
    assert.equal(chunksInDb.length, 1, 'Chunks must not be deleted');

    // 6. CRITICAL: Qdrant vector was NOT deleted
    assert.equal(mockQdrant.getPointsCount(), 1, 'Qdrant vectors must remain untouched');

    // 7. Verify retrieval still returns the item
    const retrieval = new RetrievalService(chunkRepo, mockEmbeddingProvider, mockQdrant);
    const searchResults = await retrieval.retrieve('Content that must be preserved');
    assert.equal(searchResults.length, 1);
    assert.equal(searchResults[0].chunk_id, chunkId);
  });

  test('2. Successful deletion removes the item, chunks, and Qdrant vectors', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Full Deletion Note',
      raw_content: 'Item to be fully deleted.',
      status: 'completed',
    });
    const chunkId = crypto.randomUUID();
    await chunkRepo.createMany([
      {
        id: chunkId,
        item_id: item.id,
        chunk_index: 0,
        content: 'Item to be fully deleted.',
        embedding: JSON.stringify([0.5, 0.5, 0.5, 0.5]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);
    await mockQdrant.upsertChunks([
      {
        id: chunkId,
        vector: [0.5, 0.5, 0.5, 0.5],
        payload: { item_id: item.id, chunk_index: 0, source_type: 'note' },
      },
    ]);

    const { req, res, getStatus, getBody } = createMockReqRes({ id: item.id });
    await controller.deleteItem(req, res, (err) => {
      if (err) throw err;
    });

    assert.equal(getStatus(), 200);
    assert.equal(getBody().status, 'success');
    assert.equal(getBody().data.database_deleted, true);
    assert.equal(getBody().data.vector_cleanup_completed, true);
    assert.equal(getBody().data.deleted_chunks, 1);

    // Verified removed from SQLite
    assert.equal(await itemRepo.findById(item.id), null);
    assert.equal((await chunkRepo.findByItemId(item.id)).length, 0);

    // Verified removed from Qdrant
    assert.equal(mockQdrant.getPointsCount(), 0);

    // Verified no leftover records in pending_vector_cleanups
    assert.equal(await cleanupRepo.count(), 0);
  });

  test('3. Qdrant failure after Turso commit leaves durable cleanup records and returns partial_success', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Partial Failure Item',
      raw_content: 'Item whose vector deletion will fail in Qdrant.',
      status: 'completed',
    });
    const chunkId = crypto.randomUUID();
    await chunkRepo.createMany([
      {
        id: chunkId,
        item_id: item.id,
        chunk_index: 0,
        content: 'Item whose vector deletion will fail in Qdrant.',
        embedding: JSON.stringify([1, 1, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);
    await mockQdrant.upsertChunks([
      {
        id: chunkId,
        vector: [1, 1, 0, 0],
        payload: { item_id: item.id, chunk_index: 0, source_type: 'note' },
      },
    ]);

    // Flaky Qdrant service simulating network failure during deletePoints
    class FailingDeleteQdrantService extends MockQdrantService {
      override async deletePoints(_pointIds: string[]): Promise<void> {
        throw new Error('Qdrant cluster unavailable (simulated 503)');
      }
    }
    const failingQdrant = new FailingDeleteQdrantService();
    // seed the point into failingQdrant too
    await failingQdrant.upsertChunks([
      {
        id: chunkId,
        vector: [1, 1, 0, 0],
        payload: { item_id: item.id, chunk_index: 0, source_type: 'note' },
      },
    ]);

    const partialController = new ItemController(itemRepo, chunkRepo, failingQdrant, cleanupRepo);

    const { req, res, getStatus, getBody } = createMockReqRes({ id: item.id });
    await partialController.deleteItem(req, res, (err) => {
      if (err) throw err;
    });

    // 1. Response must be HTTP 207 Multi-Status partial_success, NOT standard success
    assert.equal(getStatus(), 207);
    assert.equal(getBody().status, 'partial_success');
    assert.equal(getBody().code, 'VECTOR_CLEANUP_PENDING');
    assert.equal(getBody().data.database_deleted, true);
    assert.equal(getBody().data.vector_cleanup_completed, false);
    assert.ok(getBody().data.orphaned_point_ids.includes(chunkId));

    // 2. Relational deletion succeeded
    assert.equal(await itemRepo.findById(item.id), null);
    assert.equal((await chunkRepo.findByItemId(item.id)).length, 0);

    // 3. Durable cleanup record exists in Turso table
    const pending = await cleanupRepo.findAll();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].point_id, chunkId);
    assert.equal(pending[0].item_id, item.id);
  });

  test('4. Retrieval ignores orphaned vectors when chunks are deleted from Turso', async () => {
    // Vector point is in Qdrant, but chunks table in Turso is empty
    const orphanedChunkId = crypto.randomUUID();
    await mockQdrant.upsertChunks([
      {
        id: orphanedChunkId,
        vector: [0.9, 0.1, 0, 0],
        payload: { item_id: crypto.randomUUID(), chunk_index: 0, source_type: 'note' },
      },
    ]);

    const retrieval = new RetrievalService(chunkRepo, mockEmbeddingProvider, mockQdrant);
    const results = await retrieval.retrieve('Any question query');

    // Chunks table has no record for orphanedChunkId, so hydration filters it out!
    assert.equal(results.length, 0, 'Hydration must drop orphaned Qdrant vectors');
  });

  test('5. Cleanup records survive simulated server restart', async () => {
    // 1. Insert pending cleanup records directly into SQLite
    const orphanId1 = crypto.randomUUID();
    const orphanId2 = crypto.randomUUID();
    await cleanupRepo.insertMany([orphanId1, orphanId2], 'simulated-parent-item');

    assert.equal(await cleanupRepo.count(), 2);

    // 2. Simulate server restart: new repository instance with new memory client pointing to same DB
    const restartedCleanupRepo = new VectorCleanupRepository(client);
    const reloadedRecords = await restartedCleanupRepo.findAll();

    assert.equal(reloadedRecords.length, 2);
    const loadedIds = reloadedRecords.map((r) => r.point_id);
    assert.ok(loadedIds.includes(orphanId1));
    assert.ok(loadedIds.includes(orphanId2));
  });

  test('6. Successful retry removes vectors from Qdrant and cleanup records from database', async () => {
    const orphanId = crypto.randomUUID();
    await cleanupRepo.insertMany([orphanId], 'parent-item');
    await mockQdrant.upsertChunks([
      {
        id: orphanId,
        vector: [0.5, 0.5, 0, 0],
        payload: { item_id: 'parent-item', chunk_index: 0, source_type: 'note' },
      },
    ]);
    assert.equal(mockQdrant.getPointsCount(), 1);

    // Retry cleanup
    const retryResult = await mockQdrant.retryDurableCleanups(cleanupRepo);

    assert.equal(retryResult.succeeded, 1);
    assert.equal(retryResult.failed, 0);

    // Vector in Qdrant is purged
    assert.equal(mockQdrant.getPointsCount(), 0);

    // Record in database is purged
    assert.equal(await cleanupRepo.count(), 0);
  });

  test('7. Failure to remove cleanup records after successful Qdrant deletion is safely retryable', async () => {
    const orphanId = crypto.randomUUID();
    await cleanupRepo.insertMany([orphanId], 'parent-item');
    await mockQdrant.upsertChunks([
      {
        id: orphanId,
        vector: [0.5, 0.5, 0, 0],
        payload: { item_id: 'parent-item', chunk_index: 0, source_type: 'note' },
      },
    ]);

    // Flaky cleanup repository where deleteByPointIds fails on attempt 1
    let failDelete = true;
    class FlakyCleanupRepository extends VectorCleanupRepository {
      override async deleteByPointIds(pointIds: string[]): Promise<number> {
        if (failDelete) {
          throw new Error('Simulated SQLite write lock timeout during cleanup record purge');
        }
        return super.deleteByPointIds(pointIds);
      }
    }
    const flakyCleanupRepo = new FlakyCleanupRepository(client);

    // Attempt 1: Qdrant deletion succeeds, but database deletion throws
    const res1 = await mockQdrant.retryDurableCleanups(flakyCleanupRepo);
    assert.equal(res1.succeeded, 1);
    // Point was removed from Qdrant
    assert.equal(mockQdrant.getPointsCount(), 0);
    // But record still in DB
    assert.equal(await flakyCleanupRepo.count(), 1);

    // Attempt 2: Retry is safe and idempotent!
    failDelete = false;
    const res2 = await mockQdrant.retryDurableCleanups(flakyCleanupRepo);
    assert.equal(res2.succeeded, 1);
    assert.equal(res2.failed, 0);
    // Record in DB is now purged
    assert.equal(await flakyCleanupRepo.count(), 0);
  });

  test('8. Failure to register cleanup records prevents relational deletion', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Rollback Test Note',
      raw_content: 'Content that should not be deleted if cleanup registration fails.',
      status: 'completed',
    });
    const chunkId = crypto.randomUUID();
    await chunkRepo.createMany([
      {
        id: chunkId,
        item_id: item.id,
        chunk_index: 0,
        content: 'Chunk content',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    // Mock client batch to throw when executing
    class BatchFailingItemRepo extends ItemRepository {
      override async deleteWithChunksAndRegisterCleanup(
        _itemId: string,
        _chunkPointIds: string[]
      ): Promise<boolean> {
        throw new Error('Simulated database batch failure on cleanup insert');
      }
    }

    const failingRepo = new BatchFailingItemRepo(client);
    const testController = new ItemController(failingRepo, chunkRepo, mockQdrant, cleanupRepo);

    const { req, res } = createMockReqRes({ id: item.id });
    let capturedError: any = null;
    await testController.deleteItem(req, res, (err) => {
      capturedError = err;
    });

    assert.ok(capturedError instanceof Error);
    assert.equal(capturedError.message, 'Simulated database batch failure on cleanup insert');

    // Item and chunks must still exist
    assert.notEqual(await itemRepo.findById(item.id), null);
    assert.equal((await chunkRepo.findByItemId(item.id)).length, 1);
  });

  test('9. Existing ingestion cleanup behavior still works with durable storage', async () => {
    let failDeletions = true;
    class FlakyQdrantService extends MockQdrantService {
      override async deletePoints(pointIds: string[]) {
        if (failDeletions) {
          throw new Error('Simulated network timeout during Qdrant points deletion');
        }
        return super.deletePoints(pointIds);
      }
    }

    let version = 1;
    class DynamicScraper extends ScraperService {
      override async scrape(url: string) {
        return {
          url,
          title: `Title v${version}`,
          content: `Content revision v${version} for testing durable ingestion cleanup.`,
          contentType: 'text/html',
        };
      }
    }

    const flakyQdrant = new FlakyQdrantService();
    const chunkingService = new ChunkingService({ chunkSize: 100, chunkOverlap: 20 });
    const ingestionService = new IngestionService(
      itemRepo,
      chunkRepo,
      new DynamicScraper(),
      chunkingService,
      mockEmbeddingProvider,
      flakyQdrant,
      cleanupRepo
    );

    // 1. Ingest Version 1
    const res1 = await ingestionService.ingest({
      source_type: 'url',
      url: 'https://example.com/durable-ingest-test',
    });
    const oldChunks = await chunkRepo.findByItemId(res1.item.id);
    const oldChunkId = oldChunks[0].id;

    // 2. Re-ingest Version 2 while Qdrant deletePoints fails
    version = 2;
    failDeletions = true;
    const res2 = await ingestionService.ingest({
      source_type: 'url',
      url: 'https://example.com/durable-ingest-test',
    });

    assert.equal(res2.item.id, res1.item.id);

    // 3. Verify failed point ID is in pending_vector_cleanups durable table
    const pending = await cleanupRepo.findAll();
    assert.ok(pending.length > 0);
    assert.ok(pending.some((p) => p.point_id === oldChunkId));

    // 4. Retry purge when Qdrant recovers
    failDeletions = false;
    const retryResult = await flakyQdrant.retryDurableCleanups(cleanupRepo);
    assert.equal(retryResult.succeeded, pending.length);
    assert.equal(await cleanupRepo.count(), 0);
  });

  test('10. Repeated deletion and retry operations are safe and idempotent', async () => {
    // 1. Repeated deleteItem call on nonexistent ID returns HTTP 404
    const nonexistentId = crypto.randomUUID();
    const { req, res } = createMockReqRes({ id: nonexistentId });
    let capturedError: any = null;
    await controller.deleteItem(req, res, (err) => {
      capturedError = err;
    });

    assert.ok(capturedError instanceof AppError);
    assert.equal(capturedError.statusCode, 404);

    // 2. Invalid ID format returns HTTP 400
    const { req: reqBad, res: resBad } = createMockReqRes({ id: 'invalid-uuid-string' });
    let badIdError: any = null;
    await controller.deleteItem(reqBad, resBad, (err) => {
      badIdError = err;
    });
    assert.ok(badIdError instanceof ZodError);

    // 3. retryDurableCleanups on empty table is a safe no-op
    const emptyRetry = await mockQdrant.retryDurableCleanups(cleanupRepo);
    assert.equal(emptyRetry.succeeded, 0);
    assert.equal(emptyRetry.failed, 0);
  });

  test('11. Recovery after initially failed startup cleanup when Qdrant is unavailable on boot', async () => {
    // 1. Seed durable cleanup records in the database
    const orphan1 = crypto.randomUUID();
    const orphan2 = crypto.randomUUID();
    await cleanupRepo.insertMany([orphan1, orphan2], 'startup-test-item');
    assert.equal(await cleanupRepo.count(), 2);

    // 2. Simulate Qdrant being offline on startup
    let qdrantOnline = false;
    class RecoverableQdrantService extends MockQdrantService {
      override async deletePoints(pointIds: string[]): Promise<void> {
        if (!qdrantOnline) {
          throw new Error('Qdrant 503 Service Unavailable (simulated startup outage)');
        }
        return super.deletePoints(pointIds);
      }
    }
    const recoverableQdrant = new RecoverableQdrantService();
    // seed the points in the service
    await recoverableQdrant.upsertChunks([
      { id: orphan1, vector: [1, 0, 0, 0], payload: { item_id: 'startup-test-item' } },
      { id: orphan2, vector: [0, 1, 0, 0], payload: { item_id: 'startup-test-item' } },
    ]);

    // 3. First execution (startup recovery attempt) fails because Qdrant is down
    const startupAttempt = await recoverableQdrant.retryDurableCleanups(cleanupRepo);
    assert.equal(startupAttempt.succeeded, 0);
    assert.equal(startupAttempt.failed, 2);

    // Records MUST be preserved in the durable database table
    assert.equal(await cleanupRepo.count(), 2, 'Records must not be dropped when startup retry fails');

    // State reflects backoff
    const stateAfterFail = recoverableQdrant.getCleanupState();
    assert.equal(stateAfterFail.consecutiveFailures, 1);
    assert.ok(stateAfterFail.nextAllowedTime > Date.now());

    // In-between tick while in backoff should skip without spamming Qdrant
    const skippedTick = await recoverableQdrant.retryDurableCleanups(cleanupRepo);
    assert.equal(skippedTick.skipped, true);
    assert.equal(skippedTick.succeeded, 0);
    assert.equal(skippedTick.failed, 0);

    // 4. Now Qdrant comes online / recovers
    qdrantOnline = true;

    // Trigger manual recovery or forced retry
    const recoveryResult = await recoverableQdrant.triggerManualCleanup(cleanupRepo);
    assert.equal(recoveryResult.succeeded, 2);
    assert.equal(recoveryResult.failed, 0);

    // Both points deleted from Qdrant and records deleted from database
    assert.equal(recoverableQdrant.getPointsCount(), 0);
    assert.equal(await cleanupRepo.count(), 0);

    // State resets
    const finalState = recoverableQdrant.getCleanupState();
    assert.equal(finalState.consecutiveFailures, 0);
    assert.equal(finalState.nextAllowedTime, 0);
  });

  test('12. Concurrency lock prevents overlapping retry executions', async () => {
    const orphanId = crypto.randomUUID();
    await cleanupRepo.insertMany([orphanId], 'concurrent-item');

    let releaseDelay: () => void;
    const delayPromise = new Promise<void>((resolve) => {
      releaseDelay = resolve;
    });

    class SlowQdrantService extends MockQdrantService {
      override async deletePoints(pointIds: string[]): Promise<void> {
        // Hold execution until delayPromise resolves
        await delayPromise;
        return super.deletePoints(pointIds);
      }
    }

    const slowQdrant = new SlowQdrantService();
    await slowQdrant.upsertChunks([
      { id: orphanId, vector: [0, 1, 0, 0], payload: { item_id: 'concurrent-item' } },
    ]);

    // Launch first cleanup (which will hold waiting for delayPromise)
    const run1Promise = slowQdrant.retryDurableCleanups(cleanupRepo);

    // Launch second cleanup immediately while first is in-flight
    const run2Promise = slowQdrant.retryDurableCleanups(cleanupRepo);

    const run2Result = await run2Promise;
    // Second concurrent call must detect active execution and skip safely
    assert.equal(run2Result.skipped, true);
    assert.equal(run2Result.isRunning, true);

    // Now release the slow first call
    releaseDelay!();
    const run1Result = await run1Promise;
    assert.equal(run1Result.succeeded, 1);
    assert.equal(run1Result.failed, 0);

    // Cleaned up completely
    assert.equal(await cleanupRepo.count(), 0);
  });

  test('13. Bounded batching processes cleanups in controlled slices', async () => {
    // Insert 5 pending items
    const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
    await cleanupRepo.insertMany(ids, 'batch-test-item');
    assert.equal(await cleanupRepo.count(), 5);

    const batchQdrant = new MockQdrantService();
    for (const id of ids) {
      await batchQdrant.upsertChunks([
        { id, vector: [1, 0, 0, 0], payload: { item_id: 'batch-test-item' } },
      ]);
    }

    // Run with batchSize = 2 and maxBatches = 1 (processes exactly 2 points)
    const sliceResult = await batchQdrant.retryDurableCleanups(cleanupRepo, {
      batchSize: 2,
      maxBatches: 1,
    });

    assert.equal(sliceResult.succeeded, 2);
    // 3 items must still remain in the database
    assert.equal(await cleanupRepo.count(), 3);
    assert.equal(batchQdrant.getPointsCount(), 3);

    // Next run processes remaining items (up to 5 batches of 2)
    const drainResult = await batchQdrant.retryDurableCleanups(cleanupRepo, {
      batchSize: 2,
      maxBatches: 5,
    });
    assert.equal(drainResult.succeeded, 3);
    assert.equal(await cleanupRepo.count(), 0);
    assert.equal(batchQdrant.getPointsCount(), 0);
  });
});
