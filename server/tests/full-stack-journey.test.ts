import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { initSchema } from '../src/db/schema';
import { wrapDatabaseSync } from '../src/db/connection';
import { ItemRepository } from '../src/repositories/item.repository';
import { ChunkRepository } from '../src/repositories/chunk.repository';
import { VectorCleanupRepository } from '../src/repositories/vector-cleanup.repository';
import { MockQdrantService } from '../src/services/qdrant.service';
import { MockEmbeddingProvider } from '../src/services/embedding.service';
import { MockChatProvider } from '../src/services/chat.service';
import { RetrievalService } from '../src/services/retrieval.service';
import { RAGService } from '../src/services/rag.service';
import { IngestionService } from '../src/services/ingestion.service';
import { ChunkingService } from '../src/services/chunking.service';
import { ScraperService } from '../src/services/scraper.service';
import { ItemController } from '../src/controllers/item.controller';

describe('Phase 4: Full-Stack Regression Verification & Complete User Journey', () => {
  let sqliteDb: DatabaseSync;
  let client: any;
  let itemRepo: ItemRepository;
  let chunkRepo: ChunkRepository;
  let cleanupRepo: VectorCleanupRepository;
  let mockQdrant: MockQdrantService;
  let mockEmbeddingProvider: MockEmbeddingProvider;
  let mockChatProvider: MockChatProvider;
  let retrievalService: RetrievalService;
  let ragService: RAGService;
  let ingestionService: IngestionService;
  let itemController: ItemController;
  let scraperService: ScraperService;

  // Track created entities across the journey
  let noteItemId: string;
  let urlItemId: string;

  beforeEach(() => {
    sqliteDb = new DatabaseSync(':memory:');
    initSchema(sqliteDb);
    client = wrapDatabaseSync(sqliteDb);

    itemRepo = new ItemRepository(client);
    chunkRepo = new ChunkRepository(client);
    cleanupRepo = new VectorCleanupRepository(client);
    mockQdrant = new MockQdrantService();

    // 4-dimensional mock embeddings for fast, deterministic vector geometry
    mockEmbeddingProvider = new MockEmbeddingProvider({
      modelName: 'gemini-embedding-001',
      dimensions: 4,
      generator: (text: string) => {
        const lower = text.toLowerCase();
        if (lower.includes('dual persistence') || lower.includes('turso') || lower.includes('architecture')) {
          return [1, 0, 0, 0]; // Architecture vector
        }
        if (lower.includes('quantum') || lower.includes('qubit') || lower.includes('superposition') || lower.includes('algorithms')) {
          return [0, 1, 0, 0]; // Quantum vector
        }
        if (lower.includes('mars') || lower.includes('unanswerable')) {
          return [0, 0, 0, 1]; // Orthogonal vector (0 similarity with indexed knowledge)
        }
        return [0, 0, 1, 0]; // Other content
      },
    });

    retrievalService = new RetrievalService(chunkRepo, mockEmbeddingProvider, mockQdrant);
    mockChatProvider = new MockChatProvider();
    mockChatProvider.setHandler((_sys, user) => {
      if (user.includes('Mars base 3050') || user.includes('secret code')) {
        return {
          answer: 'I could not find sufficient information in your knowledge inbox to answer this question.',
          citedChunkIds: [],
        };
      }
      const chunkIdMatches = user.match(/CHUNK_ID:\s*([a-f0-9-]+)/gi);
      const citedChunkIds: string[] = [];
      if (chunkIdMatches) {
        for (const match of chunkIdMatches) {
          const id = match.replace(/CHUNK_ID:\s*/i, '').trim();
          if (id && !citedChunkIds.includes(id)) {
            citedChunkIds.push(id);
          }
        }
      }
      return {
        answer: 'This is a grounded answer synthesized from the provided knowledge chunks.',
        citedChunkIds,
      };
    });
    ragService = new RAGService(retrievalService, mockChatProvider);

    class DynamicScraper extends ScraperService {
      override async scrape(url: string) {
        if (url.includes('quantum-computing-overview')) {
          return {
            url,
            title: 'Quantum Computing Overview & Qubits',
            content: 'Quantum computing leverages quantum mechanics, including superposition and entanglement of qubits, to perform complex computations.',
            contentType: 'text/html',
          };
        }
        return {
          url,
          title: 'Generic Scraped Page',
          content: 'Generic page content for testing.',
          contentType: 'text/html',
        };
      }
    }

    scraperService = new DynamicScraper();
    const chunkingService = new ChunkingService({ chunkSize: 120, chunkOverlap: 20 });
    ingestionService = new IngestionService(
      itemRepo,
      chunkRepo,
      scraperService,
      chunkingService,
      mockEmbeddingProvider,
      mockQdrant,
      cleanupRepo
    );

    itemController = new ItemController(itemRepo, chunkRepo, mockQdrant, cleanupRepo);
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

  test('Complete 13-Step User Journey Verification', async () => {
    // =========================================================================
    // 1. Start the application: Verify clean initial state
    // =========================================================================
    assert.equal((await itemRepo.findAll()).length, 0);
    assert.equal(mockQdrant.getPointsCount(), 0);
    assert.equal(await cleanupRepo.count(), 0);

    // =========================================================================
    // 2. Add a plain-text note
    // =========================================================================
    const noteResult = await ingestionService.ingest({
      source_type: 'note',
      title: 'Architecture Decision Record: Dual Persistence',
      content: 'Turium AI utilizes Turso Cloud (hosted libSQL) as the Source of Truth and Qdrant Cloud for vector search.',
    });

    assert.ok(noteResult.item.id);
    assert.equal(noteResult.item.title, 'Architecture Decision Record: Dual Persistence');
    assert.equal(noteResult.item.source_type, 'note');
    assert.equal(noteResult.item.status, 'completed');
    assert.ok(noteResult.chunk_count > 0);
    noteItemId = noteResult.item.id;

    // Verify Turso & Qdrant persistence
    const noteInDb = await itemRepo.findById(noteItemId);
    assert.notEqual(noteInDb, null);
    const noteChunks = await chunkRepo.findByItemId(noteItemId);
    assert.equal(noteChunks.length, noteResult.chunk_count);
    assert.equal(mockQdrant.getPointsCount(), noteResult.chunk_count);

    // =========================================================================
    // 3. Ingest a URL
    // =========================================================================
    const urlResult = await ingestionService.ingest({
      source_type: 'url',
      url: 'https://example.com/quantum-computing-overview',
    });

    assert.ok(urlResult.item.id);
    assert.equal(urlResult.item.title, 'Quantum Computing Overview & Qubits');
    assert.equal(urlResult.item.source_type, 'url');
    assert.equal(urlResult.item.status, 'completed');
    assert.ok(urlResult.chunk_count > 0);
    urlItemId = urlResult.item.id;

    // Verify both items now exist
    assert.equal((await itemRepo.findAll()).length, 2);
    const totalExpectedChunks = noteResult.chunk_count + urlResult.chunk_count;
    assert.equal(mockQdrant.getPointsCount(), totalExpectedChunks);

    // =========================================================================
    // 4. View saved items
    // =========================================================================
    const allItems = await itemRepo.findAllSummaries();
    assert.equal(allItems.length, 2);
    // Ordered by created_at DESC: URL item was created second, so it appears first
    assert.equal(allItems[0].id, urlItemId);
    assert.equal(allItems[1].id, noteItemId);
    assert.equal(allItems[0].chunk_count, urlResult.chunk_count);
    assert.equal(allItems[1].chunk_count, noteResult.chunk_count);

    // =========================================================================
    // 5. Ask a global AI question
    // =========================================================================
    const globalAnswer = await ragService.answerQuestion('What is the dual persistence strategy?');
    assert.ok(globalAnswer.answer.length > 0);
    assert.ok(globalAnswer.sources.length > 0);
    // Global retrieval finds the Architecture note
    assert.ok(globalAnswer.sources.some((c) => c.item_id === noteItemId));

    // =========================================================================
    // 6. Ask an item-scoped AI question
    // =========================================================================
    // Querying about quantum computing scoped strictly to urlItemId
    const scopedAnswer = await ragService.answerQuestion('Explain superposition and qubits', {
      itemId: urlItemId,
    });
    assert.ok(scopedAnswer.answer.length > 0);
    assert.ok(scopedAnswer.sources.length > 0);
    // Every single citation MUST belong strictly to the scoped item!
    for (const citation of scopedAnswer.sources) {
      assert.equal(citation.item_id, urlItemId, 'Scoped query must not include other items');
    }

    // =========================================================================
    // 7. Verify source citations
    // =========================================================================
    const firstCitation = scopedAnswer.sources[0];
    assert.ok(firstCitation.chunk_id);
    assert.ok(firstCitation.snippet.includes('superposition') || firstCitation.snippet.includes('qubits'));
    assert.equal(firstCitation.item_title, 'Quantum Computing Overview & Qubits');
    assert.equal(firstCitation.source_url, 'https://example.com/quantum-computing-overview');
    assert.ok(firstCitation.similarity > 0);

    // =========================================================================
    // 8. Verify appropriate abstention when information is unavailable
    // =========================================================================
    const unanswerable = await ragService.answerQuestion('What is the secret code of Mars base 3050?');
    // Low similarity / missing context triggers abstention
    assert.ok(
      unanswerable.answer.includes('not contain enough information') ||
        unanswerable.answer.includes('insufficient information')
    );
    assert.equal(unanswerable.sources.length, 0, 'Abstention response must contain 0 citations');

    // =========================================================================
    // 9. Re-ingest an existing URL and verify in-place updating
    // =========================================================================
    class UpdatedScraper extends ScraperService {
      override async scrape(url: string) {
        return {
          url,
          title: 'Quantum Computing v2: Advanced Algorithms',
          content: 'Updated content: Quantum computing uses Shor and Grover algorithms on entangled qubits.',
          contentType: 'text/html',
        };
      }
    }
    const updateIngestion = new IngestionService(
      itemRepo,
      chunkRepo,
      new UpdatedScraper(),
      new ChunkingService({ chunkSize: 120, chunkOverlap: 20 }),
      mockEmbeddingProvider,
      mockQdrant,
      cleanupRepo
    );

    const reingestResult = await updateIngestion.ingest({
      source_type: 'url',
      url: 'https://example.com/quantum-computing-overview', // Same URL
    });

    // In-place update: ID must remain the same!
    assert.equal(reingestResult.item.id, urlItemId);
    assert.equal(reingestResult.item.title, 'Quantum Computing v2: Advanced Algorithms');
    // Total items must remain 2 (no duplicate record created!)
    assert.equal((await itemRepo.findAll()).length, 2);

    // Chunks replaced cleanly
    const updatedChunks = await chunkRepo.findByItemId(urlItemId);
    assert.ok(updatedChunks[0].content.includes('Shor and Grover'));

    // =========================================================================
    // 10. Verify search and filters
    // =========================================================================
    const currentItems = await itemRepo.findAll();
    // Filter by type: note
    const notesOnly = currentItems.filter((i) => i.source_type === 'note');
    assert.equal(notesOnly.length, 1);
    assert.equal(notesOnly[0].id, noteItemId);

    // Filter by type: url
    const urlsOnly = currentItems.filter((i) => i.source_type === 'url');
    assert.equal(urlsOnly.length, 1);
    assert.equal(urlsOnly[0].id, urlItemId);

    // Search by title text
    const searchMatch = currentItems.filter((i) => i.title?.toLowerCase().includes('advanced'));
    assert.equal(searchMatch.length, 1);
    assert.equal(searchMatch[0].id, urlItemId);

    // =========================================================================
    // 11. Delete an item (Standard deletion HTTP 200)
    // =========================================================================
    const { req: reqDelNote, res: resDelNote, getStatus: getNoteStatus, getBody: getNoteBody } =
      createMockReqRes({ id: noteItemId });

    await itemController.deleteItem(reqDelNote, resDelNote, (err) => {
      if (err) throw err;
    });

    assert.equal(getNoteStatus(), 200);
    assert.equal(getNoteBody().status, 'success');
    assert.equal(getNoteBody().data.database_deleted, true);
    assert.equal(getNoteBody().data.vector_cleanup_completed, true);

    // Verify deleted from Turso and Qdrant
    assert.equal(await itemRepo.findById(noteItemId), null);
    assert.equal((await chunkRepo.findByItemId(noteItemId)).length, 0);
    assert.equal((await itemRepo.findAll()).length, 1); // Only urlItemId remains

    // =========================================================================
    // 12. Verify Ask AI scope clearing after deletion
    // =========================================================================
    // If client was scoped to noteItemId, that item no longer exists.
    // Querying for deleted item chunks returns 0 candidates and abstains
    const postDeleteQuery = await ragService.answerQuestion('What is dual persistence?', {
      itemId: noteItemId, // Scoped to deleted item
    });
    assert.ok(
      postDeleteQuery.answer.includes('not contain enough information') ||
        postDeleteQuery.answer.includes('insufficient information')
    );
    assert.equal(postDeleteQuery.sources.length, 0);

    // =========================================================================
    // 13. Verify partial deletion feedback and durable cleanup recovery
    // =========================================================================
    // Delete the remaining urlItemId while Qdrant deletePoints fails (simulating network outage)
    class OutageQdrantService extends MockQdrantService {
      override async deletePoints(_ids: string[]): Promise<void> {
        throw new Error('Qdrant cluster network timeout (simulated 504)');
      }
    }
    const outageQdrant = new OutageQdrantService();
    const partialController = new ItemController(itemRepo, chunkRepo, outageQdrant, cleanupRepo);

    const { req: reqDelUrl, res: resDelUrl, getStatus: getUrlStatus, getBody: getUrlBody } =
      createMockReqRes({ id: urlItemId });

    await partialController.deleteItem(reqDelUrl, resDelUrl, (err) => {
      if (err) throw err;
    });

    // Partial success response HTTP 207 Multi-Status
    assert.equal(getUrlStatus(), 207);
    assert.equal(getUrlBody().status, 'partial_success');
    assert.equal(getUrlBody().code, 'VECTOR_CLEANUP_PENDING');
    assert.equal(getUrlBody().data.database_deleted, true);
    assert.equal(getUrlBody().data.vector_cleanup_completed, false);

    // Relational records removed from Turso
    assert.equal((await itemRepo.findAll()).length, 0);
    assert.equal((await chunkRepo.findByItemId(urlItemId)).length, 0);

    // Durable pending cleanup records exist in Turso table
    const pendingCleanups = await cleanupRepo.findAll();
    assert.ok(pendingCleanups.length > 0);
    assert.equal(pendingCleanups[0].item_id, urlItemId);

    // Now Qdrant recovers: execute durable retry
    const recoveryResult = await mockQdrant.retryDurableCleanups(cleanupRepo);
    assert.equal(recoveryResult.succeeded, pendingCleanups.length);
    assert.equal(recoveryResult.failed, 0);

    // Database cleanup table is now completely drained
    assert.equal(await cleanupRepo.count(), 0);
  });
});
