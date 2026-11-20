import crypto from 'node:crypto';
import { ChunkRepository } from '../repositories/chunk.repository';
import { EmbeddingProvider, defaultEmbeddingProvider } from './embedding.service';
import { QdrantService, defaultQdrantService } from './qdrant.service';
import { SourceType, ChunkWithMetadata } from '../types/database.types';
import { logger } from '../utils/logger';

export interface ScoredChunk {
  chunk_id: string;
  chunk_index: number;
  content: string;
  similarity: number;
  item_id: string;
  item_title: string | null;
  item_source_type: SourceType;
  item_source_url: string | null;
}

export interface RetrievalOptions {
  topK?: number;
  minSimilarity?: number;
  /**
   * Optional item UUID to restrict retrieval to a single knowledge item.
   * When provided, Qdrant search and relational fallback are both scoped
   * to chunks belonging to that item only.
   */
  itemId?: string;
}

/**
 * Computes a deterministic SHA-256 fingerprint from chunk content,
 * normalizing leading/trailing whitespace and internal whitespace runs
 * while strictly preserving character case and semantic content.
 */
export function computeContentFingerprint(content: string): string {
  const normalized = content.trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Computes cosine similarity between two numeric vectors
 * cos(theta) = (A . B) / (||A|| * ||B||)
 * Safely handles zero-magnitude vectors and dimension mismatches
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(-1, Math.min(1, similarity));
}

/**
 * Vector Retrieval Service
 * Performs semantic similarity search using Qdrant Cloud with Turso hydration,
 * and preserves in-process relational cosine scans as an automatic fallback.
 */
export class RetrievalService {
  private chunkRepo: ChunkRepository;
  private embeddingProvider: EmbeddingProvider;
  private qdrantService: QdrantService;

  constructor(
    chunkRepo?: ChunkRepository,
    embeddingProvider?: EmbeddingProvider,
    qdrantService?: QdrantService
  ) {
    this.chunkRepo = chunkRepo || new ChunkRepository();
    this.embeddingProvider = embeddingProvider || defaultEmbeddingProvider;
    this.qdrantService = qdrantService || defaultQdrantService;
  }

  /**
   * Retrieve the top-K semantically relevant chunks for a given query string.
   * When options.itemId is provided, retrieval is scoped to that item only.
   * Duplicate chunks from re-ingested identical sources are deduplicated before
   * slicing to topK, ensuring diverse results rather than near-identical duplicates.
   */
  async retrieve(query: string, options?: RetrievalOptions): Promise<ScoredChunk[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return [];
    }

    const topK = options?.topK ?? 5;
    const minSimilarity = options?.minSimilarity ?? -1;
    const itemId = options?.itemId;

    // 1. Generate query embedding vector
    const queryVector = await this.embeddingProvider.generateEmbedding(trimmedQuery);

    // 2. Fast Path: Dedicated Vector Database (Qdrant Cloud) with Turso Hydration
    if (this.qdrantService.isConfigured()) {
      try {
        const qdrantResults = await this.qdrantService.search(queryVector, {
          topK: topK * 3, // Fetch extra candidates to allow for deduplication and orphan drops
          minSimilarity,
          embeddingModel: this.embeddingProvider.modelName,
          itemId,
        });

        if (qdrantResults.length > 0) {
          // 3. Hydrate chunk records from Turso (Source of Truth)
          const chunkIds = qdrantResults.map((p) => p.id);
          const hydratedChunks = await this.chunkRepo.findByIds(chunkIds);

          const hydratedMap = new Map<string, ChunkWithMetadata>();
          for (const chunk of hydratedChunks) {
            hydratedMap.set(chunk.id, chunk);
          }

          // 4. Align with Qdrant similarity scores and preserve ranking order
          // Deduplicate by content key (source + chunk_index) to handle re-ingested duplicates
          const seenContentKeys = new Set<string>();
          const scored: ScoredChunk[] = [];

          for (const point of qdrantResults) {
            const chunk = hydratedMap.get(point.id);
            // Drop orphaned points (not in Turso or parent item not completed)
            if (!chunk) {
              continue;
            }

            // Drop if itemId filter is set but chunk belongs to different item
            if (itemId && chunk.item_id !== itemId) {
              continue;
            }

            // Deduplicate: skip if identical content from same source position already added from duplicate ingestion
            const contentKey = `${chunk.item_source_url ?? chunk.item_id}::${computeContentFingerprint(chunk.content)}`;
            if (seenContentKeys.has(contentKey)) {
              continue;
            }
            seenContentKeys.add(contentKey);

            scored.push({
              chunk_id: chunk.id,
              chunk_index: chunk.chunk_index,
              content: chunk.content,
              similarity: point.score,
              item_id: chunk.item_id,
              item_title: chunk.item_title,
              item_source_type: chunk.item_source_type,
              item_source_url: chunk.item_source_url,
            });

            if (scored.length >= topK) {
              break;
            }
          }

          if (scored.length > 0) {
            logger.info(
              {
                queryLength: trimmedQuery.length,
                qdrantCandidates: qdrantResults.length,
                hydratedCount: scored.length,
                topScore: scored[0].similarity,
                scopedToItem: itemId ?? 'global',
              },
              'Qdrant vector retrieval and Turso hydration completed'
            );

            return scored;
          }
        }
      } catch (err: unknown) {
        logger.warn(
          { err },
          'Qdrant search encountered non-fatal error; falling back to relational vector retrieval'
        );
      }
    }

    // 5. Fallback Path: In-process Cosine Similarity over relational records
    const candidates = await this.chunkRepo.findAllForRetrieval(
      this.embeddingProvider.modelName,
      itemId
    );

    if (candidates.length === 0) {
      logger.info(
        { queryLength: trimmedQuery.length, scopedToItem: itemId ?? 'global' },
        'No eligible indexed chunks available for retrieval'
      );
      return [];
    }

    const seenContentKeys = new Set<string>();
    const scored: ScoredChunk[] = [];

    for (const chunk of candidates) {
      if (!chunk.embedding) {
        continue;
      }

      let candidateVector: number[];
      try {
        candidateVector = JSON.parse(chunk.embedding);
      } catch {
        logger.warn({ chunkId: chunk.id }, 'Skipping chunk with unparseable embedding JSON');
        continue;
      }

      if (!Array.isArray(candidateVector) || candidateVector.length !== queryVector.length) {
        continue;
      }

      const hasInvalidNumbers = candidateVector.some(
        (v) => typeof v !== 'number' || !Number.isFinite(v)
      );
      if (hasInvalidNumbers) {
        continue;
      }

      const score = cosineSimilarity(queryVector, candidateVector);

      if (score >= minSimilarity) {
        // Deduplicate by content key
        const contentKey = `${chunk.item_source_url ?? chunk.item_id}::${computeContentFingerprint(chunk.content)}`;
        if (!seenContentKeys.has(contentKey)) {
          seenContentKeys.add(contentKey);
          scored.push({
            chunk_id: chunk.id,
            chunk_index: chunk.chunk_index,
            content: chunk.content,
            similarity: score,
            item_id: chunk.item_id,
            item_title: chunk.item_title,
            item_source_type: chunk.item_source_type,
            item_source_url: chunk.item_source_url,
          });
        }
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    const results = scored.slice(0, topK);

    logger.info(
      {
        queryLength: trimmedQuery.length,
        candidateCount: candidates.length,
        matchedCount: results.length,
        topScore: results.length > 0 ? results[0].similarity : null,
        scopedToItem: itemId ?? 'global',
      },
      'Relational in-process vector retrieval completed'
    );

    return results;
  }
}
