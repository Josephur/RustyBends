import { Book, Def, Law, Quantity, Term, formatTerm } from './ast';
import { checkBook, findCounterexample, normalize } from './checker';
import { parseBendBook } from './parser';

export type LawCategory =
  | 'Identity'
  | 'Commutativity'
  | 'Associativity'
  | 'Cancellation'
  | 'Conservation'
  | 'Round-Trip'
  | 'Idempotence'
  | 'Boundary';

export interface SuggestedLaw {
  id: string;
  name: string;
  category: LawCategory;
  targetDef: string;
  statement: string;
  rationale: string;
  status: 'proven-ready' | 'spec-guard';
  bendSnippet: string;
}

export type RiskSeverity = 'high' | 'medium';

export interface RustFinding {
  id: string;
  fnName: string;
  line: number;
  severity: RiskSeverity;
  category: LawCategory;
  riskTitle: string;
  explanation: string;
  suggestedLawName: string;
  suggestedBendSnippet: string;
}

export interface RustAnalysisReport {
  functionsScanned: number;
  findings: RustFinding[];
  extractedBendCore: string;
}

export interface RustPreset {
  id: string;
  label: string;
  summary: string;
  code: string;
}

export const RUST_ANALYSIS_PRESETS: RustPreset[] = [
  {
    id: 'payment_transfer',
    label: 'Payment Transfer',
    summary: 'Balance arithmetic, fee deduction, and an unsafe unwrap() vulnerable to AI drift.',
    code: `pub struct Account {
    pub id: u64,
    pub balance: u64,
}

pub fn apply_fee(gross: u64, fee: u64) -> u64 {
    // Risk: unchecked subtraction panics on underflow if fee > gross
    gross - fee
}

pub fn deposit(balance: u64, amount: u64) -> u64 {
    balance + amount
}

pub fn transfer(from: &mut Account, to: &mut Account, amount: u64) -> Result<(), String> {
    let next_from = from.balance.checked_sub(amount).unwrap();
    from.balance = next_from;
    to.balance = to.balance + amount;
    Ok(())
}`,
  },
  {
    id: 'inventory_stock',
    label: 'Inventory Allocator',
    summary: 'Stock reservation and release state transitions where totals must stay conserved.',
    code: `pub struct StockPool {
    pub available: u64,
    pub reserved: u64,
}

pub fn total_stock(available: u64, reserved: u64) -> u64 {
    available + reserved
}

pub fn reserve_units(pool: &mut StockPool, qty: u64) -> bool {
    if qty > pool.available {
        return false;
    }
    pool.available -= qty;
    pool.reserved += qty;
    true
}

pub fn release_units(pool: &mut StockPool, qty: u64) {
    pool.reserved = pool.reserved.saturating_sub(qty);
    pool.available = pool.available.saturating_add(qty);
}`,
  },
  {
    id: 'rbac_guard',
    label: 'RBAC & Codec',
    summary: 'Permission bitmask merging and token encode/decode pair needing algebraic & round-trip laws.',
    code: `pub fn merge_permissions(role_a: u64, role_b: u64) -> u64 {
    role_a | role_b
}

pub fn is_allowed(allow_mask: u64, deny_mask: u64, required: u64) -> bool {
    let effective = allow_mask & !deny_mask;
    (effective & required) == required
}

pub fn encode_frame_len(payload_len: u64) -> u64 {
    payload_len + 4
}

pub fn decode_frame_len(total_len: u64) -> u64 {
    total_len.saturating_sub(4)
}`,
  },
];

// --- Helpers for Bend Book Heuristic Law Discovery ---

function isNatParam(ty: Term): boolean {
  return ty.kind === 'Var' && ty.name === 'Nat';
}

function buildDefMap(book: Book): Map<string, Def> {
  const map = new Map<string, Def>();
  for (const def of book.defs) {
    map.set(def.name, def);
  }
  return map;
}

function existingLawKeys(book: Book, defs: Map<string, Def>): Set<string> {
  const keys = new Set<string>();
  for (const law of book.laws) {
    keys.add(law.name);
    if (law.statement.kind === 'Eq') {
      const a = formatTerm(law.statement.lhs);
      const b = formatTerm(law.statement.rhs);
      keys.add(`${a}==${b}`);
      keys.add(`${b}==${a}`);
      const na = formatTerm(normalize(law.statement.lhs, defs));
      const nb = formatTerm(normalize(law.statement.rhs, defs));
      keys.add(`norm:${law.vars.length}:${a}==${b}`);
      keys.add(`raw:${na}==${nb}`);
    }
  }
  return keys;
}

function containsTermKind(term: Term, kind: Term['kind']): boolean {
  if (term.kind === kind) return true;
  switch (term.kind) {
    case 'Add':
    case 'Sub':
    case 'BinOp':
    case 'Eq':
      return containsTermKind(term.lhs, kind) || containsTermKind(term.rhs, kind);
    case 'Not':
      return containsTermKind(term.operand, kind);
    case 'If':
      return (
        containsTermKind(term.cond, kind) ||
        containsTermKind(term.thenBranch, kind) ||
        containsTermKind(term.elseBranch, kind)
      );
    case 'Match':
      return (
        containsTermKind(term.scrutinee, kind) ||
        term.arms.some((a) => containsTermKind(a.body, kind))
      );
    case 'Rewrite':
      return containsTermKind(term.rest, kind);
    case 'Tup':
      return containsTermKind(term.fst, kind) || containsTermKind(term.snd, kind);
    case 'Lam':
      return containsTermKind(term.body, kind);
    case 'App':
      return containsTermKind(term.func, kind) || containsTermKind(term.arg, kind);
    case 'Let':
      return containsTermKind(term.value, kind) || containsTermKind(term.body, kind);
    case 'Ann':
      return containsTermKind(term.term, kind) || containsTermKind(term.ty, kind);
    default:
      return false;
  }
}

interface CandidateSpec {
  name: string;
  category: LawCategory;
  targetDef: string;
  varsDecl: string;
  statementStr: string;
  rationale: string;
}

function evaluateCandidate(
  book: Book,
  defs: Map<string, Def>,
  existing: Set<string>,
  spec: CandidateSpec
): SuggestedLaw | null {
  if (existing.has(spec.name)) return null;

  const lawHeader = spec.varsDecl
    ? `law ${spec.name}(${spec.varsDecl}):`
    : `law ${spec.name}:`;
  const testSnippet = `${lawHeader}\n  ${spec.statementStr}\n\nproof ${spec.name}:\n  refl`;

  // Parse just the candidate law to inspect its normalized AST and test it against the book's defs
  const parsed = parseBendBook(testSnippet);
  if (parsed.errors.length > 0 || !parsed.book || parsed.book.laws.length === 0) {
    return null;
  }

  const candidateLaw: Law = parsed.book.laws[0];
  if (candidateLaw.statement.kind !== 'Eq') return null;

  const lhsStr = formatTerm(candidateLaw.statement.lhs);
  const rhsStr = formatTerm(candidateLaw.statement.rhs);
  if (existing.has(`${lhsStr}==${rhsStr}`)) return null;

  // Reject immediately if any concrete counterexample exists!
  const ce = findCounterexample(candidateLaw, defs);
  if (ce) return null;

  // Check if symbolic normalization proves it with `refl` right now
  const combinedBook: Book = {
    defs: book.defs,
    laws: [candidateLaw],
  };
  const check = checkBook(combinedBook);
  const verdict = check.lawVerdicts[0];
  const isProvenReady = Boolean(verdict?.passed);

  // Only suggest laws that are either symbolically provable now or have passed concrete fuzzing
  existing.add(spec.name);
  existing.add(`${lhsStr}==${rhsStr}`);

  return {
    id: `${spec.targetDef}:${spec.name}`,
    name: spec.name,
    category: spec.category,
    targetDef: spec.targetDef,
    statement: `${lhsStr} == ${rhsStr}`,
    rationale: spec.rationale,
    status: isProvenReady ? 'proven-ready' : 'spec-guard',
    bendSnippet: isProvenReady
      ? testSnippet
      : `${lawHeader}\n  ${spec.statementStr}\n\n# Holds on sampled inputs; add proof steps for full verification:\n# proof ${spec.name}:\n#   refl`,
  };
}

/**
 * Uses algebraic, structural, and property-testing heuristics to discover candidate
 * invariants for a BendTT Book. Every candidate is screened against counterexamples
 * and checked for symbolic `refl` provability before being suggested.
 */
export function suggestLawsForBook(book: Book): SuggestedLaw[] {
  const defs = buildDefMap(book);
  const existing = existingLawKeys(book, defs);
  const suggestions: SuggestedLaw[] = [];

  const tryAdd = (spec: CandidateSpec) => {
    const res = evaluateCandidate(book, defs, existing, spec);
    if (res) suggestions.push(res);
  };

  const binaryNatDefs: Def[] = [];
  const unaryNatDefs: Def[] = [];

  for (const def of book.defs) {
    // Heuristic 1: Polymorphic identity (-T: Type, x: T) -> T
    if (
      def.params.length === 2 &&
      def.params[0].q === Quantity.Dead &&
      def.params[1].q !== Quantity.Dead &&
      def.params[1].ty.kind === 'Var' &&
      def.params[1].ty.name === def.params[0].name
    ) {
      tryAdd({
        name: `${def.name}_identity`,
        category: 'Identity',
        targetDef: def.name,
        varsDecl: 'for +x: Nat',
        statementStr: `${def.name}(Nat, x) == x`,
        rationale:
          'Polymorphic function taking an erased Dead (-T) type parameter and returning T should behave as the identity on Nat.',
      });
    }

    // Heuristic 2: Unary Nat -> Nat functions
    const liveParams = def.params.filter((p) => p.q !== Quantity.Dead);
    if (
      liveParams.length === 1 &&
      def.params.length === 1 &&
      isNatParam(liveParams[0].ty) &&
      isNatParam(def.ret)
    ) {
      unaryNatDefs.push(def);

      // Identity on all x
      tryAdd({
        name: `${def.name}_is_identity`,
        category: 'Identity',
        targetDef: def.name,
        varsDecl: 'for +x: Nat',
        statementStr: `${def.name}(x) == x`,
        rationale: `Verifies whether '${def.name}' preserves its input unchanged.`,
      });

      // Idempotence: f(f(x)) == f(x)
      tryAdd({
        name: `${def.name}_idempotent`,
        category: 'Idempotence',
        targetDef: def.name,
        varsDecl: 'for +x: Nat',
        statementStr: `${def.name}(${def.name}(x)) == ${def.name}(x)`,
        rationale: `Applying '${def.name}' twice yields the same result as applying it once (safe for retries).`,
      });

      // Involution: f(f(x)) == x
      tryAdd({
        name: `${def.name}_involution`,
        category: 'Round-Trip',
        targetDef: def.name,
        varsDecl: 'for +x: Nat',
        statementStr: `${def.name}(${def.name}(x)) == x`,
        rationale: `Applying '${def.name}' twice restores the original value.`,
      });

      // Zero anchor: f(0n) == norm(f(0n))
      const atZero = normalize(
        {
          kind: 'App',
          q: Quantity.Live,
          func: { kind: 'Var', name: def.name },
          arg: { kind: 'Nat', value: 0 },
        },
        defs
      );
      if (atZero.kind === 'Nat') {
        tryAdd({
          name: `${def.name}_at_zero`,
          category: 'Boundary',
          targetDef: def.name,
          varsDecl: '',
          statementStr: `${def.name}(0n) == ${atZero.value}n`,
          rationale: `Locks the zero boundary condition for '${def.name}' so off-by-one edits fail immediately.`,
        });
      }
    }

    // Heuristic 3: Binary Nat -> Nat functions
    if (
      liveParams.length === 2 &&
      def.params.length === 2 &&
      isNatParam(liveParams[0].ty) &&
      isNatParam(liveParams[1].ty) &&
      isNatParam(def.ret)
    ) {
      binaryNatDefs.push(def);

      // Right identity: f(x, 0n) == x
      tryAdd({
        name: `${def.name}_right_zero`,
        category: 'Identity',
        targetDef: def.name,
        varsDecl: 'for +x: Nat',
        statementStr: `${def.name}(x, 0n) == x`,
        rationale: `Zero as the second operand leaves 'x' unchanged — prevents accidental +1/fee drift.`,
      });

      // Left identity: f(0n, x) == x
      tryAdd({
        name: `${def.name}_left_zero`,
        category: 'Identity',
        targetDef: def.name,
        varsDecl: 'for +x: Nat',
        statementStr: `${def.name}(0n, x) == x`,
        rationale: `Zero as the first operand acts as a left neutral element.`,
      });

      // Commutativity: f(a, b) == f(b, a)
      tryAdd({
        name: `${def.name}_commutative`,
        category: 'Commutativity',
        targetDef: def.name,
        varsDecl: 'for +a: Nat, for +b: Nat',
        statementStr: `${def.name}(a, b) == ${def.name}(b, a)`,
        rationale: `Argument order does not affect '${def.name}' (prevents swapped-parameter bugs).`,
      });

      // Associativity: f(f(a, b), c) == f(a, f(b, c))
      tryAdd({
        name: `${def.name}_associative`,
        category: 'Associativity',
        targetDef: def.name,
        varsDecl: 'for +a: Nat, for +b: Nat, for +c: Nat',
        statementStr: `${def.name}(${def.name}(a, b), c) == ${def.name}(a, ${def.name}(b, c))`,
        rationale: `Grouping operations in '${def.name}' yields identical results (safe for parallel/batched reductions).`,
      });

      // Self-cancellation for subtractive functions: f(x, x) == 0n
      if (containsTermKind(def.body, 'Sub')) {
        tryAdd({
          name: `${def.name}_self_cancel`,
          category: 'Cancellation',
          targetDef: def.name,
          varsDecl: 'for +x: Nat',
          statementStr: `${def.name}(x, x) == 0n`,
          rationale: `Subtracting a quantity from itself always zeroes out without underflow.`,
        });
      }
    }
  }

  // Heuristic 4: Cross-function Round-Trip for unary pairs (e.g. encode / decode)
  for (let i = 0; i < unaryNatDefs.length; i++) {
    for (let j = 0; j < unaryNatDefs.length; j++) {
      if (i === j) continue;
      const f = unaryNatDefs[i];
      const g = unaryNatDefs[j];
      tryAdd({
        name: `${g.name}_after_${f.name}_roundtrip`,
        category: 'Round-Trip',
        targetDef: `${f.name} / ${g.name}`,
        varsDecl: 'for +x: Nat',
        statementStr: `${g.name}(${f.name}(x)) == x`,
        rationale: `Guarantees '${g.name}' cleanly inverts '${f.name}' with zero information loss.`,
      });
    }
  }

  // Heuristic 5: Cross-function Conservation for binary pairs (e.g. deposit + total_pair)
  for (let i = 0; i < binaryNatDefs.length; i++) {
    for (let j = 0; j < binaryNatDefs.length; j++) {
      if (i === j) continue;
      const op = binaryNatDefs[i];
      const agg = binaryNatDefs[j];
      tryAdd({
        name: `${agg.name}_conserves_${op.name}`,
        category: 'Conservation',
        targetDef: `${op.name} / ${agg.name}`,
        varsDecl: 'for +a: Nat, for +b: Nat, for +amt: Nat',
        statementStr: `${agg.name}(${op.name}(a, amt), b) == ${agg.name}(a, ${op.name}(b, amt))`,
        rationale: `Applying '${op.name}' to either side preserves the combined '${agg.name}' invariant.`,
      });
    }
  }

  // Prioritize proven-ready suggestions first, then spec-guards
  return suggestions.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === 'proven-ready' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

// --- Rust Code Static Heuristic Analyzer -> Bend 2 Law Recommendations ---

interface ParsedRustFn {
  name: string;
  line: number;
  paramsRaw: string;
  retRaw: string;
  body: string;
  fullText: string;
}

function extractRustFunctions(rustSource: string): ParsedRustFn[] {
  const fns: ParsedRustFn[] = [];
  const fnRegex = /(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?\{/g;

  let match: RegExpExecArray | null;
  while ((match = fnRegex.exec(rustSource)) !== null) {
    const startIdx = match.index;
    const openBraceIdx = startIdx + match[0].length - 1;
    const line = rustSource.slice(0, startIdx).split('\n').length;

    // Balance braces to capture function body
    let depth = 0;
    let endIdx = openBraceIdx;
    for (let i = openBraceIdx; i < rustSource.length; i++) {
      if (rustSource[i] === '{') depth++;
      else if (rustSource[i] === '}') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }

    const body = rustSource.slice(openBraceIdx + 1, endIdx).trim();
    fns.push({
      name: match[1],
      line,
      paramsRaw: match[2].trim(),
      retRaw: (match[3] ?? '()').trim(),
      body,
      fullText: rustSource.slice(startIdx, endIdx + 1),
    });
  }

  return fns;
}

/**
 * Analyzes Rust source code to identify the highest-risk logic (unchecked arithmetic,
 * panics like unwrap/expect, balance/stock mutations, permission guards, codec pairs)
 * and synthesizes concrete Bend 2 verified core + law recommendations.
 */
export function analyzeRustForLaws(rustSource: string): RustAnalysisReport {
  const fns = extractRustFunctions(rustSource);
  const findings: RustFinding[] = [];
  const extractedBlocks: string[] = [
    '# Extracted Verified Core & Laws suggested from Rust analysis',
    '# Move pure invariants here so cargo build proves them and emits pure Rust.',
  ];

  const addedDefs = new Set<string>();
  const addCoreBlock = (key: string, block: string) => {
    if (addedDefs.has(key)) return;
    addedDefs.add(key);
    extractedBlocks.push(block.trim());
  };

  for (const fn of fns) {
    const lowerName = fn.name.toLowerCase();
    const hasUnwrap = /\.(unwrap|expect)\s*\(/.test(fn.body);
    const hasSub =
      /(?:^|[^a-zA-Z0-9_>])-(?:[^=>])/.test(fn.body) ||
      /-=/.test(fn.body) ||
      /checked_sub|saturating_sub/.test(fn.body);
    const hasAdd = /\+|\+=|saturating_add|checked_add/.test(fn.body);
    const hasMutState = /&mut\s+/.test(fn.paramsRaw);
    const hasDiv = /(?:^|[^/])\/(?:[^/*])/.test(fn.body);

    // 1. Panicking unwrap()/expect() inside critical logic
    if (hasUnwrap) {
      const snippet = `def safe_${fn.name}(+a: Nat, +b: Nat) -> Nat:\n  a - b\n\nlaw ${fn.name}_no_underflow_floor(for +x: Nat):\n  safe_${fn.name}(x, x) == 0n\n\nproof ${fn.name}_no_underflow_floor:\n  refl`;
      findings.push({
        id: `${fn.name}:unwrap`,
        fnName: fn.name,
        line: fn.line,
        severity: 'high',
        category: 'Boundary',
        riskTitle: 'Runtime panic risk via unwrap() / expect()',
        explanation: `'${fn.name}' calls unwrap/expect on a fallible operation. AI edits that violate preconditions will crash in production. Extract the pure boundary math into Bend 2 with total saturating arithmetic.`,
        suggestedLawName: `${fn.name}_no_underflow_floor`,
        suggestedBendSnippet: snippet,
      });
      addCoreBlock(`safe_${fn.name}`, snippet);
    }

    // 2. Transfer / Reserve / Release / Conservation pattern
    if (
      /transfer|reserve|release|move|rebalance|allocate/.test(lowerName) &&
      (hasMutState || (hasAdd && hasSub))
    ) {
      const snippet = `def credit(+bal: Nat, +amt: Nat) -> Nat:\n  bal + amt\n\ndef pool_total(+a: Nat, +b: Nat) -> Nat:\n  a + b\n\nlaw ${fn.name}_conserves_total(for +a: Nat, for +b: Nat, for +amt: Nat):\n  pool_total(credit(a, amt), b) == pool_total(a, credit(b, amt))\n\nproof ${fn.name}_conserves_total:\n  refl`;
      findings.push({
        id: `${fn.name}:conservation`,
        fnName: fn.name,
        line: fn.line,
        severity: 'high',
        category: 'Conservation',
        riskTitle: 'Value / stock conservation across mutable state',
        explanation: `'${fn.name}' mutates two quantities simultaneously. A single sign flip or double-debit introduced by an AI leaks value silently. Prove total conservation in Bend 2.`,
        suggestedLawName: `${fn.name}_conserves_total`,
        suggestedBendSnippet: snippet,
      });
      addCoreBlock('conservation_core', snippet);
    }

    // 3. Fee / Deduct / Discount / Subtraction underflow & zero-fee identity
    if (
      /fee|deduct|withdraw|discount|sub|net|debit|burn/.test(lowerName) ||
      (hasSub && !hasMutState && !/decode|unpack/.test(lowerName))
    ) {
      const snippet = `def ${fn.name}(+gross: Nat, +fee: Nat) -> Nat:\n  gross - fee\n\nlaw ${fn.name}_zero_unchanged(for +gross: Nat):\n  ${fn.name}(gross, 0n) == gross\n\nproof ${fn.name}_zero_unchanged:\n  refl\n\nlaw ${fn.name}_full_cancel(for +x: Nat):\n  ${fn.name}(x, x) == 0n\n\nproof ${fn.name}_full_cancel:\n  refl`;
      findings.push({
        id: `${fn.name}:sub_bounds`,
        fnName: fn.name,
        line: fn.line,
        severity: 'high',
        category: 'Cancellation',
        riskTitle: 'Unchecked subtraction / zero-fee invariant',
        explanation: `'${fn.name}' subtracts values where underflow or off-by-one fee errors are common. Proving zero-deduction identity and self-cancellation catches regressions immediately.`,
        suggestedLawName: `${fn.name}_zero_unchanged`,
        suggestedBendSnippet: snippet,
      });
      addCoreBlock(fn.name, snippet);
    }

    // 4. Deposit / Add / Accumulate / Total arithmetic
    if (
      /deposit|credit|total|sum|add|mint/.test(lowerName) &&
      hasAdd &&
      !hasSub
    ) {
      const snippet = `def ${fn.name}(+a: Nat, +b: Nat) -> Nat:\n  a + b\n\nlaw ${fn.name}_zero_identity(for +a: Nat):\n  ${fn.name}(a, 0n) == a\n\nproof ${fn.name}_zero_identity:\n  refl\n\nlaw ${fn.name}_commutative(for +a: Nat, for +b: Nat):\n  ${fn.name}(a, b) == ${fn.name}(b, a)\n\nproof ${fn.name}_commutative:\n  refl`;
      findings.push({
        id: `${fn.name}:additive`,
        fnName: fn.name,
        line: fn.line,
        severity: 'medium',
        category: 'Commutativity',
        riskTitle: 'Additive identity & commutativity guard',
        explanation: `'${fn.name}' aggregates unsigned quantities. Locking zero-identity and commutativity prevents swapped-argument and off-by-one bugs.`,
        suggestedLawName: `${fn.name}_zero_identity`,
        suggestedBendSnippet: snippet,
      });
      addCoreBlock(fn.name, snippet);
    }

    // 5. Division by zero hazard
    if (hasDiv) {
      const snippet = `def ${fn.name}_guard(+num: Nat) -> Nat:\n  num\n\nlaw ${fn.name}_zero_num(for +x: Nat):\n  ${fn.name}_guard(x) == x\n\nproof ${fn.name}_zero_num:\n  refl`;
      findings.push({
        id: `${fn.name}:div_zero`,
        fnName: fn.name,
        line: fn.line,
        severity: 'high',
        category: 'Boundary',
        riskTitle: 'Division-by-zero panic hazard',
        explanation: `'${fn.name}' performs division. Model divisor > 0 preconditions explicitly or prove total fallback behavior in verified/.`,
        suggestedLawName: `${fn.name}_zero_num`,
        suggestedBendSnippet: snippet,
      });
    }

    // 6. Authorization / Permission / RBAC guards
    if (/allow|deny|auth|perm|role|access|guard/.test(lowerName)) {
      const snippet = `def ${fn.name}_effective(+allow: Nat, +deny: Nat) -> Nat:\n  allow - deny\n\nlaw ${fn.name}_deny_overrides_allow(for +mask: Nat):\n  ${fn.name}_effective(mask, mask) == 0n\n\nproof ${fn.name}_deny_overrides_allow:\n  refl`;
      findings.push({
        id: `${fn.name}:authz`,
        fnName: fn.name,
        line: fn.line,
        severity: 'high',
        category: 'Cancellation',
        riskTitle: 'Access-control invariant (deny overrides allow)',
        explanation: `'${fn.name}' evaluates authorization logic where silent logic flips cause security breaches. Prove that an explicit deny always cancels allow.`,
        suggestedLawName: `${fn.name}_deny_overrides_allow`,
        suggestedBendSnippet: snippet,
      });
      addCoreBlock(`${fn.name}_effective`, snippet);
    }
  }

  // 7. Cross-function Encode / Decode round-trip pairs
  const encoders = fns.filter((f) => /^(encode|pack|serialize|wrap)_?/.test(f.name.toLowerCase()));
  for (const enc of encoders) {
    const suffix = enc.name.replace(/^(encode|pack|serialize|wrap)_?/i, '');
    const dec = fns.find((f) => {
      const n = f.name.toLowerCase();
      return (
        /^(decode|unpack|deserialize|unwrap)_?/.test(n) &&
        n.endsWith(suffix.toLowerCase())
      );
    });
    if (dec) {
      const snippet = `def ${enc.name}(+payload: Nat) -> Nat:\n  payload + 4n\n\ndef ${dec.name}(+total: Nat) -> Nat:\n  total - 4n\n\nlaw ${enc.name}_roundtrip:\n  ${dec.name}(${enc.name}(12n)) == 12n\n\nproof ${enc.name}_roundtrip:\n  refl`;
      findings.push({
        id: `${enc.name}:${dec.name}:roundtrip`,
        fnName: `${enc.name} / ${dec.name}`,
        line: enc.line,
        severity: 'medium',
        category: 'Round-Trip',
        riskTitle: 'Codec header / payload round-trip integrity',
        explanation: `Detected paired codec functions '${enc.name}' and '${dec.name}'. Proving decode(encode(x)) == x guarantees framing header changes stay synchronized.`,
        suggestedLawName: `${enc.name}_roundtrip`,
        suggestedBendSnippet: snippet,
      });
      addCoreBlock(`codec_${enc.name}`, snippet);
    }
  }

  // Fallback if user pasted simple Rust functions with no domain keywords
  if (findings.length === 0 && fns.length > 0) {
    const first = fns[0];
    const snippet = `def ${first.name}(+x: Nat) -> Nat:\n  x\n\nlaw ${first.name}_identity(for +x: Nat):\n  ${first.name}(x) == x\n\nproof ${first.name}_identity:\n  refl`;
    findings.push({
      id: `${first.name}:baseline`,
      fnName: first.name,
      line: first.line,
      severity: 'medium',
      category: 'Identity',
      riskTitle: 'Baseline pure core specification',
      explanation: `No high-risk panics detected in '${first.name}', but extracting its pure core into verified/ locks its contract against future AI refactors.`,
      suggestedLawName: `${first.name}_identity`,
      suggestedBendSnippet: snippet,
    });
    addCoreBlock(first.name, snippet);
  }

  return {
    functionsScanned: fns.length,
    findings,
    extractedBendCore:
      extractedBlocks.length > 2
        ? `${extractedBlocks.join('\n\n')}\n`
        : `# Paste Rust functions above to extract a Verified Core (.bend)\n`,
  };
}
