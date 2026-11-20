import { createApp } from './app';
import { config } from './config/env';
import { logger } from './utils/logger';
import { initDatabase, closeDatabase } from './db';
import { defaultQdrantService } from './services/qdrant.service';
import { VectorCleanupRepository } from './repositories/vector-cleanup.repository';

const bootstrap = async (): Promise<void> => {
  // Initialize database schema (Turso / libSQL or SQLite fallback)
  await initDatabase();

  // If Qdrant is configured, initialize vector collection idempotently and retry pending cleanups
  if (defaultQdrantService.isConfigured()) {
    try {
      await defaultQdrantService.initCollection();
      const cleanupRepo = new VectorCleanupRepository();
      const retryResult = await defaultQdrantService.retryDurableCleanups(cleanupRepo);
      if (retryResult.succeeded > 0 || retryResult.failed > 0) {
        logger.info(
          retryResult,
          'Durable vector cleanup recovery executed on server startup'
        );
      }
      // Start lightweight recurring cleanup scheduler (every 30s) for restart-resilience and transient failure recovery
      defaultQdrantService.startPeriodicCleanup(cleanupRepo, 30000);
    } catch (err: unknown) {
      logger.warn({ err }, 'Qdrant collection init or durable cleanup retry deferred on bootstrap');
    }
  }

  const app = createApp();

  const server = app.listen(config.PORT, () => {
    logger.info(
      {
        port: config.PORT,
        env: config.NODE_ENV,
        healthCheck: `http://localhost:${config.PORT}/health`,
      },
      `🚀 Server successfully started and listening on port ${config.PORT}`
    );
  });

  // Graceful Shutdown handling
  const handleShutdown = (signal: string) => {
    logger.info(`Received ${signal}. Shutting down server gracefully...`);
    defaultQdrantService.stopPeriodicCleanup();
    server.close(() => {
      closeDatabase();
      logger.info('HTTP server and database connection closed successfully.');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Forceful shutdown triggered after timeout.');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
};

bootstrap().catch((err) => {
  logger.error({ err }, 'Fatal bootstrap failure');
  process.exit(1);
});
