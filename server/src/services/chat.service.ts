import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { config } from '../config/env';
import { AppError } from '../middleware/error-handler.middleware';
import { logger } from '../utils/logger';

export interface ChatCompletionResult {
  answer: string;
  citedChunkIds: string[];
}

export interface ChatProvider {
  readonly modelName: string;
  generateGroundedAnswer(
    systemPrompt: string,
    userPrompt: string
  ): Promise<ChatCompletionResult>;
}

export interface GeminiChatOptions {
  apiKey?: string;
  modelName?: string;
  client?: GoogleGenAI;
}

/**
 * Production Google Gemini Chat Provider
 * Uses Google Gen AI SDK (@google/genai) with JSON response mode and deterministic temperature (0)
 */
export class GeminiChatProvider implements ChatProvider {
  readonly modelName: string;
  private apiKey?: string;
  private client?: GoogleGenAI;

  constructor(options?: GeminiChatOptions) {
    this.apiKey =
      options?.apiKey !== undefined
        ? options.apiKey
        : (process.env.GEMINI_API_KEY || config.GEMINI_API_KEY);
    this.modelName =
      options?.modelName ||
      process.env.GEMINI_CHAT_MODEL ||
      config.GEMINI_CHAT_MODEL ||
      'gemini-3.5-flash-lite';

    if (options?.client) {
      this.client = options.client;
    } else if (this.apiKey) {
      this.client = new GoogleGenAI({ apiKey: this.apiKey });
    }
  }

  /**
   * Dispatches chat completion request to Google Gemini and parses structured grounded response
   */
  async generateGroundedAnswer(
    systemPrompt: string,
    userPrompt: string
  ): Promise<ChatCompletionResult> {
    if (!this.apiKey && !this.client) {
      logger.error('GEMINI_API_KEY is not configured in the server environment');
      throw new AppError(
        500,
        'GEMINI_API_KEY is not configured on the server. Please set GEMINI_API_KEY in the environment.'
      );
    }

    if (!this.client && this.apiKey) {
      this.client = new GoogleGenAI({ apiKey: this.apiKey });
    }

    logger.info({ model: this.modelName }, 'Requesting grounded answer from Google Gemini chat completion');

    let response: any;
    try {
      response = await this.client!.models.generateContent({
        model: this.modelName,
        contents: userPrompt,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW,
            includeThoughts: false,
          },
        },
      });
    } catch (err: unknown) {
      this.handleProviderError(err);
    }

    let rawContent = response?.text?.trim();

    if (!rawContent) {
      logger.error({ model: this.modelName }, 'Google Gemini returned empty message content');
      throw new AppError(502, 'Chat provider returned empty completion content');
    }

    // Strip markdown code fences if model enclosed JSON in ```json ... ```
    if (rawContent.startsWith('```')) {
      rawContent = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }

    // Parse and validate structured JSON output
    let parsed: { answer?: unknown; cited_chunk_ids?: unknown };
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      logger.error({ rawContent }, 'Failed to parse JSON response from chat model');
      throw new AppError(502, 'Chat provider response was not valid JSON format');
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new AppError(502, 'Chat provider returned non-object JSON structure');
    }

    if (typeof parsed.answer !== 'string') {
      throw new AppError(502, 'Chat provider response missing string answer field');
    }

    const answer = parsed.answer.trim();

    let citedChunkIds: string[] = [];
    if (Array.isArray(parsed.cited_chunk_ids)) {
      citedChunkIds = parsed.cited_chunk_ids.filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0
      );
    }

    return {
      answer,
      citedChunkIds,
    };
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
      'Google Gemini chat generation failed due to an upstream provider error. Please try again later.';

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
        'Google Gemini service is temporarily unavailable or experiencing high demand. Please try again shortly.';
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
        'Google Gemini rate limit exceeded or quota exhausted. Please retry shortly.';
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
      clientMessage = `Google Gemini model '${this.modelName}' not found or unsupported by the API.`;
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
      clientMessage = 'Google Gemini request timed out. Please try again.';
    }

    logger.error(
      {
        provider: 'Google Gemini',
        model: this.modelName,
        upstreamStatusCode: upstreamCode || status,
        errorCategory,
      },
      'Google Gemini chat completion error'
    );

    throw new AppError(httpStatus, clientMessage);
  }
}

/**
 * Mock Chat Provider for isolated deterministic testing
 */
export class MockChatProvider implements ChatProvider {
  readonly modelName: string;
  private responseGenerator?: (
    systemPrompt: string,
    userPrompt: string
  ) => ChatCompletionResult | Promise<ChatCompletionResult>;

  constructor(options?: {
    modelName?: string;
    responseGenerator?: (
      systemPrompt: string,
      userPrompt: string
    ) => ChatCompletionResult | Promise<ChatCompletionResult>;
  }) {
    this.modelName = options?.modelName || 'gemini-3.8-flash';
    this.responseGenerator = options?.responseGenerator;
  }

  setHandler(
    handler: (
      systemPrompt: string,
      userPrompt: string
    ) => ChatCompletionResult | Promise<ChatCompletionResult>
  ): void {
    this.responseGenerator = handler;
  }

  async generateGroundedAnswer(
    systemPrompt: string,
    userPrompt: string
  ): Promise<ChatCompletionResult> {
    if (this.responseGenerator) {
      return this.responseGenerator(systemPrompt, userPrompt);
    }

    // Default mock response extracting chunk IDs from the prompt if present
    const chunkIdMatches = userPrompt.match(/CHUNK_ID:\s*([a-f0-9-]+)/gi);
    const citedChunkIds: string[] = [];

    if (chunkIdMatches) {
      for (const match of chunkIdMatches) {
        const id = match.replace(/CHUNK_ID:\s*/i, '').trim();
        if (id && !citedChunkIds.includes(id)) {
          citedChunkIds.push(id);
        }
      }
    }

    return {
      answer:
        'This is a mock grounded answer synthesized from the provided knowledge chunks.',
      citedChunkIds,
    };
  }
}

// Default system singleton chat provider
export const defaultChatProvider: ChatProvider = new GeminiChatProvider();
