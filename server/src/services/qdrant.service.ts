import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { SourceType } from '../types/database.types';

export const QDRANT_COLLECTION_NAME = 'turium_knowledge_chunks';

export interface ChunkQdrantPayload {
  item_id: string;
  chunk_index: number;
  source_type: SourceType;
  embedding_model: string;
  created_at: string;
  [key: string]: unknown;
}

export interface QdrantScoredPoint {
  id: string;
  score: number;
  payload?: ChunkQdrantPayload;
}

export interface QdrantPointInput {
  id: string;
  vector: number[];
  payload: ChunkQdrantPayload;
}

export class QdrantService {
  private client: QdrantClient | null = null;
  private isInitialized = false;

  constructor(client?: QdrantClient) {
    if (client) {
      this.client = client;
    } else if (this.isConfigured()) {
      this.client = new QdrantClient({
        url: config.QDRANT_URL!,
        apiKey: config.QDRANT_API_KEY,
        checkCompatibility: false,
      });
    }
  }

  isConfigured(): boolean {
    return Boolean(config.QDRANT_URL && config.QDRANT_URL.trim() !== '');
  }

  getClient(): QdrantClient | null {
    return this.client;
  }

  /**
   * Idempotent collection initialization.
   * Checks if collection exists before attempting to create.
   * Never recreates or overwrites an existing collection.
   */
  async initCollection(): Promise<void> {
    if (!this.client || this.isInitialized) {
      return;
    }

    try {
      const response = await this.client.getCollections();
      const exists = response.collections.some(
        (col) => col.name === QDRANT_COLLECTION_NAME
      );

      if (!exists) {
        logger.info(
          { collection: QDRANT_COLLECTION_NAME, size: 1536, distance: 'Cosine' },
          'Creating Qdrant vector collection'
        );
        await this.client.createCollection(QDRANT_COLLECTION_NAME, {
          vectors: {
            size: 1536,
            distance: 'Cosine',
          },
        });
        logger.info({ collection: QDRANT_COLLECTION_NAME }, 'Qdrant collection created successfully');
      } else {
        logger.info({ collection: QDRANT_COLLECTION_NAME }, 'Qdrant collection already exists; preserving');
      }

      this.isInitialized = true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message }, 'Failed to initialize Qdrant collection');
      throw new Error(`Qdrant initialization failure: ${message}`);
    }
  }

  /**
   * Upsert vector points into Qdrant collection
   */
  async upsertChunks(points: QdrantPointInput[]): Promise<void> {
    if (!this.client) {
      throw new Error('Qdrant client is not configured');
    }
    if (points.length === 0) {
      return;
    }

    await this.initCollection();

    await this.client.upsert(QDRANT_COLLECTION_NAME, {
      wait: true,
      points: points.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    });

    logger.info({ count: points.length }, 'Successfully upserted vector chunks to Qdrant');
  }

  /**
   * Semantic vector similarity search using Qdrant Query API.
   * When options.itemId is provided, search is filtered to chunks belonging to that item.
   */
  async search(
    vector: number[],
    options?: {
      topK?: number;
      minSimilarity?: number;
      embeddingModel?: string;
      /** Optional item UUID to scope search to a single knowledge item */
      itemId?: string;
    }
  ): Promise<QdrantScoredPoint[]> {
    if (!this.client) {
      return [];
    }

    await this.initCollection();

    const limit = options?.topK ?? 5;
    const scoreThreshold = options?.minSimilarity ?? -1;

    const mustClauses: unknown[] = [];

    if (options?.embeddingModel) {
      mustClauses.push({
        key: 'embedding_model',
        match: { value: options.embeddingModel },
      });
    }

    if (options?.itemId) {
      mustClauses.push({
        key: 'item_id',
        match: { value: options.itemId },
      });
    }

    const filter: Record<string, unknown> = {};
    if (mustClauses.length > 0) {
      filter.must = mustClauses;
    }

    const queryResponse = await this.client.query(QDRANT_COLLECTION_NAME, {
      query: vector,
      limit,
      score_threshold: scoreThreshold > 0 ? scoreThreshold : undefined,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      with_payload: true,
    });

    const points = (queryResponse as { points?: { id: string | number; score: number; payload?: unknown }[] }).points || [];

    return points.map((p) => ({
      id: String(p.id),
      score: p.score,
      payload: p.payload as ChunkQdrantPayload | undefined,
    }));
  }

  /**
   * Delete vector points belonging to an item
   */
  async deleteByItemId(itemId: string): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      await this.initCollection();
      await this.client.delete(QDRANT_COLLECTION_NAME, {
        wait: true,
        filter: {
          must: [
            {
              key: 'item_id',
              match: { value: itemId },
            },
          ],
        },
      });
      logger.info({ itemId }, 'Deleted item vectors from Qdrant');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ itemId, error: message }, 'Failed to delete item vectors from Qdrant');
    }
  }

  /**
   * Delete specific point vectors by their IDs (e.g. for safe blue-green replacement cleanup)
   */
  async deletePoints(pointIds: string[]): Promise<void> {
    if (!this.client || pointIds.length === 0) return;

    try {
      await this.initCollection();
      await this.client.delete(QDRANT_COLLECTION_NAME, {
        wait: true,
        points: pointIds,
      });
      logger.info({ count: pointIds.length }, 'Deleted specific points from Qdrant');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ count: pointIds.length, error: message }, 'Failed to delete specific points from Qdrant');
      throw err;
    }
  }

  // In-memory registry of orphaned point IDs pending retry
  protected pendingOrphanedPointIds: Set<string> = new Set();

  // Mutex flag preventing concurrent cleanup cycles
  protected isCleanupRunning: boolean = false;

  // Failure tracking and backoff for durable recovery
  protected consecutiveCleanupFailures: number = 0;
  protected nextAllowedCleanupTime: number = 0;

  // Periodic cleanup scheduler timer handle
  protected periodicCleanupTimer: NodeJS.Timeout | null = null;

  /**
   * Queue point IDs that failed deletion for subsequent idempotent retry
   */
  queueFailedCleanup(pointIds: string[]): void {
    for (const id of pointIds) {
      this.pendingOrphanedPointIds.add(id);
    }
  }

  /**
   * Get all currently queued orphaned point IDs
   */
  getPendingOrphanedPointIds(): string[] {
    return Array.from(this.pendingOrphanedPointIds);
  }

  /**
   * Retries cleanup of all pending orphaned points idempotently.
   * Successfully deleted points are removed from the queue.
   */
  async retryFailedCleanups(): Promise<{ succeeded: number; failed: number }> {
    const idsToRetry = Array.from(this.pendingOrphanedPointIds);
    if (idsToRetry.length === 0) {
      return { succeeded: 0, failed: 0 };
    }

    try {
      await this.deletePoints(idsToRetry);
      this.pendingOrphanedPointIds.clear();
      logger.info({ count: idsToRetry.length }, 'Successfully retried cleanup of orphaned Qdrant points');
      return { succeeded: idsToRetry.length, failed: 0 };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ error: message, count: idsToRetry.length }, 'Retry cleanup of orphaned Qdrant points failed; remaining queued');
      return { succeeded: 0, failed: idsToRetry.length };
    }
  }

  /**
   * Retries cleanup of pending orphaned points stored in the durable database table.
   * Point deletion in Qdrant is idempotent.
   * Bounded batches: processes points in batches (default 50) up to maxBatchesPerRun (default 5).
   * Concurrency-safe: rejects or skips overlapping executions.
   * Backoff-aware: if previous attempts failed, defers retry unless force=true.
   * Kept records: cleanup records in Turso are only deleted after Qdrant confirms deletion.
   */
  async retryDurableCleanups(
    cleanupRepo: {
      findBatch?(limit: number): Promise<{ point_id: string; item_id: string; created_at: string }[]>;
      findAll?(): Promise<{ point_id: string; item_id: string; created_at: string }[]>;
      deleteByPointIds(pointIds: string[]): Promise<number>;
    },
    options?: {
      batchSize?: number;
      maxBatches?: number;
      force?: boolean;
    }
  ): Promise<{ succeeded: number; failed: number; skipped?: boolean; isRunning?: boolean }> {
    const batchSize = options?.batchSize ?? 50;
    const maxBatches = options?.maxBatches ?? 5;
    const force = options?.force ?? false;

    // 1. Backoff guard: check if in backoff cooldown
    const now = Date.now();
    if (!force && now < this.nextAllowedCleanupTime) {
      logger.debug(
        { nextAllowed: new Date(this.nextAllowedCleanupTime).toISOString() },
        'Durable cleanup in backoff cooldown; skipping this execution'
      );
      return { succeeded: 0, failed: 0, skipped: true };
    }

    // 2. Concurrency guard: prevent overlapping runs
    if (this.isCleanupRunning) {
      logger.debug('Durable cleanup is already in progress, skipping concurrent trigger');
      return { succeeded: 0, failed: 0, skipped: true, isRunning: true };
    }

    this.isCleanupRunning = true;
    let totalSucceeded = 0;
    let totalFailed = 0;

    try {
      for (let batchIndex = 0; batchIndex < maxBatches; batchIndex++) {
        // Fetch next bounded batch
        let batch: { point_id: string; item_id: string; created_at: string }[] = [];
        if (typeof cleanupRepo.findBatch === 'function') {
          batch = await cleanupRepo.findBatch(batchSize);
        } else if (typeof cleanupRepo.findAll === 'function') {
          const all = await cleanupRepo.findAll();
          batch = all.slice(0, batchSize);
        } else {
          break;
        }

        if (batch.length === 0) {
          // No more pending records
          break;
        }

        const pointIds = batch.map((p) => p.point_id);

        try {
          // 3. Attempt idempotent deletion in Qdrant
          await this.deletePoints(pointIds);

          // 4. Once Qdrant confirms deletion, remove records from Turso
          try {
            await cleanupRepo.deleteByPointIds(pointIds);
            logger.info(
              { count: pointIds.length, batchIndex },
              'Successfully purged pending vector cleanups from Qdrant and durable database'
            );
          } catch (dbErr) {
            logger.warn(
              { count: pointIds.length, dbErr },
              'Qdrant points purged, but failed to delete cleanup records from database; retry remains safe'
            );
          }

          totalSucceeded += pointIds.length;

          // If batch was smaller than batchSize, queue is drained
          if (batch.length < batchSize) {
            break;
          }
        } catch (qdrantErr: unknown) {
          const message = qdrantErr instanceof Error ? qdrantErr.message : String(qdrantErr);
          totalFailed += pointIds.length;

          // Backoff calculation: exponential backoff (5s, 10s, 20s, 40s... capped at 5 mins)
          this.consecutiveCleanupFailures++;
          const backoffDelay = Math.min(
            300_000,
            5000 * Math.pow(2, this.consecutiveCleanupFailures - 1)
          );
          this.nextAllowedCleanupTime = Date.now() + backoffDelay;

          logger.warn(
            {
              error: message,
              failedBatchCount: pointIds.length,
              consecutiveFailures: this.consecutiveCleanupFailures,
              backoffSeconds: backoffDelay / 1000,
            },
            'Durable vector cleanup batch failed; stopping run and applying backoff. Records preserved.'
          );

          // Immediately abort further batches during this run
          break;
        }
      }

      // If we had successes and no failures in this run, reset backoff
      if (totalFailed === 0 && totalSucceeded > 0) {
        this.consecutiveCleanupFailures = 0;
        this.nextAllowedCleanupTime = 0;
      }

      return { succeeded: totalSucceeded, failed: totalFailed };
    } finally {
      this.isCleanupRunning = false;
    }
  }

  /**
   * Starts periodic durable cleanup runner.
   * Runs in the background at the specified interval, bounded by concurrency and backoff.
   */
  startPeriodicCleanup(
    cleanupRepo: {
      findBatch?(limit: number): Promise<{ point_id: string; item_id: string; created_at: string }[]>;
      findAll?(): Promise<{ point_id: string; item_id: string; created_at: string }[]>;
      deleteByPointIds(pointIds: string[]): Promise<number>;
    },
    intervalMs = 30000,
    batchSize = 50
  ): void {
    if (this.periodicCleanupTimer) {
      return;
    }

    this.periodicCleanupTimer = setInterval(async () => {
      try {
        await this.retryDurableCleanups(cleanupRepo, { batchSize, force: false });
      } catch (err) {
        logger.warn({ err }, 'Error in periodic durable cleanup tick');
      }
    }, intervalMs);

    // unref so timer does not block process exit
    if (this.periodicCleanupTimer.unref) {
      this.periodicCleanupTimer.unref();
    }
    logger.info({ intervalMs, batchSize }, 'Periodic durable vector cleanup scheduler started');
  }

  /**
   * Stops periodic durable cleanup runner (for graceful shutdown or test teardown).
   */
  stopPeriodicCleanup(): void {
    if (this.periodicCleanupTimer) {
      clearInterval(this.periodicCleanupTimer);
      this.periodicCleanupTimer = null;
      logger.info('Periodic durable vector cleanup scheduler stopped');
    }
  }

  /**
   * Manual recovery trigger (bypasses backoff to immediately attempt cleanup).
   */
  async triggerManualCleanup(
    cleanupRepo: {
      findBatch?(limit: number): Promise<{ point_id: string; item_id: string; created_at: string }[]>;
      findAll?(): Promise<{ point_id: string; item_id: string; created_at: string }[]>;
      deleteByPointIds(pointIds: string[]): Promise<number>;
    },
    batchSize = 50
  ): Promise<{ succeeded: number; failed: number; skipped?: boolean }> {
    return this.retryDurableCleanups(cleanupRepo, { batchSize, force: true });
  }

  /**
   * Helper to inspect internal cleanup state (for tests and diagnostics)
   */
  getCleanupState(): {
    isRunning: boolean;
    consecutiveFailures: number;
    nextAllowedTime: number;
    hasActiveScheduler: boolean;
  } {
    return {
      isRunning: this.isCleanupRunning,
      consecutiveFailures: this.consecutiveCleanupFailures,
      nextAllowedTime: this.nextAllowedCleanupTime,
      hasActiveScheduler: this.periodicCleanupTimer !== null,
    };
  }

  /**
   * Health check probe
   */
  async checkHealth(): Promise<{ status: 'connected' | 'disconnected' | 'error'; error?: string }> {
    if (!this.client) {
      return { status: 'disconnected' };
    }

    try {
      await this.client.getCollections();
      return { status: 'connected' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'error', error: message };
    }
  }
}

export const defaultQdrantService = new QdrantService();

/**
 * Explicitly disabled Qdrant service for testing relational fallback pathways.
 */
export class DisabledQdrantService extends QdrantService {
  override isConfigured(): boolean {
    return false;
  }
}

/**
 * In-memory Mock Qdrant Service for isolated unit testing and offline development.
 */
export class MockQdrantService extends QdrantService {
  private points: Map<string, QdrantPointInput> = new Map();

  constructor() {
    super();
  }

  override isConfigured(): boolean {
    return true;
  }

  override async initCollection(): Promise<void> {
    // In-memory collection requires no remote initialization
  }

  override async upsertChunks(points: QdrantPointInput[]): Promise<void> {
    for (const point of points) {
      this.points.set(point.id, point);
    }
  }

  override async search(
    vector: number[],
    options?: {
      topK?: number;
      minSimilarity?: number;
      embeddingModel?: string;
      itemId?: string;
    }
  ): Promise<QdrantScoredPoint[]> {
    const limit = options?.topK ?? 5;
    const scoreThreshold = options?.minSimilarity ?? -1;
    const results: QdrantScoredPoint[] = [];

    for (const [id, point] of this.points.entries()) {
      if (options?.embeddingModel && point.payload?.embedding_model !== options.embeddingModel) {
        continue;
      }

      if (options?.itemId && point.payload?.item_id !== options.itemId) {
        continue;
      }

      // Compute cosine similarity in memory
      let dot = 0;
      let magA = 0;
      let magB = 0;
      for (let i = 0; i < vector.length && i < point.vector.length; i++) {
        dot += vector[i] * point.vector[i];
        magA += vector[i] * vector[i];
        magB += point.vector[i] * point.vector[i];
      }

      const similarity =
        magA === 0 || magB === 0 ? 0 : dot / (Math.sqrt(magA) * Math.sqrt(magB));

      if (similarity >= scoreThreshold) {
        results.push({
          id,
          score: similarity,
          payload: point.payload,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  override async deleteByItemId(itemId: string): Promise<void> {
    for (const [id, point] of this.points.entries()) {
      if (point.payload?.item_id === itemId) {
        this.points.delete(id);
      }
    }
  }

  override async deletePoints(pointIds: string[]): Promise<void> {
    for (const id of pointIds) {
      this.points.delete(id);
    }
  }

  override async checkHealth(): Promise<{ status: 'connected' | 'disconnected' | 'error'; error?: string }> {
    return { status: 'connected' };
  }

  clear(): void {
    this.points.clear();
  }

  getPointsCount(): number {
    return this.points.size;
  }
}
