import React, { useMemo, useState } from 'react';
import { AlertTriangle, ArrowUpRight, Check, Copy } from 'lucide-react';
import {
  RUST_ANALYSIS_PRESETS,
  analyzeRustForLaws,
} from '../kernel/lawSuggester';

interface RustAnalyzerViewProps {
  onLoadBendCore: (bendCode: string) => void;
}

export const RustAnalyzerView: React.FC<RustAnalyzerViewProps> = ({
  onLoadBendCore,
}) => {
  const [selectedPresetId, setSelectedPresetId] = useState<string>(
    RUST_ANALYSIS_PRESETS[0].id
  );
  const [rustCode, setRustCode] = useState<string>(
    RUST_ANALYSIS_PRESETS[0].code
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const report = useMemo(() => analyzeRustForLaws(rustCode), [rustCode]);
  const lines = rustCode.split('\n');

  const handleSelectPreset = (id: string) => {
    const found = RUST_ANALYSIS_PRESETS.find((p) => p.id === id);
    if (!found) return;
    setSelectedPresetId(found.id);
    setRustCode(found.code);
  };

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(key);
      window.setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard may be restricted
    }
  };

  return (
    <div className="space-y-6">
      {/* Header + Presets */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Rust Code → Bend 2 Law Analyzer
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Paste Rust code to detect high-risk panics, unchecked arithmetic, mutable conservation
            paths, permission logic, and codec pairs — then extract proven Bend 2 laws straight into
            the Workbench.
          </p>
        </div>

        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-md">
          {RUST_ANALYSIS_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => handleSelectPreset(preset.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600 ${
                selectedPresetId === preset.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
        {/* Left: Rust Input Editor */}
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-4">
            <span className="text-xs font-semibold text-slate-700">
              Rust Source Input (src/*.rs)
            </span>
            <span className="text-xs text-slate-500 tabular-nums">
              {report.functionsScanned} fn{report.functionsScanned === 1 ? '' : 's'} scanned ·{' '}
              {report.findings.length} suggested law{report.findings.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="flex bg-slate-950 text-slate-100 max-h-[540px] overflow-y-auto">
            <div
              aria-hidden="true"
              className="select-none py-4 pl-3 pr-3 text-right font-mono text-xs leading-6 text-slate-500 border-r border-slate-800 tabular-nums shrink-0"
            >
              {lines.map((_, idx) => (
                <div key={idx}>{idx + 1}</div>
              ))}
            </div>
            <textarea
              aria-label="Rust source input for law analysis"
              spellCheck={false}
              value={rustCode}
              onChange={(e) => setRustCode(e.target.value)}
              rows={Math.max(18, lines.length + 1)}
              className="code-input flex-1 w-full bg-transparent p-4 font-mono text-xs leading-6 text-slate-100 resize-none focus:outline-none overflow-x-auto"
            />
          </div>
        </section>

        {/* Right: Risk Findings & Suggested Bend 2 Laws */}
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-xs font-semibold text-slate-700">
              Suggested Bend 2 Laws ({report.findings.length})
            </h3>
            <button
              type="button"
              disabled={report.findings.length === 0}
              onClick={() => onLoadBendCore(report.extractedBendCore)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600"
            >
              Load All into Workbench
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {report.findings.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-slate-500">
              Paste one or more Rust <code className="text-slate-800">fn</code> blocks on the left
              to identify high-risk invariants and generate Bend 2 laws.
            </div>
          ) : (
            <ul className="divide-y divide-slate-200 max-h-[540px] overflow-y-auto">
              {report.findings.map((finding) => (
                <li key={finding.id} className="p-4 space-y-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <AlertTriangle
                          className={`w-3.5 h-3.5 shrink-0 ${
                            finding.severity === 'high'
                              ? 'text-red-600'
                              : 'text-amber-600'
                          }`}
                        />
                        <span className="font-semibold text-slate-900">
                          {finding.riskTitle}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-slate-500 flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-slate-700">
                          fn {finding.fnName}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">line {finding.line}</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={
                            finding.severity === 'high'
                              ? 'text-red-700 font-medium'
                              : 'text-amber-700 font-medium'
                          }
                        >
                          {finding.severity === 'high' ? 'High risk' : 'Medium risk'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{finding.category}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          handleCopy(finding.id, finding.suggestedBendSnippet)
                        }
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap"
                      >
                        {copiedId === finding.id ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-600" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            Copy
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => onLoadBendCore(finding.suggestedBendSnippet)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-blue-700 border border-blue-200 hover:bg-blue-50 rounded-md transition-colors whitespace-nowrap"
                      >
                        Open in Workbench
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <p className="text-xs text-slate-600 leading-relaxed">
                    {finding.explanation}
                  </p>

                  <pre className="bg-slate-950 text-slate-100 rounded p-3 font-mono text-[11px] leading-5 overflow-x-auto">
                    {finding.suggestedBendSnippet}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};
