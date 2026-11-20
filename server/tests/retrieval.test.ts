import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../src/db/schema';
import { ItemRepository } from '../src/repositories/item.repository';
import { ChunkRepository } from '../src/repositories/chunk.repository';
import {
  RetrievalService,
  cosineSimilarity,
  computeContentFingerprint,
} from '../src/services/retrieval.service';
import { MockEmbeddingProvider } from '../src/services/embedding.service';
import { DisabledQdrantService, MockQdrantService } from '../src/services/qdrant.service';

describe('Similarity Retrieval Test Suite', () => {
  let testDb: DatabaseSync;
  let itemRepo: ItemRepository;
  let chunkRepo: ChunkRepository;
  let mockProvider: MockEmbeddingProvider;
  let retrievalService: RetrievalService;
  let disabledQdrant: DisabledQdrantService;

  beforeEach(() => {
    testDb = new DatabaseSync(':memory:');
    initSchema(testDb);
    itemRepo = new ItemRepository(testDb);
    chunkRepo = new ChunkRepository(testDb);
    disabledQdrant = new DisabledQdrantService();

    mockProvider = new MockEmbeddingProvider({
      modelName: 'gemini-embedding-001',
      dimensions: 4,
    });
    retrievalService = new RetrievalService(chunkRepo, mockProvider, disabledQdrant);
  });

  afterEach(() => {
    testDb.close();
  });

  test('1. Cosine similarity calculation computes exact values for identical, orthogonal, and opposing vectors', () => {
    // Identical normalized vectors -> similarity = 1.0
    const identical = cosineSimilarity([1, 0, 0, 0], [1, 0, 0, 0]);
    assert.ok(Math.abs(identical - 1.0) < 1e-6);

    // Orthogonal vectors -> similarity = 0.0
    const orthogonal = cosineSimilarity([1, 0, 0, 0], [0, 1, 0, 0]);
    assert.ok(Math.abs(orthogonal - 0.0) < 1e-6);

    // Opposing vectors -> similarity = -1.0
    const opposing = cosineSimilarity([1, 0, 0, 0], [-1, 0, 0, 0]);
    assert.ok(Math.abs(opposing - (-1.0)) < 1e-6);

    // Arbitrary vectors
    const v1 = [1, 2, 3, 4];
    const v2 = [2, 4, 6, 8];
    // Collinear vectors -> similarity = 1.0
    const collinear = cosineSimilarity(v1, v2);
    assert.ok(Math.abs(collinear - 1.0) < 1e-6);
  });

  test('2. Safely handles zero-magnitude vectors without NaN or crashing', () => {
    const zeroVec = [0, 0, 0, 0];
    const normalVec = [1, 2, 3, 4];

    assert.equal(cosineSimilarity(zeroVec, normalVec), 0);
    assert.equal(cosineSimilarity(normalVec, zeroVec), 0);
    assert.equal(cosineSimilarity(zeroVec, zeroVec), 0);
  });

  test('3. Safely handles vector dimension mismatches by returning 0', () => {
    const v2d = [1, 0];
    const v4d = [1, 0, 0, 0];
    assert.equal(cosineSimilarity(v2d, v4d), 0);
  });

  test('4. Ranks chunks in correct descending cosine similarity order', async () => {
    // Create a completed item
    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Vector Ranking Test Document',
      raw_content: 'Artificial intelligence architecture guide',
      status: 'completed',
    });

    // Provide custom query vector: [1, 0, 0, 0]
    const customProvider = new MockEmbeddingProvider({
      modelName: 'gemini-embedding-001',
      dimensions: 4,
      generator: () => [1, 0, 0, 0],
    });
    const customService = new RetrievalService(chunkRepo, customProvider, disabledQdrant);

    // Insert 3 chunks with known similarity to [1, 0, 0, 0]:
    // Chunk A: [1, 0, 0, 0] -> similarity 1.0 (Highest)
    // Chunk B: [0.7071, 0.7071, 0, 0] -> similarity ~0.707 (Medium)
    // Chunk C: [0, 1, 0, 0] -> similarity 0.0 (Lowest)
    await chunkRepo.createMany([
      {
        item_id: item.id,
        chunk_index: 0,
        content: 'Chunk C - Low relevance',
        embedding: JSON.stringify([0, 1, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
      {
        item_id: item.id,
        chunk_index: 1,
        content: 'Chunk A - High relevance',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
      {
        item_id: item.id,
        chunk_index: 2,
        content: 'Chunk B - Medium relevance',
        embedding: JSON.stringify([0.7071, 0.7071, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    const results = await customService.retrieve('artificial intelligence');

    assert.equal(results.length, 3);
    assert.equal(results[0].content, 'Chunk A - High relevance');
    assert.ok(results[0].similarity > results[1].similarity);
    assert.equal(results[1].content, 'Chunk B - Medium relevance');
    assert.ok(results[1].similarity > results[2].similarity);
    assert.equal(results[2].content, 'Chunk C - Low relevance');
  });

  test('5. Honors topK limit and returns highest-ranking subset', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      title: 'TopK Test Document',
      raw_content: 'Five distinct chunks for top-k evaluation',
      status: 'completed',
    });

    const customProvider = new MockEmbeddingProvider({
      modelName: 'gemini-embedding-001',
      dimensions: 4,
      generator: () => [1, 0, 0, 0],
    });
    const customService = new RetrievalService(chunkRepo, customProvider, disabledQdrant);

    const chunks = [
      { score: 0.2, content: 'Chunk 1' },
      { score: 0.9, content: 'Chunk 2' },
      { score: 0.5, content: 'Chunk 3' },
      { score: 0.8, content: 'Chunk 4' },
      { score: 0.3, content: 'Chunk 5' },
    ].map((c, idx) => ({
      item_id: item.id,
      chunk_index: idx,
      content: c.content,
      embedding: JSON.stringify([c.score, Math.sqrt(1 - c.score * c.score), 0, 0]),
      embedding_model: 'gemini-embedding-001',
      embedding_dimensions: 4,
    }));

    await chunkRepo.createMany(chunks);

    const top2 = await customService.retrieve('query', { topK: 2 });
    assert.equal(top2.length, 2);
    assert.equal(top2[0].content, 'Chunk 2'); // score 0.9
    assert.equal(top2[1].content, 'Chunk 4'); // score 0.8
  });

  test('6. Excludes chunks with malformed JSON, non-numeric values, or dimension mismatches', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Malformed Chunks Test',
      raw_content: 'Testing fault tolerance against corrupted vectors',
      status: 'completed',
    });

    const customProvider = new MockEmbeddingProvider({
      modelName: 'gemini-embedding-001',
      dimensions: 4,
      generator: () => [1, 0, 0, 0],
    });
    const customService = new RetrievalService(chunkRepo, customProvider, disabledQdrant);

    await chunkRepo.createMany([
      {
        item_id: item.id,
        chunk_index: 0,
        content: 'Malformed JSON chunk',
        embedding: '{bad-json-array',
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
      {
        item_id: item.id,
        chunk_index: 1,
        content: 'Dimension mismatch chunk (2D instead of 4D)',
        embedding: JSON.stringify([1, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 2,
      },
      {
        item_id: item.id,
        chunk_index: 2,
        content: 'Non-numeric values chunk',
        embedding: JSON.stringify(['not-a-number', 1, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
      {
        item_id: item.id,
        chunk_index: 3,
        content: 'Valid chunk',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    const results = await customService.retrieve('test query');
    // Only the valid chunk should be returned
    assert.equal(results.length, 1);
    assert.equal(results[0].content, 'Valid chunk');
  });

  test('7. Excludes chunks from incomplete or failed parent items', async () => {
    // 1. Completed item
    const completedItem = await itemRepo.create({
      source_type: 'note',
      title: 'Completed Document',
      raw_content: 'Valid completed content',
      status: 'completed',
    });
    // 2. Failed item
    const failedItem = await itemRepo.create({
      source_type: 'note',
      title: 'Failed Document',
      raw_content: 'Failed content that should not leak',
      status: 'failed',
    });
    // 3. In-flight processing item
    const processingItem = await itemRepo.create({
      source_type: 'note',
      title: 'Processing Document',
      raw_content: 'In-flight content not yet verified',
      status: 'processing',
    });

    const customProvider = new MockEmbeddingProvider({
      modelName: 'gemini-embedding-001',
      dimensions: 4,
      generator: () => [1, 0, 0, 0],
    });
    const customService = new RetrievalService(chunkRepo, customProvider, disabledQdrant);

    await chunkRepo.createMany([
      {
        item_id: completedItem.id,
        chunk_index: 0,
        content: 'Completed item chunk',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
      {
        item_id: failedItem.id,
        chunk_index: 0,
        content: 'Failed item chunk',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
      {
        item_id: processingItem.id,
        chunk_index: 0,
        content: 'Processing item chunk',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    const results = await customService.retrieve('query');
    assert.equal(results.length, 1);
    assert.equal(results[0].content, 'Completed item chunk');
    assert.equal(results[0].item_id, completedItem.id);
  });

  test('8. Enriches retrieved chunks with parent item metadata (title, source URL, source type)', async () => {
    const urlItem = await itemRepo.create({
      source_type: 'url',
      title: 'Turium AI Official Guide',
      source_url: 'https://turium.ai/guide',
      raw_content: 'Web page body text',
      status: 'completed',
    });

    const customProvider = new MockEmbeddingProvider({
      modelName: 'gemini-embedding-001',
      dimensions: 4,
      generator: () => [1, 0, 0, 0],
    });
    const customService = new RetrievalService(chunkRepo, customProvider, disabledQdrant);

    await chunkRepo.createMany([
      {
        item_id: urlItem.id,
        chunk_index: 0,
        content: 'Scraped article chunk',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    const results = await customService.retrieve('guide');
    assert.equal(results.length, 1);
    assert.equal(results[0].item_title, 'Turium AI Official Guide');
    assert.equal(results[0].item_source_url, 'https://turium.ai/guide');
    assert.equal(results[0].item_source_type, 'url');
    assert.equal(results[0].chunk_index, 0);
    assert.ok(typeof results[0].similarity === 'number');
  });

  test('9. Returns empty array when knowledge base has no completed items or matching chunks', async () => {
    const results = await retrievalService.retrieve('any query in empty DB');
    assert.deepEqual(results, []);
  });

  test('10. Returns empty array for empty or whitespace-only query string', async () => {
    const results = await retrievalService.retrieve('   ');
    assert.deepEqual(results, []);
  });

  test('11. Provider/model compatibility: strictly isolates Google Gemini query from legacy OpenAI vectors', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Legacy and Modern Knowledge Item',
      raw_content: 'Some content',
      status: 'completed',
    });

    // Chunk 0 embedded with legacy OpenAI model
    // Chunk 1 embedded with Google Gemini model
    const [, geminiChunk] = await chunkRepo.createMany([
      {
        item_id: item.id,
        chunk_index: 0,
        content: 'Legacy OpenAI chunk',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'text-embedding-3-small',
        embedding_dimensions: 4,
      },
      {
        item_id: item.id,
        chunk_index: 1,
        content: 'Gemini embedded chunk',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    const geminiRetrieval = new RetrievalService(
      chunkRepo,
      new MockEmbeddingProvider({
        modelName: 'gemini-embedding-001',
        dimensions: 4,
        generator: () => [1, 0, 0, 0],
      }),
      disabledQdrant
    );

    const results = await geminiRetrieval.retrieve('test query');
    assert.equal(results.length, 1);
    assert.equal(results[0].chunk_id, geminiChunk.id);
    assert.equal(results[0].content, 'Gemini embedded chunk');
  });

  test('12. Qdrant vector retrieval with Turso hydration, orphan dropping, and ranking preservation', async () => {
    const mockQdrant = new MockQdrantService();

    const completedItem = await itemRepo.create({
      source_type: 'note',
      title: 'Cloud Document',
      raw_content: 'Turso and Qdrant integration content',
      status: 'completed',
    });

    const [chunkA, chunkB] = await chunkRepo.createMany([
      {
        item_id: completedItem.id,
        chunk_index: 0,
        content: 'Chunk A in Turso',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
      {
        item_id: completedItem.id,
        chunk_index: 1,
        content: 'Chunk B in Turso',
        embedding: JSON.stringify([0.7071, 0.7071, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    // Upsert into Mock Qdrant: chunkA, chunkB, and an orphaned chunk not in Turso
    await mockQdrant.upsertChunks([
      {
        id: chunkA.id,
        vector: [1, 0, 0, 0],
        payload: {
          item_id: completedItem.id,
          chunk_index: 0,
          source_type: 'note',
          embedding_model: 'gemini-embedding-001',
          created_at: new Date().toISOString(),
        },
      },
      {
        id: chunkB.id,
        vector: [0.7071, 0.7071, 0, 0],
        payload: {
          item_id: completedItem.id,
          chunk_index: 1,
          source_type: 'note',
          embedding_model: 'gemini-embedding-001',
          created_at: new Date().toISOString(),
        },
      },
      {
        id: 'orphan-chunk-id-999',
        vector: [1, 0, 0, 0], // high similarity but not in Turso
        payload: {
          item_id: 'non-existent-item-id',
          chunk_index: 0,
          source_type: 'note',
          embedding_model: 'gemini-embedding-001',
          created_at: new Date().toISOString(),
        },
      },
    ]);

    const qdrantRetrieval = new RetrievalService(
      chunkRepo,
      new MockEmbeddingProvider({
        modelName: 'gemini-embedding-001',
        dimensions: 4,
        generator: () => [1, 0, 0, 0],
      }),
      mockQdrant
    );

    const results = await qdrantRetrieval.retrieve('query');

    // Orphaned point should be dropped, only 2 chunks hydrated from Turso
    assert.equal(results.length, 2);
    assert.equal(results[0].chunk_id, chunkA.id);
    assert.equal(results[0].content, 'Chunk A in Turso');
    assert.equal(results[0].item_title, 'Cloud Document');
    assert.equal(results[1].chunk_id, chunkB.id);
    assert.ok(results[0].similarity > results[1].similarity);
  });

  // ─── Phase 1 New Tests ───────────────────────────────────────────────────

  test('11. Item-scoped retrieval with MockQdrantService returns only chunks from the specified item', async () => {
    const itemA = await itemRepo.create({
      source_type: 'note',
      title: 'Item A',
      raw_content: 'Content from Item A',
      status: 'completed',
    });
    const itemB = await itemRepo.create({
      source_type: 'note',
      title: 'Item B',
      raw_content: 'Content from Item B',
      status: 'completed',
    });

    const [chunkA] = await chunkRepo.createMany([
      {
        item_id: itemA.id,
        chunk_index: 0,
        content: 'Content from Item A',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);
    const [chunkB] = await chunkRepo.createMany([
      {
        item_id: itemB.id,
        chunk_index: 0,
        content: 'Content from Item B',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    const mockQdrant = new MockQdrantService();
    await mockQdrant.upsertChunks([
      {
        id: chunkA.id,
        vector: [1, 0, 0, 0],
        payload: {
          item_id: itemA.id,
          chunk_index: 0,
          source_type: 'note',
          embedding_model: 'gemini-embedding-001',
          created_at: new Date().toISOString(),
        },
      },
      {
        id: chunkB.id,
        vector: [1, 0, 0, 0],
        payload: {
          item_id: itemB.id,
          chunk_index: 0,
          source_type: 'note',
          embedding_model: 'gemini-embedding-001',
          created_at: new Date().toISOString(),
        },
      },
    ]);

    const scopedRetrieval = new RetrievalService(
      chunkRepo,
      new MockEmbeddingProvider({
        modelName: 'gemini-embedding-001',
        dimensions: 4,
        generator: () => [1, 0, 0, 0],
      }),
      mockQdrant
    );

    const results = await scopedRetrieval.retrieve('query', { itemId: itemA.id });

    assert.equal(results.length, 1, 'Should return only one chunk from Item A');
    assert.equal(results[0].chunk_id, chunkA.id);
    assert.equal(results[0].item_id, itemA.id);
    assert.equal(results[0].content, 'Content from Item A');
  });

  test('12. Item-scoped retrieval with relational fallback (DisabledQdrantService) returns only chunks from specified item', async () => {
    const itemA = await itemRepo.create({
      source_type: 'note',
      title: 'Relational Item A',
      raw_content: 'Only this content should be returned',
      status: 'completed',
    });
    const itemB = await itemRepo.create({
      source_type: 'note',
      title: 'Relational Item B',
      raw_content: 'This content should be excluded',
      status: 'completed',
    });

    const [chunkA] = await chunkRepo.createMany([
      {
        item_id: itemA.id,
        chunk_index: 0,
        content: 'Only this content should be returned',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);
    await chunkRepo.createMany([
      {
        item_id: itemB.id,
        chunk_index: 0,
        content: 'This content should be excluded',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    // DisabledQdrantService forces relational path
    const relationalRetrieval = new RetrievalService(
      chunkRepo,
      new MockEmbeddingProvider({
        modelName: 'gemini-embedding-001',
        dimensions: 4,
        generator: () => [1, 0, 0, 0],
      }),
      new DisabledQdrantService()
    );

    const results = await relationalRetrieval.retrieve('query', { itemId: itemA.id });

    assert.equal(results.length, 1, 'Should return only one chunk from Item A');
    assert.equal(results[0].chunk_id, chunkA.id);
    assert.equal(results[0].item_id, itemA.id);
    assert.equal(results[0].content, 'Only this content should be returned');
  });

  test('13. Content-key deduplication prevents identical source+chunk_index from two items appearing twice in relational fallback', async () => {
    const sharedUrl = 'https://example.com/shared-article';

    // Two items ingested from the same URL
    const itemOriginal = await itemRepo.create({
      source_type: 'url',
      title: 'Original Ingest',
      source_url: sharedUrl,
      raw_content: 'Same content from shared URL',
      status: 'completed',
    });
    const itemDuplicate = await itemRepo.create({
      source_type: 'url',
      title: 'Duplicate Ingest',
      source_url: sharedUrl,
      raw_content: 'Same content from shared URL',
      status: 'completed',
    });

    // Both have chunk_index=0 with the same source_url — identical content key
    await chunkRepo.createMany([
      {
        item_id: itemOriginal.id,
        chunk_index: 0,
        content: 'Same content from shared URL',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);
    await chunkRepo.createMany([
      {
        item_id: itemDuplicate.id,
        chunk_index: 0,
        content: 'Same content from shared URL',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    const relationalRetrieval = new RetrievalService(
      chunkRepo,
      new MockEmbeddingProvider({
        modelName: 'gemini-embedding-001',
        dimensions: 4,
        generator: () => [1, 0, 0, 0],
      }),
      new DisabledQdrantService()
    );

    const results = await relationalRetrieval.retrieve('query');

    // Both chunks share key `${sharedUrl}::0` — dedup must collapse to 1 result
    assert.equal(results.length, 1, 'Deduplication should collapse two identical source::chunk_index to one result');
    assert.equal(results[0].item_source_url, sharedUrl);
  });

  test('14. Content-based deduplication: Same URL + same chunk_index + DIFFERENT content keeps BOTH chunks in Qdrant path', async () => {
    const dynamicUrl = 'https://news.example.com/daily-digest';

    // Item A (Morning digest) and Item B (Evening digest) from same URL
    const itemA = await itemRepo.create({
      source_type: 'url',
      title: 'Morning Digest',
      source_url: dynamicUrl,
      raw_content: 'Morning news content',
      status: 'completed',
    });
    const itemB = await itemRepo.create({
      source_type: 'url',
      title: 'Evening Digest',
      source_url: dynamicUrl,
      raw_content: 'Evening news content updated',
      status: 'completed',
    });

    // Both chunks have chunk_index=0, but DIFFERENT content
    const [chunkA] = await chunkRepo.createMany([
      {
        item_id: itemA.id,
        chunk_index: 0,
        content: 'Morning news: Markets opened higher today across all sectors.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);
    const [chunkB] = await chunkRepo.createMany([
      {
        item_id: itemB.id,
        chunk_index: 0,
        content: 'Evening news: Markets closed at all-time records following tech rally.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    const mockQdrant = new MockQdrantService();
    await mockQdrant.upsertChunks([
      {
        id: chunkA.id,
        vector: [1, 0, 0, 0],
        payload: {
          item_id: itemA.id,
          chunk_index: 0,
          source_type: 'url',
          embedding_model: 'gemini-embedding-001',
          created_at: new Date().toISOString(),
        },
      },
      {
        id: chunkB.id,
        vector: [1, 0, 0, 0],
        payload: {
          item_id: itemB.id,
          chunk_index: 0,
          source_type: 'url',
          embedding_model: 'gemini-embedding-001',
          created_at: new Date().toISOString(),
        },
      },
    ]);

    const retrieval = new RetrievalService(
      chunkRepo,
      new MockEmbeddingProvider({
        modelName: 'gemini-embedding-001',
        dimensions: 4,
        generator: () => [1, 0, 0, 0],
      }),
      mockQdrant
    );

    const results = await retrieval.retrieve('markets');

    // Because the content is different, neither should be dropped even though source_url & chunk_index match
    assert.equal(results.length, 2, 'Both versions must survive retrieval because content differs');
    const returnedIds = results.map((r) => r.chunk_id);
    assert.ok(returnedIds.includes(chunkA.id));
    assert.ok(returnedIds.includes(chunkB.id));
  });

  test('15. Content-based deduplication: Same URL + same chunk_index + DIFFERENT content keeps BOTH chunks in relational fallback', async () => {
    const dynamicUrl = 'https://docs.example.com/changelog';

    const itemV1 = await itemRepo.create({
      source_type: 'url',
      title: 'v1 Docs',
      source_url: dynamicUrl,
      raw_content: 'Version 1.0 details',
      status: 'completed',
    });
    const itemV2 = await itemRepo.create({
      source_type: 'url',
      title: 'v2 Docs',
      source_url: dynamicUrl,
      raw_content: 'Version 2.0 details',
      status: 'completed',
    });

    const [chunkV1] = await chunkRepo.createMany([
      {
        item_id: itemV1.id,
        chunk_index: 0,
        content: 'Changelog: API v1 is the primary stable interface.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);
    const [chunkV2] = await chunkRepo.createMany([
      {
        item_id: itemV2.id,
        chunk_index: 0,
        content: 'Changelog: API v2 introduces gRPC streaming support.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    const relationalRetrieval = new RetrievalService(
      chunkRepo,
      new MockEmbeddingProvider({
        modelName: 'gemini-embedding-001',
        dimensions: 4,
        generator: () => [1, 0, 0, 0],
      }),
      new DisabledQdrantService()
    );

    const results = await relationalRetrieval.retrieve('API');

    assert.equal(results.length, 2, 'Both chunks must survive relational retrieval because content differs');
    const returnedIds = results.map((r) => r.chunk_id);
    assert.ok(returnedIds.includes(chunkV1.id));
    assert.ok(returnedIds.includes(chunkV2.id));
  });

  test('16. computeContentFingerprint normalizes whitespace without mutating character case or punctuation', () => {
    const original = '  Hello   World!\nThis is a   test.\t\t';
    const normalizedEquivalent = 'Hello World! This is a test.';
    const differentCase = 'hello world! this is a test.';

    const hash1 = computeContentFingerprint(original);
    const hash2 = computeContentFingerprint(normalizedEquivalent);
    const hash3 = computeContentFingerprint(differentCase);

    assert.equal(hash1, hash2, 'Whitespace variations should produce identical fingerprints');
    assert.notEqual(hash1, hash3, 'Character case differences must produce distinct fingerprints');
  });
});
