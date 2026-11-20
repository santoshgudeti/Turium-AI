import {
  ApiResponse,
  IngestPayload,
  IngestResult,
  ItemDetail,
  ItemSummary,
  Chunk,
  QueryPayload,
  QueryResult,
  DeleteItemResult,
} from './types';

export class ApiError extends Error {
  statusCode: number;
  code?: string;
  details?: unknown[];

  constructor(message: string, statusCode: number, code?: string, details?: unknown[]) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

// Configurable base URL; defaults to '/api' matching the Vite reverse proxy in development
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '');

async function fetchJson<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  const defaultHeaders: HeadersInit = {
    Accept: 'application/json',
  };

  if (options?.body) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        ...defaultHeaders,
        ...options?.headers,
      },
    });
  } catch {
    throw new ApiError(
      'Network connection failed. Please ensure the backend server is running on port 4000.',
      0,
      'NETWORK_ERROR'
    );
  }

  let body: ApiResponse<T>;
  try {
    body = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError(
      `Server returned an unparseable response (HTTP ${response.status})`,
      response.status,
      'PARSE_ERROR'
    );
  }

  if (!response.ok || body.status === 'error') {
    const errorMsg =
      body.message ||
      (body.errors && body.errors.length > 0 ? body.errors[0].message : undefined) ||
      `Request failed with status ${response.status}`;
    throw new ApiError(errorMsg, response.status, body.code, body.errors);
  }

  // Return wrapped data if present, otherwise return root payload (e.g. /health endpoint)
  return (body.data !== undefined ? body.data : body) as unknown as T;
}

export const api = {
  /**
   * Fetch all saved knowledge items summaries
   */
  async getItems(): Promise<{ items: ItemSummary[]; total: number }> {
    return fetchJson<{ items: ItemSummary[]; total: number }>('/items');
  },

  /**
   * Fetch a single item with its full extracted chunks and content
   */
  async getItemById(id: string): Promise<{ item: ItemDetail; chunks: Chunk[]; chunk_count: number }> {
    return fetchJson<{ item: ItemDetail; chunks: Chunk[]; chunk_count: number }>(`/items/${encodeURIComponent(id)}`);
  },

  /**
   * Ingest a new plain-text note or remote web URL
   */
  async ingest(payload: IngestPayload): Promise<IngestResult> {
    return fetchJson<IngestResult>('/ingest', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  /**
   * Query the knowledge inbox using semantic retrieval and grounded RAG answer generation.
   * Accepts an optional AbortSignal to cancel an in-flight request.
   */
  async query(payload: QueryPayload, signal?: AbortSignal): Promise<QueryResult> {
    return fetchJson<QueryResult>('/query', {
      method: 'POST',
      body: JSON.stringify(payload),
      signal,
    });
  },

  /**
   * Delete an item and its associated chunks and vector embeddings
   */
  async deleteItem(id: string): Promise<DeleteItemResult> {
    return fetchJson<DeleteItemResult>(`/items/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  /**
   * Check backend health status
   */
  async getHealth(): Promise<{ status: string; uptime: number }> {
    return fetchJson<{ status: string; uptime: number }>('/health');
  },
};
