import React from 'react';
import { Sparkles, Plus, Database, CheckCircle, XCircle } from 'lucide-react';

interface NavbarProps {
  itemCount: number;
  apiHealthy: boolean | null;
  onOpenAddModal: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  itemCount,
  apiHealthy,
  onOpenAddModal,
}) => {
  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand identity */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center text-white shadow-md shadow-indigo-100">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-slate-900 text-base tracking-tight">Turium AI</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-semibold border border-indigo-200">
                Knowledge Inbox
              </span>
            </div>
            <p className="text-xs text-slate-500 hidden sm:block">
              Save knowledge, extract chunks, and answer questions with grounded citations
            </p>
          </div>
        </div>

        {/* Status badges & Action buttons */}
        <div className="flex items-center gap-3">
          {/* Backend Status indicator */}
          <div 
            className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border bg-slate-50 border-slate-200"
            title={apiHealthy === true ? 'Backend API is connected & healthy' : apiHealthy === false ? 'Backend API is unreachable' : 'Checking backend status...'}
          >
            {apiHealthy === true ? (
              <>
                <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />
                <span className="text-emerald-700 font-medium">Backend Ready</span>
              </>
            ) : apiHealthy === false ? (
              <>
                <XCircle className="w-3.5 h-3.5 text-rose-500" />
                <span className="text-rose-600 font-medium">Backend Offline</span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping mr-1"></span>
                <span className="text-amber-700">Checking...</span>
              </>
            )}
          </div>

          {/* Item counter */}
          <div className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">
            <Database className="w-3.5 h-3.5 text-slate-500" />
            <span>{itemCount} {itemCount === 1 ? 'Item' : 'Items'}</span>
          </div>

          {/* Add Knowledge Button */}
          <button
            onClick={onOpenAddModal}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white text-sm font-medium rounded-xl shadow-sm hover:shadow transition-all"
          >
            <Plus className="w-4 h-4" />
            <span>Add Knowledge</span>
          </button>
        </div>
      </div>
    </header>
  );
};
