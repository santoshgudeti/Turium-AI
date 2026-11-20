import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, ArrowRight, Loader2, AlertCircle, BookOpen, HelpCircle, X } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { QueryResult } from '../api/types';
import { CitationCard } from './CitationCard';

interface AskAIProps {
  initialQuestion?: string;
  itemCount: number;
  onOpenAddModal: () => void;
  onInspectItem?: (itemId: string) => void;
  /** When set, queries are scoped to this specific knowledge item */
  activeScopedItem?: { id: string; title: string } | null;
  /** Called when the user clicks "Search All" to clear the scope */
  onClearScope?: () => void;
}

export const AskAI: React.FC<AskAIProps> = ({
  initialQuestion = '',
  itemCount,
  onOpenAddModal,
  onInspectItem,
  activeScopedItem,
  onClearScope,
}) => {
  const [question, setQuestion] = useState(initialQuestion);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [lastSubmittedQuestion, setLastSubmittedQuestion] = useState<string | null>(null);

  // Robust async guard: AbortController + request identity generation counter
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef<number>(0);
  const prevScopedItemIdRef = useRef<string | null>(activeScopedItem ? activeScopedItem.id : null);
  const prevInitialQuestionRef = useRef<string>(initialQuestion);

  // Abort any in-flight request on unmount
  useEffect(() => {
    return () => {
      requestIdRef.current++;
      abortControllerRef.current?.abort();
    };
  }, []);

  // Scope transition effect: handles switching between any two items (including identical titles)
  // and clearing scope back to global "Search All".
  useEffect(() => {
    const currentScopedId = activeScopedItem ? activeScopedItem.id : null;
    if (prevScopedItemIdRef.current !== currentScopedId) {
      prevScopedItemIdRef.current = currentScopedId;

      // Abort previous in-flight request and invalidate generation counter
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      requestIdRef.current++;

      // Reset state completely
      setResult(null);
      setError(null);
      setLoading(false);
      setLastSubmittedQuestion(null);
    }
  }, [activeScopedItem]);

  // Synchronize initialQuestion changes (e.g. clicking "Ask AI" on an item) to textarea and reset state
  useEffect(() => {
    if (initialQuestion !== prevInitialQuestionRef.current) {
      prevInitialQuestionRef.current = initialQuestion;
      if (initialQuestion) {
        setQuestion(initialQuestion);
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        requestIdRef.current++;

        setResult(null);
        setError(null);
        setLoading(false);
        setLastSubmittedQuestion(null);
      }
    }
  }, [initialQuestion]);

  const sampleSuggestions = [
    'What did I save about loan EMI calculations?',
    'Summarize the core takeaways from my saved notes',
    'What are the key architecture guidelines mentioned?',
  ];

  const handleSubmit = async (e?: React.FormEvent, overrideQuestion?: string) => {
    if (e) e.preventDefault();
    const queryText = (overrideQuestion ?? question).trim();

    if (!queryText || loading) return;

    // Abort previous in-flight request and generate a new request ID and target scope ID
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const thisRequestId = ++requestIdRef.current;
    const targetScopeId = activeScopedItem ? activeScopedItem.id : null;

    setLoading(true);
    setError(null);
    setLastSubmittedQuestion(queryText);

    try {
      // Include item_id when query is scoped to a specific item
      const payload = activeScopedItem
        ? { question: queryText, item_id: activeScopedItem.id }
        : { question: queryText };

      const response = await api.query(payload, controller.signal);

      // Async guard: Discard response if request was aborted, newer request was dispatched,
      // or scope changed while request was in flight.
      if (
        controller.signal.aborted ||
        thisRequestId !== requestIdRef.current ||
        (activeScopedItem ? activeScopedItem.id : null) !== targetScopeId
      ) {
        return;
      }

      setResult(response);
    } catch (err: unknown) {
      // Async guard: Discard errors if cancelled, stale, or out-of-scope
      if (
        controller.signal.aborted ||
        thisRequestId !== requestIdRef.current ||
        (activeScopedItem ? activeScopedItem.id : null) !== targetScopeId
      ) {
        return;
      }

      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to query the knowledge inbox. Please try again.');
      }
      setResult(null);
    } finally {
      if (
        !controller.signal.aborted &&
        thisRequestId === requestIdRef.current &&
        (activeScopedItem ? activeScopedItem.id : null) === targetScopeId
      ) {
        setLoading(false);
      }
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    setQuestion(suggestion);
    handleSubmit(undefined, suggestion);
  };

  const isInsufficientKnowledge =
    result?.answer?.toLowerCase().includes('does not contain enough information') ||
    result?.answer?.toLowerCase().includes('does not contain any relevant information') ||
    (result && result.sources.length === 0);

  return (
    <div className="bg-white rounded-xl border border-slate-200/90 shadow-xs p-6 flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-slate-100">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-indigo-600 rounded-lg text-white shadow-xs">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-900 tracking-tight">Ask AI Knowledge Inbox</h2>
            <p className="text-xs text-slate-500">
              Get grounded answers strictly synthesized from your saved notes and web pages with source citations.
            </p>
          </div>
        </div>

        <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-400">
          <BookOpen className="w-3.5 h-3.5" />
          <span>{itemCount} {itemCount === 1 ? 'item' : 'items'} indexed</span>
        </div>
      </div>

      {/* FE-003: Scope badge — shown when query is restricted to a specific item */}
      {activeScopedItem && (
        <div className="flex items-center gap-2 px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-lg text-xs text-indigo-800">
          <Sparkles className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
          <span className="flex-1 truncate">
            Scoping to: <span className="font-semibold">"{activeScopedItem.title}"</span>
          </span>
          <button
            type="button"
            onClick={onClearScope}
            className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-900 font-medium shrink-0"
            title="Clear scope and search all knowledge"
          >
            <X className="w-3 h-3" />
            Search All
          </button>
        </div>
      )}

      {/* Question Form */}
      <form onSubmit={(e) => handleSubmit(e)} className="flex flex-col gap-3">
        <div className="relative">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Ask anything about your saved knowledge (e.g. 'What are the steps for setting up SQLite?')..."
            rows={3}
            disabled={loading}
            className="w-full text-sm rounded-lg border border-slate-200 bg-slate-50/50 p-3.5 pr-12 focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none transition-all resize-none text-slate-800 placeholder-slate-400 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!question.trim() || loading}
            className="absolute right-3 bottom-3 p-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-xs"
            title="Ask Question (Enter)"
            aria-label="Submit Question"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
          </button>
        </div>

        <div className="flex items-center justify-between text-xs text-slate-400 px-1">
          <span>Press <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-[10px] font-sans">Enter</kbd> to ask</span>
          <span>{question.length}/1000 characters</span>
        </div>
      </form>

      {/* Suggested prompts if no items searched yet */}
      {!result && !loading && (
        <div className="flex flex-col gap-2 pt-2">
          <span className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
            <HelpCircle className="w-3.5 h-3.5" /> Sample questions to try:
          </span>
          <div className="flex flex-wrap gap-2">
            {sampleSuggestions.map((suggestion, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => handleSuggestionClick(suggestion)}
                className="text-xs text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200/80 px-3 py-1.5 rounded-full transition-colors text-left"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Loading state indicator */}
      {loading && (
        <div className="p-8 border border-slate-100 rounded-lg bg-slate-50/60 flex flex-col items-center justify-center gap-3 animate-pulse">
          <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />
          <div className="text-center">
            <p className="text-sm font-medium text-slate-700">Searching your knowledge base...</p>
            <p className="text-xs text-slate-400 mt-0.5">
              Calculating cosine similarity and generating a grounded answer from verified sources.
            </p>
          </div>
        </div>
      )}

      {/* Error Message Display */}
      {error && !loading && (
        <div className="p-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
          <div className="flex-1 text-xs">
            <p className="font-semibold text-rose-900">Query Failed</p>
            <p className="mt-0.5">{error}</p>
          </div>
          <button
            type="button"
            onClick={() => handleSubmit()}
            className="text-xs font-semibold text-rose-700 hover:text-rose-900 underline shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* Result Display */}
      {result && !loading && (
        <div className="flex flex-col gap-5 pt-3 border-t border-slate-100">
          {/* Question badge */}
          {lastSubmittedQuestion && (
            <div className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
              <span>Question:</span>
              <span className="text-slate-700 font-semibold italic">"{lastSubmittedQuestion}"</span>
            </div>
          )}

          {/* Answer Card */}
          <div
            className={`p-5 rounded-lg border ${
              isInsufficientKnowledge
                ? 'bg-amber-50/50 border-amber-200/80 text-amber-950'
                : 'bg-slate-50/50 border-slate-200/80 text-slate-800'
            }`}
          >
            <div className="flex items-center gap-2 mb-2.5">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Grounded Answer
              </span>
            </div>

            <div className="text-sm leading-relaxed whitespace-pre-line space-y-2">
              {result.answer}
            </div>

            {isInsufficientKnowledge && itemCount === 0 && (
              <div className="mt-4 pt-3 border-t border-amber-200/60 flex items-center justify-between text-xs text-amber-800">
                <span>Your knowledge inbox is currently empty. Add notes or URLs first.</span>
                <button
                  type="button"
                  onClick={onOpenAddModal}
                  className="font-semibold underline hover:text-amber-950"
                >
                  Add Knowledge Now
                </button>
              </div>
            )}
          </div>

          {/* Verified Source Citations */}
          {result.sources.length > 0 && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                  <BookOpen className="w-3.5 h-3.5" />
                  Verified Citations ({result.sources.length})
                </span>
                <span className="text-[11px] text-slate-400">
                  Independently verified against retrieved chunks
                </span>
              </div>

              <div className="grid grid-cols-1 gap-2.5">
                {result.sources.map((source, idx) => (
                  <CitationCard
                    key={source.chunk_id || idx}
                    source={source}
                    index={idx}
                    onInspectItem={onInspectItem}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
