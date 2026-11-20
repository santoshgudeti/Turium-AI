import express, { Application } from 'express';
import cors from 'cors';
import { config } from './config/env';
import { requestLogger } from './middleware/request-logger.middleware';
import { errorHandler } from './middleware/error-handler.middleware';
import { apiRouter } from './routes';
import { getHealth } from './controllers/health.controller';

export const createApp = (): Application => {
  const app = express();

  // Basic Security & Cross-Origin
  app.use(
    cors({
      origin: (requestOrigin, callback) => {
        if (!requestOrigin) return callback(null, true);

        const cleanRequest = requestOrigin.replace(/\/+$/, '');
        const cleanConfigured = config.CLIENT_ORIGIN ? config.CLIENT_ORIGIN.replace(/\/+$/, '') : '';

        // Allow configured origin, any onrender.com origin, or localhost
        if (
          cleanRequest === cleanConfigured ||
          cleanRequest.endsWith('.onrender.com') ||
          cleanRequest.includes('localhost') ||
          cleanRequest.includes('127.0.0.1')
        ) {
          return callback(null, true);
        }

        callback(null, false);
      },
      credentials: true,
    })
  );

  // Parsing & Logging
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  // Health check and API routes (accessible directly and under /api)
  app.get('/health', getHealth);
  app.use('/api', apiRouter);
  app.use(apiRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({
      status: 'error',
      code: 'NOT_FOUND',
      message: 'Requested route was not found on this server',
    });
  });

  // Centralized Error Handling
  app.use(errorHandler);

  return app;
};
