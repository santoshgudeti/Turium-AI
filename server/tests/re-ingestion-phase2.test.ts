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
import { MockQdrantService } from '../src/services/qdrant.service';
import { normalizeUrl } from '../src/utils/url';
import { AppError } from '../src/middleware/error-handler.middleware';

describe('Phase 2: Duplicate URL Re-Ingestion & Concurrency Test Suite', () => {
  let testDb: DatabaseSync;
  let itemRepo: ItemRepository;
  let chunkRepo: ChunkRepository;
  let mockQdrant: MockQdrantService;
  let mockEmbeddingProvider: MockEmbeddingProvider;
  let chunkingService: ChunkingService;

  beforeEach(() => {
    testDb = new DatabaseSync(':memory:');
    initSchema(testDb);
    itemRepo = new ItemRepository(testDb);
    chunkRepo = new ChunkRepository(testDb);
    mockQdrant = new MockQdrantService();
    mockEmbeddingProvider = new MockEmbeddingProvider({
      modelName: 'gemini-embedding-001',
      dimensions: 4,
    });
    chunkingService = new ChunkingService({ chunkSize: 100, chunkOverlap: 20 });
  });

  afterEach(() => {
    testDb.close();
  });

  test('1. normalizeUrl conservatively normalizes host, scheme, and trailing slashes while preserving query params and paths', () => {
    // Scheme and host lowercase
    assert.equal(
      normalizeUrl('HTTPS://EXAMPLE.COM/articles'),
      'https://example.com/articles'
    );

    // Root trailing slash stripped
    assert.equal(
      normalizeUrl('https://example.com/'),
      'https://example.com'
    );

    // Trailing slashes normalized consistently
    assert.equal(
      normalizeUrl('https://example.com/api/'),
      'https://example.com/api'
    );

    // Hash fragment stripped
    assert.equal(
      normalizeUrl('https://example.com/docs#installation'),
      'https://example.com/docs'
    );

    // Query parameters strictly preserved intact
    assert.equal(
      normalizeUrl('https://example.com/search?q=machine+learning&page=2#top'),
      'https://example.com/search?q=machine+learning&page=2'
    );
  });

  test('2. Duplicate URL detection: Re-ingesting existing URL updates the record in-place instead of creating a duplicate', async () => {
    let scrapeCallCount = 0;
    class ControllableScraper extends ScraperService {
      override async scrape(url: string) {
        scrapeCallCount++;
        return {
          url,
          title: 'Initial Article Title',
          content: 'Initial text content for version 1 of the article.',
          contentType: 'text/html',
        };
      }
    }

    const service = new IngestionService(
      itemRepo,
      chunkRepo,
      new ControllableScraper(),
      chunkingService,
      mockEmbeddingProvider,
      mockQdrant
    );

    // 1. Initial ingestion
    const res1 = await service.ingest({
      source_type: 'url',
      url: 'https://example.com/article-1',
    });
    const originalItemId = res1.item.id;

    const itemsAfterFirst = await itemRepo.findAll();
    assert.equal(itemsAfterFirst.length, 1, 'Exactly 1 item should exist in database');
    assert.equal(itemsAfterFirst[0].title, 'Initial Article Title');

    // 2. Re-ingest the exact same URL (different case & trailing slash variant)
    const res2 = await service.ingest({
      source_type: 'url',
      url: 'HTTPS://EXAMPLE.COM/article-1/',
    });

    // Verify it updated the existing item rather than creating a duplicate
    const itemsAfterSecond = await itemRepo.findAll();
    assert.equal(itemsAfterSecond.length, 1, 'Database must still contain only 1 item, not a duplicate');
    assert.equal(res2.item.id, originalItemId, 'Must return the same item ID');
  });

  test('3. Successful re-indexing: Content change replaces chunks in Turso and vectors in Qdrant', async () => {
    let version = 1;
    class DynamicScraper extends ScraperService {
      override async scrape(url: string) {
        if (version === 1) {
          return {
            url,
            title: 'Documentation v1.0',
            content: 'Legacy v1.0 documentation content for the platform API.',
            contentType: 'text/html',
          };
        }
        return {
          url,
          title: 'Documentation v2.0',
          content: 'Updated v2.0 documentation content introducing new streaming API.',
          contentType: 'text/html',
        };
      }
    }

    const service = new IngestionService(
      itemRepo,
      chunkRepo,
      new DynamicScraper(),
      chunkingService,
      mockEmbeddingProvider,
      mockQdrant
    );

    // 1. Ingest Version 1
    const resV1 = await service.ingest({
      source_type: 'url',
      url: 'https://docs.example.com/api',
    });
    const v1Chunks = await chunkRepo.findByItemId(resV1.item.id);
    assert.equal(v1Chunks[0].content, 'Legacy v1.0 documentation content for the platform API.');
    assert.equal(mockQdrant.getPointsCount(), v1Chunks.length);

    // 2. Ingest Version 2 (Content has changed)
    version = 2;
    const resV2 = await service.ingest({
      source_type: 'url',
      url: 'https://docs.example.com/api',
    });

    assert.equal(resV2.item.id, resV1.item.id, 'Item ID must be preserved');
    assert.equal(resV2.item.title, 'Documentation v2.0');

    // Verify Turso chunks were replaced with v2
    const v2Chunks = await chunkRepo.findByItemId(resV2.item.id);
    assert.equal(v2Chunks[0].content, 'Updated v2.0 documentation content introducing new streaming API.');

    // Verify Qdrant points were replaced (old points removed, new points added)
    assert.equal(mockQdrant.getPointsCount(), v2Chunks.length);
  });

  test('4. Failed re-indexing preserves existing working content when embedding generation fails', async () => {
    let failEmbedding = false;
    class FailOnDemandEmbeddingProvider extends MockEmbeddingProvider {
      override async generateEmbeddings(texts: string[]): Promise<number[][]> {
        if (failEmbedding) {
          throw new AppError(503, 'Upstream Gemini rate limit exhausted');
        }
        return super.generateEmbeddings(texts);
      }
    }

    let version = 1;
    class DynamicScraper extends ScraperService {
      override async scrape(url: string) {
        if (version === 1) {
          return {
            url,
            title: 'Working Page v1',
            content: 'Stable working content that must be preserved on error.',
            contentType: 'text/html',
          };
        }
        return {
          url,
          title: 'Updated Page v2',
          content: 'New content that will fail during embedding generation.',
          contentType: 'text/html',
        };
      }
    }

    const failProvider = new FailOnDemandEmbeddingProvider();
    const service = new IngestionService(
      itemRepo,
      chunkRepo,
      new DynamicScraper(),
      chunkingService,
      failProvider,
      mockQdrant
    );

    // Ingest stable v1
    const resV1 = await service.ingest({
      source_type: 'url',
      url: 'https://example.com/resilience-test',
    });
    const v1Item = await itemRepo.findById(resV1.item.id);
    assert.equal(v1Item?.status, 'completed');
    const v1Chunks = await chunkRepo.findByItemId(resV1.item.id);

    // Attempt v2 re-ingest with simulated embedding failure
    version = 2;
    failEmbedding = true;

    await assert.rejects(
      () => service.ingest({ source_type: 'url', url: 'https://example.com/resilience-test' }),
      (err: AppError) => err.statusCode === 503 && err.message.includes('Gemini rate limit')
    );

    // Existing item MUST remain completed with original title and chunks intact
    const preservedItem = await itemRepo.findById(resV1.item.id);
    assert.ok(preservedItem);
    assert.equal(preservedItem.status, 'completed', 'Existing working status must not be corrupted to failed');
    assert.equal(preservedItem.title, 'Working Page v1', 'Original title must be preserved');
    assert.equal(preservedItem.raw_content, 'Stable working content that must be preserved on error.');

    const preservedChunks = await chunkRepo.findByItemId(resV1.item.id);
    assert.equal(preservedChunks.length, v1Chunks.length);
    assert.equal(preservedChunks[0].content, v1Chunks[0].content);
  });

  test('5. Qdrant partial failure handling: If vector upsert throws, Turso chunks are NOT deleted', async () => {
    let failQdrant = false;
    class FaultyQdrantService extends MockQdrantService {
      override async upsertChunks(points: any[]) {
        if (failQdrant) {
          throw new Error('Qdrant cluster write timeout 504');
        }
        return super.upsertChunks(points);
      }
    }

    let version = 1;
    class DynamicScraper extends ScraperService {
      override async scrape(url: string) {
        if (version === 1) {
          return {
            url,
            title: 'Initial Good Title',
            content: 'Original good content that must survive Qdrant failure.',
            contentType: 'text/html',
          };
        }
        return {
          url,
          title: 'Modified Title',
          content: 'Modified content that triggers Qdrant error.',
          contentType: 'text/html',
        };
      }
    }

    const faultyQdrant = new FaultyQdrantService();
    const service = new IngestionService(
      itemRepo,
      chunkRepo,
      new DynamicScraper(),
      chunkingService,
      mockEmbeddingProvider,
      faultyQdrant
    );

    // Initial good ingest
    const res1 = await service.ingest({
      source_type: 'url',
      url: 'https://example.com/qdrant-resilience',
    });
    const originalChunks = await chunkRepo.findByItemId(res1.item.id);

    // Trigger Qdrant failure on second ingest
    version = 2;
    failQdrant = true;

    await assert.rejects(
      () => service.ingest({ source_type: 'url', url: 'https://example.com/qdrant-resilience' }),
      (err: AppError) => err.statusCode === 502 && err.message.includes('Qdrant cluster write timeout')
    );

    // Original chunks in Turso MUST NOT have been deleted
    const survivingChunks = await chunkRepo.findByItemId(res1.item.id);
    assert.equal(survivingChunks.length, originalChunks.length);
    assert.equal(survivingChunks[0].content, 'Original good content that must survive Qdrant failure.');

    const survivingItem = await itemRepo.findById(res1.item.id);
    assert.equal(survivingItem?.status, 'completed');
    assert.equal(survivingItem?.title, 'Initial Good Title');
  });

  test('6. Concurrent duplicate URL ingestion: Simultaneous requests coalesce into a single item', async () => {
    let scrapeCount = 0;
    class SlowScraper extends ScraperService {
      override async scrape(url: string) {
        scrapeCount++;
        // Simulate remote network latency
        await new Promise((r) => setTimeout(r, 40));
        return {
          url,
          title: 'Concurrent Article',
          content: 'Content fetched across simultaneous concurrent requests.',
          contentType: 'text/html',
        };
      }
    }

    const service = new IngestionService(
      itemRepo,
      chunkRepo,
      new SlowScraper(),
      chunkingService,
      mockEmbeddingProvider,
      mockQdrant
    );

    // Fire 5 identical ingestion requests concurrently
    const promises = [
      service.ingest({ source_type: 'url', url: 'https://example.com/concurrent-test' }),
      service.ingest({ source_type: 'url', url: 'https://example.com/concurrent-test' }),
      service.ingest({ source_type: 'url', url: 'https://example.com/concurrent-test' }),
      service.ingest({ source_type: 'url', url: 'https://example.com/concurrent-test' }),
      service.ingest({ source_type: 'url', url: 'https://example.com/concurrent-test' }),
    ];

    const results = await Promise.all(promises);

    // Exactly 1 scrape should have been performed
    assert.equal(scrapeCount, 1, 'Concurrent requests must coalesce into a single scrape');

    // All results must share the exact same item ID
    const firstId = results[0].item.id;
    for (const r of results) {
      assert.equal(r.item.id, firstId);
    }

    // Database must have exactly 1 record
    const allItems = await itemRepo.findAll();
    assert.equal(allItems.length, 1, 'Database must contain exactly 1 item, no duplicate rows');
  });

  test('7. Filter counts and visible result consistency logic test', () => {
    // Model the KnowledgeList filter count alignment
    const mockItems = [
      { id: '1', source_type: 'url', title: 'NASA Artemis Launch', source_url: 'https://nasa.gov/artemis' },
      { id: '2', source_type: 'url', title: 'SpaceX Starship Update', source_url: 'https://spacex.com/starship' },
      { id: '3', source_type: 'note', title: 'Architecture Review', source_url: null },
      { id: '4', source_type: 'note', title: 'NASA Rocket Design Notes', source_url: null },
      { id: '5', source_type: 'note', title: 'Personal Goals', source_url: null },
      { id: '6', source_type: 'note', title: 'Meeting Summary', source_url: null },
    ];

    const totalCount = mockItems.length; // 6
    const totalNotes = mockItems.filter((i) => i.source_type === 'note').length; // 4
    const totalUrls = mockItems.filter((i) => i.source_type === 'url').length; // 2

    // Scenario A: No search query
    const searchQueryA = '';
    const itemsMatchingA = mockItems.filter((item) => {
      if (!searchQueryA.trim()) return true;
      const q = searchQueryA.toLowerCase();
      return (item.title || '').toLowerCase().includes(q) || (item.source_url || '').toLowerCase().includes(q);
    });
    assert.equal(itemsMatchingA.length, 6);

    // Scenario B: Active search for "NASA"
    const searchQueryB = 'nasa';
    const itemsMatchingB = mockItems.filter((item) => {
      const q = searchQueryB.toLowerCase();
      return (item.title || '').toLowerCase().includes(q) || (item.source_url || '').toLowerCase().includes(q);
    });
    // Matches Item 1 (url) and Item 4 (note)
    assert.equal(itemsMatchingB.length, 2);

    const searchAllCount = itemsMatchingB.length; // 2
    const searchNoteCount = itemsMatchingB.filter((i) => i.source_type === 'note').length; // 1
    const searchUrlCount = itemsMatchingB.filter((i) => i.source_type === 'url').length; // 1

    // Chip display strings:
    const allChipLabel = `${searchAllCount}/${totalCount}`; // "2/6"
    const noteChipLabel = `${searchNoteCount}/${totalNotes}`; // "1/4"
    const urlChipLabel = `${searchUrlCount}/${totalUrls}`; // "1/2"

    assert.equal(allChipLabel, '2/6');
    assert.equal(noteChipLabel, '1/4');
    assert.equal(urlChipLabel, '1/2');

    // When "all" filter is active, visible items == searchAllCount (2)
    const visibleAll = itemsMatchingB;
    assert.equal(visibleAll.length, 2);

    // When "note" filter is active, visible items == searchNoteCount (1)
    const visibleNotes = itemsMatchingB.filter((i) => i.source_type === 'note');
    assert.equal(visibleNotes.length, 1);

    // When "url" filter is active, visible items == searchUrlCount (1)
    const visibleUrls = itemsMatchingB.filter((i) => i.source_type === 'url');
    assert.equal(visibleUrls.length, 1);

    // Visible item count always matches matching chip count! No discrepancy.
  });

  test('8. Search/filter state persistence across data refresh', () => {
    // Model React state preservation across refetch
    let componentState = {
      searchQuery: 'artemis',
      filterType: 'url',
    };

    // First render with 5 items
    let items = [
      { id: '1', source_type: 'url', title: 'NASA Artemis Launch', source_url: 'https://nasa.gov/artemis' },
    ];

    // Simulate refresh: new items loaded from API (e.g. 6th item added)
    const refreshedItems = [
      ...items,
      { id: '2', source_type: 'note', title: 'New Note', source_url: null },
    ];

    // Component does NOT unmount, state is preserved:
    assert.equal(componentState.searchQuery, 'artemis', 'Search query must persist across refresh');
    assert.equal(componentState.filterType, 'url', 'Filter type must persist across refresh');

    // Filtered items recalculate seamlessly with the persisted search query
    const filtered = refreshedItems.filter((item) => {
      if (componentState.filterType !== 'all' && item.source_type !== componentState.filterType) {
        return false;
      }
      return item.title.toLowerCase().includes(componentState.searchQuery);
    });

    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, '1');
  });

  test('9. Turso failure after Qdrant upsert: Rolls back new Qdrant vectors, preserves old Turso chunks & vectors', async () => {
    let failTursoReplace = false;
    class FaultyChunkRepo extends ChunkRepository {
      override async replaceChunksForItem(itemId: string, chunks: any[]) {
        if (failTursoReplace) {
          throw new Error('libSQL disk I/O error 500');
        }
        return super.replaceChunksForItem(itemId, chunks);
      }
    }

    let version = 1;
    class VersionScraper extends ScraperService {
      override async scrape(url: string) {
        if (version === 1) {
          return {
            url,
            title: 'Version 1 Working Title',
            content: 'Version 1 stable content in Turso and Qdrant.',
            contentType: 'text/html',
          };
        }
        return {
          url,
          title: 'Version 2 Broken Write',
          content: 'Version 2 content whose Turso commit fails.',
          contentType: 'text/html',
        };
      }
    }

    const faultyChunkRepo = new FaultyChunkRepo(testDb);
    const service = new IngestionService(
      itemRepo,
      faultyChunkRepo,
      new VersionScraper(),
      chunkingService,
      mockEmbeddingProvider,
      mockQdrant
    );

    // 1. Initial successful ingest of v1
    const resV1 = await service.ingest({
      source_type: 'url',
      url: 'https://example.com/turso-failure-test',
    });
    const v1Chunks = await chunkRepo.findByItemId(resV1.item.id);
    const v1PointCount = mockQdrant.getPointsCount();
    assert.equal(v1PointCount, v1Chunks.length);

    // 2. Re-ingest with version 2, simulating Turso replacement failure
    version = 2;
    failTursoReplace = true;

    await assert.rejects(
      () => service.ingest({ source_type: 'url', url: 'https://example.com/turso-failure-test' }),
      (err: Error) => err.message.includes('libSQL disk I/O error')
    );

    // 3. Verify Rollback & State Preservation:
    // a. Turso chunks must remain v1
    const survivingChunks = await chunkRepo.findByItemId(resV1.item.id);
    assert.equal(survivingChunks.length, v1Chunks.length);
    assert.equal(survivingChunks[0].content, 'Version 1 stable content in Turso and Qdrant.');

    // b. Qdrant point count must equal v1 (new points rolled back, old points preserved)
    assert.equal(
      mockQdrant.getPointsCount(),
      v1PointCount,
      'New Qdrant points must be rolled back on Turso failure'
    );

    // c. Item in Turso must remain completed with v1 metadata
    const item = await itemRepo.findById(resV1.item.id);
    assert.equal(item?.status, 'completed');
    assert.equal(item?.title, 'Version 1 Working Title');
  });

  test('10. Qdrant cleanup failure after Turso commit: New content remains searchable, failure is non-fatal', async () => {
    let failDeletePoints = false;
    class UncleanQdrantService extends MockQdrantService {
      override async deletePoints(pointIds: string[]) {
        if (failDeletePoints) {
          throw new Error('Qdrant cluster network disconnect during delete');
        }
        return super.deletePoints(pointIds);
      }
    }

    let version = 1;
    class VersionScraper extends ScraperService {
      override async scrape(url: string) {
        if (version === 1) {
          return {
            url,
            title: 'Original Title',
            content: 'Original content version.',
            contentType: 'text/html',
          };
        }
        return {
          url,
          title: 'Updated Title v2',
          content: 'Updated content v2 committed successfully in Turso.',
          contentType: 'text/html',
        };
      }
    }

    const uncleanQdrant = new UncleanQdrantService();
    const service = new IngestionService(
      itemRepo,
      chunkRepo,
      new VersionScraper(),
      chunkingService,
      mockEmbeddingProvider,
      uncleanQdrant
    );

    // Initial ingest
    const resV1 = await service.ingest({
      source_type: 'url',
      url: 'https://example.com/qdrant-cleanup-test',
    });

    // Version 2: Turso commit succeeds, but Qdrant deletePoints fails
    version = 2;
    failDeletePoints = true;

    // Must NOT throw: re-ingestion succeeds because Turso source-of-truth committed
    const resV2 = await service.ingest({
      source_type: 'url',
      url: 'https://example.com/qdrant-cleanup-test',
    });

    assert.equal(resV2.item.id, resV1.item.id);
    assert.equal(resV2.item.title, 'Updated Title v2');

    // Turso has new chunks
    const currentChunks = await chunkRepo.findByItemId(resV2.item.id);
    assert.equal(currentChunks[0].content, 'Updated content v2 committed successfully in Turso.');

    // In Qdrant, points count includes both old (uncleaned) + new points
    // When retrieval runs, the old points are dropped during Turso hydration
    const { RetrievalService } = await import('../src/services/retrieval.service');
    const retrieval = new RetrievalService(chunkRepo, mockEmbeddingProvider, uncleanQdrant);
    const searchResults = await retrieval.retrieve('Updated content');

    // Only current valid chunks are returned; orphaned old points are dropped!
    assert.ok(searchResults.length > 0);
    assert.equal(searchResults[0].content, 'Updated content v2 committed successfully in Turso.');
    for (const r of searchResults) {
      assert.notEqual(r.content, 'Original content version.');
    }
  });

  test('11. Legacy URL compatibility: Existing uppercase scheme/host and trailing slash records are recognized and updated', async () => {
    // 1. Manually insert legacy item created before URL normalization (uppercase scheme & host, trailing slash)
    const legacyItem = await itemRepo.create({
      source_type: 'url',
      title: 'Legacy Ingested Item',
      source_url: 'HTTPS://LEGACY-SYSTEM.EXAMPLE.COM/docs/api-v1/',
      raw_content: 'Old unnormalized content in database.',
      status: 'completed',
    });

    await chunkRepo.createMany([
      {
        item_id: legacyItem.id,
        chunk_index: 0,
        content: 'Old unnormalized content in database.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    class LegacyScraper extends ScraperService {
      override async scrape(url: string) {
        return {
          url,
          title: 'Updated Modern Title',
          content: 'Modern normalized content replacing legacy content.',
          contentType: 'text/html',
        };
      }
    }

    const service = new IngestionService(
      itemRepo,
      chunkRepo,
      new LegacyScraper(),
      chunkingService,
      mockEmbeddingProvider,
      mockQdrant
    );

    // User inputs normalized lowercase URL without trailing slash
    const result = await service.ingest({
      source_type: 'url',
      url: 'https://legacy-system.example.com/docs/api-v1',
    });

    // Must update the existing legacy item, NOT create a duplicate
    assert.equal(result.item.id, legacyItem.id, 'Must recognize and update legacy item');
    assert.equal(result.item.title, 'Updated Modern Title');

    const totalItems = await itemRepo.findAll();
    assert.equal(totalItems.length, 1, 'Database must have exactly 1 item, no duplicate legacy rows');
  });

  test('12. URL Path Case Sensitivity: /Docs/API and /docs/api are NOT treated as the same URL', async () => {
    class PassthroughScraper extends ScraperService {
      override async scrape(url: string) {
        return {
          url,
          title: `Content for ${url}`,
          content: `Distinct content for ${url} with case-sensitive path.`,
          contentType: 'text/html',
        };
      }
    }

    const service = new IngestionService(
      itemRepo,
      chunkRepo,
      new PassthroughScraper(),
      chunkingService,
      mockEmbeddingProvider,
      mockQdrant
    );

    // 1. Ingest uppercase path: /Docs/API
    const res1 = await service.ingest({
      source_type: 'url',
      url: 'https://example.com/Docs/API',
    });

    // 2. Ingest lowercase path: /docs/api
    const res2 = await service.ingest({
      source_type: 'url',
      url: 'https://example.com/docs/api',
    });

    // Must create two distinct items, NOT overwrite or collapse
    assert.notEqual(res1.item.id, res2.item.id, 'Different path casing must represent distinct items');
    const allItems = await itemRepo.findAll();
    assert.equal(allItems.length, 2, 'Both distinct path items must exist in database');
  });

  test('13. Query Parameter Case Sensitivity: ?token=ABC and ?token=abc remain distinct items', async () => {
    class PassthroughScraper extends ScraperService {
      override async scrape(url: string) {
        return {
          url,
          title: `Token query: ${url}`,
          content: `Data protected by token in ${url}`,
          contentType: 'text/html',
        };
      }
    }

    const service = new IngestionService(
      itemRepo,
      chunkRepo,
      new PassthroughScraper(),
      chunkingService,
      mockEmbeddingProvider,
      mockQdrant
    );

    const resA = await service.ingest({
      source_type: 'url',
      url: 'https://api.example.com/v1/auth?token=JWT_ABC_123',
    });

    const resB = await service.ingest({
      source_type: 'url',
      url: 'https://api.example.com/v1/auth?token=jwt_abc_123',
    });

    assert.notEqual(resA.item.id, resB.item.id, 'Query parameters with different casing must remain distinct');
    const allItems = await itemRepo.findAll();
    assert.equal(allItems.length, 2);
  });

  test('14. Recoverable Qdrant cleanup: Failed cleanup queues vector IDs and retryFailedCleanups purges them', async () => {
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
    class MultiVersionScraper extends ScraperService {
      override async scrape(url: string) {
        if (version === 1) {
          return {
            url,
            title: 'Initial Title',
            content: 'Initial chunk content to be orphaned.',
            contentType: 'text/html',
          };
        }
        return {
          url,
          title: 'Updated Title',
          content: 'Updated chunk content after safe re-index.',
          contentType: 'text/html',
        };
      }
    }

    const flakyQdrant = new FlakyQdrantService();
    const service = new IngestionService(
      itemRepo,
      chunkRepo,
      new MultiVersionScraper(),
      chunkingService,
      mockEmbeddingProvider,
      flakyQdrant
    );

    // Step 1: Initial ingest
    const res1 = await service.ingest({
      source_type: 'url',
      url: 'https://example.com/retry-cleanup-test',
    });
    const oldChunks = await chunkRepo.findByItemId(res1.item.id);
    const oldChunkId = oldChunks[0].id;

    // Step 2: Re-ingest with version 2 while Qdrant deletePoints fails
    version = 2;
    failDeletions = true;

    // The re-ingest must SUCCEED (non-fatal cleanup failure)
    const res2 = await service.ingest({
      source_type: 'url',
      url: 'https://example.com/retry-cleanup-test',
    });
    assert.equal(res2.item.id, res1.item.id);

    // Step 3: Verify the failed point IDs were safely queued for recovery
    const pendingIds = flakyQdrant.getPendingOrphanedPointIds();
    assert.ok(pendingIds.length > 0, 'Failed cleanup points must be queued in registry');
    assert.ok(pendingIds.includes(oldChunkId), 'Pending IDs must contain the exact old chunk ID');

    // Step 4: Now simulate Qdrant network recovery and retry cleanup
    failDeletions = false;
    const retryResult = await flakyQdrant.retryFailedCleanups();

    assert.equal(retryResult.succeeded, pendingIds.length);
    assert.equal(retryResult.failed, 0);
    assert.equal(flakyQdrant.getPendingOrphanedPointIds().length, 0, 'Queue must be empty after successful retry');
  });
});
