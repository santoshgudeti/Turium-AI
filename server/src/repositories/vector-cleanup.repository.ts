import { Client } from '@libsql/client';
import { DatabaseSync } from 'node:sqlite';
import { getDatabase, wrapDatabaseSync } from '../db/connection';

export interface PendingVectorCleanup {
  point_id: string;
  item_id: string;
  created_at: string;
}

export class VectorCleanupRepository {
  private db: Client;

  constructor(customClient?: Client | DatabaseSync) {
    if (!customClient) {
      this.db = getDatabase();
    } else if ('execute' in customClient) {
      this.db = customClient as Client;
    } else {
      this.db = wrapDatabaseSync(customClient);
    }
  }

  /**
   * Insert multiple pending cleanup records
   */
  async insertMany(pointIds: string[], itemId: string): Promise<void> {
    if (pointIds.length === 0) return;
    const now = new Date().toISOString();
    const statements = pointIds.map((pointId) => ({
      sql: `
        INSERT INTO pending_vector_cleanups (point_id, item_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(point_id) DO NOTHING
      `,
      args: [pointId, itemId, now],
    }));
    await this.db.batch(statements, 'write');
  }

  /**
   * Find all currently pending cleanup records
   */
  async findAll(): Promise<PendingVectorCleanup[]> {
    const result = await this.db.execute(
      'SELECT point_id, item_id, created_at FROM pending_vector_cleanups ORDER BY created_at ASC'
    );
    return result.rows.map((r: any) => ({
      point_id: String(r.point_id),
      item_id: String(r.item_id),
      created_at: String(r.created_at),
    }));
  }

  /**
   * Find a bounded batch of pending cleanup records
   */
  async findBatch(limit = 50): Promise<PendingVectorCleanup[]> {
    const result = await this.db.execute({
      sql: 'SELECT point_id, item_id, created_at FROM pending_vector_cleanups ORDER BY created_at ASC LIMIT ?',
      args: [limit],
    });
    return result.rows.map((r: any) => ({
      point_id: String(r.point_id),
      item_id: String(r.item_id),
      created_at: String(r.created_at),
    }));
  }

  /**
   * Find pending cleanups by item ID
   */
  async findByItemId(itemId: string): Promise<PendingVectorCleanup[]> {
    const result = await this.db.execute({
      sql: 'SELECT point_id, item_id, created_at FROM pending_vector_cleanups WHERE item_id = ?',
      args: [itemId],
    });
    return result.rows.map((r: any) => ({
      point_id: String(r.point_id),
      item_id: String(r.item_id),
      created_at: String(r.created_at),
    }));
  }

  /**
   * Delete cleanup records by point IDs once successfully purged from Qdrant
   */
  async deleteByPointIds(pointIds: string[]): Promise<number> {
    if (pointIds.length === 0) return 0;
    const placeholders = pointIds.map(() => '?').join(', ');
    const result = await this.db.execute({
      sql: `DELETE FROM pending_vector_cleanups WHERE point_id IN (${placeholders})`,
      args: pointIds,
    });
    return Number(result.rowsAffected || 0);
  }

  /**
   * Count total pending cleanups
   */
  async count(): Promise<number> {
    const result = await this.db.execute('SELECT COUNT(*) as count FROM pending_vector_cleanups');
    return Number((result.rows[0] as any)?.count || 0);
  }
}
