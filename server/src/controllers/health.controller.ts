import { Request, Response } from 'express';
import { getDatabase, isTursoConfigured } from '../db/connection';
import { defaultQdrantService } from '../services/qdrant.service';
import { config } from '../config/env';

export const getHealth = async (_req: Request, res: Response): Promise<void> => {
  let dbStatus: 'connected' | 'disconnected' | 'error' = 'disconnected';

  // 1. Probe relational database (Turso / libSQL or SQLite fallback)
  try {
    const db = getDatabase();
    const result = await db.execute('SELECT 1 as alive');
    if (result.rows.length > 0 && Number(result.rows[0].alive) === 1) {
      dbStatus = 'connected';
    }
  } catch {
    dbStatus = 'error';
  }

  // 2. Probe Qdrant vector database
  const qdrantHealth = await defaultQdrantService.checkHealth();

  // 3. Check Gemini API key configuration
  const geminiConfigured = Boolean(config.GEMINI_API_KEY && config.GEMINI_API_KEY.trim() !== '');

  // 4. Calculate truthful system status
  const isHealthy =
    dbStatus === 'connected' &&
    (!defaultQdrantService.isConfigured() || qdrantHealth.status === 'connected') &&
    geminiConfigured;

  const overallStatus = isHealthy ? 'ok' : 'degraded';

  res.status(200).json({
    status: overallStatus,
    service: 'turium-ai-knowledge-inbox-backend',
    database: dbStatus,
    dependencies: {
      relational_db: {
        provider: isTursoConfigured() ? 'turso' : 'sqlite',
        status: dbStatus,
      },
      vector_index: {
        provider: defaultQdrantService.isConfigured() ? 'qdrant' : 'in-process',
        status: qdrantHealth.status,
      },
      gemini_ai: {
        status: geminiConfigured ? 'configured' : 'missing',
        chat_model: config.GEMINI_CHAT_MODEL,
        embedding_model: config.GEMINI_EMBEDDING_MODEL,
        embedding_dimensions: config.GEMINI_EMBEDDING_DIMENSIONS,
      },
    },
    ai: {
      provider: 'google-gemini',
      models: {
        chat: config.GEMINI_CHAT_MODEL,
        embedding: config.GEMINI_EMBEDDING_MODEL,
      },
      embeddingDimensions: config.GEMINI_EMBEDDING_DIMENSIONS,
    },
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
};
