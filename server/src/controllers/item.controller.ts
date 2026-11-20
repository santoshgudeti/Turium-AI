import { Request, Response, NextFunction } from 'express';
import { ItemRepository } from '../repositories/item.repository';
import { ChunkRepository } from '../repositories/chunk.repository';
import { VectorCleanupRepository } from '../repositories/vector-cleanup.repository';
import { QdrantService, defaultQdrantService } from '../services/qdrant.service';
import { ItemIdParamSchema } from '../schemas/item.schema';
import { AppError } from '../middleware/error-handler.middleware';
import { logger } from '../utils/logger';

export class ItemController {
  constructor(
    private itemRepo = new ItemRepository(),
    private chunkRepo = new ChunkRepository(),
    private qdrantService: QdrantService = defaultQdrantService,
    private cleanupRepo = new VectorCleanupRepository()
  ) {}

  getItems = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const items = await this.itemRepo.findAllSummaries();
      res.status(200).json({
        status: 'success',
        data: {
          items,
          total: items.length,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  getItemById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ItemIdParamSchema.parse(req.params);
      const id = parsed.id;
      const item = await this.itemRepo.findById(id);

      if (!item) {
        throw new AppError(404, `Item with ID '${id}' not found`);
      }

      const chunks = await this.chunkRepo.findByItemId(id);

      res.status(200).json({
        status: 'success',
        data: {
          item,
          chunks,
          chunk_count: chunks.length,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  deleteItem = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = ItemIdParamSchema.parse(req.params);
      const id = parsed.id;

      // 1. Check if item exists in Turso
      const item = await this.itemRepo.findById(id);
      if (!item) {
        throw new AppError(404, `Item with ID '${id}' not found`);
      }

      // 2. Fetch all chunk IDs belonging to this item
      const chunks = await this.chunkRepo.findByItemId(id);
      const chunkIds = chunks.map((c) => c.id);

      // 3. ATOMIC TURSO TRANSACTION:
      // Inserts all associated Qdrant point IDs into pending_vector_cleanups,
      // deletes the item's chunks, and deletes the parent item record.
      // All operations commit or roll back together.
      // If this transaction fails, the original item, chunks, and Qdrant vectors remain 100% intact.
      await this.itemRepo.deleteWithChunksAndRegisterCleanup(id, chunkIds);

      logger.info(
        { itemId: id, deletedChunks: chunkIds.length },
        'Item and chunks atomically deleted from Turso; cleanup records committed to pending_vector_cleanups'
      );

      // 4. QDRANT CLEANUP:
      // After the Turso transaction commits, attempt Qdrant deletion using the recorded point IDs.
      let vectorCleanupCompleted = true;
      if (this.qdrantService.isConfigured() && chunkIds.length > 0) {
        try {
          await this.qdrantService.deletePoints(chunkIds);

          // On success, remove the corresponding cleanup records from Turso
          try {
            await this.cleanupRepo.deleteByPointIds(chunkIds);
            logger.info(
              { itemId: id, count: chunkIds.length },
              'Successfully deleted vector points from Qdrant and removed cleanup records from database'
            );
          } catch (cleanupDbErr) {
            // If Qdrant deletion succeeds but deleting cleanup records fails,
            // a subsequent retry remains safe because deletePoints in Qdrant is idempotent.
            logger.warn(
              { itemId: id, count: chunkIds.length, cleanupDbErr },
              'Vectors deleted from Qdrant, but failed to delete cleanup records from database; retry remains safe'
            );
          }
        } catch (qdrantErr: unknown) {
          vectorCleanupCompleted = false;
          const errorMsg = qdrantErr instanceof Error ? qdrantErr.message : String(qdrantErr);
          // On failure, preserve the cleanup records in Turso and log structured warning
          logger.warn(
            {
              event: 'QDRANT_VECTOR_CLEANUP_FAILED_POST_TURSO_COMMIT',
              itemId: id,
              orphanedPointIds: chunkIds,
              error: errorMsg,
            },
            'Item deleted from database, but Qdrant vector deletion failed; records preserved in pending_vector_cleanups'
          );
        }
      }

      // 5. STRUCTURED RESPONSE:
      // Return explicit status indicating database_deleted and vector_cleanup_completed
      if (vectorCleanupCompleted) {
        res.status(200).json({
          status: 'success',
          message: 'Item and associated chunks and vectors deleted successfully',
          data: {
            id,
            deleted_chunks: chunkIds.length,
            database_deleted: true,
            vector_cleanup_completed: true,
            status: 'success',
          },
        });
      } else {
        res.status(207).json({
          status: 'partial_success',
          code: 'VECTOR_CLEANUP_PENDING',
          message:
            'Item was removed from the database, but vector cleanup in Qdrant is pending retry.',
          data: {
            id,
            deleted_chunks: chunkIds.length,
            database_deleted: true,
            vector_cleanup_completed: false,
            status: 'partial_success',
            code: 'VECTOR_CLEANUP_PENDING',
            orphaned_point_ids: chunkIds,
          },
        });
      }
    } catch (err) {
      next(err);
    }
  };
}

const defaultItemController = new ItemController();
export const getItems = defaultItemController.getItems;
export const getItemById = defaultItemController.getItemById;
export const deleteItem = defaultItemController.deleteItem;
