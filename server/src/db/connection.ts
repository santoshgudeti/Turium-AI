import { createClient, Client, InStatement } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { initSchema } from './schema';

let clientInstance: Client | null = null;
let schemaInitialized = false;

export const isTursoConfigured = (): boolean => {
  return Boolean(config.TURSO_DATABASE_URL && config.TURSO_DATABASE_URL.trim() !== '');
};

export const resolveDatabasePath = (customPath?: string): string => {
  const dbPath = customPath || config.DATABASE_PATH;
  if (dbPath === ':memory:' || dbPath.startsWith('file:')) {
    return dbPath;
  }
  if (path.isAbsolute(dbPath)) {
    return dbPath;
  }

  // If invoked inside server workspace, check root repository database first
  if (path.basename(process.cwd()) === 'server') {
    const rootCandidate = path.resolve(process.cwd(), '..', dbPath);
    if (fs.existsSync(rootCandidate)) {
      return rootCandidate;
    }
  }

  return path.resolve(process.cwd(), dbPath);
};

/**
 * Adapts a synchronous node:sqlite DatabaseSync instance into the async Client interface.
 * Useful for local testing and backward compatibility with in-memory sqlite fixtures.
 */
export function wrapDatabaseSync(sqliteDb: any): Client {
  return {
    async execute(stmt: InStatement) {
      const sql = typeof stmt === 'string' ? stmt : stmt.sql;
      const rawArgs = typeof stmt === 'string' ? [] : (stmt.args || []);
      const args = Array.isArray(rawArgs) ? rawArgs : Object.values(rawArgs);

      const trimmed = sql.trim().toUpperCase();
      const isSelect =
        trimmed.startsWith('SELECT') ||
        trimmed.startsWith('PRAGMA') ||
        trimmed.includes('RETURNING');

      const prepared = sqliteDb.prepare(sql);
      if (isSelect) {
        const rows = prepared.all(...args) as any[];
        return {
          rows,
          columns: rows.length > 0 ? Object.keys(rows[0]) : [],
          rowsAffected: 0,
          lastInsertRowid: undefined,
        } as any;
      } else {
        const info = prepared.run(...args);
        return {
          rows: [],
          columns: [],
          rowsAffected: Number(info?.changes || 0),
          lastInsertRowid: info?.lastInsertRowid,
        } as any;
      }
    },

    async executeMultiple(sql: string) {
      sqliteDb.exec(sql);
    },

    async batch(statements: InStatement[], _mode?: 'write' | 'read' | 'deferred') {
      sqliteDb.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) {
          const sql = typeof s === 'string' ? s : s.sql;
          const rawArgs = typeof s === 'string' ? [] : (s.args || []);
          const args = Array.isArray(rawArgs) ? rawArgs : Object.values(rawArgs);
          const trimmed = sql.trim().toUpperCase();
          const isSelect =
            trimmed.startsWith('SELECT') ||
            trimmed.startsWith('PRAGMA') ||
            trimmed.includes('RETURNING');
          const prepared = sqliteDb.prepare(sql);
          if (isSelect) {
            results.push({
              rows: prepared.all(...args),
              columns: [],
              rowsAffected: 0,
            });
          } else {
            const info = prepared.run(...args);
            results.push({
              rows: [],
              columns: [],
              rowsAffected: Number(info?.changes || 0),
              lastInsertRowid: info?.lastInsertRowid,
            });
          }
        }
        sqliteDb.exec('COMMIT');
        return results as any;
      } catch (err) {
        sqliteDb.exec('ROLLBACK');
        throw err;
      }
    },

    close() {
      sqliteDb.close();
    },
  } as unknown as Client;
}

export const createDatabaseClient = (customUrl?: string, customAuthToken?: string): Client => {
  if (customUrl) {
    const url = customUrl.startsWith('file:') || customUrl === ':memory:'
      ? customUrl
      : customUrl;
    return createClient({
      url,
      authToken: customAuthToken,
    });
  }

  if (isTursoConfigured()) {
    logger.info('Connecting to primary cloud database (Turso / libSQL)...');
    return createClient({
      url: config.TURSO_DATABASE_URL!,
      authToken: config.TURSO_AUTH_TOKEN,
    });
  }

  // Local fallback to SQLite database file
  const resolvedPath = resolveDatabasePath();
  if (resolvedPath !== ':memory:' && !resolvedPath.startsWith('file:')) {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info({ dir }, 'Created local database directory');
    }
    const fileUrl = `file:${resolvedPath.replace(/\\/g, '/')}`;
    logger.info({ path: resolvedPath }, 'Connecting to local SQLite fallback database via libSQL client');
    return createClient({ url: fileUrl });
  }

  return createClient({ url: 'file::memory:' });
};

export const getDatabase = (customClient?: Client): Client => {
  if (customClient) {
    return customClient;
  }

  if (clientInstance) {
    return clientInstance;
  }

  clientInstance = createDatabaseClient();
  return clientInstance;
};

export const initDatabase = async (client?: Client): Promise<Client> => {
  const activeClient = client || getDatabase();
  if (!schemaInitialized || client) {
    await initSchema(activeClient);
    schemaInitialized = true;
  }
  return activeClient;
};

export const closeDatabase = (): void => {
  if (clientInstance) {
    logger.info('Closing database client connection');
    try {
      clientInstance.close();
    } catch (err) {
      logger.warn({ err }, 'Error closing database client');
    } finally {
      clientInstance = null;
      schemaInitialized = false;
    }
  }
};
