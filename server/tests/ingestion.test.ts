import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../src/db/schema';
import { ItemRepository } from '../src/repositories/item.repository';
import { ChunkRepository } from '../src/repositories/chunk.repository';
import { IngestionService } from '../src/services/ingestion.service';
import { ScraperService } from '../src/services/scraper.service';
import { ChunkingService } from '../src/services/chunking.service';
import { MockEmbeddingProvider } from '../src/services/embedding.service';
import { IngestRequestSchema } from '../src/schemas/ingest.schema';
import { AppError } from '../middleware/error-handler.middleware';
import { MockQdrantService } from '../src/services/qdrant.service';

describe('Ingestion & Items Processing Integration Test Suite', () => {
  let testDb: DatabaseSync;
  let itemRepo: ItemRepository;
  let chunkRepo: ChunkRepository;
  let scraperService: ScraperService;
  let chunkingService: ChunkingService;
  let ingestionService: IngestionService;
  let mockQdrant: MockQdrantService;

  beforeEach(() => {
    // 1. Initialize isolated in-memory test database for each test
    testDb = new DatabaseSync(':memory:');
    initSchema(testDb);

    itemRepo = new ItemRepository(testDb);
    chunkRepo = new ChunkRepository(testDb);

    // 2. Mock scraper service for deterministic offline testing
    class MockScraperService extends ScraperService {
      async scrape(url: string) {
        if (
          url.includes('localhost') ||
          url.includes('127.0.0.1') ||
          url.includes('169.254.') ||
          url.includes('192.168.')
        ) {
          await super.validateTargetUrl(url); // triggers actual SSRF guard
        }

        if (url.includes('empty-content')) {
          return super.extractReadableContent('<html><body></body></html>', url);
        }

        return {
          url,
          title: 'Turium AI Platform Documentation',
          content:
            'Turium AI provides minimal and robust RAG infrastructure for modern enterprise teams. ' +
            'This content is extracted and chunked into deterministic semantic blocks for retrieval.',
          contentType: 'text/html',
        };
      }
    }

    scraperService = new MockScraperService();
    chunkingService = new ChunkingService({ chunkSize: 80, chunkOverlap: 15 });
    const mockEmbeddingProvider = new MockEmbeddingProvider();
    mockQdrant = new MockQdrantService();
    ingestionService = new IngestionService(
      itemRepo,
      chunkRepo,
      scraperService,
      chunkingService,
      mockEmbeddingProvider,
      mockQdrant
    );
  });

  afterEach(() => {
    testDb.close();
  });

  test('1. Ingesting a valid plain text note creates an item and chunks with status completed', async () => {
    const input = {
      source_type: 'note' as const,
      title: 'Interview Preparation',
      content:
        'Turium AI assignment emphasizes clarity, separation of concerns, and error handling. ' +
        'This note must be stored in the database with multiple linked chunks.',
    };

    const validated = IngestRequestSchema.parse(input);
    const result = await ingestionService.ingest(validated);

    assert.ok(result.item.id);
    assert.equal(result.item.source_type, 'note');
    assert.equal(result.item.title, 'Interview Preparation');
    assert.equal(result.item.status, 'completed');
    assert.ok(result.chunk_count >= 2);

    // Verify database persistence
    const savedItem = await itemRepo.findById(result.item.id);
    assert.ok(savedItem);
    assert.equal(savedItem.status, 'completed');

    const savedChunks = await chunkRepo.findByItemId(result.item.id);
    assert.equal(savedChunks.length, result.chunk_count);
    assert.equal(savedChunks[0].chunk_index, 0);
    assert.equal(savedChunks[1].chunk_index, 1);
    assert.ok(savedChunks[0].embedding, 'Embedding should be generated and persisted');
    assert.equal(savedChunks[0].embedding_model, 'gemini-embedding-001');
    assert.equal(savedChunks[0].embedding_dimensions, 1536);
  });

  test('2. Ingesting note with empty or whitespace content fails Zod schema validation', () => {
    assert.throws(
      () => {
        IngestRequestSchema.parse({
          source_type: 'note',
          title: 'Empty Content Note',
          content: '   ',
        });
      },
      (err: Error) => err.message.includes('Note content cannot be empty')
    );
  });

  test('3. Ingesting note missing content or source_type fails Zod schema validation', () => {
    assert.throws(() => {
      IngestRequestSchema.parse({
        title: 'Missing source type',
      });
    });

    assert.throws(() => {
      IngestRequestSchema.parse({
        source_type: 'note',
      });
    });
  });

  test('4. Ingesting note with content exceeding length limit fails validation', () => {
    assert.throws(() => {
      IngestRequestSchema.parse({
        source_type: 'note',
        content: 'A'.repeat(100_001),
      });
    });
  });

  test('5. SSRF Guard rejects localhost, loopback, and private IPs before fetching', async () => {
    const maliciousUrls = [
      'http://localhost:8080/admin',
      'http://127.0.0.1:4000/metrics',
      'http://169.254.169.254/latest/meta-data',
      'http://192.168.1.1/router',
    ];

    for (const url of maliciousUrls) {
      await assert.rejects(
        () => ingestionService.ingest({ source_type: 'url', url }),
        (err: AppError) => err.statusCode === 400
      );
    }
  });

  test('6. Ingesting a valid URL extracts content, creates item, and stores chunks', async () => {
    const input = {
      source_type: 'url' as const,
      url: 'https://docs.turium.ai/platform/overview',
    };

    const validated = IngestRequestSchema.parse(input);
    const result = await ingestionService.ingest(validated);

    assert.ok(result.item.id);
    assert.equal(result.item.source_type, 'url');
    assert.equal(result.item.title, 'Turium AI Platform Documentation');
    assert.equal(result.item.source_url, 'https://docs.turium.ai/platform/overview');
    assert.equal(result.item.status, 'completed');
    assert.ok(result.chunk_count >= 1);

    // Verify database persistence
    const savedChunks = await chunkRepo.findByItemId(result.item.id);
    assert.equal(savedChunks.length, result.chunk_count);
  });

  test('7. Ingestion failure marks item status as failed in database', async () => {
    // Force a chunking failure by mocking chunkText to throw
    const faultyChunkingService = new ChunkingService();
    faultyChunkingService.chunkText = () => {
      throw new Error('Unexpected chunking engine error');
    };

    const faultyIngestion = new IngestionService(
      itemRepo,
      chunkRepo,
      scraperService,
      faultyChunkingService,
      undefined,
      mockQdrant
    );

    await assert.rejects(
      () =>
        faultyIngestion.ingest({
          source_type: 'note',
          title: 'Faulty Task',
          content: 'This will trigger an error during chunking.',
        }),
      (err: Error) => err.message.includes('Unexpected chunking engine error')
    );

    // Verify item was created and marked 'failed'
    const items = await itemRepo.findAll();
    assert.equal(items.length, 1);
    assert.equal(items[0].status, 'failed');
  });

  test('8. ItemRepository.findAllSummaries returns item list with chunk counts and excludes raw_content', async () => {
    await ingestionService.ingest({
      source_type: 'note',
      title: 'Item 1',
      content: 'Short content for item 1.',
    });

    await new Promise((r) => setTimeout(r, 10));

    await ingestionService.ingest({
      source_type: 'url',
      url: 'https://turium.ai/about',
    });

    const summaries = await itemRepo.findAllSummaries();
    assert.equal(summaries.length, 2);

    // Newest first
    assert.equal(summaries[0].source_type, 'url');
    assert.equal(summaries[1].source_type, 'note');

    // Has chunk counts
    assert.ok(summaries[0].chunk_count > 0);
    assert.ok(summaries[1].chunk_count > 0);

    // raw_content is excluded from summary
    assert.equal((summaries[0] as unknown as { raw_content?: string }).raw_content, undefined);
  });

  test('9. ChunkRepository.findAllForRetrieval returns chunks enriched with parent item metadata', async () => {
    const res = await ingestionService.ingest({
      source_type: 'url',
      url: 'https://turium.ai/docs',
    });

    const retrievalChunks = await chunkRepo.findAllForRetrieval();
    assert.ok(retrievalChunks.length >= 1);

    const match = retrievalChunks.find((c) => c.item_id === res.item.id);
    assert.ok(match);
    assert.equal(match.item_title, 'Turium AI Platform Documentation');
    assert.equal(match.item_source_url, 'https://turium.ai/docs');
    assert.equal(match.item_source_type, 'url');
  });

  test('10. Deleting parent item cascades deletion to all chunks', async () => {
    const res = await ingestionService.ingest({
      source_type: 'note',
      title: 'Note to be deleted',
      content: 'This note and all its chunks will be deleted.',
    });

    assert.ok((await chunkRepo.findByItemId(res.item.id)).length > 0);

    const deleted = await itemRepo.delete(res.item.id);
    assert.equal(deleted, true);

    assert.equal(await itemRepo.findById(res.item.id), null);
    assert.equal((await chunkRepo.findByItemId(res.item.id)).length, 0);
  });
});
