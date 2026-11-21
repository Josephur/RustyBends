import React from 'react';
import { ArrowRight, Plus } from 'lucide-react';
import { SuggestedLaw } from '../kernel/lawSuggester';

interface LawSuggesterPanelProps {
  suggestions: SuggestedLaw[];
  onInsertLaw: (snippet: string) => void;
  onOpenRustAnalyzer: () => void;
}

export const LawSuggesterPanel: React.FC<LawSuggesterPanelProps> = ({
  suggestions,
  onInsertLaw,
  onOpenRustAnalyzer,
}) => {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          Discovered automatically from your current <code className="text-slate-800">def</code>{' '}
          signatures and bodies, screened against counterexamples.
        </p>
        <button
          type="button"
          onClick={onOpenRustAnalyzer}
          className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-800 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600 rounded"
        >
          Analyze Rust code
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {suggestions.length === 0 ? (
        <div className="py-10 px-4 text-center border border-slate-200 rounded-md bg-slate-50">
          <p className="text-sm font-medium text-slate-800">
            All discovered invariants are already declared
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Add another <code className="text-slate-800">def</code> in the editor or analyze a
            Rust module to discover new laws.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 border border-slate-200 rounded-md overflow-hidden">
          {suggestions.map((item) => (
            <li key={item.id} className="p-3.5 bg-white space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono font-semibold text-slate-900">
                      {item.name}
                    </span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="text-slate-600">{item.category}</span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span
                      className={
                        item.status === 'proven-ready'
                          ? 'text-emerald-700 font-medium'
                          : 'text-amber-700 font-medium'
                      }
                    >
                      {item.status === 'proven-ready'
                        ? 'Proven-ready (refl)'
                        : 'Spec guard'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                    {item.rationale}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => onInsertLaw(item.bendSnippet)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Insert Law
                </button>
              </div>

              <pre className="bg-slate-950 text-slate-100 rounded p-3 font-mono text-[11px] leading-5 overflow-x-auto">
                {item.bendSnippet}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
