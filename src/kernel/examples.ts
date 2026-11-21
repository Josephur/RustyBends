export interface BendExample {
  id: string;
  title: string;
  summary: string;
  expectedOutcome: 'pass' | 'fail';
  source: string;
}

export const BEND_EXAMPLES: BendExample[] = [
  {
    id: 'ledger_verified',
    title: 'Ledger Balance Conservation',
    summary: 'Verified financial core: deposit & split preserve total value, emitting zero-dependency Rust.',
    expectedOutcome: 'pass',
    source: `# Verified Core: pure ledger math checked at build time
# +bal and +amt are Data (q=2): duplicable, pure u64 values

def deposit(+bal: Nat, +amt: Nat) -> Nat:
  bal + amt

def total_pair(+a: Nat, +b: Nat) -> Nat:
  a + b

law deposit_zero(for +bal: Nat):
  deposit(bal, 0n) == bal

proof deposit_zero:
  refl

law deposit_commutes(for +a: Nat, for +b: Nat):
  deposit(a, b) == deposit(b, a)

proof deposit_commutes:
  refl

law total_after_deposit(for +a: Nat, for +b: Nat, for +amt: Nat):
  total_pair(deposit(a, amt), b) == total_pair(a, deposit(b, amt))

proof total_after_deposit:
  refl
`,
  },
  {
    id: 'id_erased',
    title: 'Identity & Dead Erasure',
    summary: 'Polymorphic identity with q=0 type parameter (-T), erased annotation, and proven law.',
    expectedOutcome: 'pass',
    source: `# Polymorphic identity in BendTT
# -T is Dead (q=0): checked, then erased before Rust codegen
# x is Live (q=1): affine value used at most once

def id(-T: Type, x: T) -> T:
  (x : T)

def double(+n: Nat) -> Nat:
  n + n

law id_left(for +x: Nat):
  id(Nat, x) == x

proof id_left:
  refl

law double_three:
  double(3n) == 6n

proof double_three:
  refl
`,
  },
  {
    id: 'false_law_ce',
    title: 'False Law Counterexample',
    summary: 'Buggy fee calculation caught instantly by the counterexample finder before wasting proof loops.',
    expectedOutcome: 'fail',
    source: `# Suppose an AI accidentally adds a +1n bug inside net_amount.
# Counterexample search immediately finds a concrete failing input!

def net_amount(+gross: Nat, +fee: Nat) -> Nat:
  (gross - fee) + 1n

law zero_fee_unchanged(for +gross: Nat):
  net_amount(gross, 0n) == gross

proof zero_fee_unchanged:
  refl
`,
  },
  {
    id: 'unproven_law',
    title: 'Unproven Law Build Gate',
    summary: 'Valid definitions, but a law lacks a proof — RustyBends blocks Rust codegen until proven.',
    expectedOutcome: 'fail',
    source: `# RustyBends invariant: "If it compiles, the laws hold."
# A law without an accepted proof fails the build and blocks Rust codegen.

def inc(+n: Nat) -> Nat:
  n + 1n

law inc_two:
  inc(2n) == 3n

# Use "Add refl Proof" in Laws & Lock (or uncomment below) to pass:
# proof inc_two:
#   refl
`,
  },
  {
    id: 'affine_dup_err',
    title: 'Affine Duplication Error',
    summary: 'Uses a Live (q=1) affine parameter twice — rejected with a fix hint to mark +x as Data.',
    expectedOutcome: 'fail',
    source: `# Live (q=1) parameters are affine: they may be used at most once.
# Using 'x' twice violates BendTT's affine discipline.

def bad_dup(x: Nat) -> Nat:
  (x, x)
`,
  },
  {
    id: 'order_state_machine',
    title: 'Order State Machine (ADT + Case Proof)',
    summary: 'Algebraic Data Type (enum), pattern matching, and exhaustive structural case-split proofs emitting pure Rust.',
    expectedOutcome: 'pass',
    source: `# v1 Verified Core: Algebraic Data Type (enum) + exhaustive case-split proofs
type OrderState:
  Draft
  Paid(amount: Nat)
  Shipped(amount: Nat)
  Cancelled

def cancel_order(+s: OrderState) -> OrderState:
  match s:
    case OrderState.Draft => OrderState.Cancelled
    case OrderState.Paid(amt) => OrderState.Cancelled
    case OrderState.Shipped(amt) => OrderState.Shipped(amt)
    case OrderState.Cancelled => OrderState.Cancelled

def is_shipped(+s: OrderState) -> Bool:
  match s:
    case OrderState.Shipped(amt) => true
    case _ => false

law cancel_idempotent(for +s: OrderState):
  cancel_order(cancel_order(s)) == cancel_order(s)

proof cancel_idempotent:
  match s:
    case OrderState.Draft => refl
    case OrderState.Paid(amt) => refl
    case OrderState.Shipped(amt) => refl
    case OrderState.Cancelled => refl

law shipped_cannot_be_cancelled(for +amt: Nat):
  is_shipped(cancel_order(OrderState.Shipped(amt))) == true

proof shipped_cannot_be_cancelled:
  refl
`,
  },
  {
    id: 'lemma_rewrite_chain',
    title: 'Lemma Rewrite & RBAC (Bool + Rewrite)',
    summary: 'Demonstrates boolean logic, if/else, and chaining a proven lemma via `rewrite` inside a downstream proof.',
    expectedOutcome: 'pass',
    source: `# v1 Verified Core: Boolean RBAC guard + lemma reuse via rewrite
def can_write(+is_admin: Bool, +is_revoked: Bool) -> Bool:
  if is_revoked: false else: is_admin

def add_fee(+bal: Nat, +fee: Nat) -> Nat:
  bal + fee

law revoked_never_writes(for +is_admin: Bool):
  can_write(is_admin, true) == false

proof revoked_never_writes:
  refl

law add_fee_zero(for +bal: Nat):
  add_fee(bal, 0n) == bal

proof add_fee_zero:
  refl

law double_zero_fee_unchanged(for +bal: Nat):
  add_fee(add_fee(bal, 0n), 0n) == bal

proof double_zero_fee_unchanged:
  rewrite add_fee_zero;
  rewrite add_fee_zero;
  refl
`,
  },
  {
    id: 'dead_leak_err',
    title: 'Dead-to-Live Leak Error',
    summary: 'Attempts to return a Dead (q=0) erased parameter from a Live (q=1) function body.',
    expectedOutcome: 'fail',
    source: `# Dead (q=0) bindings are erased before runtime.
# Returning '-T' in a live body is a compile-time error.

def leak_dead(-T: Type, x: T) -> Type:
  T
`,
  },
];
