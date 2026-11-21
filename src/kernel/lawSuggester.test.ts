import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBook } from './checker';
import {
  RUST_ANALYSIS_PRESETS,
  analyzeRustForLaws,
  suggestLawsForBook,
} from './lawSuggester';
import { parseBendBook } from './parser';

test('suggestLawsForBook discovers right/left zero, commutativity, and associativity for additive binary def', () => {
  const parsed = parseBendBook(`
def deposit(+bal: Nat, +amt: Nat) -> Nat:
  bal + amt
`);
  assert.equal(parsed.errors.length, 0);
  assert.ok(parsed.book);

  const suggestions = suggestLawsForBook(parsed.book);
  const names = suggestions.map((s) => s.name);

  assert.ok(names.includes('deposit_right_zero'));
  assert.ok(names.includes('deposit_left_zero'));
  assert.ok(names.includes('deposit_commutative'));
  assert.ok(names.includes('deposit_associative'));

  // Every proven-ready suggestion must compile and pass checkBook when appended
  for (const s of suggestions.filter((x) => x.status === 'proven-ready')) {
    const combined = parseBendBook(`def deposit(+bal: Nat, +amt: Nat) -> Nat:\n  bal + amt\n\n${s.bendSnippet}`);
    assert.equal(combined.errors.length, 0, `Snippet parse failed for ${s.name}`);
    assert.ok(combined.book);
    const report = checkBook(combined.book);
    assert.equal(report.buildPassed, true, `Suggested law ${s.name} should pass checkBook`);
  }
});

test('suggestLawsForBook deduplicates laws already present in the book', () => {
  const parsed = parseBendBook(`
def deposit(+bal: Nat, +amt: Nat) -> Nat:
  bal + amt

law deposit_zero(for +x: Nat):
  deposit(x, 0n) == x

proof deposit_zero:
  refl
`);
  assert.ok(parsed.book);
  const suggestions = suggestLawsForBook(parsed.book);
  assert.equal(
    suggestions.some((s) => s.name === 'deposit_right_zero'),
    false,
    'Should not suggest duplicate right-zero law already present under another name'
  );
  assert.equal(
    suggestions.some((s) => s.name === 'deposit_commutative'),
    true,
    'Should still suggest missing commutativity law'
  );
});

test('suggestLawsForBook discovers self-cancellation for subtractive defs and identity for polymorphic id', () => {
  const parsed = parseBendBook(`
def id(-T: Type, x: T) -> T:
  (x : T)

def net(+gross: Nat, +fee: Nat) -> Nat:
  gross - fee
`);
  assert.ok(parsed.book);
  const suggestions = suggestLawsForBook(parsed.book);
  const names = suggestions.map((s) => s.name);
  assert.ok(names.includes('id_identity'));
  assert.ok(names.includes('net_right_zero'));
  assert.ok(names.includes('net_self_cancel'));
  // Subtraction is NOT commutative — heuristic must reject net_commutative!
  assert.equal(names.includes('net_commutative'), false);
});

test('suggestLawsForBook discovers cross-function conservation for binary pairs', () => {
  const parsed = parseBendBook(`
def deposit(+bal: Nat, +amt: Nat) -> Nat:
  bal + amt

def total_pair(+a: Nat, +b: Nat) -> Nat:
  a + b
`);
  assert.ok(parsed.book);
  const suggestions = suggestLawsForBook(parsed.book);
  assert.ok(
    suggestions.some((s) => s.category === 'Conservation' && s.status === 'proven-ready')
  );
});

test('analyzeRustForLaws detects unwrap panics, underflow, conservation, authz, and codec pairs across presets', () => {
  for (const preset of RUST_ANALYSIS_PRESETS) {
    const report = analyzeRustForLaws(preset.code);
    assert.ok(report.functionsScanned >= 3, `Preset ${preset.id} should scan >= 3 fns`);
    assert.ok(report.findings.length >= 2, `Preset ${preset.id} should produce >= 2 findings`);

    // Extracted Bend core must parse cleanly and pass BendTT build verification!
    const parsed = parseBendBook(report.extractedBendCore);
    assert.equal(
      parsed.errors.length,
      0,
      `Extracted Bend core from preset ${preset.id} had parse errors: ${JSON.stringify(parsed.errors)}`
    );
    assert.ok(parsed.book);
    const check = checkBook(parsed.book);
    assert.equal(
      check.buildPassed,
      true,
      `Extracted Bend core from preset ${preset.id} failed checkBook: ${JSON.stringify(check.diagnostics)}`
    );
  }
});
