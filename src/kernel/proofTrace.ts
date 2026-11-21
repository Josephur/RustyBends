import {
  Book,
  Def,
  Law,
  Quantity,
  Term,
  TypeDef,
  binOpSymbol,
  formatParam,
  formatPattern,
  formatTerm,
} from './ast';
import {
  Counterexample,
  applyLemmaRewrite,
  canonicalizeAdd,
  checkBook,
  findCounterexample,
  matchPattern,
  normalize,
  subst,
  unwindAppChain,
} from './checker';

export type RewriteRuleKind =
  | 'initial'
  | 'delta_unfold'
  | 'beta_reduce'
  | 'let_inline'
  | 'erase_ann'
  | 'nat_eval'
  | 'bool_eval'
  | 'if_branch'
  | 'match_arm'
  | 'nat_identity'
  | 'sub_cancel'
  | 'ac_canon'
  | 'lemma_rewrite'
  | 'normalize';

export interface ReductionStep {
  index: number;
  rule: RewriteRuleKind;
  ruleLabel: string;
  detail: string;
  before: string;
  after: string;
  term: Term;
}

export interface ProofBranchTrace {
  patternLabel: string;
  substitutionNote: string;
  lhsSteps: ReductionStep[];
  rhsSteps: ReductionStep[];
  lhsFinal: string;
  rhsFinal: string;
  converged: boolean;
  passed: boolean;
  proofSummary: string;
}

export interface CounterexampleTrace {
  bindings: Record<string, string>;
  lhsSteps: ReductionStep[];
  rhsSteps: ReductionStep[];
  lhsFinal: string;
  rhsFinal: string;
}

export type ProofTraceStatus =
  | 'proven'
  | 'false_counterexample'
  | 'unproven_missing_proof'
  | 'unproven_mismatch'
  | 'invalid_statement';

export type ProofStrategy = 'refl' | 'case_split' | 'rewrite' | 'missing';

export interface ProofPathTrace {
  lawName: string;
  quantifiers: string[];
  statement: string;
  lhsInitial: string;
  rhsInitial: string;
  lhsSteps: ReductionStep[];
  rhsSteps: ReductionStep[];
  lhsFinal: string;
  rhsFinal: string;
  converged: boolean;
  proofTerm: string | null;
  proofStrategy: ProofStrategy;
  proofSteps: ReductionStep[];
  branches?: ProofBranchTrace[];
  status: ProofTraceStatus;
  verdictSummary: string;
  counterexampleTrace?: CounterexampleTrace;
}

interface SingleStepResult {
  next: Term;
  rule: RewriteRuleKind;
  ruleLabel: string;
  detail: string;
}

function buildCtorTerm(typeName: string | undefined, ctor: string, args: Term[]): Term {
  let acc: Term = { kind: 'Var', name: typeName ? `${typeName}.${ctor}` : ctor };
  for (const arg of args) {
    acc = { kind: 'App', q: Quantity.Live, func: acc, arg };
  }
  return acc;
}

/**
 * Performs a single deterministic small-step reduction matching checker.ts `normalize`.
 * Returns null if the term is already in normal form.
 */
function stepOnce(term: Term, defs: Map<string, Def>): SingleStepResult | null {
  switch (term.kind) {
    case 'Ann': {
      return {
        next: term.term,
        rule: 'erase_ann',
        ruleLabel: 'Erase q=0 annotation',
        detail: `Stripped erased type annotation ': ${formatTerm(term.ty)}' from '${formatTerm(term.term)}'.`,
      };
    }

    case 'Var': {
      const def = defs.get(term.name);
      if (def && def.params.length === 0) {
        return {
          next: def.body,
          rule: 'delta_unfold',
          ruleLabel: 'δ-unfold constant',
          detail: `Unfolded 0-arg definition '${def.name}' to '${formatTerm(def.body)}'.`,
        };
      }
      return null;
    }

    case 'Let': {
      const valStep = stepOnce(term.value, defs);
      if (valStep) {
        return {
          next: { ...term, value: valStep.next },
          rule: valStep.rule,
          ruleLabel: valStep.ruleLabel,
          detail: valStep.detail,
        };
      }
      const inlined = subst(term.body, term.name, term.value);
      return {
        next: inlined,
        rule: 'let_inline',
        ruleLabel: 'Inline let binding',
        detail: `Substituted '${term.name} := ${formatTerm(term.value)}' into body.`,
      };
    }

    case 'Not': {
      const inner = stepOnce(term.operand, defs);
      if (inner) {
        return {
          next: { kind: 'Not', operand: inner.next },
          rule: inner.rule,
          ruleLabel: inner.ruleLabel,
          detail: inner.detail,
        };
      }
      if (term.operand.kind === 'Bool') {
        return {
          next: { kind: 'Bool', value: !term.operand.value },
          rule: 'bool_eval',
          ruleLabel: 'Boolean negation',
          detail: `Evaluated !${term.operand.value} to ${!term.operand.value}.`,
        };
      }
      if (term.operand.kind === 'Not') {
        return {
          next: term.operand.operand,
          rule: 'bool_eval',
          ruleLabel: 'Double negation',
          detail: `Eliminated double negation on '${formatTerm(term.operand.operand)}'.`,
        };
      }
      return null;
    }

    case 'BinOp': {
      const lStep = stepOnce(term.lhs, defs);
      if (lStep) {
        return {
          next: { ...term, lhs: lStep.next },
          rule: lStep.rule,
          ruleLabel: lStep.ruleLabel,
          detail: lStep.detail,
        };
      }
      const rStep = stepOnce(term.rhs, defs);
      if (rStep) {
        return {
          next: { ...term, rhs: rStep.next },
          rule: rStep.rule,
          ruleLabel: rStep.ruleLabel,
          detail: rStep.detail,
        };
      }
      const sym = binOpSymbol(term.op);
      const reduced = normalize(term, defs, 4);
      if (formatTerm(reduced) !== formatTerm(term)) {
        return {
          next: reduced,
          rule: 'bool_eval',
          ruleLabel: `Evaluate (${sym})`,
          detail: `Simplified '${formatTerm(term)}' to '${formatTerm(reduced)}'.`,
        };
      }
      return null;
    }

    case 'If': {
      const cStep = stepOnce(term.cond, defs);
      if (cStep) {
        return {
          next: { ...term, cond: cStep.next },
          rule: cStep.rule,
          ruleLabel: cStep.ruleLabel,
          detail: cStep.detail,
        };
      }
      if (term.cond.kind === 'Bool') {
        const chosen = term.cond.value ? term.thenBranch : term.elseBranch;
        return {
          next: chosen,
          rule: 'if_branch',
          ruleLabel: `Select ${term.cond.value ? 'then' : 'else'} branch`,
          detail: `Condition evaluated to ${term.cond.value}, selecting '${formatTerm(chosen)}'.`,
        };
      }
      const tStep = stepOnce(term.thenBranch, defs);
      if (tStep) {
        return {
          next: { ...term, thenBranch: tStep.next },
          rule: tStep.rule,
          ruleLabel: tStep.ruleLabel,
          detail: tStep.detail,
        };
      }
      const eStep = stepOnce(term.elseBranch, defs);
      if (eStep) {
        return {
          next: { ...term, elseBranch: eStep.next },
          rule: eStep.rule,
          ruleLabel: eStep.ruleLabel,
          detail: eStep.detail,
        };
      }
      if (formatTerm(term.thenBranch) === formatTerm(term.elseBranch)) {
        return {
          next: term.thenBranch,
          rule: 'if_branch',
          ruleLabel: 'Merge identical branches',
          detail: `Both 'if' branches reduce to '${formatTerm(term.thenBranch)}'.`,
        };
      }
      return null;
    }

    case 'Match': {
      const sStep = stepOnce(term.scrutinee, defs);
      if (sStep) {
        return {
          next: { ...term, scrutinee: sStep.next },
          rule: sStep.rule,
          ruleLabel: sStep.ruleLabel,
          detail: sStep.detail,
        };
      }
      for (const arm of term.arms) {
        const matched = matchPattern(arm.pattern, term.scrutinee);
        if (matched !== null) {
          let body = arm.body;
          const notes: string[] = [];
          for (const [k, v] of matched.entries()) {
            body = subst(body, k, v);
            notes.push(`${k} := ${formatTerm(v)}`);
          }
          return {
            next: body,
            rule: 'match_arm',
            ruleLabel: `Match case ${formatPattern(arm.pattern)}`,
            detail:
              notes.length > 0
                ? `Matched '${formatTerm(term.scrutinee)}' against '${formatPattern(arm.pattern)}' (${notes.join(', ')}).`
                : `Matched '${formatTerm(term.scrutinee)}' against '${formatPattern(arm.pattern)}'.`,
          };
        }
      }
      return null;
    }

    case 'App': {
      const { head, args } = unwindAppChain(term);
      if (head.kind === 'Var') {
        const def = defs.get(head.name);
        if (def && args.length === def.params.length && def.params.length > 0) {
          let body = def.body;
          const substNotes: string[] = [];
          for (let i = 0; i < def.params.length; i++) {
            const param = def.params[i];
            const arg = args[i];
            body = subst(body, param.name, arg);
            substNotes.push(`${param.name} := ${formatTerm(arg)}`);
          }
          return {
            next: body,
            rule: 'delta_unfold',
            ruleLabel: `δ-unfold ${def.name}`,
            detail: `Expanded '${def.name}' with ${substNotes.join(', ')}.`,
          };
        }
      }

      if (term.func.kind === 'Lam') {
        const reduced = subst(term.func.body, term.func.param, term.arg);
        return {
          next: reduced,
          rule: 'beta_reduce',
          ruleLabel: 'β-reduction',
          detail: `Applied lambda parameter '${term.func.param} := ${formatTerm(term.arg)}'.`,
        };
      }

      const fnStep = stepOnce(term.func, defs);
      if (fnStep) {
        return {
          next: { ...term, func: fnStep.next },
          rule: fnStep.rule,
          ruleLabel: fnStep.ruleLabel,
          detail: fnStep.detail,
        };
      }
      const argStep = stepOnce(term.arg, defs);
      if (argStep) {
        return {
          next: { ...term, arg: argStep.next },
          rule: argStep.rule,
          ruleLabel: argStep.ruleLabel,
          detail: argStep.detail,
        };
      }
      return null;
    }

    case 'Add': {
      const lhsStep = stepOnce(term.lhs, defs);
      if (lhsStep) {
        return {
          next: { kind: 'Add', lhs: lhsStep.next, rhs: term.rhs },
          rule: lhsStep.rule,
          ruleLabel: lhsStep.ruleLabel,
          detail: lhsStep.detail,
        };
      }
      const rhsStep = stepOnce(term.rhs, defs);
      if (rhsStep) {
        return {
          next: { kind: 'Add', lhs: term.lhs, rhs: rhsStep.next },
          rule: rhsStep.rule,
          ruleLabel: rhsStep.ruleLabel,
          detail: rhsStep.detail,
        };
      }
      if (term.lhs.kind === 'Nat' && term.rhs.kind === 'Nat') {
        const sum = term.lhs.value + term.rhs.value;
        return {
          next: { kind: 'Nat', value: sum },
          rule: 'nat_eval',
          ruleLabel: 'Nat evaluation',
          detail: `Computed literal sum ${term.lhs.value}n + ${term.rhs.value}n = ${sum}n.`,
        };
      }
      if (term.rhs.kind === 'Nat' && term.rhs.value === 0) {
        return {
          next: term.lhs,
          rule: 'nat_identity',
          ruleLabel: 'Additive zero identity',
          detail: `Eliminated '+ 0n' identity on '${formatTerm(term.lhs)}'.`,
        };
      }
      if (term.lhs.kind === 'Nat' && term.lhs.value === 0) {
        return {
          next: term.rhs,
          rule: 'nat_identity',
          ruleLabel: 'Additive zero identity',
          detail: `Eliminated '0n +' identity on '${formatTerm(term.rhs)}'.`,
        };
      }
      const canonical = canonicalizeAdd(term.lhs, term.rhs);
      if (formatTerm(canonical) !== formatTerm(term)) {
        return {
          next: canonical,
          rule: 'ac_canon',
          ruleLabel: 'AC canonicalize (+)',
          detail: `Reordered associative/commutative sum to canonical form '${formatTerm(canonical)}'.`,
        };
      }
      return null;
    }

    case 'Sub': {
      const lhsStep = stepOnce(term.lhs, defs);
      if (lhsStep) {
        return {
          next: { kind: 'Sub', lhs: lhsStep.next, rhs: term.rhs },
          rule: lhsStep.rule,
          ruleLabel: lhsStep.ruleLabel,
          detail: lhsStep.detail,
        };
      }
      const rhsStep = stepOnce(term.rhs, defs);
      if (rhsStep) {
        return {
          next: { kind: 'Sub', lhs: term.lhs, rhs: rhsStep.next },
          rule: rhsStep.rule,
          ruleLabel: rhsStep.ruleLabel,
          detail: rhsStep.detail,
        };
      }
      if (term.lhs.kind === 'Nat' && term.rhs.kind === 'Nat') {
        const diff = Math.max(0, term.lhs.value - term.rhs.value);
        return {
          next: { kind: 'Nat', value: diff },
          rule: 'nat_eval',
          ruleLabel: 'Saturating Nat sub',
          detail: `Computed saturating difference ${term.lhs.value}n - ${term.rhs.value}n = ${diff}n.`,
        };
      }
      if (term.rhs.kind === 'Nat' && term.rhs.value === 0) {
        return {
          next: term.lhs,
          rule: 'nat_identity',
          ruleLabel: 'Subtractive zero identity',
          detail: `Eliminated '- 0n' identity on '${formatTerm(term.lhs)}'.`,
        };
      }
      if (formatTerm(term.lhs) === formatTerm(term.rhs)) {
        return {
          next: { kind: 'Nat', value: 0 },
          rule: 'sub_cancel',
          ruleLabel: 'Self-cancellation',
          detail: `Canceled identical operands '${formatTerm(term.lhs)} - ${formatTerm(term.rhs)}' to 0n.`,
        };
      }
      return null;
    }

    case 'Tup': {
      const fstStep = stepOnce(term.fst, defs);
      if (fstStep) {
        return {
          next: { kind: 'Tup', fst: fstStep.next, snd: term.snd },
          rule: fstStep.rule,
          ruleLabel: fstStep.ruleLabel,
          detail: fstStep.detail,
        };
      }
      const sndStep = stepOnce(term.snd, defs);
      if (sndStep) {
        return {
          next: { kind: 'Tup', fst: term.fst, snd: sndStep.next },
          rule: sndStep.rule,
          ruleLabel: sndStep.ruleLabel,
          detail: sndStep.detail,
        };
      }
      return null;
    }

    case 'Lam': {
      const bodyStep = stepOnce(term.body, defs);
      if (bodyStep) {
        return {
          next: { ...term, body: bodyStep.next },
          rule: bodyStep.rule,
          ruleLabel: bodyStep.ruleLabel,
          detail: bodyStep.detail,
        };
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Traces every reduction step from an initial BendTT term to its normal form.
 * Guarantees parity with `checker.normalize()`.
 */
export function traceReduction(
  initial: Term,
  defs: Map<string, Def>,
  maxSteps = 48
): ReductionStep[] {
  const initialStr = formatTerm(initial);
  const steps: ReductionStep[] = [
    {
      index: 0,
      rule: 'initial',
      ruleLabel: 'Initial expression',
      detail: 'Original term from the law statement before reduction.',
      before: initialStr,
      after: initialStr,
      term: initial,
    },
  ];

  let current = initial;
  for (let i = 1; i <= maxSteps; i++) {
    const res = stepOnce(current, defs);
    if (!res) break;
    const before = formatTerm(current);
    const after = formatTerm(res.next);
    if (before === after) break;
    steps.push({
      index: steps.length,
      rule: res.rule,
      ruleLabel: res.ruleLabel,
      detail: res.detail,
      before,
      after,
      term: res.next,
    });
    current = res.next;
  }

  const expectedFinal = normalize(initial, defs);
  const expectedStr = formatTerm(expectedFinal);
  const lastStr = steps[steps.length - 1].after;
  if (lastStr !== expectedStr) {
    steps.push({
      index: steps.length,
      rule: 'normalize',
      ruleLabel: 'Kernel normal form',
      detail: `Completed full BendTT normalization to '${expectedStr}'.`,
      before: lastStr,
      after: expectedStr,
      term: expectedFinal,
    });
  }

  return steps;
}

function appendReductionTail(
  prefix: ReductionStep[],
  startTerm: Term,
  defs: Map<string, Def>
): ReductionStep[] {
  const tail = traceReduction(startTerm, defs);
  const combined = [...prefix];
  for (let i = 1; i < tail.length; i++) {
    combined.push({
      ...tail[i],
      index: combined.length,
    });
  }
  return combined;
}

function buildCounterexampleTrace(
  law: Law,
  ce: Counterexample,
  defs: Map<string, Def>
): CounterexampleTrace {
  let lhs = law.statement.kind === 'Eq' ? law.statement.lhs : law.statement;
  let rhs = law.statement.kind === 'Eq' ? law.statement.rhs : law.statement;

  for (const [name, rawVal] of Object.entries(ce.bindings)) {
    let valTerm: Term | null = null;
    if (rawVal === 'true' || rawVal === 'false') {
      valTerm = { kind: 'Bool', value: rawVal === 'true' };
    } else if (/^\d+n$/.test(rawVal)) {
      valTerm = { kind: 'Nat', value: Number.parseInt(rawVal.slice(0, -1), 10) };
    } else {
      valTerm = { kind: 'Var', name: rawVal };
    }
    if (valTerm) {
      lhs = subst(lhs, name, valTerm);
      rhs = subst(rhs, name, valTerm);
    }
  }

  const lhsSteps = traceReduction(lhs, defs);
  const rhsSteps = traceReduction(rhs, defs);
  return {
    bindings: ce.bindings,
    lhsSteps,
    rhsSteps,
    lhsFinal: lhsSteps[lhsSteps.length - 1].after,
    rhsFinal: rhsSteps[rhsSteps.length - 1].after,
  };
}

function traceRewriteChain(
  proof: Term,
  lhsInitial: Term,
  rhsInitial: Term,
  defs: Map<string, Def>,
  lawMap: Map<string, Law>
): { lhsSteps: ReductionStep[]; rhsSteps: ReductionStep[] } {
  const lhsSteps: ReductionStep[] = [
    {
      index: 0,
      rule: 'initial',
      ruleLabel: 'Initial expression',
      detail: 'Original LHS from the law statement before lemma rewriting.',
      before: formatTerm(lhsInitial),
      after: formatTerm(lhsInitial),
      term: lhsInitial,
    },
  ];
  const rhsSteps: ReductionStep[] = [
    {
      index: 0,
      rule: 'initial',
      ruleLabel: 'Initial expression',
      detail: 'Original RHS from the law statement before lemma rewriting.',
      before: formatTerm(rhsInitial),
      after: formatTerm(rhsInitial),
      term: rhsInitial,
    },
  ];

  let curLhs = lhsInitial;
  let curRhs = rhsInitial;
  let curProof = proof;

  while (curProof.kind === 'Rewrite') {
    const lemma = lawMap.get(curProof.lemma);
    if (!lemma) break;
    const dir = curProof.reverse ? '<- ' : '';

    const rLhs = applyLemmaRewrite(curLhs, lemma, curProof.reverse);
    if (rLhs.changed) {
      const before = formatTerm(curLhs);
      const after = formatTerm(rLhs.term);
      lhsSteps.push({
        index: lhsSteps.length,
        rule: 'lemma_rewrite',
        ruleLabel: `rewrite ${dir}${curProof.lemma}`,
        detail: `Applied proven lemma '${curProof.lemma}' (${formatTerm(lemma.statement)}) to rewrite LHS.`,
        before,
        after,
        term: rLhs.term,
      });
      curLhs = rLhs.term;
    }

    const rRhs = applyLemmaRewrite(curRhs, lemma, curProof.reverse);
    if (rRhs.changed) {
      const before = formatTerm(curRhs);
      const after = formatTerm(rRhs.term);
      rhsSteps.push({
        index: rhsSteps.length,
        rule: 'lemma_rewrite',
        ruleLabel: `rewrite ${dir}${curProof.lemma}`,
        detail: `Applied proven lemma '${curProof.lemma}' (${formatTerm(lemma.statement)}) to rewrite RHS.`,
        before,
        after,
        term: rRhs.term,
      });
      curRhs = rRhs.term;
    }

    curProof = curProof.rest;
  }

  return {
    lhsSteps: appendReductionTail(lhsSteps, curLhs, defs),
    rhsSteps: appendReductionTail(rhsSteps, curRhs, defs),
  };
}

/**
 * Generates the complete step-by-step proof path trace for a single Law within a Book,
 * supporting `refl`, `rewrite` lemma chains, and exhaustive `match` case-split proofs.
 */
export function traceLawProof(law: Law, book: Book): ProofPathTrace {
  const defs = new Map<string, Def>(book.defs.map((d) => [d.name, d]));
  const typeMap = new Map<string, TypeDef>((book.types ?? []).map((t) => [t.name, t]));
  const lawMap = new Map<string, Law>(book.laws.map((l) => [l.name, l]));
  const quantifiers = law.vars.map((v) => `for ${formatParam(v)}`);
  const statement = formatTerm(law.statement);

  const report = checkBook(book);
  const verdict = report.lawVerdicts.find((v) => v.name === law.name);

  if (law.statement.kind !== 'Eq') {
    const onlySteps = traceReduction(law.statement, defs);
    const finalStr = onlySteps[onlySteps.length - 1].after;
    return {
      lawName: law.name,
      quantifiers,
      statement,
      lhsInitial: statement,
      rhsInitial: '—',
      lhsSteps: onlySteps,
      rhsSteps: [],
      lhsFinal: finalStr,
      rhsFinal: '—',
      converged: false,
      proofTerm: law.proof ? formatTerm(law.proof) : null,
      proofStrategy: 'missing',
      proofSteps: law.proof ? traceReduction(law.proof, defs) : [],
      status: 'invalid_statement',
      verdictSummary: 'Law statement must be an equality (lhs == rhs) to check.',
    };
  }

  const proofStrategy: ProofStrategy = !law.proof
    ? 'missing'
    : law.proof.kind === 'Match'
      ? 'case_split'
      : law.proof.kind === 'Rewrite'
        ? 'rewrite'
        : 'refl';

  // Compute LHS & RHS traces (incorporating lemma rewrites when present)
  const { lhsSteps, rhsSteps } =
    law.proof && law.proof.kind === 'Rewrite'
      ? traceRewriteChain(law.proof, law.statement.lhs, law.statement.rhs, defs, lawMap)
      : {
          lhsSteps: traceReduction(law.statement.lhs, defs),
          rhsSteps: traceReduction(law.statement.rhs, defs),
        };

  const lhsFinal = lhsSteps[lhsSteps.length - 1].after;
  const rhsFinal = rhsSteps[rhsSteps.length - 1].after;

  // Build structural case-split branch traces when proof is `match v: case ...`
  let branches: ProofBranchTrace[] | undefined;
  if (law.proof && law.proof.kind === 'Match' && law.proof.scrutinee.kind === 'Var') {
    const varName = law.proof.scrutinee.name;
    const varParam = law.vars.find((v) => v.name === varName);
    const varTyName = varParam?.ty.kind === 'Var' ? varParam.ty.name : undefined;
    const td = varTyName ? typeMap.get(varTyName) : undefined;

    branches = law.proof.arms.map((arm) => {
      let patTerm: Term | null = null;
      if (arm.pattern.kind === 'PatBool') {
        patTerm = { kind: 'Bool', value: arm.pattern.value };
      } else if (arm.pattern.kind === 'PatNat') {
        patTerm = { kind: 'Nat', value: arm.pattern.value };
      } else if (arm.pattern.kind === 'PatCtor') {
        const argTerms: Term[] = arm.pattern.args.map((a, idx) => ({
          kind: 'Var',
          name: a === '_' ? `_arg${idx}` : a,
        }));
        patTerm = buildCtorTerm(
          arm.pattern.typeName ?? td?.name,
          arm.pattern.ctor,
          argTerms
        );
      }

      const bLhs =
        patTerm && law.statement.kind === 'Eq'
          ? subst(law.statement.lhs, varName, patTerm)
          : law.statement.kind === 'Eq'
            ? law.statement.lhs
            : law.statement;
      const bRhs =
        patTerm && law.statement.kind === 'Eq'
          ? subst(law.statement.rhs, varName, patTerm)
          : law.statement.kind === 'Eq'
            ? law.statement.rhs
            : law.statement;

      const traced =
        arm.body.kind === 'Rewrite'
          ? traceRewriteChain(arm.body, bLhs, bRhs, defs, lawMap)
          : {
              lhsSteps: traceReduction(bLhs, defs),
              rhsSteps: traceReduction(bRhs, defs),
            };
      const bLhsFinal = traced.lhsSteps[traced.lhsSteps.length - 1].after;
      const bRhsFinal = traced.rhsSteps[traced.rhsSteps.length - 1].after;
      const bConv = bLhsFinal === bRhsFinal;
      return {
        patternLabel: formatPattern(arm.pattern),
        substitutionNote: patTerm ? `${varName} := ${formatTerm(patTerm)}` : 'wildcard',
        lhsSteps: traced.lhsSteps,
        rhsSteps: traced.rhsSteps,
        lhsFinal: bLhsFinal,
        rhsFinal: bRhsFinal,
        converged: bConv,
        passed: bConv,
        proofSummary: formatTerm(arm.body),
      };
    });
  }

  const converged =
    proofStrategy === 'case_split' && branches
      ? Boolean(verdict?.passed)
      : lhsFinal === rhsFinal;

  const ce = findCounterexample(law, defs, typeMap);
  if (ce) {
    const bindingList = Object.entries(ce.bindings)
      .map(([k, v]) => `${k} = ${v}`)
      .join(', ');
    const where = bindingList ? `at ${bindingList} ` : '';
    return {
      lawName: law.name,
      quantifiers,
      statement,
      lhsInitial: formatTerm(law.statement.lhs),
      rhsInitial: formatTerm(law.statement.rhs),
      lhsSteps,
      rhsSteps,
      lhsFinal,
      rhsFinal,
      converged: false,
      proofTerm: law.proof ? formatTerm(law.proof) : null,
      proofStrategy,
      proofSteps: law.proof ? traceReduction(law.proof, defs) : [],
      branches,
      status: 'false_counterexample',
      verdictSummary: `Diverged: concrete counterexample ${where}produces ${ce.lhsValue} != ${ce.rhsValue}.`,
      counterexampleTrace: buildCounterexampleTrace(law, ce, defs),
    };
  }

  if (!law.proof) {
    return {
      lawName: law.name,
      quantifiers,
      statement,
      lhsInitial: formatTerm(law.statement.lhs),
      rhsInitial: formatTerm(law.statement.rhs),
      lhsSteps,
      rhsSteps,
      lhsFinal,
      rhsFinal,
      converged,
      proofTerm: null,
      proofStrategy: 'missing',
      proofSteps: [],
      status: 'unproven_missing_proof',
      verdictSummary: converged
        ? `Both sides converged to '${lhsFinal}', but no 'proof ${law.name}: refl' block is present.`
        : `No proof block declared and '${lhsFinal}' != '${rhsFinal}'.`,
    };
  }

  if (verdict?.passed) {
    return {
      lawName: law.name,
      quantifiers,
      statement,
      lhsInitial: formatTerm(law.statement.lhs),
      rhsInitial: formatTerm(law.statement.rhs),
      lhsSteps,
      rhsSteps,
      lhsFinal,
      rhsFinal,
      converged: true,
      proofTerm: formatTerm(law.proof),
      proofStrategy,
      proofSteps: traceReduction(law.proof, defs),
      branches,
      status: 'proven',
      verdictSummary: verdict.reason,
    };
  }

  return {
    lawName: law.name,
    quantifiers,
    statement,
    lhsInitial: formatTerm(law.statement.lhs),
    rhsInitial: formatTerm(law.statement.rhs),
    lhsSteps,
    rhsSteps,
    lhsFinal,
    rhsFinal,
    converged: false,
    proofTerm: formatTerm(law.proof),
    proofStrategy,
    proofSteps: traceReduction(law.proof, defs),
    branches,
    status: 'unproven_mismatch',
    verdictSummary:
      verdict?.reason ?? `Reflexivity failed: '${lhsFinal}' does not equal '${rhsFinal}'.`,
  };
}

export function traceBookLaws(book: Book): ProofPathTrace[] {
  return book.laws.map((law) => traceLawProof(law, book));
}
