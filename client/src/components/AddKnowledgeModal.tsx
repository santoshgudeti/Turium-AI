import React, { useState, useEffect, useRef } from 'react';
import { X, FileText, Globe, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { IngestPayload, IngestResult } from '../api/types';

interface AddKnowledgeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (result: IngestResult) => void;
}

export const AddKnowledgeModal: React.FC<AddKnowledgeModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [activeTab, setActiveTab] = useState<'note' | 'url'>('note');
  const [noteTitle, setNoteTitle] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [urlInput, setUrlInput] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<string | null>(null);

  const previouslyFocusedElement = useRef<HTMLElement | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const noteTitleInputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Manage body scroll lock, focus trap, and restore focus on close
  useEffect(() => {
    if (!isOpen) return;

    previouslyFocusedElement.current = document.activeElement as HTMLElement;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) {
        e.preventDefault();
        onClose();
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

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      previouslyFocusedElement.current?.focus?.();
    };
  }, [isOpen, loading, onClose]);

  // Autofocus active tab's primary input when opened or tab changed
  useEffect(() => {
    if (!isOpen) return;

    const timer = setTimeout(() => {
      if (activeTab === 'note') {
        noteTitleInputRef.current?.focus();
      } else {
        urlInputRef.current?.focus();
      }
    }, 50);

    return () => clearTimeout(timer);
  }, [isOpen, activeTab]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessInfo(null);

    let payload: IngestPayload;

    if (activeTab === 'note') {
      const trimmedContent = noteContent.trim();
      if (!trimmedContent) {
        setError('Note content cannot be empty.');
        return;
      }
      payload = {
        source_type: 'note',
        title: noteTitle.trim() || undefined,
        content: trimmedContent,
      };
    } else {
      const trimmedUrl = urlInput.trim();
      if (!trimmedUrl) {
        setError('Please enter a valid website URL.');
        return;
      }
      if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
        setError('URL must start with http:// or https://');
        return;
      }
      payload = {
        source_type: 'url',
        url: trimmedUrl,
      };
    }

    setLoading(true);

    try {
      const result = await api.ingest(payload);
      setSuccessInfo(
        `Successfully saved! Extracted and embedded ${result.chunk_count} ${
          result.chunk_count === 1 ? 'chunk' : 'chunks'
        }.`
      );

      // Brief pause to show success checkmark before closing
      setTimeout(() => {
        onSuccess(result);
        setNoteTitle('');
        setNoteContent('');
        setUrlInput('');
        setSuccessInfo(null);
        setLoading(false);
        onClose();
      }, 700);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to ingest content. Please check input and try again.');
      }
      setLoading(false);
    }
  };

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading) {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs transition-opacity animate-fade-in"
    >
      <div
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-lg w-full overflow-hidden flex flex-col max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div>
            <h2 id="modal-title" className="text-base font-semibold text-slate-900">
              Save to Knowledge Inbox
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Add plain text or import remote web pages for semantic search and Q&A.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-slate-200 bg-slate-50/70 px-6 pt-3 gap-2">
          <button
            type="button"
            onClick={() => {
              setActiveTab('note');
              setError(null);
            }}
            className={`pb-2.5 px-3 text-xs font-medium border-b-2 transition-all flex items-center gap-1.5 ${
              activeTab === 'note'
                ? 'border-indigo-600 text-indigo-600 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <FileText className="w-4 h-4" />
            Plain Text Note
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('url');
              setError(null);
            }}
            className={`pb-2.5 px-3 text-xs font-medium border-b-2 transition-all flex items-center gap-1.5 ${
              activeTab === 'url'
                ? 'border-indigo-600 text-indigo-600 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Globe className="w-4 h-4" />
            Web Page URL
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 flex flex-col gap-4 overflow-y-auto">
          {error && (
            <div className="p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-rose-900">Ingestion Error</p>
                <p className="mt-0.5">{error}</p>
              </div>
            </div>
          )}

          {successInfo && (
            <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{successInfo}</span>
            </div>
          )}

          {activeTab === 'note' ? (
            <>
              <div>
                <label htmlFor="note-title" className="block text-xs font-medium text-slate-700 mb-1">
                  Title (Optional)
                </label>
                <input
                  ref={noteTitleInputRef}
                  id="note-title"
                  type="text"
                  value={noteTitle}
                  onChange={(e) => setNoteTitle(e.target.value)}
                  placeholder="e.g. System Design Notes, Meeting Summary..."
                  maxLength={200}
                  disabled={loading}
                  className="w-full text-sm rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-slate-800 placeholder-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none transition-all"
                />
              </div>

              <div>
                <label htmlFor="note-content" className="block text-xs font-medium text-slate-700 mb-1">
                  Note Content <span className="text-rose-500">*</span>
                </label>
                <textarea
                  id="note-content"
                  value={noteContent}
                  onChange={(e) => setNoteContent(e.target.value)}
                  placeholder="Write or paste your note here..."
                  rows={6}
                  required
                  disabled={loading}
                  className="w-full text-sm rounded-lg border border-slate-200 bg-white p-3 text-slate-800 placeholder-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none transition-all resize-none"
                />
                <span className="text-[11px] text-slate-400 block mt-1 text-right">
                  {noteContent.length} characters
                </span>
              </div>
            </>
          ) : (
            <>
              <div>
                <label htmlFor="url-input" className="block text-xs font-medium text-slate-700 mb-1">
                  URL <span className="text-rose-500">*</span>
                </label>
                <input
                  ref={urlInputRef}
                  id="url-input"
                  type="url"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="https://example.com/article"
                  required
                  disabled={loading}
                  className="w-full text-sm rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-slate-800 placeholder-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none transition-all"
                />
                <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
                  The server safely resolves the address with SSRF boundaries, extracts clean article text, chunks the content, and computes embeddings automatically.
                </p>
              </div>
            </>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100 mt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || (activeTab === 'note' ? !noteContent.trim() : !urlInput.trim())}
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Processing & Embedding...</span>
                </>
              ) : (
                <span>Save to Inbox</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
