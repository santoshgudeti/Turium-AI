import React from 'react';
import { ExternalLink, FileText, Globe, Hash } from 'lucide-react';
import { GroundedSource } from '../api/types';

interface CitationCardProps {
  source: GroundedSource;
  index: number;
  onInspectItem?: (itemId: string) => void;
}

export const CitationCard: React.FC<CitationCardProps> = ({ source, index, onInspectItem }) => {
  const isUrl = source.source_type === 'url';
  const displayTitle = source.item_title || (isUrl ? source.source_url : 'Untitled Note');
  const similarityPercent = Math.round(source.similarity * 100);

  return (
    <div className="bg-white rounded-lg border border-slate-200/90 shadow-xs hover:border-slate-300 transition-all p-3.5 flex flex-col gap-2">
      {/* Header row: Source Index, Type, Title, Similarity badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 shrink-0">
            [{index + 1}]
          </span>
          <div
            className={`p-1.5 rounded-md shrink-0 ${
              isUrl ? 'bg-sky-50 text-sky-600' : 'bg-amber-50 text-amber-600'
            }`}
          >
            {isUrl ? <Globe className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {onInspectItem ? (
                <button
                  type="button"
                  onClick={() => onInspectItem(source.item_id)}
                  className="text-xs font-semibold text-slate-900 hover:text-indigo-600 truncate text-left transition-colors cursor-pointer"
                  title={`Inspect source item: ${displayTitle}`}
                >
                  {displayTitle}
                </button>
              ) : (
                <span className="text-xs font-semibold text-slate-900 truncate" title={displayTitle || ''}>
                  {displayTitle}
                </span>
              )}
              {isUrl && source.source_url && (
                <a
                  href={source.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-400 hover:text-slate-600 shrink-0 inline-flex items-center"
                  title="Open original URL in new tab"
                >
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Similarity Score */}
        <span
          className="text-[11px] font-medium px-2 py-0.5 rounded-full shrink-0 bg-emerald-50 text-emerald-700 border border-emerald-200/60"
          title={`Cosine similarity: ${source.similarity.toFixed(4)}`}
        >
          {similarityPercent}% match
        </span>
      </div>

      {/* Snippet */}
      <blockquote className="text-xs text-slate-600 italic bg-slate-50/80 p-2.5 rounded border-l-2 border-slate-300 leading-relaxed font-sans">
        &ldquo;{source.snippet}&rdquo;
      </blockquote>

      {/* Footer: Chunk ID, 1-based chunk index, and inspect link */}
      <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono pt-1 border-t border-slate-100">
        <span className="flex items-center gap-1 text-slate-500">
          <Hash className="w-3 h-3 text-slate-400" />
          Chunk #{source.chunk_index + 1}
        </span>
        <div className="flex items-center gap-2">
          {onInspectItem && (
            <button
              type="button"
              onClick={() => onInspectItem(source.item_id)}
              className="text-[11px] font-sans font-medium text-indigo-600 hover:text-indigo-800 transition-colors cursor-pointer"
              title="Inspect full item and chunks in detail modal"
            >
              Inspect Source &rarr;
            </button>
          )}
          <span className="truncate max-w-[120px] text-slate-400" title={`Chunk ID: ${source.chunk_id}`}>
            {source.chunk_id.slice(0, 8)}...
          </span>
        </div>
      </div>
    </div>
  );
};
