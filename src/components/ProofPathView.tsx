import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  GitMerge,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { ProofPathTrace, ReductionStep } from '../kernel/proofTrace';

interface ProofPathViewProps {
  traces: ProofPathTrace[];
  selectedLawName: string | null;
  onSelectLaw: (lawName: string) => void;
  onInsertProof: (lawName: string) => void;
  onLoadSample: (exampleId: string) => void;
}

interface SelectedNode {
  side: 'lhs' | 'rhs';
  stepIndex: number;
}

function statusLabel(status: ProofPathTrace['status']): {
  text: string;
  className: string;
} {
  switch (status) {
    case 'proven':
      return { text: 'Proven', className: 'text-emerald-700' };
    case 'false_counterexample':
      return { text: 'False (Counterexample)', className: 'text-red-700' };
    case 'unproven_missing_proof':
      return { text: 'Converged · Proof missing', className: 'text-amber-700' };
    case 'unproven_mismatch':
    case 'invalid_statement':
      return { text: 'Verification failed', className: 'text-red-700' };
  }
}

function strategyLabel(strategy: ProofPathTrace['proofStrategy']): string {
  switch (strategy) {
    case 'refl':
      return 'Direct reflexivity (refl)';
    case 'case_split':
      return 'Exhaustive case split (match)';
    case 'rewrite':
      return 'Lemma rewrite chain (rewrite)';
    case 'missing':
      return 'No proof attached';
  }
}

export function ProofPathView({
  traces,
  selectedLawName,
  onSelectLaw,
  onInsertProof,
  onLoadSample,
}: ProofPathViewProps) {
  const activeTrace = useMemo(() => {
    if (traces.length === 0) return null;
    if (selectedLawName) {
      const found = traces.find((t) => t.lawName === selectedLawName);
      if (found) return found;
    }
    return traces[0];
  }, [traces, selectedLawName]);

  const [selectedBranchIdx, setSelectedBranchIdx] = useState<number>(0);

  // When a law uses structural case splitting (`match`), show the active constructor branch's LHS/RHS lanes
  const hasBranches = Boolean(activeTrace?.branches && activeTrace.branches.length > 0);
  const activeBranchObj = hasBranches
    ? activeTrace!.branches![Math.min(selectedBranchIdx, activeTrace!.branches!.length - 1)]
    : null;

  const displayLhsSteps = activeBranchObj
    ? activeBranchObj.lhsSteps
    : activeTrace?.lhsSteps ?? [];
  const displayRhsSteps = activeBranchObj
    ? activeBranchObj.rhsSteps
    : activeTrace?.rhsSteps ?? [];
  const displayLhsFinal = activeBranchObj
    ? activeBranchObj.lhsFinal
    : activeTrace?.lhsFinal ?? '';
  const displayRhsFinal = activeBranchObj
    ? activeBranchObj.rhsFinal
    : activeTrace?.rhsFinal ?? '';
  const displayConverged = activeBranchObj
    ? activeBranchObj.converged
    : activeTrace?.converged ?? false;

  const maxBranchSteps = Math.max(
    displayLhsSteps.length - 1,
    displayRhsSteps.length - 1,
    0
  );
  const finalStage = maxBranchSteps + 1;

  const [visibleStage, setVisibleStage] = useState<number>(finalStage);
  const [selectedNode, setSelectedNode] = useState<SelectedNode>({
    side: 'lhs',
    stepIndex: 0,
  });
  const [showCounterexampleTrace, setShowCounterexampleTrace] =
    useState<boolean>(true);

  useEffect(() => {
    setSelectedBranchIdx(0);
  }, [activeTrace?.lawName, activeTrace?.statement]);

  useEffect(() => {
    setVisibleStage(finalStage);
    const defaultSide =
      displayLhsSteps.length >= displayRhsSteps.length ? 'lhs' : 'rhs';
    const branch = defaultSide === 'lhs' ? displayLhsSteps : displayRhsSteps;
    setSelectedNode({
      side: defaultSide,
      stepIndex: Math.min(1, Math.max(0, branch.length - 1)),
    });
  }, [
    activeTrace?.lawName,
    activeTrace?.statement,
    selectedBranchIdx,
    finalStage,
    displayLhsSteps.length,
    displayRhsSteps.length,
  ]);

  if (!activeTrace) {
    return (
      <section className="bg-white border border-slate-200 rounded-lg px-6 py-12 text-center space-y-3">
        <GitMerge className="w-6 h-6 text-slate-400 mx-auto" />
        <h2 className="text-sm font-semibold text-slate-900">
          No laws in the current BendTT file
        </h2>
        <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
          Load a Verified Core sample with laws to inspect how BendTT unfolds definitions,
          applies <code className="text-slate-800">rewrite</code> lemmas, splits ADT cases,
          and unifies both sides via <code className="text-slate-800">refl</code>.
        </p>
        <div className="pt-2 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => onLoadSample('order_state_machine')}
            className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap"
          >
            Load Order State Machine (ADT)
          </button>
          <button
            type="button"
            onClick={() => onLoadSample('lemma_rewrite_chain')}
            className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap"
          >
            Load Lemma Rewrite Sample
          </button>
          <button
            type="button"
            onClick={() => onLoadSample('ledger_verified')}
            className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap"
          >
            Load Ledger Conservation
          </button>
        </div>
      </section>
    );
  }

  const badge = statusLabel(activeTrace.status);
  const lhsVisible = displayLhsSteps.slice(0, visibleStage + 1);
  const rhsVisible = displayRhsSteps.slice(0, visibleStage + 1);
  const gateRevealed = visibleStage >= finalStage;

  const activeSideSteps =
    selectedNode.side === 'lhs' ? displayLhsSteps : displayRhsSteps;
  const inspectedStep: ReductionStep | undefined =
    activeSideSteps[selectedNode.stepIndex] ?? activeSideSteps[0];

  const effectivePassed = activeBranchObj
    ? activeBranchObj.passed && activeTrace.status === 'proven'
    : activeTrace.status === 'proven';

  const strokeColor = !gateRevealed
    ? '#cbd5e1'
    : effectivePassed
      ? '#059669'
      : activeTrace.status === 'unproven_missing_proof'
        ? '#d97706'
        : '#dc2626';

  const renderLane = (
    side: 'lhs' | 'rhs',
    title: string,
    allSteps: ReductionStep[],
    visibleSteps: ReductionStep[]
  ) => (
    <div className="flex flex-col min-w-0">
      <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-200">
        <h3 className="text-xs font-semibold text-slate-700">{title}</h3>
        <span className="text-xs text-slate-500 tabular-nums">
          {Math.max(0, allSteps.length - 1)}{' '}
          {allSteps.length - 1 === 1 ? 'rewrite' : 'rewrites'}
        </span>
      </div>

      <ol className="pt-4 flex flex-col">
        {visibleSteps.map((step, idx) => {
          const isSelected =
            selectedNode.side === side && selectedNode.stepIndex === step.index;
          const isFinal = step.index === allSteps.length - 1;
          const isLemma = step.rule === 'lemma_rewrite';
          return (
            <li key={`${side}-${step.index}`} className="flex flex-col">
              {idx > 0 && (
                <div className="py-2 pl-3 flex items-center gap-2 text-xs text-slate-500">
                  <ArrowDown
                    className={`w-3.5 h-3.5 shrink-0 ${
                      isLemma ? 'text-blue-600' : 'text-slate-400'
                    }`}
                  />
                  <span
                    className={`font-medium ${
                      isLemma ? 'text-blue-700 font-mono' : 'text-slate-700'
                    }`}
                  >
                    {step.ruleLabel}
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={() => setSelectedNode({ side, stepIndex: step.index })}
                aria-pressed={isSelected}
                className={`w-full text-left px-3.5 py-3 rounded-md border transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 ${
                  isSelected
                    ? 'border-blue-600 bg-blue-50/40'
                    : isFinal && gateRevealed
                      ? 'border-slate-300 bg-slate-50/80 hover:border-slate-400'
                      : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/60'
                }`}
              >
                <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                  <span className="tabular-nums">
                    Step {step.index} · {step.rule === 'initial' ? 'Start' : step.ruleLabel}
                  </span>
                  {isFinal && (
                    <span className="font-medium text-slate-700">Normal form</span>
                  )}
                </div>
                <div className="mt-1.5 font-mono text-xs text-slate-900 break-words leading-relaxed">
                  {step.after}
                </div>
              </button>
            </li>
          );
        })}

        {visibleSteps.length < allSteps.length && (
          <li className="pt-2 pl-3 text-xs text-slate-400 tabular-nums">
            +{allSteps.length - visibleSteps.length} remaining{' '}
            {allSteps.length - visibleSteps.length === 1 ? 'step' : 'steps'}…
          </li>
        )}
      </ol>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Law Selector & Step Progression Controls */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">
              Proof Path Visualizer (<code className="font-mono">refl</code> ·{' '}
              <code className="font-mono">match</code> ·{' '}
              <code className="font-mono">rewrite</code>)
            </h2>
            <p className="text-xs text-slate-500 max-w-2xl">
              Trace how BendTT unfolds definitions, splits ADT cases, rewrites with proven
              lemmas, and unifies both sides via <code className="text-slate-800">refl</code>.
              All proof work runs at <code className="text-slate-800">q=0</code> and is
              erased before Rust emission.
            </p>
          </div>

          {/* Step Scrubber Toolbar */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-mono text-slate-600 tabular-nums pr-1">
              Stage {visibleStage} / {finalStage}
            </span>
            <button
              type="button"
              onClick={() => setVisibleStage(0)}
              disabled={visibleStage === 0}
              aria-label="Reset to step 0"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Start
            </button>
            <button
              type="button"
              onClick={() => setVisibleStage((s) => Math.max(0, s - 1))}
              disabled={visibleStage === 0}
              aria-label="Previous derivation step"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Prev
            </button>
            <button
              type="button"
              onClick={() => setVisibleStage((s) => Math.min(finalStage, s + 1))}
              disabled={visibleStage >= finalStage}
              aria-label="Next derivation step"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              Next
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setVisibleStage(finalStage)}
              disabled={visibleStage >= finalStage}
              className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              Full Path
            </button>
          </div>
        </div>

        {/* Law Picker Tabs */}
        <div
          role="tablist"
          aria-label="Select law to trace"
          className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-200"
        >
          {traces.map((trace) => {
            const selected = trace.lawName === activeTrace.lawName;
            const st = statusLabel(trace.status);
            return (
              <button
                key={trace.lawName}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onSelectLaw(trace.lawName)}
                className={`px-3 py-1.5 text-xs rounded-md border transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600 ${
                  selected
                    ? 'border-blue-700 bg-blue-50/50 text-slate-900 font-semibold'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'
                }`}
              >
                <span className="font-mono">{trace.lawName}</span>
                <span aria-hidden="true" className="mx-1.5 text-slate-300">
                  ·
                </span>
                <span className={st.className}>
                  {trace.status === 'proven'
                    ? 'Proven'
                    : trace.status === 'false_counterexample'
                      ? 'False'
                      : 'Unproven'}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Main Proof Derivation Diagram */}
      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {/* Law Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="font-mono font-semibold text-slate-900">
                law {activeTrace.lawName}
              </span>
              {activeTrace.quantifiers.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">
                    ({activeTrace.quantifiers.join(', ')})
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className={`font-medium ${badge.className}`}>{badge.text}</span>
            </div>
            <div className="mt-1 font-mono text-sm text-slate-900 break-words">
              {activeTrace.statement}
            </div>
          </div>

          <div className="text-xs text-slate-500 shrink-0 text-right">
            <div>{strategyLabel(activeTrace.proofStrategy)}</div>
            <div className="font-mono text-slate-700 mt-0.5 max-w-xs truncate">
              {activeTrace.proofTerm ?? 'no proof'}
            </div>
          </div>
        </div>

        {/* Structural Case-Split Branch Selector (when proof uses `match`) */}
        {hasBranches && activeTrace.branches && (
          <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="inline-flex items-center gap-1.5 font-semibold text-slate-800">
                <GitBranch className="w-3.5 h-3.5 text-blue-700" />
                Structural Case-Split Branches ({activeTrace.branches.length})
              </div>
              {activeBranchObj && (
                <div className="font-mono text-slate-600">
                  Active substitution: {activeBranchObj.substitutionNote}
                </div>
              )}
            </div>
            <div
              role="tablist"
              aria-label="Proof case-split branches"
              className="flex flex-wrap items-center gap-2"
            >
              {activeTrace.branches.map((branch, idx) => {
                const isSelected = idx === selectedBranchIdx;
                return (
                  <button
                    key={`${branch.patternLabel}-${idx}`}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    onClick={() => setSelectedBranchIdx(idx)}
                    className={`px-3 py-1.5 text-xs rounded-md border transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-600 ${
                      isSelected
                        ? 'border-blue-700 bg-white text-slate-900 font-semibold'
                        : 'border-slate-200 bg-white/70 text-slate-600 hover:border-slate-300 hover:text-slate-900'
                    }`}
                  >
                    <span className="font-mono">case {branch.patternLabel}</span>
                    <span aria-hidden="true" className="mx-1.5 text-slate-300">
                      ·
                    </span>
                    <span
                      className={
                        branch.passed ? 'text-emerald-700' : 'text-red-700'
                      }
                    >
                      {branch.passed ? 'refl ✓' : 'failed'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Two-Lane Reduction Flow */}
        <div className="p-5">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            {renderLane('lhs', 'Left-Hand Side (LHS)', displayLhsSteps, lhsVisible)}
            {renderLane('rhs', 'Right-Hand Side (RHS)', displayRhsSteps, rhsVisible)}
          </div>

          {/* SVG Convergence Connector into the refl Gate */}
          <div className="my-2 hidden lg:block" aria-hidden="true">
            <svg
              viewBox="0 0 800 52"
              className="w-full h-13 overflow-visible"
              preserveAspectRatio="none"
              fill="none"
            >
              <path
                d="M 200 2 C 200 32, 396 20, 396 48"
                stroke={strokeColor}
                strokeWidth="1.75"
                vectorEffect="non-scaling-stroke"
                strokeDasharray={gateRevealed ? undefined : '4 4'}
              />
              <path
                d="M 600 2 C 600 32, 404 20, 404 48"
                stroke={strokeColor}
                strokeWidth="1.75"
                vectorEffect="non-scaling-stroke"
                strokeDasharray={gateRevealed ? undefined : '4 4'}
              />
            </svg>
          </div>

          {/* Final refl Unification Verdict Gate */}
          <div
            className={`mt-4 lg:mt-0 rounded-md border px-5 py-4 flex flex-wrap items-center justify-between gap-4 transition-colors ${
              !gateRevealed
                ? 'border-dashed border-slate-300 bg-slate-50/70'
                : effectivePassed
                  ? 'border-emerald-200 bg-emerald-50/50'
                  : activeTrace.status === 'unproven_missing_proof'
                    ? 'border-amber-200 bg-amber-50/50'
                    : 'border-red-200 bg-red-50/50'
            }`}
          >
            <div className="flex items-start gap-3 min-w-0">
              {!gateRevealed ? (
                <GitMerge className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" />
              ) : effectivePassed ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              ) : activeTrace.status === 'unproven_missing_proof' ? (
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              ) : (
                <XCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              )}

              <div className="min-w-0 space-y-1">
                <div className="text-xs font-semibold text-slate-900">
                  {!gateRevealed
                    ? 'Reflexivity Unification Gate (advance to final stage to verify)'
                    : effectivePassed
                      ? activeBranchObj
                        ? `Branch '${activeBranchObj.patternLabel}' Verified — LHS ≡ RHS ⊢ refl`
                        : 'Unification Succeeded — LHS ≡ RHS ⊢ refl'
                      : activeTrace.status === 'unproven_missing_proof'
                        ? 'Normal Forms Match — Missing Proof Block'
                        : 'Unification Failed — LHS ≠ RHS'}
                </div>
                <div className="font-mono text-xs text-slate-700 break-words">
                  {gateRevealed
                    ? `${displayLhsFinal} ${displayConverged ? '==' : '!='} ${displayRhsFinal}`
                    : `Step through remaining rewrites (${visibleStage} of ${finalStage}) to inspect final normal forms.`}
                </div>
                {gateRevealed && (
                  <p className="text-xs text-slate-600">{activeTrace.verdictSummary}</p>
                )}
              </div>
            </div>

            {gateRevealed && activeTrace.status === 'unproven_missing_proof' && (
              <button
                type="button"
                onClick={() => onInsertProof(activeTrace.lawName)}
                className="px-3.5 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Add refl Proof
              </button>
            )}
          </div>
        </div>

        {/* Selected Step Detail Inspector */}
        {inspectedStep && (
          <div className="px-5 py-4 border-t border-slate-200 bg-slate-50/70 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="font-semibold text-slate-800">
                Selected Step · {selectedNode.side.toUpperCase()} Step {inspectedStep.index} ·{' '}
                <span className="text-blue-700">{inspectedStep.ruleLabel}</span>
              </div>
              <div className="text-slate-500">
                Click any node above to inspect its rewrite rule
              </div>
            </div>
            <p className="text-xs text-slate-600">{inspectedStep.detail}</p>
            {inspectedStep.rule !== 'initial' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                <div className="bg-white border border-slate-200 rounded px-3 py-2">
                  <div className="text-[11px] text-slate-500">Before</div>
                  <div className="font-mono text-xs text-slate-800 mt-0.5 break-words">
                    {inspectedStep.before}
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded px-3 py-2">
                  <div className="text-[11px] text-slate-500">After</div>
                  <div className="font-mono text-xs text-slate-900 font-medium mt-0.5 break-words">
                    {inspectedStep.after}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Concrete Counterexample Evaluation Witness (when law is false) */}
      {activeTrace.counterexampleTrace && (
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Counterexample Evaluation Witness
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Concrete input substitution proving no <code className="text-slate-800">refl</code>{' '}
                proof can exist until the definition is fixed:{' '}
                <span className="font-mono text-red-700 font-medium">
                  {Object.entries(activeTrace.counterexampleTrace.bindings)
                    .map(([k, v]) => `${k} = ${v}`)
                    .join(', ') || 'closed term'}
                </span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowCounterexampleTrace((v) => !v)}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              {showCounterexampleTrace ? 'Hide Witness Steps' : 'Show Witness Steps'}
            </button>
          </div>

          {showCounterexampleTrace && (
            <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <div className="text-xs font-semibold text-slate-700 pb-2 border-b border-slate-200">
                  LHS with Counterexample Inputs →{' '}
                  <span className="font-mono text-red-700">
                    {activeTrace.counterexampleTrace.lhsFinal}
                  </span>
                </div>
                <ol className="pt-3 space-y-2">
                  {activeTrace.counterexampleTrace.lhsSteps.map((s) => (
                    <li
                      key={`ce-lhs-${s.index}`}
                      className="text-xs flex items-baseline gap-2"
                    >
                      <span className="font-mono text-slate-400 tabular-nums shrink-0">
                        {s.index}.
                      </span>
                      <span className="font-mono text-slate-900 break-words">
                        {s.after}
                      </span>
                      <span className="text-slate-500 shrink-0">({s.ruleLabel})</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-700 pb-2 border-b border-slate-200">
                  RHS with Counterexample Inputs →{' '}
                  <span className="font-mono text-red-700">
                    {activeTrace.counterexampleTrace.rhsFinal}
                  </span>
                </div>
                <ol className="pt-3 space-y-2">
                  {activeTrace.counterexampleTrace.rhsSteps.map((s) => (
                    <li
                      key={`ce-rhs-${s.index}`}
                      className="text-xs flex items-baseline gap-2"
                    >
                      <span className="font-mono text-slate-400 tabular-nums shrink-0">
                        {s.index}.
                      </span>
                      <span className="font-mono text-slate-900 break-words">
                        {s.after}
                      </span>
                      <span className="text-slate-500 shrink-0">({s.ruleLabel})</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
