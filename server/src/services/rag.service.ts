import { RetrievalService, ScoredChunk, computeContentFingerprint } from './retrieval.service';
import { ChatProvider, defaultChatProvider } from './chat.service';
import { PromptService } from './prompt.service';
import { SourceType } from '../types/database.types';
import { logger } from '../utils/logger';

export interface GroundedSource {
  item_id: string;
  item_title: string | null;
  source_type: SourceType;
  source_url: string | null;
  chunk_id: string;
  chunk_index: number;
  snippet: string;
  similarity: number;
}

export interface RAGAnswerResult {
  answer: string;
  sources: GroundedSource[];
}

export interface RAGQueryOptions {
  topK?: number;
  /**
   * Optional item UUID to restrict retrieval to a single knowledge item.
   * When provided, only chunks belonging to that item are searched.
   */
  itemId?: string;
}

export class RAGService {
  private retrievalService: RetrievalService;
  private chatProvider: ChatProvider;

  constructor(
    retrievalService?: RetrievalService,
    chatProvider?: ChatProvider
  ) {
    this.retrievalService = retrievalService || new RetrievalService();
    this.chatProvider = chatProvider || defaultChatProvider;
  }

  /**
   * Execute end-to-end Retrieval-Augmented Generation pipeline:
   * 1. Semantic vector retrieval of completed chunks
   * 2. Grounded prompt synthesis with anti-injection boundaries
   * 3. Chat model completion
   * 4. Independent backend citation validation
   */
  async answerQuestion(
    question: string,
    options?: RAGQueryOptions
  ): Promise<RAGAnswerResult> {
    const trimmedQuestion = question.trim();

    if (!trimmedQuestion) {
      return {
        answer: 'Please provide a non-empty question to query the knowledge inbox.',
        sources: [],
      };
    }

    const topK = options?.topK ?? 5;

    // 1. Retrieve highest-ranking eligible chunks
    const retrievedChunks: ScoredChunk[] = await this.retrievalService.retrieve(
      trimmedQuestion,
      { topK, itemId: options?.itemId }
    );

    // 2. Handle empty knowledge base or zero retrieved chunks
    if (retrievedChunks.length === 0) {
      logger.info(
        { questionLength: trimmedQuestion.length },
        'Zero relevant context chunks found; returning insufficient knowledge response without calling LLM'
      );
      return {
        answer: 'The saved knowledge inbox does not contain enough information to answer this question.',
        sources: [],
      };
    }

    // 3. Construct isolated, delimited prompt
    const { systemPrompt, userPrompt } = PromptService.buildRAGPrompt(
      trimmedQuestion,
      retrievedChunks
    );

    // 4. Request grounded answer from chat provider
    const chatResult = await this.chatProvider.generateGroundedAnswer(
      systemPrompt,
      userPrompt
    );

    // 5. Independently validate and filter citations against retrieved chunks
    const retrievedMap = new Map<string, ScoredChunk>();
    for (const chunk of retrievedChunks) {
      retrievedMap.set(chunk.chunk_id, chunk);
    }

    const validatedSources: GroundedSource[] = [];
    const seenChunkIds = new Set<string>();
    // Deduplicate by content fingerprint: prevent identical text appearing twice
    // when duplicate items (e.g. same URL ingested twice) produce near-identical chunks.
    const seenContentKeys = new Set<string>();

    for (const citedId of chatResult.citedChunkIds) {
      if (seenChunkIds.has(citedId)) {
        continue;
      }

      const matchingChunk = retrievedMap.get(citedId);
      if (matchingChunk) {
        // Build a content-based deduplication key: source URL (or item_id for notes) + SHA-256 content fingerprint.
        // This catches duplicate chunks from re-ingested identical content, while preserving different
        // content versions from the same URL even if chunk indexes match.
        const contentKey = `${matchingChunk.item_source_url ?? matchingChunk.item_id}::${computeContentFingerprint(matchingChunk.content)}`;
        if (seenContentKeys.has(contentKey)) {
          logger.info(
            { citedChunkId: citedId, contentKey },
            'Skipping duplicate citation with identical source content (duplicate ingestion detected)'
          );
          seenChunkIds.add(citedId);
          continue;
        }

        seenChunkIds.add(citedId);
        seenContentKeys.add(contentKey);
        validatedSources.push({
          item_id: matchingChunk.item_id,
          item_title: matchingChunk.item_title,
          source_type: matchingChunk.item_source_type,
          source_url: matchingChunk.item_source_url,
          chunk_id: matchingChunk.chunk_id,
          chunk_index: matchingChunk.chunk_index,
          snippet: matchingChunk.content.slice(0, 300).trim(),
          similarity: Number(matchingChunk.similarity.toFixed(4)),
        });
      } else {
        logger.warn(
          {
            citedChunkId: citedId,
            questionLength: trimmedQuestion.length,
            model: this.chatProvider.modelName,
          },
          'Discarding hallucinated/unverified citation returned by model'
        );
      }
    }

    const INSUFFICIENT_KNOWLEDGE_RESPONSE =
      'The saved knowledge inbox does not contain enough information to answer this question.';

    // Check if the model explicitly indicated insufficient information
    const lowerAnswer = chatResult.answer.toLowerCase();
    const isExplicitInsufficientInfo =
      lowerAnswer.includes('does not contain enough information') ||
      lowerAnswer.includes('does not contain any relevant information') ||
      lowerAnswer.includes('insufficient information') ||
      lowerAnswer.includes('not enough information');

    if (isExplicitInsufficientInfo) {
      logger.info(
        { questionLength: trimmedQuestion.length, model: this.chatProvider.modelName },
        'Model explicitly acknowledged insufficient information'
      );
      return {
        answer: chatResult.answer,
        sources: [],
      };
    }

    // CITATION-TO-ANSWER INTEGRITY RULE:
    // If the model returned a substantive answer but none of its cited chunk IDs match
    // the actual retrieved chunks, reject the unsupported answer and return insufficient knowledge.
    if (validatedSources.length === 0) {
      logger.warn(
        {
          questionLength: trimmedQuestion.length,
          claimedCitationsCount: chatResult.citedChunkIds.length,
          validatedCitationsCount: 0,
          model: this.chatProvider.modelName,
        },
        'Model returned a substantive answer without valid grounding citations from retrieved chunks; rejecting unsupported answer'
      );
      return {
        answer: INSUFFICIENT_KNOWLEDGE_RESPONSE,
        sources: [],
      };
    }

    logger.info(
      {
        questionLength: trimmedQuestion.length,
        retrievedCount: retrievedChunks.length,
        claimedCitations: chatResult.citedChunkIds.length,
        validatedCitations: validatedSources.length,
      },
      'RAG question answering pipeline completed successfully'
    );

    return {
      answer: chatResult.answer,
      sources: validatedSources,
    };
  }
}
