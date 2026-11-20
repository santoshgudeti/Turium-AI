import { Client, Row } from '@libsql/client';
import crypto from 'node:crypto';
import { getDatabase, wrapDatabaseSync } from '../db/connection';
import { Item, ItemSummary, CreateItemInput, ItemStatus } from '../types/database.types';

function rowToItem(row: Row): Item {
  return {
    id: String(row.id),
    source_type: row.source_type as Item['source_type'],
    title: row.title !== null && row.title !== undefined ? String(row.title) : null,
    source_url: row.source_url !== null && row.source_url !== undefined ? String(row.source_url) : null,
    raw_content: String(row.raw_content),
    status: row.status as ItemStatus,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToItemSummary(row: Row): ItemSummary {
  return {
    id: String(row.id),
    source_type: row.source_type as ItemSummary['source_type'],
    title: row.title !== null && row.title !== undefined ? String(row.title) : null,
    source_url: row.source_url !== null && row.source_url !== undefined ? String(row.source_url) : null,
    status: row.status as ItemStatus,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    chunk_count: Number(row.chunk_count || 0),
  };
}

export class ItemRepository {
  private db: Client;

  constructor(db?: Client | any) {
    if (db && typeof db.prepare === 'function' && typeof db.execute !== 'function') {
      this.db = wrapDatabaseSync(db);
    } else {
      this.db = db || getDatabase();
    }
  }

  /**
   * Persist a new knowledge item (note or scraped URL)
   */
  async create(input: CreateItemInput): Promise<Item> {
    const id = input.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const status: ItemStatus = input.status || 'pending';

    await this.db.execute({
      sql: `
        INSERT INTO items (
          id, source_type, title, source_url, raw_content, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        input.source_type,
        input.title || null,
        input.source_url || null,
        input.raw_content ?? '',
        status,
        now,
        now,
      ],
    });

    return {
      id,
      source_type: input.source_type,
      title: input.title || null,
      source_url: input.source_url || null,
      raw_content: input.raw_content,
      status,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Find an item by its unique ID
   */
  async findById(id: string): Promise<Item | null> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM items WHERE id = ?',
      args: [id],
    });

    if (result.rows.length === 0) {
      return null;
    }

    return rowToItem(result.rows[0]);
  }

  /**
   * Find an existing item by its source URL.
   * Matches scheme and hostname case-insensitively, and handles trailing slash differences,
   * while STRICTLY preserving character casing in paths and query parameter names/values.
   */
  async findBySourceUrl(sourceUrl: string): Promise<Item | null> {
    const trimmed = sourceUrl.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = new URL(trimmed);
      const originLower = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}`;
      const pathWithSlash = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
      const pathWithoutSlash = parsed.pathname.replace(/\/+$/, '') || '/';
      const targetQuery = parsed.search || '';

      const pathExact = `${parsed.pathname}${targetQuery}`;
      const pathSlashQuery = `${pathWithSlash}${targetQuery}`;
      const pathNoSlashQuery = `${pathWithoutSlash}${targetQuery}`;

      const fullExact = `${originLower}${pathExact}`;
      const fullWithSlash = `${originLower}${pathSlashQuery}`;
      const fullWithoutSlash = `${originLower}${pathNoSlashQuery}`;

      // 1. Direct exact candidate match
      const exactResult = await this.db.execute({
        sql: `
          SELECT * FROM items 
          WHERE source_type = 'url' 
            AND (source_url = ? OR source_url = ? OR source_url = ? OR source_url = ?)
          ORDER BY 
            CASE WHEN source_url = ? THEN 0 ELSE 1 END,
            created_at DESC 
          LIMIT 1
        `,
        args: [trimmed, fullExact, fullWithoutSlash, fullWithSlash, trimmed],
      });

      if (exactResult.rows.length > 0) {
        return rowToItem(exactResult.rows[0]);
      }

      // 2. Legacy scheme/hostname case-insensitivity:
      // Origin (scheme + host) is compared via LOWER(),
      // while path and query string are compared with strict case-sensitivity.
      const originLen = originLower.length;
      const legacyResult = await this.db.execute({
        sql: `
          SELECT * FROM items 
          WHERE source_type = 'url'
            AND LOWER(SUBSTR(source_url, 1, ?)) = ?
            AND (
              SUBSTR(source_url, ? + 1) = ?
              OR SUBSTR(source_url, ? + 1) = ?
              OR SUBSTR(source_url, ? + 1) = ?
            )
          ORDER BY created_at DESC LIMIT 1
        `,
        args: [
          originLen,
          originLower,
          originLen,
          pathExact,
          originLen,
          pathNoSlashQuery,
          originLen,
          pathSlashQuery,
        ],
      });

      if (legacyResult.rows.length > 0) {
        return rowToItem(legacyResult.rows[0]);
      }

      return null;
    } catch {
      // Fallback for non-standard URL strings
      const withSlash = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
      const withoutSlash = trimmed.replace(/\/+$/, '');
      const fallbackResult = await this.db.execute({
        sql: `
          SELECT * FROM items 
          WHERE source_url = ? OR source_url = ? OR source_url = ?
          ORDER BY created_at DESC LIMIT 1
        `,
        args: [trimmed, withSlash, withoutSlash],
      });
      return fallbackResult.rows.length > 0 ? rowToItem(fallbackResult.rows[0]) : null;
    }
  }

  /**
   * List all saved knowledge items, ordered by creation date descending
   */
  async findAll(): Promise<Item[]> {
    const result = await this.db.execute('SELECT * FROM items ORDER BY created_at DESC');
    return result.rows.map(rowToItem);
  }

  /**
   * List item summaries including chunk counts, omitting large raw_content
   */
  async findAllSummaries(): Promise<ItemSummary[]> {
    const result = await this.db.execute(`
      SELECT 
        i.id,
        i.source_type,
        i.title,
        i.source_url,
        i.status,
        i.created_at,
        i.updated_at,
        CAST(COUNT(c.id) AS INTEGER) AS chunk_count
      FROM items i
      LEFT JOIN chunks c ON i.id = c.item_id
      GROUP BY i.id
      ORDER BY i.created_at DESC
    `);
    return result.rows.map(rowToItemSummary);
  }

  /**
   * Update the ingestion/processing status of an item
   */
  async updateStatus(id: string, status: ItemStatus): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db.execute({
      sql: `
        UPDATE items
        SET status = ?, updated_at = ?
        WHERE id = ?
      `,
      args: [status, now, id],
    });

    return Number(result.rowsAffected) > 0;
  }

  /**
   * Update content, title, source_url and status of an existing item (e.g. during re-ingestion)
   */
  async updateContentAndStatus(
    id: string,
    update: {
      title?: string | null;
      source_url?: string | null;
      raw_content: string;
      status: ItemStatus;
    }
  ): Promise<Item | null> {
    const now = new Date().toISOString();
    await this.db.execute({
      sql: `
        UPDATE items
        SET title = ?, source_url = ?, raw_content = ?, status = ?, updated_at = ?
        WHERE id = ?
      `,
      args: [
        update.title || null,
        update.source_url || null,
        update.raw_content ?? '',
        update.status,
        now,
        id,
      ],
    });

    return this.findById(id);
  }

  /**
   * Update the updated_at timestamp without modifying content or status
   */
  async touchUpdatedAt(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute({
      sql: 'UPDATE items SET updated_at = ? WHERE id = ?',
      args: [now, id],
    });
  }

  /**
   * Delete an item and automatically cascade deletion to all its chunks
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.db.execute({
      sql: 'DELETE FROM items WHERE id = ?',
      args: [id],
    });

    return Number(result.rowsAffected) > 0;
  }

  /**
   * Safely and atomically delete an item and all its associated chunks in a single transaction batch.
   */
  async deleteWithChunks(id: string): Promise<boolean> {
    const statements = [
      { sql: 'DELETE FROM chunks WHERE item_id = ?', args: [id] },
      { sql: 'DELETE FROM items WHERE id = ?', args: [id] },
    ];
    await this.db.batch(statements, 'write');
    return true;
  }

  /**
   * Safely and atomically registers pending Qdrant point cleanup records,
   * deletes all associated chunks, and deletes the parent item within a single
   * all-or-nothing transaction batch.
   */
  async deleteWithChunksAndRegisterCleanup(
    itemId: string,
    chunkPointIds: string[]
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const statements: { sql: string; args: any[] }[] = [];

    // 1. Insert pending cleanup records for all associated Qdrant vector points
    for (const pointId of chunkPointIds) {
      statements.push({
        sql: `
          INSERT INTO pending_vector_cleanups (point_id, item_id, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT(point_id) DO NOTHING
        `,
        args: [pointId, itemId, now],
      });
    }

    // 2. Delete item's chunks
    statements.push({
      sql: 'DELETE FROM chunks WHERE item_id = ?',
      args: [itemId],
    });

    // 3. Delete parent item
    statements.push({
      sql: 'DELETE FROM items WHERE id = ?',
      args: [itemId],
    });

    await this.db.batch(statements, 'write');
    return true;
  }
}
