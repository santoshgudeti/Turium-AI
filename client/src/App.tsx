import React from 'react';
import {
  Inbox,
  PlusCircle,
  FileText,
  Search,
  Sparkles,
  Info,
  Clock,
  Layers,
} from 'lucide-react';

export const App: React.FC = () => {
  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Navigation Bar */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-indigo-600 rounded-lg text-white">
              <Inbox className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-slate-900">
                AI Knowledge Inbox
              </h1>
              <p className="text-xs text-slate-500">
                Turium Enterprise AI Assessment
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
              <span className="w-1.5 h-1.5 mr-1.5 bg-emerald-500 rounded-full"></span>
              Environment Ready (T-001)
            </span>
          </div>
        </div>
      </header>

      {/* Main Workspace Layout */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Ingestion & Saved Items */}
        <section className="lg:col-span-5 space-y-6">
          {/* Section 1: Content Ingestion Placeholder */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2">
                <PlusCircle className="w-5 h-5 text-indigo-600" />
                <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wider">
                  Ingest Content
                </h2>
              </div>
              <span className="text-xs text-slate-400">POST /ingest</span>
            </div>
            <div className="p-8 border-2 border-dashed border-slate-200 rounded-lg text-center bg-slate-50">
              <FileText className="w-8 h-8 text-slate-400 mx-auto mb-2" />
              <p className="text-sm font-medium text-slate-600">
                Content Ingestion Interface
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Plain-text note and server-side URL scraper input will be wired
                here in subsequent milestones.
              </p>
            </div>
          </div>

          {/* Section 2: Saved Knowledge Items Placeholder */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2">
                <Layers className="w-5 h-5 text-indigo-600" />
                <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wider">
                  Saved Knowledge Items
                </h2>
              </div>
              <span className="text-xs text-slate-400">GET /items</span>
            </div>
            <div className="p-8 border-2 border-dashed border-slate-200 rounded-lg text-center bg-slate-50">
              <Clock className="w-8 h-8 text-slate-400 mx-auto mb-2" />
              <p className="text-sm font-medium text-slate-600">
                Knowledge Stream
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Stored raw items, metadata, and timestamps will populate this
                feed.
              </p>
            </div>
          </div>
        </section>

        {/* Right Column: Q&A / Semantic Search Interface Placeholder */}
        <section className="lg:col-span-7">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 h-full flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2">
                <Sparkles className="w-5 h-5 text-indigo-600" />
                <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wider">
                  Ask Knowledge Inbox (RAG)
                </h2>
              </div>
              <span className="text-xs text-slate-400">POST /query</span>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center p-12 border-2 border-dashed border-slate-200 rounded-lg text-center bg-slate-50 min-h-[350px]">
              <Search className="w-10 h-10 text-slate-400 mb-3" />
              <h3 className="text-base font-semibold text-slate-700">
                Semantic Question Answering
              </h3>
              <p className="text-xs text-slate-500 max-w-md mt-1 mb-4">
                Ask questions across saved content. Context retrieval, chunk
                citations, and LLM responses will render here.
              </p>
              <div className="inline-flex items-center space-x-2 text-xs text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-md border border-indigo-100">
                <Info className="w-4 h-4" />
                <span>RAG pipeline pending implementation in milestone T-002+</span>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-4 text-center text-xs text-slate-400">
        AI Knowledge Inbox &bull; Turium AI Interview Assessment &bull; Architecture Milestone T-001
      </footer>
    </div>
  );
};

export default App;
