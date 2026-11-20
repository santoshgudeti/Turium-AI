import React, { useState, useMemo } from 'react';
import { 
  FileText, 
  Globe, 
  ExternalLink, 
  Layers, 
  Clock, 
  Search, 
  Filter, 
  Sparkles, 
  Eye, 
  Plus, 
  CheckCircle2, 
  AlertCircle, 
  Loader2,
  Inbox,
  Trash2,
  AlertTriangle,
  X
} from 'lucide-react';
import { ItemSummary, DeleteItemResult } from '../api/types';

interface KnowledgeListProps {
  items: ItemSummary[];
  loading: boolean;
  onInspect: (itemId: string) => void;
  onAskAboutItem: (item: { id: string; title: string }) => void;
  onAddNew: () => void;
  onDelete?: (itemId: string) => Promise<DeleteItemResult | void>;
}

type FilterType = 'all' | 'note' | 'url';

export const KnowledgeList: React.FC<KnowledgeListProps> = ({
  items,
  loading,
  onInspect,
  onAskAboutItem,
  onAddNew,
  onDelete,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<FilterType>('all');

  // Deletion confirmation and in-flight state
  const [itemPendingDelete, setItemPendingDelete] = useState<ItemSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<{
    type: 'success' | 'warning';
    message: string;
  } | null>(null);

  // Filter by search query across all items first
  const itemsMatchingSearch = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.toLowerCase();
    return items.filter((item) => {
      const titleMatch = (item.title || '').toLowerCase().includes(q);
      const urlMatch = (item.source_url || '').toLowerCase().includes(q);
      return titleMatch || urlMatch;
    });
  }, [items, searchQuery]);

  // Then apply source_type filter
  const filteredItems = useMemo(() => {
    if (filterType === 'all') return itemsMatchingSearch;
    return itemsMatchingSearch.filter((item) => item.source_type === filterType);
  }, [itemsMatchingSearch, filterType]);

  const isSearchActive = searchQuery.trim().length > 0;
  const totalCount = items.length;
  const totalNoteCount = useMemo(() => items.filter((i) => i.source_type === 'note').length, [items]);
  const totalUrlCount = useMemo(() => items.filter((i) => i.source_type === 'url').length, [items]);

  const searchAllCount = itemsMatchingSearch.length;
  const searchNoteCount = useMemo(() => itemsMatchingSearch.filter((i) => i.source_type === 'note').length, [itemsMatchingSearch]);
  const searchUrlCount = useMemo(() => itemsMatchingSearch.filter((i) => i.source_type === 'url').length, [itemsMatchingSearch]);

  const formatDate = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      }).format(date);
    } catch {
      return isoString;
    }
  };

  const handleConfirmDelete = async () => {
    if (!itemPendingDelete || !onDelete || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const result = await onDelete(itemPendingDelete.id);
      const deletedTitle = itemPendingDelete.title || 'Knowledge item';
      setItemPendingDelete(null);
      if (
        result &&
        (result.vector_cleanup_completed === false ||
          result.status === 'partial_success' ||
          result.code === 'VECTOR_CLEANUP_PENDING')
      ) {
        setDeleteNotice({
          type: 'warning',
          message: `Removed "${deletedTitle}" from database. Vector cleanup in Qdrant is pending retry (HTTP 207 Multi-Status).`,
        });
      } else {
        setDeleteNotice({
          type: 'success',
          message: `Deleted "${deletedTitle}" and all its vector points.`,
        });
      }
      setTimeout(() => setDeleteNotice(null), 6000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to delete item from server';
      setDeleteError(msg);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCancelDelete = () => {
    if (isDeleting) return;
    setItemPendingDelete(null);
    setDeleteError(null);
  };

  return (
    <div className="space-y-4">
      {/* Success / Warning Notification Banner */}
      {deleteNotice && (
        <div
          role="status"
          className={`p-3 rounded-xl text-xs flex items-center justify-between transition-all ${
            deleteNotice.type === 'warning'
              ? 'bg-amber-50 border border-amber-200 text-amber-900'
              : 'bg-emerald-50 border border-emerald-200 text-emerald-900'
          }`}
        >
          <div className="flex items-center gap-2">
            {deleteNotice.type === 'warning' ? (
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            )}
            <span>{deleteNotice.message}</span>
          </div>
          <button
            onClick={() => setDeleteNotice(null)}
            className={`p-1 cursor-pointer transition-colors ${
              deleteNotice.type === 'warning'
                ? 'text-amber-500 hover:text-amber-700'
                : 'text-emerald-500 hover:text-emerald-700'
            }`}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Search and Filter Controls */}
      <div className="flex flex-col gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          {/* Search Input */}
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search saved titles or URLs..."
              className="w-full pl-10 pr-16 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600 bg-slate-200 hover:bg-slate-300 px-2 py-0.5 rounded cursor-pointer transition-colors"
                title="Clear search query"
              >
                Clear
              </button>
            )}
          </div>

          {/* Quick Add Button */}
          <button
            onClick={onAddNew}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition-colors shadow-xs cursor-pointer shrink-0"
          >
            <Plus className="w-4 h-4" />
            Add Item
          </button>
        </div>

        {/* Filter Pills with Search-Aware Badges */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-400 flex items-center gap-1 mr-1">
              <Filter className="w-3 h-3" />
              Filter:
            </span>
            <button
              onClick={() => setFilterType('all')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                filterType === 'all'
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              All{' '}
              <span className={`text-[10px] ml-1 px-1.5 py-0.2 rounded-full ${
                filterType === 'all' ? 'bg-slate-700 text-slate-100' : 'bg-slate-200 text-slate-700 font-semibold'
              }`}>
                {isSearchActive ? `${searchAllCount}/${totalCount}` : totalCount}
              </span>
            </button>
            <button
              onClick={() => setFilterType('note')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                filterType === 'note'
                  ? 'bg-amber-600 text-white'
                  : 'bg-amber-50 text-amber-800 hover:bg-amber-100'
              }`}
            >
              Notes{' '}
              <span className={`text-[10px] ml-1 px-1.5 py-0.2 rounded-full ${
                filterType === 'note' ? 'bg-amber-700 text-amber-100' : 'bg-amber-100 text-amber-800 font-semibold'
              }`}>
                {isSearchActive ? `${searchNoteCount}/${totalNoteCount}` : totalNoteCount}
              </span>
            </button>
            <button
              onClick={() => setFilterType('url')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                filterType === 'url'
                  ? 'bg-blue-600 text-white'
                  : 'bg-blue-50 text-blue-800 hover:bg-blue-100'
              }`}
            >
              URLs{' '}
              <span className={`text-[10px] ml-1 px-1.5 py-0.2 rounded-full ${
                filterType === 'url' ? 'bg-blue-700 text-blue-100' : 'bg-blue-100 text-blue-800 font-semibold'
              }`}>
                {isSearchActive ? `${searchUrlCount}/${totalUrlCount}` : totalUrlCount}
              </span>
            </button>
          </div>

          <div className="text-xs text-slate-400">
            {isSearchActive ? (
              <span>Matching <strong>{filteredItems.length}</strong> of {totalCount} total</span>
            ) : (
              <span>Total: <strong>{totalCount}</strong> items</span>
            )}
          </div>
        </div>

        {/* Active Search Summary Banner */}
        {isSearchActive && (
          <div className="flex items-center justify-between px-3 py-1.5 bg-indigo-50 border border-indigo-100 rounded-lg text-xs text-indigo-700">
            <span>
              Searching for <strong>"{searchQuery}"</strong> ({itemsMatchingSearch.length} found)
            </span>
            <button
              onClick={() => setSearchQuery('')}
              className="text-indigo-600 hover:text-indigo-800 font-medium underline cursor-pointer"
            >
              Reset Search
            </button>
          </div>
        )}
      </div>

      {/* Loading State */}
      {loading && items.length === 0 && (
        <div className="p-12 text-center bg-white rounded-xl border border-slate-200">
          <Loader2 className="w-8 h-8 text-indigo-600 animate-spin mx-auto mb-3" />
          <p className="text-sm font-medium text-slate-600">Loading saved knowledge...</p>
        </div>
      )}

      {/* Empty State */}
      {!loading && filteredItems.length === 0 && (
        <div className="p-12 text-center bg-white rounded-xl border border-dashed border-slate-300">
          <div className="w-12 h-12 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-3">
            <Inbox className="w-6 h-6" />
          </div>
          <h3 className="text-sm font-semibold text-slate-900 mb-1">
            {isSearchActive
              ? 'No matching knowledge found'
              : filterType !== 'all'
              ? `No ${filterType === 'note' ? 'notes' : 'URLs'} saved yet`
              : 'Your knowledge inbox is empty'}
          </h3>
          <p className="text-xs text-slate-500 max-w-sm mx-auto mb-4">
            {isSearchActive
              ? `Try adjusting your search terms or clearing the filter.`
              : 'Save personal notes or scrape web articles to start building your personal semantic knowledge base.'}
          </p>
          {isSearchActive ? (
            <button
              onClick={() => setSearchQuery('')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium transition-colors cursor-pointer"
            >
              Clear Search
            </button>
          ) : (
            <button
              onClick={onAddNew}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-medium transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Your First Item
            </button>
          )}
        </div>
      )}

      {/* Items Feed */}
      <div className="space-y-3">
        {filteredItems.map((item) => {
          const isNote = item.source_type === 'note';
          const title = item.title || (isNote ? 'Untitled Note' : item.source_url || 'Untitled URL');

          return (
            <div
              key={item.id}
              className="bg-white rounded-xl border border-slate-200 hover:border-slate-300 shadow-xs hover:shadow-sm transition-all p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 group"
            >
              {/* Item Info */}
              <div className="flex-1 min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Type Badge */}
                  {isNote ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
                      <FileText className="w-3 h-3" />
                      Note
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                      <Globe className="w-3 h-3" />
                      Web URL
                    </span>
                  )}

                  {/* Status Badge */}
                  {item.status === 'completed' && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                      <CheckCircle2 className="w-3 h-3" />
                      Indexed
                    </span>
                  )}
                  {item.status === 'processing' && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Processing
                    </span>
                  )}
                  {item.status === 'failed' && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200">
                      <AlertCircle className="w-3 h-3" />
                      Failed
                    </span>
                  )}

                  {/* Chunk Count Pill */}
                  <span className="inline-flex items-center gap-1 text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-md border border-slate-200">
                    <Layers className="w-3 h-3 text-slate-400" />
                    {item.chunk_count ?? 0} {item.chunk_count === 1 ? 'chunk' : 'chunks'}
                  </span>

                  {/* Timestamp */}
                  <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                    <Clock className="w-3 h-3" />
                    {formatDate(item.created_at)}
                  </span>
                </div>

                {/* Title and URL link */}
                <div className="flex items-center gap-2">
                  <h4 className="text-base font-semibold text-slate-900 truncate">
                    {title}
                  </h4>
                  {item.source_url && (
                    <a
                      href={item.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open source URL in new tab"
                      className="text-slate-400 hover:text-indigo-600 transition-colors shrink-0"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-100">
                <button
                  onClick={() => onInspect(item.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
                  title="Inspect item content and all generated chunks"
                >
                  <Eye className="w-3.5 h-3.5 text-slate-500" />
                  Inspect
                </button>
                <button
                  onClick={() => onAskAboutItem({ id: item.id, title })}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition-colors cursor-pointer"
                  title="Ask a question grounded in this knowledge item"
                >
                  <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
                  Ask AI
                </button>
                {onDelete && (
                  <button
                    onClick={() => {
                      setItemPendingDelete(item);
                      setDeleteError(null);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors cursor-pointer"
                    title="Delete item and vector points"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-rose-500" />
                    Delete
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Confirmation Dialog Modal */}
      {itemPendingDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-in fade-in duration-150"
        >
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h3 id="delete-dialog-title" className="text-base font-bold text-slate-900">
                  Delete Knowledge Item?
                </h3>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Are you sure you want to permanently delete{' '}
                  <strong className="text-slate-700">
                    "{itemPendingDelete.title || 'Untitled'}"
                  </strong>
                  ? This will delete all {itemPendingDelete.chunk_count ?? 0} extracted chunks and
                  associated vector embeddings in Qdrant Cloud. This action cannot be undone.
                </p>
              </div>
            </div>

            {/* Error in modal if deletion failed */}
            {deleteError && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{deleteError}</span>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={handleCancelDelete}
                disabled={isDeleting}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-50 rounded-lg transition-colors shadow-xs cursor-pointer"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Item
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
