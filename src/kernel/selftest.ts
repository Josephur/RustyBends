import { Quantity, Term, isErased } from './ast';
import { checkBook, createLawLock } from './checker';
import { emitVerifiedRust } from './codegen';
import { parseBendBook } from './parser';

export interface KernelTestResult {
  name: string;
  origin: string;
  passed: boolean;
  detail: string;
}

export function runKernelSelfTests(): KernelTestResult[] {
  const results: KernelTestResult[] = [];

  // 1. Direct port of original lib.rs test
  {
    const passed =
      isErased(Quantity.Dead) &&
      !isErased(Quantity.Live) &&
      !isErased(Quantity.Data);
    results.push({
      name: 'dead_parts_are_erased_and_live_parts_are_not',
      origin: 'lib.rs unit test',
      passed,
      detail: 'Quantity::Dead.is_erased() == true; Live and Data are false.',
    });
  }

  // 2. Direct port of original lib.rs test
  {
    const term: Term = {
      kind: 'Ann',
      term: { kind: 'Var', name: 'x' },
      ty: { kind: 'Univ', q: Quantity.Dead },
    };
    const passed =
      term.kind === 'Ann' && term.ty.kind === 'Univ' && isErased(term.ty.q);
    results.push({
      name: 'annotation_marks_the_type_as_a_dead_term',
      origin: 'lib.rs unit test',
      passed,
      detail: 'Term::Ann carries a Dead (q=0) type annotation stripped by erasure.',
    });
  }

  // 3. Affine live duplication rejected
  {
    const parsed = parseBendBook('def bad(x: Nat) -> Nat: (x, x)');
    const report = parsed.book ? checkBook(parsed.book) : null;
    const passed =
      parsed.errors.length === 0 &&
      report !== null &&
      !report.buildPassed &&
      report.diagnostics.some((d) => d.code === 'E_AFFINE_DUP');
    results.push({
      name: 'affine_live_duplication_fails_check',
      origin: 'BendTT affine rule',
      passed,
      detail: 'Using Live (q=1) variable twice triggers E_AFFINE_DUP with fix hint.',
    });
  }

  // 4. Data (q=2) duplication succeeds & emits pure Rust
  {
    const parsed = parseBendBook('def ok(+n: Nat) -> Nat: n + n');
    const report = parsed.book ? checkBook(parsed.book) : null;
    const rust = parsed.book && report ? emitVerifiedRust(parsed.book, report) : '';
    const passed =
      parsed.errors.length === 0 &&
      report !== null &&
      report.buildPassed &&
      rust.includes('pub fn ok(n: u64) -> u64');
    results.push({
      name: 'verified_data_def_emits_pure_rust',
      origin: 'Verified Core -> Rust',
      passed,
      detail: 'Passing Data (q=2) def emits zero-dependency pub fn ok(n: u64) -> u64.',
    });
  }

  // 5. Dead leak into live body fails
  {
    const parsed = parseBendBook('def leak(-T: Type) -> Type: T');
    const report = parsed.book ? checkBook(parsed.book) : null;
    const passed =
      parsed.errors.length === 0 &&
      report !== null &&
      !report.buildPassed &&
      report.diagnostics.some((d) => d.code === 'E_DEAD_LEAK');
    results.push({
      name: 'dead_binding_cannot_leak_into_live_body',
      origin: 'BendTT dead/live split',
      passed,
      detail: 'Returning q=0 parameter in live body triggers E_DEAD_LEAK.',
    });
  }

  // 6. Erasure eliminates all q=0 nodes and laws
  {
    const parsed = parseBendBook(
      'def id(-T: Type, x: T) -> T: (x : T)\nlaw id_ok(for +n: Nat): id(Nat, n) == n\nproof id_ok: refl'
    );
    const report = parsed.book ? checkBook(parsed.book) : null;
    const passed =
      parsed.errors.length === 0 &&
      report !== null &&
      report.buildPassed &&
      report.erasure.deadParamsErased === 1 &&
      report.erasure.annotationsErased === 1 &&
      report.erasure.lawsErased === 1 &&
      report.erasure.remainingDeadNodes === 0;
    results.push({
      name: 'erasure_eliminates_all_q0_nodes_and_laws',
      origin: 'BendTT erasure invariant',
      passed,
      detail: 'Erased 1 Dead param, 1 Ann, and 1 Law; 0 Dead nodes remain.',
    });
  }

  // 7. Counterexample finder catches false laws instantly
  {
    const parsed = parseBendBook(
      'def buggy(+x: Nat) -> Nat: x + 1n\nlaw bad(for +x: Nat): buggy(x) == x\nproof bad: refl'
    );
    const report = parsed.book ? checkBook(parsed.book) : null;
    const passed =
      parsed.errors.length === 0 &&
      report !== null &&
      !report.buildPassed &&
      report.diagnostics.some((d) => d.code === 'E_LAW_FALSE') &&
      Boolean(report.lawVerdicts[0]?.counterexample);
    results.push({
      name: 'counterexample_finder_catches_false_law',
      origin: 'Fail-fast counterexample',
      passed,
      detail: 'False law triggers E_LAW_FALSE with concrete input counterexample.',
    });
  }

  // 8. Anti-cheat LAWS.bend lock catches tampered or deleted laws
  {
    const original = parseBendBook(
      'def f(+n: Nat) -> Nat: n\nlaw keep(for +n: Nat): f(n) == n\nproof keep: refl'
    );
    const tampered = parseBendBook('def f(+n: Nat) -> Nat: n');
    const lock = original.book ? createLawLock(original.book) : null;
    const report = tampered.book ? checkBook(tampered.book, lock) : null;
    const rust = tampered.book && report ? emitVerifiedRust(tampered.book, report) : '';
    const passed =
      report !== null &&
      !report.buildPassed &&
      report.diagnostics.some((d) => d.code === 'E_LAW_LOCK_TAMPERED') &&
      rust.includes('compile_error!');
    results.push({
      name: 'anti_cheat_law_lock_blocks_deleted_laws',
      origin: 'LAWS.bend anti-cheat lock',
      passed,
      detail: 'Deleting a locked law triggers E_LAW_LOCK_TAMPERED and blocks Rust codegen.',
    });
  }

  return results;
}
