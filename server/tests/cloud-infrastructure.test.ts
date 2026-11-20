import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../src/db/schema';
import { ItemRepository } from '../src/repositories/item.repository';
import { ChunkRepository } from '../src/repositories/chunk.repository';
import { IngestionService } from '../src/services/ingestion.service';
import { ChunkingService } from '../src/services/chunking.service';
import { MockEmbeddingProvider } from '../src/services/embedding.service';
import {
  QdrantService,
  MockQdrantService,
  DisabledQdrantService,
  QDRANT_COLLECTION_NAME,
} from '../src/services/qdrant.service';
import { wrapDatabaseSync, isTursoConfigured } from '../src/db/connection';
import { getHealth } from '../src/controllers/health.controller';
import { AppError } from '../middleware/error-handler.middleware';

describe('Cloud Infrastructure (Turso + Qdrant) Test Suite', () => {
  let testDb: DatabaseSync;
  let itemRepo: ItemRepository;
  let chunkRepo: ChunkRepository;

  beforeEach(async () => {
    testDb = new DatabaseSync(':memory:');
    await initSchema(testDb);
    itemRepo = new ItemRepository(testDb);
    chunkRepo = new ChunkRepository(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  // 1. Turso adapter & wrapDatabaseSync compatibility
  test('1. wrapDatabaseSync polyfills Client interface on synchronous DatabaseSync', async () => {
    const client = wrapDatabaseSync(testDb);

    // execute SELECT
    const selectRes = await client.execute('SELECT 1 as num');
    assert.equal(selectRes.rows.length, 1);
    assert.equal(selectRes.rows[0].num, 1);

    // execute INSERT
    const insertRes = await client.execute({
      sql: `INSERT INTO items (id, source_type, title, raw_content, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ['item-test-1', 'note', 'Test Note', 'Test Content', 'completed', '2026-01-01', '2026-01-01'],
    });
    assert.equal(insertRes.rowsAffected, 1);

    // batch operations
    const batchRes = await client.batch([
      {
        sql: `INSERT INTO chunks (id, item_id, chunk_index, content, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: ['chunk-test-1', 'item-test-1', 0, 'Chunk content 1', '2026-01-01'],
      },
      {
        sql: `INSERT INTO chunks (id, item_id, chunk_index, content, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: ['chunk-test-2', 'item-test-1', 1, 'Chunk content 2', '2026-01-01'],
      },
    ]);
    assert.equal(batchRes.length, 2);

    const countRes = await client.execute('SELECT count(*) as count FROM chunks');
    assert.equal(countRes.rows[0].count, 2);
  });

  // 2. Mock Qdrant Service functionality
  test('2. MockQdrantService stores vectors, searches by cosine similarity, and filters by model', async () => {
    const qdrant = new MockQdrantService();
    assert.equal(qdrant.isConfigured(), true);

    await qdrant.initCollection();

    // Upsert 2 points with Gemini embeddings and 1 with legacy model
    await qdrant.upsertChunks([
      {
        id: 'chunk-1',
        vector: [1, 0, 0, 0],
        payload: {
          item_id: 'item-1',
          chunk_index: 0,
          source_type: 'note',
          embedding_model: 'gemini-embedding-001',
          created_at: '2026-01-01',
        },
      },
      {
        id: 'chunk-2',
        vector: [0.7071, 0.7071, 0, 0],
        payload: {
          item_id: 'item-1',
          chunk_index: 1,
          source_type: 'note',
          embedding_model: 'gemini-embedding-001',
          created_at: '2026-01-01',
        },
      },
      {
        id: 'chunk-legacy',
        vector: [1, 0, 0, 0],
        payload: {
          item_id: 'item-2',
          chunk_index: 0,
          source_type: 'note',
          embedding_model: 'text-embedding-3-small',
          created_at: '2026-01-01',
        },
      },
    ]);

    assert.equal(qdrant.getPointsCount(), 3);

    // Search with Gemini model filter
    const searchRes = await qdrant.search([1, 0, 0, 0], {
      topK: 5,
      embeddingModel: 'gemini-embedding-001',
    });

    assert.equal(searchRes.length, 2);
    assert.equal(searchRes[0].id, 'chunk-1');
    assert.ok(searchRes[0].score > searchRes[1].score);

    // Delete by item ID
    await qdrant.deleteByItemId('item-1');
    assert.equal(qdrant.getPointsCount(), 1);

    const remaining = await qdrant.search([1, 0, 0, 0]);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, 'chunk-legacy');
  });

  // 3. Error handling: Ingestion failure when Qdrant fails
  test('3. Ingestion marks item as failed if Qdrant vector indexing throws', async () => {
    // Failing Qdrant Service
    class FailingQdrantService extends QdrantService {
      override isConfigured(): boolean {
        return true;
      }
      override async upsertChunks(): Promise<void> {
        throw new Error('Qdrant cluster unavailable (simulated 503)');
      }
    }

    const failingQdrant = new FailingQdrantService();
    const chunker = new ChunkingService();
    const provider = new MockEmbeddingProvider({
      modelName: 'gemini-embedding-001',
      dimensions: 4,
    });

    const ingestionService = new IngestionService(
      itemRepo,
      chunkRepo,
      undefined,
      chunker,
      provider,
      failingQdrant
    );

    await assert.rejects(
      () =>
        ingestionService.ingest({
          source_type: 'note',
          title: 'Resilience Test Note',
          content: 'This note content will fail during vector indexing in Qdrant.',
        }),
      (err: AppError) => {
        assert.equal(err.statusCode, 502);
        assert.ok(err.message.includes('Vector indexing failed in Qdrant'));
        return true;
      }
    );

    // Invariant: The item must exist in Turso but be marked with status 'failed'
    const items = await itemRepo.findAll();
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Resilience Test Note');
    assert.equal(items[0].status, 'failed');
  });

  // 4. Health endpoint architecture validation
  test('4. Health endpoint reports all 4 subsystems with backward compatibility', async () => {
    const mockRes = {
      statusCode: 0,
      jsonPayload: null as any,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(data: any) {
        this.jsonPayload = data;
        return this;
      },
    };

    await getHealth({} as any, mockRes as any);

    assert.equal(mockRes.statusCode, 200);
    const data = mockRes.jsonPayload;

    // Verify top-level backward compatibility for frontend
    assert.ok(data.status === 'ok' || data.status === 'degraded');
    assert.ok(data.database);
    assert.ok(data.ai);
    assert.equal(data.ai.models.chat, 'gemini-3.5-flash-lite');
    assert.equal(data.ai.models.embedding, 'gemini-embedding-001');
    assert.equal(data.ai.embeddingDimensions, 1536);

    // Verify detailed dependencies subsystems
    assert.ok(data.dependencies);
    assert.ok(data.dependencies.relational_db);
    assert.ok(['turso', 'sqlite'].includes(data.dependencies.relational_db.provider));
    assert.ok(data.dependencies.vector_index);
    assert.ok(['qdrant', 'in-process'].includes(data.dependencies.vector_index.provider));
    assert.ok(data.dependencies.gemini_ai);
    assert.equal(data.dependencies.gemini_ai.chat_model, 'gemini-3.5-flash-lite');
  });
});
