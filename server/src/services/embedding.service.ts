import { GoogleGenAI } from '@google/genai';
import { config } from '../config/env';
import { AppError } from '../middleware/error-handler.middleware';
import { logger } from '../utils/logger';

export interface EmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;
  generateEmbeddings(texts: string[]): Promise<number[][]>;
  generateEmbedding(text: string): Promise<number[]>;
}

export interface GeminiEmbeddingOptions {
  apiKey?: string;
  modelName?: string;
  dimensions?: number;
  maxBatchSize?: number;
  client?: GoogleGenAI;
}

/**
 * Production Google Gemini Embedding Provider
 * Implements batch generation, dimension validation, error mapping, and key security using @google/genai.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;
  private apiKey?: string;
  private maxBatchSize: number;
  private client?: GoogleGenAI;

  constructor(options?: GeminiEmbeddingOptions) {
    this.apiKey =
      options?.apiKey !== undefined
        ? options.apiKey
        : (process.env.GEMINI_API_KEY || config.GEMINI_API_KEY);
    this.modelName =
      options?.modelName ||
      process.env.GEMINI_EMBEDDING_MODEL ||
      config.GEMINI_EMBEDDING_MODEL ||
      'gemini-embedding-001';
    this.dimensions = options?.dimensions || config.GEMINI_EMBEDDING_DIMENSIONS || 1536;
    this.maxBatchSize = options?.maxBatchSize || 100;

    if (options?.client) {
      this.client = options.client;
    } else if (this.apiKey) {
      this.client = new GoogleGenAI({ apiKey: this.apiKey });
    }
  }

  /**
   * Batch generate embeddings for an array of input strings using Gemini embedContent
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }

    // 1. Enforce API key configuration
    if (!this.apiKey && !this.client) {
      logger.error('GEMINI_API_KEY is not configured in the server environment');
      throw new AppError(
        500,
        'GEMINI_API_KEY is not configured on the server. Please set GEMINI_API_KEY in the environment.'
      );
    }

    // Lazy instantiate client if key was supplied after construction
    if (!this.client && this.apiKey) {
      this.client = new GoogleGenAI({ apiKey: this.apiKey });
    }

    // 2. Validate input strings
    const sanitizedTexts = texts.map((t) => {
      const trimmed = t.trim();
      return trimmed.length > 0 ? trimmed : ' '; // Non-empty string per item
    });

    const allVectors: number[][] = [];

    // 3. Process inputs in chunks of maxBatchSize
    for (let i = 0; i < sanitizedTexts.length; i += this.maxBatchSize) {
      const batch = sanitizedTexts.slice(i, i + this.maxBatchSize);

      logger.info(
        { model: this.modelName, batchSize: batch.length, offset: i, total: sanitizedTexts.length },
        'Requesting embedding batch from Google Gemini'
      );

      let response: any;
      try {
        response = await this.client!.models.embedContent({
          model: this.modelName,
          contents: batch,
          config: {
            outputDimensionality: this.dimensions,
          },
        });
      } catch (err: unknown) {
        this.handleProviderError(err);
      }

      // 4. Extract embeddings from response
      // When batch is sent, @google/genai returns response.embeddings
      // When single item is sent, response.embeddings or response.embedding may be present
      let returnedEmbeddings: Array<{ values?: number[] }> = [];

      if (Array.isArray(response?.embeddings)) {
        returnedEmbeddings = response.embeddings;
      } else if (response?.embedding?.values) {
        returnedEmbeddings = [response.embedding];
      }

      // Validate response count
      if (returnedEmbeddings.length !== batch.length) {
        logger.error(
          {
            expected: batch.length,
            received: returnedEmbeddings.length,
            model: this.modelName,
          },
          'Embedding provider returned unexpected item count'
        );
        throw new AppError(
          502,
          `Embedding provider count mismatch: returned ${returnedEmbeddings.length} embeddings for ${batch.length} input texts`
        );
      }

      // 5. Validate each vector's dimensions and numeric values
      for (let idx = 0; idx < returnedEmbeddings.length; idx++) {
        const item = returnedEmbeddings[idx];
        const vector = item?.values;

        if (!Array.isArray(vector) || vector.length === 0) {
          throw new AppError(
            502,
            `Embedding at index ${i + idx} is empty or not an array`
          );
        }

        if (this.dimensions && vector.length !== this.dimensions) {
          logger.warn(
            { expected: this.dimensions, actual: vector.length, index: i + idx },
            'Vector dimension mismatch from embedding provider'
          );
          throw new AppError(
            502,
            `Embedding at index ${i + idx} has unexpected dimension ${vector.length} (expected ${this.dimensions})`
          );
        }

        // Validate all elements are finite numbers
        for (let d = 0; d < vector.length; d++) {
          if (typeof vector[d] !== 'number' || !Number.isFinite(vector[d])) {
            throw new AppError(
              502,
              `Embedding at index ${i + idx} contains non-numeric or non-finite value at dimension ${d}`
            );
          }
        }

        allVectors.push(vector);
      }
    }

    return allVectors;
  }

  /**
   * Generate an embedding for a single text input (e.g. search query)
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new AppError(400, 'Cannot generate embedding for empty text');
    }

    const vectors = await this.generateEmbeddings([trimmed]);
    if (!vectors || vectors.length === 0) {
      throw new AppError(502, 'No vector returned for input query');
    }

    return vectors[0];
  }

  /**
   * Map provider-specific error structures to standardized AppError instances
   */
  private handleProviderError(err: unknown): never {
    if (err instanceof AppError) {
      throw err;
    }

    const errorObj = err as any;
    const status = errorObj?.status || errorObj?.statusCode || errorObj?.response?.status;
    const rawMessage = typeof errorObj?.message === 'string' ? errorObj.message : '';

    let parsedUpstreamError: any = null;
    try {
      if (rawMessage.trim().startsWith('{')) {
        parsedUpstreamError = JSON.parse(rawMessage);
      }
    } catch {
      // ignore
    }

    const upstreamCode = parsedUpstreamError?.error?.code || status;
    const upstreamStatus = parsedUpstreamError?.error?.status || '';
    const upstreamMessage = parsedUpstreamError?.error?.message || rawMessage;
    const lowerMsg = (upstreamMessage + ' ' + upstreamStatus).toLowerCase();

    let errorCategory = 'UPSTREAM_FAILURE';
    let httpStatus = 502;
    let clientMessage =
      'Google Gemini embedding request failed due to an upstream provider error. Please try again later.';

    if (
      upstreamCode === 503 ||
      status === 503 ||
      upstreamStatus === 'UNAVAILABLE' ||
      lowerMsg.includes('high demand') ||
      lowerMsg.includes('unavailable')
    ) {
      errorCategory = 'SERVICE_UNAVAILABLE';
      httpStatus = 502;
      clientMessage =
        'Google Gemini embedding service is temporarily unavailable or experiencing high demand. Please try again shortly.';
    } else if (
      upstreamCode === 429 ||
      status === 429 ||
      upstreamStatus === 'RESOURCE_EXHAUSTED' ||
      lowerMsg.includes('rate limit') ||
      lowerMsg.includes('quota')
    ) {
      errorCategory = 'RATE_LIMIT';
      httpStatus = 429;
      clientMessage =
        'Google Gemini embedding rate limit exceeded or quota exhausted. Please retry shortly.';
    } else if (
      upstreamCode === 401 ||
      upstreamCode === 403 ||
      status === 401 ||
      status === 403 ||
      upstreamStatus === 'PERMISSION_DENIED' ||
      lowerMsg.includes('api_key') ||
      lowerMsg.includes('permission_denied')
    ) {
      errorCategory = 'AUTH_ERROR';
      httpStatus = 500;
      clientMessage =
        'Google Gemini authentication failed. Please verify that GEMINI_API_KEY is valid.';
    } else if (
      upstreamCode === 404 ||
      status === 404 ||
      upstreamStatus === 'NOT_FOUND' ||
      lowerMsg.includes('not_found') ||
      lowerMsg.includes('model not found')
    ) {
      errorCategory = 'MODEL_NOT_FOUND';
      httpStatus = 502;
      clientMessage = `Google Gemini embedding model '${this.modelName}' not found or unsupported by the API.`;
    } else if (
      upstreamCode === 504 ||
      upstreamCode === 408 ||
      status === 504 ||
      status === 408 ||
      upstreamStatus === 'DEADLINE_EXCEEDED' ||
      lowerMsg.includes('deadline_exceeded') ||
      lowerMsg.includes('timeout')
    ) {
      errorCategory = 'TIMEOUT';
      httpStatus = 504;
      clientMessage = 'Google Gemini embedding request timed out. Please try again.';
    }

    logger.error(
      {
        provider: 'Google Gemini',
        model: this.modelName,
        upstreamStatusCode: upstreamCode || status,
        errorCategory,
      },
      'Google Gemini embedding API error occurred'
    );

    throw new AppError(httpStatus, clientMessage);
  }
}

/**
 * Mock Embedding Provider for isolated unit & integration testing
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;
  private generator?: (text: string) => number[];

  constructor(options?: {
    modelName?: string;
    dimensions?: number;
    generator?: (text: string) => number[];
  }) {
    this.modelName = options?.modelName || 'gemini-embedding-001';
    this.dimensions = options?.dimensions || 1536;
    this.generator = options?.generator;
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.generateDeterministicVector(text));
  }

  async generateEmbedding(text: string): Promise<number[]> {
    return this.generateDeterministicVector(text);
  }

  private generateDeterministicVector(text: string): number[] {
    if (this.generator) {
      return this.generator(text);
    }
    return MockEmbeddingProvider.generateDeterministicVector(text, this.dimensions);
  }

  /**
   * Generates a deterministic pseudo-random unit vector from text
   */
  static generateDeterministicVector(text: string, dimensions: number = 1536): number[] {
    const vector = new Array(dimensions).fill(0);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }

    let sumSq = 0;
    for (let d = 0; d < dimensions; d++) {
      const val = Math.sin(hash + d * 0.1);
      vector[d] = val;
      sumSq += val * val;
    }

    const norm = Math.sqrt(sumSq) || 1;
    return vector.map((v) => Number((v / norm).toFixed(6)));
  }
}

// Default system singleton embedding provider
export const defaultEmbeddingProvider: EmbeddingProvider = new GeminiEmbeddingProvider();
