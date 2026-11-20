import crypto from 'node:crypto';
import { ItemRepository } from '../repositories/item.repository';
import { ChunkRepository } from '../repositories/chunk.repository';
import { VectorCleanupRepository } from '../repositories/vector-cleanup.repository';
import { ScraperService } from './scraper.service';
import { ChunkingService, GeneratedChunk, defaultChunkingService } from './chunking.service';
import { EmbeddingProvider, defaultEmbeddingProvider } from './embedding.service';
import { QdrantService, QdrantPointInput, defaultQdrantService } from './qdrant.service';
import { IngestNoteInput, IngestUrlInput, IngestRequestInput } from '../schemas/ingest.schema';
import { Item, Chunk, SourceType } from '../types/database.types';
import { AppError } from '../middleware/error-handler.middleware';
import { logger } from '../utils/logger';
import { normalizeUrl } from '../utils/url';

export interface IngestionResult {
  item: Item;
  chunk_count: number;
}

export class IngestionService {
  private itemRepo: ItemRepository;
  private chunkRepo: ChunkRepository;
  private scraperService: ScraperService;
  private chunkingService: ChunkingService;
  private embeddingProvider: EmbeddingProvider;
  private qdrantService: QdrantService;
  private cleanupRepo: VectorCleanupRepository;
  /** In-process concurrency mutex to coalesce simultaneous ingestion requests for the same URL */
  private inFlightUrlIngestions = new Map<string, Promise<IngestionResult>>();

  constructor(
    itemRepo?: ItemRepository,
    chunkRepo?: ChunkRepository,
    scraperService?: ScraperService,
    chunkingService?: ChunkingService,
    embeddingProvider?: EmbeddingProvider,
    qdrantService?: QdrantService,
    cleanupRepo?: VectorCleanupRepository
  ) {
    this.itemRepo = itemRepo || new ItemRepository();
    this.chunkRepo = chunkRepo || new ChunkRepository();
    this.scraperService = scraperService || new ScraperService();
    this.chunkingService = chunkingService || defaultChunkingService;
    this.embeddingProvider = embeddingProvider || defaultEmbeddingProvider;
    this.qdrantService = qdrantService || defaultQdrantService;
    this.cleanupRepo = cleanupRepo || new VectorCleanupRepository();
  }

  /**
   * Batch generates embeddings for chunks, reusing existing valid embeddings where applicable,
   * stores relational chunks in Turso (Source of Truth), and syncs vector index to Qdrant.
   */
  private async processChunksWithEmbeddings(
    itemId: string,
    sourceType: SourceType,
    generatedChunks: GeneratedChunk[]
  ): Promise<Chunk[]> {
    if (generatedChunks.length === 0) {
      return [];
    }

    const existingChunks = await this.chunkRepo.findByItemId(itemId);
    const existingChunkMap = new Map<number, Chunk>();
    for (const ec of existingChunks) {
      existingChunkMap.set(ec.chunk_index, ec);
    }

    const currentModel = this.embeddingProvider.modelName;

    // Determine which chunks require fresh embedding generation
    const chunksNeedingEmbeddings: { index: number; content: string }[] = [];
    const resolvedEmbeddings: (number[] | null)[] = new Array(generatedChunks.length).fill(null);

    for (let i = 0; i < generatedChunks.length; i++) {
      const gc = generatedChunks[i];
      const existing = existingChunkMap.get(gc.chunk_index);

      // Check if existing chunk can be reused (identical content and current model)
      if (
        existing &&
        existing.content === gc.content &&
        existing.embedding &&
        existing.embedding_model === currentModel
      ) {
        try {
          const parsed = JSON.parse(existing.embedding);
          if (Array.isArray(parsed) && parsed.length > 0) {
            resolvedEmbeddings[i] = parsed;
            continue;
          }
        } catch {
          // Malformed JSON fallback to regeneration
        }
      }

      chunksNeedingEmbeddings.push({ index: i, content: gc.content });
    }

    // Generate embeddings in a single batch request for all chunks that need it
    if (chunksNeedingEmbeddings.length > 0) {
      logger.info(
        {
          itemId,
          totalChunks: generatedChunks.length,
          freshBatched: chunksNeedingEmbeddings.length,
          reused: generatedChunks.length - chunksNeedingEmbeddings.length,
          model: currentModel,
        },
        'Generating batch embeddings for ingestion'
      );

      const textsToEmbed = chunksNeedingEmbeddings.map((c) => c.content);
      const generatedVectors = await this.embeddingProvider.generateEmbeddings(textsToEmbed);

      if (generatedVectors.length !== chunksNeedingEmbeddings.length) {
        throw new AppError(
          502,
          `Embedding provider count mismatch: expected ${chunksNeedingEmbeddings.length}, got ${generatedVectors.length}`
        );
      }

      for (let j = 0; j < chunksNeedingEmbeddings.length; j++) {
        const targetIndex = chunksNeedingEmbeddings[j].index;
        resolvedEmbeddings[targetIndex] = generatedVectors[j];
      }
    }

    // 1. Persist relational chunks in Turso (Source of Truth)
    const chunkInputs = generatedChunks.map((gc, idx) => {
      const vector = resolvedEmbeddings[idx];
      return {
        item_id: itemId,
        chunk_index: gc.chunk_index,
        content: gc.content,
        embedding: vector ? JSON.stringify(vector) : null,
        embedding_model: vector ? currentModel : null,
        embedding_dimensions: vector ? vector.length : null,
      };
    });

    // Replace any existing chunks with the updated set in Turso
    await this.chunkRepo.deleteByItemId(itemId);
    const insertedChunks = await this.chunkRepo.createMany(chunkInputs);

    // 2. Synchronize vector embeddings to Qdrant (Vector Index)
    if (this.qdrantService.isConfigured()) {
      try {
        const qdrantPoints = insertedChunks
          .map((c, idx) => {
            const vector = resolvedEmbeddings[idx];
            if (!vector) return null;
            return {
              id: c.id,
              vector,
              payload: {
                item_id: itemId,
                chunk_index: c.chunk_index,
                source_type: sourceType,
                embedding_model: c.embedding_model || currentModel,
                created_at: c.created_at,
              },
            };
          })
          .filter((p): p is NonNullable<typeof p> => p !== null);

        if (qdrantPoints.length > 0) {
          await this.qdrantService.upsertChunks(qdrantPoints);
        }
      } catch (qdrantErr: unknown) {
        const errorMsg = qdrantErr instanceof Error ? qdrantErr.message : String(qdrantErr);
        logger.error({ itemId, error: errorMsg }, 'Qdrant vector index upsert failed');
        // Important invariant: NEVER mark an item completed if vector indexing failed!
        throw new AppError(502, `Vector indexing failed in Qdrant: ${errorMsg}`);
      }
    }

    return insertedChunks;
  }

  /**
   * Ingest plain text note
   */
  async ingestNote(input: IngestNoteInput): Promise<IngestionResult> {
    logger.info({ title: input.title, length: input.content.length }, 'Ingesting plain text note');

    // 1. Create item in 'processing' state in Turso
    const item = await this.itemRepo.create({
      source_type: 'note',
      title: input.title || 'Untitled Note',
      raw_content: input.content,
      status: 'processing',
    });

    try {
      // 2. Generate deterministic text chunks
      const generatedChunks = this.chunkingService.chunkText(input.content);

      if (generatedChunks.length === 0) {
        throw new AppError(422, 'Provided note produced zero extractable chunks');
      }

      // 3. Batch generate embeddings, save to Turso, sync to Qdrant
      await this.processChunksWithEmbeddings(item.id, 'note', generatedChunks);

      // 4. Mark item completed only after both Turso and Qdrant succeed
      await this.itemRepo.updateStatus(item.id, 'completed');
      item.status = 'completed';

      logger.info(
        { itemId: item.id, chunkCount: generatedChunks.length },
        'Note ingestion and embedding completed successfully'
      );

      return {
        item,
        chunk_count: generatedChunks.length,
      };
    } catch (err) {
      logger.error({ itemId: item.id, err }, 'Failed to chunk or embed note content');
      await this.itemRepo.updateStatus(item.id, 'failed');
      throw err;
    }
  }

  /**
   * Ingest remote URL content.
   * If a record with this URL already exists, safely updates the existing record
   * in-place (re-scraping, re-chunking, re-embedding, and safely replacing chunks/vectors)
   * without creating duplicate database records or destroying old working data on error.
   */
  async ingestUrl(input: IngestUrlInput): Promise<IngestionResult> {
    const normalizedInputUrl = normalizeUrl(input.url);

    // Concurrency Lock: Coalesce simultaneous requests for the same URL into a single in-flight promise
    const inFlight = this.inFlightUrlIngestions.get(normalizedInputUrl);
    if (inFlight) {
      logger.info({ url: normalizedInputUrl }, 'Joining concurrent in-flight ingestion for same URL');
      return inFlight;
    }

    const executionPromise = this.executeUrlIngestion(normalizedInputUrl, input.url);
    this.inFlightUrlIngestions.set(normalizedInputUrl, executionPromise);

    try {
      return await executionPromise;
    } finally {
      this.inFlightUrlIngestions.delete(normalizedInputUrl);
    }
  }

  private async executeUrlIngestion(
    normalizedUrl: string,
    rawUrl: string
  ): Promise<IngestionResult> {
    logger.info({ url: rawUrl, normalizedUrl }, 'Processing URL content ingestion');

    // 1. Identify existing records before scraping
    let existingItem = await this.itemRepo.findBySourceUrl(normalizedUrl);
    if (!existingItem && normalizedUrl !== rawUrl) {
      existingItem = await this.itemRepo.findBySourceUrl(rawUrl);
    }

    // 2. Fetch remote content and extract readable text with SSRF guards
    // If scraping fails, the existing record (if any) remains completely intact.
    const page = await this.scraperService.scrape(rawUrl);
    const normalizedPageUrl = normalizeUrl(page.url);

    // If redirected to a final destination URL, also check if that destination exists
    if (!existingItem && normalizedPageUrl !== normalizedUrl) {
      existingItem = await this.itemRepo.findBySourceUrl(normalizedPageUrl);
      if (!existingItem && page.url !== normalizedPageUrl) {
        existingItem = await this.itemRepo.findBySourceUrl(page.url);
      }
    }

    // 3. Generate deterministic text chunks
    const generatedChunks = this.chunkingService.chunkText(page.content);
    if (generatedChunks.length === 0) {
      throw new AppError(422, 'Scraped page produced zero extractable chunks');
    }

    // 4. Branch: Safe in-place update vs. New Item Creation
    if (existingItem) {
      return this.updateExistingItemFromScrape(existingItem, page, normalizedPageUrl, generatedChunks);
    }

    return this.createNewItemFromScrape(page, normalizedPageUrl, generatedChunks);
  }

  /**
   * Safe blue-green update of an existing item:
   * Generates new embeddings and upserts new Qdrant points BEFORE modifying Turso records.
   * If any step fails, old working chunks in Turso and vectors in Qdrant are fully preserved.
   */
  private async updateExistingItemFromScrape(
    existingItem: Item,
    page: { title: string | null; url: string; content: string },
    normalizedUrl: string,
    generatedChunks: GeneratedChunk[]
  ): Promise<IngestionResult> {
    const itemId = existingItem.id;
    const currentModel = this.embeddingProvider.modelName;

    // Fast-path: Check if scraped content is completely unchanged
    if (
      existingItem.status === 'completed' &&
      existingItem.raw_content === page.content &&
      existingItem.title === page.title
    ) {
      logger.info({ itemId, url: normalizedUrl }, 'URL content unchanged; touching updated_at timestamp');
      await this.itemRepo.touchUpdatedAt(itemId);
      const chunkCount = await this.chunkRepo.countByItemId(itemId);
      return {
        item: { ...existingItem, updated_at: new Date().toISOString() },
        chunk_count: chunkCount,
      };
    }

    logger.info({ itemId, url: normalizedUrl }, 'URL content changed; safely re-indexing chunks and vectors');

    // Step A: Generate all embeddings in memory first
    // If Gemini fails, old data in Turso and Qdrant is untouched!
    const textsToEmbed = generatedChunks.map((c) => c.content);
    const generatedVectors = await this.embeddingProvider.generateEmbeddings(textsToEmbed);
    if (generatedVectors.length !== generatedChunks.length) {
      throw new AppError(
        502,
        `Embedding provider count mismatch: expected ${generatedChunks.length}, got ${generatedVectors.length}`
      );
    }

    // Pre-assign chunk UUIDs so that Turso and Qdrant IDs are synchronized
    const newChunkInputs = generatedChunks.map((gc, idx) => {
      const vector = generatedVectors[idx];
      return {
        id: crypto.randomUUID(),
        item_id: itemId,
        chunk_index: gc.chunk_index,
        content: gc.content,
        embedding: vector ? JSON.stringify(vector) : null,
        embedding_model: vector ? currentModel : null,
        embedding_dimensions: vector ? vector.length : null,
      };
    });

    // Record old chunk IDs for cleanup after replacement succeeds
    const oldChunks = await this.chunkRepo.findByItemId(itemId);
    const oldChunkIds = oldChunks.map((c) => c.id);

    // Step B: Upsert new points into Qdrant first (before deleting old chunks in Turso)
    const newQdrantPoints: QdrantPointInput[] = [];
    if (this.qdrantService.isConfigured()) {
      for (let i = 0; i < newChunkInputs.length; i++) {
        const vector = generatedVectors[i];
        if (!vector) continue;
        newQdrantPoints.push({
          id: newChunkInputs[i].id,
          vector,
          payload: {
            item_id: itemId,
            chunk_index: newChunkInputs[i].chunk_index,
            source_type: 'url',
            embedding_model: currentModel,
            created_at: new Date().toISOString(),
          },
        });
      }

      if (newQdrantPoints.length > 0) {
        try {
          await this.qdrantService.upsertChunks(newQdrantPoints);
        } catch (qdrantErr: unknown) {
          const errorMsg = qdrantErr instanceof Error ? qdrantErr.message : String(qdrantErr);
          logger.error(
            { itemId, error: errorMsg },
            'Qdrant vector upsert failed during re-index; existing data preserved'
          );
          // Preserve existing working data; do not mark failed or delete old chunks
          throw new AppError(502, `Vector indexing failed in Qdrant: ${errorMsg}`);
        }
      }
    }

    // Step C: Atomically replace chunks and update parent item in Turso
    let updatedItem: Item | null = null;
    try {
      await this.chunkRepo.replaceChunksForItem(itemId, newChunkInputs as any);
      updatedItem = await this.itemRepo.updateContentAndStatus(itemId, {
        title: page.title,
        source_url: page.url,
        raw_content: page.content,
        status: 'completed',
      });
    } catch (tursoErr) {
      logger.error({ itemId, tursoErr }, 'Turso chunk replacement failed; rolling back new Qdrant points');
      // Rollback new Qdrant points so no orphaned vectors remain
      if (newQdrantPoints.length > 0) {
        await this.qdrantService.deletePoints(newQdrantPoints.map((p) => p.id));
      }
      throw tursoErr;
    }

    // Step D: Now that new chunks and item are committed in Turso, clean up old points in Qdrant
    if (this.qdrantService.isConfigured() && oldChunkIds.length > 0) {
      try {
        await this.qdrantService.deletePoints(oldChunkIds);
      } catch (cleanupErr: unknown) {
        const errorMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        // 1. Structured log with exact point IDs for visibility, monitoring, and auditability
        logger.warn(
          {
            event: 'QDRANT_ORPHANED_POINTS_CLEANUP_FAILED',
            itemId,
            orphanedPointIds: oldChunkIds,
            count: oldChunkIds.length,
            error: errorMessage,
          },
          'Non-fatal: failed to clean up old Qdrant vector points after Turso commit; points queued for retry'
        );
        // 2. Queue exact IDs for idempotent recovery in-memory AND durable database
        this.qdrantService.queueFailedCleanup(oldChunkIds);
        try {
          await this.cleanupRepo.insertMany(oldChunkIds, itemId);
        } catch (dbErr) {
          logger.warn({ itemId, dbErr }, 'Failed to record orphaned points in pending_vector_cleanups table');
        }
      }
    }

    logger.info(
      { itemId, url: normalizedUrl, chunkCount: newChunkInputs.length },
      'URL re-indexing and embedding completed successfully'
    );

    return {
      item: updatedItem || {
        ...existingItem,
        title: page.title,
        source_url: page.url,
        raw_content: page.content,
        updated_at: new Date().toISOString(),
        status: 'completed',
      },
      chunk_count: newChunkInputs.length,
    };
  }

  /**
   * Create brand new item from scraped URL content
   */
  private async createNewItemFromScrape(
    page: { title: string | null; url: string; content: string },
    normalizedUrl: string,
    generatedChunks: GeneratedChunk[]
  ): Promise<IngestionResult> {
    const item = await this.itemRepo.create({
      source_type: 'url',
      title: page.title,
      source_url: page.url,
      raw_content: page.content,
      status: 'processing',
    });

    try {
      await this.processChunksWithEmbeddings(item.id, 'url', generatedChunks);
      await this.itemRepo.updateStatus(item.id, 'completed');
      item.status = 'completed';

      logger.info(
        { itemId: item.id, url: normalizedUrl, chunkCount: generatedChunks.length },
        'URL ingestion and embedding completed successfully'
      );

      return {
        item,
        chunk_count: generatedChunks.length,
      };
    } catch (err) {
      logger.error({ itemId: item.id, url: normalizedUrl, err }, 'Failed to process URL content');
      await this.itemRepo.updateStatus(item.id, 'failed');
      throw err;
    }
  }

  /**
   * Orchestrates discriminated request
   */
  async ingest(input: IngestRequestInput): Promise<IngestionResult> {
    if (input.source_type === 'note') {
      return this.ingestNote(input);
    }
    return this.ingestUrl(input);
  }
}
