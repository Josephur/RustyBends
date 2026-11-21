import {
  Book,
  Def,
  Law,
  Pattern,
  Quantity,
  Term,
  TypeDef,
  canonicalLawSignature,
  formatPattern,
  formatTerm,
  isErased,
} from './ast';

export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  scope: string;
  message: string;
  fixHint?: string;
  line?: number;
}

export interface Counterexample {
  bindings: Record<string, string>;
  lhsValue: string;
  rhsValue: string;
}

export interface LawVerdict {
  name: string;
  passed: boolean;
  statement: string;
  normalizedLhs: string;
  normalizedRhs: string;
  reason: string;
  proofKind?: 'refl' | 'case_split' | 'rewrite' | 'missing';
  counterexample?: Counterexample;
}

export interface LawLockSnapshot {
  fingerprint: string;
  laws: Record<string, string>;
  lockedAt: string;
}

export interface LawLockCheck {
  locked: boolean;
  valid: boolean;
  currentFingerprint: string;
  expectedFingerprint?: string;
  missingLaws: string[];
  modifiedLaws: string[];
}

export interface ErasureReport {
  erasedBook: Book;
  deadParamsErased: number;
  deadLambdasErased: number;
  deadAppsErased: number;
  annotationsErased: number;
  lawsErased: number;
  remainingDeadNodes: number;
}

export interface CheckReport {
  buildPassed: boolean;
  diagnostics: Diagnostic[];
  lawVerdicts: LawVerdict[];
  erasure: ErasureReport;
  lockCheck: LawLockCheck;
  defStats: Array<{
    name: string;
    deadParams: number;
    liveParams: number;
    dataParams: number;
    erasedOk: boolean;
  }>;
}

interface EnvEntry {
  q: Quantity;
  uses: number;
  line?: number;
}

type Env = Map<string, EnvEntry>;

function cloneEnv(env: Env): Env {
  const next = new Map<string, EnvEntry>();
  for (const [k, v] of env.entries()) {
    next.set(k, { ...v });
  }
  return next;
}

/** Deterministic FNV-1a 64-bit-like hex hash for LAWS.bend anti-cheat locking. */
function stableHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hi = (h2 >>> 0).toString(16).padStart(8, '0');
  const lo = (h1 >>> 0).toString(16).padStart(8, '0');
  return `bend-lock:${hi}${lo}`;
}

export function createLawLock(book: Book): LawLockSnapshot {
  const laws: Record<string, string> = {};
  const sorted = [...book.laws].sort((a, b) => a.name.localeCompare(b.name));
  for (const law of sorted) {
    laws[law.name] = canonicalLawSignature(law);
  }
  const serialized = Object.entries(laws)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  return {
    fingerprint: stableHash(serialized),
    laws,
    lockedAt: new Date().toISOString(),
  };
}

export function verifyLawLock(
  book: Book,
  lock: LawLockSnapshot | null
): LawLockCheck {
  const current = createLawLock(book);
  if (!lock) {
    return {
      locked: false,
      valid: true,
      currentFingerprint: current.fingerprint,
      missingLaws: [],
      modifiedLaws: [],
    };
  }

  const missingLaws: string[] = [];
  const modifiedLaws: string[] = [];

  for (const [name, expectedSig] of Object.entries(lock.laws)) {
    const actualSig = current.laws[name];
    if (!actualSig) {
      missingLaws.push(name);
    } else if (actualSig !== expectedSig) {
      modifiedLaws.push(name);
    }
  }

  return {
    locked: true,
    valid: missingLaws.length === 0 && modifiedLaws.length === 0,
    currentFingerprint: current.fingerprint,
    expectedFingerprint: lock.fingerprint,
    missingLaws,
    modifiedLaws,
  };
}

function buildKnownSymbols(book: Book): {
  typeMap: Map<string, TypeDef>;
  knownGlobals: Set<string>;
} {
  const typeMap = new Map<string, TypeDef>();
  const knownGlobals = new Set<string>(['Nat', 'Bool', 'Equal']);
  for (const def of book.defs) {
    knownGlobals.add(def.name);
  }
  for (const td of book.types ?? []) {
    typeMap.set(td.name, td);
    knownGlobals.add(td.name);
    for (const v of td.variants) {
      knownGlobals.add(v.name);
      knownGlobals.add(`${td.name}.${v.name}`);
    }
  }
  return { typeMap, knownGlobals };
}

/**
 * Checks whether a term violates the Data (q=2) restriction:
 * "duplicable data. No lambdas or calls inside."
 */
function checkDataPurity(
  term: Term,
  scope: string,
  ctorNames: Set<string>,
  diagnostics: Diagnostic[]
): void {
  switch (term.kind) {
    case 'Lam':
      diagnostics.push({
        code: 'E_DATA_LAM',
        severity: 'error',
        scope,
        message: `Data (q=2) position cannot contain lambda '@${term.q} ${term.param} => ...'`,
        fixHint:
          'Move closures to a Live (q=1) parameter or return pure Nat/Bool/ADT data instead.',
        line: term.span?.line,
      });
      return;
    case 'App': {
      const { head } = unwindAppChain(term);
      const isCtorApp = head.kind === 'Var' && ctorNames.has(head.name);
      if (term.q !== Quantity.Data && !isCtorApp) {
        diagnostics.push({
          code: 'E_DATA_CALL',
          severity: 'error',
          scope,
          message: `Data (q=2) position cannot contain ${term.q} call '${formatTerm(term)}'`,
          fixHint:
            'Only Data-safe expressions (Nat/Bool literals, ADT constructors, arithmetic, tuples, or [2] calls) may appear inside a Data (q=2) argument.',
          line: term.span?.line,
        });
      }
      checkDataPurity(term.func, scope, ctorNames, diagnostics);
      checkDataPurity(term.arg, scope, ctorNames, diagnostics);
      return;
    }
    case 'Tup':
      checkDataPurity(term.fst, scope, ctorNames, diagnostics);
      checkDataPurity(term.snd, scope, ctorNames, diagnostics);
      return;
    case 'Add':
    case 'Sub':
    case 'BinOp':
      checkDataPurity(term.lhs, scope, ctorNames, diagnostics);
      checkDataPurity(term.rhs, scope, ctorNames, diagnostics);
      return;
    case 'Not':
      checkDataPurity(term.operand, scope, ctorNames, diagnostics);
      return;
    case 'If':
      checkDataPurity(term.cond, scope, ctorNames, diagnostics);
      checkDataPurity(term.thenBranch, scope, ctorNames, diagnostics);
      checkDataPurity(term.elseBranch, scope, ctorNames, diagnostics);
      return;
    case 'Match':
      checkDataPurity(term.scrutinee, scope, ctorNames, diagnostics);
      for (const arm of term.arms) {
        checkDataPurity(arm.body, scope, ctorNames, diagnostics);
      }
      return;
    case 'Let':
      checkDataPurity(term.value, scope, ctorNames, diagnostics);
      checkDataPurity(term.body, scope, ctorNames, diagnostics);
      return;
    case 'Ann':
      checkDataPurity(term.term, scope, ctorNames, diagnostics);
      return;
    default:
      return;
  }
}

function checkTermUsage(
  term: Term,
  ctxQ: Quantity,
  env: Env,
  knownGlobals: Set<string>,
  ctorNames: Set<string>,
  scope: string,
  diagnostics: Diagnostic[]
): void {
  switch (term.kind) {
    case 'Var': {
      const entry = env.get(term.name);
      if (!entry) {
        if (!knownGlobals.has(term.name)) {
          diagnostics.push({
            code: 'E_UNBOUND',
            severity: 'error',
            scope,
            message: `Unbound variable '${term.name}'`,
            fixHint: `Declare '${term.name}' as a parameter, type constructor, or 'def ${term.name}(...)'.`,
            line: term.span?.line,
          });
        }
        return;
      }

      if (ctxQ !== Quantity.Dead) {
        if (entry.q === Quantity.Dead) {
          diagnostics.push({
            code: 'E_DEAD_LEAK',
            severity: 'error',
            scope,
            message: `Dead (q=0) binding '${term.name}' cannot be used in a ${ctxQ} runtime position`,
            fixHint: `Remove '${term.name}' from the runtime body (use it only in types/annotations), or drop the '-' prefix so it is Live (q=1) or '+${term.name}' Data (q=2).`,
            line: term.span?.line,
          });
          return;
        }
        entry.uses += 1;
        if (entry.q === Quantity.Live && entry.uses > 1) {
          diagnostics.push({
            code: 'E_AFFINE_DUP',
            severity: 'error',
            scope,
            message: `Affine Live (q=1) variable '${term.name}' used ${entry.uses} times (at most once allowed)`,
            fixHint: `Change parameter '${term.name}' to '+${term.name}' (Data q=2) if duplication is safe and intended.`,
            line: term.span?.line,
          });
        }
      }
      return;
    }

    case 'Nat':
    case 'Bool':
    case 'Refl':
    case 'Univ':
      return;

    case 'Not':
      checkTermUsage(term.operand, ctxQ, env, knownGlobals, ctorNames, scope, diagnostics);
      return;

    case 'Add':
    case 'Sub':
    case 'BinOp':
      checkTermUsage(term.lhs, ctxQ, env, knownGlobals, ctorNames, scope, diagnostics);
      checkTermUsage(term.rhs, ctxQ, env, knownGlobals, ctorNames, scope, diagnostics);
      return;

    case 'Eq':
      checkTermUsage(term.lhs, Quantity.Dead, env, knownGlobals, ctorNames, scope, diagnostics);
      checkTermUsage(term.rhs, Quantity.Dead, env, knownGlobals, ctorNames, scope, diagnostics);
      return;

    case 'Rewrite':
      checkTermUsage(term.rest, Quantity.Dead, env, knownGlobals, ctorNames, scope, diagnostics);
      return;

    case 'If': {
      checkTermUsage(term.cond, ctxQ, env, knownGlobals, ctorNames, scope, diagnostics);
      const thenEnv = cloneEnv(env);
      const elseEnv = cloneEnv(env);
      checkTermUsage(term.thenBranch, ctxQ, thenEnv, knownGlobals, ctorNames, scope, diagnostics);
      checkTermUsage(term.elseBranch, ctxQ, elseEnv, knownGlobals, ctorNames, scope, diagnostics);
      for (const [k, outer] of env.entries()) {
        const tUses = thenEnv.get(k)?.uses ?? outer.uses;
        const eUses = elseEnv.get(k)?.uses ?? outer.uses;
        outer.uses = Math.max(tUses, eUses);
      }
      return;
    }

    case 'Match': {
      checkTermUsage(term.scrutinee, ctxQ, env, knownGlobals, ctorNames, scope, diagnostics);
      const branchEnvs: Env[] = [];
      for (const arm of term.arms) {
        const armEnv = cloneEnv(env);
        if (arm.pattern.kind === 'PatCtor') {
          for (const argName of arm.pattern.args) {
            if (argName !== '_') {
              armEnv.set(argName, { q: Quantity.Data, uses: 0, line: arm.span?.line });
            }
          }
        }
        checkTermUsage(arm.body, ctxQ, armEnv, knownGlobals, ctorNames, scope, diagnostics);
        branchEnvs.push(armEnv);
      }
      for (const [k, outer] of env.entries()) {
        let maxUses = outer.uses;
        for (const bEnv of branchEnvs) {
          const u = bEnv.get(k)?.uses ?? outer.uses;
          if (u > maxUses) maxUses = u;
        }
        outer.uses = maxUses;
      }
      return;
    }

    case 'Tup':
      checkTermUsage(term.fst, ctxQ, env, knownGlobals, ctorNames, scope, diagnostics);
      checkTermUsage(term.snd, ctxQ, env, knownGlobals, ctorNames, scope, diagnostics);
      return;

    case 'Ann':
      checkTermUsage(term.term, ctxQ, env, knownGlobals, ctorNames, scope, diagnostics);
      checkTermUsage(term.ty, Quantity.Dead, env, knownGlobals, ctorNames, scope, diagnostics);
      return;

    case 'Lam': {
      const innerEnv = cloneEnv(env);
      innerEnv.set(term.param, { q: term.q, uses: 0, line: term.span?.line });
      checkTermUsage(term.body, ctxQ, innerEnv, knownGlobals, ctorNames, scope, diagnostics);
      for (const [k, innerEntry] of innerEnv.entries()) {
        if (k === term.param) continue;
        const outer = env.get(k);
        if (outer) {
          outer.uses = innerEntry.uses;
        }
      }
      return;
    }

    case 'Let': {
      const valueQ = ctxQ === Quantity.Dead ? Quantity.Dead : Quantity.Live;
      checkTermUsage(term.value, valueQ, env, knownGlobals, ctorNames, scope, diagnostics);
      const innerEnv = cloneEnv(env);
      const inferredQ =
        term.value.kind === 'Nat' ||
        term.value.kind === 'Bool' ||
        term.value.kind === 'Add' ||
        term.value.kind === 'Sub' ||
        term.value.kind === 'BinOp' ||
        term.value.kind === 'Not'
          ? Quantity.Data
          : Quantity.Live;
      innerEnv.set(term.name, { q: inferredQ, uses: 0, line: term.span?.line });
      checkTermUsage(term.body, ctxQ, innerEnv, knownGlobals, ctorNames, scope, diagnostics);
      for (const [k, innerEntry] of innerEnv.entries()) {
        if (k === term.name) continue;
        const outer = env.get(k);
        if (outer) {
          outer.uses = innerEntry.uses;
        }
      }
      return;
    }

    case 'App': {
      checkTermUsage(term.func, ctxQ, env, knownGlobals, ctorNames, scope, diagnostics);
      const argQ =
        ctxQ === Quantity.Dead
          ? Quantity.Dead
          : term.q === Quantity.Dead
            ? Quantity.Dead
            : term.q;
      if (argQ === Quantity.Data) {
        checkDataPurity(term.arg, scope, ctorNames, diagnostics);
      }
      checkTermUsage(term.arg, argQ, env, knownGlobals, ctorNames, scope, diagnostics);
      return;
    }
  }
}

/** Erases all q=0 (Dead) parts, type annotations, and proof laws from a Book. */
export function eraseBook(book: Book): ErasureReport {
  let deadParamsErased = 0;
  let deadLambdasErased = 0;
  let deadAppsErased = 0;
  let annotationsErased = 0;

  const eraseTerm = (term: Term): Term => {
    switch (term.kind) {
      case 'Var':
      case 'Nat':
      case 'Bool':
      case 'Refl':
      case 'Univ':
        return term;
      case 'Not':
        return { kind: 'Not', operand: eraseTerm(term.operand) };
      case 'BinOp':
        return {
          kind: 'BinOp',
          op: term.op,
          lhs: eraseTerm(term.lhs),
          rhs: eraseTerm(term.rhs),
        };
      case 'Add':
        return { kind: 'Add', lhs: eraseTerm(term.lhs), rhs: eraseTerm(term.rhs) };
      case 'Sub':
        return { kind: 'Sub', lhs: eraseTerm(term.lhs), rhs: eraseTerm(term.rhs) };
      case 'Eq':
        return { kind: 'Eq', lhs: eraseTerm(term.lhs), rhs: eraseTerm(term.rhs) };
      case 'If':
        return {
          kind: 'If',
          cond: eraseTerm(term.cond),
          thenBranch: eraseTerm(term.thenBranch),
          elseBranch: eraseTerm(term.elseBranch),
        };
      case 'Match':
        return {
          kind: 'Match',
          scrutinee: eraseTerm(term.scrutinee),
          arms: term.arms.map((arm) => ({
            pattern: arm.pattern,
            body: eraseTerm(arm.body),
          })),
        };
      case 'Rewrite':
        return eraseTerm(term.rest);
      case 'Tup':
        return { kind: 'Tup', fst: eraseTerm(term.fst), snd: eraseTerm(term.snd) };
      case 'Let':
        return {
          kind: 'Let',
          name: term.name,
          value: eraseTerm(term.value),
          body: eraseTerm(term.body),
        };
      case 'Ann':
        annotationsErased += 1;
        return eraseTerm(term.term);
      case 'Lam':
        if (isErased(term.q)) {
          deadLambdasErased += 1;
          return eraseTerm(term.body);
        }
        return {
          kind: 'Lam',
          q: term.q,
          param: term.param,
          body: eraseTerm(term.body),
        };
      case 'App':
        if (isErased(term.q)) {
          deadAppsErased += 1;
          return eraseTerm(term.func);
        }
        return {
          kind: 'App',
          q: term.q,
          func: eraseTerm(term.func),
          arg: eraseTerm(term.arg),
        };
    }
  };

  const erasedDefs: Def[] = book.defs.map((def) => {
    const liveParams = def.params.filter((p) => {
      if (isErased(p.q)) {
        deadParamsErased += 1;
        return false;
      }
      return true;
    });
    return {
      name: def.name,
      params: liveParams,
      ret: def.ret,
      body: eraseTerm(def.body),
    };
  });

  const erasedBook: Book = {
    types: book.types ?? [],
    defs: erasedDefs,
    laws: [],
  };

  const remainingDeadNodes = countDeadNodes(erasedBook);

  return {
    erasedBook,
    deadParamsErased,
    deadLambdasErased,
    deadAppsErased,
    annotationsErased,
    lawsErased: book.laws.length,
    remainingDeadNodes,
  };
}

function countDeadNodesInTerm(term: Term): number {
  switch (term.kind) {
    case 'Var':
    case 'Nat':
    case 'Bool':
    case 'Refl':
      return 0;
    case 'Univ':
      return isErased(term.q) ? 1 : 0;
    case 'Not':
      return countDeadNodesInTerm(term.operand);
    case 'Add':
    case 'Sub':
    case 'BinOp':
    case 'Eq':
      return countDeadNodesInTerm(term.lhs) + countDeadNodesInTerm(term.rhs);
    case 'If':
      return (
        countDeadNodesInTerm(term.cond) +
        countDeadNodesInTerm(term.thenBranch) +
        countDeadNodesInTerm(term.elseBranch)
      );
    case 'Match':
      return (
        countDeadNodesInTerm(term.scrutinee) +
        term.arms.reduce((acc, a) => acc + countDeadNodesInTerm(a.body), 0)
      );
    case 'Rewrite':
      return 1 + countDeadNodesInTerm(term.rest);
    case 'Tup':
      return countDeadNodesInTerm(term.fst) + countDeadNodesInTerm(term.snd);
    case 'Let':
      return countDeadNodesInTerm(term.value) + countDeadNodesInTerm(term.body);
    case 'Ann':
      return 1 + countDeadNodesInTerm(term.term) + countDeadNodesInTerm(term.ty);
    case 'Lam':
      return (isErased(term.q) ? 1 : 0) + countDeadNodesInTerm(term.body);
    case 'App':
      return (
        (isErased(term.q) ? 1 : 0) +
        countDeadNodesInTerm(term.func) +
        countDeadNodesInTerm(term.arg)
      );
  }
}

export function countDeadNodes(book: Book): number {
  let count = book.laws.length;
  for (const def of book.defs) {
    for (const p of def.params) {
      if (isErased(p.q)) count += 1;
    }
    count += countDeadNodesInTerm(def.body);
  }
  return count;
}

// --- Normalization, Pattern Matching, Lemma Rewriting & Counterexample Search ---

export function unwindAppChain(term: Term): { head: Term; args: Term[] } {
  const args: Term[] = [];
  let cur = term;
  while (cur.kind === 'App') {
    args.push(cur.arg);
    cur = cur.func;
  }
  args.reverse();
  return { head: cur, args };
}

function buildCtorTerm(typeName: string | undefined, ctor: string, args: Term[]): Term {
  let acc: Term = { kind: 'Var', name: typeName ? `${typeName}.${ctor}` : ctor };
  for (const arg of args) {
    acc = { kind: 'App', q: Quantity.Live, func: acc, arg };
  }
  return acc;
}

export function matchPattern(
  pattern: Pattern,
  value: Term
): Map<string, Term> | null {
  switch (pattern.kind) {
    case 'PatWild':
      return new Map();
    case 'PatBool':
      return value.kind === 'Bool' && value.value === pattern.value
        ? new Map()
        : null;
    case 'PatNat':
      return value.kind === 'Nat' && value.value === pattern.value
        ? new Map()
        : null;
    case 'PatCtor': {
      const { head, args } = unwindAppChain(value);
      if (head.kind !== 'Var') return null;
      const dotIdx = head.name.lastIndexOf('.');
      const valType = dotIdx > 0 ? head.name.slice(0, dotIdx) : undefined;
      const valCtor = dotIdx > 0 ? head.name.slice(dotIdx + 1) : head.name;
      if (valCtor !== pattern.ctor) return null;
      if (pattern.typeName && valType && pattern.typeName !== valType) return null;
      if (args.length !== pattern.args.length) return null;
      const bindings = new Map<string, Term>();
      for (let i = 0; i < pattern.args.length; i++) {
        const bName = pattern.args[i];
        if (bName !== '_') {
          bindings.set(bName, args[i]);
        }
      }
      return bindings;
    }
  }
}

function freeVars(term: Term, out: Set<string> = new Set()): Set<string> {
  switch (term.kind) {
    case 'Var':
      out.add(term.name);
      return out;
    case 'Nat':
    case 'Bool':
    case 'Refl':
    case 'Univ':
      return out;
    case 'Not':
      freeVars(term.operand, out);
      return out;
    case 'Add':
    case 'Sub':
    case 'BinOp':
    case 'Eq':
      freeVars(term.lhs, out);
      freeVars(term.rhs, out);
      return out;
    case 'If':
      freeVars(term.cond, out);
      freeVars(term.thenBranch, out);
      freeVars(term.elseBranch, out);
      return out;
    case 'Match': {
      freeVars(term.scrutinee, out);
      for (const arm of term.arms) {
        const inner = freeVars(arm.body);
        if (arm.pattern.kind === 'PatCtor') {
          for (const a of arm.pattern.args) inner.delete(a);
        }
        for (const v of inner) out.add(v);
      }
      return out;
    }
    case 'Rewrite':
      freeVars(term.rest, out);
      return out;
    case 'Tup':
      freeVars(term.fst, out);
      freeVars(term.snd, out);
      return out;
    case 'Ann':
      freeVars(term.term, out);
      freeVars(term.ty, out);
      return out;
    case 'App':
      freeVars(term.func, out);
      freeVars(term.arg, out);
      return out;
    case 'Lam': {
      const inner = freeVars(term.body);
      inner.delete(term.param);
      for (const v of inner) out.add(v);
      return out;
    }
    case 'Let': {
      freeVars(term.value, out);
      const inner = freeVars(term.body);
      inner.delete(term.name);
      for (const v of inner) out.add(v);
      return out;
    }
  }
}

let freshCounter = 0;

function freshName(base: string, avoid: Set<string>): string {
  let candidate = `${base}_${++freshCounter}`;
  while (avoid.has(candidate)) {
    candidate = `${base}_${++freshCounter}`;
  }
  return candidate;
}

export function subst(term: Term, name: string, replacement: Term): Term {
  switch (term.kind) {
    case 'Var':
      return term.name === name ? replacement : term;
    case 'Nat':
    case 'Bool':
    case 'Refl':
    case 'Univ':
      return term;
    case 'Not':
      return { kind: 'Not', operand: subst(term.operand, name, replacement) };
    case 'BinOp':
      return {
        kind: 'BinOp',
        op: term.op,
        lhs: subst(term.lhs, name, replacement),
        rhs: subst(term.rhs, name, replacement),
      };
    case 'Add':
      return {
        kind: 'Add',
        lhs: subst(term.lhs, name, replacement),
        rhs: subst(term.rhs, name, replacement),
      };
    case 'Sub':
      return {
        kind: 'Sub',
        lhs: subst(term.lhs, name, replacement),
        rhs: subst(term.rhs, name, replacement),
      };
    case 'Eq':
      return {
        kind: 'Eq',
        lhs: subst(term.lhs, name, replacement),
        rhs: subst(term.rhs, name, replacement),
      };
    case 'If':
      return {
        kind: 'If',
        cond: subst(term.cond, name, replacement),
        thenBranch: subst(term.thenBranch, name, replacement),
        elseBranch: subst(term.elseBranch, name, replacement),
      };
    case 'Match': {
      const nextScrut = subst(term.scrutinee, name, replacement);
      const repFree = freeVars(replacement);
      const nextArms = term.arms.map((arm) => {
        if (arm.pattern.kind === 'PatCtor') {
          if (arm.pattern.args.includes(name)) {
            return arm;
          }
          let body = arm.body;
          const nextArgs = [...arm.pattern.args];
          for (let i = 0; i < nextArgs.length; i++) {
            const pVar = nextArgs[i];
            if (pVar !== '_' && repFree.has(pVar)) {
              const avoid = new Set<string>([...repFree, ...freeVars(body), name]);
              const renamed = freshName(pVar, avoid);
              body = subst(body, pVar, { kind: 'Var', name: renamed });
              nextArgs[i] = renamed;
            }
          }
          return {
            pattern: { ...arm.pattern, args: nextArgs },
            body: subst(body, name, replacement),
          };
        }
        return {
          pattern: arm.pattern,
          body: subst(arm.body, name, replacement),
        };
      });
      return { kind: 'Match', scrutinee: nextScrut, arms: nextArms };
    }
    case 'Rewrite':
      return {
        ...term,
        rest: subst(term.rest, name, replacement),
      };
    case 'Tup':
      return {
        kind: 'Tup',
        fst: subst(term.fst, name, replacement),
        snd: subst(term.snd, name, replacement),
      };
    case 'Ann':
      return {
        kind: 'Ann',
        term: subst(term.term, name, replacement),
        ty: subst(term.ty, name, replacement),
      };
    case 'Lam': {
      if (term.param === name) return term;
      const repFree = freeVars(replacement);
      if (repFree.has(term.param)) {
        const avoid = new Set<string>([...repFree, ...freeVars(term.body), name]);
        const renamed = freshName(term.param, avoid);
        const renamedBody = subst(term.body, term.param, { kind: 'Var', name: renamed });
        return {
          kind: 'Lam',
          q: term.q,
          param: renamed,
          body: subst(renamedBody, name, replacement),
        };
      }
      return {
        kind: 'Lam',
        q: term.q,
        param: term.param,
        body: subst(term.body, name, replacement),
      };
    }
    case 'Let': {
      const nextVal = subst(term.value, name, replacement);
      if (term.name === name) {
        return { kind: 'Let', name: term.name, value: nextVal, body: term.body };
      }
      const repFree = freeVars(replacement);
      if (repFree.has(term.name)) {
        const avoid = new Set<string>([...repFree, ...freeVars(term.body), name]);
        const renamed = freshName(term.name, avoid);
        const renamedBody = subst(term.body, term.name, { kind: 'Var', name: renamed });
        return {
          kind: 'Let',
          name: renamed,
          value: nextVal,
          body: subst(renamedBody, name, replacement),
        };
      }
      return {
        kind: 'Let',
        name: term.name,
        value: nextVal,
        body: subst(term.body, name, replacement),
      };
    }
    case 'App':
      return {
        kind: 'App',
        q: term.q,
        func: subst(term.func, name, replacement),
        arg: subst(term.arg, name, replacement),
      };
  }
}

function defToLambda(def: Def): Term {
  let acc: Term = def.body;
  for (let i = def.params.length - 1; i >= 0; i--) {
    acc = {
      kind: 'Lam',
      q: def.params[i].q,
      param: def.params[i].name,
      body: acc,
    };
  }
  return acc;
}

/** Collects additive summands to canonicalize associative/commutative Nat sums for symbolic proof checking. */
function flattenAdd(term: Term, out: Term[]): void {
  if (term.kind === 'Add') {
    flattenAdd(term.lhs, out);
    flattenAdd(term.rhs, out);
  } else {
    out.push(term);
  }
}

export function canonicalizeAdd(lhs: Term, rhs: Term): Term {
  const parts: Term[] = [];
  flattenAdd(lhs, parts);
  flattenAdd(rhs, parts);
  let constSum = 0;
  const symbolic: Term[] = [];
  for (const p of parts) {
    if (p.kind === 'Nat') {
      constSum += p.value;
    } else {
      symbolic.push(p);
    }
  }
  symbolic.sort((a, b) => formatTerm(a).localeCompare(formatTerm(b)));
  if (constSum > 0 || symbolic.length === 0) {
    symbolic.push({ kind: 'Nat', value: constSum });
  }
  return symbolic.reduce((acc, item) => ({ kind: 'Add', lhs: acc, rhs: item }));
}

export function normalize(term: Term, defs: Map<string, Def>, fuel = 128): Term {
  if (fuel <= 0) return term;

  switch (term.kind) {
    case 'Ann':
      return normalize(term.term, defs, fuel - 1);

    case 'Var': {
      const def = defs.get(term.name);
      if (def && def.params.length === 0) {
        return normalize(def.body, defs, fuel - 1);
      }
      return term;
    }

    case 'Let': {
      const val = normalize(term.value, defs, fuel - 1);
      return normalize(subst(term.body, term.name, val), defs, fuel - 1);
    }

    case 'Not': {
      const op = normalize(term.operand, defs, fuel - 1);
      if (op.kind === 'Bool') return { kind: 'Bool', value: !op.value };
      if (op.kind === 'Not') return op.operand;
      return { kind: 'Not', operand: op };
    }

    case 'BinOp': {
      const lhs = normalize(term.lhs, defs, fuel - 1);
      const rhs = normalize(term.rhs, defs, fuel - 1);
      switch (term.op) {
        case 'And':
          if (lhs.kind === 'Bool') return lhs.value ? rhs : { kind: 'Bool', value: false };
          if (rhs.kind === 'Bool') return rhs.value ? lhs : { kind: 'Bool', value: false };
          if (formatTerm(lhs) === formatTerm(rhs)) return lhs;
          return { kind: 'BinOp', op: 'And', lhs, rhs };
        case 'Or':
          if (lhs.kind === 'Bool') return lhs.value ? { kind: 'Bool', value: true } : rhs;
          if (rhs.kind === 'Bool') return rhs.value ? { kind: 'Bool', value: true } : lhs;
          if (formatTerm(lhs) === formatTerm(rhs)) return lhs;
          return { kind: 'BinOp', op: 'Or', lhs, rhs };
        case 'Lt':
          if (lhs.kind === 'Nat' && rhs.kind === 'Nat') {
            return { kind: 'Bool', value: lhs.value < rhs.value };
          }
          return { kind: 'BinOp', op: 'Lt', lhs, rhs };
        case 'Le':
          if (lhs.kind === 'Nat' && rhs.kind === 'Nat') {
            return { kind: 'Bool', value: lhs.value <= rhs.value };
          }
          return { kind: 'BinOp', op: 'Le', lhs, rhs };
        case 'Gt':
          if (lhs.kind === 'Nat' && rhs.kind === 'Nat') {
            return { kind: 'Bool', value: lhs.value > rhs.value };
          }
          return { kind: 'BinOp', op: 'Gt', lhs, rhs };
        case 'Ge':
          if (lhs.kind === 'Nat' && rhs.kind === 'Nat') {
            return { kind: 'Bool', value: lhs.value >= rhs.value };
          }
          return { kind: 'BinOp', op: 'Ge', lhs, rhs };
        case 'Neq':
          if (lhs.kind === 'Nat' && rhs.kind === 'Nat') {
            return { kind: 'Bool', value: lhs.value !== rhs.value };
          }
          if (lhs.kind === 'Bool' && rhs.kind === 'Bool') {
            return { kind: 'Bool', value: lhs.value !== rhs.value };
          }
          if (formatTerm(lhs) === formatTerm(rhs)) {
            return { kind: 'Bool', value: false };
          }
          return { kind: 'BinOp', op: 'Neq', lhs, rhs };
      }
    }

    case 'If': {
      const cond = normalize(term.cond, defs, fuel - 1);
      if (cond.kind === 'Bool') {
        return normalize(cond.value ? term.thenBranch : term.elseBranch, defs, fuel - 1);
      }
      const thenBranch = normalize(term.thenBranch, defs, fuel - 1);
      const elseBranch = normalize(term.elseBranch, defs, fuel - 1);
      if (formatTerm(thenBranch) === formatTerm(elseBranch)) {
        return thenBranch;
      }
      return { kind: 'If', cond, thenBranch, elseBranch };
    }

    case 'Match': {
      const scrutinee = normalize(term.scrutinee, defs, fuel - 1);
      for (const arm of term.arms) {
        const matched = matchPattern(arm.pattern, scrutinee);
        if (matched !== null) {
          let body = arm.body;
          for (const [k, v] of matched.entries()) {
            body = subst(body, k, v);
          }
          return normalize(body, defs, fuel - 1);
        }
      }
      return {
        kind: 'Match',
        scrutinee,
        arms: term.arms.map((arm) => ({
          pattern: arm.pattern,
          body: normalize(arm.body, defs, fuel - 1),
        })),
      };
    }

    case 'App': {
      let fn = term.func;
      if (fn.kind === 'Var') {
        const def = defs.get(fn.name);
        if (def) {
          fn = defToLambda(def);
        }
      } else {
        fn = normalize(fn, defs, fuel - 1);
      }
      const arg = normalize(term.arg, defs, fuel - 1);
      if (fn.kind === 'Lam') {
        return normalize(subst(fn.body, fn.param, arg), defs, fuel - 1);
      }
      return { kind: 'App', q: term.q, func: fn, arg };
    }

    case 'Add': {
      const lhs = normalize(term.lhs, defs, fuel - 1);
      const rhs = normalize(term.rhs, defs, fuel - 1);
      if (lhs.kind === 'Nat' && rhs.kind === 'Nat') {
        return { kind: 'Nat', value: lhs.value + rhs.value };
      }
      return canonicalizeAdd(lhs, rhs);
    }

    case 'Sub': {
      const lhs = normalize(term.lhs, defs, fuel - 1);
      const rhs = normalize(term.rhs, defs, fuel - 1);
      if (lhs.kind === 'Nat' && rhs.kind === 'Nat') {
        return { kind: 'Nat', value: Math.max(0, lhs.value - rhs.value) };
      }
      if (rhs.kind === 'Nat' && rhs.value === 0) return lhs;
      if (formatTerm(lhs) === formatTerm(rhs)) return { kind: 'Nat', value: 0 };
      return { kind: 'Sub', lhs, rhs };
    }

    case 'Tup':
      return {
        kind: 'Tup',
        fst: normalize(term.fst, defs, fuel - 1),
        snd: normalize(term.snd, defs, fuel - 1),
      };

    case 'Lam':
      return {
        kind: 'Lam',
        q: term.q,
        param: term.param,
        body: normalize(term.body, defs, fuel - 1),
      };

    default:
      return term;
  }
}

export function termsEqual(a: Term, b: Term): boolean {
  return formatTerm(a) === formatTerm(b);
}

// --- Pattern Unification & Lemma Rewriting ---

function unifyPattern(
  pattern: Term,
  subject: Term,
  patternVars: Set<string>,
  bindings: Map<string, Term>
): boolean {
  if (pattern.kind === 'Var' && patternVars.has(pattern.name)) {
    const existing = bindings.get(pattern.name);
    if (existing) {
      return termsEqual(existing, subject);
    }
    bindings.set(pattern.name, subject);
    return true;
  }

  if (pattern.kind !== subject.kind) return false;

  switch (pattern.kind) {
    case 'Var':
      return subject.kind === 'Var' && pattern.name === subject.name;
    case 'Nat':
      return subject.kind === 'Nat' && pattern.value === subject.value;
    case 'Bool':
      return subject.kind === 'Bool' && pattern.value === subject.value;
    case 'Refl':
      return true;
    case 'Univ':
      return subject.kind === 'Univ' && pattern.q === subject.q;
    case 'Not':
      return (
        subject.kind === 'Not' &&
        unifyPattern(pattern.operand, subject.operand, patternVars, bindings)
      );
    case 'Add':
    case 'Sub':
    case 'Eq':
      return (
        subject.kind === pattern.kind &&
        unifyPattern(pattern.lhs, subject.lhs, patternVars, bindings) &&
        unifyPattern(pattern.rhs, subject.rhs, patternVars, bindings)
      );
    case 'BinOp':
      return (
        subject.kind === 'BinOp' &&
        pattern.op === subject.op &&
        unifyPattern(pattern.lhs, subject.lhs, patternVars, bindings) &&
        unifyPattern(pattern.rhs, subject.rhs, patternVars, bindings)
      );
    case 'App':
      return (
        subject.kind === 'App' &&
        unifyPattern(pattern.func, subject.func, patternVars, bindings) &&
        unifyPattern(pattern.arg, subject.arg, patternVars, bindings)
      );
    case 'Tup':
      return (
        subject.kind === 'Tup' &&
        unifyPattern(pattern.fst, subject.fst, patternVars, bindings) &&
        unifyPattern(pattern.snd, subject.snd, patternVars, bindings)
      );
    case 'If':
      return (
        subject.kind === 'If' &&
        unifyPattern(pattern.cond, subject.cond, patternVars, bindings) &&
        unifyPattern(pattern.thenBranch, subject.thenBranch, patternVars, bindings) &&
        unifyPattern(pattern.elseBranch, subject.elseBranch, patternVars, bindings)
      );
    default:
      return formatTerm(pattern) === formatTerm(subject);
  }
}

function instantiateTerm(template: Term, bindings: Map<string, Term>): Term {
  let out = template;
  for (const [k, v] of bindings.entries()) {
    out = subst(out, k, v);
  }
  return out;
}

/**
 * Rewrites matching subterms of `target` using a proven equality lemma (`lhs == rhs`).
 * Supports forward (`rewrite lemma`) and reverse (`rewrite <- lemma`) directions.
 */
export function applyLemmaRewrite(
  target: Term,
  lemma: Law,
  reverse: boolean
): { term: Term; changed: boolean } {
  if (lemma.statement.kind !== 'Eq') return { term: target, changed: false };
  const patternVars = new Set(lemma.vars.map((v) => v.name));
  const pat = reverse ? lemma.statement.rhs : lemma.statement.lhs;
  const rep = reverse ? lemma.statement.lhs : lemma.statement.rhs;

  let changed = false;

  const rewriteNode = (node: Term): Term => {
    const bindings = new Map<string, Term>();
    if (unifyPattern(pat, node, patternVars, bindings)) {
      changed = true;
      return instantiateTerm(rep, bindings);
    }

    switch (node.kind) {
      case 'Not':
        return { kind: 'Not', operand: rewriteNode(node.operand) };
      case 'Add':
        return { kind: 'Add', lhs: rewriteNode(node.lhs), rhs: rewriteNode(node.rhs) };
      case 'Sub':
        return { kind: 'Sub', lhs: rewriteNode(node.lhs), rhs: rewriteNode(node.rhs) };
      case 'BinOp':
        return {
          kind: 'BinOp',
          op: node.op,
          lhs: rewriteNode(node.lhs),
          rhs: rewriteNode(node.rhs),
        };
      case 'App':
        return {
          kind: 'App',
          q: node.q,
          func: rewriteNode(node.func),
          arg: rewriteNode(node.arg),
        };
      case 'Tup':
        return { kind: 'Tup', fst: rewriteNode(node.fst), snd: rewriteNode(node.snd) };
      case 'If':
        return {
          kind: 'If',
          cond: rewriteNode(node.cond),
          thenBranch: rewriteNode(node.thenBranch),
          elseBranch: rewriteNode(node.elseBranch),
        };
      case 'Match':
        return {
          kind: 'Match',
          scrutinee: rewriteNode(node.scrutinee),
          arms: node.arms.map((a) => ({ pattern: a.pattern, body: rewriteNode(a.body) })),
        };
      case 'Let':
        return {
          kind: 'Let',
          name: node.name,
          value: rewriteNode(node.value),
          body: rewriteNode(node.body),
        };
      case 'Ann':
        return { kind: 'Ann', term: rewriteNode(node.term), ty: node.ty };
      default:
        return node;
    }
  };

  const next = rewriteNode(target);
  return { term: next, changed };
}

// --- Sample Generation for Counterexample Search (Nat, Bool, and ADTs) ---

function sampleValuesForType(
  ty: Term,
  typeMap: Map<string, TypeDef>,
  varCount: number
): Term[] {
  if (ty.kind !== 'Var') return [];
  if (ty.name === 'Nat') {
    const nums = varCount === 1 ? [0, 1, 2, 3, 5, 10, 42] : [0, 1, 2, 5];
    return nums.map((v) => ({ kind: 'Nat', value: v }));
  }
  if (ty.name === 'Bool') {
    return [
      { kind: 'Bool', value: true },
      { kind: 'Bool', value: false },
    ];
  }
  const td = typeMap.get(ty.name);
  if (td) {
    const out: Term[] = [];
    for (const v of td.variants) {
      if (v.fields.length === 0) {
        out.push(buildCtorTerm(td.name, v.name, []));
      } else {
        // Instantiate with 0n/false and 5n/true samples
        const sampleZero = v.fields.map((f): Term =>
          f.ty.kind === 'Var' && f.ty.name === 'Bool'
            ? { kind: 'Bool', value: false }
            : { kind: 'Nat', value: 0 }
        );
        const sampleNonZero = v.fields.map((f): Term =>
          f.ty.kind === 'Var' && f.ty.name === 'Bool'
            ? { kind: 'Bool', value: true }
            : { kind: 'Nat', value: 5 }
        );
        out.push(buildCtorTerm(td.name, v.name, sampleZero));
        out.push(buildCtorTerm(td.name, v.name, sampleNonZero));
      }
    }
    return out;
  }
  return [];
}

/**
 * Fast fail-first counterexample search on concrete Nat, Bool, and ADT inputs.
 * Tells an AI model immediately if a law is FALSE rather than merely needing more proof steps.
 */
export function findCounterexample(
  law: Law,
  defs: Map<string, Def>,
  typeMap: Map<string, TypeDef> = new Map()
): Counterexample | undefined {
  if (law.statement.kind !== 'Eq') return undefined;

  const testableVars = law.vars
    .map((v) => ({
      name: v.name,
      samples: sampleValuesForType(v.ty, typeMap, law.vars.length),
    }))
    .filter((v) => v.samples.length > 0)
    .slice(0, 3);

  // If no quantified testable variables, evaluate directly
  if (testableVars.length === 0) {
    const lhs = normalize(law.statement.lhs, defs);
    const rhs = normalize(law.statement.rhs, defs);
    if (!termsEqual(lhs, rhs)) {
      return {
        bindings: {},
        lhsValue: formatTerm(lhs),
        rhsValue: formatTerm(rhs),
      };
    }
    return undefined;
  }

  let budget = 200;
  const search = (
    idx: number,
    currentBindings: Record<string, Term>
  ): Counterexample | undefined => {
    if (budget <= 0) return undefined;
    if (idx === testableVars.length) {
      budget--;
      let lhs = law.statement.kind === 'Eq' ? law.statement.lhs : law.statement;
      let rhs = law.statement.kind === 'Eq' ? law.statement.rhs : law.statement;
      for (const [name, val] of Object.entries(currentBindings)) {
        lhs = subst(lhs, name, val);
        rhs = subst(rhs, name, val);
      }
      const nLhs = normalize(lhs, defs);
      const nRhs = normalize(rhs, defs);
      if (!termsEqual(nLhs, nRhs)) {
        const prettyBindings: Record<string, string> = {};
        for (const [k, v] of Object.entries(currentBindings)) {
          prettyBindings[k] = formatTerm(v);
        }
        return {
          bindings: prettyBindings,
          lhsValue: formatTerm(nLhs),
          rhsValue: formatTerm(nRhs),
        };
      }
      return undefined;
    }

    const v = testableVars[idx];
    for (const s of v.samples) {
      currentBindings[v.name] = s;
      const found = search(idx + 1, currentBindings);
      if (found) return found;
    }
    return undefined;
  };

  return search(0, {});
}

interface ProofCheckOutcome {
  ok: boolean;
  reason: string;
  proofKind: 'refl' | 'case_split' | 'rewrite';
  errorCode?: string;
}

function verifyProofGoal(
  proof: Term,
  lhs: Term,
  rhs: Term,
  varTypes: Map<string, Term>,
  defs: Map<string, Def>,
  typeMap: Map<string, TypeDef>,
  provenLaws: Map<string, Law>
): ProofCheckOutcome {
  if (proof.kind === 'Refl') {
    const nLhs = normalize(lhs, defs);
    const nRhs = normalize(rhs, defs);
    if (termsEqual(nLhs, nRhs)) {
      return {
        ok: true,
        reason: 'Verified by symbolic normalization and reflexivity (refl).',
        proofKind: 'refl',
      };
    }
    return {
      ok: false,
      reason: `Reflexivity failed: '${formatTerm(nLhs)}' does not reduce to '${formatTerm(nRhs)}'.`,
      proofKind: 'refl',
      errorCode: 'E_LAW_UNPROVEN',
    };
  }

  if (proof.kind === 'Rewrite') {
    const lemma = provenLaws.get(proof.lemma);
    if (!lemma) {
      return {
        ok: false,
        reason: `Unknown or unproven lemma '${proof.lemma}' in rewrite proof.`,
        proofKind: 'rewrite',
        errorCode: 'E_PROOF_UNKNOWN_LEMMA',
      };
    }

    // Try rewriting raw terms first, then normalized terms (covers both unfolded & folded goals)
    let nextLhs = lhs;
    let nextRhs = rhs;
    let didChange = false;

    const rLhsRaw = applyLemmaRewrite(lhs, lemma, proof.reverse);
    if (rLhsRaw.changed) {
      nextLhs = rLhsRaw.term;
      didChange = true;
    }
    const rRhsRaw = applyLemmaRewrite(rhs, lemma, proof.reverse);
    if (rRhsRaw.changed) {
      nextRhs = rRhsRaw.term;
      didChange = true;
    }

    if (!didChange) {
      const normL = normalize(lhs, defs);
      const normR = normalize(rhs, defs);
      const rLhsNorm = applyLemmaRewrite(normL, lemma, proof.reverse);
      if (rLhsNorm.changed) {
        nextLhs = rLhsNorm.term;
        didChange = true;
      }
      const rRhsNorm = applyLemmaRewrite(normR, lemma, proof.reverse);
      if (rRhsNorm.changed) {
        nextRhs = rRhsNorm.term;
        didChange = true;
      }
    }

    if (!didChange) {
      return {
        ok: false,
        reason: `Lemma '${proof.lemma}' did not match any subterm in '${formatTerm(lhs)} == ${formatTerm(rhs)}'.`,
        proofKind: 'rewrite',
        errorCode: 'E_PROOF_REWRITE_NO_MATCH',
      };
    }

    const sub = verifyProofGoal(
      proof.rest,
      nextLhs,
      nextRhs,
      varTypes,
      defs,
      typeMap,
      provenLaws
    );
    return {
      ...sub,
      proofKind: 'rewrite',
      reason: sub.ok
        ? `Verified via lemma rewrite '${proof.lemma}' and ${sub.proofKind === 'case_split' ? 'case split' : 'refl'}.`
        : sub.reason,
    };
  }

  if (proof.kind === 'Match') {
    if (proof.scrutinee.kind !== 'Var') {
      return {
        ok: false,
        reason: `Case-split proof scrutinee '${formatTerm(proof.scrutinee)}' must be a quantified variable.`,
        proofKind: 'case_split',
        errorCode: 'E_PROOF_CASE_SCRUTINEE',
      };
    }
    const varName = proof.scrutinee.name;
    const varTy = varTypes.get(varName);
    if (!varTy || varTy.kind !== 'Var') {
      return {
        ok: false,
        reason: `Cannot case-split on unknown variable '${varName}'.`,
        proofKind: 'case_split',
        errorCode: 'E_PROOF_CASE_SCRUTINEE',
      };
    }

    // Check exhaustiveness against Bool or declared ADT
    const hasWildcard = proof.arms.some((a) => a.pattern.kind === 'PatWild');
    if (varTy.name === 'Bool' && !hasWildcard) {
      const covered = new Set(
        proof.arms
          .filter((a) => a.pattern.kind === 'PatBool')
          .map((a) => (a.pattern.kind === 'PatBool' ? String(a.pattern.value) : ''))
      );
      const missing = ['true', 'false'].filter((b) => !covered.has(b));
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `Incomplete case-split proof on Bool '${varName}': missing branch(es) ${missing.join(', ')}.`,
          proofKind: 'case_split',
          errorCode: 'E_PROOF_INCOMPLETE_CASE',
        };
      }
    } else if (typeMap.has(varTy.name) && !hasWildcard) {
      const td = typeMap.get(varTy.name)!;
      const covered = new Set(
        proof.arms
          .filter((a) => a.pattern.kind === 'PatCtor')
          .map((a) => (a.pattern.kind === 'PatCtor' ? a.pattern.ctor : ''))
      );
      const missing = td.variants
        .map((v) => v.name)
        .filter((name) => !covered.has(name));
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `Incomplete case-split proof on '${td.name}': missing constructor case(s) ${missing.join(', ')}.`,
          proofKind: 'case_split',
          errorCode: 'E_PROOF_INCOMPLETE_CASE',
        };
      }
    }

    // Verify each branch by substituting the constructor/literal pattern into LHS and RHS
    for (const arm of proof.arms) {
      let patTerm: Term | null = null;
      const nextVarTypes = new Map(varTypes);

      if (arm.pattern.kind === 'PatBool') {
        patTerm = { kind: 'Bool', value: arm.pattern.value };
      } else if (arm.pattern.kind === 'PatNat') {
        patTerm = { kind: 'Nat', value: arm.pattern.value };
      } else if (arm.pattern.kind === 'PatCtor') {
        const pat = arm.pattern;
        const td = typeMap.get(varTy.name);
        const variant = td?.variants.find((v) => v.name === pat.ctor);
        const argTerms: Term[] = pat.args.map((aName, idx) => {
          const safeName = aName === '_' ? `_arg${idx}` : aName;
          if (variant && variant.fields[idx]) {
            nextVarTypes.set(safeName, variant.fields[idx].ty);
          }
          return { kind: 'Var', name: safeName };
        });
        patTerm = buildCtorTerm(
          pat.typeName ?? (td ? td.name : undefined),
          pat.ctor,
          argTerms
        );
      }

      const branchLhs = patTerm ? subst(lhs, varName, patTerm) : lhs;
      const branchRhs = patTerm ? subst(rhs, varName, patTerm) : rhs;
      const branchRes = verifyProofGoal(
        arm.body,
        branchLhs,
        branchRhs,
        nextVarTypes,
        defs,
        typeMap,
        provenLaws
      );
      if (!branchRes.ok) {
        return {
          ok: false,
          reason: `Case '${formatPattern(arm.pattern)}' failed: ${branchRes.reason}`,
          proofKind: 'case_split',
          errorCode: branchRes.errorCode ?? 'E_LAW_UNPROVEN',
        };
      }
    }

    return {
      ok: true,
      reason: `Verified exhaustively across ${proof.arms.length} structural case branch(es) on '${varName}'.`,
      proofKind: 'case_split',
    };
  }

  const normProof = normalize(proof, defs);
  if (normProof.kind === 'Refl') {
    return verifyProofGoal(normProof, lhs, rhs, varTypes, defs, typeMap, provenLaws);
  }
  return {
    ok: false,
    reason: `Proof term '${formatTerm(normProof)}' did not reduce to 'refl', 'rewrite', or 'match'.`,
    proofKind: 'refl',
    errorCode: 'E_LAW_UNPROVEN',
  };
}

function verifyLaw(
  law: Law,
  defs: Map<string, Def>,
  typeMap: Map<string, TypeDef>,
  provenLaws: Map<string, Law>
): { verdict: LawVerdict; errorCode?: string } {
  const statementStr = formatTerm(law.statement);

  if (law.statement.kind !== 'Eq') {
    return {
      verdict: {
        name: law.name,
        passed: false,
        statement: statementStr,
        normalizedLhs: statementStr,
        normalizedRhs: '—',
        reason: 'Law statement must be an equality (lhs == rhs).',
        proofKind: 'missing',
      },
      errorCode: 'E_LAW_UNPROVEN',
    };
  }

  const normLhs = normalize(law.statement.lhs, defs);
  const normRhs = normalize(law.statement.rhs, defs);
  const ce = findCounterexample(law, defs, typeMap);

  if (ce) {
    const inputs = Object.entries(ce.bindings)
      .map(([k, v]) => `${k} = ${v}`)
      .join(', ');
    const where = inputs ? `for ${inputs}: ` : '';
    return {
      verdict: {
        name: law.name,
        passed: false,
        statement: statementStr,
        normalizedLhs: formatTerm(normLhs),
        normalizedRhs: formatTerm(normRhs),
        reason: `Counterexample found (${where}${ce.lhsValue} != ${ce.rhsValue}). The law or implementation is false.`,
        counterexample: ce,
        proofKind: law.proof ? 'refl' : 'missing',
      },
      errorCode: 'E_LAW_FALSE',
    };
  }

  if (!law.proof) {
    return {
      verdict: {
        name: law.name,
        passed: false,
        statement: statementStr,
        normalizedLhs: formatTerm(normLhs),
        normalizedRhs: formatTerm(normRhs),
        reason: `Unproven law: no counterexample found, add 'proof ${law.name}: refl' (or a case-split/rewrite proof) to complete the build gate.`,
        proofKind: 'missing',
      },
      errorCode: 'E_LAW_UNPROVEN',
    };
  }

  const varTypes = new Map<string, Term>();
  for (const v of law.vars) {
    varTypes.set(v.name, v.ty);
  }

  const outcome = verifyProofGoal(
    law.proof,
    law.statement.lhs,
    law.statement.rhs,
    varTypes,
    defs,
    typeMap,
    provenLaws
  );

  return {
    verdict: {
      name: law.name,
      passed: outcome.ok,
      statement: statementStr,
      normalizedLhs: formatTerm(normLhs),
      normalizedRhs: formatTerm(normRhs),
      reason: outcome.reason,
      proofKind: outcome.proofKind,
    },
    errorCode: outcome.ok ? undefined : outcome.errorCode ?? 'E_LAW_UNPROVEN',
  };
}

export function checkBook(
  book: Book,
  lawLock: LawLockSnapshot | null = null
): CheckReport {
  const diagnostics: Diagnostic[] = [];
  const { typeMap, knownGlobals } = buildKnownSymbols(book);
  const ctorNames = new Set<string>();
  for (const td of book.types ?? []) {
    for (const v of td.variants) {
      ctorNames.add(v.name);
      ctorNames.add(`${td.name}.${v.name}`);
    }
  }

  const defMap = new Map<string, Def>();
  const defStats: CheckReport['defStats'] = [];

  for (const def of book.defs) {
    if (defMap.has(def.name)) {
      diagnostics.push({
        code: 'E_DUP_DEF',
        severity: 'error',
        scope: def.name,
        message: `Duplicate definition '${def.name}'`,
        fixHint: `Rename or merge the duplicate 'def ${def.name}'.`,
        line: def.span?.line,
      });
    }
    defMap.set(def.name, def);
  }

  for (const def of book.defs) {
    const env: Env = new Map();
    let deadParams = 0;
    let liveParams = 0;
    let dataParams = 0;

    for (const p of def.params) {
      if (p.q === Quantity.Dead) deadParams++;
      else if (p.q === Quantity.Live) liveParams++;
      else dataParams++;

      checkTermUsage(p.ty, Quantity.Dead, env, knownGlobals, ctorNames, def.name, diagnostics);
      env.set(p.name, { q: p.q, uses: 0, line: p.span?.line });
    }

    checkTermUsage(def.ret, Quantity.Dead, env, knownGlobals, ctorNames, def.name, diagnostics);

    const bodyCtx =
      def.ret.kind === 'Univ' && def.ret.q === Quantity.Data
        ? Quantity.Data
        : Quantity.Live;

    if (bodyCtx === Quantity.Data) {
      checkDataPurity(def.body, def.name, ctorNames, diagnostics);
    }

    const beforeErrors = diagnostics.length;
    checkTermUsage(def.body, bodyCtx, env, knownGlobals, ctorNames, def.name, diagnostics);

    defStats.push({
      name: def.name,
      deadParams,
      liveParams,
      dataParams,
      erasedOk: diagnostics.length === beforeErrors,
    });
  }

  // Verify laws sequentially so proven laws become usable as lemmas in subsequent `rewrite` proofs!
  const provenLaws = new Map<string, Law>();
  const lawVerdicts = book.laws.map((law) => {
    const { verdict, errorCode } = verifyLaw(law, defMap, typeMap, provenLaws);
    if (verdict.passed) {
      provenLaws.set(law.name, law);
    } else {
      diagnostics.push({
        code: errorCode ?? (verdict.counterexample ? 'E_LAW_FALSE' : 'E_LAW_UNPROVEN'),
        severity: 'error',
        scope: `law ${law.name}`,
        message: verdict.reason,
        fixHint: verdict.counterexample
          ? 'Fix the definition in verified/ — the counterexample proves the current code violates the law.'
          : errorCode === 'E_PROOF_INCOMPLETE_CASE'
            ? 'Add the missing constructor case branch(es) to make the structural proof exhaustive.'
            : errorCode === 'E_PROOF_UNKNOWN_LEMMA'
              ? 'Ensure the referenced lemma is declared and proven earlier in the file.'
              : `Add 'proof ${law.name}: refl' (or a 'match' case-split / 'rewrite' proof).`,
        line: law.span?.line,
      });
    }
    return verdict;
  });

  const lockCheck = verifyLawLock(book, lawLock);
  if (lockCheck.locked && !lockCheck.valid) {
    const parts: string[] = [];
    if (lockCheck.missingLaws.length > 0) {
      parts.push(`removed: ${lockCheck.missingLaws.join(', ')}`);
    }
    if (lockCheck.modifiedLaws.length > 0) {
      parts.push(`modified: ${lockCheck.modifiedLaws.join(', ')}`);
    }
    diagnostics.push({
      code: 'E_LAW_LOCK_TAMPERED',
      severity: 'error',
      scope: 'LAWS.bend lock',
      message: `Locked laws were altered (${parts.join('; ')}). AI agents may not weaken or delete locked laws.`,
      fixHint:
        'Restore the original law statements, or explicitly update the lock as a human reviewer (RUSTY_BENDS_UPDATE_LAWS=1).',
    });
  }

  const erasure = eraseBook(book);
  if (erasure.remainingDeadNodes > 0) {
    diagnostics.push({
      code: 'E_ERASURE_INCOMPLETE',
      severity: 'error',
      scope: 'erasure',
      message: `${erasure.remainingDeadNodes} Dead (q=0) node(s) survived erasure`,
      fixHint: 'Ensure all Dead (q=0) binders and annotations are erased before codegen.',
    });
  }

  const hasErrors = diagnostics.some((d) => d.severity === 'error');
  const allLawsPass = lawVerdicts.every((v) => v.passed);

  return {
    buildPassed: !hasErrors && allLawsPass && lockCheck.valid,
    diagnostics,
    lawVerdicts,
    erasure,
    lockCheck,
    defStats,
  };
}
