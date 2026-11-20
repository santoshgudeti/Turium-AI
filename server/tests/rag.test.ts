import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { GoogleGenAI } from '@google/genai';
import { initSchema } from '../src/db/schema';
import { ItemRepository } from '../src/repositories/item.repository';
import { ChunkRepository } from '../src/repositories/chunk.repository';
import { RetrievalService } from '../src/services/retrieval.service';
import { DisabledQdrantService } from '../src/services/qdrant.service';
import { MockEmbeddingProvider } from '../src/services/embedding.service';
import { MockChatProvider, GeminiChatProvider } from '../src/services/chat.service';
import { PromptService } from '../src/services/prompt.service';
import { RAGService } from '../src/services/rag.service';
import { QueryRequestSchema } from '../src/schemas/query.schema';
import { AppError } from '../middleware/error-handler.middleware';
import { logger } from '../src/utils/logger';

describe('RAG Answer Generation & Source Citations Test Suite', () => {
  let testDb: DatabaseSync;
  let itemRepo: ItemRepository;
  let chunkRepo: ChunkRepository;
  let embeddingProvider: MockEmbeddingProvider;
  let retrievalService: RetrievalService;
  let chatProvider: MockChatProvider;
  let ragService: RAGService;

  beforeEach(() => {
    testDb = new DatabaseSync(':memory:');
    initSchema(testDb);
    itemRepo = new ItemRepository(testDb);
    chunkRepo = new ChunkRepository(testDb);

    embeddingProvider = new MockEmbeddingProvider({
      modelName: 'gemini-embedding-001',
      dimensions: 4,
      generator: () => [1, 0, 0, 0], // Deterministic query and chunk vectors
    });

    retrievalService = new RetrievalService(chunkRepo, embeddingProvider, new DisabledQdrantService());
    chatProvider = new MockChatProvider();
    ragService = new RAGService(retrievalService, chatProvider);
  });

  afterEach(() => {
    testDb.close();
  });

  test('1. Valid question produces grounded answer and validated source citations', async () => {
    const item = await itemRepo.create({
      source_type: 'url',
      title: 'Home Loan EMI Calculation Guide',
      source_url: 'https://finance.example.com/emi-guide',
      raw_content: 'Loan EMI is calculated using principal, interest rate, and tenure formula: P * r * (1+r)^n / ((1+r)^n - 1).',
      status: 'completed',
    });

    const [chunk] = await chunkRepo.createMany([
      {
        item_id: item.id,
        chunk_index: 0,
        content: 'Loan EMI is calculated using principal, interest rate, and tenure formula: P * r * (1+r)^n / ((1+r)^n - 1).',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    chatProvider.setHandler((_sys, userPrompt) => {
      assert.ok(userPrompt.includes(chunk.id), 'Prompt should contain chunk ID');
      return {
        answer: 'Loan EMI depends on principal, interest rate, and tenure.',
        citedChunkIds: [chunk.id],
      };
    });

    const result = await ragService.answerQuestion('What did I save about loan EMI calculations?');

    assert.equal(result.answer, 'Loan EMI depends on principal, interest rate, and tenure.');
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].chunk_id, chunk.id);
    assert.equal(result.sources[0].item_title, 'Home Loan EMI Calculation Guide');
    assert.equal(result.sources[0].source_url, 'https://finance.example.com/emi-guide');
    assert.equal(result.sources[0].source_type, 'url');
    assert.equal(result.sources[0].chunk_index, 0);
    assert.ok(result.sources[0].snippet.includes('Loan EMI'));
    assert.equal(result.sources[0].similarity, 1);
  });

  test('2. Empty or whitespace-only question is rejected by Zod schema and RAGService', async () => {
    // Zod schema rejection
    assert.throws(
      () => QueryRequestSchema.parse({ question: '   ' }),
      (err) => err instanceof Error && err.message.includes('empty')
    );

    assert.throws(
      () => QueryRequestSchema.parse({ question: '' }),
      (err) => err instanceof Error
    );

    // Direct service safety guard
    const serviceResult = await ragService.answerQuestion('   ');
    assert.ok(serviceResult.answer.includes('non-empty question'));
    assert.deepEqual(serviceResult.sources, []);
  });

  test('3. Question exceeding maximum length is rejected by schema', () => {
    const longQuestion = 'a'.repeat(1001);
    assert.throws(
      () => QueryRequestSchema.parse({ question: longQuestion }),
      (err) => err instanceof Error && err.message.includes('1000 characters')
    );
  });

  test('4. Returns helpful insufficient-knowledge response without calling LLM when knowledge base has no items', async () => {
    let llmCalled = false;
    chatProvider.setHandler(() => {
      llmCalled = true;
      return { answer: 'Should not be called', citedChunkIds: [] };
    });

    const result = await ragService.answerQuestion('What is my credit score?');

    assert.equal(llmCalled, false, 'LLM must not be called when retrieval yields zero candidates');
    assert.ok(result.answer.includes('does not contain enough information'));
    assert.deepEqual(result.sources, []);
  });

  test('5. Relevant retrieved context is formatted into user prompt with stable delimiters', () => {
    const mockChunks = [
      {
        chunk_id: 'chunk-uuid-1',
        chunk_index: 0,
        content: 'Relevant snippet about quantum computing.',
        similarity: 0.8876,
        item_id: 'item-1',
        item_title: 'Quantum Overview',
        item_source_type: 'note' as const,
        item_source_url: null,
      },
    ];

    const prompt = PromptService.buildUserPrompt('Explain qubits', mockChunks);

    assert.ok(prompt.includes('CHUNK_ID: chunk-uuid-1'));
    assert.ok(prompt.includes('SOURCE: Quantum Overview'));
    assert.ok(prompt.includes('Relevant snippet about quantum computing.'));
    assert.ok(prompt.includes('SIMILARITY: 0.8876'));
    assert.ok(prompt.includes('--- CHUNK [1] ---'));
  });

  test('6. Prompt construction guards against prompt injection inside retrieved document chunks', () => {
    const systemPrompt = PromptService.getSystemPrompt();

    assert.ok(systemPrompt.includes('UNTRUSTED DATA'));
    assert.ok(systemPrompt.includes('Ignore previous instructions'));
    assert.ok(systemPrompt.includes('DISREGARD THEM ENTIRELY'));
  });

  test('7. Discards fabricated chunk IDs returned by model and only returns verified source citations', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Real Note',
      raw_content: 'Legitimate information in the database.',
      status: 'completed',
    });

    const [chunk] = await chunkRepo.createMany([
      {
        item_id: item.id,
        chunk_index: 0,
        content: 'Legitimate information in the database.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    // Model returns one legitimate chunk ID and one hallucinated/fabricated ID
    chatProvider.setHandler(() => ({
      answer: 'Synthesized response.',
      citedChunkIds: [chunk.id, 'fabricated-chunk-id-999', 'fake-uuid-abc'],
    }));

    const result = await ragService.answerQuestion('Verify citations');

    // Only the real chunk must be returned in sources
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].chunk_id, chunk.id);
    assert.ok(!result.sources.some((s) => s.chunk_id === 'fabricated-chunk-id-999'));
    assert.ok(!result.sources.some((s) => s.chunk_id === 'fake-uuid-abc'));
  });

  test('8. Handles model response citing no chunk IDs cleanly (empty sources array)', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      title: 'General Note',
      raw_content: 'General content.',
      status: 'completed',
    });

    await chunkRepo.createMany([
      {
        item_id: item.id,
        chunk_index: 0,
        content: 'General content.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    chatProvider.setHandler(() => ({
      answer: 'The saved knowledge inbox does not contain enough information to answer this question.',
      citedChunkIds: [],
    }));

    const result = await ragService.answerQuestion('Unrelated question?');
    assert.equal(result.sources.length, 0);
    assert.ok(result.answer.includes('does not contain enough information'));
  });

  test('9. Chat provider rate limit (HTTP 429) propagates as standardized AppError', async () => {
    const rateLimitClient = {
      models: {
        generateContent: async () => {
          const err = new Error('Resource exhausted / rate limit exceeded') as Error & { status: number };
          err.status = 429;
          throw err;
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiChatProvider({
      apiKey: 'test-key',
      client: rateLimitClient,
    });

    await assert.rejects(
      () => provider.generateGroundedAnswer('sys', 'user'),
      (err: AppError) => err.statusCode === 429 && err.message.includes('rate limit')
    );
  });

  test('10. Chat provider timeout (504 deadline exceeded) propagates as HTTP 504 AppError', async () => {
    const timeoutClient = {
      models: {
        generateContent: async () => {
          const err = new Error('Deadline exceeded') as Error & { status: number };
          err.status = 504;
          throw err;
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiChatProvider({
      apiKey: 'test-key',
      client: timeoutClient,
    });

    await assert.rejects(
      () => provider.generateGroundedAnswer('sys', 'user'),
      (err: AppError) => err.statusCode === 504 && err.message.includes('timed out')
    );
  });

  test('11. Chat provider authentication failure (HTTP 401) propagates as HTTP 500 AppError', async () => {
    const authFailClient = {
      models: {
        generateContent: async () => {
          const err = new Error('Unauthorized') as Error & { status: number };
          err.status = 401;
          throw err;
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiChatProvider({
      apiKey: 'test-key',
      client: authFailClient,
    });

    await assert.rejects(
      () => provider.generateGroundedAnswer('sys', 'user'),
      (err: AppError) => err.statusCode === 500 && err.message.includes('authentication failed')
    );
  });

  test('12. Chat provider returning malformed JSON throws HTTP 502 AppError', async () => {
    const badJsonClient = {
      models: {
        generateContent: async () => ({
          text: 'Not a JSON object',
        }),
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiChatProvider({
      apiKey: 'test-key',
      client: badJsonClient,
    });

    await assert.rejects(
      () => provider.generateGroundedAnswer('sys', 'user'),
      (err: AppError) => err.statusCode === 502 && err.message.includes('not valid JSON')
    );
  });

  test('13. Chat provider missing answer field throws HTTP 502 AppError', async () => {
    const missingAnswerClient = {
      models: {
        generateContent: async () => ({
          text: JSON.stringify({ cited_chunk_ids: [] }),
        }),
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiChatProvider({
      apiKey: 'test-key',
      client: missingAnswerClient,
    });

    await assert.rejects(
      () => provider.generateGroundedAnswer('sys', 'user'),
      (err: AppError) => err.statusCode === 502 && err.message.includes('missing string answer')
    );
  });

  test('14. Source metadata correctness: includes title, URL, type, chunk index, snippet, and similarity', async () => {
    const item = await itemRepo.create({
      source_type: 'url',
      title: 'Turium Architecture Whitepaper',
      source_url: 'https://turium.ai/whitepaper',
      raw_content: 'Detailed discussion of full-stack AI knowledge architecture.',
      status: 'completed',
    });

    const [chunk] = await chunkRepo.createMany([
      {
        item_id: item.id,
        chunk_index: 3,
        content: 'Detailed discussion of full-stack AI knowledge architecture.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    chatProvider.setHandler(() => ({
      answer: 'Turium architecture enables grounded RAG.',
      citedChunkIds: [chunk.id],
    }));

    const result = await ragService.answerQuestion('Explain architecture');

    assert.equal(result.sources.length, 1);
    const src = result.sources[0];
    assert.equal(src.item_id, item.id);
    assert.equal(src.item_title, 'Turium Architecture Whitepaper');
    assert.equal(src.source_url, 'https://turium.ai/whitepaper');
    assert.equal(src.source_type, 'url');
    assert.equal(src.chunk_id, chunk.id);
    assert.equal(src.chunk_index, 3);
    assert.ok(src.snippet.startsWith('Detailed discussion'));
    assert.equal(typeof src.similarity, 'number');
  });

  test('15. Grounding Integrity: Substantive answer with ONLY fabricated citations is rejected and returns insufficient knowledge', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Company Financials',
      raw_content: 'Q3 revenue reached 12.5M dollars with 22% margin.',
      status: 'completed',
    });

    await chunkRepo.createMany([
      {
        item_id: item.id,
        chunk_index: 0,
        content: 'Q3 revenue reached 12.5M dollars with 22% margin.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    // Model provides a substantive answer, but its citations are completely fabricated
    chatProvider.setHandler(() => ({
      answer: 'The company reported 12.5 million in revenue with strong margins.',
      citedChunkIds: ['fake-chunk-id-1', 'fake-chunk-id-2'],
    }));

    const result = await ragService.answerQuestion('What was the revenue?');

    // Substantive answer MUST be rejected because it lacks valid grounding
    assert.equal(
      result.answer,
      'The saved knowledge inbox does not contain enough information to answer this question.'
    );
    assert.deepEqual(result.sources, []);
  });

  test('16. Grounding Integrity: Substantive answer with valid citations is returned with verified sources', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Company Strategy',
      raw_content: 'Turium AI focuses on high-precision knowledge inbox workflows.',
      status: 'completed',
    });

    const [chunk] = await chunkRepo.createMany([
      {
        item_id: item.id,
        chunk_index: 0,
        content: 'Turium AI focuses on high-precision knowledge inbox workflows.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    chatProvider.setHandler(() => ({
      answer: 'Turium AI focuses on high-precision workflows.',
      citedChunkIds: [chunk.id],
    }));

    const result = await ragService.answerQuestion('What is Turium strategy?');

    assert.equal(result.answer, 'Turium AI focuses on high-precision workflows.');
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].chunk_id, chunk.id);
  });

  test('17. Grounding Integrity: Mixed valid and fabricated citations return only validated sources', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Security Policy',
      raw_content: 'All endpoints enforce strict input sanitization and rate limits.',
      status: 'completed',
    });

    const [chunk] = await chunkRepo.createMany([
      {
        item_id: item.id,
        chunk_index: 0,
        content: 'All endpoints enforce strict input sanitization and rate limits.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    // Model returns valid chunk ID plus an invented one
    chatProvider.setHandler(() => ({
      answer: 'Endpoints enforce rate limits and input sanitization.',
      citedChunkIds: [chunk.id, 'hallucinated-id-xyz'],
    }));

    const result = await ragService.answerQuestion('What is the security policy?');

    assert.equal(result.answer, 'Endpoints enforce rate limits and input sanitization.');
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].chunk_id, chunk.id);
    assert.ok(!result.sources.some((s) => s.chunk_id === 'hallucinated-id-xyz'));
  });

  test('18. Grounding Integrity: Explicit insufficient-knowledge answer from model remains valid and returns empty sources', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Cooking Recipes',
      raw_content: 'Chocolate chip cookies require flour, sugar, butter, and chips.',
      status: 'completed',
    });

    await chunkRepo.createMany([
      {
        item_id: item.id,
        chunk_index: 0,
        content: 'Chocolate chip cookies require flour, sugar, butter, and chips.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    // Model explicitly states insufficient information
    chatProvider.setHandler(() => ({
      answer: 'The saved knowledge inbox does not contain enough information to answer how to repair a bicycle.',
      citedChunkIds: [],
    }));

    const result = await ragService.answerQuestion('How to repair a bicycle?');

    assert.ok(result.answer.includes('does not contain enough information'));
    assert.deepEqual(result.sources, []);
  });

  test('19. Logging Privacy: Citation warning logs do not contain the user question', async () => {
    const item = await itemRepo.create({
      source_type: 'note',
      title: 'Confidential Document',
      raw_content: 'Protected enterprise data.',
      status: 'completed',
    });

    await chunkRepo.createMany([
      {
        item_id: item.id,
        chunk_index: 0,
        content: 'Protected enterprise data.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    // Model returns fabricated citation to trigger logger.warn
    chatProvider.setHandler(() => ({
      answer: 'Confidential summary.',
      citedChunkIds: ['fake-unverified-chunk-id'],
    }));

    const sensitiveUserQuestion = 'CONFIDENTIAL_SECRET_TOKEN_QUESTION_987654';

    let loggedWarningObjects: Record<string, unknown>[] = [];
    const originalWarn = logger.warn.bind(logger);
    (logger as any).warn = (obj: any, ...args: any[]) => {
      loggedWarningObjects.push(obj);
      originalWarn(obj, ...args);
    };

    try {
      await ragService.answerQuestion(sensitiveUserQuestion);

      assert.ok(loggedWarningObjects.length > 0, 'Warning logs should have been emitted');

      // Verify that NO warning log object contains the sensitive question string
      for (const logObj of loggedWarningObjects) {
        const serialized = JSON.stringify(logObj);
        assert.ok(
          !serialized.includes(sensitiveUserQuestion),
          `Warning log contained sensitive question: ${serialized}`
        );
        // Ensure questionLength is used instead
        assert.equal((logObj as any).questionLength, sensitiveUserQuestion.length);
      }
    } finally {
      (logger as any).warn = originalWarn;
    }
  });

  test('20. Upstream 503 Handling: GeminiChatProvider maps 503/UNAVAILABLE to stable 502 without leaking raw response bodies or prompts', async () => {
    const rawUpstream503Message = JSON.stringify({
      error: {
        code: 503,
        message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
        status: 'UNAVAILABLE',
      },
    });

    const mockGenAIClient = {
      models: {
        generateContent: async () => {
          const err = new Error(rawUpstream503Message) as Error & { status: number };
          err.status = 503;
          throw err;
        },
      },
    } as unknown as GoogleGenAI;

    const provider = new GeminiChatProvider({
      apiKey: 'test-key',
      client: mockGenAIClient,
    });

    let loggedErrorObjects: Record<string, unknown>[] = [];
    const originalError = logger.error.bind(logger);
    (logger as any).error = (obj: any, ...args: any[]) => {
      loggedErrorObjects.push(obj);
      originalError(obj, ...args);
    };

    const secretPrompt = 'SECRET_USER_INPUT_PROMPT_123456';

    try {
      await assert.rejects(
        () => provider.generateGroundedAnswer('system instruction', secretPrompt),
        (err: AppError) => {
          assert.equal(err.statusCode, 502);
          assert.ok(
            err.message.includes('temporarily unavailable or experiencing high demand'),
            `Unexpected message: ${err.message}`
          );
          // Verify raw upstream JSON body is NOT leaked to client message
          assert.ok(!err.message.includes('{"error"'));
          return true;
        }
      );

      // Verify structured diagnostic logging
      assert.ok(loggedErrorObjects.length > 0);
      const lastError = loggedErrorObjects[loggedErrorObjects.length - 1];
      assert.equal(lastError.provider, 'Google Gemini');
      assert.equal(lastError.errorCategory, 'SERVICE_UNAVAILABLE');
      assert.equal(lastError.upstreamStatusCode, 503);

      // Ensure secret prompt was never logged
      const serializedLogs = JSON.stringify(loggedErrorObjects);
      assert.ok(!serializedLogs.includes(secretPrompt), 'Secret prompt was leaked in logger.error');
    } finally {
      (logger as any).error = originalError;
    }
  });

  test('21. Upstream Provider Errors: GeminiChatProvider sanitizes 429, 401, 504 and generic upstream errors', async () => {
    // 429 Rate limit
    const rateLimitClient = {
      models: {
        generateContent: async () => {
          const err = new Error('Resource exhausted') as Error & { status: number };
          err.status = 429;
          throw err;
        },
      },
    } as unknown as GoogleGenAI;

    const rateLimitProvider = new GeminiChatProvider({
      apiKey: 'test-key',
      client: rateLimitClient,
    });

    await assert.rejects(
      () => rateLimitProvider.generateGroundedAnswer('system', 'user'),
      (err: AppError) => err.statusCode === 429 && err.message.includes('rate limit exceeded')
    );

    // 401 Auth error
    const authClient = {
      models: {
        generateContent: async () => {
          const err = new Error('API_KEY_INVALID') as Error & { status: number };
          err.status = 401;
          throw err;
        },
      },
    } as unknown as GoogleGenAI;

    const authProvider = new GeminiChatProvider({
      apiKey: 'test-key',
      client: authClient,
    });

    await assert.rejects(
      () => authProvider.generateGroundedAnswer('system', 'user'),
      (err: AppError) => err.statusCode === 500 && err.message.includes('authentication failed')
    );

    // Generic upstream failure
    const genericClient = {
      models: {
        generateContent: async () => {
          throw new Error('Internal backend RPC failure');
        },
      },
    } as unknown as GoogleGenAI;

    const genericProvider = new GeminiChatProvider({
      apiKey: 'test-key',
      client: genericClient,
    });

    await assert.rejects(
      () => genericProvider.generateGroundedAnswer('system', 'user'),
      (err: AppError) => err.statusCode === 502 && err.message.includes('upstream provider error')
    );
  });

  // ─── Phase 1 New Tests ───────────────────────────────────────────────────

  test('22. Duplicate citations from re-ingested URL are collapsed to one citation per unique source+chunk_index', async () => {
    const sharedUrl = 'https://example.com/duplicate-article';

    // Simulate two items created from the same URL
    const itemA = await itemRepo.create({
      source_type: 'url',
      title: 'First Ingest',
      source_url: sharedUrl,
      raw_content: 'Identical content from both ingests',
      status: 'completed',
    });
    const itemB = await itemRepo.create({
      source_type: 'url',
      title: 'Second Ingest (Re-ingest)',
      source_url: sharedUrl,
      raw_content: 'Identical content from both ingests',
      status: 'completed',
    });

    // Both items have chunk_index=0 with identical content
    const [chunkA] = await chunkRepo.createMany([
      {
        item_id: itemA.id,
        chunk_index: 0,
        content: 'Identical content from both ingests',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);
    const [chunkB] = await chunkRepo.createMany([
      {
        item_id: itemB.id,
        chunk_index: 0,
        content: 'Identical content from both ingests',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    // LLM cites both chunk IDs — rag.service must deduplicate to one citation
    chatProvider.setHandler((_sys, _user) => ({
      answer: 'The article discusses shared content.',
      citedChunkIds: [chunkA.id, chunkB.id],
    }));

    const result = await ragService.answerQuestion('What does the article say?');

    assert.ok(result.sources.length <= 1,
      `Expected at most 1 citation after dedup, got ${result.sources.length}`
    );
    if (result.sources.length === 1) {
      assert.equal(result.sources[0].source_url, sharedUrl);
    }
  });

  test('23. Item-scoped query passes itemId through the pipeline and returns only chunks from that item', async () => {
    const itemTarget = await itemRepo.create({
      source_type: 'note',
      title: 'Target Item',
      raw_content: 'Target item content only',
      status: 'completed',
    });
    const itemOther = await itemRepo.create({
      source_type: 'note',
      title: 'Other Item',
      raw_content: 'Other item content — should not appear',
      status: 'completed',
    });

    const [targetChunk] = await chunkRepo.createMany([
      {
        item_id: itemTarget.id,
        chunk_index: 0,
        content: 'Target item content only',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);
    await chunkRepo.createMany([
      {
        item_id: itemOther.id,
        chunk_index: 0,
        content: 'Other item content — should not appear',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    chatProvider.setHandler((_sys, userPrompt) => {
      // The prompt should contain the target chunk but not any other-item chunk
      assert.ok(userPrompt.includes(targetChunk.id), 'Prompt should include target chunk ID');
      return {
        answer: 'Answer scoped to target item.',
        citedChunkIds: [targetChunk.id],
      };
    });

    const result = await ragService.answerQuestion('What is in the target item?', { itemId: itemTarget.id });

    assert.equal(result.sources.length, 1, 'Should have exactly one source from the target item');
    assert.equal(result.sources[0].chunk_id, targetChunk.id);
    assert.equal(result.sources[0].item_id, itemTarget.id);
  });

  test('24. Content-based citation deduplication: Same URL + same chunk_index + DIFFERENT content preserves both citations', async () => {
    const dynamicUrl = 'https://example.com/live-blog';

    const itemV1 = await itemRepo.create({
      source_type: 'url',
      title: 'Live Blog Morning',
      source_url: dynamicUrl,
      raw_content: 'Morning post',
      status: 'completed',
    });
    const itemV2 = await itemRepo.create({
      source_type: 'url',
      title: 'Live Blog Afternoon',
      source_url: dynamicUrl,
      raw_content: 'Afternoon post',
      status: 'completed',
    });

    const [chunkV1] = await chunkRepo.createMany([
      {
        item_id: itemV1.id,
        chunk_index: 0,
        content: 'Key finding A: Rocket stage separated successfully.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);
    const [chunkV2] = await chunkRepo.createMany([
      {
        item_id: itemV2.id,
        chunk_index: 0,
        content: 'Key finding B: Spacecraft achieved target orbit.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    chatProvider.setHandler((_sys, _user) => ({
      answer: 'The mission had two key milestones: stage separation and target orbit.',
      citedChunkIds: [chunkV1.id, chunkV2.id],
    }));

    const result = await ragService.answerQuestion('What were the mission milestones?');

    assert.equal(result.sources.length, 2, 'Both distinct content versions must be cited');
    const citedIds = result.sources.map((s) => s.chunk_id);
    assert.ok(citedIds.includes(chunkV1.id));
    assert.ok(citedIds.includes(chunkV2.id));
  });

  test('25. Content-based citation deduplication: Same URL + same chunk_index + IDENTICAL content collapses to 1 citation', async () => {
    const staticUrl = 'https://example.com/static-policy';

    const item1 = await itemRepo.create({
      source_type: 'url',
      title: 'Policy Ingest 1',
      source_url: staticUrl,
      raw_content: 'Exact policy text',
      status: 'completed',
    });
    const item2 = await itemRepo.create({
      source_type: 'url',
      title: 'Policy Ingest 2 (Duplicate)',
      source_url: staticUrl,
      raw_content: 'Exact policy text',
      status: 'completed',
    });

    const [chunk1] = await chunkRepo.createMany([
      {
        item_id: item1.id,
        chunk_index: 0,
        content: 'All passwords must contain at least 16 characters including symbols.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);
    const [chunk2] = await chunkRepo.createMany([
      {
        item_id: item2.id,
        chunk_index: 0,
        content: 'All passwords must contain at least 16 characters including symbols.',
        embedding: JSON.stringify([1, 0, 0, 0]),
        embedding_model: 'gemini-embedding-001',
        embedding_dimensions: 4,
      },
    ]);

    // LLM hallucinated citing both duplicates
    chatProvider.setHandler((_sys, _user) => ({
      answer: 'Password policy requires 16 characters with symbols.',
      citedChunkIds: [chunk1.id, chunk2.id],
    }));

    const result = await ragService.answerQuestion('What is the password requirement?');

    assert.equal(result.sources.length, 1, 'Identical content citations must be collapsed to exactly 1 source');
    assert.equal(result.sources[0].source_url, staticUrl);
  });
});
