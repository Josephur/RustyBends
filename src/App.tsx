import { useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Lock,
  LockOpen,
  Play,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { bookToRustAst, formatBook } from './kernel/ast';
import { LawLockSnapshot, checkBook, createLawLock } from './kernel/checker';
import { emitVerifiedRust } from './kernel/codegen';
import { BEND_EXAMPLES } from './kernel/examples';
import { suggestLawsForBook } from './kernel/lawSuggester';
import { parseBendBook } from './kernel/parser';
import { traceBookLaws } from './kernel/proofTrace';
import { runKernelSelfTests } from './kernel/selftest';
import { AstTree } from './components/AstTree';
import { LawSuggesterPanel } from './components/LawSuggesterPanel';
import { ProofPathView } from './components/ProofPathView';
import { RustAnalyzerView } from './components/RustAnalyzerView';
import { RustCrateKitView } from './components/RustCrateKitView';
import { AiToolkitView } from './components/AiToolkitView';

type PrimaryTab = 'workbench' | 'erasure' | 'laws' | 'crate' | 'ai';
type InspectorTab = 'rust_gen' | 'suggest' | 'ast' | 'erased' | 'rust_ast';
type LawsSubTab = 'verdicts' | 'proof_path' | 'rust_analyzer';

export function App() {
  const [activeTab, setActiveTab] = useState<PrimaryTab>('workbench');
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('rust_gen');
  const [lawsSubTab, setLawsSubTab] = useState<LawsSubTab>('verdicts');
  const [selectedExampleId, setSelectedExampleId] = useState<string>(
    BEND_EXAMPLES[0].id
  );
  const [source, setSource] = useState<string>(BEND_EXAMPLES[0].source);
  const [lawLock, setLawLock] = useState<LawLockSnapshot | null>(null);
  const [selectedProofLaw, setSelectedProofLaw] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [checkCount, setCheckCount] = useState<number>(1);
  const [testRunNonce, setTestRunNonce] = useState<number>(0);

  const parsed = useMemo(() => parseBendBook(source), [source, checkCount]);
  const report = useMemo(
    () => (parsed.book ? checkBook(parsed.book, lawLock) : null),
    [parsed, lawLock]
  );

  const testResults = useMemo(() => {
    void testRunNonce;
    return runKernelSelfTests();
  }, [testRunNonce]);

  const buildPasses =
    parsed.errors.length === 0 && report !== null && report.buildPassed;

  const erasedSource = useMemo(() => {
    if (!report) return '';
    return formatBook(report.erasure.erasedBook, { erased: true });
  }, [report]);

  const generatedRust = useMemo(() => {
    if (!parsed.book || !report) {
      return 'compile_error!("RustyBends parser error — fix syntax errors before codegen.");';
    }
    return emitVerifiedRust(parsed.book, report);
  }, [parsed.book, report]);

  const rustAstOutput = useMemo(() => {
    if (!parsed.book) return '';
    return bookToRustAst(parsed.book);
  }, [parsed.book]);

  const suggestedLaws = useMemo(() => {
    if (!parsed.book || parsed.errors.length > 0) return [];
    return suggestLawsForBook(parsed.book);
  }, [parsed]);

  const proofTraces = useMemo(() => {
    if (!parsed.book) return [];
    return traceBookLaws(parsed.book);
  }, [parsed.book]);

  const handleSelectExample = (id: string) => {
    const example = BEND_EXAMPLES.find((e) => e.id === id);
    if (!example) return;
    setSelectedExampleId(example.id);
    setSource(example.source);
    setLawLock(null);
    setSelectedProofLaw(null);
  };

  const handleResetExample = () => {
    const example = BEND_EXAMPLES.find((e) => e.id === selectedExampleId);
    if (example) {
      setSource(example.source);
      setLawLock(null);
    }
  };

  const handleCheckBuild = () => {
    setCheckCount((c) => c + 1);
  };

  const handleLockLaws = () => {
    if (!parsed.book) return;
    setLawLock(createLawLock(parsed.book));
  };

  const handleUnlockLaws = () => {
    setLawLock(null);
  };

  const handleInsertProof = (lawName: string) => {
    const snippet = `\nproof ${lawName}:\n  refl\n`;
    setSource((prev) => `${prev.trimEnd()}\n${snippet}`);
  };

  const handleInsertLawSnippet = (snippet: string) => {
    setSource((prev) => `${prev.trimEnd()}\n\n${snippet.trim()}\n`);
  };

  const handleLoadBendFromRust = (bendCode: string) => {
    setSource(bendCode);
    setLawLock(null);
    setActiveTab('workbench');
    setInspectorTab('rust_gen');
  };

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      // Clipboard may be restricted
    }
  };

  const lines = source.split('\n');
  const passedTestsCount = testResults.filter((t) => t.passed).length;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Three-zone Top Navigation Bar */}
      <header className="h-14 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-8 shrink-0">
        <button
          type="button"
          onClick={() => setActiveTab('workbench')}
          className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600 rounded"
        >
          RustyBends
        </button>

        <nav
          aria-label="Primary sections"
          className="flex items-center gap-6 overflow-x-auto"
        >
          {(
            [
              ['workbench', 'Workbench'],
              ['erasure', 'Erasure'],
              ['laws', 'Laws & Lock'],
              ['crate', 'Rust Crate'],
              ['ai', 'AI Toolkit'],
            ] as Array<[PrimaryTab, string]>
          ).map(([id, label]) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`h-14 inline-flex items-center text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600 ${
                  isActive
                    ? 'border-blue-700 text-slate-900'
                    : 'border-transparent text-slate-500 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            );
          })}
        </nav>

        <div className="shrink-0">
          <button
            type="button"
            onClick={handleCheckBuild}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
          >
            <Play className="w-3.5 h-3.5" />
            Check Build
          </button>
        </div>
      </header>

      {/* Main Workspace Canvas */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Left Sidebar */}
        <aside className="w-full lg:w-64 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 p-5 flex flex-col gap-6 shrink-0">
          <div>
            <h2 className="text-xs font-semibold text-slate-500 mb-3">
              Verified Core Samples
            </h2>
            <ul className="space-y-1">
              {BEND_EXAMPLES.map((example) => {
                const selected = selectedExampleId === example.id;
                return (
                  <li key={example.id}>
                    <button
                      type="button"
                      onClick={() => handleSelectExample(example.id)}
                      className={`w-full text-left px-3 py-2 rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 ${
                        selected
                          ? 'bg-slate-100 text-slate-900'
                          : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                      }`}
                    >
                      <div className="text-sm font-medium leading-snug">
                        {example.title}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        <span
                          className={
                            example.expectedOutcome === 'pass'
                              ? 'text-emerald-700 font-medium'
                              : 'text-amber-700 font-medium'
                          }
                        >
                          {example.expectedOutcome === 'pass'
                            ? 'Expected pass'
                            : 'Expected fail'}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="border-t border-slate-200 pt-5">
            <h2 className="text-xs font-semibold text-slate-500 mb-3">
              BendTT Quantities
            </h2>
            <dl className="space-y-2.5 text-xs">
              <div>
                <dt className="font-mono font-medium text-slate-700">
                  Dead · q=0 · <span className="text-slate-500">-name</span>
                </dt>
                <dd className="text-slate-500 mt-0.5 leading-relaxed">
                  Types, annotations, and proofs. Checked at build time and erased before Rust emission.
                </dd>
              </div>
              <div>
                <dt className="font-mono font-medium text-blue-700">
                  Live · q=1 · <span className="text-slate-500">name</span>
                </dt>
                <dd className="text-slate-500 mt-0.5 leading-relaxed">
                  Affine runtime values. Used at most once.
                </dd>
              </div>
              <div>
                <dt className="font-mono font-medium text-emerald-700">
                  Data · q=2 · <span className="text-slate-500">+name</span>
                </dt>
                <dd className="text-slate-500 mt-0.5 leading-relaxed">
                  Duplicable pure data. No lambdas or live calls inside.
                </dd>
              </div>
            </dl>
          </div>

          <div className="border-t border-slate-200 pt-5 mt-auto">
            <h2 className="text-xs font-semibold text-slate-500 mb-2">
              Build-Time Architecture
            </h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Verified Core (.bend) compiles to pure zero-dependency Rust. Grab the local{' '}
              <button
                type="button"
                onClick={() => setActiveTab('crate')}
                className="text-blue-700 hover:underline font-medium"
              >
                rusty-bends-build
              </button>{' '}
              crate and{' '}
              <button
                type="button"
                onClick={() => setActiveTab('ai')}
                className="text-blue-700 hover:underline font-medium"
              >
                BEND_GUIDE.md
              </button>{' '}
              for your Cargo workspace.
            </p>
          </div>
        </aside>

        {/* Main Content Viewport */}
        <main className="flex-1 min-w-0 p-6 lg:p-8 flex flex-col gap-6">
          {/* Build Verdict Summary Strip */}
          <section
            aria-label="Build verdict"
            className="bg-white border border-slate-200 rounded-lg px-5 py-4 flex flex-wrap items-center justify-between gap-4"
          >
            <div className="flex items-center gap-3 min-w-0">
              {buildPasses ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
              ) : (
                <XCircle className="w-5 h-5 text-red-600 shrink-0" />
              )}
              <div className="min-w-0">
                <h1 className="text-sm font-semibold text-slate-900">
                  {buildPasses
                    ? 'Build Passed — Verified Core emitted to pure Rust'
                    : 'Build Failed — Kernel errors, counterexample, or lock violation'}
                </h1>
                <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                  {parsed.book?.defs.length ?? 0} defs · {parsed.book?.laws.length ?? 0} laws ·{' '}
                  {parsed.errors.length + (report?.diagnostics.length ?? 0)} diagnostics ·{' '}
                  {lawLock
                    ? report?.lockCheck.valid
                      ? 'LAWS.bend locked (intact)'
                      : 'LAWS.bend lock TAMPERED'
                    : 'LAWS.bend unlocked'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {lawLock ? (
                <button
                  type="button"
                  onClick={handleUnlockLaws}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 hover:bg-amber-100 rounded-md transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600"
                >
                  <LockOpen className="w-3.5 h-3.5" />
                  Unlock Laws
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleLockLaws}
                  disabled={!parsed.book || parsed.book.laws.length === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600"
                >
                  <Lock className="w-3.5 h-3.5" />
                  Lock Laws
                </button>
              )}
              <button
                type="button"
                onClick={handleResetExample}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </button>
            </div>
          </section>

          {activeTab === 'workbench' && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
              {/* Left Column: BendTT Editor + Diagnostics */}
              <div className="flex flex-col gap-6 min-w-0">
                <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-4">
                    <div className="text-xs font-semibold text-slate-700">
                      verified/core.bend
                    </div>
                    <div className="text-xs text-slate-500 tabular-nums">
                      {lines.length} lines
                    </div>
                  </div>
                  <div className="flex bg-slate-950 text-slate-100 max-h-[430px] overflow-y-auto">
                    <div
                      aria-hidden="true"
                      className="select-none py-4 pl-3 pr-3 text-right font-mono text-xs leading-6 text-slate-500 border-r border-slate-800 tabular-nums shrink-0"
                    >
                      {lines.map((_, idx) => (
                        <div key={idx}>{idx + 1}</div>
                      ))}
                    </div>
                    <textarea
                      aria-label="BendTT source editor"
                      spellCheck={false}
                      value={source}
                      onChange={(e) => setSource(e.target.value)}
                      rows={Math.max(15, lines.length + 1)}
                      className="code-input flex-1 w-full bg-transparent p-4 font-mono text-xs leading-6 text-slate-100 resize-none focus:outline-none overflow-x-auto"
                    />
                  </div>
                </section>

                {/* Diagnostics Table */}
                <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                    <h2 className="text-xs font-semibold text-slate-700">
                      Build Gate Diagnostics &amp; AI Hints
                    </h2>
                    <span className="text-xs text-slate-500 tabular-nums">
                      {parsed.errors.length + (report?.diagnostics.length ?? 0)} total
                    </span>
                  </div>

                  {parsed.errors.length === 0 &&
                  (report?.diagnostics.length ?? 0) === 0 ? (
                    <div className="px-4 py-6 text-sm text-emerald-700 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      All quantities, erasure invariants, and laws verified. Safe to emit Rust.
                    </div>
                  ) : (
                    <ul className="divide-y divide-slate-200">
                      {parsed.errors.map((err, i) => (
                        <li
                          key={`parse-${i}`}
                          className="px-4 py-3 flex items-start gap-3 text-xs"
                        >
                          <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <div className="font-mono font-medium text-red-700">
                              E_PARSE · line {err.line}:{err.column}
                            </div>
                            <div className="text-slate-800 mt-0.5">{err.message}</div>
                          </div>
                        </li>
                      ))}
                      {report?.diagnostics.map((diag, i) => (
                        <li
                          key={`diag-${i}`}
                          className="px-4 py-3 flex items-start gap-3 text-xs"
                        >
                          <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                          <div className="min-w-0 space-y-1">
                            <div className="font-mono font-medium text-red-700">
                              {diag.code} · {diag.scope}
                              {diag.line ? ` · line ${diag.line}` : ''}
                            </div>
                            <div className="text-slate-800">{diag.message}</div>
                            {diag.fixHint && (
                              <div className="text-slate-500">
                                Fix hint: {diag.fixHint}
                              </div>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>

              {/* Right Column: Inspector Tabs */}
              <section className="bg-white border border-slate-200 rounded-lg overflow-hidden min-w-0">
                <div className="px-4 py-2.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                  <div
                    role="tablist"
                    aria-label="Kernel output views"
                    className="flex items-center gap-1 bg-slate-100 p-1 rounded-md overflow-x-auto"
                  >
                    {(
                      [
                        ['rust_gen', 'Generated Rust'],
                        [
                          'suggest',
                          `Suggest Laws (${suggestedLaws.length})`,
                        ],
                        ['ast', 'AST Tree'],
                        ['erased', 'Erased Core'],
                        ['rust_ast', 'Rust AST'],
                      ] as Array<[InspectorTab, string]>
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        role="tab"
                        aria-selected={inspectorTab === id}
                        type="button"
                        onClick={() => setInspectorTab(id)}
                        className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600 ${
                          inspectorTab === id
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {inspectorTab !== 'ast' && inspectorTab !== 'suggest' && (
                    <button
                      type="button"
                      onClick={() =>
                        handleCopy(
                          inspectorTab,
                          inspectorTab === 'rust_gen'
                            ? generatedRust
                            : inspectorTab === 'erased'
                              ? erasedSource
                              : rustAstOutput
                        )
                      }
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600 rounded px-2 py-1"
                    >
                      {copiedKey === inspectorTab ? (
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
                  )}
                </div>

                <div className="p-4 max-h-[640px] overflow-auto">
                  {inspectorTab === 'suggest' && (
                    <LawSuggesterPanel
                      suggestions={suggestedLaws}
                      onInsertLaw={handleInsertLawSnippet}
                      onOpenRustAnalyzer={() => {
                        setActiveTab('laws');
                        setLawsSubTab('rust_analyzer');
                      }}
                    />
                  )}

                  {inspectorTab === 'rust_gen' && (
                    <div className="space-y-3">
                      <p className="text-xs text-slate-500">
                        Pure, zero-dependency Rust emitted into Cargo&apos;s{' '}
                        <code className="text-slate-800">OUT_DIR</code> after all proofs pass and{' '}
                        <code className="text-slate-800">q=0</code> terms are erased. Refuses to emit if any check fails.
                      </p>
                      <pre className="bg-slate-950 text-slate-100 rounded-md p-4 font-mono text-xs leading-6 overflow-x-auto">
                        {generatedRust}
                      </pre>
                    </div>
                  )}

                  {inspectorTab === 'ast' && parsed.book && (
                    <AstTree book={parsed.book} />
                  )}

                  {inspectorTab === 'erased' && (
                    <div className="space-y-3">
                      <p className="text-xs text-slate-500">
                        All <code className="text-slate-800">q=0</code> Dead parameters, type
                        annotations, and compile-time laws are stripped before Rust codegen.
                      </p>
                      <pre className="bg-slate-950 text-slate-100 rounded-md p-4 font-mono text-xs leading-6 overflow-x-auto">
                        {erasedSource || '// No live definitions to emit'}
                      </pre>
                    </div>
                  )}

                  {inspectorTab === 'rust_ast' && (
                    <div className="space-y-3">
                      <p className="text-xs text-slate-500">
                        Equivalent Rust AST structs matching{' '}
                        <code className="text-slate-800">rusty_bends::Book</code>.
                      </p>
                      <pre className="bg-slate-950 text-slate-100 rounded-md p-4 font-mono text-xs leading-6 overflow-x-auto">
                        {rustAstOutput}
                      </pre>
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}

          {activeTab === 'erasure' && report && (
            <div className="space-y-6">
              <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  {
                    label: 'Dead Params Erased',
                    value: report.erasure.deadParamsErased,
                  },
                  {
                    label: 'Annotations Erased',
                    value: report.erasure.annotationsErased,
                  },
                  {
                    label: 'Laws Erased',
                    value: report.erasure.lawsErased,
                  },
                  {
                    label: 'Remaining Dead Nodes',
                    value: report.erasure.remainingDeadNodes,
                    highlight: report.erasure.remainingDeadNodes === 0,
                  },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className="bg-white border border-slate-200 rounded-lg px-4 py-3.5"
                  >
                    <div className="text-xs text-slate-500">{stat.label}</div>
                    <div
                      className={`mt-1 text-2xl font-semibold font-mono tabular-nums ${
                        stat.highlight ? 'text-emerald-700' : 'text-slate-900'
                      }`}
                    >
                      {stat.value}
                    </div>
                  </div>
                ))}
              </section>

              <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 text-xs font-semibold text-slate-700">
                    Before Erasure (Source Book + q=0 Laws)
                  </div>
                  <pre className="p-4 bg-slate-950 text-slate-100 font-mono text-xs leading-6 overflow-x-auto min-h-[260px]">
                    {parsed.book ? formatBook(parsed.book) : ''}
                  </pre>
                </div>

                <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 text-xs font-semibold text-slate-700">
                    After q=0 Erasure (Pure Rust Emitted Target)
                  </div>
                  <pre className="p-4 bg-slate-950 text-slate-100 font-mono text-xs leading-6 overflow-x-auto min-h-[260px]">
                    {generatedRust}
                  </pre>
                </div>
              </section>
            </div>
          )}

          {activeTab === 'laws' && report && (
            <div className="space-y-6">
              {/* Sub-navigation for Active Laws vs Rust Code Analyzer */}
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div
                  role="tablist"
                  aria-label="Laws and analyzer modes"
                  className="inline-flex items-center gap-1 bg-slate-200/70 p-1 rounded-md"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={lawsSubTab === 'verdicts'}
                    onClick={() => setLawsSubTab('verdicts')}
                    className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600 ${
                      lawsSubTab === 'verdicts'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Active Laws &amp; Lock
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={lawsSubTab === 'proof_path'}
                    onClick={() => setLawsSubTab('proof_path')}
                    className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600 ${
                      lawsSubTab === 'proof_path'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Proof Path ({proofTraces.length})
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={lawsSubTab === 'rust_analyzer'}
                    onClick={() => setLawsSubTab('rust_analyzer')}
                    className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600 ${
                      lawsSubTab === 'rust_analyzer'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Rust → Laws Analyzer
                  </button>
                </div>
              </div>

              {lawsSubTab === 'rust_analyzer' ? (
                <RustAnalyzerView onLoadBendCore={handleLoadBendFromRust} />
              ) : lawsSubTab === 'proof_path' ? (
                <ProofPathView
                  traces={proofTraces}
                  selectedLawName={selectedProofLaw}
                  onSelectLaw={setSelectedProofLaw}
                  onInsertProof={handleInsertProof}
                  onLoadSample={handleSelectExample}
                />
              ) : (
                <>
                  {/* Anti-Cheat LAWS.bend Lock Panel */}
                  <section className="bg-white border border-slate-200 rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
                    <div className="space-y-1">
                      <h2 className="text-sm font-semibold text-slate-900">
                        Anti-Cheat LAWS.bend Lock
                      </h2>
                  <p className="text-xs text-slate-500 max-w-2xl">
                    Prevents AI models from deleting or weakening laws to force a green build.
                    Once locked, editing any law statement trips{' '}
                    <code className="text-slate-800">E_LAW_LOCK_TAMPERED</code> and blocks Rust codegen.
                  </p>
                  <div className="text-xs font-mono text-slate-600 pt-1">
                    Current fingerprint: {report.lockCheck.currentFingerprint}
                    {lawLock ? ` · Locked: ${lawLock.fingerprint}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {lawLock ? (
                    <button
                      type="button"
                      onClick={handleUnlockLaws}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 hover:bg-amber-100 rounded-md transition-colors whitespace-nowrap"
                    >
                      <LockOpen className="w-3.5 h-3.5" />
                      Approve &amp; Unlock Laws
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleLockLaws}
                      disabled={!parsed.book || parsed.book.laws.length === 0}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap"
                    >
                      <Lock className="w-3.5 h-3.5" />
                      Lock Current Laws
                    </button>
                  )}
                </div>
              </section>

              {/* Laws & Counterexample Table */}
              <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">
                      Laws, Proofs &amp; Counterexample Search
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Failed laws automatically run fast input search to report concrete counterexamples before an AI wastes turns searching for an impossible proof.
                    </p>
                  </div>
                  <span className="text-xs font-medium text-slate-600 tabular-nums shrink-0">
                    {report.lawVerdicts.filter((v) => v.passed).length} /{' '}
                    {report.lawVerdicts.length} proven
                  </span>
                </div>

                {report.lawVerdicts.length === 0 ? (
                  <div className="px-5 py-10 text-center text-sm text-slate-500">
                    No laws declared in this program. Select{' '}
                    <button
                      type="button"
                      onClick={() => handleSelectExample('false_law_ce')}
                      className="text-blue-700 hover:underline font-medium"
                    >
                      False Law Counterexample
                    </button>{' '}
                    or{' '}
                    <button
                      type="button"
                      onClick={() => handleSelectExample('unproven_law')}
                      className="text-blue-700 hover:underline font-medium"
                    >
                      Unproven Law Build Gate
                    </button>
                    .
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                          <th className="py-2.5 px-4 font-semibold">Law</th>
                          <th className="py-2.5 px-4 font-semibold">Statement</th>
                          <th className="py-2.5 px-4 font-semibold">Normalized LHS / RHS</th>
                          <th className="py-2.5 px-4 font-semibold">Verdict</th>
                          <th className="py-2.5 px-4 font-semibold text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {report.lawVerdicts.map((v) => (
                          <tr key={v.name} className="hover:bg-slate-50/70">
                            <td className="py-3 px-4 font-mono font-medium text-slate-900 whitespace-nowrap">
                              {v.name}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-700">
                              {v.statement}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-600">
                              {v.normalizedLhs} == {v.normalizedRhs}
                            </td>
                            <td className="py-3 px-4">
                              <div
                                className={`font-medium ${
                                  v.passed ? 'text-emerald-700' : 'text-red-700'
                                }`}
                              >
                                {v.passed
                                  ? 'Proven'
                                  : v.counterexample
                                    ? 'False (Counterexample)'
                                    : 'Unproven'}
                              </div>
                              <div className="text-slate-500 mt-0.5">{v.reason}</div>
                            </td>
                            <td className="py-3 px-4 text-right whitespace-nowrap">
                              <div className="inline-flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedProofLaw(v.name);
                                    setLawsSubTab('proof_path');
                                  }}
                                  className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap"
                                >
                                  Trace Path
                                </button>
                                {!v.passed && !v.counterexample && (
                                  <button
                                    type="button"
                                    onClick={() => handleInsertProof(v.name)}
                                    className="px-3 py-1.5 text-xs font-medium text-blue-700 border border-blue-200 hover:bg-blue-50 rounded-md transition-colors whitespace-nowrap"
                                  >
                                    Add refl Proof
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Kernel Self-Test Suite */}
              <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">
                      Kernel Invariant Self-Tests
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                      {passedTestsCount} of {testResults.length} assertions passing.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTestRunNonce((n) => n + 1)}
                    className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
                  >
                    Re-run Suite
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                        <th className="py-2.5 px-4 font-semibold">Test Case</th>
                        <th className="py-2.5 px-4 font-semibold">Origin</th>
                        <th className="py-2.5 px-4 font-semibold">Assertion</th>
                        <th className="py-2.5 px-4 font-semibold text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {testResults.map((t) => (
                        <tr key={t.name} className="hover:bg-slate-50/70">
                          <td className="py-2.5 px-4 font-mono font-medium text-slate-900 whitespace-nowrap">
                            {t.name}
                          </td>
                          <td className="py-2.5 px-4 text-slate-500 whitespace-nowrap">
                            {t.origin}
                          </td>
                          <td className="py-2.5 px-4 text-slate-700">{t.detail}</td>
                          <td className="py-2.5 px-4 text-right whitespace-nowrap">
                            <span
                              className={`font-medium ${
                                t.passed ? 'text-emerald-700' : 'text-red-700'
                              }`}
                            >
                              {t.passed ? 'Passed' : 'Failed'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
                </>
              )}
            </div>
          )}

          {activeTab === 'crate' && (
            <RustCrateKitView
              currentBendSource={source}
              generatedRustSource={generatedRust}
              lawLockFingerprint={
                report?.lockCheck.currentFingerprint ?? 'bend-lock:empty'
              }
            />
          )}

          {activeTab === 'ai' && <AiToolkitView />}
        </main>
      </div>
    </div>
  );
}

export default App;
