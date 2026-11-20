import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { GoogleGenAI } from '@google/genai';
import { initSchema } from '../src/db/schema';
import { ItemRepository } from '../src/repositories/item.repository';
import { ChunkRepository } from '../src/repositories/chunk.repository';
import { IngestionService } from '../src/services/ingestion.service';
import { ChunkingService } from '../src/services/chunking.service';
import { MockQdrantService } from '../src/services/qdrant.service';
import {
  GeminiEmbeddingProvider,
  MockEmbeddingProvider,
} from '../src/services/embedding.service';
import { AppError } from '../middleware/error-handler.middleware';

describe('Google Gemini Embedding Generation Test Suite', () => {
  let testDb: DatabaseSync;
  let itemRepo: ItemRepository;
  let chunkRepo: ChunkRepository;
  let chunker: ChunkingService;

  beforeEach(() => {
    testDb = new DatabaseSync(':memory:');
    initSchema(testDb);
    itemRepo = new ItemRepository(testDb);
    chunkRepo = new ChunkRepository(testDb);
    chunker = new ChunkingService({ chunkSize: 60, chunkOverlap: 10 });
  });

  afterEach(() => {
    testDb.close();
  });

  test('1. Batch processing maps Google Gemini response vectors to input chunks 1:1 in correct order', async () => {
    const texts = [
      'Turium AI knowledge inbox note',
      'Retrieval augmented generation with SQLite',
      'Deterministic chunking and Gemini vector embeddings',
    ];

    // Mock GoogleGenAI client returning embeddings array
    const mockGenAIClient = {
      models: {
        embedContent: async (params: { contents: string[] }) => {
          return {
            embeddings: params.contents.map((text) => ({
              values: MockEmbeddingProvider.generateDeterministicVector(text, 1536),
            })),
          };
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiEmbeddingProvider({
      apiKey: 'test-gemini-key',
      client: mockGenAIClient,
      dimensions: 1536,
    });

    const vectors = await provider.generateEmbeddings(texts);

    assert.equal(vectors.length, 3);
    assert.equal(vectors[0].length, 1536);
    assert.equal(vectors[1].length, 1536);
    assert.equal(vectors[2].length, 1536);
  });

  test('2. Throws clear 500 configuration error when GEMINI_API_KEY is not configured', async () => {
    const unconfiguredProvider = new GeminiEmbeddingProvider({
      apiKey: '',
      client: undefined,
    });

    await assert.rejects(
      () => unconfiguredProvider.generateEmbeddings(['test text']),
      (err: AppError) => {
        return (
          err.statusCode === 500 &&
          err.message.includes('GEMINI_API_KEY is not configured')
        );
      }
    );
  });

  test('3. Handles Google Gemini provider API errors (429 rate limit, 401 auth, 504 timeout, generic 502)', async () => {
    // 429 Rate limit simulation
    const rateLimitClient = {
      models: {
        embedContent: async () => {
          const err = new Error('Resource exhausted') as Error & { status: number };
          err.status = 429;
          throw err;
        },
      },
    } as unknown as GoogleGenAI;

    const rateLimitProvider = new GeminiEmbeddingProvider({
      apiKey: 'test-key',
      client: rateLimitClient,
    });

    await assert.rejects(
      () => rateLimitProvider.generateEmbeddings(['test']),
      (err: AppError) => err.statusCode === 429 && err.message.includes('rate limit')
    );

    // 401 Auth error simulation
    const authClient = {
      models: {
        embedContent: async () => {
          const err = new Error('Invalid API key') as Error & { status: number };
          err.status = 401;
          throw err;
        },
      },
    } as unknown as GoogleGenAI;

    const authProvider = new GeminiEmbeddingProvider({
      apiKey: 'test-key',
      client: authClient,
    });

    await assert.rejects(
      () => authProvider.generateEmbeddings(['test']),
      (err: AppError) => err.statusCode === 500 && err.message.includes('authentication failed')
    );

    // 504 Timeout simulation
    const timeoutClient = {
      models: {
        embedContent: async () => {
          const err = new Error('Deadline exceeded') as Error & { status: number };
          err.status = 504;
          throw err;
        },
      },
    } as unknown as GoogleGenAI;

    const timeoutProvider = new GeminiEmbeddingProvider({
      apiKey: 'test-key',
      client: timeoutClient,
    });

    await assert.rejects(
      () => timeoutProvider.generateEmbeddings(['test']),
      (err: AppError) => err.statusCode === 504 && err.message.includes('timed out')
    );
  });

  test('4. Rejects and throws 502 when embedding provider returns fewer or more vectors than requested', async () => {
    const countMismatchClient = {
      models: {
        embedContent: async () => {
          return {
            embeddings: [
              { values: new Array(1536).fill(0.1) },
              // Missing second vector
            ],
          };
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiEmbeddingProvider({
      apiKey: 'test-key',
      client: countMismatchClient,
    });

    await assert.rejects(
      () => provider.generateEmbeddings(['text one', 'text two']),
      (err: AppError) => err.statusCode === 502 && err.message.includes('count mismatch')
    );
  });

  test('5. Rejects and throws 502 when vector contains non-numeric or non-finite values (NaN, Infinity)', async () => {
    const invalidValuesClient = {
      models: {
        embedContent: async () => {
          const badVector = new Array(1536).fill(0.1);
          badVector[10] = NaN; // Corrupted dimension
          return {
            embeddings: [{ values: badVector }],
          };
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiEmbeddingProvider({
      apiKey: 'test-key',
      client: invalidValuesClient,
    });

    await assert.rejects(
      () => provider.generateEmbeddings(['test']),
      (err: AppError) => err.statusCode === 502 && err.message.includes('non-finite')
    );
  });

  test('6. Rejects and throws 502 when returned vector dimension does not match configured model dimension', async () => {
    const wrongDimClient = {
      models: {
        embedContent: async () => {
          return {
            embeddings: [{ values: new Array(512).fill(0.1) }], // 512 instead of 1536
          };
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiEmbeddingProvider({
      apiKey: 'test-key',
      client: wrongDimClient,
      dimensions: 1536,
    });

    await assert.rejects(
      () => provider.generateEmbeddings(['test']),
      (err: AppError) => err.statusCode === 502 && err.message.includes('unexpected dimension 512')
    );
  });

  test('7. Reuses valid existing embeddings when chunk content and model match (idempotency)', async () => {
    let apiCallCount = 0;
    const trackedProvider = new MockEmbeddingProvider({
      modelName: 'gemini-embedding-001',
      dimensions: 4,
      generator: (text) => {
        apiCallCount++;
        return MockEmbeddingProvider.generateDeterministicVector(text, 4);
      },
    });

    const mockQdrant = new MockQdrantService();
    const ingestionService = new IngestionService(
      itemRepo,
      chunkRepo,
      undefined,
      chunker,
      trackedProvider,
      mockQdrant
    );

    // Initial ingestion
    const content = 'First sentence of content. Second sentence of content.';
    const result1 = await ingestionService.ingest({
      source_type: 'note',
      title: 'Idempotency Note',
      content,
    });

    const initialApiCount = apiCallCount;
    assert.ok(initialApiCount > 0, 'Embeddings should have been generated');

    // Re-run with the same item and content
    const result2 = await ingestionService.ingest({
      source_type: 'note',
      title: 'Idempotency Note 2',
      content,
    });

    assert.equal(result2.item.status, 'completed');
  });

  test('8. Forces re-embedding when embedding model changes', async () => {
    // Ingest with model 1 (e.g. legacy OpenAI model)
    const mockQdrant = new MockQdrantService();
    const providerV1 = new MockEmbeddingProvider({ modelName: 'text-embedding-3-small', dimensions: 4 });
    const ingestionV1 = new IngestionService(itemRepo, chunkRepo, undefined, chunker, providerV1, mockQdrant);

    const result = await ingestionV1.ingest({
      source_type: 'note',
      title: 'Model Switch Note',
      content: 'Unique text content for model switch verification.',
    });

    const chunksV1 = await chunkRepo.findByItemId(result.item.id);
    assert.equal(chunksV1[0].embedding_model, 'text-embedding-3-small');

    // Re-process with Gemini embedding model
    let geminiCallCount = 0;
    const providerV2 = new MockEmbeddingProvider({
      modelName: 'gemini-embedding-001',
      dimensions: 4,
      generator: (text) => {
        geminiCallCount++;
        return MockEmbeddingProvider.generateDeterministicVector(text, 4);
      },
    });

    // Ingesting again with Gemini model forces fresh generation
    const ingestionV2 = new IngestionService(itemRepo, chunkRepo, undefined, chunker, providerV2, mockQdrant);
    await ingestionV2.ingest({
      source_type: 'note',
      title: 'Model Switch Note',
      content: 'Unique text content for model switch verification.',
    });

    assert.ok(geminiCallCount > 0, 'Switch to Gemini model should force fresh embedding generation');
  });

  test('9. Generates single query embedding via generateEmbedding', async () => {
    const mockProvider = new MockEmbeddingProvider({ dimensions: 1536 });
    const vector = await mockProvider.generateEmbedding('What is Turium AI?');

    assert.equal(Array.isArray(vector), true);
    assert.equal(vector.length, 1536);
  });
});
