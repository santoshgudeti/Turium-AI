import { Client, Row } from '@libsql/client';
import crypto from 'node:crypto';
import { getDatabase, wrapDatabaseSync } from '../db/connection';
import { Chunk, ChunkWithMetadata, CreateChunkInput, SourceType } from '../types/database.types';

function rowToChunk(row: Row): Chunk {
  return {
    id: String(row.id),
    item_id: String(row.item_id),
    chunk_index: Number(row.chunk_index),
    content: String(row.content),
    embedding: row.embedding !== null && row.embedding !== undefined ? String(row.embedding) : null,
    embedding_model: row.embedding_model !== null && row.embedding_model !== undefined ? String(row.embedding_model) : null,
    embedding_dimensions: row.embedding_dimensions !== null && row.embedding_dimensions !== undefined ? Number(row.embedding_dimensions) : null,
    created_at: String(row.created_at),
  };
}

function rowToChunkWithMetadata(row: Row): ChunkWithMetadata {
  return {
    ...rowToChunk(row),
    item_title: row.item_title !== null && row.item_title !== undefined ? String(row.item_title) : null,
    item_source_url: row.item_source_url !== null && row.item_source_url !== undefined ? String(row.item_source_url) : null,
    item_source_type: row.item_source_type as SourceType,
  };
}

export class ChunkRepository {
  private db: Client;

  constructor(db?: Client | any) {
    if (db && typeof db.prepare === 'function' && typeof db.execute !== 'function') {
      this.db = wrapDatabaseSync(db);
    } else {
      this.db = db || getDatabase();
    }
  }

  /**
   * Insert multiple content chunks inside an atomic batch transaction
   */
  async createMany(chunks: CreateChunkInput[]): Promise<Chunk[]> {
    if (chunks.length === 0) {
      return [];
    }

    const insertedChunks: Chunk[] = [];
    const now = new Date().toISOString();

    const statements = chunks.map((chunk) => {
      const id = chunk.id || crypto.randomUUID();
      const embedding = chunk.embedding || null;
      const embeddingModel = chunk.embedding_model || null;
      const embeddingDimensions = chunk.embedding_dimensions ?? null;

      insertedChunks.push({
        id,
        item_id: chunk.item_id,
        chunk_index: chunk.chunk_index,
        content: chunk.content,
        embedding,
        embedding_model: embeddingModel,
        embedding_dimensions: embeddingDimensions,
        created_at: now,
      });

      return {
        sql: `
          INSERT INTO chunks (
            id, item_id, chunk_index, content, embedding, embedding_model, embedding_dimensions, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          id,
          chunk.item_id,
          chunk.chunk_index,
          chunk.content,
          embedding,
          embeddingModel,
          embeddingDimensions,
          now,
        ],
      };
    });

    await this.db.batch(statements, 'write');
    return insertedChunks;
  }

  /**
   * Retrieve a chunk by its unique ID
   */
  async findById(id: string): Promise<Chunk | null> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM chunks WHERE id = ?',
      args: [id],
    });

    if (result.rows.length === 0) {
      return null;
    }

    return rowToChunk(result.rows[0]);
  }

  /**
   * Retrieve all chunks belonging to a specific parent item, ordered by chunk index
   */
  async findByItemId(itemId: string): Promise<Chunk[]> {
    const result = await this.db.execute({
      sql: `
        SELECT * FROM chunks
        WHERE item_id = ?
        ORDER BY chunk_index ASC
      `,
      args: [itemId],
    });

    return result.rows.map(rowToChunk);
  }

  /**
   * Retrieve chunks by an array of IDs and enrich with parent item metadata
   * Used for hydrating Qdrant search results from Turso (Source of Truth)
   */
  async findByIds(ids: string[]): Promise<ChunkWithMetadata[]> {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => '?').join(', ');
    const result = await this.db.execute({
      sql: `
        SELECT 
          c.id,
          c.item_id,
          c.chunk_index,
          c.content,
          c.embedding,
          c.embedding_model,
          c.embedding_dimensions,
          c.created_at,
          i.title AS item_title,
          i.source_url AS item_source_url,
          i.source_type AS item_source_type
        FROM chunks c
        JOIN items i ON c.item_id = i.id
        WHERE c.id IN (${placeholders})
          AND i.status = 'completed'
      `,
      args: ids,
    });

    return result.rows.map(rowToChunkWithMetadata);
  }

  /**
   * Update the embedding vector and metadata for an existing chunk
   */
  async updateEmbedding(
    id: string,
    embedding: string,
    model: string,
    dimensions: number
  ): Promise<void> {
    await this.db.execute({
      sql: `
        UPDATE chunks
        SET embedding = ?, embedding_model = ?, embedding_dimensions = ?
        WHERE id = ?
      `,
      args: [embedding, model, dimensions, id],
    });
  }

  /**
   * Retrieve all chunks across completed items for semantic vector retrieval,
   * optionally filtered by embedding model and/or a specific item ID, enriched with parent item metadata.
   */
  async findAllForRetrieval(modelName?: string, itemId?: string): Promise<ChunkWithMetadata[]> {
    if (modelName) {
      const sql = itemId
        ? `
          SELECT 
            c.id,
            c.item_id,
            c.chunk_index,
            c.content,
            c.embedding,
            c.embedding_model,
            c.embedding_dimensions,
            c.created_at,
            i.title AS item_title,
            i.source_url AS item_source_url,
            i.source_type AS item_source_type
          FROM chunks c
          JOIN items i ON c.item_id = i.id
          WHERE i.status = 'completed'
            AND c.embedding IS NOT NULL
            AND c.embedding_model = ?
            AND c.item_id = ?
          ORDER BY c.item_id, c.chunk_index ASC
        `
        : `
          SELECT 
            c.id,
            c.item_id,
            c.chunk_index,
            c.content,
            c.embedding,
            c.embedding_model,
            c.embedding_dimensions,
            c.created_at,
            i.title AS item_title,
            i.source_url AS item_source_url,
            i.source_type AS item_source_type
          FROM chunks c
          JOIN items i ON c.item_id = i.id
          WHERE i.status = 'completed'
            AND c.embedding IS NOT NULL
            AND c.embedding_model = ?
          ORDER BY c.item_id, c.chunk_index ASC
        `;
      const args: (string)[] = itemId ? [modelName, itemId] : [modelName];
      const result = await this.db.execute({ sql, args });
      return result.rows.map(rowToChunkWithMetadata);
    }

    if (itemId) {
      const result = await this.db.execute({
        sql: `
          SELECT 
            c.id,
            c.item_id,
            c.chunk_index,
            c.content,
            c.embedding,
            c.embedding_model,
            c.embedding_dimensions,
            c.created_at,
            i.title AS item_title,
            i.source_url AS item_source_url,
            i.source_type AS item_source_type
          FROM chunks c
          JOIN items i ON c.item_id = i.id
          WHERE i.status = 'completed'
            AND c.item_id = ?
          ORDER BY c.item_id, c.chunk_index ASC
        `,
        args: [itemId],
      });
      return result.rows.map(rowToChunkWithMetadata);
    }

    const result = await this.db.execute(`
      SELECT 
        c.id,
        c.item_id,
        c.chunk_index,
        c.content,
        c.embedding,
        c.embedding_model,
        c.embedding_dimensions,
        c.created_at,
        i.title AS item_title,
        i.source_url AS item_source_url,
        i.source_type AS item_source_type
      FROM chunks c
      JOIN items i ON c.item_id = i.id
      WHERE i.status = 'completed'
      ORDER BY c.item_id, c.chunk_index ASC
    `);
    return result.rows.map(rowToChunkWithMetadata);
  }

  /**
   * Delete all chunks belonging to an item manually
   */
  async deleteByItemId(itemId: string): Promise<number> {
    const result = await this.db.execute({
      sql: 'DELETE FROM chunks WHERE item_id = ?',
      args: [itemId],
    });
    return Number(result.rowsAffected);
  }

  /**
   * Count total chunks for an item
   */
  async countByItemId(itemId: string): Promise<number> {
    const result = await this.db.execute({
      sql: 'SELECT COUNT(*) as count FROM chunks WHERE item_id = ?',
      args: [itemId],
    });
    return Number((result.rows[0] as any)?.count || 0);
  }

  /**
   * Atomically replace all chunks for an item inside a single transaction batch.
   */
  async replaceChunksForItem(
    itemId: string,
    chunks: (Omit<Chunk, 'id' | 'created_at'> & { id?: string })[]
  ): Promise<Chunk[]> {
    const now = new Date().toISOString();
    const insertedChunks: Chunk[] = [];

    const statements: { sql: string; args: any[] }[] = [
      {
        sql: 'DELETE FROM chunks WHERE item_id = ?',
        args: [itemId],
      },
    ];

    for (const chunk of chunks) {
      const id = chunk.id || crypto.randomUUID();
      const embedding = chunk.embedding || null;
      const embeddingModel = chunk.embedding_model || null;
      const embeddingDimensions = chunk.embedding_dimensions ?? null;

      insertedChunks.push({
        id,
        item_id: itemId,
        chunk_index: chunk.chunk_index,
        content: chunk.content,
        embedding,
        embedding_model: embeddingModel,
        embedding_dimensions: embeddingDimensions,
        created_at: now,
      });

      statements.push({
        sql: `
          INSERT INTO chunks (
            id, item_id, chunk_index, content, embedding, embedding_model, embedding_dimensions, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          id,
          itemId,
          chunk.chunk_index,
          chunk.content,
          embedding,
          embeddingModel,
          embeddingDimensions,
          now,
        ],
      });
    }

    await this.db.batch(statements, 'write');
    return insertedChunks;
  }
}
