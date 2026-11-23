import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Quantity, isErased } from './ast';
import { checkBook, createLawLock } from './checker';
import { emitVerifiedRust } from './codegen';
import { BEND_EXAMPLES } from './examples';
import { parseBendBook } from './parser';
import { runKernelSelfTests } from './selftest';
import {
  buildAiKickoffPrompt,
  buildWorkspaceSetupScript,
  generateStarterKitFiles,
} from './starterKit';

test('all built-in kernel self-tests pass', () => {
  const results = runKernelSelfTests();
  assert.ok(results.length >= 8);
  for (const r of results) {
    assert.equal(r.passed, true, `Self-test failed: ${r.name} — ${r.detail}`);
  }
});

test('all curated BendTT examples match their expected pass/fail outcomes', () => {
  for (const ex of BEND_EXAMPLES) {
    const parsed = parseBendBook(ex.source);
    assert.equal(parsed.errors.length, 0, `Parse error in example ${ex.id}`);
    assert.ok(parsed.book);
    const report = checkBook(parsed.book);
    const expectedPass = ex.expectedOutcome === 'pass';
    assert.equal(
      report.buildPassed,
      expectedPass,
      `Example ${ex.id} expected buildPassed=${expectedPass}, got ${report.buildPassed}`
    );
  }
});

test('ledger conservation example erases q=0 and emits pure Rust', () => {
  const ledger = BEND_EXAMPLES.find((e) => e.id === 'ledger_verified');
  assert.ok(ledger);
  const parsed = parseBendBook(ledger.source);
  assert.ok(parsed.book);
  const report = checkBook(parsed.book);
  assert.equal(report.buildPassed, true);
  assert.equal(report.lawVerdicts.length, 3);
  assert.equal(report.erasure.remainingDeadNodes, 0);

  const rust = emitVerifiedRust(parsed.book, report);
  assert.ok(rust.includes('pub fn deposit(bal: u64, amt: u64) -> u64'));
  assert.ok(rust.includes('saturating_add'));
  assert.ok(!rust.includes('compile_error!'));
});

test('counterexample search catches false law immediately with concrete inputs', () => {
  const ceExample = BEND_EXAMPLES.find((e) => e.id === 'false_law_ce');
  assert.ok(ceExample);
  const parsed = parseBendBook(ceExample.source);
  assert.ok(parsed.book);
  const report = checkBook(parsed.book);
  assert.equal(report.buildPassed, false);
  const verdict = report.lawVerdicts[0];
  assert.ok(verdict?.counterexample);
  assert.equal(verdict.counterexample.lhsValue, '1n');
  assert.equal(verdict.counterexample.rhsValue, '0n');
});

test('anti-cheat LAWS.bend lock catches weakened laws but permits implementation edits', () => {
  const baseSrc = `
def deposit(+bal: Nat, +amt: Nat) -> Nat:
  bal + amt

law deposit_zero(for +bal: Nat):
  deposit(bal, 0n) == bal

proof deposit_zero:
  refl
`;
  const base = parseBendBook(baseSrc);
  assert.ok(base.book);
  const lock = createLawLock(base.book);

  // Changing implementation comment/whitespace does NOT break lock
  const sameLaws = parseBendBook(`# comment\n${baseSrc}`);
  assert.ok(sameLaws.book);
  const okReport = checkBook(sameLaws.book, lock);
  assert.equal(okReport.lockCheck.valid, true);
  assert.equal(okReport.buildPassed, true);

  // Weakening the law statement MUST trip E_LAW_LOCK_TAMPERED
  const weakened = parseBendBook(`
def deposit(+bal: Nat, +amt: Nat) -> Nat:
  bal + amt

law deposit_zero(for +bal: Nat):
  bal == bal

proof deposit_zero:
  refl
`);
  assert.ok(weakened.book);
  const tamperedReport = checkBook(weakened.book, lock);
  assert.equal(tamperedReport.lockCheck.valid, false);
  assert.deepEqual(tamperedReport.lockCheck.modifiedLaws, ['deposit_zero']);
  assert.equal(tamperedReport.buildPassed, false);
  assert.ok(emitVerifiedRust(weakened.book, tamperedReport).includes('compile_error!'));
});

test('starter kit and AI kickoff prompt generate all required v1.0.0 artifacts', () => {
  const files = generateStarterKitFiles(
    'def f(+n: Nat) -> Nat:\n  n\n\nlaw f_id(for +n: Nat):\n  f(n) == n\n\nproof f_id:\n  refl\n',
    'pub fn f(n: u64) -> u64 { n }',
    'bend-lock:1234'
  );
  assert.equal(files.length, 14);
  const byPath = new Map(files.map((f) => [f.path, f]));

  assert.ok(byPath.has('rusty-bends-build/Cargo.toml'));
  assert.ok(byPath.has('rusty-bends-build/src/lib.rs'));
  assert.ok(byPath.has('rusty-bends-build/src/lock.rs'));
  assert.ok(byPath.has('rusty-bends-build/src/emit.rs'));
  assert.ok(byPath.has('rusty-bends-build/src/law_test.rs'));
  assert.ok(byPath.has('rusty-bends-build/src/mutate.rs'));
  assert.ok(byPath.has('rusty-bends-build/src/bin/rusty-bends-laws.rs'));
  assert.ok(byPath.has('rusty-bends-build/lemmas/nat_lemmas.bend'));
  assert.ok(byPath.has('example-app/Cargo.toml'));
  assert.ok(byPath.has('example-app/build.rs'));
  assert.ok(byPath.has('example-app/bend.pin'));
  assert.ok(byPath.has('example-app/verified/core.bend'));
  assert.ok(byPath.has('example-app/src/main.rs'));
  assert.ok(byPath.has('BEND_GUIDE.md'));

  const libRs = byPath.get('rusty-bends-build/src/lib.rs')!.content;
  assert.ok(libRs.includes('pub mod lock;'));
  assert.ok(libRs.includes('pub mod emit;'));
  assert.ok(libRs.includes('--check-only'));
  assert.ok(libRs.includes('--verdict'));
  assert.ok(libRs.includes('pub const NAT_LEMMAS_BEND'));
  assert.ok(libRs.includes('pub fn write_nat_lemmas'));
  assert.ok(libRs.includes('pub fn verify_and_emit'));
  assert.ok(libRs.includes('verify_bend_version_str'));
  assert.ok(libRs.includes('E_BEND_VERSION_MISMATCH'));
  assert.ok(libRs.includes('#[cfg(test)]'));
  assert.ok(libRs.includes('compile_error!(\\"RustyBends verification failed'));
  assert.ok(!libRs.includes('\\\\n'), 'lib.rs must not contain double-escaped \\\\n');

  const lockRs = byPath.get('rusty-bends-build/src/lock.rs')!.content;
  assert.ok(lockRs.includes('pub fn extract_laws_from_source'));
  assert.ok(lockRs.includes('E_LAW_LOCK_TAMPERED'));
  assert.ok(lockRs.includes('#[cfg(test)]'));
  assert.ok(!lockRs.includes('\\\\n'), 'lock.rs must not contain double-escaped \\\\n');

  const emitRs = byPath.get('rusty-bends-build/src/emit.rs')!.content;
  assert.ok(emitRs.includes('pub fn emit_verified_rust'));
  assert.ok(emitRs.includes('pub enum '));
  assert.ok(emitRs.includes('match '));
  assert.ok(emitRs.includes('emits_real_bend2_syntax_and_erases_proof_defs'));
  assert.ok(emitRs.includes('emits_bend2_base_nat_and_bool_helpers'));
  assert.ok(emitRs.includes('emits_wrapping_for_u32_and_checked_for_nat'));
  assert.ok(emitRs.includes('emits_nested_match_multi_scrutinee_succ_and_let'));
  assert.ok(emitRs.includes('emits_pair_types_and_pair_accessors'));
  assert.ok(emitRs.includes('Nat.is_le'));
  assert.ok(emitRs.includes('Bool.and'));
  assert.ok(emitRs.includes('wrapping_add'));
  assert.ok(emitRs.includes('#[cfg(test)]'));
  assert.ok(emitRs.includes('checked_add'));
  assert.ok(emitRs.includes("out.push('\\n');"));
  assert.ok(!emitRs.includes('\\\\n'), 'emit.rs must not contain double-escaped \\\\n');

  const coreBend = byPath.get('example-app/verified/core.bend')!.content;
  assert.ok(coreBend.includes('import Base'));
  assert.ok(coreBend.includes('type OrderState is Data:'));
  assert.ok(coreBend.includes('law deposit_zero:'));
  assert.ok(coreBend.includes('{==}'));

  const bendPin = byPath.get('example-app/bend.pin')!.content;
  assert.ok(bendPin.includes('BEND_PIN_VERSION'));

  const buildRs = byPath.get('example-app/build.rs')!.content;
  assert.ok(buildRs.includes('rusty_bends_build::verify_and_emit("verified")'));

  const mainRs = byPath.get('example-app/src/main.rs')!.content;
  assert.ok(mainRs.includes('include!(concat!(env!("OUT_DIR"), "/verified.rs"))'));

  const script = buildWorkspaceSetupScript(files);
  assert.ok(script.startsWith('#!/usr/bin/env sh\n'));
  assert.ok(script.includes('mkdir -p "rusty-bends-build/src"'));
  assert.ok(script.includes('mkdir -p "example-app/verified"'));
  for (const file of files) {
    assert.ok(
      script.includes(`cat << 'RUSTY_BENDS_EOF' > "${file.path}"`),
      `setup script missing heredoc for ${file.path}`
    );
  }

  const prompt = buildAiKickoffPrompt('billing-core', 'Ledger API', 'Conservation of funds; Non-negative fees');
  assert.ok(prompt.includes('billing-core'));
  assert.ok(prompt.includes('- Conservation of funds'));
  assert.ok(prompt.includes('E_LAW_FALSE'));
  assert.equal(isErased(Quantity.Dead), true);
});

test('v1 ADT state machine passes exhaustive case-split proof and emits Rust enum + match', () => {
  const sm = BEND_EXAMPLES.find((e) => e.id === 'order_state_machine');
  assert.ok(sm);
  const parsed = parseBendBook(sm.source);
  assert.equal(parsed.errors.length, 0);
  assert.ok(parsed.book);
  assert.equal(parsed.book.types?.length, 1);
  assert.equal(parsed.book.types?.[0].name, 'OrderState');

  const report = checkBook(parsed.book);
  assert.equal(report.buildPassed, true);
  assert.equal(report.lawVerdicts.length, 2);
  assert.ok(report.lawVerdicts.every((v) => v.passed));

  const rust = emitVerifiedRust(parsed.book, report);
  assert.ok(rust.includes('pub enum OrderState'));
  assert.ok(rust.includes('OrderState::Draft'));
  assert.ok(rust.includes('OrderState::Paid(amt)'));
  assert.ok(rust.includes('match s {'));
  assert.ok(!rust.includes('compile_error!'));
});

test('incomplete ADT case-split proof is rejected with E_PROOF_INCOMPLETE_CASE', () => {
  const src = `
type OrderState:
  | Draft
  | Paid(amt: Nat)
  | Cancelled

def cancel_order(+s: OrderState) -> OrderState:
  match s:
    case OrderState.Draft => OrderState.Cancelled
    case OrderState.Paid(amt) => OrderState.Cancelled
    case OrderState.Cancelled => OrderState.Cancelled

law cancel_idem(for +s: OrderState):
  cancel_order(cancel_order(s)) == cancel_order(s)

proof cancel_idem:
  match s:
    case OrderState.Draft => refl
    case OrderState.Cancelled => refl
`;
  const parsed = parseBendBook(src);
  assert.equal(parsed.errors.length, 0);
  assert.ok(parsed.book);
  const report = checkBook(parsed.book);
  assert.equal(report.buildPassed, false);
  assert.ok(
    report.diagnostics.some((d) => d.code === 'E_PROOF_INCOMPLETE_CASE'),
    `Expected E_PROOF_INCOMPLETE_CASE, got: ${report.diagnostics.map((d) => d.code).join(', ')}`
  );
});

test('v1 lemma rewrite chaining passes and unknown lemma fails with E_PROOF_UNKNOWN_LEMMA', () => {
  const rw = BEND_EXAMPLES.find((e) => e.id === 'lemma_rewrite_chain');
  assert.ok(rw);
  const parsed = parseBendBook(rw.source);
  assert.equal(parsed.errors.length, 0);
  assert.ok(parsed.book);
  const report = checkBook(parsed.book);
  assert.equal(report.buildPassed, true);
  assert.equal(report.lawVerdicts.length, 3);
  assert.ok(report.lawVerdicts.every((v) => v.passed));

  const badSrc = `
def add_fee(+bal: Nat, +fee: Nat) -> Nat:
  bal + fee

law bad_rewrite(for +bal: Nat):
  add_fee(bal, 0n) == bal

proof bad_rewrite:
  rewrite nonexistent_lemma;
  refl
`;
  const badParsed = parseBendBook(badSrc);
  assert.equal(badParsed.errors.length, 0);
  assert.ok(badParsed.book);
  const badReport = checkBook(badParsed.book);
  assert.equal(badReport.buildPassed, false);
  assert.ok(
    badReport.diagnostics.some((d) => d.code === 'E_PROOF_UNKNOWN_LEMMA'),
    `Expected E_PROOF_UNKNOWN_LEMMA, got: ${badReport.diagnostics.map((d) => d.code).join(', ')}`
  );
});

test('buggy ADT law fails with concrete ADT counterexample', () => {
  const src = `
type OrderState:
  | Draft
  | Paid(amt: Nat)
  | Cancelled

def cancel_order(+s: OrderState) -> OrderState:
  match s:
    case OrderState.Draft => OrderState.Cancelled
    case OrderState.Paid(amt) => OrderState.Paid(amt)
    case OrderState.Cancelled => OrderState.Cancelled

law always_cancelled(for +s: OrderState):
  cancel_order(s) == OrderState.Cancelled

proof always_cancelled:
  refl
`;
  const parsed = parseBendBook(src);
  assert.equal(parsed.errors.length, 0);
  assert.ok(parsed.book);
  const report = checkBook(parsed.book);
  assert.equal(report.buildPassed, false);
  const verdict = report.lawVerdicts[0];
  assert.ok(verdict?.counterexample, 'Expected concrete ADT counterexample');
  assert.ok(
    verdict.counterexample.bindings.s.startsWith('OrderState.Paid('),
    `Expected OrderState.Paid(...) counterexample, got ${verdict.counterexample.bindings.s}`
  );
});

test('on-disk Rust crate, example-app, and setup-rusty-bends.sh match starterKit.ts byte-for-byte', () => {
  const files = generateStarterKitFiles('', '', '');
  for (const file of files) {
    assert.ok(fs.existsSync(file.path), `Expected ${file.path} to exist on disk`);
    const diskContent = fs.readFileSync(file.path, 'utf8');
    const expected = `${file.content.replace(/\n+$/, '')}\n`;
    assert.equal(diskContent, expected, `On-disk ${file.path} drifted from starterKit.ts`);
  }
  assert.ok(fs.existsSync('setup-rusty-bends.sh'), 'Expected setup-rusty-bends.sh on disk');
  assert.equal(
    fs.readFileSync('setup-rusty-bends.sh', 'utf8'),
    buildWorkspaceSetupScript(files),
    'On-disk setup-rusty-bends.sh drifted from starterKit.ts'
  );
  assert.ok(fs.existsSync('Cargo.toml'), 'Expected root workspace Cargo.toml on disk');
});


