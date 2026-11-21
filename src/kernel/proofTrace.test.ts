import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBook } from './checker';
import { BEND_EXAMPLES } from './examples';
import { parseBendBook } from './parser';
import { traceBookLaws, traceLawProof } from './proofTrace';

test('traceLawProof records unfolding, zero-identity, and AC canonicalization steps for Ledger laws', () => {
  const ledger = BEND_EXAMPLES.find((e) => e.id === 'ledger_verified');
  assert.ok(ledger);
  const parsed = parseBendBook(ledger.source);
  assert.ok(parsed.book);

  const traces = traceBookLaws(parsed.book);
  assert.equal(traces.length, 3);

  // 1. deposit_zero: deposit(bal, 0n) -> (bal + 0n) -> bal == bal
  const depZero = traces[0];
  assert.equal(depZero.lawName, 'deposit_zero');
  assert.equal(depZero.status, 'proven');
  assert.equal(depZero.converged, true);
  assert.ok(depZero.lhsSteps.some((s) => s.rule === 'delta_unfold'));
  assert.ok(depZero.lhsSteps.some((s) => s.rule === 'nat_identity'));
  assert.equal(depZero.lhsFinal, 'bal');
  assert.equal(depZero.rhsFinal, 'bal');

  // 2. deposit_commutes: deposit(a, b) -> (a + b) vs deposit(b, a) -> (b + a) -> (a + b)
  const depComm = traces[1];
  assert.equal(depComm.lawName, 'deposit_commutes');
  assert.equal(depComm.status, 'proven');
  assert.ok(depComm.rhsSteps.some((s) => s.rule === 'ac_canon'));
  assert.equal(depComm.lhsFinal, '(a + b)');
  assert.equal(depComm.rhsFinal, '(a + b)');

  // 3. total_after_deposit: multi-step unfolding + AC canonicalization
  const totalDep = traces[2];
  assert.equal(totalDep.lawName, 'total_after_deposit');
  assert.equal(totalDep.status, 'proven');
  assert.ok(totalDep.lhsSteps.length >= 3);
  assert.ok(totalDep.rhsSteps.length >= 3);
  assert.equal(totalDep.lhsFinal, totalDep.rhsFinal);
});

test('traceLawProof records q=0 annotation erasure for Identity law', () => {
  const idEx = BEND_EXAMPLES.find((e) => e.id === 'id_erased');
  assert.ok(idEx);
  const parsed = parseBendBook(idEx.source);
  assert.ok(parsed.book);

  const trace = traceLawProof(parsed.book.laws[0], parsed.book);
  assert.equal(trace.status, 'proven');
  assert.ok(trace.lhsSteps.some((s) => s.rule === 'delta_unfold'));
  assert.ok(trace.lhsSteps.some((s) => s.rule === 'erase_ann'));
  assert.equal(trace.lhsFinal, 'x');
  assert.equal(trace.rhsFinal, 'x');
});

test('traceLawProof captures counterexample evaluation steps for false laws', () => {
  const falseEx = BEND_EXAMPLES.find((e) => e.id === 'false_law_ce');
  assert.ok(falseEx);
  const parsed = parseBendBook(falseEx.source);
  assert.ok(parsed.book);

  const trace = traceLawProof(parsed.book.laws[0], parsed.book);
  assert.equal(trace.status, 'false_counterexample');
  assert.equal(trace.converged, false);
  assert.ok(trace.counterexampleTrace);
  assert.equal(trace.counterexampleTrace.lhsFinal, '1n');
  assert.equal(trace.counterexampleTrace.rhsFinal, '0n');
  assert.ok(trace.counterexampleTrace.lhsSteps.length >= 2);
});

test('traceLawProof distinguishes converged unproven laws missing a proof block', () => {
  const unprovenEx = BEND_EXAMPLES.find((e) => e.id === 'unproven_law');
  assert.ok(unprovenEx);
  const parsed = parseBendBook(unprovenEx.source);
  assert.ok(parsed.book);

  const trace = traceLawProof(parsed.book.laws[0], parsed.book);
  assert.equal(trace.status, 'unproven_missing_proof');
  assert.equal(trace.converged, true);
  assert.equal(trace.proofTerm, null);
  assert.equal(trace.lhsFinal, '3n');
  assert.equal(trace.rhsFinal, '3n');
});

test('traceBookLaws matches checkBook normalized LHS and RHS across every curated example', () => {
  for (const ex of BEND_EXAMPLES) {
    const parsed = parseBendBook(ex.source);
    assert.ok(parsed.book);
    const report = checkBook(parsed.book);
    const traces = traceBookLaws(parsed.book);
    assert.equal(traces.length, report.lawVerdicts.length);
    for (let i = 0; i < traces.length; i++) {
      assert.equal(
        traces[i].lhsFinal,
        report.lawVerdicts[i].normalizedLhs,
        `${ex.id}:${traces[i].lawName} LHS mismatch`
      );
      assert.equal(
        traces[i].rhsFinal,
        report.lawVerdicts[i].normalizedRhs,
        `${ex.id}:${traces[i].lawName} RHS mismatch`
      );
    }
  }
});

test('traceLawProof traces all 4 structural case-split branches for OrderState cancel_idempotent', () => {
  const sm = BEND_EXAMPLES.find((e) => e.id === 'order_state_machine');
  assert.ok(sm);
  const parsed = parseBendBook(sm.source);
  assert.ok(parsed.book);

  const traces = traceBookLaws(parsed.book);
  const cancelTrace = traces.find((t) => t.lawName === 'cancel_idempotent');
  assert.ok(cancelTrace);
  assert.equal(cancelTrace.status, 'proven');
  assert.equal(cancelTrace.proofStrategy, 'case_split');
  assert.ok(cancelTrace.branches);
  assert.equal(cancelTrace.branches.length, 4);
  for (const branch of cancelTrace.branches) {
    assert.equal(branch.passed, true, `Branch ${branch.patternLabel} did not pass`);
    assert.equal(branch.converged, true, `Branch ${branch.patternLabel} did not converge`);
    assert.equal(branch.lhsFinal, branch.rhsFinal);
  }
});

test('traceLawProof records lemma_rewrite steps for chained rewrite proofs', () => {
  const rw = BEND_EXAMPLES.find((e) => e.id === 'lemma_rewrite_chain');
  assert.ok(rw);
  const parsed = parseBendBook(rw.source);
  assert.ok(parsed.book);

  const traces = traceBookLaws(parsed.book);
  const chainTrace = traces.find((t) => t.lawName === 'double_zero_fee_unchanged');
  assert.ok(chainTrace);
  assert.equal(chainTrace.status, 'proven');
  assert.equal(chainTrace.proofStrategy, 'rewrite');
  const rewriteSteps = chainTrace.lhsSteps.filter((s) => s.rule === 'lemma_rewrite');
  assert.ok(rewriteSteps.length >= 2, `Expected >=2 lemma_rewrite steps, got ${rewriteSteps.length}`);
  assert.equal(chainTrace.lhsFinal, 'bal');
  assert.equal(chainTrace.rhsFinal, 'bal');
});

