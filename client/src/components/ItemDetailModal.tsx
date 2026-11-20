import React, { useEffect, useState, useRef } from 'react';
import { 
  X, 
  FileText, 
  Globe, 
  Layers, 
  Loader2, 
  AlertCircle, 
  ExternalLink, 
  Calendar, 
  Hash,
  Trash2,
  AlertTriangle
} from 'lucide-react';
import { api } from '../api/client';
import { ItemDetail, Chunk, DeleteItemResult } from '../api/types';

interface ItemDetailModalProps {
  itemId: string | null;
  onClose: () => void;
  onAskAboutItem?: (item: { id: string; title: string }) => void;
  onDelete?: (itemId: string) => Promise<DeleteItemResult | void>;
}

export const ItemDetailModal: React.FC<ItemDetailModalProps> = ({
  itemId,
  onClose,
  onAskAboutItem,
  onDelete,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{ item: ItemDetail; chunks: Chunk[] } | null>(null);
  const [activeTab, setActiveTab] = useState<'chunks' | 'raw'>('chunks');

  // Deletion state
  const [confirmingDelete, setConfirmingDelete] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const previouslyFocusedElement = useRef<HTMLElement | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Manage body scroll lock, Escape key listener, focus trap, and focus restoration
  useEffect(() => {
    if (!itemId) return;

    previouslyFocusedElement.current = document.activeElement as HTMLElement;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!isDeleting) {
          onClose();
        }
        return;
      }

      if (e.key === 'Tab') {
        const dialog = modalRef.current;
        if (!dialog) return;

        const focusableElements = dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusableElements.length === 0) return;

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstElement || !dialog.contains(document.activeElement)) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (document.activeElement === lastElement || !dialog.contains(document.activeElement)) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    const timer = setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 50);

    return () => {
      clearTimeout(timer);
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      previouslyFocusedElement.current?.focus?.();
    };
  }, [itemId, onClose, isDeleting]);

  useEffect(() => {
    if (!itemId) {
      setData(null);
      setConfirmingDelete(false);
      setDeleteError(null);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);
    setConfirmingDelete(false);
    setDeleteError(null);

    api
      .getItemById(itemId)
      .then((res) => {
        if (isMounted) {
          setData({ item: res.item, chunks: res.chunks });
        }
      })
      .catch((err) => {
        if (isMounted) {
          const msg = err instanceof Error ? err.message : 'Failed to load item';
          setError(msg);
        }
      })
      .finally(() => {
        if (isMounted) {
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [itemId]);

  const handleDelete = async () => {
    if (!itemId || !onDelete || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(itemId);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to delete item';
      setDeleteError(msg);
      setIsDeleting(false);
    }
  };

  if (!itemId) {
    return null;
  }

  const item = data?.item;
  const chunks = data?.chunks || [];
  const isUrl = item?.source_type === 'url';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="detail-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isDeleting) {
          onClose();
        }
      }}
    >
      <div
        ref={modalRef}
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden relative"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/50">
          <div className="flex items-center gap-2.5 min-w-0 pr-4">
            <div className="p-2 rounded-lg bg-indigo-50 text-indigo-600 shrink-0">
              {isUrl ? <Globe className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
            </div>
            <div className="min-w-0">
              <h2 id="detail-title" className="text-sm font-semibold text-slate-900 truncate">
                {item?.title || (isUrl ? item?.source_url : 'Untitled Item')}
              </h2>
              <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
                <span className="capitalize">{item?.source_type}</span>
                {item?.created_at && (
                  <>
                    <span>&bull;</span>
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {new Date(item.created_at).toLocaleString()}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            disabled={isDeleting}
            className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex flex-col gap-6">
          {/* Delete Error Banner */}
          {deleteError && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{deleteError}</span>
            </div>
          )}

          {loading && (
            <div className="p-12 flex flex-col items-center justify-center gap-2 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
              <span className="text-xs">Loading item details and chunks...</span>
            </div>
          )}

          {error && !loading && (
            <div className="p-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {data && !loading && (
            <>
              {/* URL Link if available */}
              {isUrl && item?.source_url && (
                <div className="flex items-center justify-between p-3 rounded-lg bg-slate-50 border border-slate-200/80 text-xs">
                  <span className="font-mono text-slate-600 truncate mr-2">{item.source_url}</span>
                  <a
                    href={item.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 font-medium shrink-0"
                  >
                    <span>Visit Link</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              )}

              {/* Status & Chunks Overview */}
              <div className="flex items-center justify-between text-xs pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <span className="text-slate-500 font-medium">Status:</span>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                      item?.status === 'completed'
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : item?.status === 'failed'
                        ? 'bg-rose-50 text-rose-700 border border-rose-200'
                        : 'bg-amber-50 text-amber-700 border border-amber-200'
                    }`}
                  >
                    {item?.status}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 text-slate-500 font-medium">
                  <Layers className="w-3.5 h-3.5 text-indigo-600" />
                  <span>{chunks.length} Chunks Indexed</span>
                </div>
              </div>

              {/* View Selection Tabs */}
              <div className="flex items-center gap-2 border-b border-slate-200 pb-1">
                <button
                  type="button"
                  onClick={() => setActiveTab('chunks')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                    activeTab === 'chunks'
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>Extracted Chunks ({chunks.length})</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('raw')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                    activeTab === 'raw'
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>Raw Content ({item?.raw_content ? item.raw_content.length : 0} chars)</span>
                </button>
              </div>

              {/* View: Chunks Breakdown */}
              {activeTab === 'chunks' && (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span className="font-bold uppercase tracking-wider">
                      Extracted Semantic Chunks
                    </span>
                    <span className="text-[11px] text-slate-400">
                      Bounded text segments indexed for semantic retrieval
                    </span>
                  </div>

                  {chunks.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-400 bg-slate-50 rounded-lg border border-slate-200">
                      No chunks extracted for this item.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2.5">
                      {chunks.map((chunk) => (
                        <div
                          key={chunk.id}
                          className="p-3.5 rounded-lg border border-slate-200 bg-slate-50/50 flex flex-col gap-2"
                        >
                          <div className="flex items-center justify-between text-[11px] text-slate-500">
                            <span className="inline-flex items-center gap-1 font-semibold text-slate-700">
                              <Hash className="w-3 h-3 text-indigo-600" />
                              Chunk #{chunk.chunk_index + 1}
                            </span>
                            <div className="flex items-center gap-2">
                              <span>{chunk.content.length} chars</span>
                              {chunk.embedding_model && (
                                <span className="px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-700 border border-indigo-100 text-[10px] font-mono">
                                  {chunk.embedding_model}
                                </span>
                              )}
                            </div>
                          </div>
                          <p className="text-xs text-slate-700 font-mono leading-relaxed bg-white p-2.5 rounded border border-slate-200/80 whitespace-pre-wrap break-words">
                            {chunk.content}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* View: Original Raw Content */}
              {activeTab === 'raw' && (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span className="font-bold uppercase tracking-wider">
                      Original Raw Content
                    </span>
                    <span className="text-[11px] text-slate-400">
                      Full un-truncated source text stored in Turso
                    </span>
                  </div>

                  <div className="p-4 rounded-lg border border-slate-200 bg-white shadow-xs max-h-[380px] overflow-y-auto">
                    <pre className="text-xs text-slate-800 font-mono whitespace-pre-wrap break-words leading-relaxed">
                      {item?.raw_content || 'No raw content stored.'}
                    </pre>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-3.5 border-t border-slate-100 bg-slate-50/50 flex flex-col gap-3">
          {confirmingDelete ? (
            <div className="flex items-center justify-between gap-3 p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-xs">
              <div className="flex items-center gap-2 text-rose-800 font-medium">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>Permanently delete this item and its vectors?</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={isDeleting}
                  className="px-3 py-1 rounded-lg bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 font-medium transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-medium shadow-xs transition-colors cursor-pointer"
                >
                  {isDeleting ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    <>
                      <Trash2 className="w-3 h-3" />
                      Confirm Delete
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {onDelete && item && (
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-600 hover:text-rose-700 transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Item
                  </button>
                )}
                {item?.title && onAskAboutItem && (
                  <button
                    type="button"
                    onClick={() => {
                      onAskAboutItem({ id: itemId!, title: item.title! });
                      onClose();
                    }}
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 cursor-pointer"
                  >
                    Ask question about this item &rarr;
                  </button>
                )}
              </div>
              <div>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-1.5 rounded-lg text-xs font-medium bg-slate-200 hover:bg-slate-300 text-slate-700 transition-colors cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
