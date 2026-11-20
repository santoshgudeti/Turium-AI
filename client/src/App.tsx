import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Navbar } from './components/Navbar';
import { KnowledgeList } from './components/KnowledgeList';
import { AskAI } from './components/AskAI';
import { AddKnowledgeModal } from './components/AddKnowledgeModal';
import { ItemDetailModal } from './components/ItemDetailModal';
import { api } from './api/client';
import { ItemSummary, IngestResult, DeleteItemResult } from './api/types';
import { AlertCircle, RefreshCw } from 'lucide-react';

export const App: React.FC = () => {
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [loadingItems, setLoadingItems] = useState<boolean>(true);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [apiHealthy, setApiHealthy] = useState<boolean | null>(null);

  // Modals state
  const [isAddModalOpen, setIsAddModalOpen] = useState<boolean>(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  // Cross-component communication
  const [activeQuestion, setActiveQuestion] = useState<string>('');
  const [activeScopedItem, setActiveScopedItem] = useState<{ id: string; title: string } | null>(null);
  const askAiSectionRef = useRef<HTMLDivElement>(null);
  const isCheckingHealth = useRef<boolean>(false);

  // Fetch health status with overlap guard
  const checkHealth = useCallback(async () => {
    if (isCheckingHealth.current) return;
    isCheckingHealth.current = true;
    try {
      const res = await api.getHealth();
      setApiHealthy(res.status === 'ok');
    } catch {
      setApiHealthy(false);
    } finally {
      isCheckingHealth.current = false;
    }
  }, []);

  // Fetch knowledge items
  const loadItems = useCallback(async () => {
    setLoadingItems(true);
    setItemsError(null);
    try {
      const res = await api.getItems();
      setItems(res.items);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load saved items from backend';
      setItemsError(msg);
    } finally {
      setLoadingItems(false);
    }
  }, []);

  useEffect(() => {
    checkHealth();
    loadItems();

    // 30-second periodic health check with unmount cleanup
    const intervalId = window.setInterval(() => {
      checkHealth();
    }, 30000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [checkHealth, loadItems]);

  // Handle newly ingested item
  const handleItemCreated = (_result: IngestResult) => {
    setIsAddModalOpen(false);
    // Refresh items to display the newly ingested item with accurate chunk counts
    loadItems();
  };

  // Inspect item details and chunks
  const handleInspectItem = (itemId: string) => {
    setSelectedItemId(itemId);
  };

  // Ask AI about a specific item — FE-003: sets scope so queries are restricted to that item
  const handleAskAboutItem = (item: { id: string; title: string }) => {
    setActiveScopedItem(item);
    setActiveQuestion(`What are the key points and findings in "${item.title}"?`);

    // Smooth scroll to Ask AI panel if on mobile/smaller screens
    if (askAiSectionRef.current) {
      askAiSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Handle item deletion: cleans up scope, open detail modal, and reloads items
  const handleDeleteItem = async (itemId: string): Promise<DeleteItemResult> => {
    const res = await api.deleteItem(itemId);

    // If the deleted item is currently viewed in detail modal, close it
    if (selectedItemId === itemId) {
      setSelectedItemId(null);
    }

    // If the deleted item is the currently scoped item for Ask AI, clear scope and question
    if (activeScopedItem?.id === itemId) {
      setActiveScopedItem(null);
      setActiveQuestion('');
    }

    // Reload knowledge items to update counts, filters, and list view
    await loadItems();

    return res;
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 font-sans">
      {/* Top Navigation */}
      <Navbar
        itemCount={items.length}
        apiHealthy={apiHealthy}
        onOpenAddModal={() => setIsAddModalOpen(true)}
      />

      {/* Main Workspace Layout */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Offline / Error Banner */}
        {apiHealthy === false && (
          <div className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-between text-amber-800 text-sm">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
              <span>
                Backend API is currently unreachable. Ensure the Express server is running on port 4000.
              </span>
            </div>
            <button
              onClick={() => {
                checkHealth();
                loadItems();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-900 rounded-lg text-xs font-medium transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry Connection
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Left Column: Knowledge Inbox (Items Feed) */}
          <section className="lg:col-span-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900 tracking-tight">Saved Knowledge</h2>
                <p className="text-xs text-slate-500">
                  Notes and web sources indexed in Turso libSQL and Qdrant Cloud
                </p>
              </div>
              <button
                onClick={loadItems}
                disabled={loadingItems}
                title="Refresh saved items"
                className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
              >
                <RefreshCw className={`w-4 h-4 ${loadingItems ? 'animate-spin text-indigo-600' : ''}`} />
              </button>
            </div>

            {itemsError && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{itemsError}</span>
              </div>
            )}

            <KnowledgeList
              items={items}
              loading={loadingItems}
              onInspect={handleInspectItem}
              onAskAboutItem={handleAskAboutItem}
              onAddNew={() => setIsAddModalOpen(true)}
              onDelete={handleDeleteItem}
            />
          </section>

          {/* Right Column: Ask AI (Grounded RAG Interface) */}
          <section ref={askAiSectionRef} className="lg:col-span-6 space-y-4">
            <div>
              <h2 className="text-lg font-bold text-slate-900 tracking-tight">Ask Knowledge Inbox</h2>
              <p className="text-xs text-slate-500">
                Grounded semantic question answering with verified chunk citations
              </p>
            </div>

            <AskAI
              itemCount={items.length}
              initialQuestion={activeQuestion}
              onOpenAddModal={() => setIsAddModalOpen(true)}
              onInspectItem={handleInspectItem}
              activeScopedItem={activeScopedItem}
              onClearScope={() => setActiveScopedItem(null)}
            />
          </section>
        </div>
      </main>

      {/* Ingest Modal */}
      <AddKnowledgeModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onSuccess={handleItemCreated}
      />

      {/* Inspect Item & Chunks Modal */}
      <ItemDetailModal
        itemId={selectedItemId}
        onClose={() => setSelectedItemId(null)}
        onAskAboutItem={(item) => handleAskAboutItem(item)}
        onDelete={handleDeleteItem}
      />

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-6 mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <div>
            <span className="font-semibold text-slate-700">Turium AI Knowledge Inbox</span> &bull; Full Stack Developer Assessment
          </div>
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  apiHealthy === true
                    ? 'bg-emerald-500'
                    : apiHealthy === false
                    ? 'bg-rose-500'
                    : 'bg-amber-400'
                }`}
              ></span>
              {apiHealthy === true
                ? 'Backend Connected'
                : apiHealthy === false
                ? 'Backend Offline'
                : 'Connecting...'}
            </span>
            <span>React 18 &bull; Express &bull; Turso libSQL &bull; Qdrant Cloud &bull; Gemini 3.5 Flash Lite &bull; Gemini Embedding 001 (1536d)</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
