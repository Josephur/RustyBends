export interface KitFile {
  path: string;
  language: 'rust' | 'toml' | 'bend' | 'markdown';
  summary: string;
  content: string;
}

export interface ErrorRecoveryEntry {
  code: string;
  cause: string;
  badExample: string;
  fixedExample: string;
  rule: string;
}

export const ERROR_RECOVERY_TABLE: ErrorRecoveryEntry[] = [
  {
    code: 'E_AFFINE_DUP',
    cause: 'A Live (q=1) parameter was used more than once.',
    badExample: 'def dup(x: Nat) -> Nat:\n  (x, x)',
    fixedExample: 'def dup(+x: Nat) -> Nat:\n  (x, x)',
    rule: 'Mark pure duplicable data parameters with + (+x: Nat) so they run at Data (q=2).',
  },
  {
    code: 'E_DEAD_LEAK',
    cause: 'A Dead (q=0) erased type/proof parameter appeared in a live runtime body.',
    badExample: 'def bad(-T: Type, x: T) -> Type:\n  T',
    fixedExample: 'def id(-T: Type, x: T) -> T:\n  (x : T)',
    rule: 'Use -T parameters only in type signatures and annotations; they are erased before Rust codegen.',
  },
  {
    code: 'E_DATA_LAM',
    cause: 'A lambda or live closure was placed inside a Data (q=2) value.',
    badExample: 'def bad() -> Data:\n  @1 x => x',
    fixedExample: 'def good(+n: Nat) -> Nat:\n  n + 1n',
    rule: 'Data (q=2) values must be pure data (Nat, Bool, ADTs, tuples) with no lambdas or live calls.',
  },
  {
    code: 'E_LAW_FALSE',
    cause: 'Counterexample search found concrete Nat/Bool/ADT inputs where LHS != RHS.',
    badExample: 'def net(+g: Nat, +f: Nat) -> Nat: (g - f) + 1n\nlaw z(for +g: Nat): net(g, 0n) == g',
    fixedExample: 'def net(+g: Nat, +f: Nat) -> Nat: g - f\nlaw z(for +g: Nat): net(g, 0n) == g\nproof z: refl',
    rule: 'Do not waste turns searching for a proof when E_LAW_FALSE fires — fix the implementation bug.',
  },
  {
    code: 'E_PROOF_INCOMPLETE_CASE',
    cause: 'A structural case-split proof (match) omitted one or more ADT/Bool constructors.',
    badExample: 'proof p:\n  match s:\n    case OrderState.Draft => refl',
    fixedExample: 'proof p:\n  match s:\n    case OrderState.Draft => refl\n    case OrderState.Paid(a) => refl\n    case OrderState.Shipped(a) => refl\n    case OrderState.Cancelled => refl',
    rule: 'Every constructor of an ADT (or both true/false for Bool) must be proven in a match proof.',
  },
  {
    code: 'E_BARE_OPERATOR',
    cause: 'Bend 2 (>2.0.16) requires explicit type annotations around arithmetic/comparison operators.',
    badExample: 'def add_u32(a: U32, b: U32) -> U32:\n  a + b',
    fixedExample: 'def add_u32(a: U32, b: U32) -> U32:\n  (a + b : U32)',
    rule: 'Always wrap operators with a type annotation: (a + b : U32), (a * b : U32), or use Nat.add(a, b) for Peano Nat.',
  },
  {
    code: 'E_LAW_SYNTAX',
    cause: 'Real Bend 2 declares laws with `law name: for x: T {lhs == rhs : T}` and proves them with a matching `def name(x):` using `{==}`.',
    badExample: 'law add_zero(for +x: Nat):\n  Nat.add(x, 0n) == x\nproof add_zero:\n  refl',
    fixedExample: 'law add_zero:\n  for x: Nat\n  {Nat.add(x, 0n) == x : Nat}\n\ndef add_zero(x):\n  match x:\n    case 0n: {==}\n    case 1n+p:\n      %add_zero(p) : {1n+Nat.add(p, 0n) == 1n+_ : Nat}\n      {==}',
    rule: 'In real Bend 2, a theorem is `law name: for ... {lhs == rhs : Type}` and its proof is `def name(...):` with `{==}` and `%lemma(args) : {goal}`.',
  },
  {
    code: 'E_LAW_LOCK_TAMPERED',
    cause: 'A locked law statement in verified/ was edited or deleted.',
    badExample: '# Weakening or deleting a locked law to make cargo build pass',
    fixedExample: '# Keep law statements intact and fix the implementation/proof instead',
    rule: 'AI agents must never weaken or delete locked laws. Only humans update locks with RUSTY_BENDS_UPDATE_LAWS=1.',
  },
  {
    code: 'E_LAW_VACUOUS',
    cause: 'A new unlocked law caught 0 broken mutants of the functions it depends on (vacuous or tautological).',
    badExample: 'law empty_check:\n  for +x: Nat\n  {f(x) == f(x) : Nat}',
    fixedExample: 'law alloc_conserves_capacity:\n  for +alloc: Nat\n  for +free: Nat\n  for +req: Nat\n  {pool_cap(pool_alloc(Pool{alloc, free}, req)) == Nat.add(alloc, free) : Nat}',
    rule: 'Strengthen or rewrite the law so concrete evaluation fails when its target function is mutated.',
  },
  {
    code: 'E_LAW_NO_PROMISE',
    cause: 'A new unlocked law is missing a plain-English `# promise:` comment directly above `law <name>:`.',
    badExample: 'law deposit_zero:\n  for bal: Nat\n  {deposit(bal, 0n) == bal : Nat}',
    fixedExample: '# promise: depositing zero leaves any existing balance unchanged\n# harm: zero-value deposits could corrupt account balances\nlaw deposit_zero:\n  for bal: Nat\n  {deposit(bal, 0n) == bal : Nat}',
    rule: 'Add a one-sentence `# promise:` line directly above every new law (and optionally `# harm:`) so reviewers can read guarantees in plain English.',
  },
];

export const BEND_GUIDE_MD = `# BEND_GUIDE.md — AI Coding Guide for Rust + RustyBends v1 (Real Bend 2 Syntax)

You are working in a Rust project protected by **RustyBends v1** (compile-time Bend 2 proofs).
Nothing from Bend 2 ships in the final runtime binary: all proofs and \`q=0\` types are checked
during \`cargo build\` / \`cargo check\` via \`bend <file> --check-only\` and \`bend <file> --verdict\`,
proof \`def\`s are erased, and only pure verified Rust (\`pub enum\` ADTs, \`match\`, and functions)
is emitted into \`OUT_DIR/verified.rs\`.

## 1. Architecture Rule: "Verified Core, Rust Shell"

- **Put pure invariants, ADTs, state machines & math in \`verified/*.bend\`**:
  balance/accounting math, order/workflow state machines (\`type ... is Data:\` + \`match\`), permission checks (\`Bool\`), bounds.
- **Put all I/O in \`src/*.rs\`**:
  HTTP servers, SQL/databases, async tasks, CLI, filesystem, networking.
- **Minimize unit test bloat**:
  Do NOT write dozens of repetitive unit tests for pure logic already proven in \`verified/\`.
  Write thin Rust integration tests for I/O boundaries only.

## 2. Bend 2 / BendTT Quantities (Required Knowledge)

| Prefix | Quantity | Meaning | Rule |
| :--- | :--- | :--- | :--- |
| \`-T: Type\` | **Dead (\`q=0\`)** | Types, motives, proofs | Checked at compile time, **erased before codegen**. Never return in a live body. |
| \`x: T\` | **Live (\`q=1\`)** | Affine runtime value | Used **at most once**. |
| \`+n: U32\` / \`type T is Data:\` | **Data (\`q=2\`)** | Duplicable pure data | May be copied/used multiple times. **No lambdas or live calls inside.** |

## 3. Real Bend 2 Syntax Cheat Sheet (Matches \`bendlang/bend\` 2.0.17+)

\`\`\`bend
import Base

# 1. Algebraic Data Types use 'is Data:' and curly braces '{}' for constructors/fields
type OrderState is Data:
  Draft{}
  Paid{amount: Nat}
  Shipped{amount: Nat}
  Cancelled{}

# 2. Operators MUST be type-annotated in Bend 2.0.17+: write (a + b : U32), NEVER bare a + b!
#    For Peano Nat math, use Nat.add(bal, amt) / Nat.sub(bal, amt).
def deposit(bal: Nat, amt: Nat) -> Nat:
  Nat.add(bal, amt)

# 3. Pattern matching: match on a variable (never a computed expression); cases use ':' and '{}'
#    Note: Bend 2 has no 'if/else' keyword — match on Bool's True{} / False{} constructors instead.
def cancel_order(s: OrderState) -> OrderState:
  match s:
    case Draft{}:
      Cancelled{}
    case Paid{amt}:
      Cancelled{}
    case Shipped{amt}:
      Shipped{amt}
    case Cancelled{}:
      Cancelled{}

# 4. LAWS & PROOFS:
#    - Promise  = '# promise: <one-sentence English statement>' directly above every law (required for new laws; '# harm:' optional)
#    - Theorem  = 'law <name>: for <var>: <Type> {<lhs> == <rhs> : <Type>}'
#    - Proof    = 'def <name>(<var>):' with the SAME name (erased automatically by rusty-bends-build!)
#    - Refl     = '{==}'
#    - Rewrite  = '%<lemma>(<args>) : {<goal_with_underscore>}'
# promise: depositing zero leaves any existing balance unchanged
# harm: zero-value deposits could corrupt account balances
law deposit_zero:
  for bal: Nat
  {deposit(bal, 0n) == bal : Nat}

def deposit_zero(bal):
  match bal:
    case 0n:
      {==}
    case 1n+p:
      %deposit_zero(p) : {1n+Nat.add(p, 0n) == 1n+_ : Nat}
      {==}

# promise: cancelling an order twice produces the same state as cancelling it once
law cancel_idempotent:
  for s: OrderState
  {cancel_order(cancel_order(s)) == cancel_order(s) : OrderState}

def cancel_idempotent(s):
  match s:
    case Draft{}: {==}
    case Paid{amt}: {==}
    case Shipped{amt}: {==}
    case Cancelled{}: {==}
\`\`\`

## 4. Supported Bend 2.0.40 \`Base\` Helpers & Exact Rust Semantics

\`rusty-bends-build/src/emit.rs\` lowers Bend 2 \`Base\` stdlib calls directly to zero-overhead Rust:

- **\`Nat\` arithmetic (checked \`u64\` on growth, saturating subtraction, total division):**
  - \`Nat.add\`, \`Nat.mul\`, \`Nat.succ\` -> \`checked_add\` / \`checked_mul\` (panics with \`"rusty-bends: Nat overflow"\` on \`u64\` overflow, so emitted Rust agrees with mathematical \`Nat\` wherever it returns and never silently saturates past \`u64::MAX\` into a law-violating state).
  - **List the panic sites:** \`RUSTY_BENDS_LIST_PANICS=1 cargo check\` prints every checked-growth op as \`RustyBends panic [function]: Nat.mul at verified/file.bend:12\`, so you can review which functions take untrusted input.
  - **Refuse instead of panicking (\`# rusty-bends: total\`):** put \`# rusty-bends: total\` in the comment block directly above a \`def\` and it emits as \`Option<T>\`, returning \`None\` on overflow anywhere in its call tree (callees get private \`Option\` variants; their public versions are unchanged). Callers in other \`def\`s keep panicking semantics (listed as \`call <f>\`). Its generated per-law tests still run.
  - **Write limit checks that cannot overflow.** Compare against a quotient instead of building a product from untrusted input:
    \`\`\`bend
    # Panics (checked_mul) when w * h overflows u64:
    def fits_area_limit(+w: Nat, +h: Nat, max_area: Nat) -> Bool:
      Bool.and(Bool.and(Nat.is_gt(w, 0n), Nat.is_gt(h, 0n)), Nat.is_le(Nat.mul(w, h), max_area))

    # Never overflows: w > 0, so w * h <= max  <=>  h <= max / w
    def fits_area_limit(+w: Nat, +h: Nat, max_area: Nat) -> Bool:
      Bool.and(Bool.and(Nat.is_gt(w, 0n), Nat.is_gt(h, 0n)), Nat.is_le(h, Nat.div(max_area, w)))
    \`\`\`
  - \`Nat.sub\`, \`Nat.pred\` -> \`saturating_sub\` (exact match for Peano \`0n - x == 0n\`).
  - \`Nat.div(a, b)\` / \`Nat.mod(a, b)\` / \`Nat.divmod(a, b)\` -> total div/mod matching Bend 2 (\`Nat.div(a, 0n) == 0n\`, \`Nat.mod(a, 0n) == a\`)
  - \`Nat.min\`, \`Nat.max\`, \`Nat.is_zero\`
  - \`Nat.is_le\`, \`Nat.is_lt\`, \`Nat.is_ge\`, \`Nat.is_gt\`, \`Nat.is_eq\`, \`Nat.is_ne\`
- **\`Bool\` & \`Pair\` helpers:**
  - \`Bool.and\`, \`Bool.or\`, \`Bool.not\`, \`Bool.xor\`, \`Bool.is_eq\`, \`Bool.is_ne\`, \`Bool.pick\`
  - \`A & B\` pair types -> \`(A, B)\`, \`Pair.fst\`, \`Pair.snd\`
- **Fixed-width integers vs \`Nat\`:**
  - \`(a + b : Nat)\` / \`(a * b : Nat)\` emit **checked** \`u64\` ops (panicking on \`u64\` overflow), while \`(a - b : Nat)\` emits \`saturating_sub\`.
  - \`(a + b : U32)\` / \`U64\` / \`I32\` / \`I64\` emit **wrapping** ops (\`wrapping_add\`, \`wrapping_sub\`, \`wrapping_mul\`) matching Bend 2's fixed-width integer semantics.
- **Control flow & patterns:** nested \`match\`, multi-scrutinee \`match a b:\`, \`case 1n+p:\` and nested \`case 1n+1n+q:\` successor patterns, and multi-line \`let\` bindings are all supported.
- **Recursive ADTs & built-in \`List\`:** direct or mutually recursive \`type\` definitions automatically box cycle-forming fields (\`Box<T>\`), omit \`Copy\` (\`#[derive(Debug, Clone, PartialEq, Eq)]\`) across recursive types and any wrappers containing them, unbox patterns (\`*__rb_box\` + nested guards), and insert \`.clone()\` on multi-use non-\`Copy\` values. Built-in \`Base\` \`List<T>\` / \`List<&2, T>\`, \`Nil{}\` / \`Con{head, tail}\`, and list literals \`[]\` / \`[a, b]\` emit \`pub enum List<T> { Nil, Con(T, Box<List<T>>) }\`.
- **Cross-file sibling imports (\`import sibling.bend as X\`):** files under \`verified/\` can import sibling \`.bend\` files (\`import base_rules.bend as B\`) to share functions, types, laws, and helper lemmas (\`B.fn_name(...)\`, \`B.TypeName\`, \`B.Ctor{}\`). Keep top-level names unique across \`verified/*.bend\`; the emitter resolves each file's import aliases into the single emitted \`verified.rs\` module, and \`rusty-bends.lock\` normalizes aliases so renaming \`as B\` does not trip \`E_LAW_LOCK_TAMPERED\`.
- **Bundled \`Nat\` arithmetic lemma library (\`nat_lemmas.bend\`):** \`rusty-bends-build\` ships \`rusty_bends_build::lemmas/nat_lemmas.bend\` via \`rusty_bends_build::NAT_LEMMAS_BEND\` and \`rusty_bends_build::write_nat_lemmas("verified")\` (called in \`build.rs\` before \`verify_and_emit("verified")\`, or copied into \`verified/\`). Import it with \`import nat_lemmas.bend as L\`. All definitions in \`nat_lemmas.bend\` are \`q=0\` proof/type helpers and are erased completely before Rust codegen, covering:
  - **Ex falso / Bool refutation:** \`bool_pick_type\`, \`bool_false_ne_true\`, \`bool_true_ne_false\`, \`bool_absurd\`, \`bool_absurd_tf\`.
  - **Order & min/max:** \`nat_le_refl\`, \`nat_le_zero\`, \`nat_le_succ_r\`, \`nat_lt_succ_self\`, \`nat_lt_succ_eq_le\`, \`nat_lt_imp_le\`, \`nat_not_lt_imp_le\`, \`nat_le_subst_r\`, \`nat_lt_subst_r\`, \`nat_lt_subst_l\`, \`nat_le_trans\`, \`nat_lt_trans\`, \`nat_lt_le_trans\`, \`nat_le_lt_trans\`, \`nat_lt_not_le\`, \`nat_lt_le_false\`, \`nat_le_lt_false\`, \`nat_le_antisym\`, \`nat_le_add_add\`, \`nat_add_not_lt_l\`, \`nat_min_le_l\`, \`nat_min_le_r\`, \`nat_max_ge_l\`, \`nat_max_ge_r\`, \`nat_min_comm\`, \`nat_max_comm\`.
  - **Addition & subtraction:** \`nat_add_zero_r\`, \`nat_add_succ_r\`, \`nat_add_comm\`, \`nat_add_assoc\`, \`nat_add_le_l\`, \`nat_add_le_r\`, \`nat_add_lt_l\`, \`nat_add_le_mono\`, \`nat_add_lt_le_mono\`, \`nat_sub_zero_r\`, \`nat_sub_self\`, \`nat_add_sub_cancel_l\`, \`nat_add_sub_cancel_r\`, \`nat_add_cancel_l\`, \`nat_sub_add_cancel\`, \`nat_sub_lt\`.
  - **Multiplication:** \`nat_mul_zero_r\`, \`nat_mul_one_r\`, \`nat_mul_succ_r\`, \`nat_mul_comm\`, \`nat_mul_add_dist_r\`, \`nat_mul_add_dist_l\`, \`nat_mul_assoc\`, \`nat_mul_le_mono_r\`, \`nat_mul_le_mono_l\`, \`nat_mul_le_mono\`.
  - **Division, modulo & alignment (\`b = 1n+bp > 0\`):** \`nat_mod_lt(a, bp)\` (\`a % (1n+bp) < 1n+bp\`), \`nat_div_mod(a, bp)\` (\`a % (1n+bp) + (a / (1n+bp)) * (1n+bp) == a\`), \`nat_div_mod_r(a, bp)\` (\`(a / (1n+bp)) * (1n+bp) + a % (1n+bp) == a\`), \`nat_div_lt_of_lt_mul(a, n, bp, h)\` (\`a < n * (1n+bp) -> a / (1n+bp) < n\`), \`nat_div_lt_of_lt_mul_l(a, n, bp, h)\` (\`a < (1n+bp) * n -> a / (1n+bp) < n\`), \`nat_split_unique_q(q1, r1, q2, r2, bp, h1, h2, e)\` (\`q1 * b + r1 == q2 * b + r2\` with \`r1, r2 < b\` gives \`q1 == q2\`), \`nat_split_unique_r(q1, r1, q2, r2, bp, h1, h2, e)\` (\`r1 == r2\`), \`nat_div_split(q, r, bp, h)\` (\`(q * b + r) / b == q\`), \`nat_mod_split(q, r, bp, h)\` (\`(q * b + r) % b == r\`), \`nat_div_small(a, bp, h)\` (\`a < b -> a / b == 0\`), \`nat_mod_small(a, bp, h)\` (\`a < b -> a % b == a\`), \`nat_eq_of_div_mod(a, c, bp, hq, hr)\` (equal quotient and remainder give \`a == c\`), \`nat_split_lt(q, r, n, bp, hq, hr)\` (\`q < n, r < b -> q * b + r < n * b\`), \`nat_mod_mul(q, bp)\` (\`(q * b) % b == 0\`), \`nat_div_mul(q, bp)\` (\`(q * b) / b == q\`), and \`nat_align_down_le(a, bp)\` (\`(a / b) * b <= a\`).
- **Generated per-law Rust tests:** every \`law\` also emits a \`#[cfg(test)]\` Rust test into \`OUT_DIR/verified.rs\` (run automatically by \`cargo test\`) that checks the emitted functions across small values, \`u64::MAX - 1\`, \`u64::MAX\`, ADT constructors, and deterministic PRNG samples (skipping only checked \`Nat\` overflow panics).
- **Counterexample vs proof-failure diagnosis:** when \`bend --check-only\` fails on a law, \`rusty-bends-build\` evaluates the emitted Rust on concrete inputs first and reports \`[E_LAW_FALSE]\` with aligned \`lhs\`/\`rhs\` values if the law is false, or notes \`"no counterexample up to ...: the law may be true; the proof is what failed"\` if no counterexample exists.
- **Mutation checking before sealing (\`E_LAW_VACUOUS\`):** every unlocked/new law is checked against small mutants of the live functions in its dependency cone (\`True{}\`/\`False{}\` swap, \`Nat.is_le\`/\`Nat.is_lt\` swap, \`Nat.add\`/\`Nat.sub\` swap, \`Bool.and\`/\`Bool.or\` operand drop, returning a constructor argument unchanged, swapping match arms) and fails with \`[E_LAW_VACUOUS]\` if it catches none. Bound and safety laws are covered too: \`NatBound\` pushes a \`Nat\` result past a bound (\`+ 1n\`, \`- 1n\`, \`0n\`), \`SiblingCtor\` replaces a returned constructor with its sibling constructors, \`BoolConst\` replaces a \`Bool\` variable with \`True{}\` / \`False{}\`, and \`FlipCmp\` loosens comparisons (\`Nat.is_le\` <-> \`Nat.is_ge\`, \`Nat.is_lt\` <-> \`Nat.is_gt\`). \`ReturnCtor\` replaces a returned variable or function call (e.g. a fallthrough \`case st _: st\`) with each constructor of the return type, \`NatLit\` changes \`Nat\` literals (\`k\` -> \`0n\`, \`k + 1\`, \`k - 1\`, at most 8 sites per function), and \`NatAddMaxMin\` swaps \`Nat.add\` (or \`(a + b : Nat)\`) with \`Nat.max\` / \`Nat.min\` and vice versa. Each reported mutant ends with its operator, e.g. \`caught by f: result -> Nat.add(result, 1n) [NatBound]\`. Run \`RUSTY_BENDS_MUTATE=all cargo check\` to report one summary line for every law (new and locked) without failing on locked laws, or \`RUSTY_BENDS_MUTATE=report cargo check\` to evaluate every generated mutant of every law, print per-mutant \`caught\`/\`survived\` lines (noting any budget/site-cap drops), and write the report to \`OUT_DIR/rusty-bends-mutants.txt\`.
- **Unevaluable new laws (\`E_LAW_UNCHECKED\`):** a new law the checker cannot evaluate (\`exs\`, a \`where\` refinement, an unparsable clause, or a goal without \`==\`) fails the build, naming the reason and the supported forms. If it truly cannot be sampled, add \`# unchecked: <why>\` in the comment block directly above \`law <name>:\`; the marker is stored in \`rusty-bends.lock\` and shown as \`[unchecked: <why>]\` by the law listing. Locked laws only warn.
- **Mutants that do not compile (\`E_MUTANT_BUILD\`):** a mutant the generated Rust cannot build was never tested, so it never counts as a survivor. The build stops with \`[E_MUTANT_BUILD]\`, naming the mutant and the first rustc error; that is a RustyBends bug to report, not a weak law.
- **Names that are Rust keywords:** any Bend name may be used, including ones Rust reserves (\`as\`, \`in\`, \`fn\`, \`ref\`, \`mut\`, \`dyn\`, \`loop\`, \`move\`, \`self\`, \`crate\`, \`super\`, ...). The emitted Rust spells them \`r#as\`, \`r#in\`, ... and, where Rust allows no raw form, \`__rb_self\`, \`__rb_crate\`, \`__rb_super\`, \`__rb_Self\`. Call them from Rust by those names, e.g. \`verified::r#loop(2, 3)\`.

## 5. Mandatory Rules for AI Agents

1. **Always type-annotate operators (Bend 2.0.17+).** Write \`(a + b : U32)\` (wrapping) or \`Nat.add(a, b)\` / \`(a + b : Nat)\` (checked \`Nat\` add) — never bare \`a + b\`.
2. **Use real Bend 2 \`law\` + proof \`def\` syntax.** Never invent \`proof foo: refl\`; write \`law foo: for x: T {lhs == rhs : T}\` paired with \`def foo(x): ... {==}\`. Helper lemmas returning \`{lhs == rhs : T}\` are also erased automatically.
3. **Run \`cargo check\` after every edit.** Cargo runs \`build.rs\` -> \`rusty_bends_build::verify_and_emit("verified")\`.
4. **NEVER delete, comment out, or weaken laws in \`verified/\`.**
   \`rusty-bends.lock\` uses an AST/token canonicalizer (safe across whitespace/comment edits, strict on law changes) and fails with \`E_LAW_LOCK_TAMPERED\`. Use \`RUSTY_BENDS_UPDATE_LAWS=<name>[,<name>...]\` to seal specific reviewed laws, \`=comments\` to refresh comment lines alone without sealing, or \`=1\` to rewrite the whole lock; every lock write prints what was sealed, re-accepted, removed, or reworded.
5. **Every new law MUST have a plain-English \`# promise:\` comment directly above \`law <name>:\`** (\`# harm:\` is optional). Missing promises on new laws fail with \`E_LAW_NO_PROMISE\` (locked laws warn if missing). Promises are stored in \`rusty-bends.lock\` outside the law hash, so improving \`# promise:\` wording is reported in build output without tripping \`E_LAW_LOCK_TAMPERED\`. Run \`RUSTY_BENDS_LIST_LAWS=1 cargo check\` or \`cargo run -p rusty-bends-build --bin rusty-bends-laws -- verified\` to print every law as \`name: promise\`, and \`RUSTY_BENDS_LIST_COVERAGE=1 cargo check\` (or \`rusty-bends-laws --coverage verified\`) to check which emitted functions no law reaches and which laws name only functions never called by Rust sources.
6. **Lean \`--verdict\` kernel cross-check**: \`rusty-bends-build\` always runs \`bend <file> --check-only\` (which checks all laws and proofs). By default (\`BEND_VERDICT=auto\`), it also runs \`--verdict\` whenever Lean (\`~/.elan/bin/lean\`) or \`$BENDTT\` is installed, and skips \`--verdict\` with a warning otherwise. Set \`BEND_VERDICT=require\` in CI to enforce Lean cross-checking, or \`BEND_VERDICT=off\` to disable it. The incremental build cache records the \`rusty-bends-build\` source hash, verdict status (\`ran\`/\`skipped\`/\`off\`), CLI flags, and Bend binary/version, so updating \`rusty-bends-build\` or switching from \`off\` or \`skipped\` to \`require\` re-runs verification; set \`RUSTY_BENDS_NO_CACHE=1\` to bypass the cache unconditionally.
7. **Pin Bend 2 if upstream drifts**: uncomment the version prefix (e.g. \`2.0.\`) in \`bend.pin\` or set \`BEND_PIN_VERSION\`.
`;

export function generateStarterKitFiles(
  _currentBendSource: string,
  _generatedRustSource: string,
  _lawLockFingerprint: string
): KitFile[] {
  const buildCrateCargo = `[package]
name = "rusty-bends-build"
version = "1.0.0"
edition = "2021"
description = "Build-time Bend 2 proof gate (--check-only / --verdict), token-canonical LAWS lock, bend.pin check, and pure Rust ADT/match OUT_DIR emitter"
license = "Apache-2.0"

[dependencies]
# Zero external dependencies — Rust stdlib only!
`;

  const buildCrateBuildRs = `//! Build script for \`rusty-bends-build\`.
//!
//! Computes a deterministic compile-time hash of this crate's own manifest,
//! build script, \`src/\`, and \`lemmas/\` sources and exposes it via
//! \`RUSTY_BENDS_BUILD_HASH\`. Downstream build caches include this hash so
//! updating or patching \`rusty-bends-build\` automatically invalidates cached
//! \`OUT_DIR/verified.rs\` and mutation results without needing \`cargo clean\`.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const FNV_OFFSET_BASIS_128: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;
const FNV_PRIME_128: u128 = 0x0000_0000_0100_0000_0000_0000_0000_013b;

fn fnv1a_update(hash: &mut u128, bytes: &[u8]) {
    for &b in bytes {
        *hash ^= u128::from(b);
        *hash = hash.wrapping_mul(FNV_PRIME_128);
    }
}

fn collect_tree(root: &Path, rel: &Path, dirs: &mut Vec<String>, files: &mut Vec<String>) {
    let full = root.join(rel);
    if !full.is_dir() {
        return;
    }
    dirs.push(rel.to_string_lossy().replace('\\\\', "/"));
    let mut entries: Vec<PathBuf> = fs::read_dir(&full)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", full.display()))
        .map(|entry| {
            entry
                .unwrap_or_else(|e| panic!("failed to read dir entry in {}: {e}", full.display()))
                .path()
        })
        .collect();
    entries.sort();
    for path in entries {
        let Some(name) = path.file_name() else {
            continue;
        };
        let child_rel = rel.join(name);
        if path.is_dir() {
            collect_tree(root, &child_rel, dirs, files);
        } else if path.is_file() {
            files.push(child_rel.to_string_lossy().replace('\\\\', "/"));
        }
    }
}

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"));

    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for top in ["Cargo.toml", "build.rs"] {
        if manifest_dir.join(top).is_file() {
            files.push(top.to_string());
        }
    }
    for tree in ["src", "lemmas"] {
        collect_tree(&manifest_dir, Path::new(tree), &mut dirs, &mut files);
    }

    dirs.sort();
    dirs.dedup();
    files.sort();
    files.dedup();

    for dir in &dirs {
        println!(
            "cargo:rerun-if-changed={}",
            manifest_dir.join(dir).display()
        );
    }
    for file in &files {
        println!(
            "cargo:rerun-if-changed={}",
            manifest_dir.join(file).display()
        );
    }

    let mut hash = FNV_OFFSET_BASIS_128;
    fnv1a_update(&mut hash, b"rb-builder-v1\\0");
    for file in &files {
        let full = manifest_dir.join(file);
        let bytes =
            fs::read(&full).unwrap_or_else(|e| panic!("failed to read {}: {e}", full.display()));
        fnv1a_update(&mut hash, file.as_bytes());
        fnv1a_update(&mut hash, b"\\0");
        fnv1a_update(&mut hash, &(bytes.len() as u64).to_le_bytes());
        fnv1a_update(&mut hash, &bytes);
        fnv1a_update(&mut hash, b"\\0");
    }

    println!("cargo:rustc-env=RUSTY_BENDS_BUILD_HASH={hash:032x}");
}
`;

  const buildCrateLock = `//! AST/token-aware anti-cheat law lock for RustyBends v1.
//!
//! Unlike naive line scanners, this module strips comments (# and --), tokenizes the full
//! multi-line \`law ...\` declaration up to the next top-level item (\`type\`, \`def\`, \`law\`, \`proof\`),
//! and hashes the canonical token stream.
//!
//! Guarantees:
//! - Reformatting whitespace or adding comments inside a law NEVER triggers false lock failures.
//! - Editing any quantifier, operator, or expression inside a multi-line law trips E_LAW_LOCK_TAMPERED.
//! - Deleting a locked law trips E_LAW_LOCK_TAMPERED.
//! - Adding a brand-new law is allowed without unlocking.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalLaw {
    pub name: String,
    pub canonical_sig: String,
    pub hash: String,
    pub promise: Option<String>,
    pub harm: Option<String>,
    /// \`# unchecked: <reason>\` marker: the author accepts that the mutation checker cannot
    /// evaluate this law (Issue #14). Stored in the lock next to the promise for reviewers.
    pub unchecked: Option<String>,
}

/// Plain-English doc fields read from the comment block directly above a \`law\`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LawDocs {
    pub promise: Option<String>,
    pub harm: Option<String>,
    pub unchecked: Option<String>,
}

/// Extracts all \`law\` blocks across the provided \`.bend\` files in canonical token form.
pub fn extract_canonical_laws(files: &[PathBuf]) -> Result<BTreeMap<String, CanonicalLaw>, String> {
    let mut map = BTreeMap::new();
    for file in files {
        let content = fs::read_to_string(file).map_err(|e| e.to_string())?;
        for law in extract_laws_from_source(&content) {
            map.insert(law.name.clone(), law);
        }
    }
    Ok(map)
}

fn normalize_alias_token<'a>(tok: &'a str, aliases: &BTreeSet<String>) -> &'a str {
    if !aliases.is_empty() {
        if let Some((prefix, rest)) = tok.split_once('.') {
            if aliases.contains(prefix) && !rest.is_empty() {
                return rest;
            }
        }
    }
    tok
}

/// Tokenizes Bend source (stripping comments and whitespace) and extracts every full multi-line \`law\`.
pub fn extract_laws_from_source(source: &str) -> Vec<CanonicalLaw> {
    let docs = extract_law_doc_comments(source);
    let aliases: BTreeSet<String> = crate::emit::parse_import_aliases(source)
        .into_iter()
        .collect();
    let tokens = tokenize_bend(source);
    let mut laws = Vec::new();
    let mut i = 0usize;

    while i < tokens.len() {
        if tokens[i] == "law" && i + 1 < tokens.len() {
            let name = tokens[i + 1].clone();
            let start = i;
            i += 2;
            while i < tokens.len() && !is_top_level_keyword(&tokens[i]) {
                i += 1;
            }
            let canonical_sig = tokens[start..i]
                .iter()
                .map(|tok| normalize_alias_token(tok, &aliases))
                .collect::<Vec<_>>()
                .join(" ");
            let hash = fnv1a_hex(canonical_sig.as_bytes());
            let LawDocs {
                promise,
                harm,
                unchecked,
            } = docs.get(&name).cloned().unwrap_or_default();
            laws.push(CanonicalLaw {
                name,
                canonical_sig,
                hash,
                promise,
                harm,
                unchecked,
            });
            continue;
        }
        i += 1;
    }

    laws
}

fn normalize_doc_ws(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn append_doc_field(slot: &mut Option<String>, raw: &str) {
    let normalized = normalize_doc_ws(raw);
    if normalized.is_empty() {
        return;
    }
    match slot {
        Some(existing) => {
            existing.push(' ');
            existing.push_str(&normalized);
        }
        None => *slot = Some(normalized),
    }
}

/// Extracts \`# promise:\`, \`# harm:\`, and \`# unchecked:\` lines from the contiguous comment block
/// immediately above each top-level \`law <name>\` declaration. Blank or non-comment lines break
/// the block.
pub fn extract_law_doc_comments(source: &str) -> BTreeMap<String, LawDocs> {
    let mut docs = BTreeMap::new();
    let lines: Vec<&str> = source.lines().collect();

    for (idx, line) in lines.iter().enumerate() {
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let Some(after_kw) = line.strip_prefix("law") else {
            continue;
        };
        if !after_kw
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_whitespace())
        {
            continue;
        }
        let name = after_kw
            .trim_start()
            .split(|c: char| c.is_ascii_whitespace() || c == ':' || c == '(')
            .next()
            .unwrap_or("")
            .trim();
        if name.is_empty() {
            continue;
        }

        let mut start = idx;
        while start > 0 {
            let prev = lines[start - 1].trim();
            if prev.is_empty() || !(prev.starts_with('#') || prev.starts_with("--")) {
                break;
            }
            start -= 1;
        }

        let mut promise: Option<String> = None;
        let mut harm: Option<String> = None;
        let mut unchecked: Option<String> = None;
        for &comment_line in &lines[start..idx] {
            let trimmed = comment_line.trim();
            let body = if let Some(rest) = trimmed.strip_prefix('#') {
                rest.trim()
            } else if let Some(rest) = trimmed.strip_prefix("--") {
                rest.trim()
            } else {
                continue;
            };
            if body
                .get(..8)
                .is_some_and(|p| p.eq_ignore_ascii_case("promise:"))
            {
                append_doc_field(&mut promise, &body[8..]);
            } else if body
                .get(..5)
                .is_some_and(|p| p.eq_ignore_ascii_case("harm:"))
            {
                append_doc_field(&mut harm, &body[5..]);
            } else if body
                .get(..10)
                .is_some_and(|p| p.eq_ignore_ascii_case("unchecked:"))
            {
                append_doc_field(&mut unchecked, &body[10..]);
            }
        }

        docs.insert(
            name.to_string(),
            LawDocs {
                promise,
                harm,
                unchecked,
            },
        );
    }

    docs
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum LockUpdateMode {
    #[default]
    None,
    /// \`RUSTY_BENDS_UPDATE_LAWS=1\`: rewrite the entire lock from current sources.
    All,
    /// \`RUSTY_BENDS_UPDATE_LAWS=comments\`: refresh \`# promise\` / \`# harm\` / \`# unchecked\`
    /// comment lines of already-locked laws whose statement hash is unchanged.
    CommentsOnly,
    /// \`RUSTY_BENDS_UPDATE_LAWS=<name>[,<name>...]\`: seal, re-accept, or remove only
    /// the named laws, leaving every other locked or new law untouched.
    Named(BTreeSet<String>),
}

impl LockUpdateMode {
    pub fn parse(raw: &str) -> Self {
        let trimmed = raw.trim();
        let lower = trimmed.to_ascii_lowercase();
        if trimmed.is_empty() || matches!(lower.as_str(), "0" | "false" | "no" | "off") {
            return Self::None;
        }
        if trimmed == "1" {
            return Self::All;
        }
        if lower == "comments" {
            return Self::CommentsOnly;
        }
        let names: BTreeSet<String> = trimmed
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .collect();
        if names.is_empty() {
            Self::None
        } else {
            Self::Named(names)
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LockUpdateSummary {
    pub sealed: Vec<String>,
    pub reaccepted: Vec<(String, String, String)>,
    pub removed: Vec<String>,
    pub comments_updated: Vec<(String, Vec<String>)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockCheckReport {
    pub current: BTreeMap<String, CanonicalLaw>,
    pub locked_names: BTreeSet<String>,
    pub new_names: BTreeSet<String>,
    pub serialized: String,
    pub needs_write: bool,
    pub warnings: Vec<String>,
    pub update_summary: LockUpdateSummary,
}

pub fn format_lock_update_notes(summary: &LockUpdateSummary) -> Vec<String> {
    let mut notes = Vec::new();
    for name in &summary.sealed {
        notes.push(format!("RustyBends lock: sealed law '{name}'"));
    }
    for (name, old_hash, new_hash) in &summary.reaccepted {
        notes.push(format!(
            "RustyBends lock: RE-ACCEPTED changed law '{name}' ({old_hash} -> {new_hash})"
        ));
    }
    for name in &summary.removed {
        notes.push(format!("RustyBends lock: removed deleted law '{name}'"));
    }
    for (name, fields) in &summary.comments_updated {
        notes.push(format!(
            "RustyBends lock: updated {} comment(s) for '{name}'",
            fields.join(", ")
        ));
    }
    notes
}

fn serialize_lock_entries(current: &BTreeMap<String, CanonicalLaw>) -> String {
    let mut lines = Vec::new();
    for law in current.values() {
        if law.canonical_sig.is_empty() {
            lines.push(format!("{}  {}", law.hash, law.name));
        } else {
            lines.push(format!("{}  {}  {}", law.hash, law.name, law.canonical_sig));
        }
        if let Some(ref p) = law.promise {
            lines.push(format!("# promise {}: {p}", law.name));
        }
        if let Some(ref h) = law.harm {
            lines.push(format!("# harm {}: {h}", law.name));
        }
        if let Some(ref u) = law.unchecked {
            lines.push(format!("# unchecked {}: {u}", law.name));
        }
    }
    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\\n", lines.join("\\n"))
    }
}

fn parse_lock_comment_line(trimmed: &str) -> Option<(&'static str, &str, String)> {
    for (field, prefix) in [
        ("promise", "# promise "),
        ("harm", "# harm "),
        ("unchecked", "# unchecked "),
    ] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            if let Some((law_name, text)) = rest.split_once(':') {
                let name = law_name.trim();
                let normalized = normalize_doc_ws(text);
                if !name.is_empty() && !normalized.is_empty() {
                    return Some((field, name, normalized));
                }
            }
            return None;
        }
    }
    None
}

fn parse_existing_lock(expected_raw: &str) -> (BTreeMap<String, CanonicalLaw>, Vec<String>) {
    let mut entries: BTreeMap<String, CanonicalLaw> = BTreeMap::new();
    let mut promises: BTreeMap<String, String> = BTreeMap::new();
    let mut harms: BTreeMap<String, String> = BTreeMap::new();
    let mut unchecked_map: BTreeMap<String, String> = BTreeMap::new();
    let mut malformed = Vec::new();

    for line in expected_raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('#') {
            if let Some((field, name, normalized)) = parse_lock_comment_line(trimmed) {
                match field {
                    "promise" => {
                        promises.insert(name.to_string(), normalized);
                    }
                    "harm" => {
                        harms.insert(name.to_string(), normalized);
                    }
                    "unchecked" => {
                        unchecked_map.insert(name.to_string(), normalized);
                    }
                    _ => {}
                }
            }
            continue;
        }
        let parts: Vec<&str> = trimmed.splitn(3, "  ").collect();
        if parts.len() < 2 {
            malformed.push(trimmed.to_string());
            continue;
        }
        let hash = parts[0].trim().to_string();
        let name = parts[1].trim().to_string();
        let sig = parts.get(2).copied().unwrap_or("").trim().to_string();
        entries.insert(
            name.clone(),
            CanonicalLaw {
                name,
                canonical_sig: sig,
                hash,
                promise: None,
                harm: None,
                unchecked: None,
            },
        );
    }

    for (name, entry) in &mut entries {
        entry.promise = promises.remove(name);
        entry.harm = harms.remove(name);
        entry.unchecked = unchecked_map.remove(name);
    }

    (entries, malformed)
}

fn diff_comment_fields(old: &CanonicalLaw, new: &CanonicalLaw) -> Vec<String> {
    let mut changed = Vec::new();
    if old.promise != new.promise {
        changed.push("promise".to_string());
    }
    if old.harm != new.harm {
        changed.push("harm".to_string());
    }
    if old.unchecked != new.unchecked {
        changed.push("unchecked".to_string());
    }
    changed
}

/// Formats a sorted \`name: promise\` listing suitable for PR descriptions and build output.
/// Laws carrying an \`# unchecked:\` marker get a trailing \`[unchecked: <reason>]\` tag.
pub fn format_law_list(laws: &BTreeMap<String, CanonicalLaw>) -> String {
    laws.values()
        .map(|law| {
            let base = match &law.promise {
                Some(p) => format!("{}: {p}", law.name),
                None => format!("{}: (no promise)", law.name),
            };
            match &law.unchecked {
                Some(u) => format!("{base} [unchecked: {u}]"),
                None => base,
            }
        })
        .collect::<Vec<_>>()
        .join("\\n")
}

/// Checks \`rusty-bends.lock\` against the canonicalized laws in \`files\` without modifying the lock file.
pub fn check_law_lock(
    lock_file: &Path,
    files: &[PathBuf],
    allow_lock_update: bool,
) -> Result<LockCheckReport, String> {
    let mode = if allow_lock_update {
        LockUpdateMode::All
    } else {
        LockUpdateMode::None
    };
    check_law_lock_with_mode(lock_file, files, &mode)
}

/// Checks \`rusty-bends.lock\` under \`mode\` (\`None\`, \`All\`, \`CommentsOnly\`, or \`Named\`).
pub fn check_law_lock_with_mode(
    lock_file: &Path,
    files: &[PathBuf],
    mode: &LockUpdateMode,
) -> Result<LockCheckReport, String> {
    let current = extract_canonical_laws(files)?;
    let all_serialized = serialize_lock_entries(&current);

    let mut locked_names = BTreeSet::new();
    let mut new_names = BTreeSet::new();
    let mut locked_promises: BTreeMap<String, String> = BTreeMap::new();
    let mut update_summary = LockUpdateSummary::default();
    let serialized;
    let needs_write;

    if lock_file.exists() {
        let expected_raw = fs::read_to_string(lock_file).map_err(|e| e.to_string())?;
        let (existing, malformed) = parse_existing_lock(&expected_raw);

        for trimmed in &malformed {
            if *mode != LockUpdateMode::All && !all_serialized.lines().any(|cur| cur == trimmed) {
                return Err(format!(
                    "[E_LAW_LOCK_TAMPERED] Locked law altered or deleted: '{trimmed}'.\\nHint: Restore the original law or run RUSTY_BENDS_UPDATE_LAWS=1 cargo check."
                ));
            }
        }

        if let LockUpdateMode::Named(targets) = mode {
            for target in targets {
                if !current.contains_key(target) && !existing.contains_key(target) {
                    return Err(format!(
                        "[E_LAW_NOT_FOUND] RUSTY_BENDS_UPDATE_LAWS named unknown law '{target}', which is not in verified/ or {}.",
                        lock_file.display()
                    ));
                }
            }
        }

        for (law_name, old_entry) in &existing {
            if let Some(ref p) = old_entry.promise {
                locked_promises.insert(law_name.clone(), p.clone());
            }
            let allowed_to_change = match mode {
                LockUpdateMode::All => true,
                LockUpdateMode::Named(targets) => targets.contains(law_name),
                LockUpdateMode::None | LockUpdateMode::CommentsOnly => false,
            };
            if !allowed_to_change {
                match current.get(law_name) {
                    None => {
                        return Err(format!(
                            "[E_LAW_LOCK_TAMPERED] Locked law '{law_name}' was deleted.\\nHint: Restore 'law {law_name}' in verified/, or approve intentionally with RUSTY_BENDS_UPDATE_LAWS={law_name} cargo check (or RUSTY_BENDS_UPDATE_LAWS=1)."
                        ));
                    }
                    Some(actual) if actual.hash != old_entry.hash => {
                        return Err(format!(
                            "[E_LAW_LOCK_TAMPERED] Locked law '{law_name}' was modified (expected {}, got {}).\\nHint: Restore the original law statement, or approve intentionally with RUSTY_BENDS_UPDATE_LAWS={law_name} cargo check (or RUSTY_BENDS_UPDATE_LAWS=1).",
                            old_entry.hash, actual.hash
                        ));
                    }
                    Some(_) => {}
                }
            }
        }

        for (name, law) in &current {
            if existing.get(name).is_some_and(|e| e.hash == law.hash) {
                locked_names.insert(name.clone());
            } else {
                new_names.insert(name.clone());
            }
        }

        match mode {
            LockUpdateMode::None => {
                serialized = all_serialized;
                needs_write = false;
            }
            LockUpdateMode::All => {
                for name in existing.keys() {
                    if !current.contains_key(name) {
                        update_summary.removed.push(name.clone());
                    }
                }
                for (name, cur) in &current {
                    match existing.get(name) {
                        None => update_summary.sealed.push(name.clone()),
                        Some(old) if old.hash != cur.hash => {
                            update_summary.reaccepted.push((
                                name.clone(),
                                old.hash.clone(),
                                cur.hash.clone(),
                            ));
                        }
                        Some(old) => {
                            let fields = diff_comment_fields(old, cur);
                            if !fields.is_empty() {
                                update_summary.comments_updated.push((name.clone(), fields));
                            }
                        }
                    }
                }
                serialized = all_serialized;
                needs_write = serialized != expected_raw;
            }
            LockUpdateMode::CommentsOnly => {
                let mut next_lock = existing;
                for (name, entry) in &mut next_lock {
                    if let Some(cur) = current.get(name) {
                        let fields = diff_comment_fields(entry, cur);
                        if !fields.is_empty() {
                            entry.promise = cur.promise.clone();
                            entry.harm = cur.harm.clone();
                            entry.unchecked = cur.unchecked.clone();
                            update_summary.comments_updated.push((name.clone(), fields));
                        }
                    }
                }
                serialized = serialize_lock_entries(&next_lock);
                needs_write = serialized != expected_raw;
            }
            LockUpdateMode::Named(targets) => {
                let mut next_lock = existing.clone();
                for target in targets {
                    match (existing.get(target), current.get(target)) {
                        (None, Some(cur)) => {
                            next_lock.insert(target.clone(), cur.clone());
                            update_summary.sealed.push(target.clone());
                        }
                        (Some(old), Some(cur)) => {
                            if old.hash != cur.hash {
                                update_summary.reaccepted.push((
                                    target.clone(),
                                    old.hash.clone(),
                                    cur.hash.clone(),
                                ));
                            } else {
                                let fields = diff_comment_fields(old, cur);
                                if !fields.is_empty() {
                                    update_summary
                                        .comments_updated
                                        .push((target.clone(), fields));
                                }
                            }
                            next_lock.insert(target.clone(), cur.clone());
                        }
                        (Some(_), None) => {
                            next_lock.remove(target);
                            update_summary.removed.push(target.clone());
                        }
                        (None, None) => {}
                    }
                }
                serialized = serialize_lock_entries(&next_lock);
                needs_write = serialized != expected_raw;
            }
        }
    } else {
        for name in current.keys() {
            new_names.insert(name.clone());
        }
        match mode {
            LockUpdateMode::None | LockUpdateMode::All => {
                update_summary.sealed = current.keys().cloned().collect();
                serialized = all_serialized;
                needs_write = true;
            }
            LockUpdateMode::CommentsOnly => {
                serialized = String::new();
                needs_write = false;
            }
            LockUpdateMode::Named(targets) => {
                let mut next_lock = BTreeMap::new();
                for target in targets {
                    let Some(cur) = current.get(target) else {
                        return Err(format!(
                            "[E_LAW_NOT_FOUND] RUSTY_BENDS_UPDATE_LAWS named unknown law '{target}', which is not in verified/ or {}.",
                            lock_file.display()
                        ));
                    };
                    next_lock.insert(target.clone(), cur.clone());
                    update_summary.sealed.push(target.clone());
                }
                serialized = serialize_lock_entries(&next_lock);
                needs_write = !next_lock.is_empty();
            }
        }
    }

    for name in &new_names {
        if let Some(law) = current.get(name) {
            if law.promise.is_none() {
                return Err(format!(
                    "[E_LAW_NO_PROMISE] New law '{name}' is missing a plain-English '# promise:' comment.\\nHint: Add '# promise: <one-sentence statement of what this law guarantees>' (and optionally '# harm: ...') directly above 'law {name}:'."
                ));
            }
        }
    }

    let mut warnings = Vec::new();
    for name in &locked_names {
        if let Some(law) = current.get(name) {
            match (&law.promise, locked_promises.get(name)) {
                (None, Some(old)) => warnings.push(format!(
                    "RustyBends [law {name}]: promise removed (was: \\"{old}\\"); add '# promise: ...' directly above 'law {name}:'."
                )),
                (None, None) => warnings.push(format!(
                    "RustyBends [law {name}]: locked law is missing a '# promise:' comment. Add '# promise: <one-sentence rule>' directly above 'law {name}:'."
                )),
                (Some(cur), Some(old)) if cur != old => warnings.push(format!(
                    "RustyBends [law {name}]: promise wording changed (lock hash unchanged): \\"{old}\\" -> \\"{cur}\\""
                )),
                (Some(cur), None) => warnings.push(format!(
                    "RustyBends [law {name}]: promise added (lock hash unchanged): \\"{cur}\\""
                )),
                (Some(_), Some(_)) => {}
            }
        }
    }

    Ok(LockCheckReport {
        current,
        locked_names,
        new_names,
        serialized,
        needs_write,
        warnings,
        update_summary,
    })
}

/// Persists \`report.serialized\` to \`lock_file\`.
pub fn write_law_lock(lock_file: &Path, report: &LockCheckReport) -> Result<(), String> {
    fs::write(lock_file, &report.serialized).map_err(|e| e.to_string())
}

/// Enforces \`rusty-bends.lock\` against the canonicalized laws in \`files\`.
pub fn enforce_law_lock(
    lock_file: &Path,
    files: &[PathBuf],
    allow_lock_update: bool,
) -> Result<usize, String> {
    let report = check_law_lock(lock_file, files, allow_lock_update)?;
    if report.needs_write {
        write_law_lock(lock_file, &report)?;
    }
    Ok(report.current.len())
}

/// Enforces \`rusty-bends.lock\` under \`mode\`.
pub fn enforce_law_lock_with_mode(
    lock_file: &Path,
    files: &[PathBuf],
    mode: &LockUpdateMode,
) -> Result<LockCheckReport, String> {
    let report = check_law_lock_with_mode(lock_file, files, mode)?;
    if report.needs_write {
        write_law_lock(lock_file, &report)?;
    }
    Ok(report)
}

/// Reads the set of locked law names currently present in \`lock_file\` (returns empty if missing).
pub fn read_locked_law_names(lock_file: &Path) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let Ok(raw) = fs::read_to_string(lock_file) else {
        return names;
    };
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = trimmed.splitn(3, "  ").collect();
        if parts.len() >= 2 {
            names.insert(parts[1].trim().to_string());
        }
    }
    names
}

fn is_top_level_keyword(tok: &str) -> bool {
    matches!(tok, "import" | "type" | "def" | "law" | "proof")
}

/// Strips '#' and '--' comments and splits Bend source into canonical lexical tokens.
pub fn tokenize_bend(source: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = source.chars().collect();
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];
        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        // Line comments: # ... or -- ...
        if ch == '#' || (ch == '-' && i + 1 < chars.len() && chars[i + 1] == '-') {
            while i < chars.len() && chars[i] != '\\n' {
                i += 1;
            }
            continue;
        }

        // Two-character operators
        if i + 1 < chars.len() {
            let two: String = [ch, chars[i + 1]].iter().collect();
            if matches!(
                two.as_str(),
                "->" | "<-" | "=>" | "==" | "!=" | "&&" | "||" | "<=" | ">="
            ) {
                tokens.push(two);
                i += 2;
                continue;
            }
        }

        // Identifiers (including dotted constructors like OrderState.Paid)
        if ch.is_ascii_alphabetic() || ch == '_' {
            let start = i;
            i += 1;
            while i < chars.len()
                && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '.')
            {
                i += 1;
            }
            tokens.push(chars[start..i].iter().collect());
            continue;
        }

        // Natural literals (0n, 42n) or numbers
        if ch.is_ascii_digit() {
            let start = i;
            i += 1;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i < chars.len() && chars[i] == 'n' {
                i += 1;
            }
            tokens.push(chars[start..i].iter().collect());
            continue;
        }

        tokens.push(ch.to_string());
        i += 1;
    }

    tokens
}

pub fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn tmp_dir(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = env::temp_dir().join(format!("rb_lock_{tag}_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reformatting_and_comments_do_not_break_lock() {
        let dir = tmp_dir("reformat");
        let file = dir.join("core.bend");
        let lock = dir.join("rusty-bends.lock");

        fs::write(
            &file,
            "# promise: depositing in either order yields the same balance\\nlaw conserved(for +a: Nat, for +b: Nat):\\n  deposit(a, b) == deposit(b, a)\\nproof conserved:\\n  refl\\n",
        )
        .unwrap();
        assert_eq!(
            enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap(),
            1
        );

        // Multi-line reformat + comments inside the law must remain locked-valid!
        fs::write(
            &file,
            "# promise: depositing in either order yields the same balance\\n# header comment\\nlaw conserved(\\n  for +a: Nat,\\n  -- inline note\\n  for +b: Nat\\n):\\n  deposit(a, b)\\n    ==\\n  deposit(b, a)\\n\\nproof conserved:\\n  refl\\n",
        )
        .unwrap();
        assert_eq!(enforce_law_lock(&lock, &[file], false).unwrap(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn multi_line_law_tampering_is_detected() {
        let dir = tmp_dir("multiline_tamper");
        let file = dir.join("core.bend");
        let lock = dir.join("rusty-bends.lock");

        fs::write(
            &file,
            "# promise: cancelling an order twice matches cancelling it once\\nlaw cancel_idempotent(\\n  for +s: OrderState\\n):\\n  cancel_order(\\n    cancel_order(s)\\n  ) == cancel_order(s)\\n\\nproof cancel_idempotent:\\n  refl\\n",
        )
        .unwrap();
        enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap();

        // Subtle change on line 6 of the multi-line law must be caught
        fs::write(
            &file,
            "# promise: cancelling an order twice matches cancelling it once\\nlaw cancel_idempotent(\\n  for +s: OrderState\\n):\\n  cancel_order(\\n    s\\n  ) == cancel_order(s)\\n\\nproof cancel_idempotent:\\n  refl\\n",
        )
        .unwrap();
        let err = enforce_law_lock(&lock, &[file], false).unwrap_err();
        assert!(err.contains("E_LAW_LOCK_TAMPERED"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_locked_law_is_blocked() {
        let dir = tmp_dir("delete");
        let file = dir.join("core.bend");
        let lock = dir.join("rusty-bends.lock");

        fs::write(
            &file,
            "# promise: identity holds\\nlaw keep_me:\\n  1n == 1n\\nproof keep_me:\\n  refl\\n",
        )
        .unwrap();
        enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap();

        fs::write(&file, "def x(+n: Nat) -> Nat:\\n  n\\n").unwrap();
        let err = enforce_law_lock(&lock, &[file], false).unwrap_err();
        assert!(err.contains("E_LAW_LOCK_TAMPERED"));
        assert!(err.contains("deleted"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn adding_new_law_is_permitted() {
        let dir = tmp_dir("add_new");
        let file = dir.join("core.bend");
        let lock = dir.join("rusty-bends.lock");

        fs::write(
            &file,
            "# promise: one equals one\\nlaw first:\\n  1n == 1n\\nproof first:\\n  refl\\n",
        )
        .unwrap();
        enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap();

        fs::write(
            &file,
            "# promise: one equals one\\nlaw first:\\n  1n == 1n\\nproof first:\\n  refl\\n\\n# promise: two equals two\\nlaw second:\\n  2n == 2n\\nproof second:\\n  refl\\n",
        )
        .unwrap();
        assert_eq!(enforce_law_lock(&lock, &[file], false).unwrap(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_law_without_promise_fails_with_e_law_no_promise() {
        let dir = tmp_dir("no_promise");
        let file = dir.join("core.bend");
        let lock = dir.join("rusty-bends.lock");

        // Completely missing promise
        fs::write(&file, "law missing_p:\\n  1n == 1n\\n").unwrap();
        let err = check_law_lock(&lock, std::slice::from_ref(&file), false).unwrap_err();
        assert!(err.contains("E_LAW_NO_PROMISE"), "got: {err}");
        assert!(err.contains("missing_p"), "got: {err}");

        // Blank promise text
        fs::write(&file, "# promise:   \\nlaw missing_p:\\n  1n == 1n\\n").unwrap();
        let err_blank = check_law_lock(&lock, std::slice::from_ref(&file), false).unwrap_err();
        assert!(err_blank.contains("E_LAW_NO_PROMISE"), "got: {err_blank}");

        // Separated from \`law\` by a blank line -> does not attach to \`law\`
        fs::write(
            &file,
            "# promise: separated comment\\n\\nlaw missing_p:\\n  1n == 1n\\n",
        )
        .unwrap();
        let err_sep = check_law_lock(&lock, &[file], false).unwrap_err();
        assert!(err_sep.contains("E_LAW_NO_PROMISE"), "got: {err_sep}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn locked_law_without_promise_warns_without_failing() {
        let dir = tmp_dir("locked_no_promise");
        let file = dir.join("core.bend");
        let lock = dir.join("rusty-bends.lock");

        let src = "law legacy_law:\\n  for +x: Nat\\n  {x == x : Nat}\\n";
        fs::write(&file, src).unwrap();
        let law = extract_laws_from_source(src).into_iter().next().unwrap();
        // Legacy lock file without \`# promise\` lines
        fs::write(
            &lock,
            format!("{}  {}  {}\\n", law.hash, law.name, law.canonical_sig),
        )
        .unwrap();

        let report = check_law_lock(&lock, &[file], false)
            .expect("locked law missing promise should warn, not fail");
        assert!(report.locked_names.contains("legacy_law"));
        assert!(
            report
                .warnings
                .iter()
                .any(|w| w.contains("legacy_law") && w.contains("missing a '# promise:' comment")),
            "warnings: {:?}",
            report.warnings
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn editing_promise_wording_does_not_trip_lock_and_is_reported() {
        let dir = tmp_dir("promise_edit");
        let file = dir.join("core.bend");
        let lock = dir.join("rusty-bends.lock");

        fs::write(
            &file,
            "# promise: initial balance rule\\n# harm: wrong balance\\nlaw bal_rule:\\n  for +x: Nat\\n  {x == x : Nat}\\n",
        )
        .unwrap();
        enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap();
        let initial_hash = extract_canonical_laws(std::slice::from_ref(&file))
            .unwrap()
            .get("bal_rule")
            .unwrap()
            .hash
            .clone();

        // Edit only the promise wording
        fs::write(
            &file,
            "# promise: clearer wording for the balance invariant\\n# harm: wrong balance\\nlaw bal_rule:\\n  for +x: Nat\\n  {x == x : Nat}\\n",
        )
        .unwrap();
        let updated_hash = extract_canonical_laws(std::slice::from_ref(&file))
            .unwrap()
            .get("bal_rule")
            .unwrap()
            .hash
            .clone();
        assert_eq!(initial_hash, updated_hash);

        let report = check_law_lock(&lock, &[file], false)
            .expect("editing promise wording must not trigger E_LAW_LOCK_TAMPERED");
        assert!(
            report.warnings.iter().any(|w| w.contains("bal_rule")
                && w.contains("promise wording changed")
                && w.contains("initial balance rule")
                && w.contains("clearer wording for the balance invariant")),
            "warnings: {:?}",
            report.warnings
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn format_law_list_prints_name_and_promise() {
        let src = r#"# promise: first guarantee
law alpha:
  1n == 1n

law beta:
  2n == 2n
"#;
        let map: BTreeMap<String, CanonicalLaw> = extract_laws_from_source(src)
            .into_iter()
            .map(|l| (l.name.clone(), l))
            .collect();
        let listing = format_law_list(&map);
        assert_eq!(listing, "alpha: first guarantee\\nbeta: (no promise)");
    }

    #[test]
    fn renaming_import_alias_preserves_canonical_law_hash_and_lock() {
        let dir = tmp_dir("alias_lock");
        let uses = dir.join("uses.bend");
        let lock = dir.join("rusty-bends.lock");

        let src_b = r#"import Base
import base_rules.bend as B

# promise: within_both with identical bounds agrees with within_limit
law within_both_diag:
  for +pos: Nat
  for +a: Nat
  {within_both(pos, a, a) == B.within_limit(pos, a) : Bool}
"#;
        fs::write(&uses, src_b).unwrap();
        enforce_law_lock(&lock, std::slice::from_ref(&uses), false).unwrap();
        let hash_b = extract_canonical_laws(std::slice::from_ref(&uses))
            .unwrap()
            .get("within_both_diag")
            .unwrap()
            .hash
            .clone();

        let src_rules = r#"import Base
import base_rules.bend as Rules

# promise: within_both with identical bounds agrees with within_limit
law within_both_diag:
  for +pos: Nat
  for +a: Nat
  {within_both(pos, a, a) == Rules.within_limit(pos, a) : Bool}
"#;
        fs::write(&uses, src_rules).unwrap();
        let hash_rules = extract_canonical_laws(std::slice::from_ref(&uses))
            .unwrap()
            .get("within_both_diag")
            .unwrap()
            .hash
            .clone();
        assert_eq!(hash_b, hash_rules);
        check_law_lock(&lock, &[uses], false)
            .expect("renaming import alias must not trip E_LAW_LOCK_TAMPERED");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn selective_seal_comments_only_and_reaccept_reporting_work_as_specified() {
        let dir = tmp_dir("issue17_selective");
        let ledger = dir.join("ledger.bend");
        let lock = dir.join("rusty-bends.lock");

        let start_src = r#"import Base

def total_items(+a: Nat, +b: Nat) -> Nat:
  Nat.add(a, b)

def bump(+n: Nat) -> Nat:
  1n+n

# promise: the total never drops below the first delivery
law total_covers_first:
  for +a: Nat
  for +b: Nat
  {Nat.is_le(a, total_items(a, b)) == True{} : Bool}

# promise: a write always changes the stamp
law bump_changes:
  for +m: Nat
  {Nat.is_eq(m, bump(m)) == False{} : Bool}
"#;
        fs::write(&ledger, start_src).unwrap();
        let init =
            enforce_law_lock_with_mode(&lock, std::slice::from_ref(&ledger), &LockUpdateMode::None)
                .unwrap();
        assert_eq!(
            init.update_summary.sealed,
            vec!["bump_changes", "total_covers_first"]
        );

        // 1. Reword bump_changes promise, add reviewed total_covers_second and doubted bump_not_lower.
        let step1_src = r#"import Base

def total_items(+a: Nat, +b: Nat) -> Nat:
  Nat.add(a, b)

def bump(+n: Nat) -> Nat:
  1n+n

# promise: the total never drops below the first delivery
law total_covers_first:
  for +a: Nat
  for +b: Nat
  {Nat.is_le(a, total_items(a, b)) == True{} : Bool}

# promise: every write gives the record a stamp it never had before
law bump_changes:
  for +m: Nat
  {Nat.is_eq(m, bump(m)) == False{} : Bool}

# promise: a write never lowers the stamp
law bump_not_lower:
  for +m: Nat
  {Nat.is_le(m, bump(m)) == True{} : Bool}

# promise: the total never drops below the second delivery
law total_covers_second:
  for +a: Nat
  for +b: Nat
  {Nat.is_le(b, total_items(a, b)) == True{} : Bool}
"#;
        fs::write(&ledger, step1_src).unwrap();

        // Seal ONLY total_covers_second.
        let r_named = enforce_law_lock_with_mode(
            &lock,
            std::slice::from_ref(&ledger),
            &LockUpdateMode::parse("total_covers_second"),
        )
        .unwrap();
        assert_eq!(
            r_named.update_summary.sealed,
            vec!["total_covers_second".to_string()]
        );
        assert!(r_named.update_summary.comments_updated.is_empty());
        let lock_after_named = fs::read_to_string(&lock).unwrap();
        assert!(lock_after_named.contains("total_covers_second"));
        assert!(!lock_after_named.contains("bump_not_lower"));
        assert!(
            lock_after_named.contains("# promise bump_changes: a write always changes the stamp"),
            "named seal must leave bump_changes promise line untouched:\\n{lock_after_named}"
        );

        // Comments-only mode updates ONLY bump_changes's promise line and seals nothing.
        let r_comments = enforce_law_lock_with_mode(
            &lock,
            std::slice::from_ref(&ledger),
            &LockUpdateMode::parse("comments"),
        )
        .unwrap();
        assert!(r_comments.update_summary.sealed.is_empty());
        assert_eq!(
            r_comments.update_summary.comments_updated,
            vec![("bump_changes".to_string(), vec!["promise".to_string()])]
        );
        let lock_after_comments = fs::read_to_string(&lock).unwrap();
        assert!(!lock_after_comments.contains("bump_not_lower"));
        assert!(lock_after_comments.contains(
            "# promise bump_changes: every write gives the record a stamp it never had before"
        ));

        // 2. Weaken locked total_covers_first; both named (other law) and comments-only must fail.
        let weakened = step1_src.replace(
            "{Nat.is_le(a, total_items(a, b)) == True{} : Bool}",
            "{Nat.is_le(a, total_items(a, 0n)) == True{} : Bool}",
        );
        fs::write(&ledger, &weakened).unwrap();
        let err_named = check_law_lock_with_mode(
            &lock,
            std::slice::from_ref(&ledger),
            &LockUpdateMode::parse("bump_not_lower"),
        )
        .unwrap_err();
        assert!(err_named.contains("E_LAW_LOCK_TAMPERED"));
        assert!(err_named.contains("total_covers_first"));

        let err_comments = check_law_lock_with_mode(
            &lock,
            std::slice::from_ref(&ledger),
            &LockUpdateMode::CommentsOnly,
        )
        .unwrap_err();
        assert!(err_comments.contains("E_LAW_LOCK_TAMPERED"));
        assert!(err_comments.contains("total_covers_first"));

        // Re-accepting with =1 explicitly reports total_covers_first with old and new hash.
        let r_all = check_law_lock_with_mode(
            &lock,
            std::slice::from_ref(&ledger),
            &LockUpdateMode::parse("1"),
        )
        .unwrap();
        assert_eq!(r_all.update_summary.reaccepted.len(), 1);
        assert_eq!(r_all.update_summary.reaccepted[0].0, "total_covers_first");
        let notes = format_lock_update_notes(&r_all.update_summary);
        assert!(
            notes
                .iter()
                .any(|n| n.contains("RE-ACCEPTED changed law 'total_covers_first'")),
            "notes: {notes:?}"
        );

        // Unknown law name fails with E_LAW_NOT_FOUND.
        let err_missing = check_law_lock_with_mode(
            &lock,
            std::slice::from_ref(&ledger),
            &LockUpdateMode::parse("no_such_law"),
        )
        .unwrap_err();
        assert!(err_missing.contains("E_LAW_NOT_FOUND"), "{err_missing}");

        // Deleting a locked law and naming it removes it from the lock.
        let without_bump = weakened.replace(
            "# promise: every write gives the record a stamp it never had before\\nlaw bump_changes:\\n  for +m: Nat\\n  {Nat.is_eq(m, bump(m)) == False{} : Bool}\\n",
            "",
        );
        fs::write(&ledger, &without_bump).unwrap();
        let r_del = check_law_lock_with_mode(
            &lock,
            std::slice::from_ref(&ledger),
            &LockUpdateMode::parse("total_covers_first,bump_changes"),
        )
        .unwrap();
        assert_eq!(r_del.update_summary.removed, vec!["bump_changes"]);
        assert!(!r_del.serialized.contains("bump_changes"));
        assert!(!r_del.serialized.contains("bump_not_lower"));

        let _ = fs::remove_dir_all(&dir);
    }
}
`;

  const buildCrateEmit = `//! Erased-core BendTT v1 -> Pure Rust code emitter.
//!
//! Runs *only after* the real 'bend' proof checker approves every type, definition, and law.
//! Strictly enforces the BendTT dead/live split:
//! - 'type' ADTs emit '#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum ...' (or Clone-only with Box<T> indirection when recursive).
//! - 'match' and 'if/else' emit idiomatic Rust pattern matching and conditionals.
//! - 'Dead' (q=0) parameters ('-T: Type') and annotations ('(x : T)') are erased.
//! - 'law' and 'proof' blocks (including match/rewrite proofs) are completely stripped.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quantity {
    Dead,
    Live,
    Data,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Param {
    pub q: Quantity,
    pub name: String,
    pub ty: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Variant {
    pub name: String,
    pub field_types: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeDef {
    pub name: String,
    pub variants: Vec<Variant>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Def {
    pub name: String,
    pub params: Vec<Param>,
    pub ret: String,
    pub body: String,
    /// \`# rusty-bends: total\` above the \`def\`: emit as \`Option<T>\` (\`None\` on \`Nat\`
    /// overflow) instead of panicking (Issue #13).
    pub total: bool,
}

/// One checked-growth panic site in emitted Rust: \`function\` panics with
/// \`rusty-bends: Nat overflow\` when \`op\` overflows \`u64\`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanicSite {
    pub function: String,
    /// \`Nat.add\`, \`Nat.mul\`, \`Nat.succ\`, or \`call <f>\` (a call to a total function).
    pub op: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitSummary {
    pub rust_source: String,
    pub types_emitted: usize,
    pub defs_emitted: usize,
    pub dead_params_erased: usize,
    /// Every checked-growth op that can panic, per public emitted function, in emission order.
    pub panic_sites: Vec<PanicSite>,
}

#[derive(Debug, Clone)]
pub(crate) struct CtorInfo {
    pub(crate) type_name: String,
    pub(crate) variant_name: String,
    pub(crate) arity: usize,
    pub(crate) field_types: Vec<String>,
    pub(crate) boxed_fields: Vec<bool>,
}

#[derive(Debug, Clone)]
pub(crate) struct TypeEnv {
    pub(crate) ctor_map: HashMap<String, CtorInfo>,
    pub(crate) non_copy_types: HashSet<String>,
    pub(crate) uses_builtin_list: bool,
}

impl TypeEnv {
    pub(crate) fn build(types: &[TypeDef], defs: &[Def], extra_sources: &[&str]) -> Self {
        let type_names: HashSet<&str> = types.iter().map(|t| t.name.as_str()).collect();
        let user_ctor_names: HashSet<&str> = types
            .iter()
            .flat_map(|t| t.variants.iter().map(|v| v.name.as_str()))
            .collect();

        // Build ADT dependency graph: A -> B if any variant of A mentions user ADT B.
        let mut deps: HashMap<&str, HashSet<String>> = HashMap::new();
        for td in types {
            let mut refs = HashSet::new();
            for v in &td.variants {
                for ft in &v.field_types {
                    collect_referenced_adts(ft, &type_names, &mut refs);
                }
            }
            deps.insert(td.name.as_str(), refs);
        }

        let mut uses_builtin_list = false;
        if !type_names.contains("List") {
            'scan_list: for td in types {
                for v in &td.variants {
                    for ft in &v.field_types {
                        if mentions_builtin_list(ft, &user_ctor_names) {
                            uses_builtin_list = true;
                            break 'scan_list;
                        }
                    }
                }
            }
            if !uses_builtin_list {
                'scan_defs: for d in defs {
                    if mentions_builtin_list(&d.ret, &user_ctor_names)
                        || mentions_builtin_list(&d.body, &user_ctor_names)
                        || d.params
                            .iter()
                            .any(|p| mentions_builtin_list(&p.ty, &user_ctor_names))
                    {
                        uses_builtin_list = true;
                        break 'scan_defs;
                    }
                }
            }
            if !uses_builtin_list {
                for src in extra_sources {
                    if mentions_builtin_list(src, &user_ctor_names) {
                        uses_builtin_list = true;
                        break;
                    }
                }
            }
        }

        let mut ctor_map: HashMap<String, CtorInfo> = HashMap::new();
        let mut non_copy_types: HashSet<String> = HashSet::new();
        if uses_builtin_list {
            non_copy_types.insert("List".to_string());
        }

        for td in types {
            let mut has_boxed = false;
            for v in &td.variants {
                let mut boxed_fields = Vec::with_capacity(v.field_types.len());
                for ft in &v.field_types {
                    let mut field_refs = HashSet::new();
                    collect_referenced_adts(ft, &type_names, &mut field_refs);
                    let needs_box = field_refs
                        .iter()
                        .any(|b| b == &td.name || can_reach(b, &td.name, &deps));
                    if needs_box {
                        has_boxed = true;
                    }
                    boxed_fields.push(needs_box);
                }
                let info = CtorInfo {
                    type_name: td.name.clone(),
                    variant_name: v.name.clone(),
                    arity: v.field_types.len(),
                    field_types: v.field_types.clone(),
                    boxed_fields,
                };
                ctor_map.insert(format!("{}.{}", td.name, v.name), info.clone());
                ctor_map.entry(v.name.clone()).or_insert(info);
            }
            if has_boxed {
                non_copy_types.insert(td.name.clone());
            }
        }

        // Fixed-point propagation of non-Copy across non-recursive wrapper ADTs.
        loop {
            let mut changed = false;
            for td in types {
                if non_copy_types.contains(&td.name) {
                    continue;
                }
                let refs_non_copy = td.variants.iter().any(|v| {
                    v.field_types
                        .iter()
                        .any(|ft| type_contains_non_copy(ft, &non_copy_types))
                });
                if refs_non_copy {
                    non_copy_types.insert(td.name.clone());
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }

        if uses_builtin_list && !type_names.contains("List") {
            let nil_info = CtorInfo {
                type_name: "List".to_string(),
                variant_name: "Nil".to_string(),
                arity: 0,
                field_types: Vec::new(),
                boxed_fields: Vec::new(),
            };
            let con_info = CtorInfo {
                type_name: "List".to_string(),
                variant_name: "Con".to_string(),
                arity: 2,
                field_types: vec!["_".to_string(), "List".to_string()],
                boxed_fields: vec![false, true],
            };
            ctor_map.insert("List.Nil".to_string(), nil_info.clone());
            ctor_map.entry("Nil".to_string()).or_insert(nil_info);
            ctor_map.insert("List.Con".to_string(), con_info.clone());
            ctor_map.entry("Con".to_string()).or_insert(con_info);
        }

        Self {
            ctor_map,
            non_copy_types,
            uses_builtin_list,
        }
    }
}

fn can_reach(start: &str, target: &str, deps: &HashMap<&str, HashSet<String>>) -> bool {
    let mut visited = HashSet::new();
    let mut queue = VecDeque::new();
    visited.insert(start.to_string());
    queue.push_back(start.to_string());
    while let Some(cur) = queue.pop_front() {
        if let Some(nexts) = deps.get(cur.as_str()) {
            for next in nexts {
                if next == target {
                    return true;
                }
                if visited.insert(next.clone()) {
                    queue.push_back(next.clone());
                }
            }
        }
    }
    false
}

pub(crate) fn parse_list_elem_type(ty: &str) -> Option<&str> {
    let t = ty.trim();
    let rest = t.strip_prefix("List")?.trim_start();
    if !(rest.starts_with('<') && rest.ends_with('>')) || !is_wrapped_in_angles(rest) {
        return None;
    }
    let inner = rest[1..rest.len() - 1].trim();
    let parts = split_type_args(inner, ',');
    parts
        .last()
        .copied()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn collect_referenced_adts(ty: &str, type_names: &HashSet<&str>, out: &mut HashSet<String>) {
    let t = ty.trim();
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
        if parts.len() > 1 {
            for p in parts {
                collect_referenced_adts(p, type_names, out);
            }
            return;
        }
        collect_referenced_adts(inner, type_names, out);
        return;
    }
    let amp = split_type_args(t, '&');
    if amp.len() > 1 {
        for p in amp {
            collect_referenced_adts(p, type_names, out);
        }
        return;
    }
    if let Some(elem) = parse_list_elem_type(t) {
        collect_referenced_adts(elem, type_names, out);
        return;
    }
    if type_names.contains(t) {
        out.insert(t.to_string());
    }
}

pub(crate) fn type_contains_non_copy(ty: &str, non_copy_types: &HashSet<String>) -> bool {
    let t = ty.trim();
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
        if parts.len() > 1 {
            return parts
                .iter()
                .any(|p| type_contains_non_copy(p, non_copy_types));
        }
        return type_contains_non_copy(inner, non_copy_types);
    }
    let amp = split_type_args(t, '&');
    if amp.len() > 1 {
        return amp
            .iter()
            .any(|p| type_contains_non_copy(p, non_copy_types));
    }
    if parse_list_elem_type(t).is_some() {
        return true;
    }
    non_copy_types.contains(t)
}

fn mentions_builtin_list(s: &str, user_ctors: &HashSet<&str>) -> bool {
    if s.contains("List<") || s.contains("List.Nil") || s.contains("List.Con") || s.contains('[') {
        return true;
    }
    for tok in crate::lock::tokenize_bend(s) {
        if tok == "List"
            || (!user_ctors.contains("Nil") && tok == "Nil")
            || (!user_ctors.contains("Con") && tok == "Con")
        {
            return true;
        }
    }
    false
}

/// Parses Bend v1 'type' and 'def' items from verified source, erases all q=0 parts and laws,
/// and emits zero-dependency Rust (plus generated \`#[cfg(test)]\` per-law checks) ready for
/// \`include!(concat!(env!("OUT_DIR"), "/verified.rs"))\`.
pub fn emit_verified_rust(source: &str, laws_verified: usize) -> Result<EmitSummary, String> {
    let (types, defs) = parse_book_items(source)?;
    let laws = crate::law_test::parse_laws(source);
    let extra_sources = collect_law_source_slices(&laws);
    let type_env = TypeEnv::build(&types, &defs, &extra_sources);
    let mut summary = emit_items_to_rust(&types, &defs, &type_env, laws_verified, None, true)?;

    if !laws.is_empty() {
        let test_mod = crate::law_test::emit_law_tests_module(&laws, &types, &defs, &type_env);
        if !test_mod.is_empty() {
            summary.rust_source.push('\\n');
            summary.rust_source.push_str(&test_mod);
        }
    }

    Ok(summary)
}

/// Emits pure runtime Rust only (without \`#[cfg(test)]\` law harnesses).
pub fn emit_runtime_only(source: &str, laws_verified: usize) -> Result<EmitSummary, String> {
    let (types, defs) = parse_book_items(source)?;
    let type_env = TypeEnv::build(&types, &defs, &[]);
    emit_items_to_rust(&types, &defs, &type_env, laws_verified, None, true)
}

pub(crate) fn collect_law_source_slices(laws: &[crate::law_test::ParsedLaw]) -> Vec<&str> {
    let mut slices = Vec::new();
    for l in laws {
        if !l.lhs.is_empty() {
            slices.push(l.lhs.as_str());
        }
        if !l.rhs.is_empty() {
            slices.push(l.rhs.as_str());
        }
        if !l.eq_ty.is_empty() {
            slices.push(l.eq_ty.as_str());
        }
        for v in &l.vars {
            slices.push(v.ty.as_str());
        }
        for h in &l.hypotheses {
            slices.push(h.lhs.as_str());
            slices.push(h.rhs.as_str());
            slices.push(h.ty.as_str());
        }
    }
    slices
}

pub(crate) fn emit_items_to_rust(
    types: &[TypeDef],
    defs: &[Def],
    type_env: &TypeEnv,
    laws_verified: usize,
    step_limit: Option<usize>,
    emit_types: bool,
) -> Result<EmitSummary, String> {
    let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
    let mut dead_params_erased = 0usize;
    let mut blocks = Vec::new();
    let empty_set = HashSet::new();

    if let Some(limit) = step_limit {
        blocks.push(format!(
            "std::thread_local! {{\\n    static __RB_STEPS: std::cell::Cell<usize> = const {{ std::cell::Cell::new(0) }};\\n}}\\n\\nfn __rb_reset_steps() {{\\n    __RB_STEPS.with(|c| c.set(0));\\n}}\\n\\nfn __rb_tick() {{\\n    __RB_STEPS.with(|c| {{\\n        let next = c.get().saturating_add(1);\\n        c.set(next);\\n        if next > {limit} {{\\n            panic!(\\"rusty-bends: step limit\\");\\n        }}\\n    }});\\n}}"
        ));
    }

    if emit_types && type_env.uses_builtin_list {
        blocks.push(
            "#[derive(Debug, Clone, PartialEq, Eq)]\\npub enum List<T> {\\n    Nil,\\n    Con(T, Box<List<T>>),\\n}"
                .to_string(),
        );
    }

    if emit_types {
        for td in types {
            let mut variants_rs = Vec::new();
            for v in &td.variants {
                if v.field_types.is_empty() {
                    variants_rs.push(format!("    {},", v.name));
                } else {
                    let info = type_env.ctor_map.get(&format!("{}.{}", td.name, v.name));
                    let mapped: Vec<String> = v
                        .field_types
                        .iter()
                        .enumerate()
                        .map(|(idx, t)| {
                            let rty = bend_type_to_rust(t, &empty_set);
                            let is_boxed = info
                                .and_then(|c| c.boxed_fields.get(idx).copied())
                                .unwrap_or(false);
                            if is_boxed {
                                format!("Box<{rty}>")
                            } else {
                                rty
                            }
                        })
                        .collect();
                    variants_rs.push(format!("    {}({}),", v.name, mapped.join(", ")));
                }
            }
            let derive_line = if type_env.non_copy_types.contains(&td.name) {
                "#[derive(Debug, Clone, PartialEq, Eq)]"
            } else {
                "#[derive(Debug, Clone, Copy, PartialEq, Eq)]"
            };
            blocks.push(format!(
                "{derive_line}\\npub enum {} {{\\n{}\\n}}",
                td.name,
                variants_rs.join("\\n")
            ));
        }
    }

    let total_cone = total_def_cone(defs, &def_map);
    let mut panic_sites = Vec::new();

    for def in defs {
        let mut type_params = Vec::new();
        let mut type_param_set = HashSet::new();
        let mut live_params = Vec::new();

        for p in &def.params {
            if p.q == Quantity::Dead {
                dead_params_erased += 1;
                if matches!(p.ty.trim(), "Type" | "Data" | "*1" | "*2") {
                    type_params.push(p.name.clone());
                    type_param_set.insert(p.name.clone());
                }
            } else {
                live_params.push(p);
            }
        }

        let has_generics = !type_params.is_empty();
        let generics = if !has_generics {
            String::new()
        } else {
            format!("<{}>", type_params.join(", "))
        };

        let rust_params = live_params
            .iter()
            .map(|p| {
                format!(
                    "{}: {}",
                    rust_ident(&p.name),
                    bend_type_to_rust(&p.ty, &type_param_set)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");

        let mut clone_vars = HashSet::new();
        if !has_generics {
            for p in &live_params {
                if type_contains_non_copy(&p.ty, &type_env.non_copy_types)
                    && count_ident_uses(&def.body, &p.name) > 1
                {
                    clone_vars.insert(p.name.clone());
                }
            }
        }

        let default_mode = arith_mode_for_type(&def.ret, ArithMode::NatChecked);
        let ret_ty = infer_return_type(&def.body, &def.ret, &type_param_set);
        let guard_prefix = if step_limit.is_some() {
            "__rb_tick();\\n    "
        } else {
            ""
        };
        const FN_ALLOWS: &str = "unused_variables, unused_parens, unreachable_patterns, irrefutable_let_patterns, clippy::let_and_return, clippy::double_parens, clippy::unnecessary_cast, clippy::clone_on_copy, clippy::match_like_matches_macro";

        // Variants to emit: the public function (total when marked), plus a private
        // \`Option\` shadow when an unmarked def is called from a total function.
        let mut variants = vec![(rust_ident(&def.name), def.total, true)];
        if !def.total && total_cone.contains(&def.name) {
            variants.push((rust_ident(&total_fn_name(def)), true, false));
        }
        for (fn_name, total, public) in variants {
            let ops = RefCell::new(Vec::new());
            let ctx = EmitCtx {
                defs: &def_map,
                type_env,
                clone_vars: &clone_vars,
                has_generics,
                total,
                total_cone: &total_cone,
                panic_ops: &ops,
            };
            let body_expr = emit_expr_with_ctx(&def.body, &ctx, default_mode)?;
            if public {
                for op in ops.into_inner() {
                    panic_sites.push(PanicSite {
                        function: def.name.clone(),
                        op,
                    });
                }
            }
            if total {
                let (vis, extra_allow) = if public {
                    ("pub ", "")
                } else {
                    ("", "dead_code, ")
                };
                blocks.push(format!(
                    "#[inline]\\n#[allow({extra_allow}{FN_ALLOWS}, clippy::needless_question_mark, clippy::question_mark, clippy::unnecessary_lazy_evaluations)]\\n{vis}fn {fn_name}{generics}({rust_params}) -> Option<{ret_ty}> {{\\n    {guard_prefix}Some({body_expr})\\n}}"
                ));
            } else {
                blocks.push(format!(
                    "#[inline]\\n#[allow({FN_ALLOWS})]\\npub fn {fn_name}{generics}({rust_params}) -> {ret_ty} {{\\n    {guard_prefix}{body_expr}\\n}}"
                ));
            }
        }
    }

    let mut out = String::new();
    out.push_str("// @generated by rusty-bends-build v1 (Verified Core -> Pure Rust)\\n");
    out.push_str("// Zero Bend runtime. Zero proof code. All q=0 types and laws were erased.\\n");
    out.push_str(&format!(
        "// Types: {} | Verified laws: {laws_verified} | Defs emitted: {} | Dead params erased: {dead_params_erased}\\n\\n",
        types.len(),
        defs.len()
    ));

    if blocks.is_empty() {
        out.push_str("// No live definitions found in verified/*.bend\\n");
    } else {
        out.push_str(&blocks.join("\\n\\n"));
        out.push('\\n');
    }

    Ok(EmitSummary {
        rust_source: out,
        types_emitted: types.len(),
        defs_emitted: defs.len(),
        dead_params_erased,
        panic_sites,
    })
}

fn is_valid_alias_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn parse_import_alias_line(raw_line: &str) -> Option<String> {
    if raw_line.starts_with(|c: char| c.is_whitespace() && c != '\\r') {
        return None;
    }
    let clean = strip_comment(raw_line).trim();
    let parts: Vec<&str> = clean.split_whitespace().collect();
    if parts.len() == 4
        && parts[0] == "import"
        && parts[1].ends_with(".bend")
        && parts[2] == "as"
        && is_valid_alias_ident(parts[3])
        && parts[3] != "Base"
    {
        Some(parts[3].to_string())
    } else {
        None
    }
}

/// Parses unindented \`import <path>.bend as <Alias>\` directives from a Bend 2 source file.
pub fn parse_import_aliases(source: &str) -> HashSet<String> {
    let mut aliases = HashSet::new();
    for raw in source.lines() {
        if let Some(alias) = parse_import_alias_line(raw) {
            aliases.insert(alias);
        }
    }
    aliases
}

fn split_code_and_comment(line: &str) -> (&str, &str) {
    let bytes = line.as_bytes();
    let mut i = 0usize;
    let mut in_string = false;
    while i < bytes.len() {
        if in_string {
            if bytes[i] == b'\\\\' && i + 1 < bytes.len() {
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                in_string = false;
            }
            let ch = line[i..].chars().next().unwrap();
            i += ch.len_utf8();
            continue;
        }
        if bytes[i] == b'"' {
            in_string = true;
            i += 1;
            continue;
        }
        if bytes[i] == b'#' || (bytes[i] == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-') {
            return (&line[..i], &line[i..]);
        }
        let ch = line[i..].chars().next().unwrap();
        i += ch.len_utf8();
    }
    (line, "")
}

fn strip_aliases_in_code(code: &str, aliases: &HashSet<String>) -> String {
    let bytes = code.as_bytes();
    let mut out = String::with_capacity(code.len());
    let mut i = 0usize;
    let mut in_string = false;

    while i < bytes.len() {
        if in_string {
            if bytes[i] == b'\\\\' && i + 1 < bytes.len() {
                out.push(bytes[i] as char);
                let next_ch = code[i + 1..].chars().next().unwrap();
                out.push(next_ch);
                i += 1 + next_ch.len_utf8();
                continue;
            }
            if bytes[i] == b'"' {
                in_string = false;
            }
            let ch = code[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        if bytes[i] == b'"' {
            in_string = true;
            out.push('"');
            i += 1;
            continue;
        }
        let prev_is_ident_or_dot = i > 0
            && (bytes[i - 1].is_ascii_alphanumeric()
                || bytes[i - 1] == b'_'
                || bytes[i - 1] == b'.');
        if !prev_is_ident_or_dot && (bytes[i].is_ascii_alphabetic() || bytes[i] == b'_') {
            let seg_start = i;
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let seg = &code[seg_start..i];
            if aliases.contains(seg)
                && i + 1 < bytes.len()
                && bytes[i] == b'.'
                && (bytes[i + 1].is_ascii_alphabetic() || bytes[i + 1] == b'_')
            {
                i += 1;
                let next_start = i;
                i += 1;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                    i += 1;
                }
                out.push_str(&code[next_start..i]);
                continue;
            }
            out.push_str(seg);
            continue;
        }
        let ch = code[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Resolves sibling \`.bend\` import aliases (\`import foo.bend as X\`) within a single file's
/// source by dropping the import directive line and stripping \`X.\` qualifiers from code tokens,
/// leaving comments and string literals untouched. Idempotent by construction.
pub fn resolve_import_aliases(source: &str) -> String {
    let aliases = parse_import_aliases(source);
    if aliases.is_empty() {
        return source.to_string();
    }
    let mut out_lines = Vec::new();
    for raw in source.split('\\n') {
        let line = raw.strip_suffix('\\r').unwrap_or(raw);
        let cr = if raw.ends_with('\\r') { "\\r" } else { "" };
        if parse_import_alias_line(line).is_some() {
            out_lines.push(cr.to_string());
            continue;
        }
        let (code, comment) = split_code_and_comment(line);
        let rewritten = strip_aliases_in_code(code, &aliases);
        out_lines.push(format!("{rewritten}{comment}{cr}"));
    }
    out_lines.join("\\n")
}

pub fn parse_book_items(source: &str) -> Result<(Vec<TypeDef>, Vec<Def>), String> {
    let resolved = resolve_import_aliases(source);
    let source = resolved.as_str();
    // Pass 1: Collect all law names so real Bend 2 proof definitions ('def <law_name>(...):')
    // are recognized as q=0 proofs and completely erased before Rust emission.
    let mut law_names: HashSet<String> = HashSet::new();
    for raw in source.lines() {
        let stripped = strip_comment(raw).trim();
        if let Some(rest) = stripped.strip_prefix("law ") {
            if let Some(name) = rest
                .split(|c: char| c == ':' || c == '(' || c.is_whitespace())
                .next()
            {
                if !name.is_empty() {
                    law_names.insert(name.to_string());
                }
            }
        }
    }

    let mut types = Vec::new();
    let mut defs = Vec::new();
    let lines: Vec<&str> = source.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        let stripped = strip_comment(lines[i]).trim();
        if stripped.is_empty() || stripped.starts_with("import ") {
            i += 1;
            continue;
        }

        // Laws and legacy proof blocks are q=0: verified by Bend CLI, erased before Rust codegen
        if stripped.starts_with("law ") || stripped.starts_with("proof ") {
            i += 1;
            while i < lines.len() {
                let clean = strip_comment(lines[i]);
                let trimmed = clean.trim();
                if trimmed.is_empty() {
                    i += 1;
                    continue;
                }
                if is_top_level_start(lines[i], trimmed) {
                    break;
                }
                i += 1;
            }
            continue;
        }

        if let Some(rest) = stripped.strip_prefix("type ") {
            let (header_part, inline_variants) = split_header_colon(rest)?;
            let name_part = header_part
                .split_whitespace()
                .next()
                .unwrap_or(header_part)
                .trim();
            let mut variant_lines = Vec::new();
            if !inline_variants.is_empty() {
                for piece in inline_variants.split('|') {
                    if !piece.trim().is_empty() {
                        variant_lines.push(piece.trim().to_string());
                    }
                }
            }
            i += 1;
            while i < lines.len() {
                let raw = lines[i];
                let clean = strip_comment(raw);
                let trimmed = clean.trim();
                if trimmed.is_empty() {
                    i += 1;
                    continue;
                }
                if is_top_level_start(raw, trimmed) {
                    break;
                }
                for piece in trimmed.trim_start_matches('|').split('|') {
                    if !piece.trim().is_empty() {
                        variant_lines.push(piece.trim().to_string());
                    }
                }
                i += 1;
            }
            let variants = variant_lines
                .iter()
                .map(|v| parse_variant(v))
                .collect::<Result<Vec<_>, _>>()?;
            types.push(TypeDef {
                name: name_part.to_string(),
                variants,
            });
            continue;
        }

        if stripped.starts_with("def ") {
            let total = has_total_marker(&lines, i);
            // Bend 2 allows the parameter list (and an equality return type) to span lines:
            //   def f(
            //     +a: Nat,
            //     b: Nat
            //   ) -> Bool:
            let (header, last_header_line) = collect_header(&lines, i);
            i = last_header_line;
            let rest = &header["def ".len()..];
            let (header_part, inline_body) = split_header_colon(rest)?;
            let mut body_lines = Vec::new();
            if !inline_body.is_empty() {
                body_lines.push(inline_body.to_string());
            }
            i += 1;
            while i < lines.len() {
                let raw = lines[i];
                let clean = strip_comment(raw);
                let trimmed = clean.trim();
                if trimmed.is_empty() {
                    i += 1;
                    continue;
                }
                if is_top_level_start(raw, trimmed) {
                    break;
                }
                body_lines.push(clean.trim_end().to_string());
                i += 1;
            }

            let body = body_lines.join("\\n");

            // Real Bend 2 proof and type-level definitions (matching law names, equality
            // return types '{...}', Type/Data/Empty/Kind return types, equality/Empty proof
            // arguments, or body '{==}' without '->') are q=0 and erased before codegen.
            if is_erased_proof_or_type_def(header_part, &body, &law_names) {
                continue;
            }

            if body.trim().is_empty() {
                return Err(format!(
                    "[E_EMIT_EMPTY_BODY] Empty body in 'def {header_part}'"
                ));
            }
            let mut def = parse_def_header(header_part, body)?;
            def.total = total;
            defs.push(def);
            continue;
        }

        i += 1;
    }

    Ok((types, defs))
}

/// Every def reachable from a \`# rusty-bends: total\` def (including the total defs themselves).
/// Each needs an \`Option\`-returning variant so overflow anywhere below a total function
/// propagates as \`None\` instead of panicking.
pub(crate) fn total_def_cone(defs: &[Def], def_map: &HashMap<String, &Def>) -> HashSet<String> {
    let mut cone = HashSet::new();
    let mut queue: VecDeque<String> = defs
        .iter()
        .filter(|d| d.total)
        .map(|d| d.name.clone())
        .collect();
    while let Some(name) = queue.pop_front() {
        if !cone.insert(name.clone()) {
            continue;
        }
        if let Some(def) = def_map.get(&name) {
            for tok in crate::lock::tokenize_bend(&def.body) {
                if def_map.contains_key(&tok) && !cone.contains(&tok) {
                    queue.push_back(tok);
                }
            }
        }
    }
    cone
}

/// The comment line that opts a \`def\` into non-panicking \`Option<T>\` emission.
pub const TOTAL_MARKER: &str = "rusty-bends: total";

/// True when the contiguous comment block directly above \`lines[def_idx]\` contains
/// \`# rusty-bends: total\` (blank or non-comment lines end the block).
pub(crate) fn has_total_marker(lines: &[&str], def_idx: usize) -> bool {
    let mut k = def_idx;
    while k > 0 {
        let prev = lines[k - 1].trim();
        let body = if let Some(rest) = prev.strip_prefix('#') {
            rest
        } else if let Some(rest) = prev.strip_prefix("--") {
            rest
        } else {
            return false;
        };
        if body.trim().eq_ignore_ascii_case(TOTAL_MARKER) {
            return true;
        }
        k -= 1;
    }
    false
}

fn is_erased_proof_or_type_def(header_part: &str, body: &str, law_names: &HashSet<String>) -> bool {
    let def_name = header_part.split('(').next().unwrap_or("").trim();
    if law_names.contains(def_name) {
        return true;
    }

    let mut params_raw = "";
    let mut tail = header_part;
    if let Some(open) = header_part.find('(') {
        let mut depth = 0i32;
        let mut close = None;
        for (idx, ch) in header_part[open..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(open + idx);
                        break;
                    }
                }
                _ => {}
            }
        }
        if let Some(c) = close {
            params_raw = header_part[open + 1..c].trim();
            tail = header_part[c + 1..].trim();
        }
    }

    if let Some(ret) = tail.strip_prefix("->").map(str::trim) {
        if ret.starts_with('{')
            || matches!(ret, "Type" | "Data" | "Empty" | "*0" | "*1" | "*2")
            || ret.starts_with("Kind(")
            || (ret.contains('{') && ret.contains("=="))
        {
            return true;
        }
    } else if body.contains("{==}") {
        return true;
    }

    if !params_raw.is_empty() {
        for chunk in split_type_args(params_raw, ',') {
            let item = chunk.trim();
            if item.is_empty() {
                continue;
            }
            if let Some((lhs, ty)) = split_type_args_once(item, ':') {
                let lhs = lhs.trim();
                let ty = ty.trim();
                if !lhs.starts_with('-') && (ty.starts_with('{') || ty == "Empty") {
                    return true;
                }
            }
        }
    }

    false
}

fn parse_variant(raw: &str) -> Result<Variant, String> {
    let s = raw.trim().trim_end_matches(',');
    let (open_ch, close_ch) = if s.contains('{') && s.ends_with('}') {
        ('{', '}')
    } else if s.contains('(') && s.ends_with(')') {
        ('(', ')')
    } else {
        return Ok(Variant {
            name: s.to_string(),
            field_types: Vec::new(),
        });
    };

    let open = s.find(open_ch).unwrap();
    if !s.ends_with(close_ch) {
        return Err(format!("[E_EMIT_SYNTAX] Unclosed variant '{s}'"));
    }
    let name = s[..open].trim().to_string();
    let inner = s[open + 1..s.len() - 1].trim();
    let mut field_types = Vec::new();
    if !inner.is_empty() {
        for part in split_type_args(inner, ',') {
            let p = part.trim();
            if p.is_empty() {
                continue;
            }
            if let Some((_fname, fty)) = split_type_args_once(p, ':') {
                field_types.push(fty.trim().to_string());
            } else {
                field_types.push(p.to_string());
            }
        }
    }
    Ok(Variant { name, field_types })
}

pub(crate) fn is_top_level_start(raw_line: &str, trimmed: &str) -> bool {
    let not_indented = !raw_line.starts_with(' ') && !raw_line.starts_with('\\t');
    not_indented
        && (trimmed.starts_with("import ")
            || trimmed.starts_with("type ")
            || trimmed.starts_with("def ")
            || trimmed.starts_with("law ")
            || trimmed.starts_with("proof "))
}

pub(crate) fn strip_comment(line: &str) -> &str {
    let mut end = line.len();
    if let Some(pos) = line.find('#') {
        end = end.min(pos);
    }
    if let Some(pos) = line.find("--") {
        end = end.min(pos);
    }
    &line[..end]
}

/// Net bracket depth change of a (comment-stripped) source fragment, over '()', '{}' and '[]'.
fn bracket_depth_delta(s: &str) -> i32 {
    s.chars().fold(0, |depth, ch| match ch {
        '(' | '{' | '[' => depth + 1,
        ')' | '}' | ']' => depth - 1,
        _ => depth,
    })
}

/// Joins a top-level item header starting at 'lines[start]' with its continuation lines
/// while any '(' / '{' / '[' is still open, so multi-line parameter lists parse like
/// single-line ones. Returns the flattened, comment-stripped header and the index of the
/// last line it consumed.
fn collect_header(lines: &[&str], start: usize) -> (String, usize) {
    let mut header = strip_comment(lines[start]).trim().to_string();
    let mut depth = bracket_depth_delta(&header);
    let mut last = start;
    while depth > 0 && last + 1 < lines.len() {
        last += 1;
        let piece = strip_comment(lines[last]).trim();
        if piece.is_empty() {
            continue;
        }
        if !header.ends_with('(') && !header.ends_with('{') && !header.ends_with('[') {
            header.push(' ');
        }
        header.push_str(piece);
        depth += bracket_depth_delta(piece);
    }
    (header, last)
}

fn split_header_colon(rest: &str) -> Result<(&str, &str), String> {
    let mut depth = 0i32;
    for (idx, ch) in rest.char_indices() {
        match ch {
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            ':' if depth == 0 => {
                return Ok((rest[..idx].trim(), rest[idx + 1..].trim()));
            }
            _ => {}
        }
    }
    Err(format!("[E_EMIT_SYNTAX] Missing ':' in header '{rest}'"))
}

fn parse_def_header(header: &str, body: String) -> Result<Def, String> {
    let open = header
        .find('(')
        .ok_or_else(|| format!("[E_EMIT_SYNTAX] Missing '(' in 'def {header}'"))?;
    let name = header[..open].trim().to_string();

    let mut depth = 0i32;
    let mut close = None;
    for (idx, ch) in header[open..].char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(open + idx);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close.ok_or_else(|| format!("[E_EMIT_SYNTAX] Unclosed '(' in 'def {header}'"))?;
    let params_raw = header[open + 1..close].trim();
    let tail = header[close + 1..].trim();
    let ret = tail
        .strip_prefix("->")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "Nat".to_string());

    let mut params = Vec::new();
    if !params_raw.is_empty() {
        for chunk in split_type_args(params_raw, ',') {
            let item = chunk.trim();
            if item.is_empty() {
                continue;
            }
            let (lhs, ty) = split_type_args_once(item, ':')
                .ok_or_else(|| format!("[E_EMIT_SYNTAX] Invalid param '{item}' in 'def {name}'"))?;
            let lhs = lhs.trim();
            let (q, pname) = if let Some(stripped) = lhs.strip_prefix('-') {
                (Quantity::Dead, stripped.trim())
            } else if let Some(stripped) = lhs.strip_prefix('+') {
                (Quantity::Data, stripped.trim())
            } else {
                (Quantity::Live, lhs)
            };
            params.push(Param {
                q,
                name: pname.to_string(),
                ty: ty.trim().to_string(),
            });
        }
    }

    Ok(Def {
        name,
        params,
        ret,
        body,
        total: false,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArithMode {
    NatChecked,
    Wrapping,
}

pub(crate) fn arith_mode_for_type(ty: &str, fallback: ArithMode) -> ArithMode {
    match ty.trim() {
        "U32" | "U64" | "I32" | "I64" => ArithMode::Wrapping,
        "Nat" => ArithMode::NatChecked,
        _ => fallback,
    }
}

pub(crate) fn bend_type_to_rust(ty: &str, type_params: &HashSet<String>) -> String {
    let t = ty.trim();
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
        if parts.len() > 1 {
            let mapped = parts
                .into_iter()
                .map(|p| bend_type_to_rust(p, type_params))
                .collect::<Vec<_>>()
                .join(", ");
            return format!("({mapped})");
        }
        return bend_type_to_rust(inner, type_params);
    }
    let amp_parts = split_type_args(t, '&');
    if amp_parts.len() > 1 {
        let mapped = amp_parts
            .into_iter()
            .map(|p| bend_type_to_rust(p, type_params))
            .collect::<Vec<_>>()
            .join(", ");
        return format!("({mapped})");
    }
    if let Some(elem) = parse_list_elem_type(t) {
        return format!("List<{}>", bend_type_to_rust(elem, type_params));
    }
    match t {
        "Nat" | "U64" => "u64".to_string(),
        "U32" => "u32".to_string(),
        "I32" => "i32".to_string(),
        "I64" => "i64".to_string(),
        "Bool" => "bool".to_string(),
        "Unit" | "()" => "()".to_string(),
        _ if type_params.contains(t) => t.to_string(),
        _ => t.to_string(),
    }
}

fn infer_return_type(body: &str, declared_ret: &str, type_params: &HashSet<String>) -> String {
    let trimmed = unwrap_outer_parens(body.trim());
    if !trimmed.contains('\\n')
        && !trimmed.starts_with("match ")
        && !trimmed.starts_with("if ")
        && !trimmed.starts_with("let ")
        && split_top_level(trimmed, ',').len() == 2
        && !declared_ret.trim().starts_with('(')
        && !declared_ret.contains('&')
    {
        let elem = bend_type_to_rust(declared_ret, type_params);
        return format!("({elem}, {elem})");
    }
    bend_type_to_rust(declared_ret, type_params)
}

enum NatPattern {
    Const(u64),
    Succ { offset: u64, var: String },
}

/// Rust strict, reserved and edition-reserved keywords. A Bend name that equals one of
/// these is legal in Bend but must never be emitted as a bare Rust identifier.
/// \`true\`/\`false\` are left out: they are Bend literals too and must stay literals.
const RUST_KEYWORDS: &[&str] = &[
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern",
    "fn", "for", "gen", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
    "ref", "return", "self", "Self", "static", "struct", "super", "trait", "try", "type", "unsafe",
    "use", "where", "while", "abstract", "become", "box", "do", "final", "macro", "override",
    "priv", "typeof", "unsized", "virtual", "yield",
];

/// Keywords that cannot be written as raw identifiers (\`r#self\` is rejected by rustc).
const NON_RAW_KEYWORDS: &[&str] = &["self", "Self", "super", "crate"];

/// Maps a Bend identifier to a Rust identifier that cannot clash with a Rust keyword:
/// \`as\` becomes \`r#as\`, and \`self\`/\`Self\`/\`super\`/\`crate\` become \`__rb_self\` and so on.
/// Every place that turns a Bend value name (def, parameter, binder, law variable) into
/// Rust source must go through this (or [\`rust_path\`]).
pub(crate) fn rust_ident(name: &str) -> String {
    if NON_RAW_KEYWORDS.contains(&name) {
        format!("__rb_{name}")
    } else if RUST_KEYWORDS.contains(&name) {
        format!("r#{name}")
    } else {
        name.to_string()
    }
}

/// Like [\`rust_ident\`] for a dotted Bend path (\`Mod.name\` -> \`Mod::name\`), escaping each
/// segment.
pub(crate) fn rust_path(path: &str) -> String {
    path.split('.')
        .map(rust_ident)
        .collect::<Vec<_>>()
        .join("::")
}

fn is_valid_rust_ident_or_wildcard(s: &str) -> bool {
    if s == "_" {
        return true;
    }
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn parse_nat_succ_pattern(p: &str) -> Result<Option<NatPattern>, String> {
    let mut cur = unwrap_outer_parens(p.trim());
    let mut offset: u64 = 0;
    let mut saw_succ = false;

    while let Some((lhs, rhs)) = split_top_level_once(cur, '+') {
        let lhs_trim = unwrap_outer_parens(lhs.trim());
        if lhs_trim.is_empty() {
            // Leading '+' on a Data binder like \`+q\` (or inside \`1n++q\`) leaves an empty LHS.
            break;
        }
        let Some(digits) = lhs_trim.strip_suffix('n') else {
            if saw_succ {
                return Err(format!(
                    "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported nested Nat pattern '{p}'"
                ));
            }
            return Ok(None);
        };
        if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
            if saw_succ {
                return Err(format!(
                    "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported nested Nat pattern '{p}'"
                ));
            }
            return Ok(None);
        }
        let k: u64 = digits.parse().map_err(|_| {
            format!("[E_EMIT_UNSUPPORTED_PATTERN] Nat literal overflow in pattern '{p}'")
        })?;
        offset = offset.checked_add(k).ok_or_else(|| {
            format!("[E_EMIT_UNSUPPORTED_PATTERN] Nat offset overflow in pattern '{p}'")
        })?;
        saw_succ = true;
        cur = unwrap_outer_parens(rhs.trim());
    }

    if !saw_succ {
        return Ok(None);
    }

    if let Some(digits) = cur.strip_suffix('n') {
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            let tail_k: u64 = digits.parse().map_err(|_| {
                format!("[E_EMIT_UNSUPPORTED_PATTERN] Nat literal overflow in pattern '{p}'")
            })?;
            let total = offset.checked_add(tail_k).ok_or_else(|| {
                format!("[E_EMIT_UNSUPPORTED_PATTERN] Nat offset overflow in pattern '{p}'")
            })?;
            return Ok(Some(NatPattern::Const(total)));
        }
    }

    let var = cur.trim_start_matches('+').trim_start_matches('-').trim();
    if !is_valid_rust_ident_or_wildcard(var) {
        return Err(format!(
            "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported successor tail '{cur}' in pattern '{p}'"
        ));
    }

    Ok(Some(NatPattern::Succ {
        offset,
        var: var.to_string(),
    }))
}

#[derive(Default)]
struct PatState {
    succ_counter: usize,
    box_counter: usize,
    guard_counter: usize,
    bindings: Vec<String>,
    guards: Vec<String>,
    bound_vars: Vec<(String, Option<String>)>,
}

fn is_nat_literal(s: &str) -> bool {
    s.strip_suffix('n')
        .is_some_and(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
}

fn is_plain_binder_ident(s: &str, ctors: &HashMap<String, CtorInfo>) -> bool {
    !matches!(
        s,
        "_" | "true" | "false" | "True{}" | "False{}" | "Unit{}" | "()" | "[]"
    ) && !is_nat_literal(s)
        && !ctors.contains_key(s)
        && !s.contains('.')
        && is_valid_rust_ident_or_wildcard(s)
}

fn split_expected_tuple_types(expected_ty: Option<&str>) -> Option<Vec<&str>> {
    let t = expected_ty?.trim();
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
        if parts.len() > 1 {
            return Some(parts);
        }
        return split_expected_tuple_types(Some(inner));
    }
    let amp = split_type_args(t, '&');
    if amp.len() > 1 {
        return Some(amp);
    }
    None
}

fn emit_pattern_guard(
    pat: &str,
    target: &str,
    ctors: &HashMap<String, CtorInfo>,
    guard_counter: &mut usize,
) -> Result<String, String> {
    let p = pat.trim();
    if p == "_" || p == "Unit{}" || p == "()" {
        return Ok("true".to_string());
    }
    if p == "true" || p == "True{}" {
        return Ok(format!("matches!({target}, true)"));
    }
    if p == "false" || p == "False{}" {
        return Ok(format!("matches!({target}, false)"));
    }
    if p == "[]" {
        return Ok(format!("matches!({target}, List::Nil)"));
    }
    if let Some(nat_pat) = parse_nat_succ_pattern(p)? {
        return Ok(match nat_pat {
            NatPattern::Const(total) => format!("matches!({target}, {total}_u64)"),
            NatPattern::Succ { offset: 0, .. } => "true".to_string(),
            NatPattern::Succ { offset, .. } => {
                format!("matches!({target}, {offset}_u64..=u64::MAX)")
            }
        });
    }
    if let Some(digits) = p.strip_suffix('n') {
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            return Ok(format!("matches!({target}, {digits}_u64)"));
        }
    }
    if is_wrapped_in_parens(p) {
        let inner = p[1..p.len() - 1].trim();
        let parts = split_top_level(inner, ',');
        if parts.len() > 1 {
            let mut vars = Vec::with_capacity(parts.len());
            let mut sub_guards = Vec::with_capacity(parts.len());
            for part in parts {
                let gv = format!("__rb_g{}", *guard_counter);
                *guard_counter += 1;
                let sg = emit_pattern_guard(part, &gv, ctors, guard_counter)?;
                vars.push(gv);
                sub_guards.push(sg);
            }
            return Ok(format!(
                "match {target} {{ ({}) => {} }}",
                vars.join(", "),
                sub_guards.join(" && ")
            ));
        }
    }
    if let Some((head, inner, is_curly)) = split_ctor_pattern(p)? {
        let info_opt = ctors.get(head);
        let rust_head = resolve_ctor_path(head, ctors);
        if inner.is_empty() {
            return Ok(format!("matches!({target}, {rust_head})"));
        }
        let parts = split_top_level(inner, ',');
        let mut vars = Vec::with_capacity(parts.len());
        let mut sub_guards = Vec::with_capacity(parts.len());
        for (idx, part) in parts.iter().enumerate() {
            let rhs = extract_ctor_pattern_field_rhs(part, is_curly);
            let is_boxed = info_opt
                .and_then(|i| i.boxed_fields.get(idx).copied())
                .unwrap_or(false);
            let gv = format!("__rb_g{}", *guard_counter);
            *guard_counter += 1;
            let sub_target = if is_boxed {
                format!("&**{gv}")
            } else {
                gv.clone()
            };
            let sg = emit_pattern_guard(rhs, &sub_target, ctors, guard_counter)?;
            vars.push(gv);
            sub_guards.push(sg);
        }
        return Ok(format!(
            "match {target} {{ {rust_head}({}) => {}, _ => false }}",
            vars.join(", "),
            sub_guards.join(" && ")
        ));
    }
    let clean = p.trim_start_matches('+').trim_start_matches('-').trim();
    if is_plain_binder_ident(clean, ctors) {
        return Ok("true".to_string());
    }
    if clean.is_empty() || !clean.split('.').all(is_valid_rust_ident_or_wildcard) {
        return Err(format!(
            "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported match pattern '{p}'"
        ));
    }
    let rust_head = resolve_ctor_path(clean, ctors);
    Ok(format!("matches!({target}, {rust_head})"))
}

fn split_ctor_pattern(p: &str) -> Result<Option<(&str, &str, bool)>, String> {
    if let Some(open) = p.find('{') {
        if p.ends_with('}') {
            let head = p[..open].trim();
            if !is_valid_path_ident(head) {
                return Err(format!(
                    "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported constructor pattern '{p}'"
                ));
            }
            return Ok(Some((head, p[open + 1..p.len() - 1].trim(), true)));
        }
    }
    if let Some(open) = p.find('(') {
        if p.ends_with(')') {
            let head = p[..open].trim();
            if !is_valid_path_ident(head) {
                return Err(format!(
                    "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported constructor pattern '{p}'"
                ));
            }
            return Ok(Some((head, p[open + 1..p.len() - 1].trim(), false)));
        }
    }
    Ok(None)
}

fn extract_ctor_pattern_field_rhs(raw: &str, is_curly: bool) -> &str {
    let clean = raw
        .trim()
        .trim_start_matches('+')
        .trim_start_matches('-')
        .trim();
    if is_curly {
        if let Some((_, v)) = split_top_level_once(clean, ':') {
            return v
                .trim()
                .trim_start_matches('+')
                .trim_start_matches('-')
                .trim();
        }
    }
    clean
}

fn emit_single_pattern(
    pat: &str,
    ctors: &HashMap<String, CtorInfo>,
    expected_ty: Option<&str>,
    state: &mut PatState,
) -> Result<String, String> {
    let p = pat.trim();
    if p == "_" || p == "true" || p == "false" || p == "()" {
        return Ok(p.to_string());
    }
    if p == "True{}" {
        return Ok("true".to_string());
    }
    if p == "False{}" {
        return Ok("false".to_string());
    }
    if p == "Unit{}" {
        return Ok("()".to_string());
    }
    if p == "[]" {
        return Ok("List::Nil".to_string());
    }
    if let Some(nat_pat) = parse_nat_succ_pattern(p)? {
        return match nat_pat {
            NatPattern::Const(total) => Ok(format!("{total}_u64")),
            NatPattern::Succ { offset: 0, var } => {
                if var != "_" {
                    state
                        .bound_vars
                        .push((var.clone(), Some("Nat".to_string())));
                }
                Ok(rust_ident(&var))
            }
            NatPattern::Succ { offset, var } if var == "_" => {
                Ok(format!("{offset}_u64..=u64::MAX"))
            }
            NatPattern::Succ { offset, var } => {
                let idx = state.succ_counter;
                state.succ_counter += 1;
                let tmp = format!("__rb_n{idx}");
                state
                    .bindings
                    .push(format!("let {} = {tmp} - {offset}_u64;", rust_ident(&var)));
                state.bound_vars.push((var, Some("Nat".to_string())));
                Ok(format!("{tmp} @ {offset}_u64..=u64::MAX"))
            }
        };
    }
    if let Some(digits) = p.strip_suffix('n') {
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            return Ok(format!("{digits}_u64"));
        }
    }
    // Tuple pattern: (a, b)
    if is_wrapped_in_parens(p) {
        let inner = p[1..p.len() - 1].trim();
        let parts = split_top_level(inner, ',');
        if parts.len() > 1 {
            let elem_tys = split_expected_tuple_types(expected_ty);
            let mut rust_parts = Vec::new();
            for (idx, part) in parts.iter().enumerate() {
                let sub_ty = elem_tys.as_ref().and_then(|ts| ts.get(idx).copied());
                let rp = emit_single_pattern(part, ctors, sub_ty, state)?;
                rust_parts.push(rp);
            }
            return Ok(format!("({})", rust_parts.join(", ")));
        }
    }
    // Real Bend 2 curly-brace or paren constructor pattern
    if let Some((head, inner, is_curly)) = split_ctor_pattern(p)? {
        let info_opt = ctors.get(head);
        let rust_head = resolve_ctor_path(head, ctors);
        if inner.is_empty() {
            return Ok(rust_head);
        }
        let mut fields = Vec::new();
        for (idx, b) in split_top_level(inner, ',').iter().enumerate() {
            let rhs = extract_ctor_pattern_field_rhs(b, is_curly);
            let is_boxed = info_opt
                .and_then(|i| i.boxed_fields.get(idx).copied())
                .unwrap_or(false);
            let field_ty = info_opt.and_then(|i| i.field_types.get(idx).cloned());
            if !is_boxed {
                fields.push(emit_single_pattern(rhs, ctors, field_ty.as_deref(), state)?);
            } else if rhs == "_" {
                fields.push("_".to_string());
            } else if is_plain_binder_ident(rhs, ctors) {
                let box_tmp = format!("__rb_box{}", state.box_counter);
                state.box_counter += 1;
                state
                    .bindings
                    .push(format!("let {} = *{box_tmp};", rust_ident(rhs)));
                state.bound_vars.push((rhs.to_string(), field_ty));
                fields.push(box_tmp);
            } else {
                let box_tmp = format!("__rb_box{}", state.box_counter);
                state.box_counter += 1;
                let guard = emit_pattern_guard(
                    rhs,
                    &format!("&*{box_tmp}"),
                    ctors,
                    &mut state.guard_counter,
                )?;
                state.guards.push(guard);

                let mut sub_state = PatState {
                    succ_counter: state.succ_counter,
                    box_counter: state.box_counter,
                    guard_counter: state.guard_counter,
                    ..Default::default()
                };
                let inner_pat =
                    emit_single_pattern(rhs, ctors, field_ty.as_deref(), &mut sub_state)?;
                state.succ_counter = sub_state.succ_counter;
                state.box_counter = sub_state.box_counter;
                state.guard_counter = sub_state.guard_counter;
                if !sub_state.bound_vars.is_empty() || !sub_state.bindings.is_empty() {
                    state.bindings.push(format!(
                        "let {inner_pat} = *{box_tmp} else {{ unreachable!() }};"
                    ));
                    state.bindings.extend(sub_state.bindings);
                    state.bound_vars.extend(sub_state.bound_vars);
                }
                fields.push(box_tmp);
            }
        }
        return Ok(format!("{rust_head}({})", fields.join(", ")));
    }
    let clean = p.trim_start_matches('+').trim_start_matches('-').trim();
    if clean.is_empty() || !clean.split('.').all(is_valid_rust_ident_or_wildcard) {
        return Err(format!(
            "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported match pattern '{p}'"
        ));
    }
    if is_plain_binder_ident(clean, ctors) {
        state
            .bound_vars
            .push((clean.to_string(), expected_ty.map(str::to_string)));
        return Ok(rust_ident(clean));
    }
    Ok(resolve_ctor_path(clean, ctors))
}

fn emit_match_pattern(
    pat: &str,
    scrut_count: usize,
    ctors: &HashMap<String, CtorInfo>,
) -> Result<(String, PatState), String> {
    let mut state = PatState::default();
    if scrut_count > 1 {
        let parts = split_pattern_tokens(pat);
        if parts.len() > 1 {
            let mut rust_parts = Vec::new();
            for part in &parts {
                let rp = emit_single_pattern(part, ctors, None, &mut state)?;
                rust_parts.push(rp);
            }
            return Ok((format!("({})", rust_parts.join(", ")), state));
        }
    }
    let rp = emit_single_pattern(pat, ctors, None, &mut state)?;
    Ok((rp, state))
}

fn resolve_ctor_path(name: &str, ctors: &HashMap<String, CtorInfo>) -> String {
    if let Some(info) = ctors.get(name) {
        return format!("{}::{}", info.type_name, info.variant_name);
    }
    name.replace('.', "::")
}

pub(crate) fn leading_indent(line: &str) -> usize {
    line.chars()
        .take_while(|c| *c == ' ' || *c == '\\t')
        .map(|c| if c == '\\t' { 4 } else { 1 })
        .sum()
}

fn clean_let_binding(raw: &str) -> String {
    let t = raw.trim();
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_top_level(inner, ',')
            .into_iter()
            .map(clean_let_binding)
            .collect::<Vec<_>>();
        return format!("({})", parts.join(", "));
    }
    rust_ident(t.trim_start_matches('+').trim_start_matches('-').trim())
}

fn extract_let_bound_names(raw: &str) -> Vec<String> {
    let t = raw.trim();
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        return split_top_level(inner, ',')
            .into_iter()
            .flat_map(extract_let_bound_names)
            .collect();
    }
    let clean = t.trim_start_matches('+').trim_start_matches('-').trim();
    if !clean.is_empty() && clean != "_" && is_valid_rust_ident_or_wildcard(clean) {
        vec![clean.to_string()]
    } else {
        Vec::new()
    }
}

fn is_obviously_copy_expr(expr: &str) -> bool {
    let s = expr.trim();
    s == "True{}"
        || s == "False{}"
        || s == "Unit{}"
        || s == "()"
        || is_nat_literal(s)
        || s.starts_with("Nat.is_")
        || s.starts_with("Nat.add(")
        || s.starts_with("Nat.sub(")
        || s.starts_with("Nat.mul(")
        || s.starts_with("Nat.div(")
        || s.starts_with("Nat.mod(")
        || s.starts_with("Nat.min(")
        || s.starts_with("Nat.max(")
        || s.starts_with("Nat.succ(")
        || s.starts_with("Nat.pred(")
        || s.starts_with("Bool.")
}

pub(crate) fn count_ident_uses(src: &str, name: &str) -> usize {
    if name.is_empty() {
        return 0;
    }
    let bytes = src.as_bytes();
    let nbytes = name.as_bytes();
    let mut count = 0usize;
    let mut i = 0usize;
    let mut in_string = false;

    while i < bytes.len() {
        if in_string {
            if bytes[i] == b'\\\\' && i + 1 < bytes.len() {
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if bytes[i] == b'"' {
            in_string = true;
            i += 1;
            continue;
        }
        if bytes[i] == b'#' || (bytes[i] == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-') {
            while i < bytes.len() && bytes[i] != b'\\n' {
                i += 1;
            }
            continue;
        }
        if bytes[i..].starts_with(nbytes) {
            let prev_ok = i == 0
                || (!bytes[i - 1].is_ascii_alphanumeric()
                    && bytes[i - 1] != b'_'
                    && bytes[i - 1] != b'.');
            let end = i + nbytes.len();
            let next_ok =
                end == bytes.len() || (!bytes[end].is_ascii_alphanumeric() && bytes[end] != b'_');
            if prev_ok && next_ok {
                count += 1;
                i = end;
                continue;
            }
        }
        i += 1;
    }
    count
}

fn split_top_level_ws(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start: Option<usize> = None;
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' | '[' => {
                if start.is_none() {
                    start = Some(idx);
                }
                depth += 1;
            }
            ')' | '}' | ']' => {
                depth -= 1;
            }
            c if c.is_whitespace() && depth == 0 => {
                if let Some(st) = start.take() {
                    out.push(&s[st..idx]);
                }
            }
            _ => {
                if start.is_none() {
                    start = Some(idx);
                }
            }
        }
    }
    if let Some(st) = start {
        out.push(&s[st..]);
    }
    out
}

fn split_match_scrutinees(scrut: &str) -> Vec<&str> {
    let tokens = split_top_level_ws(scrut.trim());
    if tokens.len() <= 1 {
        return tokens;
    }
    let has_op_or_kw = tokens.iter().any(|t| {
        matches!(
            *t,
            "+" | "-"
                | "*"
                | "/"
                | "%"
                | "=="
                | "!="
                | "<"
                | ">"
                | "<="
                | ">="
                | "&&"
                | "||"
                | "if"
                | "let"
                | "match"
                | "else:"
        )
    });
    if has_op_or_kw {
        vec![scrut.trim()]
    } else {
        tokens
    }
}

fn split_pattern_tokens(pat: &str) -> Vec<String> {
    let raw = split_top_level_ws(pat.trim());
    let mut out = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let mut cur = raw[i].to_string();
        while i + 2 < raw.len() && cur.ends_with('n') && raw[i + 1] == "+" {
            cur.push('+');
            cur.push_str(raw[i + 2]);
            i += 2;
        }
        out.push(cur);
        i += 1;
    }
    out
}

fn parse_indented_case_arms(lines: &[&str]) -> Vec<(String, String)> {
    let Some(case_indent) = lines
        .iter()
        .find(|l| l.trim_start().starts_with("case "))
        .map(|l| leading_indent(l))
    else {
        return Vec::new();
    };

    let mut arms: Vec<(String, String)> = Vec::new();
    let mut cur_pat: Option<String> = None;
    let mut cur_body: Vec<String> = Vec::new();

    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if leading_indent(line) == case_indent && trimmed.starts_with("case ") {
            if let Some(prev_pat) = cur_pat.take() {
                arms.push((prev_pat, cur_body.join("\\n")));
                cur_body.clear();
            }
            let after_case = trimmed.strip_prefix("case ").unwrap().trim();
            if let Some((pat, inline_body)) = split_case_arm(after_case) {
                cur_pat = Some(pat.trim().to_string());
                if !inline_body.trim().is_empty() {
                    cur_body.push(inline_body.trim().to_string());
                }
            }
        } else if cur_pat.is_some() {
            cur_body.push((*line).to_string());
        }
    }
    if let Some(prev_pat) = cur_pat.take() {
        arms.push((prev_pat, cur_body.join("\\n")));
    }
    arms
}

#[derive(Clone, Copy)]
pub(crate) struct EmitCtx<'a> {
    pub(crate) defs: &'a HashMap<String, &'a Def>,
    pub(crate) type_env: &'a TypeEnv,
    pub(crate) clone_vars: &'a HashSet<String>,
    pub(crate) has_generics: bool,
    /// Emitting an \`Option<T>\` body: overflow and total calls propagate \`None\` with \`?\`.
    pub(crate) total: bool,
    /// Defs with an \`Option\`-returning variant (\`# rusty-bends: total\` defs and their callees).
    pub(crate) total_cone: &'a HashSet<String>,
    /// Records each panicking checked-growth op emitted (ignored in total mode).
    pub(crate) panic_ops: &'a RefCell<Vec<String>>,
}

const OVERFLOW_EXPECT: &str = ".expect(\\"rusty-bends: Nat overflow\\")";

impl EmitCtx<'_> {
    /// Suffix for a \`checked_*\` result: \`?\` in total mode, otherwise a recorded panic site.
    fn overflow(&self, op: &str) -> &'static str {
        if self.total {
            "?"
        } else {
            self.panic_ops.borrow_mut().push(op.to_string());
            OVERFLOW_EXPECT
        }
    }
}

/// Name of the \`Option\`-returning variant of \`def\`.
pub(crate) fn total_fn_name(def: &Def) -> String {
    if def.total {
        def.name.clone()
    } else {
        format!("__rb_total_{}", def.name)
    }
}

pub(crate) fn emit_expr_with_mode(
    expr: &str,
    defs: &HashMap<String, &Def>,
    type_env: &TypeEnv,
    clone_vars: &HashSet<String>,
    mode: ArithMode,
) -> Result<String, String> {
    let no_cone = HashSet::new();
    let ops = RefCell::new(Vec::new());
    let ctx = EmitCtx {
        defs,
        type_env,
        clone_vars,
        has_generics: false,
        total: false,
        total_cone: &no_cone,
        panic_ops: &ops,
    };
    emit_expr_with_ctx(expr, &ctx, mode)
}

fn emit_expr_with_ctx(expr: &str, ctx: &EmitCtx<'_>, mode: ArithMode) -> Result<String, String> {
    let defs = ctx.defs;
    let ctors = &ctx.type_env.ctor_map;
    let lines: Vec<&str> = expr.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return Ok("()".to_string());
    }

    let first_trim = lines[0].trim();

    // Multi-line let bindings:
    //   let x = expr
    //   body
    if lines.len() > 1
        && first_trim.starts_with("let ")
        && split_top_level_once(first_trim, ';').is_none()
    {
        let let_indent = leading_indent(lines[0]);
        if let Some((lhs_raw, val_first)) =
            split_top_level_once(first_trim.strip_prefix("let ").unwrap(), '=')
        {
            let mut val_lines = Vec::new();
            if !val_first.trim().is_empty() {
                val_lines.push(val_first.trim().to_string());
            }
            let mut split_idx = 1;
            while split_idx < lines.len() && leading_indent(lines[split_idx]) > let_indent {
                val_lines.push(lines[split_idx].to_string());
                split_idx += 1;
            }
            if split_idx < lines.len() {
                let val_src = val_lines.join("\\n");
                let rest_src = lines[split_idx..].join("\\n");
                let mut body_clone_vars = ctx.clone_vars.clone();
                let bound_names = extract_let_bound_names(lhs_raw);
                for b in &bound_names {
                    body_clone_vars.remove(b);
                }
                if !ctx.has_generics
                    && !ctx.type_env.non_copy_types.is_empty()
                    && !is_obviously_copy_expr(&val_src)
                {
                    for b in bound_names {
                        if count_ident_uses(&rest_src, &b) > 1 {
                            body_clone_vars.insert(b);
                        }
                    }
                }
                let body_ctx = EmitCtx {
                    clone_vars: &body_clone_vars,
                    ..*ctx
                };
                return Ok(format!(
                    "{{\\n        let {} = {};\\n        {}\\n    }}",
                    clean_let_binding(lhs_raw),
                    emit_expr_with_ctx(&val_src, ctx, mode)?,
                    emit_expr_with_ctx(&rest_src, &body_ctx, mode)?
                ));
            }
        }
    }

    // Handle match expressions: indentation-aware nested match, multi-scrutinee match, and single-line match
    if let Some(after_match) = first_trim.strip_prefix("match ") {
        if let Some((scrut_raw, inline_arms)) = split_top_level_once(after_match, ':') {
            let scrut_parts = split_match_scrutinees(scrut_raw);
            let rust_scrut = if scrut_parts.len() > 1 {
                let mut emitted = Vec::with_capacity(scrut_parts.len());
                for p in &scrut_parts {
                    emitted.push(emit_expr_with_ctx(p, ctx, mode)?);
                }
                format!("({})", emitted.join(", "))
            } else {
                emit_expr_with_ctx(scrut_raw, ctx, mode)?
            };

            let parsed_arms: Vec<(String, String)> = if lines.len() > 1 {
                parse_indented_case_arms(&lines[1..])
            } else {
                split_case_arms(inline_arms)
                    .into_iter()
                    .filter_map(|chunk| {
                        split_case_arm(&chunk)
                            .map(|(p, b)| (p.trim().to_string(), b.trim().to_string()))
                    })
                    .collect()
            };

            let mut rust_arms = Vec::new();
            let mut any_guarded = false;
            for (pat, arm_body) in parsed_arms {
                let (rust_pat, pat_state) = emit_match_pattern(&pat, scrut_parts.len(), ctors)?;
                let mut arm_clone_vars = ctx.clone_vars.clone();
                for (var, _) in &pat_state.bound_vars {
                    arm_clone_vars.remove(var);
                }
                if !ctx.has_generics {
                    for (var, field_ty) in &pat_state.bound_vars {
                        let maybe_non_copy = match field_ty.as_deref() {
                            Some("_") => !ctx.type_env.non_copy_types.is_empty(),
                            Some(ty) => type_contains_non_copy(ty, &ctx.type_env.non_copy_types),
                            None => false,
                        };
                        if maybe_non_copy && count_ident_uses(&arm_body, var) > 1 {
                            arm_clone_vars.insert(var.clone());
                        }
                    }
                }
                let arm_ctx = EmitCtx {
                    clone_vars: &arm_clone_vars,
                    ..*ctx
                };
                let emitted_body = emit_expr_with_ctx(&arm_body, &arm_ctx, mode)?;
                let guard_clause = if pat_state.guards.is_empty() {
                    String::new()
                } else {
                    any_guarded = true;
                    format!(" if {}", pat_state.guards.join(" && "))
                };
                if pat_state.bindings.is_empty() {
                    rust_arms.push(format!(
                        "        {rust_pat}{guard_clause} => {emitted_body},"
                    ));
                } else {
                    rust_arms.push(format!(
                        "        {rust_pat}{guard_clause} => {{ {} {emitted_body} }},",
                        pat_state.bindings.join(" ")
                    ));
                }
            }
            if any_guarded {
                rust_arms.push("        _ => unreachable!(),".to_string());
            }
            return Ok(format!(
                "match {rust_scrut} {{\\n{}\\n    }}",
                rust_arms.join("\\n")
            ));
        }
    }

    // Collapse remaining multi-line expressions (e.g. multi-line if/else, calls, annotations)
    let owned_flat;
    let s = if lines.len() == 1 {
        first_trim
    } else {
        owned_flat = lines.iter().map(|l| l.trim()).collect::<Vec<_>>().join(" ");
        owned_flat.as_str()
    };

    if s == "True{}" {
        return Ok("true".to_string());
    }
    if s == "False{}" {
        return Ok("false".to_string());
    }
    if s == "Unit{}" || s == "()" {
        return Ok("()".to_string());
    }

    // Handle conditionals: if cond: then_branch else: else_branch
    if let Some(rest) = s.strip_prefix("if ") {
        if let Some((before_else, after_else)) = split_keyword(rest, " else:") {
            if let Some((cond, then_b)) = split_top_level_once(before_else, ':') {
                return Ok(format!(
                    "if {} {{ {} }} else {{ {} }}",
                    emit_expr_with_ctx(cond, ctx, mode)?,
                    emit_expr_with_ctx(then_b, ctx, mode)?,
                    emit_expr_with_ctx(after_else, ctx, mode)?
                ));
            }
        }
    }

    // Unwrap outer parentheses and handle annotations (term : ty) or tuples (a, b, ...)
    if is_wrapped_in_parens(s) {
        let inner = s[1..s.len() - 1].trim();
        let tuple_parts = split_top_level(inner, ',');
        if tuple_parts.len() >= 2 {
            let mut emitted = Vec::with_capacity(tuple_parts.len());
            for p in &tuple_parts {
                emitted.push(emit_expr_with_ctx(p, ctx, mode)?);
            }
            return Ok(format!("({})", emitted.join(", ")));
        }
        if let Some((term_part, ty_part)) = split_top_level_once(inner, ':') {
            let inner_mode = arith_mode_for_type(ty_part, mode);
            return emit_expr_with_ctx(term_part, ctx, inner_mode);
        }
        return emit_expr_with_ctx(inner, ctx, mode);
    }

    // List literal sugar: [] or [e1, e2, ...]
    if is_wrapped_in_brackets(s) {
        let inner = s[1..s.len() - 1].trim();
        if inner.is_empty() {
            return Ok("List::Nil".to_string());
        }
        let elems = split_top_level(inner, ',');
        let mut acc = "List::Nil".to_string();
        for elem in elems.into_iter().rev() {
            let emitted = emit_expr_with_ctx(elem, ctx, mode)?;
            acc = format!("List::Con({emitted}, Box::new({acc}))");
        }
        return Ok(acc);
    }

    // Handle single-line let bindings: let x = val; body
    if let Some(rest) = s.strip_prefix("let ") {
        if let Some((binding, body)) = split_top_level_once(rest, ';') {
            if let Some((name, val)) = split_top_level_once(binding, '=') {
                let mut body_clone_vars = ctx.clone_vars.clone();
                let bound_names = extract_let_bound_names(name);
                for b in &bound_names {
                    body_clone_vars.remove(b);
                }
                if !ctx.has_generics
                    && !ctx.type_env.non_copy_types.is_empty()
                    && !is_obviously_copy_expr(val)
                {
                    for b in bound_names {
                        if count_ident_uses(body, &b) > 1 {
                            body_clone_vars.insert(b);
                        }
                    }
                }
                let body_ctx = EmitCtx {
                    clone_vars: &body_clone_vars,
                    ..*ctx
                };
                return Ok(format!(
                    "{{\\n        let {} = {};\\n        {}\\n    }}",
                    clean_let_binding(name),
                    emit_expr_with_ctx(val, ctx, mode)?,
                    emit_expr_with_ctx(body, &body_ctx, mode)?
                ));
            }
        }
    }

    // Logical and comparison binary operators (lowest to highest precedence)
    for op in ["||", "&&", "==", "!=", "<=", ">=", "<", ">"] {
        if let Some((lhs, rhs)) = split_top_level_str(s, op) {
            return Ok(format!(
                "({} {op} {})",
                emit_expr_with_ctx(lhs, ctx, mode)?,
                emit_expr_with_ctx(rhs, ctx, mode)?
            ));
        }
    }

    // Right-to-left top-level '+' or '-' (checked add / saturating sub for Nat; wrapping for U32/U64/I32/I64)
    if let Some((op, lhs, rhs)) = split_last_additive(s) {
        let l = emit_expr_with_ctx(lhs, ctx, mode)?;
        let r = emit_expr_with_ctx(rhs, ctx, mode)?;
        return Ok(match (mode, op) {
            (ArithMode::NatChecked, '+') => {
                format!("({l}).checked_add({r}){}", ctx.overflow("Nat.add"))
            }
            (ArithMode::NatChecked, '-') => format!("({l}).saturating_sub({r})"),
            (ArithMode::Wrapping, '+') => format!("({l}).wrapping_add({r})"),
            (ArithMode::Wrapping, '-') => format!("({l}).wrapping_sub({r})"),
            _ => unreachable!(),
        });
    }

    // Right-to-left top-level '*', '/', '%'
    if let Some((op, lhs, rhs)) = split_last_multiplicative(s) {
        let l = emit_expr_with_ctx(lhs, ctx, mode)?;
        let r = emit_expr_with_ctx(rhs, ctx, mode)?;
        return Ok(match (mode, op) {
            (ArithMode::NatChecked, '*') => {
                format!("({l}).checked_mul({r}){}", ctx.overflow("Nat.mul"))
            }
            (ArithMode::Wrapping, '*') => format!("({l}).wrapping_mul({r})"),
            (ArithMode::NatChecked, '/') => {
                format!("{{ let __a = {l}; let __b = {r}; if __b == 0_u64 {{ 0_u64 }} else {{ __a / __b }} }}")
            }
            (ArithMode::Wrapping, '/') => {
                format!("{{ let __a = {l}; let __b = {r}; if __b == 0 {{ 0 }} else {{ __a.wrapping_div(__b) }} }}")
            }
            (ArithMode::NatChecked, '%') => {
                format!("{{ let __a = {l}; let __b = {r}; if __b == 0_u64 {{ __a }} else {{ __a % __b }} }}")
            }
            (ArithMode::Wrapping, '%') => {
                format!("{{ let __a = {l}; let __b = {r}; if __b == 0 {{ 0 }} else {{ __a.wrapping_rem(__b) }} }}")
            }
            _ => unreachable!(),
        });
    }

    // Unary boolean negation
    if let Some(operand) = s.strip_prefix('!') {
        return Ok(format!("!({})", emit_expr_with_ctx(operand, ctx, mode)?));
    }

    // Real Bend 2 curly-brace ADT constructor: Draft{}, Paid{amt}, OrderState.Paid{10n}
    if let Some(open) = s.find('{') {
        if s.ends_with('}') && is_valid_path_ident(s[..open].trim()) {
            let callee = s[..open].trim();
            let args_inner = s[open + 1..s.len() - 1].trim();
            let rust_ctor = resolve_ctor_path(callee, ctors);
            if args_inner.is_empty() {
                return Ok(rust_ctor);
            }
            let info_opt = ctors.get(callee);
            let parts = split_top_level(args_inner, ',');
            let mut emitted_args = Vec::with_capacity(parts.len());
            for (idx, a) in parts.iter().enumerate() {
                let trimmed = a.trim();
                let val = if let Some((_, v)) = split_top_level_once(trimmed, ':') {
                    v
                } else {
                    trimmed
                };
                let emitted = emit_expr_with_ctx(val, ctx, mode)?;
                let is_boxed = info_opt
                    .and_then(|i| i.boxed_fields.get(idx).copied())
                    .unwrap_or(false);
                if is_boxed {
                    emitted_args.push(format!("Box::new({emitted})"));
                } else {
                    emitted_args.push(emitted);
                }
            }
            return Ok(format!("{rust_ctor}({})", emitted_args.join(", ")));
        }
    }

    // Function or ADT constructor application: callee(arg1, arg2)
    if let Some(open) = s.find('(') {
        if s.ends_with(')') && is_valid_path_ident(s[..open].trim()) {
            let callee = s[..open].trim();
            let args_inner = s[open + 1..s.len() - 1].trim();
            let raw_args = if args_inner.is_empty() {
                Vec::new()
            } else {
                split_top_level(args_inner, ',')
            };

            // Built-in Bend 2.0.40 Base stdlib helpers (Nat.*, Bool.*, Pair.*) -> zero-overhead Rust
            if let Some(builtin) = emit_base_builtin(callee, &raw_args, ctx, mode)? {
                return Ok(builtin);
            }

            if let Some(info) = ctors.get(callee) {
                let mut emitted_args = Vec::with_capacity(raw_args.len());
                for (idx, a) in raw_args.iter().enumerate() {
                    let emitted = emit_expr_with_ctx(a, ctx, mode)?;
                    let is_boxed = info.boxed_fields.get(idx).copied().unwrap_or(false);
                    if is_boxed {
                        emitted_args.push(format!("Box::new({emitted})"));
                    } else {
                        emitted_args.push(emitted);
                    }
                }
                return Ok(format!(
                    "{}::{}({})",
                    info.type_name,
                    info.variant_name,
                    emitted_args.join(", ")
                ));
            }

            let mut emitted_args = Vec::new();
            let target_def = defs.get(callee);
            for (idx, arg) in raw_args.iter().enumerate() {
                if let Some(def) = target_def {
                    if let Some(param) = def.params.get(idx) {
                        if param.q == Quantity::Dead {
                            continue;
                        }
                    }
                }
                emitted_args.push(emit_expr_with_ctx(arg, ctx, mode)?);
            }
            if let Some(def) = target_def {
                if ctx.total && ctx.total_cone.contains(callee) {
                    return Ok(format!(
                        "{}({})?",
                        rust_path(&total_fn_name(def)),
                        emitted_args.join(", ")
                    ));
                }
                if def.total {
                    // A total function called from panicking code keeps panicking semantics.
                    return Ok(format!(
                        "{}({}){}",
                        rust_path(callee),
                        emitted_args.join(", "),
                        ctx.overflow(&format!("call {callee}"))
                    ));
                }
            }
            return Ok(format!(
                "{}({})",
                rust_path(callee),
                emitted_args.join(", ")
            ));
        }
    }

    // Natural number literals (0n, 42n)
    if let Some(digits) = s.strip_suffix('n') {
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            return Ok(format!("{digits}_u64"));
        }
    }

    // Unit ADT constructor (e.g. OrderState.Draft or Draft)
    if let Some(info) = ctors.get(s) {
        if info.arity == 0 {
            return Ok(format!("{}::{}", info.type_name, info.variant_name));
        }
    }

    if ctx.clone_vars.contains(s) {
        return Ok(format!("{}.clone()", rust_ident(s)));
    }

    if s.split('.').all(is_valid_rust_ident_or_wildcard) {
        return Ok(rust_path(s));
    }
    Ok(s.replace('.', "::"))
}

fn emit_base_builtin(
    callee: &str,
    raw_args: &[&str],
    ctx: &EmitCtx<'_>,
    mode: ArithMode,
) -> Result<Option<String>, String> {
    let e = |a: &str, m: ArithMode| emit_expr_with_ctx(a, ctx, m);
    Ok(match (callee, raw_args.len()) {
        // Unary Bool / Nat / Pair helpers
        ("Bool.not", 1) => Some(format!("(!({}))", e(raw_args[0], mode)?)),
        ("Nat.is_zero", 1) => Some(format!(
            "(({}) == 0_u64)",
            e(raw_args[0], ArithMode::NatChecked)?
        )),
        ("Nat.succ", 1) => Some(format!(
            "({}).checked_add(1_u64){}",
            e(raw_args[0], ArithMode::NatChecked)?,
            ctx.overflow("Nat.succ")
        )),
        ("Nat.pred", 1) => Some(format!(
            "({}).saturating_sub(1_u64)",
            e(raw_args[0], ArithMode::NatChecked)?
        )),
        ("Pair.fst", 1) => Some(format!("({}).0", e(raw_args[0], mode)?)),
        ("Pair.snd", 1) => Some(format!("({}).1", e(raw_args[0], mode)?)),

        // Binary Nat arithmetic (checked add/mul, saturating sub, total div/mod matching Bend 2)
        ("Nat.add", 2) => Some(format!(
            "({}).checked_add({}){}",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?,
            ctx.overflow("Nat.add")
        )),
        ("Nat.sub", 2) => Some(format!(
            "({}).saturating_sub({})",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.mul", 2) => Some(format!(
            "({}).checked_mul({}){}",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?,
            ctx.overflow("Nat.mul")
        )),
        ("Nat.div", 2) => Some(format!(
            "{{ let __a = {}; let __b = {}; if __b == 0_u64 {{ 0_u64 }} else {{ __a / __b }} }}",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.mod", 2) => Some(format!(
            "{{ let __a = {}; let __b = {}; if __b == 0_u64 {{ __a }} else {{ __a % __b }} }}",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.divmod", 2) => Some(format!(
            "{{ let __a = {}; let __b = {}; if __b == 0_u64 {{ (0_u64, __a) }} else {{ (__a / __b, __a % __b) }} }}",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.min", 2) => Some(format!(
            "({}).min({})",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.max", 2) => Some(format!(
            "({}).max({})",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),

        // Binary Nat comparisons
        ("Nat.is_le" | "Nat.le" | "Nat.lte", 2) => Some(format!(
            "(({}) <= ({}))",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.is_lt" | "Nat.lt", 2) => Some(format!(
            "(({}) < ({}))",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.is_ge" | "Nat.ge" | "Nat.gte", 2) => Some(format!(
            "(({}) >= ({}))",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.is_gt" | "Nat.gt", 2) => Some(format!(
            "(({}) > ({}))",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.is_eq" | "Nat.eq" | "Nat.equal", 2) => Some(format!(
            "(({}) == ({}))",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.is_ne" | "Nat.ne", 2) => Some(format!(
            "(({}) != ({}))",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),

        // Binary Bool logic
        ("Bool.and", 2) => Some(format!(
            "(({}) && ({}))",
            e(raw_args[0], mode)?,
            e(raw_args[1], mode)?
        )),
        ("Bool.or", 2) => Some(format!(
            "(({}) || ({}))",
            e(raw_args[0], mode)?,
            e(raw_args[1], mode)?
        )),
        ("Bool.xor", 2) => Some(format!(
            "(({}) ^ ({}))",
            e(raw_args[0], mode)?,
            e(raw_args[1], mode)?
        )),
        ("Bool.is_eq" | "Bool.eq", 2) => Some(format!(
            "(({}) == ({}))",
            e(raw_args[0], mode)?,
            e(raw_args[1], mode)?
        )),
        ("Bool.is_ne" | "Bool.ne", 2) => Some(format!(
            "(({}) != ({}))",
            e(raw_args[0], mode)?,
            e(raw_args[1], mode)?
        )),

        // Polymorphic Pair / Bool.pick helpers (with or without erased type args)
        ("Pair.fst", 3) => Some(format!("({}).0", e(raw_args[2], mode)?)),
        ("Pair.snd", 3) => Some(format!("({}).1", e(raw_args[2], mode)?)),
        ("Bool.pick", 3) => Some(format!(
            "if {} {{ {} }} else {{ {} }}",
            e(raw_args[0], mode)?,
            e(raw_args[1], mode)?,
            e(raw_args[2], mode)?
        )),
        ("Bool.pick", 4) => Some(format!(
            "if {} {{ {} }} else {{ {} }}",
            e(raw_args[1], mode)?,
            e(raw_args[2], mode)?,
            e(raw_args[3], mode)?
        )),
        _ => None,
    })
}

fn split_case_arms(arms_str: &str) -> Vec<String> {
    let mut arms = Vec::new();
    let mut current = String::new();
    let mut depth = 0i32;
    let tokens: Vec<&str> = arms_str.split_whitespace().collect();
    for tok in tokens {
        if tok == "case" && depth == 0 {
            if !current.trim().is_empty() {
                arms.push(current.trim().trim_end_matches(';').to_string());
                current.clear();
            }
            continue;
        }
        for ch in tok.chars() {
            match ch {
                '(' | '{' | '[' => depth += 1,
                ')' | '}' | ']' => depth -= 1,
                _ => {}
            }
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(tok);
    }
    if !current.trim().is_empty() {
        arms.push(current.trim().trim_end_matches(';').to_string());
    }
    arms
}

pub(crate) fn split_case_arm(arm: &str) -> Option<(&str, &str)> {
    if let Some(pair) = split_fat_arrow(arm) {
        return Some(pair);
    }
    split_top_level_once(arm, ':')
}

fn split_fat_arrow(arm: &str) -> Option<(&str, &str)> {
    let mut depth = 0i32;
    let bytes = arm.as_bytes();
    for i in 0..bytes.len().saturating_sub(1) {
        match bytes[i] {
            b'(' | b'{' | b'[' => depth += 1,
            b')' | b'}' | b']' => depth -= 1,
            b'=' if depth == 0 && bytes[i + 1] == b'>' => {
                return Some((arm[..i].trim(), arm[i + 2..].trim()));
            }
            _ => {}
        }
    }
    None
}

fn split_keyword<'a>(s: &'a str, needle: &str) -> Option<(&'a str, &'a str)> {
    let mut depth = 0i32;
    let bytes = s.as_bytes();
    for i in 0..bytes.len() {
        match bytes[i] {
            b'(' | b'{' | b'[' => depth += 1,
            b')' | b'}' | b']' => depth -= 1,
            _ if depth == 0 && s[i..].starts_with(needle) => {
                return Some((s[..i].trim(), s[i + needle.len()..].trim()));
            }
            _ => {}
        }
    }
    None
}

pub(crate) fn split_top_level_str<'a>(s: &'a str, op: &str) -> Option<(&'a str, &'a str)> {
    let mut depth = 0i32;
    let bytes = s.as_bytes();
    for i in 0..bytes.len() {
        match bytes[i] {
            b'(' | b'{' | b'[' => depth += 1,
            b')' | b'}' | b']' => depth -= 1,
            _ if depth == 0 && i > 0 && s[i..].starts_with(op) => {
                if (op == "<" || op == ">") && i + 1 < bytes.len() && bytes[i + 1] == b'=' {
                    continue;
                }
                if op == ">" && (bytes[i - 1] == b'=' || bytes[i - 1] == b'-') {
                    continue;
                }
                return Some((s[..i].trim(), s[i + op.len()..].trim()));
            }
            _ => {}
        }
    }
    None
}

fn is_valid_path_ident(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

pub(crate) fn is_wrapped_in_parens(s: &str) -> bool {
    is_wrapped_in_delims(s, '(', ')')
}

fn is_wrapped_in_brackets(s: &str) -> bool {
    is_wrapped_in_delims(s, '[', ']')
}

fn is_wrapped_in_delims(s: &str, open: char, close: char) -> bool {
    if !(s.starts_with(open) && s.ends_with(close)) {
        return false;
    }
    let mut depth = 0i32;
    for (idx, ch) in s.char_indices() {
        if ch == open {
            depth += 1;
        } else if ch == close {
            depth -= 1;
            if depth == 0 && idx < s.len() - close.len_utf8() {
                return false;
            }
        }
    }
    depth == 0
}

fn is_wrapped_in_angles(s: &str) -> bool {
    if !(s.starts_with('<') && s.ends_with('>')) {
        return false;
    }
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    for (idx, ch) in s.char_indices() {
        match ch {
            '<' => depth += 1,
            '>' => {
                if idx > 0 && bytes[idx - 1] == b'-' {
                    continue;
                }
                depth -= 1;
                if depth == 0 && idx < s.len() - 1 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

pub(crate) fn split_type_args(s: &str, delim: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    let bytes = s.as_bytes();
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' | '[' | '<' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            '>' => {
                if idx > 0 && bytes[idx - 1] == b'-' {
                    continue;
                }
                depth -= 1;
            }
            c if c == delim && depth == 0 => {
                parts.push(s[start..idx].trim());
                start = idx + ch.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(s[start..].trim());
    parts
}

fn split_type_args_once(s: &str, delim: char) -> Option<(&str, &str)> {
    let mut depth = 0i32;
    let bytes = s.as_bytes();
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' | '[' | '<' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            '>' => {
                if idx > 0 && bytes[idx - 1] == b'-' {
                    continue;
                }
                depth -= 1;
            }
            c if c == delim && depth == 0 => {
                return Some((s[..idx].trim(), s[idx + ch.len_utf8()..].trim()));
            }
            _ => {}
        }
    }
    None
}

pub(crate) fn unwrap_outer_parens(s: &str) -> &str {
    let mut cur = s.trim();
    while is_wrapped_in_parens(cur) {
        cur = cur[1..cur.len() - 1].trim();
    }
    cur
}

pub(crate) fn split_top_level(s: &str, delim: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            c if c == delim && depth == 0 => {
                parts.push(s[start..idx].trim());
                start = idx + ch.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(s[start..].trim());
    parts
}

pub(crate) fn split_top_level_once(s: &str, delim: char) -> Option<(&str, &str)> {
    let mut depth = 0i32;
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            c if c == delim && depth == 0 => {
                return Some((s[..idx].trim(), s[idx + ch.len_utf8()..].trim()));
            }
            _ => {}
        }
    }
    None
}

pub(crate) fn split_last_additive(s: &str) -> Option<(char, &str, &str)> {
    let mut depth = 0i32;
    let mut found = None;
    let bytes = s.as_bytes();
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            '+' | '-' if depth == 0 && idx > 0 => {
                if ch == '-' && idx + 1 < bytes.len() && bytes[idx + 1] == b'>' {
                    continue;
                }
                found = Some((ch, s[..idx].trim(), s[idx + 1..].trim()));
            }
            _ => {}
        }
    }
    found
}

fn split_last_multiplicative(s: &str) -> Option<(char, &str, &str)> {
    let mut depth = 0i32;
    let mut found = None;
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            '*' | '/' | '%' if depth == 0 && idx > 0 => {
                found = Some((ch, s[..idx].trim(), s[idx + ch.len_utf8()..].trim()));
            }
            _ => {}
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erases_dead_type_param_and_annotation() {
        let src = "def id(-T: Type, x: T) -> T:\\n  (x : T)\\n";
        let summary = emit_verified_rust(src, 1).expect("emit succeeded");
        assert_eq!(summary.defs_emitted, 1);
        assert_eq!(summary.dead_params_erased, 1);
        assert!(summary.rust_source.contains("pub fn id<T>(x: T) -> T"));
        assert!(summary.rust_source.contains("    x\\n}"));
    }

    #[test]
    fn emits_checked_nat_math_and_erases_laws() {
        let src = r#"
def deposit(+bal: Nat, +amt: Nat) -> Nat:
  (bal + amt : Nat)

def apply_fee(+gross: Nat, +fee: Nat) -> Nat:
  (gross - fee : Nat)

law deposit_zero(for +bal: Nat):
  deposit(bal, 0n) == bal

proof deposit_zero:
  refl
"#;
        let summary = emit_verified_rust(src, 1).expect("emit succeeded");
        let (runtime_part, tests_part) = summary
            .rust_source
            .split_once("#[cfg(test)]")
            .expect("expected generated #[cfg(test)] law module");
        let code_only: String = runtime_part
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\\n");
        assert_eq!(summary.defs_emitted, 2);
        assert!(code_only.contains("pub fn deposit(bal: u64, amt: u64) -> u64"));
        assert!(code_only.contains("(bal).checked_add(amt).expect(\\"rusty-bends: Nat overflow\\")"));
        assert!(code_only.contains("(gross).saturating_sub(fee)"));
        assert!(!code_only.contains("law "));
        assert!(!code_only.contains("proof "));
        assert!(!code_only.contains("refl"));
        assert!(tests_part.contains("fn law_deposit_zero()"));
    }

    #[test]
    fn drops_dead_arguments_at_call_sites() {
        let src = r#"
def id(-T: Type, x: T) -> T:
  (x : T)

def keep_nat(+n: Nat) -> Nat:
  id(Nat, n)
"#;
        let summary = emit_verified_rust(src, 0).expect("emit succeeded");
        assert!(summary.rust_source.contains("id(n)"));
        assert!(!summary.rust_source.contains("id(Nat, n)"));
    }

    #[test]
    fn handles_tuple_duplication_for_data_params() {
        let src = "def dup(+n: Nat) -> Nat:\\n  (n, n)\\n";
        let summary = emit_verified_rust(src, 0).expect("emit succeeded");
        assert!(summary
            .rust_source
            .contains("pub fn dup(n: u64) -> (u64, u64)"));
        assert!(summary.rust_source.contains("(n, n)"));
    }

    #[test]
    fn emits_adt_enum_and_pattern_matching_while_stripping_case_proofs() {
        let src = r#"
type OrderState:
  Draft
  Paid(amount: Nat)
  Cancelled

def cancel_order(+s: OrderState) -> OrderState:
  match s:
    case OrderState.Draft => OrderState.Cancelled
    case OrderState.Paid(amt) => OrderState.Cancelled
    case OrderState.Cancelled => OrderState.Cancelled

law cancel_idempotent(for +s: OrderState):
  cancel_order(cancel_order(s)) == cancel_order(s)

proof cancel_idempotent:
  match s:
    case OrderState.Draft => refl
    case OrderState.Paid(amt) => refl
    case OrderState.Cancelled => refl
"#;
        let summary = emit_verified_rust(src, 1).expect("emit succeeded");
        let (runtime_part, tests_part) = summary
            .rust_source
            .split_once("#[cfg(test)]")
            .expect("expected generated #[cfg(test)] law module");
        assert_eq!(summary.types_emitted, 1);
        assert_eq!(summary.defs_emitted, 1);
        assert!(runtime_part.contains("pub enum OrderState"));
        assert!(runtime_part.contains("Paid(u64),"));
        assert!(runtime_part.contains("OrderState::Draft => OrderState::Cancelled,"));
        assert!(runtime_part.contains("OrderState::Paid(amt) => OrderState::Cancelled,"));
        assert!(!runtime_part.contains("cancel_idempotent"));
        assert!(!runtime_part.contains("refl"));
        assert!(tests_part.contains("fn law_cancel_idempotent()"));
    }

    #[test]
    fn emits_bool_if_else_and_logical_operators() {
        let src = r#"
def can_write(+is_admin: Bool, +is_revoked: Bool) -> Bool:
  if is_revoked: false else: is_admin
"#;
        let summary = emit_verified_rust(src, 0).expect("emit succeeded");
        assert!(summary
            .rust_source
            .contains("pub fn can_write(is_admin: bool, is_revoked: bool) -> bool"));
        assert!(summary
            .rust_source
            .contains("if is_revoked { false } else { is_admin }"));
    }

    #[test]
    fn emits_real_bend2_syntax_and_erases_proof_defs() {
        let src = r#"
import Base

type OrderState is Data:
  Draft{}
  Paid{amount: Nat}
  Shipped{amount: Nat}
  Cancelled{}

def deposit(bal: Nat, amt: Nat) -> Nat:
  Nat.add(bal, amt)

def cancel_order(s: OrderState) -> OrderState:
  match s:
    case Draft{}:
      Cancelled{}
    case Paid{amt}:
      Cancelled{}
    case Shipped{amt}:
      Shipped{amt}
    case Cancelled{}:
      Cancelled{}

law deposit_zero:
  for bal: Nat
  {deposit(bal, 0n) == bal : Nat}

def deposit_zero(bal):
  match bal:
    case 0n:
      {==}
    case 1n+p:
      %deposit_zero(p) : {1n+Nat.add(p, 0n) == 1n+_ : Nat}
      {==}

law cancel_idempotent:
  for s: OrderState
  {cancel_order(cancel_order(s)) == cancel_order(s) : OrderState}

def cancel_idempotent(s):
  match s:
    case Draft{}: {==}
    case Paid{amt}: {==}
    case Shipped{amt}: {==}
    case Cancelled{}: {==}
"#;
        let summary = emit_verified_rust(src, 2).expect("real bend2 emit succeeded");
        let (runtime_part, tests_part) = summary
            .rust_source
            .split_once("#[cfg(test)]")
            .expect("expected generated #[cfg(test)] law module");
        assert_eq!(summary.types_emitted, 1);
        assert_eq!(summary.defs_emitted, 2);
        assert!(runtime_part.contains("pub enum OrderState"));
        assert!(runtime_part.contains("Draft,"));
        assert!(runtime_part.contains("Paid(u64),"));
        assert!(
            runtime_part.contains("(bal).checked_add(amt).expect(\\"rusty-bends: Nat overflow\\")")
        );
        assert!(runtime_part.contains("OrderState::Draft => OrderState::Cancelled,"));
        assert!(runtime_part.contains("OrderState::Paid(amt) => OrderState::Cancelled,"));
        assert!(runtime_part.contains("OrderState::Shipped(amt) => OrderState::Shipped(amt),"));
        assert!(!runtime_part.contains("deposit_zero"));
        assert!(!runtime_part.contains("cancel_idempotent"));
        assert!(!runtime_part.contains("{==}"));
        assert!(tests_part.contains("fn law_deposit_zero()"));
        assert!(tests_part.contains("fn law_cancel_idempotent()"));
    }

    #[test]
    fn emits_bend2_base_nat_and_bool_helpers() {
        let src = r#"
import Base

def can_fit(used: Nat, req: Nat, cap: Nat, enabled: Bool) -> Bool:
  Bool.and(enabled, Bool.or(Nat.is_le(Nat.add(used, req), cap), Bool.not(Nat.is_gt(req, 0n))))

def clamp_range(n: Nat, lo: Nat, hi: Nat) -> Nat:
  Nat.min(Nat.max(n, lo), hi)

def chunks_needed(items: Nat, size: Nat) -> Nat:
  Nat.add(Nat.div(items, size), Bool.pick(Nat, Nat.is_eq(Nat.mod(items, size), 0n), 0n, 1n))

def cmp_flags(a: Nat, b: Nat) -> Bool:
  Bool.and(Nat.is_lt(a, b), Nat.is_ge(b, a))
"#;
        let summary = emit_verified_rust(src, 0).expect("base helpers emit succeeded");
        assert_eq!(summary.defs_emitted, 4);
        assert!(summary.rust_source.contains("((enabled) && ("));
        assert!(summary.rust_source.contains("<= (cap)"));
        assert!(summary.rust_source.contains("(!(((req) > (0_u64))))"));
        assert!(summary.rust_source.contains("((n).max(lo)).min(hi)"));
        assert!(summary
            .rust_source
            .contains("if __b == 0_u64 { 0_u64 } else { __a / __b }"));
        assert!(summary
            .rust_source
            .contains("if __b == 0_u64 { __a } else { __a % __b }"));
        assert!(summary.rust_source.contains("if (({ let __a = items;"));
        assert!(summary
            .rust_source
            .contains("(((a) < (b))) && (((b) >= (a)))"));
        assert!(!summary.rust_source.contains("Nat::"));
        assert!(!summary.rust_source.contains("Bool::"));
    }

    #[test]
    fn emits_wrapping_for_u32_and_checked_for_nat() {
        let src = r#"
def wrap_u32(a: U32, b: U32) -> U32:
  ((a + b : U32) * (a - b : U32) : U32)

def checked_nat(a: Nat, b: Nat) -> Nat:
  (a + b : Nat)

def sub_nat(a: Nat, b: Nat) -> Nat:
  (a - b : Nat)
"#;
        let summary = emit_verified_rust(src, 0).expect("arith mode emit succeeded");
        assert!(summary
            .rust_source
            .contains("pub fn wrap_u32(a: u32, b: u32) -> u32"));
        assert!(summary
            .rust_source
            .contains("((a).wrapping_add(b)).wrapping_mul((a).wrapping_sub(b))"));
        assert!(summary
            .rust_source
            .contains("pub fn checked_nat(a: u64, b: u64) -> u64"));
        assert!(summary
            .rust_source
            .contains("(a).checked_add(b).expect(\\"rusty-bends: Nat overflow\\")"));
        assert!(summary.rust_source.contains("(a).saturating_sub(b)"));
    }

    #[test]
    fn emits_nested_match_multi_scrutinee_succ_and_let() {
        let src = r#"
import Base

type Store is Data:
  Ready{free: Nat}
  Exhausted{}

def try_take(state: Store, req: Nat) -> Store:
  match state:
    case Ready{free}:
      let ok = Nat.is_le(req, free)
      match ok:
        case True{}:
          Ready{Nat.sub(free, req)}
        case False{}:
          Ready{free}
    case Exhausted{}:
      Exhausted{}

def nat_min_rec(a: Nat, b: Nat) -> Nat:
  match a b:
    case 0n _:
      0n
    case 1n+ap 0n:
      0n
    case 1n+ap 1n+bp:
      Nat.add(1n, nat_min_rec(ap, bp))

def helper_lemma(x: Nat) -> {x == x : Nat}:
  {==}
"#;
        let summary = emit_verified_rust(src, 0).expect("nested match emit succeeded");
        assert_eq!(summary.types_emitted, 1);
        assert_eq!(summary.defs_emitted, 2);
        assert!(summary.rust_source.contains("let ok = ((req) <= (free));"));
        assert!(summary.rust_source.contains("match ok {"));
        assert!(summary
            .rust_source
            .contains("true => Store::Ready((free).saturating_sub(req)),"));
        assert!(summary.rust_source.contains("match (a, b) {"));
        assert!(summary.rust_source.contains("(0_u64, _) => 0_u64,"));
        assert!(summary.rust_source.contains("(__rb_n0 @ 1_u64..=u64::MAX, __rb_n1 @ 1_u64..=u64::MAX) => { let ap = __rb_n0 - 1_u64; let bp = __rb_n1 - 1_u64;"));
        assert!(!summary.rust_source.contains("helper_lemma"));
    }

    #[test]
    fn emits_pair_types_and_pair_accessors() {
        let src = r#"
import Base

def split_chunks(n: Nat, size: Nat) -> Nat & Nat:
  Nat.divmod(n, size)

def first_of_pair(p: Nat & Nat) -> Nat:
  Pair.fst(Nat, Nat, p)
"#;
        let summary = emit_verified_rust(src, 0).expect("pair emit succeeded");
        assert!(summary
            .rust_source
            .contains("pub fn split_chunks(n: u64, size: u64) -> (u64, u64)"));
        assert!(summary
            .rust_source
            .contains("if __b == 0_u64 { (0_u64, __a) } else { (__a / __b, __a % __b) }"));
        assert!(summary
            .rust_source
            .contains("pub fn first_of_pair(p: (u64, u64)) -> u64"));
        assert!(summary.rust_source.contains("(p).0"));
    }

    #[test]
    fn parses_multi_line_def_headers_and_erases_multi_line_lemmas() {
        // Accepted by 'bend --check-only' on Bend 2.0.40.
        let src = r#"
import Base

def in_order(
  +lo: Nat,  # comment inside the header
  +mid: Nat,
  hi: Nat,
  +step: Nat
) -> Bool:
  (lo <= mid : Nat) && (mid <= hi : Nat)

def add_zero_eq(
  n: Nat
) -> {Nat.add(n, 0n) == n : Nat}:
  match n:
    case 0n:
      {==}
    case 1n+p:
      %add_zero_eq(p) : {1n+Nat.add(p, 0n) == 1n+_ : Nat}
      {==}

def one_liner(n: Nat) -> Nat: Nat.add(n, 1n)
"#;
        let summary = emit_verified_rust(src, 0).expect("multi-line headers emit");
        assert_eq!(summary.defs_emitted, 2);
        assert!(summary
            .rust_source
            .contains("pub fn in_order(lo: u64, mid: u64, hi: u64, step: u64) -> bool"));
        assert!(summary
            .rust_source
            .contains("pub fn one_liner(n: u64) -> u64"));
        assert!(!summary.rust_source.contains("add_zero_eq"));
        assert!(summary.rust_source.contains(
            "#[allow(unused_variables, unused_parens, unreachable_patterns, irrefutable_let_patterns, clippy::let_and_return, clippy::double_parens, clippy::unnecessary_cast, clippy::clone_on_copy, clippy::match_like_matches_macro)]"
        ));
    }

    #[test]
    fn lowers_nested_successor_patterns_and_rejects_unsupported_patterns() {
        let src = r#"
import Base

type Box is Data:
  Wrap{x: Nat}

def minus_two(n: Nat) -> Nat:
  match n:
    case 0n:
      0n
    case 1n:
      0n
    case 1n+1n+q:
      q

def within_span(a: Nat, b: Nat, span: Nat) -> Bool:
  match span:
    case 0n:
      True{}
    case 1n:
      Nat.is_eq(a, b)
    case 1n+1n+q:
      Nat.is_le(a, Nat.add(b, 1n+1n+q))

def nested_const_and_three(n: Nat) -> Nat:
  match n:
    case 0n:
      0n
    case 1n+1n+0n:
      10n
    case 2n+1n+q:
      q

def nested_data_binder(+m: Nat) -> Nat:
  match m:
    case 0n: 0n
    case 1n: 0n
    case 1n+1n++q: Nat.add(q, q)

def nested_in_box(b: Box) -> Nat:
  match b:
    case Wrap{0n}: 0n
    case Wrap{1n}: 0n
    case Wrap{1n+1n+1n+_}: 42n

def nested_multi(x: Nat, y: Nat) -> Nat:
  match x y:
    case 0n _: 0n
    case 1n _: 0n
    case 1n+1n+q 1n+p: Nat.add(q, p)
"#;
        let summary = emit_verified_rust(src, 0).expect("nested successor patterns should emit");
        assert!(summary
            .rust_source
            .contains("__rb_n0 @ 2_u64..=u64::MAX => { let q = __rb_n0 - 2_u64; q }"));
        assert!(summary.rust_source.contains("2_u64 => 10_u64,"));
        assert!(summary
            .rust_source
            .contains("__rb_n0 @ 3_u64..=u64::MAX => { let q = __rb_n0 - 3_u64; q }"));
        assert!(summary
            .rust_source
            .contains("Box::Wrap(3_u64..=u64::MAX) => 42_u64,"));
        assert!(summary.rust_source.contains("(__rb_n0 @ 2_u64..=u64::MAX, __rb_n1 @ 1_u64..=u64::MAX) => { let q = __rb_n0 - 2_u64; let p = __rb_n1 - 1_u64;"));
        assert!(!summary.rust_source.contains("1n+1n+q"));

        // Unsupported patterns must fail cleanly with E_EMIT_UNSUPPORTED_PATTERN instead of emitting unparseable Rust.
        let bad_add = "def bad(n: Nat) -> Nat:\\n  match n:\\n    case a+b: a\\n";
        let err = emit_verified_rust(bad_add, 0).expect_err("a+b pattern must be rejected");
        assert!(err.contains("E_EMIT_UNSUPPORTED_PATTERN"), "got: {err}");

        let bad_tail = "def bad2(n: Nat) -> Nat:\\n  match n:\\n    case 1n+Foo{}: 0n\\n";
        let err2 = emit_verified_rust(bad_tail, 0).expect_err("1n+Foo{} pattern must be rejected");
        assert!(err2.contains("E_EMIT_UNSUPPORTED_PATTERN"), "got: {err2}");
    }

    #[test]
    fn differential_nested_successor_matches_bend_and_compiles_with_rustc() {
        let bend_src = r#"import Base

def minus_two(n: Nat) -> Nat:
  match n:
    case 0n:
      0n
    case 1n:
      0n
    case 1n+1n+q:
      q

def within_span(a: Nat, b: Nat, span: Nat) -> Bool:
  match span:
    case 0n:
      True{}
    case 1n:
      Nat.is_eq(a, b)
    case 1n+1n+q:
      Nat.is_le(a, Nat.add(b, 1n+1n+q))
"#;
        let dir = std::env::temp_dir().join(format!("rb_nested_succ_diff_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bend_path = dir.join("nested.bend");
        std::fs::write(&bend_path, bend_src).unwrap();

        let bend_bin = crate::resolve_bend_bin(
            std::env::var("BEND_BIN").ok(),
            std::env::var_os("PATH"),
            std::env::var_os("HOME").map(std::path::PathBuf::from),
        );
        if let Ok(out) = std::process::Command::new(&bend_bin)
            .arg(&bend_path)
            .arg("--check-only")
            .output()
        {
            assert!(
                out.status.success(),
                "bend --check-only failed: {}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        }

        let summary = emit_verified_rust(bend_src, 0).expect("emit nested succ");
        let rs_path = dir.join("test.rs");
        let bin_path = dir.join("test_bin");
        let harness = format!(
            "{}\\nfn main() {{\\n    assert_eq!(minus_two(0), 0);\\n    assert_eq!(minus_two(1), 0);\\n    assert_eq!(minus_two(2), 0);\\n    assert_eq!(minus_two(5), 3);\\n    assert!(within_span(10, 20, 0));\\n    assert!(within_span(7, 7, 1));\\n    assert!(!within_span(7, 8, 1));\\n    assert!(within_span(5, 3, 2));\\n    assert!(!within_span(10, 3, 2));\\n}}\\n",
            summary.rust_source
        );
        std::fs::write(&rs_path, harness).unwrap();
        let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = std::process::Command::new(&rustc)
            .args(["--edition", "2021", "-o"])
            .arg(&bin_path)
            .arg(&rs_path)
            .output()
            .expect("rustc must run");
        assert!(
            compile.status.success(),
            "rustc failed: {}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run = std::process::Command::new(&bin_path)
            .output()
            .expect("run compiled binary");
        assert!(run.status.success(), "runtime assertions failed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn emits_recursive_adts_with_box_indirection_and_non_copy_handling() {
        // Covers Issue #9: self-recursion (Chain), non-recursive wrapper (Wrap),
        // mutual recursion (Tree/Forest), nested boxed patterns, and multi-use non-Copy +c.
        let src = r#"import Base

type Chain is Data:
  ChainEnd{}
  ChainLink{has_limit: Bool, limit: Nat, in_use: Nat, rest: Chain}

type Wrap is Data:
  Wrap{inner: Chain}

type Tree is Data:
  Leaf{val: Nat}
  Branch{children: Forest}

type Forest is Data:
  FEmpty{}
  FCons{head: Tree, tail: Forest}

def chain_step(+so_far: Nat, has_limit: Bool, limit: Nat, in_use: Nat) -> Nat:
  match has_limit:
    case True{}:
      Nat.min(so_far, Nat.sub(limit, in_use))
    case False{}:
      so_far

def chain_available(c: Chain, +so_far: Nat) -> Nat:
  match c:
    case ChainEnd{}:
      so_far
    case ChainLink{h, l, u, rest}:
      chain_available(rest, chain_step(so_far, h, l, u))

def chain_is_two_deep(c: Chain) -> Bool:
  match c:
    case ChainEnd{}:
      False{}
    case ChainLink{_, _, _, ChainEnd{}}:
      False{}
    case ChainLink{_, _, _, ChainLink{_, _, _, ChainEnd{}}}:
      True{}
    case ChainLink{_, _, _, _}:
      False{}

def chain_head_sum_plus_rest(+c: Chain) -> Nat:
  match c:
    case ChainEnd{}:
      0n
    case ChainLink{_, l, _, rest}:
      Nat.add(l, chain_available(rest, chain_available(c, 100n)))

def unwrap_available(w: Wrap, +so_far: Nat) -> Nat:
  match w:
    case Wrap{inner}:
      chain_available(inner, so_far)

def sum_tree(t: Tree) -> Nat:
  match t:
    case Leaf{v}:
      v
    case Branch{children}:
      sum_forest(children)

def sum_forest(f: Forest) -> Nat:
  match f:
    case FEmpty{}:
      0n
    case FCons{head, tail}:
      Nat.add(sum_tree(head), sum_forest(tail))
"#;
        let summary = emit_verified_rust(src, 0).expect("recursive ADTs should emit");
        // Chain: non-Copy + boxed rest
        assert!(summary.rust_source.contains(
            "#[derive(Debug, Clone, PartialEq, Eq)]\\npub enum Chain {\\n    ChainEnd,\\n    ChainLink(bool, u64, u64, Box<Chain>),\\n}"
        ), "got:\\n{}", summary.rust_source);
        // Wrap: non-recursive (no Box), but non-Copy because it contains Chain
        assert!(
            summary.rust_source.contains(
                "#[derive(Debug, Clone, PartialEq, Eq)]\\npub enum Wrap {\\n    Wrap(Chain),\\n}"
            ),
            "got:\\n{}",
            summary.rust_source
        );
        // Mutual recursion: Tree <-> Forest both boxed and non-Copy
        assert!(summary.rust_source.contains("Branch(Box<Forest>),"));
        assert!(summary
            .rust_source
            .contains("FCons(Box<Tree>, Box<Forest>),"));
        // Multi-use +c clones when passed multiple times
        assert!(summary.rust_source.contains("c.clone()"));

        let dir = std::env::temp_dir().join(format!("rb_rec_adt_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rs_path = dir.join("rec_adt.rs");
        let bin_path = dir.join("rec_adt_bin");
        let harness = format!(
            "{}\\nfn main() {{\\n    let c = Chain::ChainLink(true, 40, 10, Box::new(Chain::ChainLink(false, 99, 0, Box::new(Chain::ChainEnd))));\\n    assert_eq!(chain_available(c.clone(), 50), 30);\\n    assert!(chain_is_two_deep(c.clone()));\\n    assert!(!chain_is_two_deep(Chain::ChainEnd));\\n    assert!(!chain_is_two_deep(Chain::ChainLink(true, 1, 0, Box::new(Chain::ChainEnd))));\\n    assert_eq!(unwrap_available(Wrap::Wrap(c.clone()), 100), 30);\\n    assert_eq!(chain_head_sum_plus_rest(c), 40 + 30);\\n    let tr = Tree::Branch(Box::new(Forest::FCons(Box::new(Tree::Leaf(4)), Box::new(Forest::FCons(Box::new(Tree::Leaf(6)), Box::new(Forest::FEmpty))))));\\n    assert_eq!(sum_tree(tr), 10);\\n}}\\n",
            summary.rust_source
        );
        std::fs::write(&rs_path, harness).unwrap();
        let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = std::process::Command::new(&rustc)
            .args(["--edition", "2021", "-D", "warnings", "-o"])
            .arg(&bin_path)
            .arg(&rs_path)
            .output()
            .expect("rustc must run");
        assert!(
            compile.status.success(),
            "rustc failed:\\n{}\\nsource:\\n{}",
            String::from_utf8_lossy(&compile.stderr),
            summary.rust_source
        );
        let run = std::process::Command::new(&bin_path)
            .output()
            .expect("run compiled binary");
        assert!(run.status.success(), "runtime assertions failed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn emits_base_list_and_list_literals_and_compiles_with_rustc() {
        let src = r#"import Base

def sum_list(xs: List<&2, Nat>) -> Nat:
  match xs:
    case Nil{}:
      0n
    case Con{h, t}:
      Nat.add(h, sum_list(t))

def list_cat(xs: List<&2, Nat>, ys: List<&2, Nat>) -> List<&2, Nat>:
  match xs:
    case Nil{}:
      ys
    case Con{h, t}:
      Con{h, list_cat(t, ys)}

def sample_list() -> List<&2, Nat>:
  [1n, 2n, 3n]
"#;
        let summary = emit_verified_rust(src, 0).expect("Base List should emit");
        assert!(summary.rust_source.contains("pub enum List<T>"));
        assert!(summary.rust_source.contains("Con(T, Box<List<T>>)"));
        assert!(summary
            .rust_source
            .contains("pub fn sum_list(xs: List<u64>) -> u64"));
        assert!(summary
            .rust_source
            .contains("List::Con(1_u64, Box::new(List::Con(2_u64, Box::new(List::Con(3_u64, Box::new(List::Nil))))))"));

        let dir = std::env::temp_dir().join(format!("rb_base_list_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rs_path = dir.join("list.rs");
        let bin_path = dir.join("list_bin");
        let harness = format!(
            "{}\\nfn main() {{\\n    let s = sample_list();\\n    assert_eq!(sum_list(s.clone()), 6);\\n    assert_eq!(sum_list(list_cat(s.clone(), s)), 12);\\n    assert_eq!(sum_list(List::Nil), 0);\\n}}\\n",
            summary.rust_source
        );
        std::fs::write(&rs_path, harness).unwrap();
        let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = std::process::Command::new(&rustc)
            .args(["--edition", "2021", "-D", "warnings", "-o"])
            .arg(&bin_path)
            .arg(&rs_path)
            .output()
            .expect("rustc must run");
        assert!(
            compile.status.success(),
            "rustc failed:\\n{}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run = std::process::Command::new(&bin_path)
            .output()
            .expect("run compiled binary");
        assert!(run.status.success(), "runtime assertions failed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolves_sibling_import_aliases_in_functions_types_and_comments() {
        let base_src = r#"import Base

type Status is Data:
  Open{}
  Closed{}

def within_limit(pos: Nat, limit: Nat) -> Bool:
  Nat.is_le(pos, limit)
"#;
        let uses_src = r#"import Base
import base_rules.bend as B  # trailing comment

def within_both(+pos: Nat, a: Nat, b: Nat) -> Bool:
  Bool.and(B.within_limit(pos, a), Nat.is_le(pos, b))

def open_or(s: B.Status, flag: Bool) -> Bool:
  match s:
    case B.Open{}: True{}
    case B.Closed{}: flag

# promise: B.within_limit comment text stays untouched
law within_both_diag:
  for +pos: Nat
  for +a: Nat
  {within_both(pos, a, a) == B.within_limit(pos, a) : Bool}
"#;
        let resolved_uses = resolve_import_aliases(uses_src);
        // Idempotent
        assert_eq!(resolve_import_aliases(&resolved_uses), resolved_uses);
        assert!(!resolved_uses.contains("import base_rules.bend"));
        assert!(resolved_uses.contains("import Base"));
        assert!(resolved_uses.contains("within_limit(pos, a)"));
        assert!(resolved_uses.contains("s: Status, flag: Bool"));
        assert!(resolved_uses.contains("case Open{}:"));
        assert!(resolved_uses.contains("# promise: B.within_limit comment text stays untouched"));
        assert!(!resolved_uses.contains("B.within_limit(pos, a)"));

        // Per-file isolation: a sibling file without \`as B\` can define its own \`type B\`
        let other_src = r#"import Base

type B is Data:
  Tag{}

def use_b(x: B) -> Nat:
  match x:
    case Tag{}: 1n
"#;
        let combined = format!(
            "{}\\n{}\\n{}\\n",
            resolve_import_aliases(base_src),
            resolved_uses,
            resolve_import_aliases(other_src)
        );
        let summary = emit_verified_rust(&combined, 1).expect("emit with resolved aliases");
        assert!(!summary.rust_source.contains("B::within_limit"));
        assert!(!summary.rust_source.contains("B::Status"));
        assert!(!summary.rust_source.contains("B::Open"));
        assert!(summary.rust_source.contains("B::Tag"));
        assert!(summary.rust_source.contains("within_limit(pos, a)"));
        assert!(summary.rust_source.contains("pub enum Status"));
        assert!(summary.rust_source.contains("pub enum B"));
    }

    #[test]
    fn erases_type_level_and_proof_only_helper_defs() {
        let bundled = emit_verified_rust(include_str!("../lemmas/nat_lemmas.bend"), 0)
            .expect("bundled nat_lemmas.bend should parse and erase cleanly");
        assert_eq!(bundled.types_emitted, 0);
        assert_eq!(bundled.defs_emitted, 0);

        let mixed = r#"import Base

def bool_pick_type(b: Bool, t: Type, f: Type) -> Type:
  match b:
    case True{}:
      t
    case False{}:
      f

def bool_false_ne_true(h: {False{} == True{} : Bool}) -> Empty:
  %h : bool_pick_type(_, Empty, Unit)
  Unit{}

def bool_absurd(-A: Type, h: {False{} == True{} : Bool}) -> A:
  Empty.absurd(A, bool_false_ne_true(h))

def checked_id(x: Nat, -proof: {x == x : Nat}) -> Nat:
  x
"#;
        let summary = emit_verified_rust(mixed, 0).expect("mixed source should emit");
        assert_eq!(summary.defs_emitted, 1);
        assert!(!summary.rust_source.contains("bool_pick_type"));
        assert!(!summary.rust_source.contains("bool_false_ne_true"));
        assert!(!summary.rust_source.contains("bool_absurd"));
        assert!(summary
            .rust_source
            .contains("pub fn checked_id(x: u64) -> u64"));
    }

    const AREA_SRC: &str = r#"import Base

def area(+w: Nat, +h: Nat) -> Nat:
  Nat.mul(w, h)

def fits_area_limit(+w: Nat, +h: Nat, max_area: Nat) -> Bool:
  Bool.and(Bool.and(Nat.is_gt(w, 0n), Nat.is_gt(h, 0n)), Nat.is_le(area(w, h), max_area))

def fits_default_limit(+w: Nat, +h: Nat) -> Bool:
  fits_area_limit(w, h, 1000n)

# promise: a zero-width rectangle is always refused
law zero_width_refused:
  for +h: Nat
  for +m: Nat
  {fits_area_limit(0n, h, m) == False{} : Bool}
"#;

    fn total_area_src() -> String {
        AREA_SRC.replace(
            "def fits_area_limit(",
            "# Untrusted input reaches this check: refuse instead of panicking.\\n# rusty-bends: total\\ndef fits_area_limit(",
        )
    }

    fn compile_and_run(tag: &str, source: &str, extra_args: &[&str]) -> String {
        let dir = std::env::temp_dir().join(format!("rb_total_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rs_path = dir.join("main.rs");
        let bin_path = dir.join("main_bin");
        std::fs::write(&rs_path, source).unwrap();
        let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = std::process::Command::new(&rustc)
            .args(["--edition", "2021", "-D", "warnings"])
            .args(extra_args)
            .arg("-o")
            .arg(&bin_path)
            .arg(&rs_path)
            .output()
            .expect("rustc must run");
        assert!(
            compile.status.success(),
            "rustc failed:\\n{}\\nsource:\\n{source}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run = std::process::Command::new(&bin_path)
            .output()
            .expect("run compiled binary");
        let stdout = String::from_utf8_lossy(&run.stdout).to_string();
        assert!(
            run.status.success(),
            "binary failed:\\n{stdout}{}",
            String::from_utf8_lossy(&run.stderr)
        );
        let _ = std::fs::remove_dir_all(&dir);
        stdout
    }

    #[test]
    fn records_checked_growth_panic_sites_and_lists_them_with_file_and_line() {
        let summary = emit_verified_rust(AREA_SRC, 1).unwrap();
        let sites: Vec<(&str, &str)> = summary
            .panic_sites
            .iter()
            .map(|p| (p.function.as_str(), p.op.as_str()))
            .collect();
        assert_eq!(sites, vec![("area", "Nat.mul")]);

        let path = std::path::Path::new("verified/shapes.bend");
        let listing = crate::format_panic_sites(&summary.panic_sites, &[(path, AREA_SRC)]);
        assert_eq!(
            listing[0],
            "RustyBends panic [area]: Nat.mul at verified/shapes.bend:4"
        );
        assert!(listing[1].contains("1 checked-growth panic site(s) in 1 function(s)"));
        assert!(listing[1].contains("# rusty-bends: total"));

        let none = emit_verified_rust("def id(+n: Nat) -> Nat:\\n  n\\n", 0).unwrap();
        assert!(none.panic_sites.is_empty());
        assert_eq!(
            crate::format_panic_sites(&none.panic_sites, &[]),
            vec!["RustyBends panics: no checked-growth panic sites in emitted Rust"]
        );
    }

    #[test]
    fn total_marker_emits_option_returning_function_that_refuses_overflow() {
        let src = total_area_src();
        let (_, defs) = parse_book_items(&src).unwrap();
        assert!(defs.iter().any(|d| d.name == "fits_area_limit" && d.total));
        assert!(defs.iter().any(|d| d.name == "area" && !d.total));

        let summary = emit_verified_rust(&src, 1).unwrap();
        let rs = &summary.rust_source;
        assert!(
            rs.contains("pub fn fits_area_limit(w: u64, h: u64, max_area: u64) -> Option<bool>"),
            "{rs}"
        );
        // Callee gets a private Option shadow; its public form keeps panicking semantics.
        assert!(rs.contains("fn __rb_total_area(w: u64, h: u64) -> Option<u64>"));
        assert!(rs.contains("(w).checked_mul(h)?"));
        assert!(rs.contains("__rb_total_area(w, h)?"));
        assert!(rs.contains("pub fn area(w: u64, h: u64) -> u64"));

        // Panic listing: area's own Nat.mul, plus the panicking caller of the total fn.
        let mut sites: Vec<(String, String)> = summary
            .panic_sites
            .iter()
            .map(|p| (p.function.clone(), p.op.clone()))
            .collect();
        sites.sort();
        assert_eq!(
            sites,
            vec![
                ("area".to_string(), "Nat.mul".to_string()),
                (
                    "fits_default_limit".to_string(),
                    "call fits_area_limit".to_string()
                ),
            ]
        );
        let path = std::path::Path::new("verified/shapes.bend");
        let listing = crate::format_panic_sites(&summary.panic_sites, &[(path, &src)]);
        assert!(listing.iter().any(|l| l
            == "RustyBends panic [fits_default_limit]: call fits_area_limit at verified/shapes.bend:12"));

        let runtime_only = rs.split("#[cfg(test)]").next().unwrap();
        let harness = format!(
            "{runtime_only}\\nfn main() {{\\n    assert_eq!(fits_area_limit(u64::MAX, u64::MAX, u64::MAX - 1), None);\\n    assert_eq!(fits_area_limit(10, 10, 100), Some(true));\\n    assert_eq!(fits_area_limit(10, 11, 100), Some(false));\\n    assert_eq!(fits_area_limit(0, 5, 100), Some(false));\\n    assert!(std::panic::catch_unwind(|| area(u64::MAX, 2)).is_err());\\n    assert!(fits_default_limit(10, 10));\\n    assert!(!fits_default_limit(100, 100));\\n}}\\n"
        );
        compile_and_run("runtime", &harness, &[]);
    }

    #[test]
    fn total_function_generated_law_test_still_runs() {
        let summary = emit_verified_rust(&total_area_src(), 1).unwrap();
        assert!(summary.rust_source.contains("fn law_zero_width_refused()"));
        let out = compile_and_run(
            "lawtest",
            &summary.rust_source,
            &["--test", "-A", "dead_code"],
        );
        assert!(out.contains("law_zero_width_refused ... ok"), "{out}");
        assert!(out.contains("test result: ok"), "{out}");
    }
}
`;

  const buildCrateLib = `//! rusty-bends-build v1: compile-time Bend 2 proof gate, AST/token law lock,
//! Bend version-pin checker, and pure Rust ADT/match OUT_DIR emitter.
//!
//! Add this crate under '[build-dependencies]' (never '[dependencies]') so nothing
//! proof-related ever links into your final binary:
//!
//! // build.rs
//! fn main() {
//!     rusty_bends_build::verify_and_emit("verified");
//! }

pub mod coverage;
pub mod emit;
pub mod law_test;
pub mod lock;
pub mod mutate;

pub use lock::LockUpdateMode;
pub use mutate::MutateMode;

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerdictMode {
    /// Run --verdict when Lean (~/.elan/bin/lean or PATH) or $BENDTT is available; skip gracefully with a cargo:warning otherwise.
    Auto,
    /// Always run --verdict and fail the build if Lean / $BENDTT is missing (recommended for strict CI).
    Require,
    /// Never run --verdict; verify with 'bend <file> --check-only' only.
    Off,
}

impl VerdictMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "require" | "strict" | "1" | "true" | "on" => Self::Require,
            "off" | "0" | "false" | "skip" => Self::Off,
            _ => Self::Auto,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub verified_dir: PathBuf,
    pub bend_bin: String,
    pub check_flag: String,
    pub verdict_flag: String,
    pub verdict_mode: VerdictMode,
    pub lock_file: PathBuf,
    pub pin_file: PathBuf,
    pub pinned_version: Option<String>,
    pub out_dir: PathBuf,
    pub allow_lock_update: bool,
    pub lock_update: LockUpdateMode,
    pub emit_rust: bool,
    pub mutate_mode: MutateMode,
    pub list_laws: bool,
    /// \`RUSTY_BENDS_LIST_PANICS=1\`: print every checked-growth panic site as
    /// \`function: op at file:line\` (Issue #13).
    pub list_panics: bool,
    /// \`RUSTY_BENDS_LIST_COVERAGE=1\`: print which emitted functions each law covers,
    /// which emitted functions no law reaches, and which laws name only uncalled functions.
    pub list_coverage: bool,
    /// Optional crate root (\`CARGO_MANIFEST_DIR\`) scanned under \`list_coverage\` for \`src/\`,
    /// \`tests/\`, and \`benches/\` call-site checks.
    pub crate_root: Option<PathBuf>,
    /// \`RUSTY_BENDS_NO_CACHE=1\`: bypass the incremental build cache in \`OUT_DIR\`
    /// and re-run verification and code generation.
    pub no_cache: bool,
}

impl Default for Config {
    fn default() -> Self {
        let verdict_mode = env::var("BEND_VERDICT")
            .map(|v| VerdictMode::parse(&v))
            .unwrap_or(VerdictMode::Auto);
        let mutate_mode = env::var("RUSTY_BENDS_MUTATE")
            .map(|v| MutateMode::parse(&v))
            .unwrap_or(MutateMode::NewOnly);
        let env_flag = |name: &str| {
            env::var(name)
                .map(|v| {
                    matches!(
                        v.trim().to_ascii_lowercase().as_str(),
                        "1" | "true" | "yes" | "on"
                    )
                })
                .unwrap_or(false)
        };
        let list_laws = env_flag("RUSTY_BENDS_LIST_LAWS");
        let list_panics = env_flag("RUSTY_BENDS_LIST_PANICS");
        let list_coverage = env_flag("RUSTY_BENDS_LIST_COVERAGE");
        let no_cache = env_flag("RUSTY_BENDS_NO_CACHE");
        let crate_root = env::var_os("CARGO_MANIFEST_DIR").map(PathBuf::from);
        let lock_update = env::var("RUSTY_BENDS_UPDATE_LAWS")
            .map(|v| LockUpdateMode::parse(&v))
            .unwrap_or(LockUpdateMode::None);
        let allow_lock_update = lock_update == LockUpdateMode::All;
        Self {
            verified_dir: PathBuf::from("verified"),
            bend_bin: resolve_bend_bin(
                env::var("BEND_BIN").ok(),
                env::var_os("PATH"),
                env::var_os("HOME").map(PathBuf::from),
            ),
            check_flag: env::var("BEND_CHECK_FLAG").unwrap_or_else(|_| "--check-only".to_string()),
            verdict_flag: env::var("BEND_VERDICT_FLAG").unwrap_or_else(|_| "--verdict".to_string()),
            verdict_mode,
            lock_file: PathBuf::from("rusty-bends.lock"),
            pin_file: PathBuf::from("bend.pin"),
            pinned_version: env::var("BEND_PIN_VERSION")
                .ok()
                .filter(|v| !v.trim().is_empty()),
            out_dir: PathBuf::from(env::var("OUT_DIR").unwrap_or_else(|_| "target".to_string())),
            allow_lock_update,
            lock_update,
            emit_rust: true,
            mutate_mode,
            list_laws,
            list_panics,
            list_coverage,
            crate_root,
            no_cache,
        }
    }
}

impl Config {
    fn effective_lock_update(&self) -> LockUpdateMode {
        if self.allow_lock_update && self.lock_update == LockUpdateMode::None {
            LockUpdateMode::All
        } else {
            self.lock_update.clone()
        }
    }
}

/// Shared Bend 2 Nat arithmetic, order, and division lemma library (\`nat_lemmas.bend\`).
/// Every definition is a \`q=0\` proof/type helper and is completely erased before Rust codegen.
pub const NAT_LEMMAS_BEND: &str = include_str!("../lemmas/nat_lemmas.bend");

/// Compile-time hash of this \`rusty-bends-build\` crate's sources (\`build.rs\`, \`Cargo.toml\`,
/// \`src/\`, \`lemmas/\`), baked into \`OUT_DIR\` cache stamps so updating the build crate
/// invalidates stale generated Rust and mutation caches automatically.
pub const BUILDER_HASH: &str = env!("RUSTY_BENDS_BUILD_HASH");

/// Writes the bundled \`nat_lemmas.bend\` into \`dir\` (typically \`"verified"\`), creating
/// the directory if needed. Only writes when the file is missing or differs, keeping
/// mtime stable for Cargo incremental rebuilds.
pub fn write_nat_lemmas(dir: impl AsRef<Path>) -> Result<PathBuf, String> {
    let dir = dir.as_ref();
    fs::create_dir_all(dir).map_err(|e| {
        format!(
            "[E_NAT_LEMMAS_WRITE] Failed to create '{}': {e}",
            dir.display()
        )
    })?;
    let dest = dir.join("nat_lemmas.bend");
    let unchanged = fs::read_to_string(&dest)
        .map(|existing| existing == NAT_LEMMAS_BEND)
        .unwrap_or(false);
    if !unchanged {
        fs::write(&dest, NAT_LEMMAS_BEND).map_err(|e| {
            format!(
                "[E_NAT_LEMMAS_WRITE] Failed to write '{}': {e}",
                dest.display()
            )
        })?;
    }
    Ok(dest)
}

/// Primary build.rs entry point: checks bend.pin, enforces token-canonical law lock,
/// runs real 'bend <file> --check-only' (plus '--verdict' when Lean/$BENDTT is available),
/// and emits pure Rust into OUT_DIR/verified.rs.
pub fn verify_and_emit(dir: impl AsRef<Path>) {
    let cfg = Config {
        verified_dir: dir.as_ref().to_path_buf(),
        emit_rust: true,
        ..Default::default()
    };
    run_or_fail(&cfg);
}

/// Check-only build.rs entry point (verifies proofs & locks without emitting verified.rs).
pub fn verify_dir(dir: impl AsRef<Path>) {
    let cfg = Config {
        verified_dir: dir.as_ref().to_path_buf(),
        emit_rust: false,
        ..Default::default()
    };
    run_or_fail(&cfg);
}

fn run_or_fail(cfg: &Config) {
    if let Err(err) = run(cfg) {
        if cfg.emit_rust {
            let _ = fs::create_dir_all(&cfg.out_dir);
            let blocked = cfg.out_dir.join("verified.rs");
            let _ = fs::write(
                blocked,
                "compile_error!(\\"RustyBends verification failed — fix Bend 2 proofs or lock violations.\\");\\n",
            );
        }
        for line in err.lines() {
            println!("cargo:error={line}");
        }
        std::process::exit(1);
    }
}

pub fn run(cfg: &Config) -> Result<Option<PathBuf>, String> {
    println!("cargo:rerun-if-changed={}", cfg.verified_dir.display());
    println!("cargo:rerun-if-changed={}", cfg.lock_file.display());
    println!("cargo:rerun-if-changed={}", cfg.pin_file.display());
    println!("cargo:rerun-if-env-changed=RUSTY_BENDS_UPDATE_LAWS");
    println!("cargo:rerun-if-env-changed=RUSTY_BENDS_MUTATE");
    println!("cargo:rerun-if-env-changed=RUSTY_BENDS_LIST_LAWS");
    println!("cargo:rerun-if-env-changed=RUSTY_BENDS_LIST_PANICS");
    println!("cargo:rerun-if-env-changed=RUSTY_BENDS_LIST_COVERAGE");
    println!("cargo:rerun-if-env-changed=RUSTY_BENDS_NO_CACHE");
    println!("cargo:rerun-if-env-changed=BEND_BIN");
    println!("cargo:rerun-if-env-changed=BEND_PIN_VERSION");
    println!("cargo:rerun-if-env-changed=BEND_CHECK_FLAG");
    println!("cargo:rerun-if-env-changed=BEND_VERDICT_FLAG");
    println!("cargo:rerun-if-env-changed=BEND_VERDICT");
    println!("cargo:rerun-if-env-changed=BENDTT");

    // Verify Bend CLI version pin if bend.pin or BEND_PIN_VERSION is configured,
    // and capture the active Bend version so upgrades invalidate the build cache.
    let bend_version = if let Some(expected_pin) = read_active_pin(cfg)? {
        let actual_ver = query_bend_version(&cfg.bend_bin)?;
        verify_bend_version_str(&expected_pin, &actual_ver)?;
        Some(actual_ver)
    } else {
        query_bend_version(&cfg.bend_bin).ok()
    };

    run_pipeline(
        cfg,
        bend_version.as_deref(),
        has_verdict_runtime(),
        |file, has_laws| {
            println!("cargo:rerun-if-changed={}", file.display());
            verify_with_bend_cli(cfg, file, has_laws)
        },
    )
}

/// Reads an active version pin from BEND_PIN_VERSION or non-comment lines in bend.pin.
pub fn read_active_pin(cfg: &Config) -> Result<Option<String>, String> {
    if let Some(ref v) = cfg.pinned_version {
        return Ok(Some(v.trim().to_string()));
    }
    if !cfg.pin_file.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&cfg.pin_file).map_err(|e| e.to_string())?;
    for line in text.lines() {
        let clean = line.split('#').next().unwrap_or("").trim();
        if !clean.is_empty() {
            return Ok(Some(clean.to_string()));
        }
    }
    Ok(None)
}

/// Picks the 'bend' executable: '$BEND_BIN' when set, else 'bend' if it is on 'PATH', else
/// '~/.bend/bin/bend' (the default Bend 2 install location, often missing from the PATH of
/// non-interactive Cargo shells) when it exists, else plain 'bend'.
pub fn resolve_bend_bin(
    bend_bin_env: Option<String>,
    path: Option<std::ffi::OsString>,
    home: Option<PathBuf>,
) -> String {
    if let Some(bin) = bend_bin_env.filter(|v| !v.trim().is_empty()) {
        return bin;
    }
    let on_path = path
        .map(|p| env::split_paths(&p).any(|dir| dir.join("bend").is_file()))
        .unwrap_or(false);
    if !on_path {
        if let Some(home) = home {
            let installed = home.join(".bend").join("bin").join("bend");
            if installed.is_file() {
                return installed.to_string_lossy().into_owned();
            }
        }
    }
    "bend".to_string()
}

/// Checks whether the installed 'bend version' string satisfies the pinned prefix.
pub fn verify_bend_version_str(expected_pin: &str, actual_output: &str) -> Result<(), String> {
    let trimmed_pin = expected_pin.trim();
    if trimmed_pin.is_empty() || actual_output.contains(trimmed_pin) {
        return Ok(());
    }
    Err(format!(
        "[E_BEND_VERSION_MISMATCH] Pinned Bend version '{trimmed_pin}' does not match installed '{}'.\\nHint: Install the pinned Bend 2 release or update bend.pin / BEND_PIN_VERSION.",
        actual_output.trim()
    ))
}

/// Asks the Bend CLI for its version. Bend 2 (2.0.40+) only accepts the 'version'
/// subcommand ('--version' is rejected as an unknown option), so try that first and fall
/// back to '--version' for older releases.
fn query_bend_version(bend_bin: &str) -> Result<String, String> {
    let mut failures = Vec::new();
    for arg in ["version", "--version"] {
        let output = Command::new(bend_bin).arg(arg).output().map_err(|e| {
            format!("[E_BEND_MISSING] Failed to run '{bend_bin} {arg}': {e}\\nHint: Install Bend 2 (~/.bend/bin) or set BEND_BIN=/path/to/bend")
        })?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let text = format!("{stdout}{stderr}");
        if output.status.success() {
            return Ok(text);
        }
        failures.push(format!("'{bend_bin} {arg}': {}", text.trim()));
    }
    Err(format!(
        "[E_BEND_VERSION_QUERY] Could not read the Bend version:\\n{}\\nHint: Set BEND_BIN to a working Bend 2 binary or remove the bend.pin / BEND_PIN_VERSION pin.",
        failures.join("\\n")
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VerdictApplied {
    Ran,
    Skipped,
    Off,
}

impl VerdictApplied {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ran => "ran",
            Self::Skipped => "skipped",
            Self::Off => "off",
        }
    }
}

fn expected_verdict_applied(cfg: &Config, verdict_runtime_available: bool) -> VerdictApplied {
    if cfg.verdict_mode == VerdictMode::Off || cfg.verdict_flag.trim().is_empty() {
        VerdictApplied::Off
    } else if cfg.verdict_mode == VerdictMode::Auto && !verdict_runtime_available {
        VerdictApplied::Skipped
    } else {
        VerdictApplied::Ran
    }
}

fn sanitize_cache_field(s: &str) -> String {
    s.replace(['\\r', '\\n'], " ").trim().to_string()
}

fn format_cargo_warning_lines(msg: &str) -> Vec<String> {
    msg.lines()
        .map(|line| format!("cargo:warning={line}"))
        .collect()
}

fn emit_cargo_warning(msg: &str) {
    for line in format_cargo_warning_lines(msg) {
        println!("{line}");
    }
}

fn format_cache_stamp(
    cfg: &Config,
    files_hash: &str,
    builder_hash: &str,
    verdict: VerdictApplied,
    bend_version: &str,
) -> String {
    format!(
        "v4\\nhash={files_hash}\\nbuilder={}\\nverdict={}\\nbend_bin={}\\nbend_version={}\\ncheck_flag={}\\nverdict_flag={}\\n",
        sanitize_cache_field(builder_hash),
        verdict.as_str(),
        sanitize_cache_field(&cfg.bend_bin),
        sanitize_cache_field(bend_version),
        sanitize_cache_field(&cfg.check_flag),
        sanitize_cache_field(&cfg.verdict_flag),
    )
}

fn is_bend_cli_invocation_error(err: &str) -> bool {
    err.starts_with("[E_BEND_MISSING]")
        || is_missing_lean_error(err)
        || err.contains("unknown option")
        || err.contains("see bend --help")
}

/// Core pipeline with pluggable 'bend' runner for deterministic unit testing.
pub fn run_with_checker<F>(cfg: &Config, mut checker: F) -> Result<Option<PathBuf>, String>
where
    F: FnMut(&Path, bool) -> Result<(), String>,
{
    let runtime_ok = has_verdict_runtime();
    let expected = expected_verdict_applied(cfg, runtime_ok);
    run_pipeline(cfg, Some(""), runtime_ok, |file, has_laws| {
        checker(file, has_laws)?;
        Ok(expected)
    })
}

fn run_pipeline<F>(
    cfg: &Config,
    bend_version: Option<&str>,
    verdict_runtime_available: bool,
    checker: F,
) -> Result<Option<PathBuf>, String>
where
    F: FnMut(&Path, bool) -> Result<VerdictApplied, String>,
{
    run_pipeline_with_builder(
        cfg,
        bend_version,
        BUILDER_HASH,
        verdict_runtime_available,
        checker,
    )
}

fn run_pipeline_with_builder<F>(
    cfg: &Config,
    bend_version: Option<&str>,
    builder_hash: &str,
    verdict_runtime_available: bool,
    mut checker: F,
) -> Result<Option<PathBuf>, String>
where
    F: FnMut(&Path, bool) -> Result<VerdictApplied, String>,
{
    if !cfg.verified_dir.exists() {
        return Err(format!(
            "[E_NO_VERIFIED_DIR] Directory '{}' does not exist. Create verified/ with .bend files.",
            cfg.verified_dir.display()
        ));
    }

    let mut bend_files = Vec::new();
    collect_bend_files(&cfg.verified_dir, &mut bend_files)?;
    bend_files.sort();

    if bend_files.is_empty() {
        return Err(format!(
            "[E_NO_BEND_FILES] No .bend files found under '{}'.",
            cfg.verified_dir.display()
        ));
    }

    // Record which laws were already locked before this build for failure diagnostics.
    let pre_locked_laws = lock::read_locked_law_names(&cfg.lock_file);

    // 1. Check AST/token-canonical LAWS lock (defer writing until Bend & mutation checks pass)
    let effective_lock_mode = cfg.effective_lock_update();
    let lock_report =
        lock::check_law_lock_with_mode(&cfg.lock_file, &bend_files, &effective_lock_mode)?;
    let law_count = lock_report.current.len();

    for w in &lock_report.warnings {
        emit_cargo_warning(w);
    }
    if effective_lock_mode != LockUpdateMode::None && !lock_report.needs_write {
        emit_cargo_warning("RustyBends lock: no lock changes to write");
    }
    if cfg.list_laws {
        let listing = lock::format_law_list(&lock_report.current);
        emit_cargo_warning(&listing);
    }

    // 2. Check incremental build cache (file contents, builder hash, verdict mode/status, flags, and bend version)
    fs::create_dir_all(&cfg.out_dir).map_err(|e| e.to_string())?;
    let cache_file = cfg.out_dir.join("rusty-bends.cache");
    let verified_rs = cfg.out_dir.join("verified.rs");
    let combined_hash = hash_files(&bend_files)?;
    let expected_verdict = expected_verdict_applied(cfg, verdict_runtime_available);
    let expected_stamp = bend_version
        .map(|ver| format_cache_stamp(cfg, &combined_hash, builder_hash, expected_verdict, ver));

    let cache_hit = !cfg.no_cache
        && expected_stamp.as_ref().is_some_and(|stamp| {
            fs::read_to_string(&cache_file)
                .map(|s| s == *stamp)
                .unwrap_or(false)
        });
    if cache_hit
        && (!cfg.emit_rust || verified_rs.exists())
        && !lock_report.needs_write
        && lock_report.new_names.is_empty()
        && cfg.mutate_mode == MutateMode::NewOnly
        && !cfg.list_panics
        && !cfg.list_coverage
    {
        return Ok(if cfg.emit_rust {
            Some(verified_rs)
        } else {
            None
        });
    }

    // 3. Pre-read all sources and run real Bend 2 checker (--check-only, plus --verdict when laws are present)
    let mut file_sources: Vec<(&PathBuf, String)> = Vec::with_capacity(bend_files.len());
    let mut combined_source = String::new();
    for file in &bend_files {
        let text = fs::read_to_string(file).map_err(|e| e.to_string())?;
        combined_source.push_str(&emit::resolve_import_aliases(&text));
        combined_source.push('\\n');
        file_sources.push((file, text));
    }

    let mut saw_verdict_skipped = false;
    for (file, text) in &file_sources {
        let is_laws_file = file
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case("LAWS.bend"))
            .unwrap_or(false);
        let has_laws = is_laws_file || !lock::extract_laws_from_source(text).is_empty();

        match checker(file, has_laws) {
            Ok(VerdictApplied::Skipped) => {
                saw_verdict_skipped = true;
            }
            Ok(VerdictApplied::Ran | VerdictApplied::Off) => {}
            Err(err) => {
                if !is_bend_cli_invocation_error(&err) {
                    let file_laws = law_test::parse_laws(text);
                    if !file_laws.is_empty() {
                        let target_names = match law_test::extract_failed_def_name(&err) {
                            Some(failed) if file_laws.iter().any(|l| l.name == failed) => {
                                vec![failed]
                            }
                            _ => file_laws.iter().map(|l| l.name.clone()).collect(),
                        };
                        if let Ok(outcomes) = law_test::evaluate_laws_for_counterexamples(
                            &combined_source,
                            &target_names,
                            &cfg.out_dir,
                        ) {
                            let diagnosis = law_test::format_counterexample_diagnosis(
                                &outcomes,
                                &pre_locked_laws,
                            );
                            if !diagnosis.is_empty() {
                                return Err(format!("{diagnosis}\\n\\n{err}"));
                            }
                        }
                    }
                }
                return Err(err);
            }
        }
    }
    let applied_verdict =
        if cfg.verdict_mode == VerdictMode::Off || cfg.verdict_flag.trim().is_empty() {
            VerdictApplied::Off
        } else if saw_verdict_skipped {
            VerdictApplied::Skipped
        } else {
            VerdictApplied::Ran
        };

    // 4. Mutation-check every unlocked/new law before sealing (and report all locked laws under RUSTY_BENDS_MUTATE=all)
    let mut_summary = mutate::run_mutation_checks(
        &combined_source,
        &lock_report,
        cfg.mutate_mode,
        &cfg.out_dir,
    )?;
    for w in &mut_summary.warnings {
        emit_cargo_warning(w);
    }

    // 5. Persist rusty-bends.lock only after Bend proofs and mutation checks succeed
    if lock_report.needs_write {
        lock::write_law_lock(&cfg.lock_file, &lock_report)?;
        for note in lock::format_lock_update_notes(&lock_report.update_summary) {
            emit_cargo_warning(&note);
        }
    }

    // 6. Erase q=0 parts and emit pure Rust (ADTs + match + defs) into OUT_DIR/verified.rs
    let summary = if cfg.emit_rust || cfg.list_panics {
        Some(emit::emit_verified_rust(&combined_source, law_count)?)
    } else {
        None
    };
    if let (true, Some(summary)) = (cfg.list_panics, summary.as_ref()) {
        let files: Vec<(&Path, &str)> = file_sources
            .iter()
            .map(|(f, t)| (f.as_path(), t.as_str()))
            .collect();
        for line in format_panic_sites(&summary.panic_sites, &files) {
            emit_cargo_warning(&line);
        }
    }
    if cfg.list_coverage {
        let cov = coverage::analyze_coverage(&combined_source, cfg.crate_root.as_deref())?;
        for line in coverage::format_coverage_report(&cov) {
            emit_cargo_warning(&line);
        }
    }
    let emitted_path = match summary {
        Some(summary) if cfg.emit_rust => {
            fs::write(&verified_rs, summary.rust_source).map_err(|e| e.to_string())?;
            Some(verified_rs)
        }
        _ => None,
    };

    // 7. Persist passing build cache stamp (skip if Bend version could not be read so stale runs never hit)
    if let Some(ver) = bend_version {
        let stamp = format_cache_stamp(cfg, &combined_hash, builder_hash, applied_verdict, ver);
        fs::write(&cache_file, stamp).map_err(|e| e.to_string())?;
    }
    Ok(emitted_path)
}

fn verify_with_bend_cli(
    cfg: &Config,
    file: &Path,
    has_laws: bool,
) -> Result<VerdictApplied, String> {
    run_bend_step(&cfg.bend_bin, &cfg.check_flag, file)?;
    if cfg.verdict_mode == VerdictMode::Off || cfg.verdict_flag.trim().is_empty() {
        return Ok(VerdictApplied::Off);
    }
    if !has_laws {
        return Ok(expected_verdict_applied(cfg, has_verdict_runtime()));
    }

    match cfg.verdict_mode {
        VerdictMode::Off => Ok(VerdictApplied::Off),
        VerdictMode::Require => {
            run_bend_step(&cfg.bend_bin, &cfg.verdict_flag, file)?;
            Ok(VerdictApplied::Ran)
        }
        VerdictMode::Auto => {
            if !has_verdict_runtime() {
                println!(
                    "cargo:warning=RustyBends: {} passed --check-only; skipping optional --verdict Lean cross-check (install Lean/elan or set BEND_VERDICT=require in CI).",
                    file.display()
                );
                return Ok(VerdictApplied::Skipped);
            }
            match run_bend_step(&cfg.bend_bin, &cfg.verdict_flag, file) {
                Ok(()) => Ok(VerdictApplied::Ran),
                Err(err) if is_missing_lean_error(&err) => {
                    println!(
                        "cargo:warning=RustyBends: {} passed --check-only; skipping optional --verdict (Lean kernel unavailable). Set BEND_VERDICT=require to enforce.",
                        file.display()
                    );
                    Ok(VerdictApplied::Skipped)
                }
                Err(err) => Err(err),
            }
        }
    }
}

fn has_verdict_runtime() -> bool {
    if env::var("BENDTT")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .is_some()
    {
        return true;
    }
    if let Ok(home) = env::var("HOME") {
        let elan_lean = PathBuf::from(home).join(".elan").join("bin").join("lean");
        if elan_lean.exists() {
            return true;
        }
    }
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            if dir.join("lean").exists() || dir.join("lean.exe").exists() {
                return true;
            }
        }
    }
    false
}

pub fn is_missing_lean_error(err: &str) -> bool {
    err.contains("BendTT infrastructure")
        || err.contains("Executable not found in $PATH: \\"lean\\"")
        || err.contains("--verdict needs Lean")
}

fn run_bend_step(bend_bin: &str, flag: &str, file: &Path) -> Result<(), String> {
    let mut cmd = Command::new(bend_bin);
    cmd.arg(file).arg(flag);

    // Ensure ~/.elan/bin is visible to child 'bend --verdict' processes even under non-interactive Cargo shells.
    if let Ok(home) = env::var("HOME") {
        let elan_bin = PathBuf::from(home).join(".elan").join("bin");
        if elan_bin.is_dir() {
            let current_path = env::var_os("PATH").unwrap_or_default();
            let mut dirs: Vec<PathBuf> = vec![elan_bin];
            dirs.extend(env::split_paths(&current_path));
            if let Ok(joined) = env::join_paths(dirs) {
                cmd.env("PATH", joined);
            }
        }
    }

    let output = cmd.output().map_err(|e| {
        format!(
            "[E_BEND_MISSING] Failed to run '{bend_bin} {} {flag}': {e}\\nHint: Install Bend 2 (~/.bend/bin) or set BEND_BIN=/path/to/bend",
            file.display()
        )
    })?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "[E_BEND_CHECK_FAILED] '{bend_bin} {} {flag}' failed:\\n{stdout}{stderr}",
            file.display()
        ));
    }
    Ok(())
}

/// Locates \`def <name>\` in \`files\`: returns \`(file index, header line, end line exclusive)\`.
fn locate_def(name: &str, files: &[(&Path, &str)]) -> Option<(usize, usize, usize)> {
    for (fi, (_, text)) in files.iter().enumerate() {
        let lines: Vec<&str> = text.lines().collect();
        for (li, raw) in lines.iter().enumerate() {
            let Some(rest) = raw.strip_prefix("def ") else {
                continue;
            };
            let def_name = rest
                .trim_start()
                .split(|c: char| c == '(' || c == ':' || c.is_whitespace())
                .next()
                .unwrap_or("");
            if def_name != name {
                continue;
            }
            let mut end = li + 1;
            while end < lines.len() {
                let trimmed = emit::strip_comment(lines[end]).trim();
                if !trimmed.is_empty() && emit::is_top_level_start(lines[end], trimmed) {
                    break;
                }
                end += 1;
            }
            return Some((fi, li, end));
        }
    }
    None
}

/// Number of places in \`line\` where the Bend source of a checked-growth \`op\` appears.
fn op_occurrences(line: &str, op: &str) -> usize {
    let is_ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'.';
    let count_calls = |callee: &str| {
        let needle = format!("{callee}(");
        line.match_indices(&needle)
            .filter(|(i, _)| *i == 0 || !is_ident(line.as_bytes()[*i - 1]))
            .count()
    };
    match op {
        "Nat.add" => {
            let bytes = line.as_bytes();
            let infix = line.matches(" + ").count();
            // Successor literals in expressions: \`1n+x\`.
            let succ_lit = (1..bytes.len())
                .filter(|&i| {
                    bytes[i] == b'+'
                        && bytes[i - 1] == b'n'
                        && i >= 2
                        && bytes[i - 2].is_ascii_digit()
                })
                .count();
            count_calls("Nat.add") + infix + succ_lit
        }
        "Nat.mul" => count_calls("Nat.mul") + line.matches(" * ").count(),
        "Nat.succ" => count_calls("Nat.succ"),
        other => other.strip_prefix("call ").map(count_calls).unwrap_or(0),
    }
}

/// Formats checked-growth panic sites as \`RustyBends panic [function]: op at file:line\`, plus a
/// one-line summary. Source lines are matched by op kind in source order; an op that cannot
/// be matched to a body line is reported at the \`def\` header line.
pub fn format_panic_sites(sites: &[emit::PanicSite], files: &[(&Path, &str)]) -> Vec<String> {
    use std::collections::BTreeMap;
    let mut grouped: BTreeMap<(&str, &str), usize> = BTreeMap::new();
    for site in sites {
        *grouped
            .entry((site.function.as_str(), site.op.as_str()))
            .or_default() += 1;
    }

    let mut located: Vec<(String, usize, String, String)> = Vec::new();
    for ((function, op), count) in grouped {
        let Some((fi, header, end)) = locate_def(function, files) else {
            for _ in 0..count {
                located.push((String::from("?"), 0, function.to_string(), op.to_string()));
            }
            continue;
        };
        let path = files[fi].0.display().to_string();
        let lines: Vec<&str> = files[fi].1.lines().collect();
        let mut candidates = Vec::new();
        for (li, raw) in lines.iter().enumerate().take(end).skip(header + 1) {
            let code = emit::strip_comment(raw);
            let t = code.trim_start();
            if t.starts_with("case ") || t.starts_with("match ") {
                continue;
            }
            for _ in 0..op_occurrences(code, op) {
                candidates.push(li + 1);
            }
        }
        for k in 0..count {
            let line_no = candidates.get(k).copied().unwrap_or(header + 1);
            located.push((path.clone(), line_no, function.to_string(), op.to_string()));
        }
    }
    located.sort();

    let functions: std::collections::BTreeSet<&str> =
        sites.iter().map(|s| s.function.as_str()).collect();
    let mut out: Vec<String> = located
        .iter()
        .map(|(path, line, function, op)| {
            format!("RustyBends panic [{function}]: {op} at {path}:{line}")
        })
        .collect();
    if sites.is_empty() {
        out.push("RustyBends panics: no checked-growth panic sites in emitted Rust".to_string());
    } else {
        out.push(format!(
            "RustyBends panics: {} checked-growth panic site(s) in {} function(s); mark a def '# {}' to return Option (None on overflow) instead of panicking",
            sites.len(),
            functions.len(),
            emit::TOTAL_MARKER
        ));
    }
    out
}

pub fn collect_bend_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            collect_bend_files(&path, out)?;
        } else if path.extension().and_then(|s| s.to_str()) == Some("bend") {
            out.push(path);
        }
    }
    Ok(())
}

fn hash_files(files: &[PathBuf]) -> Result<String, String> {
    let mut buf = b"rb-cache-v2\\0".to_vec();
    for f in files {
        buf.extend_from_slice(f.to_string_lossy().as_bytes());
        buf.push(0);
        buf.extend_from_slice(&fs::read(f).map_err(|e| e.to_string())?);
        buf.push(0);
    }
    Ok(lock::fnv1a_hex(&buf))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_SEQ: AtomicUsize = AtomicUsize::new(0);

    fn temp_workspace(name: &str) -> PathBuf {
        let n = TEST_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = env::temp_dir().join(format!("rusty_bends_v1_{name}_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("verified")).unwrap();
        fs::create_dir_all(dir.join("out")).unwrap();
        dir
    }

    fn make_cfg(root: &Path) -> Config {
        Config {
            verified_dir: root.join("verified"),
            bend_bin: "bend".to_string(),
            check_flag: "--check-only".to_string(),
            verdict_flag: "--verdict".to_string(),
            verdict_mode: VerdictMode::Auto,
            lock_file: root.join("rusty-bends.lock"),
            pin_file: root.join("bend.pin"),
            pinned_version: None,
            out_dir: root.join("out"),
            allow_lock_update: false,
            lock_update: LockUpdateMode::None,
            emit_rust: true,
            mutate_mode: MutateMode::NewOnly,
            list_laws: false,
            list_panics: false,
            list_coverage: false,
            crate_root: Some(root.to_path_buf()),
            no_cache: false,
        }
    }

    #[test]
    fn verify_and_emit_generates_adt_rust_and_caches() {
        let root = temp_workspace("emit_adt_cache");
        fs::write(
            root.join("verified/core.bend"),
            "type Status:\\n  Open\\n  Closed\\n\\ndef close(+s: Status) -> Status:\\n  match s:\\n    case Status.Open => Status.Closed\\n    case Status.Closed => Status.Closed\\n\\n# promise: closing any status yields Closed\\nlaw close_always_closed(for +s: Status):\\n  close(s) == Status.Closed\\n\\nproof close_always_closed:\\n  match s:\\n    case Status.Open => refl\\n    case Status.Closed => refl\\n",
        )
        .unwrap();

        let cfg = make_cfg(&root);
        let mut calls = 0usize;
        let out_rs = run_with_checker(&cfg, |_file, has_laws| {
            assert!(has_laws, "file with law should trigger --verdict");
            calls += 1;
            Ok(())
        })
        .expect("first run succeeded")
        .expect("emitted verified.rs");

        assert_eq!(calls, 1);
        let emitted = fs::read_to_string(&out_rs).unwrap();
        let (runtime_part, tests_part) = emitted
            .split_once("#[cfg(test)]")
            .expect("expected generated #[cfg(test)] law module");
        assert!(runtime_part.contains("pub enum Status"));
        assert!(runtime_part.contains("Status::Open => Status::Closed,"));
        assert!(!runtime_part.contains("law close_always_closed"));
        assert!(tests_part.contains("fn law_close_always_closed()"));

        // Second run with unchanged files hits cache (0 checker invocations)
        run_with_checker(&cfg, |_file, _has_laws| {
            calls += 1;
            Ok(())
        })
        .expect("cached run succeeded");
        assert_eq!(calls, 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn lock_blocks_weakened_law_and_approves_non_vacuous_human_update() {
        let root = temp_workspace("lock_tamper");
        let core = root.join("verified/core.bend");
        fs::write(
            &core,
            "def inc(+n: Nat) -> Nat:\\n  n + 1n\\n\\n# promise: inc(2n) returns 3n\\nlaw inc_two:\\n  inc(2n) == 3n\\n\\nproof inc_two:\\n  refl\\n",
        )
        .unwrap();

        let cfg = make_cfg(&root);
        run_with_checker(&cfg, |_, _| Ok(())).expect("initial lock creation");
        let original_lock = fs::read_to_string(&cfg.lock_file).unwrap();

        // Tampering with a locked law to a vacuous tautology must fail with E_LAW_LOCK_TAMPERED
        fs::write(
            &core,
            "def inc(+n: Nat) -> Nat:\\n  n + 1n\\n\\n# promise: tautology\\nlaw inc_two:\\n  3n == 3n\\n\\nproof inc_two:\\n  refl\\n",
        )
        .unwrap();

        let err = run_with_checker(&cfg, |_, _| Ok(())).expect_err("must fail on tampered law");
        assert!(err.contains("E_LAW_LOCK_TAMPERED"));

        // Even with RUSTY_BENDS_UPDATE_LAWS=1, sealing a vacuous law is blocked with E_LAW_VACUOUS
        // and the existing lock file must remain untouched.
        let mut approved_cfg = make_cfg(&root);
        approved_cfg.allow_lock_update = true;
        let vacuous_err =
            run_with_checker(&approved_cfg, |_, _| Ok(())).expect_err("vacuous update blocked");
        assert!(vacuous_err.contains("E_LAW_VACUOUS"));
        assert_eq!(fs::read_to_string(&cfg.lock_file).unwrap(), original_lock);

        // Updating to a non-vacuous law with RUSTY_BENDS_UPDATE_LAWS=1 succeeds and updates the lock.
        fs::write(
            &core,
            "def inc(+n: Nat) -> Nat:\\n  n + 1n\\n\\n# promise: inc(3n) returns 4n\\nlaw inc_two:\\n  inc(3n) == 4n\\n\\nproof inc_two:\\n  refl\\n",
        )
        .unwrap();
        run_with_checker(&approved_cfg, |_, _| Ok(()))
            .expect("approved non-vacuous update succeeds");
        assert_ne!(fs::read_to_string(&cfg.lock_file).unwrap(), original_lock);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bend_version_pin_detects_mismatch() {
        assert!(verify_bend_version_str("0.2.38", "bend 0.2.38 (commit abc123)").is_ok());
        let err = verify_bend_version_str("0.2.38", "bend 0.3.0").unwrap_err();
        assert!(err.contains("E_BEND_VERSION_MISMATCH"));
    }

    #[test]
    fn bend_bin_resolution_prefers_env_then_path_then_home_install() {
        let root = temp_workspace("bend_bin_resolve");
        let home = root.join("home");
        let path_dir = root.join("pathdir");
        fs::create_dir_all(home.join(".bend/bin")).unwrap();
        fs::create_dir_all(&path_dir).unwrap();
        let installed = home.join(".bend/bin/bend");
        fs::write(&installed, "").unwrap();
        let empty_path = Some(env::join_paths([&path_dir]).unwrap());

        // Explicit BEND_BIN always wins.
        assert_eq!(
            resolve_bend_bin(
                Some("/opt/bend".into()),
                empty_path.clone(),
                Some(home.clone())
            ),
            "/opt/bend"
        );
        // Not on PATH -> fall back to ~/.bend/bin/bend.
        assert_eq!(
            resolve_bend_bin(None, empty_path.clone(), Some(home.clone())),
            installed.to_string_lossy()
        );
        // Blank BEND_BIN is treated as unset.
        assert_eq!(
            resolve_bend_bin(Some("  ".into()), empty_path.clone(), Some(home.clone())),
            installed.to_string_lossy()
        );
        // On PATH -> keep plain 'bend'.
        fs::write(path_dir.join("bend"), "").unwrap();
        assert_eq!(
            resolve_bend_bin(None, empty_path, Some(home.clone())),
            "bend"
        );
        // Nothing installed anywhere -> plain 'bend' (fails later with E_BEND_MISSING).
        assert_eq!(
            resolve_bend_bin(None, None, Some(root.join("nohome"))),
            "bend"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn bend_version_query_uses_subcommand_and_falls_back() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_workspace("bend_version_query");
        let script = |name: &str, body: &str| {
            let p = root.join(name);
            fs::write(&p, format!("#!/bin/sh\\n{body}\\n")).unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
            p.to_string_lossy().into_owned()
        };
        // Bend 2.0.40: 'version' works, '--version' is an unknown option.
        let new_bend = script(
            "bend_new",
            r#"if [ "$1" = version ]; then echo "bend 2.0.40"; else echo "bend: unknown option $1" >&2; exit 1; fi"#,
        );
        let v = query_bend_version(&new_bend).unwrap();
        assert!(v.contains("2.0.40"));
        assert!(verify_bend_version_str("2.0.40", &v).is_ok());

        // Older releases: only '--version' works.
        let old_bend = script(
            "bend_old",
            r#"if [ "$1" = --version ]; then echo "bend 0.2.38"; else exit 2; fi"#,
        );
        assert!(query_bend_version(&old_bend).unwrap().contains("0.2.38"));

        // Neither works: report the failure instead of matching the pin against error text.
        let broken = script("bend_broken", "echo boom >&2; exit 1");
        let err = query_bend_version(&broken).unwrap_err();
        assert!(err.contains("E_BEND_VERSION_QUERY"));
        assert!(err.contains("boom"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn verdict_mode_parsing_and_missing_lean_detection() {
        assert_eq!(VerdictMode::parse("auto"), VerdictMode::Auto);
        assert_eq!(VerdictMode::parse("require"), VerdictMode::Require);
        assert_eq!(VerdictMode::parse("off"), VerdictMode::Off);
        assert!(is_missing_lean_error(
            "Error: BendTT infrastructure: --verdict needs Lean v4.34.0"
        ));
        assert!(!is_missing_lean_error("SOME PROOFS FAIL"));
    }

    #[test]
    fn failed_law_distinguishes_false_law_counterexample_from_incomplete_proof() {
        let root = temp_workspace("issue7_diag");
        let core = root.join("verified/core.bend");
        let mut cfg = make_cfg(&root);
        cfg.bend_bin = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        cfg.verdict_mode = VerdictMode::Off;

        // 1. Valid locked release_conserves_total first
        let valid_src = r#"import Base

type Ledger is Data:
  Ledger{a: Nat, f: Nat}

def ledger_total(+p: Ledger) -> Nat:
  match p:
    case Ledger{a, f}:
      Nat.add(a, f)

def ledger_release_if(+a: Nat, +f: Nat, +rel: Nat, ok: Bool) -> Ledger:
  match ok:
    case True{}:
      Ledger{Nat.sub(a, rel), Nat.add(f, rel)}
    case False{}:
      Ledger{a, f}

def ledger_release(+p: Ledger, +rel: Nat) -> Ledger:
  match p:
    case Ledger{+a, f}:
      ledger_release_if(a, f, rel, Nat.is_le(rel, a))

# promise: releasing from a ledger conserves its total
law release_conserves_total:
  for +a: Nat
  for +f: Nat
  for +rel: Nat
  {ledger_total(ledger_release(Ledger{a, f}, rel)) == Nat.add(a, f) : Nat}
"#;
        // Seed the lock as if the law was previously sealed, then break the function (False{} drops sub, adding rel unconditionally).
        fs::write(&core, valid_src).unwrap();
        let _ = lock::enforce_law_lock(&cfg.lock_file, std::slice::from_ref(&core), false).unwrap();

        let broken_src = r#"import Base

type Ledger is Data:
  Ledger{a: Nat, f: Nat}

def ledger_total(+p: Ledger) -> Nat:
  match p:
    case Ledger{a, f}:
      Nat.add(a, f)

def ledger_release_if(+a: Nat, +f: Nat, +rel: Nat, ok: Bool) -> Ledger:
  match ok:
    case True{}:
      Ledger{Nat.sub(a, rel), Nat.add(f, rel)}
    case False{}:
      Ledger{a, Nat.add(f, rel)}

def ledger_release(+p: Ledger, +rel: Nat) -> Ledger:
  match p:
    case Ledger{+a, f}:
      ledger_release_if(a, f, rel, Nat.is_le(rel, a))

# promise: releasing from a ledger conserves its total
law release_conserves_total:
  for +a: Nat
  for +f: Nat
  for +rel: Nat
  {ledger_total(ledger_release(Ledger{a, f}, rel)) == Nat.add(a, f) : Nat}

def release_conserves_total(a, f, rel):
  {==}
"#;
        fs::write(&core, broken_src).unwrap();
        let err_false = run(&cfg).expect_err("broken function must fail build");
        assert!(
            err_false.contains("[E_LAW_FALSE] law release_conserves_total is FALSE for this code (evaluated with emitted Rust)"),
            "expected counterexample header, got:\\n{err_false}"
        );
        assert!(err_false.contains("lhs ledger_total(ledger_release(Ledger{"));
        assert!(err_false.contains("rhs Nat.add("));
        assert!(err_false.contains("stop: the law is locked"));

        // 2. True law with an incomplete proof -> no counterexample found, reports proof failure.
        let root2 = temp_workspace("issue7_proof_only");
        let core2 = root2.join("verified/core.bend");
        let mut cfg2 = make_cfg(&root2);
        cfg2.bend_bin = cfg.bend_bin.clone();
        cfg2.verdict_mode = VerdictMode::Off;

        let incomplete_proof_src = r#"import Base

def deposit(+bal: Nat, +amt: Nat) -> Nat:
  Nat.add(bal, amt)

# promise: depositing zero leaves balance unchanged
law deposit_zero:
  for +bal: Nat
  {deposit(bal, 0n) == bal : Nat}

def deposit_zero(bal):
  match bal:
    case 0n:
      {==}
    case 1n+p:
      {==}
"#;
        fs::write(&core2, incomplete_proof_src).unwrap();
        let err_proof = run(&cfg2).expect_err("incomplete proof must fail build");
        assert!(
            err_proof.contains("law deposit_zero: no counterexample up to"),
            "expected no-counterexample line, got:\\n{err_proof}"
        );
        assert!(err_proof.contains("evaluated with emitted Rust"));
        assert!(err_proof.contains("the law may be true; the proof is what failed"));
        assert!(err_proof.contains("SOME PROOFS FAIL"));

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&root2);
    }

    #[test]
    fn new_law_requires_promise_and_wording_change_preserves_lock() {
        let root = temp_workspace("issue8_promise");
        let core = root.join("verified/core.bend");
        let cfg = make_cfg(&root);

        fs::write(
            &core,
            "def inc(+n: Nat) -> Nat:\\n  n + 1n\\n\\nlaw inc_two:\\n  inc(2n) == 3n\\n",
        )
        .unwrap();
        let err = run_with_checker(&cfg, |_, _| Ok(())).expect_err("must require # promise:");
        assert!(err.contains("E_LAW_NO_PROMISE"), "got: {err}");
        assert!(!cfg.lock_file.exists(), "lock must not be written on error");

        fs::write(
            &core,
            "def inc(+n: Nat) -> Nat:\\n  n + 1n\\n\\n# promise: inc adds one to two\\nlaw inc_two:\\n  inc(2n) == 3n\\n",
        )
        .unwrap();
        run_with_checker(&cfg, |_, _| Ok(())).expect("law with # promise: passes");

        // Editing only the promise wording must not trigger E_LAW_LOCK_TAMPERED
        fs::write(
            &core,
            "def inc(+n: Nat) -> Nat:\\n  n + 1n\\n\\n# promise: incrementing two always returns three\\n# harm: off-by-one increment bug\\nlaw inc_two:\\n  inc(2n) == 3n\\n",
        )
        .unwrap();
        run_with_checker(&cfg, |_, _| Ok(()))
            .expect("promise wording edit must pass without E_LAW_LOCK_TAMPERED");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn issue9_recursive_chain_and_base_list_laws_verify_and_run_generated_rust_tests() {
        let root = temp_workspace("issue9_recursive");
        let chain_file = root.join("verified/chain.bend");
        let list_file = root.join("verified/lists.bend");

        fs::write(
            &chain_file,
            r#"import Base

type Chain is Data:
  ChainEnd{}
  ChainLink{has_limit: Bool, limit: Nat, in_use: Nat, rest: Chain}

def chain_step(+so_far: Nat, has_limit: Bool, limit: Nat, in_use: Nat) -> Nat:
  match has_limit:
    case True{}:
      Nat.min(so_far, Nat.sub(limit, in_use))
    case False{}:
      so_far

def chain_available(c: Chain, +so_far: Nat) -> Nat:
  match c:
    case ChainEnd{}:
      so_far
    case ChainLink{h, l, u, rest}:
      chain_available(rest, chain_step(so_far, h, l, u))

# promise: zero starting host capacity stays zero along any cgroup chain
law chain_available_zero:
  for c: Chain
  {chain_available(c, 0n) == 0n : Nat}

def chain_available_zero(c):
  match c:
    case ChainEnd{}:
      {==}
    case ChainLink{h, l, u, rest}:
      match h:
        case True{}:
          chain_available_zero(rest)
        case False{}:
          chain_available_zero(rest)
"#,
        )
        .unwrap();

        fs::write(
            &list_file,
            r#"import Base

def sum_list(xs: List<&2, Nat>) -> Nat:
  match xs:
    case Nil{}:
      0n
    case Con{h, t}:
      Nat.add(h, sum_list(t))

def list_cat(xs: List<&2, Nat>, ys: List<&2, Nat>) -> List<&2, Nat>:
  match xs:
    case Nil{}:
      ys
    case Con{h, t}:
      Con{h, list_cat(t, ys)}

def add_assoc(a: Nat, b: Nat, c: Nat) -> {Nat.add(a, Nat.add(b, c)) == Nat.add(Nat.add(a, b), c) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %add_assoc(ap, b, c) : {1n+Nat.add(ap, Nat.add(b, c)) == 1n+_ : Nat}
      {==}

# promise: summing two concatenated lists equals the sum of their individual sums
law sum_list_cat:
  for +xs: List<&2, Nat>
  for +ys: List<&2, Nat>
  {sum_list(list_cat(xs, ys)) == Nat.add(sum_list(xs), sum_list(ys)) : Nat}

def sum_list_cat(xs, ys):
  match xs:
    case Nil{}:
      {==}
    case Con{+h, +t}:
      %Equal.sym(Nat, sum_list(list_cat(t, ys)), Nat.add(sum_list(t), sum_list(ys)), sum_list_cat(t, ys)) : {Nat.add(h, _) == Nat.add(Nat.add(h, sum_list(t)), sum_list(ys)) : Nat}
      add_assoc(h, sum_list(t), sum_list(ys))
"#,
        )
        .unwrap();

        let mut cfg = make_cfg(&root);
        cfg.bend_bin = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        cfg.verdict_mode = if has_verdict_runtime() {
            VerdictMode::Require
        } else {
            VerdictMode::Off
        };

        let out_rs = run(&cfg)
            .expect("recursive Chain and Base List laws must pass bend, mutation check, and emit")
            .expect("expected emitted verified.rs");
        let emitted = fs::read_to_string(&out_rs).unwrap();
        assert!(emitted.contains("ChainLink(bool, u64, u64, Box<Chain>),"));
        assert!(emitted.contains("pub enum List<T>"));
        assert!(emitted.contains("fn law_chain_available_zero()"));
        assert!(emitted.contains("fn law_sum_list_cat()"));

        let bin_path = root.join("out/test_bin");
        let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = Command::new(&rustc)
            .args(["--edition", "2021", "--test", "-D", "warnings", "-o"])
            .arg(&bin_path)
            .arg(&out_rs)
            .output()
            .expect("rustc --test must execute");
        assert!(
            compile.status.success(),
            "rustc --test failed:\\n{}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run_tests = Command::new(&bin_path)
            .output()
            .expect("generated law test binary must run");
        assert!(
            run_tests.status.success(),
            "generated law tests failed:\\n{}{}",
            String::from_utf8_lossy(&run_tests.stdout),
            String::from_utf8_lossy(&run_tests.stderr)
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn issue10_sibling_import_aliases_verify_mutate_and_compile_end_to_end() {
        let root = temp_workspace("issue10_imports");
        let base_rules = root.join("verified/base_rules.bend");
        let uses = root.join("verified/uses.bend");

        fs::write(
            &base_rules,
            r#"import Base

type Status is Data:
  Open{}
  Closed{}

def within_limit(pos: Nat, limit: Nat) -> Bool:
  Nat.is_le(pos, limit)
"#,
        )
        .unwrap();

        fs::write(
            &uses,
            r#"import Base
import base_rules.bend as B

def within_both(+pos: Nat, a: Nat, b: Nat) -> Bool:
  Bool.and(B.within_limit(pos, a), Nat.is_le(pos, b))

def open_or(s: B.Status, flag: Bool) -> Bool:
  match s:
    case B.Open{}: True{}
    case B.Closed{}: flag

def diag_aux(a: Bool) -> {Bool.and(a, a) == a : Bool}:
  match a:
    case True{}: {==}
    case False{}: {==}

# promise: checking both limits when they are equal matches within_limit
law within_both_diag:
  for +pos: Nat
  for +a: Nat
  {within_both(pos, a, a) == B.within_limit(pos, a) : Bool}

def within_both_diag(pos, a):
  diag_aux(B.within_limit(pos, a))

# promise: an open status always permits the action regardless of fallback flag
law open_or_open:
  for flag: Bool
  {open_or(B.Open{}, flag) == True{} : Bool}

def open_or_open(flag):
  {==}
"#,
        )
        .unwrap();

        let mut cfg = make_cfg(&root);
        cfg.bend_bin = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        cfg.verdict_mode = if has_verdict_runtime() {
            VerdictMode::Require
        } else {
            VerdictMode::Off
        };

        let out_rs = run(&cfg)
            .expect("sibling import aliases must pass bend, mutation check, lock, and emit")
            .expect("expected emitted verified.rs");
        let emitted = fs::read_to_string(&out_rs).unwrap();
        assert!(!emitted.contains("B::"), "emitted leaked B::\\n{emitted}");
        assert!(emitted.contains("within_limit(pos, a)"), "got:\\n{emitted}");
        assert!(emitted.contains("pub enum Status"), "got:\\n{emitted}");

        let bin_path = root.join("out/test_bin");
        let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = Command::new(&rustc)
            .args(["--edition", "2021", "--test", "-D", "warnings", "-o"])
            .arg(&bin_path)
            .arg(&out_rs)
            .output()
            .expect("rustc --test must execute");
        assert!(
            compile.status.success(),
            "rustc --test failed:\\n{}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run_tests = Command::new(&bin_path)
            .output()
            .expect("generated law test binary must run");
        assert!(
            run_tests.status.success(),
            "generated law tests failed:\\n{}{}",
            String::from_utf8_lossy(&run_tests.stdout),
            String::from_utf8_lossy(&run_tests.stderr)
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nat_lemmas_bend_checks_with_bend_verdict_and_erases_completely() {
        let root = temp_workspace("issue11_lemmas_only");
        let lemma_path = write_nat_lemmas(root.join("verified"))
            .expect("write_nat_lemmas should create nat_lemmas.bend");
        assert!(lemma_path.ends_with("verified/nat_lemmas.bend"));
        assert_eq!(fs::read_to_string(&lemma_path).unwrap(), NAT_LEMMAS_BEND);

        // Idempotent second write preserves content.
        let lemma_path_2 =
            write_nat_lemmas(root.join("verified")).expect("idempotent write_nat_lemmas");
        assert_eq!(lemma_path_2, lemma_path);

        let erased =
            emit::emit_verified_rust(NAT_LEMMAS_BEND, 0).expect("nat_lemmas.bend must emit");
        assert_eq!(erased.types_emitted, 0);
        assert_eq!(erased.defs_emitted, 0);

        let bend_bin = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        if Path::new(&bend_bin).is_file() || env::var("BEND_BIN").is_ok() {
            run_bend_step(&bend_bin, "--check-only", &lemma_path)
                .expect("nat_lemmas.bend must pass bend --check-only");
            if has_verdict_runtime() {
                run_bend_step(&bend_bin, "--verdict", &lemma_path)
                    .expect("nat_lemmas.bend must pass bend --verdict");
            }
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn chunk_split_laws_verified_with_bundled_nat_lemmas() {
        let root = temp_workspace("issue11_chunk_split");
        let _ = write_nat_lemmas(root.join("verified"))
            .expect("write_nat_lemmas should populate verified/");
        let chunks_file = root.join("verified/chunks.bend");
        fs::write(
            &chunks_file,
            r#"import Base
import nat_lemmas.bend as L

def chunk_of(t: Nat, per: Nat) -> Nat:
  Nat.div(t, 1n+per)

def slot_of(t: Nat, per: Nat) -> Nat:
  Nat.mod(t, 1n+per)

def index_of(chunk: Nat, slot: Nat, per: Nat) -> Nat:
  Nat.add(slot, Nat.mul(chunk, 1n+per))

# promise: every index maps to a slot strictly below the chunk size
law slot_below_size:
  for t: Nat
  for per: Nat
  {Nat.is_lt(slot_of(t, per), 1n+per) == True{} : Bool}

def slot_below_size(t, per):
  L.nat_mod_lt(t, per)

# promise: splitting an index into chunk and slot reconstructs the original index
law split_reconstructs_index:
  for t: Nat
  for per: Nat
  {index_of(chunk_of(t, per), slot_of(t, per), per) == t : Nat}

def split_reconstructs_index(t, per):
  L.nat_div_mod(t, per)

# promise: every index below chunks * chunk size maps to a chunk strictly below chunks
law chunk_in_bounds:
  for t: Nat
  for chunks: Nat
  for per: Nat
  for h: {Nat.is_lt(t, Nat.mul(chunks, 1n+per)) == True{} : Bool}
  {Nat.is_lt(chunk_of(t, per), chunks) == True{} : Bool}

def chunk_in_bounds(t, chunks, per, h):
  L.nat_div_lt_of_lt_mul(t, chunks, per, h)
"#,
        )
        .unwrap();

        let mut cfg = make_cfg(&root);
        cfg.bend_bin = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        cfg.verdict_mode = if has_verdict_runtime() {
            VerdictMode::Require
        } else {
            VerdictMode::Off
        };

        let out_rs = run(&cfg)
            .expect("chunk split laws using nat_lemmas.bend must pass bend, mutation check, lock, and emit")
            .expect("expected emitted verified.rs");
        let emitted = fs::read_to_string(&out_rs).unwrap();
        assert!(emitted.contains("pub fn chunk_of("), "got:\\n{emitted}");
        assert!(emitted.contains("pub fn slot_of("), "got:\\n{emitted}");
        assert!(emitted.contains("pub fn index_of("), "got:\\n{emitted}");
        assert!(
            !emitted.contains("nat_mod_lt"),
            "emitted leaked proof helper:\\n{emitted}"
        );
        assert!(
            !emitted.contains("nat_div_mod"),
            "emitted leaked proof helper:\\n{emitted}"
        );
        assert!(
            !emitted.contains("bool_pick_type"),
            "emitted leaked type helper:\\n{emitted}"
        );
        assert!(
            !emitted.contains("L::"),
            "emitted leaked alias L:::\\n{emitted}"
        );

        let bin_path = root.join("out/test_bin");
        let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = Command::new(&rustc)
            .args(["--edition", "2021", "--test", "-D", "warnings", "-o"])
            .arg(&bin_path)
            .arg(&out_rs)
            .output()
            .expect("rustc --test must execute");
        assert!(
            compile.status.success(),
            "rustc --test failed:\\n{}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run_tests = Command::new(&bin_path)
            .output()
            .expect("generated law test binary must run");
        assert!(
            run_tests.status.success(),
            "generated law tests failed:\\n{}{}",
            String::from_utf8_lossy(&run_tests.stdout),
            String::from_utf8_lossy(&run_tests.stderr)
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn euclidean_division_lemmas_verify_with_verdict_and_run_rust_tests() {
        let root = temp_workspace("issue22_euclidean");
        let _ = write_nat_lemmas(root.join("verified"))
            .expect("write_nat_lemmas should populate verified/");
        let grid_file = root.join("verified/grid.bend");
        fs::write(
            &grid_file,
            r#"import Base
import nat_lemmas.bend as L

def slot_of(+i: Nat) -> Nat:
  Nat.mod(i, 4n)

def row_of(+i: Nat) -> Nat:
  Nat.div(i, 4n)

def make_index(+q: Nat, +r: Nat) -> Nat:
  Nat.add(Nat.mul(q, 4n), r)

# promise: the slot of row q and slot r (r < 4) is r
law slot_of_split:
  for +q: Nat
  for +r: Nat
  for h: {Nat.is_lt(r, 4n) == True{} : Bool}
  {slot_of(make_index(q, r)) == r : Nat}

def slot_of_split(q, r, h):
  L.nat_mod_split(q, r, 3n, h)

# promise: the row of row q and slot r (r < 4) is q
law row_of_split:
  for q: Nat
  for r: Nat
  for h: {Nat.is_lt(r, 4n) == True{} : Bool}
  {row_of(make_index(q, r)) == q : Nat}

def row_of_split(q, r, h):
  L.nat_div_split(q, r, 3n, h)

# promise: an index below four keeps its value as its slot
law slot_of_small:
  for a: Nat
  for h: {Nat.is_lt(a, 4n) == True{} : Bool}
  {slot_of(a) == a : Nat}

def slot_of_small(a, h):
  L.nat_mod_small(a, 3n, h)

# promise: an index below four has row zero
law row_of_small:
  for a: Nat
  for h: {Nat.is_lt(a, 4n) == True{} : Bool}
  {row_of(a) == 0n : Nat}

def row_of_small(a, h):
  L.nat_div_small(a, 3n, h)

# promise: two indices with the same row and slot are equal
law eq_of_row_and_slot:
  for a: Nat
  for c: Nat
  for hq: {row_of(a) == row_of(c) : Nat}
  for hr: {slot_of(a) == slot_of(c) : Nat}
  {a == c : Nat}

def eq_of_row_and_slot(a, c, hq, hr):
  L.nat_eq_of_div_mod(a, c, 3n, hq, hr)

# promise: row q below n with slot r below 4 stays below n * 4
law split_in_bounds:
  for q: Nat
  for r: Nat
  for n: Nat
  for hq: {Nat.is_lt(q, n) == True{} : Bool}
  for hr: {Nat.is_lt(r, 4n) == True{} : Bool}
  {Nat.is_lt(make_index(q, r), Nat.mul(n, 4n)) == True{} : Bool}

def split_in_bounds(q, r, n, hq, hr):
  L.nat_split_lt(q, r, n, 3n, hq, hr)

# promise: multiples of four have slot zero
law aligned_slot_zero:
  for q: Nat
  {slot_of(Nat.mul(q, 4n)) == 0n : Nat}

def aligned_slot_zero(q):
  L.nat_mod_mul(q, 3n)

# promise: dividing a multiple of four recovers the row
law aligned_row:
  for q: Nat
  {row_of(Nat.mul(q, 4n)) == q : Nat}

def aligned_row(q):
  L.nat_div_mul(q, 3n)

# promise: the aligned-down index never exceeds the original index
law align_down_le:
  for a: Nat
  {Nat.is_le(Nat.mul(row_of(a), 4n), a) == True{} : Bool}

def align_down_le(a):
  L.nat_align_down_le(a, 3n)
"#,
        )
        .unwrap();

        let mut cfg = make_cfg(&root);
        cfg.bend_bin = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        cfg.verdict_mode = if has_verdict_runtime() {
            VerdictMode::Require
        } else {
            VerdictMode::Off
        };

        let out_rs = run(&cfg)
            .expect("Euclidean division laws must pass bend, verdict, mutation check, and emit")
            .expect("expected emitted verified.rs");
        let emitted = fs::read_to_string(&out_rs).unwrap();
        assert!(emitted.contains("pub fn slot_of("), "got:\\n{emitted}");
        assert!(emitted.contains("pub fn row_of("), "got:\\n{emitted}");
        assert!(emitted.contains("pub fn make_index("), "got:\\n{emitted}");
        for leaked in [
            "nat_mod_split",
            "nat_div_split",
            "nat_split_unique_q",
            "nat_split_unique_r",
            "nat_eq_of_div_mod",
            "nat_align_down_le",
        ] {
            assert!(
                !emitted.contains(leaked),
                "emitted leaked proof helper {leaked}:\\n{emitted}"
            );
        }

        let bin_path = root.join("out/test_bin");
        let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = Command::new(&rustc)
            .args(["--edition", "2021", "--test", "-D", "warnings", "-o"])
            .arg(&bin_path)
            .arg(&out_rs)
            .output()
            .expect("rustc --test must execute");
        assert!(
            compile.status.success(),
            "rustc --test failed:\\n{}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run_tests = Command::new(&bin_path)
            .output()
            .expect("generated law test binary must run");
        assert!(
            run_tests.status.success(),
            "generated law tests failed:\\n{}{}",
            String::from_utf8_lossy(&run_tests.stdout),
            String::from_utf8_lossy(&run_tests.stderr)
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_rejects_verdict_require_after_off_or_skipped_build_and_tracks_flags() {
        let root = temp_workspace("issue18_cache");
        let _ = write_nat_lemmas(root.join("verified")).unwrap();
        let ledger = root.join("verified/ledger.bend");
        fs::write(
            &ledger,
            r#"import Base
import nat_lemmas.bend as L

def total_items(+a: Nat, +b: Nat) -> Nat:
  Nat.add(a, b)

def bump(+n: Nat) -> Nat:
  1n+n

# promise: the total never drops below the first delivery
law total_covers_first:
  for +a: Nat
  for +b: Nat
  {Nat.is_le(a, total_items(a, b)) == True{} : Bool}

def total_covers_first(a, b):
  L.nat_add_le_r(a, b)

# promise: a write always changes the stamp
law bump_changes:
  for +m: Nat
  {Nat.is_eq(m, bump(m)) == False{} : Bool}

def bump_changes(m):
  match m:
    case 0n:
      {==}
    case 1n+mp:
      bump_changes(mp)
"#,
        )
        .unwrap();

        let real_bend = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );

        // 1. Failing --verdict invocation (unknown flag) fails directly without misleading proof note.
        let mut bad_req = make_cfg(&root);
        bad_req.bend_bin = real_bend.clone();
        bad_req.verdict_mode = VerdictMode::Require;
        bad_req.verdict_flag = "--no-such-flag".to_string();
        let err1 = run(&bad_req).expect_err("unknown verdict flag must fail");
        assert!(err1.contains("unknown option --no-such-flag"), "{err1}");
        assert!(
            !err1.contains("the proof is what failed"),
            "CLI error must not misdiagnose proof failure:\\n{err1}"
        );

        // 2. BEND_VERDICT=off succeeds and records verdict=off in cache.
        let mut off_cfg = make_cfg(&root);
        off_cfg.bend_bin = real_bend.clone();
        off_cfg.verdict_mode = VerdictMode::Off;
        run(&off_cfg).expect("off build passes");
        let cache_off = fs::read_to_string(root.join("out/rusty-bends.cache")).unwrap();
        assert!(cache_off.contains("verdict=off\\n"), "{cache_off}");

        // 3. Subsequent BEND_VERDICT=require with bad flag must NOT hit cache.
        let err2 = run(&bad_req).expect_err("require build after off build must miss cache");
        assert!(err2.contains("unknown option --no-such-flag"), "{err2}");

        // 4. Skipped Auto verdict (no Lean runtime) followed by Require must also miss cache.
        let mut auto_cfg = make_cfg(&root);
        auto_cfg.verdict_mode = VerdictMode::Auto;
        let mut calls = 0usize;
        run_pipeline(&auto_cfg, Some("bend 2.0.40"), false, |_file, _has_laws| {
            calls += 1;
            Ok(VerdictApplied::Skipped)
        })
        .expect("auto skipped build passes");
        assert_eq!(calls, 2);
        let cache_skip = fs::read_to_string(root.join("out/rusty-bends.cache")).unwrap();
        assert!(cache_skip.contains("verdict=skipped\\n"), "{cache_skip}");

        let mut req_cfg = make_cfg(&root);
        req_cfg.verdict_mode = VerdictMode::Require;
        run_pipeline(&req_cfg, Some("bend 2.0.40"), true, |_file, _has_laws| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .expect("require build runs checker");
        assert_eq!(calls, 4, "require after skipped must miss cache");

        // Repeating Require with identical config hits cache.
        run_pipeline(&req_cfg, Some("bend 2.0.40"), true, |_file, _has_laws| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .expect("matching require build hits cache");
        assert_eq!(calls, 4);

        // 5. Changing flags, bend_bin, bend_version, or no_cache misses cache.
        let mut diff_check = req_cfg.clone();
        diff_check.check_flag = "--check-only-alt".to_string();
        run_pipeline(&diff_check, Some("bend 2.0.40"), true, |_, _| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .unwrap();
        assert_eq!(calls, 6);

        let mut diff_verdict_flag = req_cfg.clone();
        diff_verdict_flag.verdict_flag = "--verdict-alt".to_string();
        run_pipeline(&diff_verdict_flag, Some("bend 2.0.40"), true, |_, _| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .unwrap();
        assert_eq!(calls, 8);

        let mut diff_bin = req_cfg.clone();
        diff_bin.bend_bin = "/opt/bend".to_string();
        run_pipeline(&diff_bin, Some("bend 2.0.40"), true, |_, _| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .unwrap();
        assert_eq!(calls, 10);

        run_pipeline(&diff_bin, Some("bend 2.0.41"), true, |_, _| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .unwrap();
        assert_eq!(calls, 12);

        let mut no_cache_cfg = diff_bin.clone();
        no_cache_cfg.no_cache = true;
        run_pipeline(&no_cache_cfg, Some("bend 2.0.41"), true, |_, _| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .unwrap();
        assert_eq!(calls, 14);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn selective_lock_update_blocks_vacuous_named_law_without_touching_lock() {
        let root = temp_workspace("issue17_e2e");
        let core = root.join("verified/core.bend");
        fs::write(
            &core,
            "import Base\\n\\ndef inc(+n: Nat) -> Nat:\\n  Nat.add(n, 1n)\\n\\n# promise: zero increments to one\\nlaw inc_zero:\\n  {inc(0n) == 1n : Nat}\\n",
        )
        .unwrap();

        let cfg = make_cfg(&root);
        run_with_checker(&cfg, |_, _| Ok(())).expect("initial lock creation");
        let original_lock = fs::read_to_string(&cfg.lock_file).unwrap();

        fs::write(
            &core,
            "import Base\\n\\ndef inc(+n: Nat) -> Nat:\\n  Nat.add(n, 1n)\\n\\n# promise: zero increments to one\\nlaw inc_zero:\\n  {inc(0n) == 1n : Nat}\\n\\n# promise: vacuous identity\\nlaw inc_refl:\\n  for +n: Nat\\n  {inc(n) == inc(n) : Nat}\\n",
        )
        .unwrap();

        let mut seal_vacuous = make_cfg(&root);
        seal_vacuous.lock_update = LockUpdateMode::parse("inc_refl");
        let err = run_with_checker(&seal_vacuous, |_, _| Ok(()))
            .expect_err("vacuous named law must fail before lock write");
        assert!(err.contains("E_LAW_VACUOUS"), "{err}");
        assert_eq!(fs::read_to_string(&cfg.lock_file).unwrap(), original_lock);

        // Replace vacuous law with two valid new laws and seal only one by name.
        fs::write(
            &core,
            "import Base\\n\\ndef inc(+n: Nat) -> Nat:\\n  Nat.add(n, 1n)\\n\\n# promise: zero increments to one\\nlaw inc_zero:\\n  {inc(0n) == 1n : Nat}\\n\\n# promise: one increments to two\\nlaw inc_one:\\n  {inc(1n) == 2n : Nat}\\n\\n# promise: two increments to three\\nlaw inc_two:\\n  {inc(2n) == 3n : Nat}\\n",
        )
        .unwrap();
        let mut seal_one = make_cfg(&root);
        seal_one.lock_update = LockUpdateMode::parse("inc_one");
        run_with_checker(&seal_one, |_, _| Ok(())).expect("named seal of inc_one succeeds");
        let lock_after = fs::read_to_string(&cfg.lock_file).unwrap();
        assert!(lock_after.contains("inc_zero"));
        assert!(lock_after.contains("inc_one"));
        assert!(!lock_after.contains("inc_two"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_coverage_runs_through_pipeline_and_bypasses_warm_cache() {
        let root = temp_workspace("issue21_pipeline");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("verified/ledger.bend"),
            r#"import Base

def order_fits(+used: Nat, +want: Nat, +cap: Nat) -> Bool:
  Nat.is_le(want, Nat.sub(cap, used))

def order_fits_spec(+used: Nat, +want: Nat, +cap: Nat) -> Bool:
  Nat.is_le(Nat.add(used, want), cap)

def round_up(+x: Nat, +step: Nat) -> Nat:
  Nat.mul(Nat.div(Nat.add(x, Nat.sub(step, 1n)), step), step)

# promise: an empty order always fits
law order_fits_empty:
  for +cap: Nat
  {order_fits_spec(0n, 0n, cap) == True{} : Bool}
"#,
        )
        .unwrap();
        fs::write(
            root.join("src/main.rs"),
            "fn main() { let _ = (verified::order_fits(3, 4, 10), verified::round_up(5, 4)); }\\n",
        )
        .unwrap();

        let cfg = make_cfg(&root);
        let mut calls = 0usize;
        run_with_checker(&cfg, |_, _| {
            calls += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(calls, 1);

        // With list_coverage = true, the build bypasses warm cache and runs coverage listing.
        let mut cov_cfg = make_cfg(&root);
        cov_cfg.list_coverage = true;
        run_with_checker(&cov_cfg, |_, _| {
            calls += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(calls, 2);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn multiline_warning_formats_one_cargo_warning_per_line() {
        let lines = format_cargo_warning_lines(
            "[E_MUTANT_BUILD] Law 'foo': 1 of 2 mutants did not compile\\nFirst failing mutant: f: x -> Y\\nrustc: error[E0308]: mismatched types",
        );
        assert_eq!(
            lines,
            vec![
                "cargo:warning=[E_MUTANT_BUILD] Law 'foo': 1 of 2 mutants did not compile",
                "cargo:warning=First failing mutant: f: x -> Y",
                "cargo:warning=rustc: error[E0308]: mismatched types",
            ]
        );
        for line in &lines {
            assert!(!line.contains('\\n'));
        }
    }

    #[test]
    fn cache_invalidates_when_builder_hash_changes() {
        assert_eq!(BUILDER_HASH.len(), 32, "BUILDER_HASH={BUILDER_HASH}");
        assert!(
            BUILDER_HASH.chars().all(|c| c.is_ascii_hexdigit()),
            "BUILDER_HASH={BUILDER_HASH}"
        );

        let root = temp_workspace("issue24_builder_hash");
        fs::write(
            root.join("verified/core.bend"),
            "import Base\\n\\ndef add_one(+n: Nat) -> Nat:\\n  Nat.add(n, 1n)\\n\\n# promise: zero increments to one\\nlaw add_one_zero:\\n  {add_one(0n) == 1n : Nat}\\n",
        )
        .unwrap();

        let cfg = make_cfg(&root);
        let mut calls = 0usize;
        let out_rs =
            run_pipeline_with_builder(&cfg, Some("bend 2.0.40"), "builder_a", true, |_, _| {
                calls += 1;
                Ok(VerdictApplied::Ran)
            })
            .expect("first build with builder_a succeeds")
            .expect("verified.rs emitted");
        assert_eq!(calls, 1);
        let cache_a = fs::read_to_string(root.join("out/rusty-bends.cache")).unwrap();
        assert!(cache_a.starts_with("v4\\n"), "{cache_a}");
        assert!(cache_a.contains("builder=builder_a\\n"), "{cache_a}");

        // Repeating with identical builder hash hits cache.
        run_pipeline_with_builder(&cfg, Some("bend 2.0.40"), "builder_a", true, |_, _| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .expect("second build with builder_a hits cache");
        assert_eq!(calls, 1);

        // Switching builder hash invalidates the warm stamp and regenerates verified.rs.
        fs::write(&out_rs, "// stale-verified\\n").unwrap();
        run_pipeline_with_builder(&cfg, Some("bend 2.0.40"), "builder_b", true, |_, _| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .expect("build with builder_b misses cache and regenerates");
        assert_eq!(calls, 2);
        let emitted_b = fs::read_to_string(&out_rs).unwrap();
        assert!(
            !emitted_b.contains("stale-verified"),
            "expected regenerated verified.rs, got:\\n{emitted_b}"
        );
        let cache_b = fs::read_to_string(root.join("out/rusty-bends.cache")).unwrap();
        assert!(cache_b.contains("builder=builder_b\\n"), "{cache_b}");

        let _ = fs::remove_dir_all(&root);
    }

    fn copy_dir_recursive(src: &Path, dst: &Path) {
        fs::create_dir_all(dst).unwrap();
        for entry in fs::read_dir(src).unwrap() {
            let entry = entry.unwrap();
            let src_path = entry.path();
            let dst_path = dst.join(entry.file_name());
            if src_path.is_dir() {
                copy_dir_recursive(&src_path, &dst_path);
            } else if src_path.is_file() {
                fs::copy(&src_path, &dst_path).unwrap();
            }
        }
    }

    fn find_app_out_file(build_dir: &Path, file_name: &str) -> PathBuf {
        let mut matches = Vec::new();
        for entry in fs::read_dir(build_dir).unwrap() {
            let path = entry.unwrap().path();
            let is_app = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("app-"));
            if is_app {
                let candidate = path.join("out").join(file_name);
                if candidate.is_file() {
                    matches.push(candidate);
                }
            }
        }
        assert_eq!(
            matches.len(),
            1,
            "expected exactly one {file_name} under {}, got {matches:?}",
            build_dir.display()
        );
        matches.pop().unwrap()
    }

    #[test]
    fn cargo_rebuild_invalidates_cache_when_rusty_bends_build_changes() {
        let root = temp_workspace("issue24_cargo_rebuild");
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let rb = root.join("rb");
        fs::create_dir_all(&rb).unwrap();
        fs::copy(manifest.join("Cargo.toml"), rb.join("Cargo.toml")).unwrap();
        fs::copy(manifest.join("build.rs"), rb.join("build.rs")).unwrap();
        copy_dir_recursive(&manifest.join("src"), &rb.join("src"));
        copy_dir_recursive(&manifest.join("lemmas"), &rb.join("lemmas"));

        let app = root.join("app");
        fs::create_dir_all(app.join("verified")).unwrap();
        fs::create_dir_all(app.join("src")).unwrap();
        fs::write(
            app.join("Cargo.toml"),
            "[package]\\nname = \\"app\\"\\nversion = \\"0.1.0\\"\\nedition = \\"2021\\"\\n\\n[workspace]\\n\\n[build-dependencies]\\nrusty-bends-build = { path = \\"../rb\\" }\\n",
        )
        .unwrap();
        fs::write(
            app.join("build.rs"),
            "fn main() {\\n    rusty_bends_build::write_nat_lemmas(\\"verified\\").unwrap();\\n    rusty_bends_build::verify_and_emit(\\"verified\\");\\n}\\n",
        )
        .unwrap();
        fs::write(
            app.join("verified/ledger.bend"),
            r#"import Base
import nat_lemmas.bend as L

# Items held after two deliveries arrive.
def total_items(+a: Nat, +b: Nat) -> Nat:
  Nat.add(a, b)

# promise: the total never drops below the first delivery
law total_covers_first:
  for +a: Nat
  for +b: Nat
  {Nat.is_le(a, total_items(a, b)) == True{} : Bool}

def total_covers_first(a, b):
  L.nat_add_le_r(a, b)
"#,
        )
        .unwrap();
        fs::write(
            app.join("src/main.rs"),
            "mod verified {\\n    include!(concat!(env!(\\"OUT_DIR\\"), \\"/verified.rs\\"));\\n}\\n\\nfn main() {\\n    println!(\\"{}\\", verified::total_items(2, 3));\\n}\\n",
        )
        .unwrap();

        let cargo_bin = env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
        let real_bend = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        let run_cargo = || {
            let out = Command::new(&cargo_bin)
                .current_dir(&app)
                .args(["check", "--offline"])
                .env("CARGO_TARGET_DIR", app.join("target"))
                .env_remove("RUSTY_BENDS_NO_CACHE")
                .env_remove("RUSTY_BENDS_UPDATE_LAWS")
                .env_remove("RUSTY_BENDS_MUTATE")
                .env("BEND_VERDICT", "off")
                .env("BEND_BIN", &real_bend)
                .output()
                .expect("failed to invoke cargo check");
            assert!(
                out.status.success(),
                "cargo check --offline failed:\\nstdout:\\n{}\\nstderr:\\n{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        };

        run_cargo();
        let build_out_dir = app.join("target/debug/build");
        let verified_path = find_app_out_file(&build_out_dir, "verified.rs");
        let cache_path = find_app_out_file(&build_out_dir, "rusty-bends.cache");
        let before_rs = fs::read_to_string(&verified_path).unwrap();
        let before_first_line = before_rs.lines().next().unwrap_or("");
        assert!(
            before_first_line.starts_with("// @generated by rusty-bends-build v1")
                && !before_first_line.contains("NEW-EMITTER"),
            "unexpected initial header: {before_first_line}"
        );
        let cache_before = fs::read_to_string(&cache_path).unwrap();

        // Update only \`rb/src/emit.rs\`; the app's \`.bend\` files stay untouched.
        let emit_path = rb.join("src/emit.rs");
        let emit_src = fs::read_to_string(&emit_path).unwrap();
        let patched_emit = emit_src.replacen(
            "// @generated by rusty-bends-build v1 (Verified Core -> Pure Rust)",
            "// @generated by rusty-bends-build v1 (Verified Core -> Pure Rust) NEW-EMITTER",
            1,
        );
        assert_ne!(patched_emit, emit_src, "expected header literal in emit.rs");
        fs::write(&emit_path, patched_emit).unwrap();

        run_cargo();
        let after_rs = fs::read_to_string(&verified_path).unwrap();
        let after_first_line = after_rs.lines().next().unwrap_or("");
        assert!(
            after_first_line.contains("NEW-EMITTER"),
            "expected regenerated verified.rs after rb change, still got: {after_first_line}"
        );
        let cache_after = fs::read_to_string(&cache_path).unwrap();
        assert_ne!(
            cache_after, cache_before,
            "cache stamp must update with new builder hash"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
`;

  const buildCrateLawTest = `//! Generated per-law Rust tests for RustyBends.
//!
//! Parses \`law\` declarations from Bend 2 sources and emits \`#[cfg(test)]\` tests
//! into \`OUT_DIR/verified.rs\` so \`cargo test\` evaluates every law directly against
//! the emitted Rust code (catching translation bugs and \`Nat\`/\`u64\` edge divergence).

use crate::emit::{
    arith_mode_for_type, bend_type_to_rust, collect_law_source_slices, emit_expr_with_mode,
    emit_items_to_rust, is_top_level_start, is_wrapped_in_parens, parse_book_items,
    parse_list_elem_type, rust_ident, split_top_level_once, split_top_level_str, split_type_args,
    strip_comment, type_contains_non_copy, ArithMode, Def, TypeDef, TypeEnv,
};
use crate::lock;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static EVAL_SEQ: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LawVar {
    pub name: String,
    pub ty: String,
    pub is_type_param: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LawHypothesis {
    pub lhs: String,
    pub rhs: String,
    pub ty: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedLaw {
    pub name: String,
    pub vars: Vec<LawVar>,
    pub hypotheses: Vec<LawHypothesis>,
    pub lhs: String,
    pub rhs: String,
    pub eq_ty: String,
    pub unsupported_reason: Option<String>,
}

/// Parses all \`law\` declarations from Bend source (Bend 2 \`for ... {lhs == rhs : Ty}\`
/// as well as legacy \`law name(for ...): lhs == rhs\` syntax).
pub fn parse_laws(source: &str) -> Vec<ParsedLaw> {
    let resolved = crate::emit::resolve_import_aliases(source);
    let lines: Vec<&str> = resolved.lines().collect();
    let mut laws = Vec::new();
    let mut i = 0usize;

    while i < lines.len() {
        let stripped = strip_comment(lines[i]).trim();
        if stripped.starts_with("law ") {
            let mut block_parts = vec![stripped.to_string()];
            i += 1;
            while i < lines.len() {
                let clean = strip_comment(lines[i]);
                let trimmed = clean.trim();
                if trimmed.is_empty() {
                    i += 1;
                    continue;
                }
                if is_top_level_start(lines[i], trimmed) {
                    break;
                }
                block_parts.push(trimmed.to_string());
                i += 1;
            }
            let block = block_parts.join(" ");
            if let Some(parsed) = parse_single_law_block(&block) {
                laws.push(parsed);
            }
            continue;
        }
        i += 1;
    }

    laws
}

fn parse_single_law_block(block: &str) -> Option<ParsedLaw> {
    let after_law = block.trim().strip_prefix("law ")?.trim();
    let (header_raw, body_raw) = split_top_level_once(after_law, ':')?;

    let mut vars = Vec::new();
    let mut hypotheses = Vec::new();
    let mut unsupported_reason = None;

    let name = if let Some(open) = header_raw.find('(') {
        let nm = header_raw[..open].trim().to_string();
        if header_raw.trim_end().ends_with(')') {
            let inner = header_raw[open + 1..header_raw.trim_end().len() - 1].trim();
            if !inner.is_empty() {
                for clause in split_type_args(inner, ',') {
                    let c = clause.trim();
                    if let Some(after_for) = c.strip_prefix("for ") {
                        parse_clause_binder(after_for, &mut vars, &mut hypotheses);
                    } else if c.starts_with("exs ") {
                        unsupported_reason =
                            Some("existential quantifier 'exs' is not testable".to_string());
                    }
                }
            }
        }
        nm
    } else {
        header_raw.trim().to_string()
    };

    if name.is_empty() {
        return None;
    }

    let mut rest = body_raw.trim();
    while unsupported_reason.is_none() {
        if let Some(after_for) = strip_kw_prefix(rest, "for") {
            let (clause_str, next_rest) = split_law_clause(after_for);
            if !parse_clause_binder(clause_str, &mut vars, &mut hypotheses) {
                unsupported_reason = Some(format!("could not parse law clause 'for {clause_str}'"));
                break;
            }
            rest = next_rest.trim();
            if strip_kw_prefix(rest, "where").is_some() {
                unsupported_reason =
                    Some("'where' refinement clause in law is not testable".to_string());
                break;
            }
        } else if strip_kw_prefix(rest, "exs").is_some() {
            unsupported_reason = Some("existential quantifier 'exs' is not testable".to_string());
            break;
        } else {
            break;
        }
    }

    if let Some(reason) = unsupported_reason {
        return Some(ParsedLaw {
            name,
            vars,
            hypotheses,
            lhs: String::new(),
            rhs: String::new(),
            eq_ty: String::new(),
            unsupported_reason: Some(reason),
        });
    }

    let goal_str = rest.trim();
    let (prop_str, eq_ty) = if is_wrapped_in_braces(goal_str) {
        let inner = goal_str[1..goal_str.len() - 1].trim();
        if let Some((prop, ty)) = split_last_top_level_colon(inner) {
            (prop.trim().to_string(), ty.trim().to_string())
        } else {
            (inner.to_string(), String::new())
        }
    } else {
        (goal_str.to_string(), String::new())
    };

    if let Some((lhs, rhs)) = split_top_level_str(&prop_str, "==") {
        Some(ParsedLaw {
            name,
            vars,
            hypotheses,
            lhs: lhs.trim().to_string(),
            rhs: rhs.trim().to_string(),
            eq_ty,
            unsupported_reason: None,
        })
    } else {
        Some(ParsedLaw {
            name,
            vars,
            hypotheses,
            lhs: String::new(),
            rhs: String::new(),
            eq_ty,
            unsupported_reason: Some("law goal is not an equality ('==')".to_string()),
        })
    }
}

fn strip_kw_prefix<'a>(s: &'a str, kw: &str) -> Option<&'a str> {
    let t = s.trim_start();
    let after = t.strip_prefix(kw)?;
    if after.chars().next().is_some_and(char::is_whitespace) {
        Some(after.trim_start())
    } else {
        None
    }
}

fn split_law_clause(after_for: &str) -> (&str, &str) {
    // Handle \`binder: {lhs == rhs : Ty}\` vs \`binder: TypeExpr\`
    if let Some((_lhs, rhs)) = split_top_level_once(after_for, ':') {
        let rhs_trim = rhs.trim_start();
        if rhs_trim.starts_with('{') {
            if let Some(end_brace) = find_matching_brace(rhs_trim) {
                let total_end = (after_for.len() - rhs_trim.len()) + end_brace + 1;
                return (after_for[..total_end].trim(), after_for[total_end..].trim());
            }
        }
    }

    // Scan top-level (depth 0 over (), {}, [], <>) until next \`for \`, \`exs \`, \`where \`, or \`{\`
    let bytes = after_for.as_bytes();
    let mut depth = 0i32;
    let mut saw_colon = false;
    for (idx, ch) in after_for.char_indices() {
        match ch {
            '(' | '[' | '<' => depth += 1,
            ')' | ']' | '>' => depth -= 1,
            '{' => {
                if depth == 0 && saw_colon {
                    return (after_for[..idx].trim(), after_for[idx..].trim());
                }
                depth += 1;
            }
            '}' => depth -= 1,
            ':' if depth == 0 => saw_colon = true,
            _ if depth == 0 && saw_colon && ch.is_whitespace() => {
                let tail = after_for[idx..].trim_start();
                if strip_kw_prefix(tail, "for").is_some()
                    || strip_kw_prefix(tail, "exs").is_some()
                    || strip_kw_prefix(tail, "where").is_some()
                {
                    return (after_for[..idx].trim(), tail);
                }
            }
            _ => {}
        }
        let _ = bytes;
    }

    (after_for.trim(), "")
}

fn find_matching_brace(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    for (idx, ch) in s.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(idx);
                }
            }
            _ => {}
        }
    }
    None
}

fn parse_clause_binder(
    clause: &str,
    vars: &mut Vec<LawVar>,
    hypotheses: &mut Vec<LawHypothesis>,
) -> bool {
    let Some((raw_name, raw_ty)) = split_top_level_once(clause, ':') else {
        return false;
    };
    let clean_name = raw_name
        .trim()
        .trim_start_matches('+')
        .trim_start_matches('-')
        .trim_start_matches('~')
        .trim();
    let ty = raw_ty.trim();
    if clean_name.is_empty() || ty.is_empty() {
        return false;
    }

    if is_wrapped_in_braces(ty) {
        let inner = ty[1..ty.len() - 1].trim();
        let (prop, eq_ty) = if let Some((p, t)) = split_last_top_level_colon(inner) {
            (p.trim(), t.trim())
        } else {
            (inner, "")
        };
        if let Some((lhs, rhs)) = split_top_level_str(prop, "==") {
            hypotheses.push(LawHypothesis {
                lhs: lhs.trim().to_string(),
                rhs: rhs.trim().to_string(),
                ty: eq_ty.to_string(),
            });
            return true;
        }
        return false;
    }

    let is_type_param = matches!(ty, "Type" | "Data" | "*1" | "*2");
    vars.push(LawVar {
        name: clean_name.to_string(),
        ty: ty.to_string(),
        is_type_param,
    });
    true
}

fn is_wrapped_in_braces(s: &str) -> bool {
    if !(s.starts_with('{') && s.ends_with('}')) {
        return false;
    }
    find_matching_brace(s) == Some(s.len() - 1)
}

fn split_last_top_level_colon(s: &str) -> Option<(&str, &str)> {
    let mut depth = 0i32;
    let mut last = None;
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            ':' if depth == 0 => last = Some(idx),
            _ => {}
        }
    }
    last.map(|idx| (s[..idx].trim(), s[idx + 1..].trim()))
}

/// Computes the transitive live \`def\` dependency cone referenced by a law.
pub fn law_dependency_cone(law: &ParsedLaw, defs: &[Def]) -> Vec<String> {
    let def_map: HashMap<&str, &Def> = defs.iter().map(|d| (d.name.as_str(), d)).collect();
    let mut visited = BTreeSet::new();
    let mut queue = VecDeque::new();

    for expr in std::iter::once(law.lhs.as_str())
        .chain(std::iter::once(law.rhs.as_str()))
        .chain(
            law.hypotheses
                .iter()
                .flat_map(|h| [h.lhs.as_str(), h.rhs.as_str()]),
        )
    {
        for tok in lock::tokenize_bend(expr) {
            if def_map.contains_key(tok.as_str()) && visited.insert(tok.clone()) {
                queue.push_back(tok);
            }
        }
    }

    while let Some(name) = queue.pop_front() {
        if let Some(def) = def_map.get(name.as_str()) {
            for tok in lock::tokenize_bend(&def.body) {
                if def_map.contains_key(tok.as_str()) && visited.insert(tok.clone()) {
                    queue.push_back(tok);
                }
            }
        }
    }

    visited.into_iter().collect()
}

/// Returns \`true\` if the induced call graph over \`cone\` contains any cycle (including self-recursion).
pub fn cone_is_recursive(cone: &[String], defs: &[Def]) -> bool {
    let cone_set: HashSet<&str> = cone.iter().map(String::as_str).collect();
    let mut edges: HashMap<&str, Vec<&str>> = HashMap::new();
    for def in defs {
        if !cone_set.contains(def.name.as_str()) {
            continue;
        }
        let mut callees = Vec::new();
        for tok in lock::tokenize_bend(&def.body) {
            if let Some(&target) = cone_set.get(tok.as_str()) {
                if !callees.contains(&target) {
                    callees.push(target);
                }
            }
        }
        edges.insert(def.name.as_str(), callees);
    }

    // 0 = unvisited, 1 = visiting, 2 = done
    let mut state: HashMap<&str, u8> = HashMap::new();
    fn dfs<'a>(
        node: &'a str,
        edges: &HashMap<&'a str, Vec<&'a str>>,
        state: &mut HashMap<&'a str, u8>,
    ) -> bool {
        state.insert(node, 1);
        if let Some(nexts) = edges.get(node) {
            for &next in nexts {
                match state.get(next).copied().unwrap_or(0) {
                    1 => return true,
                    0 if dfs(next, edges, state) => return true,
                    _ => {}
                }
            }
        }
        state.insert(node, 2);
        false
    }

    for &node in &cone_set {
        if state.get(node).copied().unwrap_or(0) == 0 && dfs(node, &edges, &mut state) {
            return true;
        }
    }
    false
}

/// Emits a \`#[cfg(test)] mod __rusty_bends_law_tests\` block checking every law against emitted Rust.
pub(crate) fn emit_law_tests_module(
    laws: &[ParsedLaw],
    types: &[TypeDef],
    defs: &[Def],
    type_env: &TypeEnv,
) -> String {
    if laws.is_empty() {
        return String::new();
    }

    let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
    let type_map: HashMap<String, &TypeDef> = types.iter().map(|t| (t.name.clone(), t)).collect();

    let mut out = String::new();
    out.push_str("#[cfg(test)]\\n");
    out.push_str("#[allow(clippy::all, non_snake_case, unused_variables, unused_parens, dead_code, unused_mut)]\\n");
    out.push_str("mod __rusty_bends_law_tests {\\n");
    out.push_str("    use super::*;\\n\\n");
    out.push_str(&emit_pool_runtime_helpers(
        types, &type_map, type_env, false,
    ));

    let mut used_fn_names: HashSet<String> = HashSet::new();
    for (idx, law) in laws.iter().enumerate() {
        let mut fn_name = format!("law_{}", sanitize_ident(&law.name));
        if !used_fn_names.insert(fn_name.clone()) {
            fn_name = format!("{fn_name}_{idx}");
            used_fn_names.insert(fn_name.clone());
        }
        out.push_str(&emit_single_law_test(
            &fn_name, law, types, defs, &def_map, &type_map, type_env,
        ));
        out.push('\\n');
    }

    out.push_str("}\\n");
    out
}

pub(crate) fn sanitize_ident(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() || out.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        out.insert(0, '_');
    }
    out
}

pub(crate) fn emit_pool_runtime_helpers(
    types: &[TypeDef],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    eval_mode: bool,
) -> String {
    let mut s = String::new();
    s.push_str(
        r#"    fn __rb_next_u64(state: &mut u64) -> u64 {
        *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn __rb_is_nat_overflow(payload: &(dyn std::any::Any + Send)) -> bool {
        let msg = if let Some(m) = payload.downcast_ref::<&str>() {
            *m
        } else if let Some(m) = payload.downcast_ref::<String>() {
            m.as_str()
        } else {
            return false;
        };
        msg.contains("rusty-bends: Nat overflow") || msg.contains("rusty-bends: step limit")
    }
"#,
    );
    if eval_mode {
        s.push_str(
            r#"
    fn __rb_pool_nat(rng: &mut u64, recursive: bool) -> Vec<u64> {
        let _ = rng;
        if recursive {
            (0_u64..=12).collect()
        } else {
            vec![0_u64, 1, 2, 3, 4, 5, 6, 7, 8, 16, 1000, u64::MAX - 1, u64::MAX]
        }
    }

    fn __rb_pool_u32(rng: &mut u64) -> Vec<u32> {
        let _ = rng;
        vec![0_u32, 1, 2, 3, 4, 7, 1000, u32::MAX - 1, u32::MAX]
    }

    fn __rb_pool_u64(rng: &mut u64) -> Vec<u64> {
        let _ = rng;
        vec![0_u64, 1, 2, 3, 4, 7, 1000, u64::MAX - 1, u64::MAX]
    }

    fn __rb_pool_i32(rng: &mut u64) -> Vec<i32> {
        let _ = rng;
        vec![0_i32, 1, -1, 2, -2, 3, i32::MIN, i32::MAX]
    }

    fn __rb_pool_i64(rng: &mut u64) -> Vec<i64> {
        let _ = rng;
        vec![0_i64, 1, -1, 2, -2, 3, i64::MIN, i64::MAX]
    }
"#,
        );
    } else {
        s.push_str(
            r#"
    fn __rb_pool_nat(rng: &mut u64, recursive: bool) -> Vec<u64> {
        if recursive {
            let mut v = vec![0_u64, 1, 2, 3, 4, 5, 7, 10, 16, 32];
            for _ in 0..4 {
                v.push(__rb_next_u64(rng) % 48);
            }
            v
        } else {
            let mut v = vec![0_u64, 1, 2, 3, 5, 7, 16, 1000, u64::MAX - 1, u64::MAX];
            for _ in 0..2 {
                v.push(__rb_next_u64(rng) % 10_000);
            }
            for _ in 0..2 {
                v.push(__rb_next_u64(rng));
            }
            v
        }
    }

    fn __rb_pool_u32(rng: &mut u64) -> Vec<u32> {
        let mut v = vec![0_u32, 1, 2, 7, 1000, u32::MAX - 1, u32::MAX];
        for _ in 0..4 {
            v.push(__rb_next_u64(rng) as u32);
        }
        v
    }

    fn __rb_pool_u64(rng: &mut u64) -> Vec<u64> {
        let mut v = vec![0_u64, 1, 2, 7, 1000, u64::MAX - 1, u64::MAX];
        for _ in 0..4 {
            v.push(__rb_next_u64(rng));
        }
        v
    }

    fn __rb_pool_i32(rng: &mut u64) -> Vec<i32> {
        let mut v = vec![0_i32, 1, -1, 2, -2, i32::MIN, i32::MAX];
        for _ in 0..4 {
            v.push(__rb_next_u64(rng) as i32);
        }
        v
    }

    fn __rb_pool_i64(rng: &mut u64) -> Vec<i64> {
        let mut v = vec![0_i64, 1, -1, 2, -2, i64::MIN, i64::MAX];
        for _ in 0..4 {
            v.push(__rb_next_u64(rng) as i64);
        }
        v
    }
"#,
        );
    }

    s.push_str(
        r#"
    fn __rb_combine2<A: Clone, B: Clone>(a: &[A], b: &[B], cap: usize) -> Vec<(A, B)> {
        let mut out = Vec::new();
        if a.is_empty() || b.is_empty() {
            return out;
        }
        if a.len().saturating_mul(b.len()) <= cap {
            for x in a {
                for y in b {
                    out.push((x.clone(), y.clone()));
                }
            }
            return out;
        }
        let s0 = a.len().min(4);
        let s1 = b.len().min(4);
        for x in &a[..s0] {
            for y in &b[..s1] {
                if out.len() >= cap {
                    break;
                }
                out.push((x.clone(), y.clone()));
            }
        }
        for x in a {
            if out.len() >= cap {
                break;
            }
            out.push((x.clone(), b[0].clone()));
        }
        for y in b {
            if out.len() >= cap {
                break;
            }
            out.push((a[0].clone(), y.clone()));
        }
        if out.len() < cap {
            out.push((a[a.len() - 1].clone(), b[b.len() - 1].clone()));
        }
        out
    }

"#,
    );

    if type_env.uses_builtin_list {
        s.push_str(
            r#"
    fn __rb_pool_list<T: Clone>(elems: &[T], depth: usize) -> Vec<List<T>> {
        let mut out = vec![List::Nil];
        if depth == 0 || elems.is_empty() {
            return out;
        }
        let sub = __rb_pool_list(elems, depth - 1);
        for e in &elems[..elems.len().min(4)] {
            out.push(List::Con(e.clone(), Box::new(List::Nil)));
        }
        for (i, e) in elems[..elems.len().min(4)].iter().enumerate() {
            if let Some(tail) = sub.get((i + 1) % sub.len()) {
                out.push(List::Con(e.clone(), Box::new(tail.clone())));
            }
            if sub.len() > 1 {
                out.push(List::Con(e.clone(), Box::new(sub[sub.len() - 1].clone())));
            }
        }
        out
    }

"#,
        );
    }

    let empty_params = HashSet::new();
    for td in types {
        s.push_str(&emit_adt_pool_fn(
            td,
            type_map,
            type_env,
            &empty_params,
            eval_mode,
        ));
        s.push('\\n');
    }
    s
}

fn wrap_ctor_pool_arg(arg_expr: String, is_boxed: bool) -> String {
    if is_boxed {
        format!("Box::new({arg_expr})")
    } else {
        arg_expr
    }
}

fn emit_adt_pool_fn(
    td: &TypeDef,
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    type_params: &HashSet<String>,
    eval_mode: bool,
) -> String {
    let mut s = format!(
        "    fn __rb_pool_adt_{}(rng: &mut u64, depth: usize, recursive: bool) -> Vec<{}> {{\\n",
        td.name, td.name
    );
    s.push_str("        let mut out = Vec::new();\\n");
    for v in &td.variants {
        let has_adt_field = v
            .field_types
            .iter()
            .any(|ft| type_references_adt(ft, type_map));
        let indent = if has_adt_field {
            s.push_str("        if depth > 0 {\\n");
            "            "
        } else {
            "        "
        };
        let next_depth = if has_adt_field { "depth - 1" } else { "depth" };
        let info_opt = type_env.ctor_map.get(&format!("{}.{}", td.name, v.name));
        let field_is_boxed = |fi: usize| -> bool {
            info_opt
                .and_then(|c| c.boxed_fields.get(fi).copied())
                .unwrap_or(false)
        };
        let supported_fields = v
            .field_types
            .iter()
            .all(|ft| can_generate_pool(ft, type_map, type_params));
        if !supported_fields {
            s.push_str(&format!(
                "{indent}// Skipped variant {}::{}: unsupported field type\\n",
                td.name, v.name
            ));
        } else if v.field_types.is_empty() {
            s.push_str(&format!("{indent}out.push({}::{});\\n", td.name, v.name));
        } else if v.field_types.len() == 1 {
            let expr = emit_pool_expr(
                &v.field_types[0],
                type_map,
                type_params,
                "recursive",
                next_depth,
            );
            let pushed = wrap_ctor_pool_arg("f0".to_string(), field_is_boxed(0));
            s.push_str(&format!("{indent}for f0 in {expr} {{\\n"));
            s.push_str(&format!(
                "{indent}    out.push({}::{}({pushed}));\\n",
                td.name, v.name
            ));
            s.push_str(&format!("{indent}}}\\n"));
        } else {
            for (fi, ft) in v.field_types.iter().enumerate() {
                let expr = emit_pool_expr(ft, type_map, type_params, "recursive", next_depth);
                s.push_str(&format!("{indent}let __f{fi} = {expr};\\n"));
            }
            let non_empty_guard = (0..v.field_types.len())
                .map(|fi| format!("!__f{fi}.is_empty()"))
                .collect::<Vec<_>>()
                .join(" && ");
            s.push_str(&format!("{indent}if {non_empty_guard} {{\\n"));
            let inner_indent = format!("{indent}    ");
            // Small combinations first so counterexamples stay minimal
            let small_cap = if v.field_types.len() == 2 { 4 } else { 2 };
            let mut loop_ind = inner_indent.clone();
            for fi in 0..v.field_types.len() {
                s.push_str(&format!(
                    "{loop_ind}for __s{fi} in &__f{fi}[..__f{fi}.len().min({small_cap})] {{\\n"
                ));
                loop_ind.push_str("    ");
            }
            let small_args = (0..v.field_types.len())
                .map(|fi| wrap_ctor_pool_arg(format!("__s{fi}.clone()"), field_is_boxed(fi)))
                .collect::<Vec<_>>()
                .join(", ");
            s.push_str(&format!(
                "{loop_ind}out.push({}::{}({small_args}));\\n",
                td.name, v.name
            ));
            for _ in 0..v.field_types.len() {
                loop_ind.truncate(loop_ind.len() - 4);
                s.push_str(&format!("{loop_ind}}}\\n"));
            }
            let max_expr = (0..v.field_types.len()).fold("0usize".to_string(), |acc, fi| {
                format!("{acc}.max(__f{fi}.len())")
            });
            s.push_str(&format!(
                "{inner_indent}let __limit = ({max_expr}).min(24);\\n"
            ));
            s.push_str(&format!("{inner_indent}for __i in 0..__limit {{\\n"));
            let args_sweep = (0..v.field_types.len())
                .map(|fi| {
                    wrap_ctor_pool_arg(
                        format!("__f{fi}[__i % __f{fi}.len()].clone()"),
                        field_is_boxed(fi),
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            s.push_str(&format!(
                "{inner_indent}    out.push({}::{}({args_sweep}));\\n",
                td.name, v.name
            ));
            s.push_str(&format!("{inner_indent}}}\\n"));
            let edge_args = (0..v.field_types.len())
                .map(|fi| {
                    wrap_ctor_pool_arg(
                        format!("__f{fi}[__f{fi}.len() - 1].clone()"),
                        field_is_boxed(fi),
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            s.push_str(&format!(
                "{inner_indent}out.push({}::{}({edge_args}));\\n",
                td.name, v.name
            ));
            if !eval_mode {
                s.push_str(&format!("{inner_indent}for _ in 0..4 {{\\n"));
                let args_rng = (0..v.field_types.len())
                    .map(|fi| {
                        wrap_ctor_pool_arg(
                            format!(
                                "__f{fi}[(__rb_next_u64(rng) as usize) % __f{fi}.len()].clone()"
                            ),
                            field_is_boxed(fi),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                s.push_str(&format!(
                    "{inner_indent}    out.push({}::{}({args_rng}));\\n",
                    td.name, v.name
                ));
                s.push_str(&format!("{inner_indent}}}\\n"));
            }
            s.push_str(&format!("{indent}}}\\n"));
        }
        if has_adt_field {
            s.push_str("        }\\n");
        }
    }
    s.push_str("        out\\n    }\\n");
    s
}

fn type_references_adt(ty: &str, type_map: &HashMap<String, &TypeDef>) -> bool {
    let t = ty.trim();
    if type_map.contains_key(t) {
        return true;
    }
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
        return parts.iter().any(|p| type_references_adt(p, type_map));
    }
    let amp = split_type_args(t, '&');
    if amp.len() > 1 {
        return amp.iter().any(|p| type_references_adt(p, type_map));
    }
    if let Some(elem) = parse_list_elem_type(t) {
        return type_references_adt(elem, type_map);
    }
    false
}

pub(crate) fn can_generate_pool(
    ty: &str,
    type_map: &HashMap<String, &TypeDef>,
    type_params: &HashSet<String>,
) -> bool {
    let t = ty.trim();
    if t.contains("->") {
        return false;
    }
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
        if parts.len() > 1 {
            return parts
                .iter()
                .all(|p| can_generate_pool(p, type_map, type_params));
        }
        return can_generate_pool(inner, type_map, type_params);
    }
    let amp = split_type_args(t, '&');
    if amp.len() > 1 {
        return amp
            .iter()
            .all(|p| can_generate_pool(p, type_map, type_params));
    }
    if let Some(elem) = parse_list_elem_type(t) {
        return can_generate_pool(elem, type_map, type_params);
    }
    matches!(
        t,
        "Nat" | "U32" | "U64" | "I32" | "I64" | "Bool" | "Unit" | "()"
    ) || type_params.contains(t)
        || type_map.contains_key(t)
}

pub(crate) fn emit_pool_expr(
    ty: &str,
    type_map: &HashMap<String, &TypeDef>,
    type_params: &HashSet<String>,
    recursive_expr: &str,
    depth_expr: &str,
) -> String {
    let t = ty.trim();
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
        if parts.len() > 1 {
            return emit_tuple_pool_expr(&parts, type_map, type_params, recursive_expr, depth_expr);
        }
        return emit_pool_expr(inner, type_map, type_params, recursive_expr, depth_expr);
    }
    let amp = split_type_args(t, '&');
    if amp.len() > 1 {
        return emit_tuple_pool_expr(&amp, type_map, type_params, recursive_expr, depth_expr);
    }
    if let Some(elem) = parse_list_elem_type(t) {
        let elem_pool = emit_pool_expr(elem, type_map, type_params, recursive_expr, depth_expr);
        return format!("__rb_pool_list(&{elem_pool}, {depth_expr})");
    }
    match t {
        "Nat" => format!("__rb_pool_nat(rng, {recursive_expr})"),
        "U32" => "__rb_pool_u32(rng)".to_string(),
        "U64" => "__rb_pool_u64(rng)".to_string(),
        "I32" => "__rb_pool_i32(rng)".to_string(),
        "I64" => "__rb_pool_i64(rng)".to_string(),
        "Bool" => "vec![false, true]".to_string(),
        "Unit" | "()" => "vec![()]".to_string(),
        _ if type_params.contains(t) => format!("__rb_pool_nat(rng, {recursive_expr})"),
        _ => format!("__rb_pool_adt_{t}(rng, {depth_expr}, {recursive_expr})"),
    }
}

fn emit_tuple_pool_expr(
    parts: &[&str],
    type_map: &HashMap<String, &TypeDef>,
    type_params: &HashSet<String>,
    recursive_expr: &str,
    depth_expr: &str,
) -> String {
    if parts.len() == 2 {
        let p0 = emit_pool_expr(parts[0], type_map, type_params, recursive_expr, depth_expr);
        let p1 = emit_pool_expr(parts[1], type_map, type_params, recursive_expr, depth_expr);
        return format!("__rb_combine2(&{p0}, &{p1}, 24)");
    }
    let mut s = String::from("{\\n");
    for (idx, part) in parts.iter().enumerate() {
        let p = emit_pool_expr(part, type_map, type_params, recursive_expr, depth_expr);
        s.push_str(&format!("            let __tp{idx} = {p};\\n"));
    }
    let non_empty = (0..parts.len())
        .map(|i| format!("!__tp{i}.is_empty()"))
        .collect::<Vec<_>>()
        .join(" && ");
    s.push_str("            let mut __tout = Vec::new();\\n");
    s.push_str(&format!("            if {non_empty} {{\\n"));
    let max_expr = (0..parts.len()).fold("0usize".to_string(), |acc, i| {
        format!("{acc}.max(__tp{i}.len())")
    });
    s.push_str(&format!(
        "                let __lim = ({max_expr}).min(24);\\n"
    ));
    s.push_str("                for __i in 0..__lim {\\n");
    let elem = (0..parts.len())
        .map(|i| format!("__tp{i}[__i % __tp{i}.len()].clone()"))
        .collect::<Vec<_>>()
        .join(", ");
    s.push_str(&format!("                    __tout.push(({elem}));\\n"));
    s.push_str("                }\\n");
    s.push_str("            }\\n");
    s.push_str("            __tout\\n        }");
    s
}

fn emit_single_law_test(
    fn_name: &str,
    law: &ParsedLaw,
    _types: &[TypeDef],
    defs: &[Def],
    def_map: &HashMap<String, &Def>,
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
) -> String {
    if let Some(reason) = &law.unsupported_reason {
        return format!("    // Skipped law {}: {reason}\\n", law.name);
    }

    let type_param_set: HashSet<String> = law
        .vars
        .iter()
        .filter(|v| v.is_type_param)
        .map(|v| v.name.clone())
        .collect();
    let runtime_vars: Vec<&LawVar> = law.vars.iter().filter(|v| !v.is_type_param).collect();

    for v in &runtime_vars {
        if !can_generate_pool(&v.ty, type_map, &type_param_set) {
            return format!(
                "    // Skipped law {}: unsupported variable type '{}'\\n",
                law.name, v.ty
            );
        }
    }

    let law_clone_vars: HashSet<String> = runtime_vars
        .iter()
        .filter(|v| type_contains_non_copy(&v.ty, &type_env.non_copy_types))
        .map(|v| v.name.clone())
        .collect();

    let default_mode = arith_mode_for_type(&law.eq_ty, ArithMode::NatChecked);
    let lhs_rs =
        match emit_expr_with_mode(&law.lhs, def_map, type_env, &law_clone_vars, default_mode) {
            Ok(s) => s,
            Err(e) => return format!("    // Skipped law {}: {e}\\n", law.name),
        };
    let rhs_rs =
        match emit_expr_with_mode(&law.rhs, def_map, type_env, &law_clone_vars, default_mode) {
            Ok(s) => s,
            Err(e) => return format!("    // Skipped law {}: {e}\\n", law.name),
        };

    let mut hyp_pairs = Vec::new();
    for h in &law.hypotheses {
        let h_mode = arith_mode_for_type(&h.ty, ArithMode::NatChecked);
        let hl = match emit_expr_with_mode(&h.lhs, def_map, type_env, &law_clone_vars, h_mode) {
            Ok(s) => s,
            Err(e) => return format!("    // Skipped law {}: {e}\\n", law.name),
        };
        let hr = match emit_expr_with_mode(&h.rhs, def_map, type_env, &law_clone_vars, h_mode) {
            Ok(s) => s,
            Err(e) => return format!("    // Skipped law {}: {e}\\n", law.name),
        };
        hyp_pairs.push((hl, hr));
    }

    let mut s = String::new();
    s.push_str("    #[test]\\n");
    s.push_str(&format!("    fn {fn_name}() {{\\n"));

    if runtime_vars.is_empty() {
        let eval_block = emit_eval_closure(&hyp_pairs, &lhs_rs, &rhs_rs);
        s.push_str(&format!("        let __res = {eval_block};\\n"));
        s.push_str("        match __res {\\n");
        s.push_str("            Err(__p) if __rb_is_nat_overflow(&*__p) => return,\\n");
        s.push_str("            Err(__p) => std::panic::resume_unwind(__p),\\n");
        s.push_str("            Ok(None) => return,\\n");
        s.push_str("            Ok(Some((__lhs, __rhs))) => {\\n");
        s.push_str(&format!(
            "                assert_eq!(__lhs, __rhs, \\"law {} failed on emitted Rust:\\\\n  lhs = {{:?}}\\\\n  rhs = {{:?}}\\", __lhs, __rhs);\\n",
            escape_rust_str(&law.name)
        ));
        s.push_str("            }\\n");
        s.push_str("        }\\n");
        s.push_str("    }\\n");
        return s;
    }

    let cone = law_dependency_cone(law, defs);
    let recursive = cone_is_recursive(&cone, defs);
    let seed = 0x517c_c1b7_2722_0a95_u64
        ^ u64::from_str_radix(&lock::fnv1a_hex(law.name.as_bytes()), 16).unwrap_or(0);
    s.push_str(&format!("        let mut __rng_val: u64 = {seed}_u64;\\n"));
    s.push_str("        let rng = &mut __rng_val;\\n");
    for (vi, v) in runtime_vars.iter().enumerate() {
        let pool_expr = emit_pool_expr(
            &v.ty,
            type_map,
            &type_param_set,
            if recursive { "true" } else { "false" },
            "2",
        );
        s.push_str(&format!("        let __p{vi} = {pool_expr};\\n"));
    }

    let var_names_fmt = runtime_vars
        .iter()
        .map(|v| format!("{} = {{:?}}", v.name))
        .collect::<Vec<_>>()
        .join(", ");
    let var_args_fmt = runtime_vars
        .iter()
        .map(|v| rust_ident(&v.name))
        .collect::<Vec<_>>()
        .join(", ");

    // Helper closure for evaluating one combination
    s.push_str("        let mut __checked: usize = 0;\\n");
    s.push_str("        let mut __run_case = |");
    for (vi, v) in runtime_vars.iter().enumerate() {
        if vi > 0 {
            s.push_str(", ");
        }
        let rty = bend_type_to_rust_with_u64_params(&v.ty, &type_param_set);
        s.push_str(&format!("__arg{vi}: &{rty}"));
    }
    s.push_str("| {\\n");
    for (vi, v) in runtime_vars.iter().enumerate() {
        s.push_str(&format!(
            "            let {} = __arg{vi}.clone();\\n",
            rust_ident(&v.name)
        ));
    }
    let eval_block = emit_eval_closure(&hyp_pairs, &lhs_rs, &rhs_rs);
    s.push_str(&format!("            match {eval_block} {{\\n"));
    s.push_str("                Err(__p) if __rb_is_nat_overflow(&*__p) => {}\\n");
    s.push_str("                Err(__p) => std::panic::resume_unwind(__p),\\n");
    s.push_str("                Ok(None) => {}\\n");
    s.push_str("                Ok(Some((__lhs, __rhs))) => {\\n");
    s.push_str("                    __checked += 1;\\n");
    s.push_str(&format!(
        "                    assert_eq!(__lhs, __rhs, \\"law {} failed on emitted Rust for {var_names_fmt}:\\\\n  lhs = {{:?}}\\\\n  rhs = {{:?}}\\", {var_args_fmt}, __lhs, __rhs);\\n",
        escape_rust_str(&law.name)
    ));
    s.push_str("                }\\n");
    s.push_str("            }\\n");
    s.push_str("        };\\n");

    let lens_prod = runtime_vars
        .iter()
        .enumerate()
        .map(|(vi, _)| format!("__p{vi}.len()"))
        .fold("1usize".to_string(), |acc, x| {
            format!("{acc}.saturating_mul({x})")
        });
    s.push_str(&format!("        let __total = {lens_prod};\\n"));
    s.push_str("        if __total <= 4096 {\\n");
    let mut indent = "            ".to_string();
    for vi in 0..runtime_vars.len() {
        s.push_str(&format!("{indent}for __v{vi} in &__p{vi} {{\\n"));
        indent.push_str("    ");
    }
    let tuple_call = (0..runtime_vars.len())
        .map(|vi| format!("__v{vi}"))
        .collect::<Vec<_>>()
        .join(", ");
    s.push_str(&format!("{indent}__run_case({tuple_call});\\n"));
    for _ in 0..runtime_vars.len() {
        indent.truncate(indent.len() - 4);
        s.push_str(&format!("{indent}}}\\n"));
    }
    s.push_str("        } else {\\n");
    for vi in 0..runtime_vars.len() {
        s.push_str(&format!(
            "            for (__idx, __val) in __p{vi}.iter().enumerate() {{\\n"
        ));
        let args_zero = (0..runtime_vars.len())
            .map(|k| {
                if k == vi {
                    "__val".to_string()
                } else {
                    format!("&__p{k}[0]")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        s.push_str(&format!("                __run_case({args_zero});\\n"));
        let args_diag = (0..runtime_vars.len())
            .map(|k| {
                if k == vi {
                    "__val".to_string()
                } else {
                    format!("&__p{k}[(__idx + {k}) % __p{k}.len()]")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        s.push_str(&format!("                __run_case({args_diag});\\n"));
        s.push_str("            }\\n");
    }
    s.push_str("            for _ in 0..1024 {\\n");
    let args_sample = (0..runtime_vars.len())
        .map(|k| format!("&__p{k}[(__rb_next_u64(rng) as usize) % __p{k}.len()]"))
        .collect::<Vec<_>>()
        .join(", ");
    s.push_str(&format!("                __run_case({args_sample});\\n"));
    s.push_str("            }\\n");
    s.push_str("        }\\n");

    if law.hypotheses.is_empty() {
        s.push_str(&format!(
            "        assert!(__checked > 0, \\"law {} had 0 non-overflowing test cases\\");\\n",
            escape_rust_str(&law.name)
        ));
    }
    s.push_str("    }\\n");
    s
}

fn bend_type_to_rust_with_u64_params(ty: &str, type_params: &HashSet<String>) -> String {
    let t = ty.trim();
    if type_params.contains(t) {
        return "u64".to_string();
    }
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
        if parts.len() > 1 {
            let mapped = parts
                .into_iter()
                .map(|p| bend_type_to_rust_with_u64_params(p, type_params))
                .collect::<Vec<_>>()
                .join(", ");
            return format!("({mapped})");
        }
        return bend_type_to_rust_with_u64_params(inner, type_params);
    }
    let amp = split_type_args(t, '&');
    if amp.len() > 1 {
        let mapped = amp
            .into_iter()
            .map(|p| bend_type_to_rust_with_u64_params(p, type_params))
            .collect::<Vec<_>>()
            .join(", ");
        return format!("({mapped})");
    }
    if let Some(elem) = parse_list_elem_type(t) {
        return format!(
            "List<{}>",
            bend_type_to_rust_with_u64_params(elem, type_params)
        );
    }
    bend_type_to_rust(t, type_params)
}

fn emit_eval_closure(hyp_pairs: &[(String, String)], lhs_rs: &str, rhs_rs: &str) -> String {
    let mut hyp_checks = String::new();
    for (hl, hr) in hyp_pairs {
        hyp_checks.push_str(&format!("if ({hl}) != ({hr}) {{ return None; }} "));
    }
    format!(
        "std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {{ {hyp_checks}Some(({lhs_rs}, {rhs_rs})) }}))"
    )
}

fn escape_rust_str(s: &str) -> String {
    s.replace('\\\\', "\\\\\\\\").replace('"', "\\\\\\"")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Counterexample {
    pub law_name: String,
    pub bindings: Vec<(String, String)>,
    pub lhs_display: String,
    pub rhs_display: String,
    pub lhs_val: String,
    pub rhs_val: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LawEvalOutcome {
    Counterexample(Counterexample),
    NoCounterexample {
        law_name: String,
        checked: usize,
        bounds: String,
    },
    Skipped {
        law_name: String,
        reason: String,
    },
}

pub(crate) struct TempEvalDir(pub(crate) PathBuf);

impl Drop for TempEvalDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn create_temp_eval_dir(base_dir: &Path, tag: &str) -> Result<TempEvalDir, String> {
    fs::create_dir_all(base_dir).map_err(|e| e.to_string())?;
    let n = EVAL_SEQ.fetch_add(1, Ordering::SeqCst);
    let path = base_dir.join(format!(".rb_{tag}_{}_{n}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(TempEvalDir(path))
}

/// Extracts the failing definition/law name from Bend CLI error output (\`Location: <name>\`).
pub fn extract_failed_def_name(bend_err: &str) -> Option<String> {
    for line in bend_err.lines() {
        let trimmed = line.trim();
        if let Some(after) = trimmed.strip_prefix("Location:") {
            let rest = after.trim();
            if !rest.is_empty() {
                if let Some(tok) = rest.split_whitespace().next() {
                    let clean = tok.rsplit(':').next().unwrap_or(tok);
                    if !clean.is_empty() {
                        return Some(clean.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Evaluates \`target_law_names\` (or all laws in \`combined_source\` if empty) on concrete inputs
/// using the emitted Rust (compiled with \`rustc\` under a 10,000-step recursion guard).
pub fn evaluate_laws_for_counterexamples(
    combined_source: &str,
    target_law_names: &[String],
    out_dir: &Path,
) -> Result<Vec<LawEvalOutcome>, String> {
    let (types, defs) = parse_book_items(combined_source)?;
    let all_laws = parse_laws(combined_source);
    let extra_sources = collect_law_source_slices(&all_laws);
    let type_env = TypeEnv::build(&types, &defs, &extra_sources);

    let targets: Vec<&ParsedLaw> = if target_law_names.is_empty() {
        all_laws.iter().collect()
    } else {
        all_laws
            .iter()
            .filter(|l| target_law_names.iter().any(|t| t == &l.name))
            .collect()
    };

    if targets.is_empty() {
        return Ok(Vec::new());
    }

    let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
    let type_map: HashMap<String, &TypeDef> = types.iter().map(|t| (t.name.clone(), t)).collect();

    let runtime = emit_items_to_rust(&types, &defs, &type_env, 0, Some(10_000), true)?;
    let mut outcomes: Vec<LawEvalOutcome> = Vec::new();
    let mut runnable: Vec<(&ParsedLaw, String)> = Vec::new();
    let mut law_by_name: HashMap<String, &ParsedLaw> = HashMap::new();

    for law in targets {
        law_by_name.insert(law.name.clone(), law);
        match emit_eval_law_checker(
            &format!("__rb_eval_law_{}", sanitize_ident(&law.name)),
            law,
            &defs,
            &def_map,
            &type_map,
            &type_env,
            false,
        ) {
            Ok(code) => runnable.push((law, code)),
            Err(reason) => outcomes.push(LawEvalOutcome::Skipped {
                law_name: law.name.clone(),
                reason,
            }),
        }
    }

    if runnable.is_empty() {
        return Ok(outcomes);
    }

    let mut program = String::new();
    program.push_str("#![allow(clippy::all, non_snake_case, unused_variables, unused_parens, dead_code, unused_mut)]\\n");
    program.push_str(&runtime.rust_source);
    program.push('\\n');
    program.push_str(&emit_pool_runtime_helpers(
        &types, &type_map, &type_env, true,
    ));
    for (_, code) in &runnable {
        program.push_str(code);
        program.push('\\n');
    }
    program.push_str("fn main() {\\n");
    for (law, _) in &runnable {
        let fn_name = format!("__rb_eval_law_{}", sanitize_ident(&law.name));
        program.push_str(&format!("    {fn_name}();\\n"));
    }
    program.push_str("}\\n");

    let eval_dir = create_temp_eval_dir(out_dir, "eval")?;
    let rs_path = eval_dir.0.join("eval.rs");
    let bin_path = eval_dir.0.join("eval_bin");
    fs::write(&rs_path, program).map_err(|e| e.to_string())?;

    let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
    let compile = Command::new(&rustc)
        .args(["--edition", "2021", "-A", "warnings", "-o"])
        .arg(&bin_path)
        .arg(&rs_path)
        .output()
        .map_err(|e| format!("failed to invoke '{rustc}' for counterexample search: {e}"))?;
    if !compile.status.success() {
        return Err(format!(
            "rustc failed compiling counterexample harness:\\n{}",
            String::from_utf8_lossy(&compile.stderr)
        ));
    }

    let run = Command::new(&bin_path)
        .output()
        .map_err(|e| format!("failed to run counterexample binary: {e}"))?;
    if !run.status.success() {
        return Err(format!(
            "counterexample binary exited with failure:\\n{}{}",
            String::from_utf8_lossy(&run.stdout),
            String::from_utf8_lossy(&run.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&run.stdout);
    let mut parsed = parse_eval_protocol(&stdout, &law_by_name);
    outcomes.append(&mut parsed);
    Ok(outcomes)
}

/// Emits a standalone Rust function that evaluates \`law\` across small and edge inputs and prints
/// either \`CE_BEGIN ... CE_END\` (or \`CAUGHT\` in mutation mode) or \`NONE\\t...\`.
pub(crate) fn emit_eval_law_checker(
    fn_name: &str,
    law: &ParsedLaw,
    defs: &[Def],
    def_map: &HashMap<String, &Def>,
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    compact_mutant_mode: bool,
) -> Result<String, String> {
    if let Some(reason) = &law.unsupported_reason {
        return Err(reason.clone());
    }

    let type_param_set: HashSet<String> = law
        .vars
        .iter()
        .filter(|v| v.is_type_param)
        .map(|v| v.name.clone())
        .collect();
    let runtime_vars: Vec<&LawVar> = law.vars.iter().filter(|v| !v.is_type_param).collect();

    for v in &runtime_vars {
        if !can_generate_pool(&v.ty, type_map, &type_param_set) {
            return Err(format!("unsupported variable type '{}'", v.ty));
        }
    }

    let law_clone_vars: HashSet<String> = runtime_vars
        .iter()
        .filter(|v| type_contains_non_copy(&v.ty, &type_env.non_copy_types))
        .map(|v| v.name.clone())
        .collect();

    let default_mode = arith_mode_for_type(&law.eq_ty, ArithMode::NatChecked);
    let lhs_rs = emit_expr_with_mode(&law.lhs, def_map, type_env, &law_clone_vars, default_mode)?;
    let rhs_rs = emit_expr_with_mode(&law.rhs, def_map, type_env, &law_clone_vars, default_mode)?;

    let mut hyp_pairs = Vec::new();
    for h in &law.hypotheses {
        let h_mode = arith_mode_for_type(&h.ty, ArithMode::NatChecked);
        let hl = emit_expr_with_mode(&h.lhs, def_map, type_env, &law_clone_vars, h_mode)?;
        let hr = emit_expr_with_mode(&h.rhs, def_map, type_env, &law_clone_vars, h_mode)?;
        hyp_pairs.push((hl, hr));
    }

    let cone = law_dependency_cone(law, defs);
    let recursive = cone_is_recursive(&cone, defs);
    let bounds_desc = if runtime_vars.is_empty() {
        "ground term".to_string()
    } else if recursive {
        "Nat in 0..=12, Bool in {false, true}, ADT depth <= 2".to_string()
    } else {
        "Nat in [0..=8, 16, 1000, u64::MAX-1, u64::MAX], Bool in {false, true}, ADT depth <= 2"
            .to_string()
    };

    let mut hyp_checks = String::new();
    for (hl, hr) in &hyp_pairs {
        hyp_checks.push_str(&format!("if ({hl}) != ({hr}) {{ return None; }} "));
    }
    let eval_expr = format!(
        "std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {{ __rb_reset_steps(); {hyp_checks}Some(({lhs_rs}, {rhs_rs})) }}))"
    );

    let mut s = String::new();
    let vis = if compact_mutant_mode { "pub " } else { "" };
    let ret_sig = if compact_mutant_mode {
        " -> Option<String>"
    } else {
        ""
    };
    s.push_str(&format!("{vis}fn {fn_name}(){ret_sig} {{\\n"));

    if runtime_vars.is_empty() {
        s.push_str(&format!("    match {eval_expr} {{\\n"));
        s.push_str("        Ok(Some((__lhs, __rhs))) if __lhs != __rhs => {\\n");
        if compact_mutant_mode {
            s.push_str("            return Some(format!(\\"lhs={:?}, rhs={:?}\\", __lhs, __rhs));\\n");
        } else {
            s.push_str("            println!(\\"CE_BEGIN\\");\\n");
            s.push_str(&format!(
                "            println!(\\"LAW {{}}\\", \\"{}\\");\\n",
                escape_rust_str(&law.name)
            ));
            s.push_str("            println!(\\"LHS {:?}\\", __lhs);\\n");
            s.push_str("            println!(\\"RHS {:?}\\", __rhs);\\n");
            s.push_str("            println!(\\"CE_END\\");\\n");
        }
        s.push_str("        }\\n");
        s.push_str("        Ok(Some(_)) => {\\n");
        if compact_mutant_mode {
            s.push_str("            return None;\\n");
        } else {
            s.push_str(&format!(
                "            println!(\\"NONE\\\\t{{}}\\\\t1\\\\t{{}}\\", \\"{}\\", \\"{}\\");\\n",
                escape_rust_str(&law.name),
                escape_rust_str(&bounds_desc)
            ));
        }
        s.push_str("        }\\n");
        s.push_str("        _ => {\\n");
        if compact_mutant_mode {
            s.push_str("            return None;\\n");
        } else {
            s.push_str(&format!(
                "            println!(\\"NONE\\\\t{{}}\\\\t0\\\\t{{}}\\", \\"{}\\", \\"{}\\");\\n",
                escape_rust_str(&law.name),
                escape_rust_str(&bounds_desc)
            ));
        }
        s.push_str("        }\\n");
        s.push_str("    }\\n");
        s.push_str("}\\n");
        return Ok(s);
    }

    let seed = 0x517c_c1b7_2722_0a95_u64
        ^ u64::from_str_radix(&lock::fnv1a_hex(law.name.as_bytes()), 16).unwrap_or(0);
    s.push_str(&format!("    let mut __rng_val: u64 = {seed}_u64;\\n"));
    s.push_str("    let rng = &mut __rng_val;\\n");
    for (vi, v) in runtime_vars.iter().enumerate() {
        let pool_expr = emit_pool_expr(
            &v.ty,
            type_map,
            &type_param_set,
            if recursive { "true" } else { "false" },
            "2",
        );
        s.push_str(&format!("    let __p{vi} = {pool_expr};\\n"));
    }
    s.push_str("    let mut __checked: usize = 0;\\n");
    s.push_str("    let mut __found_ce = false;\\n");
    s.push_str("    let mut __ce_summary: Option<String> = None;\\n");
    s.push_str("    let __try_case = |__checked: &mut usize, __ce_out: &mut Option<String>");
    for (vi, v) in runtime_vars.iter().enumerate() {
        let rty = bend_type_to_rust_with_u64_params(&v.ty, &type_param_set);
        s.push_str(&format!(", __arg{vi}: &{rty}"));
    }
    s.push_str("| -> bool {\\n");
    for (vi, v) in runtime_vars.iter().enumerate() {
        s.push_str(&format!(
            "        let {} = __arg{vi}.clone();\\n",
            rust_ident(&v.name)
        ));
    }
    s.push_str(&format!("        match {eval_expr} {{\\n"));
    s.push_str("            Err(__p) if __rb_is_nat_overflow(&*__p) => false,\\n");
    s.push_str("            Err(__p) => std::panic::resume_unwind(__p),\\n");
    s.push_str("            Ok(None) => false,\\n");
    s.push_str("            Ok(Some((__lhs, __rhs))) => {\\n");
    s.push_str("                *__checked += 1;\\n");
    s.push_str("                if __lhs != __rhs {\\n");
    if compact_mutant_mode {
        let bind_fmt = runtime_vars
            .iter()
            .map(|v| format!("{}={{:?}}", v.name))
            .collect::<Vec<_>>()
            .join(", ");
        let bind_args = runtime_vars
            .iter()
            .map(|v| rust_ident(&v.name))
            .collect::<Vec<_>>()
            .join(", ");
        s.push_str(&format!(
            "                    *__ce_out = Some(format!(\\"{bind_fmt}: lhs={{:?}}, rhs={{:?}}\\", {bind_args}, __lhs, __rhs));\\n"
        ));
    } else {
        s.push_str("                    let _ = __ce_out;\\n");
        s.push_str("                    println!(\\"CE_BEGIN\\");\\n");
        s.push_str(&format!(
            "                    println!(\\"LAW {{}}\\", \\"{}\\");\\n",
            escape_rust_str(&law.name)
        ));
        for v in &runtime_vars {
            s.push_str(&format!(
                "                    println!(\\"BIND {}={{:?}}\\", {});\\n",
                escape_rust_str(&v.name),
                rust_ident(&v.name)
            ));
        }
        s.push_str("                    println!(\\"LHS {:?}\\", __lhs);\\n");
        s.push_str("                    println!(\\"RHS {:?}\\", __rhs);\\n");
        s.push_str("                    println!(\\"CE_END\\");\\n");
    }
    s.push_str("                    true\\n");
    s.push_str("                } else {\\n");
    s.push_str("                    false\\n");
    s.push_str("                }\\n");
    s.push_str("            }\\n");
    s.push_str("        }\\n");
    s.push_str("    };\\n");

    // Phase 1: small combinations first so minimal counterexamples (e.g. a=3, f=0, rel=4) appear first.
    let small_cap = if runtime_vars.len() <= 3 {
        6
    } else if runtime_vars.len() == 4 {
        4
    } else {
        2
    };
    let mut indent = "    ".to_string();
    for vi in 0..runtime_vars.len() {
        s.push_str(&format!(
            "{indent}for __v{vi} in &__p{vi}[..__p{vi}.len().min({small_cap})] {{\\n"
        ));
        indent.push_str("    ");
    }
    let small_call = (0..runtime_vars.len())
        .map(|vi| format!("__v{vi}"))
        .collect::<Vec<_>>()
        .join(", ");
    s.push_str(&format!(
        "{indent}if __try_case(&mut __checked, &mut __ce_summary, {small_call}) {{ __found_ce = true; break; }}\\n"
    ));
    for vi in (0..runtime_vars.len()).rev() {
        indent.truncate(indent.len() - 4);
        s.push_str(&format!("{indent}}}\\n"));
        if vi > 0 {
            s.push_str(&format!("{indent}if __found_ce {{ break; }}\\n"));
        }
    }

    // Phase 2: full Cartesian product (up to 8192) or sweeps + seeded PRNG samples
    let lens_prod = runtime_vars
        .iter()
        .enumerate()
        .map(|(vi, _)| format!("__p{vi}.len()"))
        .fold("1usize".to_string(), |acc, x| {
            format!("{acc}.saturating_mul({x})")
        });
    s.push_str("    if !__found_ce {\\n");
    s.push_str(&format!("        let __total = {lens_prod};\\n"));
    s.push_str("        if __total <= 8192 {\\n");
    let mut ind2 = "            ".to_string();
    for vi in 0..runtime_vars.len() {
        s.push_str(&format!("{ind2}for __v{vi} in &__p{vi} {{\\n"));
        ind2.push_str("    ");
    }
    let full_call = (0..runtime_vars.len())
        .map(|vi| format!("__v{vi}"))
        .collect::<Vec<_>>()
        .join(", ");
    s.push_str(&format!(
        "{ind2}if __try_case(&mut __checked, &mut __ce_summary, {full_call}) {{ __found_ce = true; break; }}\\n"
    ));
    for vi in (0..runtime_vars.len()).rev() {
        ind2.truncate(ind2.len() - 4);
        s.push_str(&format!("{ind2}}}\\n"));
        if vi > 0 {
            s.push_str(&format!("{ind2}if __found_ce {{ break; }}\\n"));
        }
    }
    s.push_str("        } else {\\n");
    for vi in 0..runtime_vars.len() {
        s.push_str("            if !__found_ce {\\n");
        s.push_str(&format!(
            "                for (__idx, __val) in __p{vi}.iter().enumerate() {{\\n"
        ));
        let args_zero = (0..runtime_vars.len())
            .map(|k| {
                if k == vi {
                    "__val".to_string()
                } else {
                    format!("&__p{k}[0]")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        s.push_str(&format!(
            "                    if __try_case(&mut __checked, &mut __ce_summary, {args_zero}) {{ __found_ce = true; break; }}\\n"
        ));
        let args_diag = (0..runtime_vars.len())
            .map(|k| {
                if k == vi {
                    "__val".to_string()
                } else {
                    format!("&__p{k}[(__idx + {k}) % __p{k}.len()]")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        s.push_str(&format!(
            "                    if __try_case(&mut __checked, &mut __ce_summary, {args_diag}) {{ __found_ce = true; break; }}\\n"
        ));
        s.push_str("                }\\n");
        s.push_str("            }\\n");
    }
    s.push_str("            if !__found_ce {\\n");
    s.push_str("                for _ in 0..2048 {\\n");
    let args_sample = (0..runtime_vars.len())
        .map(|k| format!("&__p{k}[(__rb_next_u64(rng) as usize) % __p{k}.len()]"))
        .collect::<Vec<_>>()
        .join(", ");
    s.push_str(&format!(
        "                    if __try_case(&mut __checked, &mut __ce_summary, {args_sample}) {{ __found_ce = true; break; }}\\n"
    ));
    s.push_str("                }\\n");
    s.push_str("            }\\n");
    s.push_str("        }\\n");
    s.push_str("    }\\n");

    if compact_mutant_mode {
        s.push_str("    __ce_summary\\n");
    } else {
        s.push_str("    if !__found_ce {\\n");
        s.push_str(&format!(
            "        println!(\\"NONE\\\\t{{}}\\\\t{{}}\\\\t{{}}\\", \\"{}\\", __checked, \\"{}\\");\\n",
            escape_rust_str(&law.name),
            escape_rust_str(&bounds_desc)
        ));
        s.push_str("    }\\n");
    }
    s.push_str("}\\n");
    Ok(s)
}

fn parse_eval_protocol(
    stdout: &str,
    law_by_name: &HashMap<String, &ParsedLaw>,
) -> Vec<LawEvalOutcome> {
    let mut outcomes = Vec::new();
    let mut in_ce = false;
    let mut cur_law = String::new();
    let mut cur_binds: Vec<(String, String)> = Vec::new();
    let mut cur_lhs = String::new();
    let mut cur_rhs = String::new();

    for line in stdout.lines() {
        if line == "CE_BEGIN" {
            in_ce = true;
            cur_law.clear();
            cur_binds.clear();
            cur_lhs.clear();
            cur_rhs.clear();
            continue;
        }
        if line == "CE_END" && in_ce {
            in_ce = false;
            let (lhs_raw, rhs_raw) = law_by_name
                .get(&cur_law)
                .map(|l| (l.lhs.as_str(), l.rhs.as_str()))
                .unwrap_or(("", ""));
            outcomes.push(LawEvalOutcome::Counterexample(Counterexample {
                law_name: cur_law.clone(),
                bindings: cur_binds.clone(),
                lhs_display: substitute_bindings(lhs_raw, &cur_binds),
                rhs_display: substitute_bindings(rhs_raw, &cur_binds),
                lhs_val: cur_lhs.clone(),
                rhs_val: cur_rhs.clone(),
            }));
            continue;
        }
        if in_ce {
            if let Some(name) = line.strip_prefix("LAW ") {
                cur_law = name.trim().to_string();
            } else if let Some(bind) = line.strip_prefix("BIND ") {
                if let Some((k, v)) = bind.split_once('=') {
                    cur_binds.push((k.trim().to_string(), v.trim().to_string()));
                }
            } else if let Some(val) = line.strip_prefix("LHS ") {
                cur_lhs = val.trim().to_string();
            } else if let Some(val) = line.strip_prefix("RHS ") {
                cur_rhs = val.trim().to_string();
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("NONE\\t") {
            let parts: Vec<&str> = rest.splitn(3, '\\t').collect();
            if parts.len() == 3 {
                outcomes.push(LawEvalOutcome::NoCounterexample {
                    law_name: parts[0].to_string(),
                    checked: parts[1].parse().unwrap_or(0),
                    bounds: parts[2].to_string(),
                });
            }
        }
    }
    outcomes
}

fn substitute_bindings(expr: &str, bindings: &[(String, String)]) -> String {
    let bind_map: HashMap<&str, &str> = bindings
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let chars: Vec<char> = expr.chars().collect();
    let mut out = String::with_capacity(expr.len());
    let mut i = 0usize;

    while i < chars.len() {
        if chars[i].is_ascii_alphabetic() || chars[i] == '_' {
            let prev_is_dot_or_ident = i > 0
                && (chars[i - 1] == '.'
                    || chars[i - 1].is_ascii_alphanumeric()
                    || chars[i - 1] == '_');
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let ident: String = chars[start..i].iter().collect();
            let next_is_dot = i < chars.len() && chars[i] == '.';
            if !prev_is_dot_or_ident && !next_is_dot {
                if let Some(val) = bind_map.get(ident.as_str()) {
                    out.push_str(val);
                    continue;
                }
            }
            out.push_str(&ident);
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }

    out
}

/// Formats counterexample or proof-only failure diagnostics for display before the Bend error.
pub fn format_counterexample_diagnosis(
    outcomes: &[LawEvalOutcome],
    locked_laws: &BTreeSet<String>,
) -> String {
    let counterexamples: Vec<&Counterexample> = outcomes
        .iter()
        .filter_map(|o| match o {
            LawEvalOutcome::Counterexample(ce) => Some(ce),
            _ => None,
        })
        .collect();

    if !counterexamples.is_empty() {
        return counterexamples
            .iter()
            .map(|ce| {
                let binds = if ce.bindings.is_empty() {
                    "(ground expression)".to_string()
                } else {
                    ce.bindings
                        .iter()
                        .map(|(k, v)| format!("{k} = {v}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                let width = ce.lhs_display.len().max(ce.rhs_display.len());
                let hint = if locked_laws.contains(&ce.law_name) {
                    "fix the function (or, if the change is meant to break this law, stop: the law is locked)"
                } else {
                    "fix the function (or revise the unlocked law if the specification changed)"
                };
                format!(
                    "[E_LAW_FALSE] law {} is FALSE for this code (evaluated with emitted Rust):\\n  {binds}\\n  lhs {:<width$} = {}\\n  rhs {:<width$} = {}\\n{hint}",
                    ce.law_name, ce.lhs_display, ce.lhs_val, ce.rhs_display, ce.rhs_val
                )
            })
            .collect::<Vec<_>>()
            .join("\\n\\n");
    }

    outcomes
        .iter()
        .filter_map(|o| match o {
            LawEvalOutcome::NoCounterexample {
                law_name,
                checked,
                bounds,
            } => Some(format!(
                "law {law_name}: no counterexample up to {bounds} ({checked} cases checked, evaluated with emitted Rust): the law may be true; the proof is what failed"
            )),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::emit::emit_verified_rust;
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn tmp_dir(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = env::temp_dir().join(format!("rb_law_test_{tag}_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_bend2_and_legacy_laws_with_hypotheses_and_deps() {
        let src = r#"
import Base

def helper(x: Nat) -> Nat:
  Nat.add(x, 1n)

def top(x: Nat) -> Nat:
  helper(x)

law simple_law:
  for x: Nat
  for h: {x == x : Nat}
  {top(x) == Nat.add(x, 1n) : Nat}

law legacy_law(for +a: Nat, for +b: Bool):
  a == a
"#;
        let laws = parse_laws(src);
        assert_eq!(laws.len(), 2);
        assert_eq!(laws[0].name, "simple_law");
        assert_eq!(laws[0].vars.len(), 1);
        assert_eq!(laws[0].hypotheses.len(), 1);
        assert_eq!(laws[0].eq_ty, "Nat");
        assert!(laws[0].unsupported_reason.is_none());

        let (_, defs) = crate::emit::parse_book_items(src).unwrap();
        let cone = law_dependency_cone(&laws[0], &defs);
        assert_eq!(cone, vec!["helper".to_string(), "top".to_string()]);
        assert!(!cone_is_recursive(&cone, &defs));
    }

    #[test]
    fn issue5_reproducer_checked_nat_passes_generated_test_and_catches_buggy_code() {
        // Exact reproducer from issue #5, completed with its Bend 2 proof.
        let bend_src = r#"import Base

type Ledger is Data:
  Ledger{a: Nat, f: Nat}

def ledger_release_if(+a: Nat, +f: Nat, +rel: Nat, ok: Bool) -> Ledger:
  match ok:
    case True{}:
      Ledger{Nat.sub(a, rel), Nat.add(f, rel)}
    case False{}:
      Ledger{a, f}

def ledger_release(+p: Ledger, +rel: Nat) -> Ledger:
  match p:
    case Ledger{+a, f}:
      ledger_release_if(a, f, rel, Nat.is_le(rel, a))

def add_le_false_lt(+a: Nat, +k: Nat) -> {False{} == Nat.is_le(Nat.add(a, 1n+k), a) : Bool}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %add_le_false_lt(ap, k) : {False{} == _ : Bool}
      {==}

law over_release_is_noop:
  for +a: Nat
  for +f: Nat
  for +extra: Nat
  {ledger_release(Ledger{a, f}, Nat.add(a, 1n+extra)) == Ledger{a, f} : Ledger}

def over_release_is_noop(a, f, extra):
  %add_le_false_lt(a, extra) : {ledger_release_if(a, f, Nat.add(a, 1n+extra), _) == Ledger{a, f} : Ledger}
  {==}
"#;
        let dir = tmp_dir("issue5");
        let bend_file = dir.join("ledger.bend");
        fs::write(&bend_file, bend_src).unwrap();

        let bend_bin = crate::resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        if let Ok(out) = Command::new(&bend_bin)
            .arg(&bend_file)
            .arg("--check-only")
            .output()
        {
            assert!(
                out.status.success(),
                "bend --check-only failed: {}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        }

        let summary = emit_verified_rust(bend_src, 1).expect("emit ledger reproducer");
        assert!(summary
            .rust_source
            .contains("fn law_over_release_is_noop()"));

        // 1. Checked Nat arithmetic passes the generated test AND explicitly refuses u64::MAX overflow.
        let overflow_check = format!(
            "{}\\n#[cfg(test)]\\n#[test]\\nfn overflow_panics_instead_of_saturating() {{\\n    let res = std::panic::catch_unwind(|| ledger_release(Ledger::Ledger(u64::MAX, 7), u64::MAX));\\n    let _ = res;\\n    let add_overflow = std::panic::catch_unwind(|| {{\\n        let a = u64::MAX;\\n        let rel = (a).checked_add((1_u64).checked_add(0).expect(\\"rusty-bends: Nat overflow\\")).expect(\\"rusty-bends: Nat overflow\\");\\n        ledger_release(Ledger::Ledger(a, 7), rel)\\n    }});\\n    assert!(add_overflow.is_err(), \\"overflow in Nat.add must panic instead of saturating\\");\\n}}\\n",
            summary.rust_source
        );
        let rs_ok = dir.join("ledger_ok.rs");
        let bin_ok = dir.join("ledger_ok_bin");
        fs::write(&rs_ok, overflow_check).unwrap();
        let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = Command::new(&rustc)
            .args(["--edition", "2021", "--test", "-o"])
            .arg(&bin_ok)
            .arg(&rs_ok)
            .output()
            .expect("rustc must run");
        assert!(
            compile.status.success(),
            "rustc --test failed: {}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run_ok = Command::new(&bin_ok).output().expect("run test binary");
        assert!(
            run_ok.status.success(),
            "generated law test should pass:\\n{}{}",
            String::from_utf8_lossy(&run_ok.stdout),
            String::from_utf8_lossy(&run_ok.stderr)
        );

        // 2. If the emitted Rust had saturating_add instead of checked_add, law_over_release_is_noop MUST fail at u64::MAX!
        let buggy_sat = summary
            .rust_source
            .replace(
                ".checked_add((1_u64).checked_add(extra).expect(\\"rusty-bends: Nat overflow\\")).expect(\\"rusty-bends: Nat overflow\\")",
                ".saturating_add((1_u64).saturating_add(extra))",
            )
            .replace(
                ".checked_add(extra).expect(\\"rusty-bends: Nat overflow\\")",
                ".saturating_add(extra)",
            )
            .replace(
                ".checked_add(rel).expect(\\"rusty-bends: Nat overflow\\")",
                ".saturating_add(rel)",
            );
        let rs_bug = dir.join("ledger_bug.rs");
        let bin_bug = dir.join("ledger_bug_bin");
        fs::write(&rs_bug, buggy_sat).unwrap();
        let compile_bug = Command::new(&rustc)
            .args(["--edition", "2021", "--test", "-o"])
            .arg(&bin_bug)
            .arg(&rs_bug)
            .output()
            .expect("rustc must run");
        assert!(compile_bug.status.success());
        let run_bug = Command::new(&bin_bug).output().expect("run buggy binary");
        assert!(
            !run_bug.status.success(),
            "generated law test must catch saturating u64::MAX failure"
        );
        let combined_out = format!(
            "{}{}",
            String::from_utf8_lossy(&run_bug.stdout),
            String::from_utf8_lossy(&run_bug.stderr)
        );
        assert!(
            combined_out.contains("law over_release_is_noop failed on emitted Rust"),
            "output should name the failing law and inputs: {combined_out}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recursive_nat_cone_bounds_inputs_and_passes_compiled_test() {
        let bend_src = r#"import Base

def rec_id(n: Nat) -> Nat:
  match n:
    case 0n: 0n
    case 1n+p: Nat.add(1n, rec_id(p))

law rec_id_same:
  for n: Nat
  {rec_id(n) == n : Nat}
"#;
        let (_, defs) = crate::emit::parse_book_items(bend_src).unwrap();
        let laws = parse_laws(bend_src);
        let cone = law_dependency_cone(&laws[0], &defs);
        assert!(cone_is_recursive(&cone, &defs));

        let summary = emit_verified_rust(bend_src, 1).expect("emit recursive law");
        assert!(summary.rust_source.contains("__rb_pool_nat(rng, true)"));

        let dir = tmp_dir("rec");
        let rs = dir.join("rec.rs");
        let bin = dir.join("rec_bin");
        fs::write(&rs, &summary.rust_source).unwrap();
        let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = Command::new(&rustc)
            .args(["--edition", "2021", "--test", "-o"])
            .arg(&bin)
            .arg(&rs)
            .output()
            .expect("rustc must run");
        assert!(
            compile.status.success(),
            "rustc --test failed: {}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run = Command::new(&bin).output().expect("run test binary");
        assert!(
            run.status.success(),
            "recursive law test failed:\\n{}{}",
            String::from_utf8_lossy(&run.stdout),
            String::from_utf8_lossy(&run.stderr)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn evaluates_broken_law_counterexample_directly() {
        let broken_src = r#"import Base

type Ledger is Data:
  Ledger{a: Nat, f: Nat}

def ledger_total(+p: Ledger) -> Nat:
  match p:
    case Ledger{a, f}:
      Nat.add(a, f)

def ledger_release_if(+a: Nat, +f: Nat, +rel: Nat, ok: Bool) -> Ledger:
  match ok:
    case True{}:
      Ledger{Nat.sub(a, rel), Nat.add(f, rel)}
    case False{}:
      Ledger{a, Nat.add(f, rel)}

def ledger_release(+p: Ledger, +rel: Nat) -> Ledger:
  match p:
    case Ledger{+a, f}:
      ledger_release_if(a, f, rel, Nat.is_le(rel, a))

law release_conserves_total:
  for +a: Nat
  for +f: Nat
  for +rel: Nat
  {ledger_total(ledger_release(Ledger{a, f}, rel)) == Nat.add(a, f) : Nat}

def release_conserves_total(a, f, rel):
  {==}
"#;
        let dir = tmp_dir("direct_ce");
        let outcomes = evaluate_laws_for_counterexamples(
            broken_src,
            &["release_conserves_total".to_string()],
            &dir,
        )
        .expect("counterexample evaluation must succeed");
        assert_eq!(outcomes.len(), 1);
        assert!(matches!(outcomes[0], LawEvalOutcome::Counterexample(_)));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Bend names that are legal in Bend 2 but are Rust keywords (issue #16).
    const KEYWORD_NAMES_SRC: &str = r#"import Base

type Slot is Data:
  Slot{kind: Nat, ref: Nat}

def loop(as: Nat, in: Nat) -> Nat:
  Nat.add(as, in)

def pick(s: Slot) -> Nat:
  match s:
    case Slot{dyn, ref}:
      loop(dyn, ref)

def dec(fn: Nat) -> Nat:
  match fn:
    case 0n:
      0n
    case 1n+move:
      move

def own(self: Nat, crate: Nat) -> Nat:
  Nat.add(self, crate)

law pick_is_loop:
  for mut: Nat
  for ref: Nat
  {pick(Slot{mut, ref}) == loop(mut, ref) : Nat}

def pick_is_loop(mut, ref):
  {==}

law dec_succ:
  for fn: Nat
  {dec(1n+fn) == fn : Nat}

def dec_succ(fn):
  {==}

law own_is_loop:
  for self: Nat
  for super: Nat
  {own(self, super) == loop(self, super) : Nat}

def own_is_loop(self, super):
  {==}
"#;

    #[test]
    fn rust_keyword_names_compile_in_emitted_code_and_law_tests() {
        let dir = tmp_dir("keyword_names");
        let bend_file = dir.join("keywords.bend");
        fs::write(&bend_file, KEYWORD_NAMES_SRC).unwrap();

        // Differential check: the reference checker accepts these names.
        let bend_bin = crate::resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        if let Ok(out) = Command::new(&bend_bin)
            .arg(&bend_file)
            .arg("--check-only")
            .output()
        {
            assert!(
                out.status.success(),
                "bend --check-only failed: {}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        }

        let summary = emit_verified_rust(KEYWORD_NAMES_SRC, 3).expect("emit keyword names");
        let src = &summary.rust_source;
        for expected in [
            "pub fn r#loop(r#as: u64, r#in: u64)",
            "pub fn dec(r#fn: u64)",
            "pub fn own(__rb_self: u64, __rb_crate: u64)",
            "let r#mut = __arg0.clone();",
            "let __rb_super = __arg1.clone();",
        ] {
            assert!(src.contains(expected), "missing \`{expected}\` in:\\n{src}");
        }

        let program = format!(
            "{src}\\n#[cfg(test)]\\n#[test]\\nfn keyword_named_functions_run() {{\\n    assert_eq!(r#loop(2, 3), 5);\\n    assert_eq!(pick(Slot::Slot(4, 5)), 9);\\n    assert_eq!(dec(7), 6);\\n    assert_eq!(own(1, 2), 3);\\n}}\\n"
        );
        let rs = dir.join("keywords.rs");
        let bin = dir.join("keywords_bin");
        fs::write(&rs, program).unwrap();
        let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = Command::new(&rustc)
            .args(["--edition", "2021", "--test", "-o"])
            .arg(&bin)
            .arg(&rs)
            .output()
            .expect("rustc must run");
        assert!(
            compile.status.success(),
            "keyword names must compile: {}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run = Command::new(&bin).output().expect("run test binary");
        let out = String::from_utf8_lossy(&run.stdout);
        assert!(run.status.success(), "law tests must pass:\\n{out}");
        for law in ["law_pick_is_loop", "law_dec_succ", "law_own_is_loop"] {
            assert!(
                out.contains(&format!("{law} ... ok")),
                "{law} must run:\\n{out}"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rust_keyword_law_variable_reports_counterexample() {
        let broken = r#"import Base

def keep(as: Nat) -> Nat:
  Nat.add(as, 1n)

law keep_same:
  for as: Nat
  {keep(as) == as : Nat}
"#;
        let dir = tmp_dir("keyword_ce");
        let outcomes = evaluate_laws_for_counterexamples(broken, &["keep_same".to_string()], &dir)
            .expect("counterexample evaluation must compile with a keyword variable");
        assert_eq!(outcomes.len(), 1);
        match &outcomes[0] {
            LawEvalOutcome::Counterexample(ce) => {
                let text = format!("{ce:?}");
                assert!(
                    text.contains("as"),
                    "binding must keep its Bend name: {text}"
                );
            }
            other => panic!("expected a counterexample, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
`;

  const buildCrateMutate = `//! Mutation testing gate for RustyBends laws (Issue #6).
//!
//! Before an unlocked/new law is accepted (and before \`rusty-bends.lock\` can be
//! created or updated), generates small mutants of every live \`def\` in the law's
//! transitive dependency cone and evaluates the law on concrete inputs using the
//! emitted Rust evaluator from \`law_test\`. If no mutant makes the law false, the
//! law is vacuous and fails the build with \`[E_LAW_VACUOUS]\`.
//!
//! \`RUSTY_BENDS_MUTATE=all\` additionally runs over already-locked laws and emits
//! one diagnostic line per law (\`CAUGHT\` or \`SURVIVED\`) without failing on them.
//!
//! A new law the checker cannot evaluate at all (unsupported clause, \`exs\`, a goal
//! without \`==\`) fails with \`[E_LAW_UNCHECKED]\` unless it carries an explicit
//! \`# unchecked: <reason>\` marker (Issue #14). Locked laws only warn.

use crate::emit::{
    collect_law_source_slices, emit_items_to_rust, leading_indent, parse_book_items,
    split_case_arm, split_last_additive, split_top_level, split_top_level_once, CtorInfo, Def,
    Quantity, TypeDef, TypeEnv,
};
use crate::law_test::{
    create_temp_eval_dir, emit_eval_law_checker, emit_pool_runtime_helpers, parse_laws, ParsedLaw,
};
use crate::lock::{self, LockCheckReport};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// Budget for the original operator families (selection order unchanged since Issue #6).
const MAX_MUTANTS_PER_LAW: usize = 48;
/// Separate budget for the bound-pushing operator families (Issue #12), shared round-robin
/// so every family is represented even when the legacy families fill their budget.
const MAX_BOUND_MUTANTS_PER_LAW: usize = 48;
/// Separate budget for the return-replacement and literal families (Issue #15), so adding
/// them never changes which bound-pushing mutants are selected.
const MAX_RETURN_LIT_MUTANTS_PER_LAW: usize = 32;
/// Separate budget for \`Nat.add\` <-> \`Nat.max\` / \`Nat.min\` swaps (Issue #20), so adding
/// them never shifts any existing operator family's selection.
const MAX_ADD_MAX_MIN_MUTANTS_PER_LAW: usize = 32;
/// At most this many \`Nat\` literal sites per function are mutated by \`NatLit\`.
const MAX_NAT_LIT_SITES_PER_DEF: usize = 8;
/// Version tag baked into mutation cone hashes so cache keys invalidate when mutators change.
const MUTATE_CACHE_VERSION: &str = "v4";
/// Maximum mutants packed into one compiled multi-law harness binary.
const BATCH_MAX_MUTANTS: usize = 160;
/// Maximum distinct laws packed into one compiled multi-law harness binary.
const BATCH_MAX_LAWS: usize = 16;

/// Law shapes the mutation checker (and the generated per-law tests) can evaluate.
const SUPPORTED_LAW_FORMS: &str = "Supported forms: zero or more 'for x: T' binders (T = Nat, Bool, U32/U64/I32/I64, a user ADT, List<T>, or a tuple of these), optional '{a == b : T} ->' hypotheses, and an equality goal '{lhs == rhs : T}'. Not supported: 'exs' (existential), 'where' refinements, goals without '=='.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutateMode {
    NewOnly,
    All,
    Report,
}

impl MutateMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "all" => Self::All,
            "report" => Self::Report,
            _ => Self::NewOnly,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mutant {
    pub operator: String,
    pub description: String,
    pub def_name: String,
    pub mutated_body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MutantStatus {
    Caught(String),
    Survived,
    BuildError(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutantOutcome {
    pub def_name: String,
    pub operator: String,
    pub description: String,
    pub status: MutantStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LawMutationReport {
    pub law_name: String,
    pub cone: Vec<String>,
    pub total_mutants: usize,
    pub generated_mutants: usize,
    pub dropped_by_budget: usize,
    pub dropped_by_site_cap: usize,
    pub caught_by: Option<(String, String)>,
    pub survived_operators: Vec<String>,
    pub mutant_outcomes: Vec<MutantOutcome>,
    pub skipped_reason: Option<String>,
    pub from_cache: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationRunSummary {
    pub reports: Vec<LawMutationReport>,
    pub warnings: Vec<String>,
    pub report_path: Option<PathBuf>,
}

struct PreparedLaw<'a> {
    law: &'a ParsedLaw,
    is_locked: bool,
    cone: Vec<String>,
    cone_key: String,
    cone_defs: Vec<Def>,
    generated: GeneratedMutants,
}

struct LawWorkItem<'a> {
    prepared_idx: usize,
    law: &'a ParsedLaw,
    is_locked: bool,
    cone_defs: &'a [Def],
    mutants: &'a [Mutant],
}

#[derive(Debug, Clone)]
enum EvaluatedLawResult {
    Complete {
        caught_by: Option<(String, String)>,
        outcomes: Vec<MutantOutcome>,
    },
    BuildFailed {
        error_message: String,
        outcomes: Vec<MutantOutcome>,
    },
}

fn sanitize_cache_field(s: &str) -> String {
    s.replace(['\\t', '\\n', '\\r'], " ")
}

fn format_dropped_suffix(
    evaluated: usize,
    generated: usize,
    dropped_by_budget: usize,
    dropped_by_site_cap: usize,
) -> String {
    if dropped_by_budget + dropped_by_site_cap == 0 {
        return String::new();
    }
    let mut parts = Vec::new();
    if dropped_by_budget > 0 {
        parts.push(format!("{dropped_by_budget} dropped by budget"));
    }
    if dropped_by_site_cap > 0 {
        parts.push(format!("{dropped_by_site_cap} dropped by site cap"));
    }
    format!(" [evaluated {evaluated}/{generated}: {}]", parts.join(", "))
}

fn emit_law_build_warnings(law_name: &str, build_err: &str, warnings: &mut Vec<String>) {
    for line in build_err.lines() {
        warnings.push(format!("RustyBends mutate [{law_name}]: {line}"));
    }
}

/// Runs mutation checks according to \`mode\`:
/// - \`NewOnly\`: checks unlocked/new laws and fails with \`[E_LAW_VACUOUS]\` or \`[E_LAW_UNCHECKED]\`
///   when an unmarked new law fails to catch at least one mutant or cannot be evaluated.
/// - \`All\`: evaluates both new and locked laws and emits one diagnostic line per law.
/// - \`Report\`: evaluates every generated mutant of every checked law (new and locked), writes
///   the full report to \`OUT_DIR/rusty-bends-mutants.txt\`, and emits per-mutant lines.
pub fn run_mutation_checks(
    combined_source: &str,
    lock_report: &LockCheckReport,
    mode: MutateMode,
    out_dir: &Path,
) -> Result<MutationRunSummary, String> {
    let all_laws = parse_laws(combined_source);
    if all_laws.is_empty() {
        return Ok(MutationRunSummary {
            reports: Vec::new(),
            warnings: Vec::new(),
            report_path: None,
        });
    }

    let check_targets: Vec<&ParsedLaw> = all_laws
        .iter()
        .filter(|l| {
            lock_report.new_names.contains(&l.name)
                || (matches!(mode, MutateMode::All | MutateMode::Report)
                    && lock_report.locked_names.contains(&l.name))
        })
        .collect();

    if check_targets.is_empty() {
        return Ok(MutationRunSummary {
            reports: Vec::new(),
            warnings: Vec::new(),
            report_path: None,
        });
    }

    let (types, defs) = parse_book_items(combined_source)?;
    let extra_sources = collect_law_source_slices(&all_laws);
    let type_env = TypeEnv::build(&types, &defs, &extra_sources);
    let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
    let type_map: HashMap<String, &TypeDef> = types.iter().map(|t| (t.name.clone(), t)).collect();

    // Precompute call graph adjacency and structural fingerprints once across all laws.
    let def_callees = precompute_def_callees(&defs, &def_map);
    let types_hash = compute_types_hash(&types);
    let def_hashes = precompute_def_hashes(&defs);

    fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let cache_path = out_dir.join("rusty-bends-mutate.cache");
    let mut cache = load_mutate_cache(&cache_path);
    let mut cache_dirty = false;
    let full_report = mode == MutateMode::Report;

    let mut prepared: Vec<PreparedLaw<'_>> = Vec::with_capacity(check_targets.len());
    let mut report_slots: Vec<Option<LawMutationReport>> = vec![None; check_targets.len()];
    let mut build_errors: Vec<Option<String>> = vec![None; check_targets.len()];

    for law in &check_targets {
        let is_locked = lock_report.locked_names.contains(&law.name);
        let cone = law_dependency_cone_fast(law, &def_map, &def_callees);
        let cone_key = compute_cone_hash_fast(law, &cone, &types_hash, &def_hashes);
        let cone_defs: Vec<Def> = cone
            .iter()
            .filter_map(|name| def_map.get(name).map(|d| (*d).clone()))
            .collect();
        prepared.push(PreparedLaw {
            law,
            is_locked,
            cone,
            cone_key,
            cone_defs,
            generated: GeneratedMutants::default(),
        });
    }

    let mut pending_indices = Vec::new();
    for (idx, item) in prepared.iter_mut().enumerate() {
        if let Some(entry) = cache.get(&item.cone_key) {
            if let Some(cached_report) =
                report_from_cache(item, entry, full_report, &def_map, &type_env.ctor_map)
            {
                report_slots[idx] = Some(cached_report);
                continue;
            }
        }

        if let Some(ref reason) = item.law.unsupported_reason {
            let report = LawMutationReport {
                law_name: item.law.name.clone(),
                cone: item.cone.clone(),
                total_mutants: 0,
                generated_mutants: 0,
                dropped_by_budget: 0,
                dropped_by_site_cap: 0,
                caught_by: None,
                survived_operators: Vec::new(),
                mutant_outcomes: Vec::new(),
                skipped_reason: Some(reason.clone()),
                from_cache: false,
            };
            cache.insert(
                item.cone_key.clone(),
                cache_entry_from_report(&report, full_report),
            );
            cache_dirty = true;
            report_slots[idx] = Some(report);
            continue;
        }

        item.generated =
            generate_mutants_for_cone_with_stats(&item.cone_defs, &def_map, &type_env.ctor_map);
        if item.generated.mutants.is_empty() {
            let report = LawMutationReport {
                law_name: item.law.name.clone(),
                cone: item.cone.clone(),
                total_mutants: 0,
                generated_mutants: item.generated.generated_total,
                dropped_by_budget: item.generated.dropped_by_budget,
                dropped_by_site_cap: item.generated.dropped_by_site_cap,
                caught_by: None,
                survived_operators: Vec::new(),
                mutant_outcomes: Vec::new(),
                skipped_reason: None,
                from_cache: false,
            };
            cache.insert(
                item.cone_key.clone(),
                cache_entry_from_report(&report, full_report),
            );
            cache_dirty = true;
            report_slots[idx] = Some(report);
            continue;
        }

        if let Err(reason) = emit_eval_law_checker(
            "check", item.law, &defs, &def_map, &type_map, &type_env, true,
        ) {
            let report = LawMutationReport {
                law_name: item.law.name.clone(),
                cone: item.cone.clone(),
                total_mutants: item.generated.mutants.len(),
                generated_mutants: item.generated.generated_total,
                dropped_by_budget: item.generated.dropped_by_budget,
                dropped_by_site_cap: item.generated.dropped_by_site_cap,
                caught_by: None,
                survived_operators: Vec::new(),
                mutant_outcomes: Vec::new(),
                skipped_reason: Some(reason),
                from_cache: false,
            };
            cache.insert(
                item.cone_key.clone(),
                cache_entry_from_report(&report, full_report),
            );
            cache_dirty = true;
            report_slots[idx] = Some(report);
            continue;
        }

        pending_indices.push(idx);
    }

    if !pending_indices.is_empty() {
        let work_items: Vec<LawWorkItem<'_>> = pending_indices
            .iter()
            .map(|&idx| {
                let item = &prepared[idx];
                LawWorkItem {
                    prepared_idx: idx,
                    law: item.law,
                    is_locked: item.is_locked,
                    cone_defs: &item.cone_defs,
                    mutants: &item.generated.mutants,
                }
            })
            .collect();

        let eval_results = evaluate_work_items_batched(
            &work_items,
            &types,
            &type_map,
            &type_env,
            full_report,
            out_dir,
        )?;

        for (work, eval_res) in work_items.into_iter().zip(eval_results) {
            let item = &prepared[work.prepared_idx];
            let ops: Vec<String> = item
                .generated
                .mutants
                .iter()
                .map(|m| m.operator.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();

            match eval_res {
                EvaluatedLawResult::Complete {
                    caught_by,
                    outcomes,
                } => {
                    let report = LawMutationReport {
                        law_name: item.law.name.clone(),
                        cone: item.cone.clone(),
                        total_mutants: item.generated.mutants.len(),
                        generated_mutants: item.generated.generated_total,
                        dropped_by_budget: item.generated.dropped_by_budget,
                        dropped_by_site_cap: item.generated.dropped_by_site_cap,
                        caught_by,
                        survived_operators: ops,
                        mutant_outcomes: outcomes,
                        skipped_reason: None,
                        from_cache: false,
                    };
                    cache.insert(
                        item.cone_key.clone(),
                        cache_entry_from_report(&report, full_report),
                    );
                    cache_dirty = true;
                    report_slots[work.prepared_idx] = Some(report);
                }
                EvaluatedLawResult::BuildFailed {
                    error_message,
                    outcomes,
                } => {
                    let caught_by = outcomes.iter().find_map(|o| match &o.status {
                        MutantStatus::Caught(ce) => Some((o.description.clone(), ce.clone())),
                        _ => None,
                    });
                    let report = LawMutationReport {
                        law_name: item.law.name.clone(),
                        cone: item.cone.clone(),
                        total_mutants: item.generated.mutants.len(),
                        generated_mutants: item.generated.generated_total,
                        dropped_by_budget: item.generated.dropped_by_budget,
                        dropped_by_site_cap: item.generated.dropped_by_site_cap,
                        caught_by,
                        survived_operators: ops,
                        mutant_outcomes: outcomes,
                        skipped_reason: None,
                        from_cache: false,
                    };
                    build_errors[work.prepared_idx] = Some(error_message);
                    report_slots[work.prepared_idx] = Some(report);
                }
            }
        }
    }

    if cache_dirty {
        save_mutate_cache(&cache_path, &cache)?;
    }

    let reports: Vec<LawMutationReport> = report_slots
        .into_iter()
        .map(|slot| slot.expect("every target law has a mutation report"))
        .collect();
    let mut warnings = Vec::new();
    let mut report_path = None;

    if full_report {
        let report_file = out_dir.join("rusty-bends-mutants.txt");
        let mut all_lines = Vec::new();
        for report in &reports {
            all_lines.extend(format_full_law_report(report));
        }
        let caught_laws = reports
            .iter()
            .filter(|r| r.skipped_reason.is_none() && r.caught_by.is_some())
            .count();
        let survived_laws = reports
            .iter()
            .filter(|r| r.skipped_reason.is_none() && r.caught_by.is_none())
            .count();
        let skipped_laws = reports
            .iter()
            .filter(|r| r.skipped_reason.is_some())
            .count();
        all_lines.push(format!(
            "Summary: {} law(s), {caught_laws} caught, {survived_laws} survived, {skipped_laws} skipped",
            reports.len()
        ));
        fs::write(&report_file, format!("{}\\n", all_lines.join("\\n")))
            .map_err(|e| e.to_string())?;
        warnings.push(format!(
            "RustyBends mutate report written to {}",
            report_file.display()
        ));
        warnings.extend(all_lines);
        report_path = Some(report_file);
    }

    for (idx, report) in reports.iter().enumerate() {
        let is_locked = prepared[idx].is_locked;
        if let Some(ref build_err) = build_errors[idx] {
            if is_locked {
                emit_law_build_warnings(&report.law_name, build_err, &mut warnings);
                continue;
            }
            return Err(build_err.clone());
        }

        let unchecked_marker = lock_report
            .current
            .get(&report.law_name)
            .and_then(|l| l.unchecked.as_deref());

        if !is_locked {
            if let Some(ref reason) = report.skipped_reason {
                match unchecked_marker {
                    Some(marker) => warnings.push(format!(
                        "RustyBends mutate [{}]: UNCHECKED ({reason}); accepted by '# unchecked: {marker}'",
                        report.law_name
                    )),
                    None => {
                        return Err(format!(
                            "[E_LAW_UNCHECKED] New law '{}' cannot be mutation-checked: {reason}.\\nHint: {SUPPORTED_LAW_FORMS}\\nRewrite '{}' in a supported form, or, if it truly cannot be evaluated, add '# unchecked: <why>' directly above 'law {}:' so reviewers see the exemption (it is stored in rusty-bends.lock and shown by RUSTY_BENDS_LIST_LAWS=1).",
                            report.law_name, report.law_name, report.law_name
                        ));
                    }
                }
            } else if report.caught_by.is_none() {
                let cone_str = if report.cone.is_empty() {
                    "none".to_string()
                } else {
                    report.cone.join(", ")
                };
                let ops_str = if report.survived_operators.is_empty() {
                    "none (law references no live verified functions)".to_string()
                } else {
                    report.survived_operators.join(", ")
                };
                let dropped = format_dropped_suffix(
                    report.total_mutants,
                    report.generated_mutants,
                    report.dropped_by_budget,
                    report.dropped_by_site_cap,
                );
                return Err(format!(
                    "[E_LAW_VACUOUS] Law '{}' is vacuous: it caught 0 mutants across [{cone_str}] (survived {} mutants: {ops_str}){dropped}.\\nHint: Strengthen '{}' so it fails when its target function is broken.",
                    report.law_name, report.total_mutants, report.law_name
                ));
            } else if let Some(marker) = unchecked_marker {
                warnings.push(format!(
                    "RustyBends mutate [{}]: '# unchecked: {marker}' is unnecessary; the law is mutation-checkable, so remove the marker.",
                    report.law_name
                ));
            }
        }

        if mode == MutateMode::All
            && (is_locked || (report.skipped_reason.is_none() && report.caught_by.is_some()))
        {
            warnings.push(format_locked_law_line(report));
        }
    }

    Ok(MutationRunSummary {
        reports,
        warnings,
        report_path,
    })
}

pub fn format_locked_law_line(report: &LawMutationReport) -> String {
    let cached_tag = if report.from_cache { " [cached]" } else { "" };
    let dropped_tag = format_dropped_suffix(
        report.total_mutants,
        report.generated_mutants,
        report.dropped_by_budget,
        report.dropped_by_site_cap,
    );
    if let Some((ref desc, ref ce)) = report.caught_by {
        format!(
            "RustyBends mutate [{}]: caught by {desc} ({ce}){dropped_tag}{cached_tag}",
            report.law_name
        )
    } else if let Some(ref reason) = report.skipped_reason {
        format!(
            "RustyBends mutate [{}]: skipped ({reason}){cached_tag}",
            report.law_name
        )
    } else {
        let ops = if report.survived_operators.is_empty() {
            "none".to_string()
        } else {
            report.survived_operators.join(", ")
        };
        format!(
            "RustyBends mutate [{}]: SURVIVED ({} mutants: {ops}){dropped_tag}{cached_tag}",
            report.law_name, report.total_mutants
        )
    }
}

pub fn format_full_law_report(report: &LawMutationReport) -> Vec<String> {
    let cached_tag = if report.from_cache { " [cached]" } else { "" };
    let dropped_tag = format_dropped_suffix(
        report.total_mutants,
        report.generated_mutants,
        report.dropped_by_budget,
        report.dropped_by_site_cap,
    );
    if let Some(ref reason) = report.skipped_reason {
        return vec![format!(
            "RustyBends mutate [{}]: skipped ({reason}){cached_tag}",
            report.law_name
        )];
    }
    let caught_count = report
        .mutant_outcomes
        .iter()
        .filter(|o| matches!(o.status, MutantStatus::Caught(_)))
        .count();
    let survived_count = report
        .mutant_outcomes
        .iter()
        .filter(|o| matches!(o.status, MutantStatus::Survived))
        .count();
    let err_count = report
        .mutant_outcomes
        .iter()
        .filter(|o| matches!(o.status, MutantStatus::BuildError(_)))
        .count();
    let err_part = if err_count > 0 {
        format!(", {err_count} build-error")
    } else {
        String::new()
    };
    let mut lines = vec![format!(
        "RustyBends mutate [{}]: {caught_count}/{} caught, {survived_count} survived{err_part}{dropped_tag}{cached_tag}",
        report.law_name, report.total_mutants
    )];
    for o in &report.mutant_outcomes {
        match &o.status {
            MutantStatus::Caught(ce) => {
                lines.push(format!("  caught   {} ({ce})", o.description));
            }
            MutantStatus::Survived => {
                lines.push(format!("  survived {}", o.description));
            }
            MutantStatus::BuildError(err) => {
                lines.push(format!("  build-error {} ({err})", o.description));
            }
        }
    }
    lines
}

fn evaluate_work_items_batched(
    work_items: &[LawWorkItem<'_>],
    types: &[TypeDef],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    full_report: bool,
    out_dir: &Path,
) -> Result<Vec<EvaluatedLawResult>, String> {
    let mut batches: Vec<&[LawWorkItem<'_>]> = Vec::new();
    let mut start = 0usize;
    while start < work_items.len() {
        let mut end = start;
        let mut mut_count = 0usize;
        while end < work_items.len() && (end - start) < BATCH_MAX_LAWS {
            let next_m = work_items[end].mutants.len();
            if end > start && mut_count + next_m > BATCH_MAX_MUTANTS {
                break;
            }
            mut_count += next_m;
            end += 1;
        }
        batches.push(&work_items[start..end]);
        start = end;
    }

    if batches.len() <= 1 {
        let mut out = Vec::with_capacity(work_items.len());
        for batch in batches {
            out.extend(run_batch_with_fallback(
                batch,
                types,
                type_map,
                type_env,
                full_report,
                out_dir,
            )?);
        }
        return Ok(out);
    }

    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .clamp(1, 8)
        .min(batches.len());
    let next_batch = AtomicUsize::new(0);
    type BatchSlot = Option<Result<Vec<EvaluatedLawResult>, String>>;
    let results: Mutex<Vec<BatchSlot>> = Mutex::new(vec![None; batches.len()]);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let bi = next_batch.fetch_add(1, Ordering::Relaxed);
                if bi >= batches.len() {
                    break;
                }
                let res = run_batch_with_fallback(
                    batches[bi],
                    types,
                    type_map,
                    type_env,
                    full_report,
                    out_dir,
                );
                let mut guard = results.lock().expect("batch results mutex");
                guard[bi] = Some(res);
            });
        }
    });

    let mut out = Vec::with_capacity(work_items.len());
    let slots = results.into_inner().expect("batch results mutex");
    for slot in slots {
        out.extend(slot.expect("every batch completed")?);
    }
    Ok(out)
}

fn run_batch_with_fallback(
    batch: &[LawWorkItem<'_>],
    types: &[TypeDef],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    full_report: bool,
    out_dir: &Path,
) -> Result<Vec<EvaluatedLawResult>, String> {
    match run_batch_harness(batch, types, type_map, type_env, full_report, out_dir) {
        Ok(res) => Ok(res),
        Err(_) if batch.len() > 1 => {
            let mut out = Vec::with_capacity(batch.len());
            for item in batch {
                out.push(run_single_law_per_mutant_fallback(
                    item,
                    types,
                    type_map,
                    type_env,
                    full_report,
                    out_dir,
                ));
            }
            Ok(out)
        }
        Err(_) => Ok(vec![run_single_law_per_mutant_fallback(
            &batch[0],
            types,
            type_map,
            type_env,
            full_report,
            out_dir,
        )]),
    }
}

fn run_single_law_per_mutant_fallback(
    item: &LawWorkItem<'_>,
    types: &[TypeDef],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    full_report: bool,
    out_dir: &Path,
) -> EvaluatedLawResult {
    // First try the single law as a batch (when coming from a failed multi-law batch).
    if let Ok(mut single) = run_batch_harness(
        std::slice::from_ref(item),
        types,
        type_map,
        type_env,
        full_report,
        out_dir,
    ) {
        if let Some(res) = single.pop() {
            return res;
        }
    }

    let mut outcomes = Vec::with_capacity(item.mutants.len());
    let mut build_failures: Vec<(String, String)> = Vec::new();
    for m in item.mutants {
        let single_item = LawWorkItem {
            prepared_idx: item.prepared_idx,
            law: item.law,
            is_locked: item.is_locked,
            cone_defs: item.cone_defs,
            mutants: std::slice::from_ref(m),
        };
        match run_batch_harness(
            &[single_item],
            types,
            type_map,
            type_env,
            full_report,
            out_dir,
        ) {
            Ok(mut res) => {
                if let Some(EvaluatedLawResult::Complete {
                    caught_by,
                    outcomes: mut sub_outcomes,
                }) = res.pop()
                {
                    if !full_report {
                        if let Some(hit) = caught_by {
                            return EvaluatedLawResult::Complete {
                                caught_by: Some(hit),
                                outcomes: Vec::new(),
                            };
                        }
                    } else if let Some(first) = sub_outcomes.pop() {
                        outcomes.push(first);
                    }
                }
            }
            Err(HarnessError::Run) => {
                if full_report {
                    outcomes.push(MutantOutcome {
                        def_name: m.def_name.clone(),
                        operator: m.operator.clone(),
                        description: m.description.clone(),
                        status: MutantStatus::Survived,
                    });
                }
            }
            Err(HarnessError::Compile(stderr)) => {
                let first_error = first_rustc_error(&stderr);
                build_failures.push((m.description.clone(), first_error.clone()));
                if full_report {
                    outcomes.push(MutantOutcome {
                        def_name: m.def_name.clone(),
                        operator: m.operator.clone(),
                        description: m.description.clone(),
                        status: MutantStatus::BuildError(first_error),
                    });
                }
            }
        }
    }

    if let Some((desc, first_error)) = build_failures.first() {
        let msg = format!(
            "[E_MUTANT_BUILD] Law '{}': {} of {} mutants did not compile, so the law could not be mutation-checked. This is a RustyBends bug, not a problem with the law; please report it.\\nFirst failing mutant: {desc}\\nrustc: {first_error}",
            item.law.name,
            build_failures.len(),
            item.mutants.len()
        );
        return EvaluatedLawResult::BuildFailed {
            error_message: msg,
            outcomes,
        };
    }

    let caught_by = outcomes.iter().find_map(|o| match &o.status {
        MutantStatus::Caught(ce) => Some((o.description.clone(), ce.clone())),
        _ => None,
    });
    EvaluatedLawResult::Complete {
        caught_by,
        outcomes,
    }
}

fn first_rustc_error(stderr: &str) -> String {
    stderr
        .lines()
        .find(|l| l.trim_start().starts_with("error"))
        .unwrap_or("(no rustc error line)")
        .trim()
        .to_string()
}

#[cfg(test)]
fn evaluate_mutants_batch(
    law: &ParsedLaw,
    mutants: &[Mutant],
    types: &[TypeDef],
    cone_defs: &[Def],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    out_dir: &Path,
) -> Result<Option<(String, String)>, String> {
    let item = LawWorkItem {
        prepared_idx: 0,
        law,
        is_locked: false,
        cone_defs,
        mutants,
    };
    match run_single_law_per_mutant_fallback(&item, types, type_map, type_env, false, out_dir) {
        EvaluatedLawResult::Complete { caught_by, .. } => Ok(caught_by),
        EvaluatedLawResult::BuildFailed { error_message, .. } => Err(error_message),
    }
}

#[cfg(test)]
fn run_mutant_harness(
    law: &ParsedLaw,
    mutants: &[Mutant],
    types: &[TypeDef],
    cone_defs: &[Def],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    out_dir: &Path,
) -> Result<Option<(String, String)>, HarnessError> {
    let item = LawWorkItem {
        prepared_idx: 0,
        law,
        is_locked: false,
        cone_defs,
        mutants,
    };
    let res = run_batch_harness(&[item], types, type_map, type_env, false, out_dir)?;
    match res.into_iter().next() {
        Some(EvaluatedLawResult::Complete { caught_by, .. }) => Ok(caught_by),
        _ => Ok(None),
    }
}

/// Why a mutant harness produced no verdict.
enum HarnessError {
    /// rustc rejected the generated program (carries its stderr).
    Compile(String),
    /// Anything else: emitting, writing, launching or running the program. A mutant
    /// that crashes its binary is treated as not caught, as before.
    Run,
}

impl From<String> for HarnessError {
    fn from(_: String) -> Self {
        HarnessError::Run
    }
}

fn run_batch_harness(
    batch: &[LawWorkItem<'_>],
    types: &[TypeDef],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    full_report: bool,
    out_dir: &Path,
) -> Result<Vec<EvaluatedLawResult>, HarnessError> {
    let mut program = String::new();
    program.push_str("#![allow(clippy::all, non_snake_case, unused_variables, unused_parens, dead_code, unused_mut)]\\n");

    let types_only = emit_items_to_rust(types, &[], type_env, 0, None, true)?;
    program.push_str(&types_only.rust_source);
    program.push('\\n');
    program.push_str(&emit_pool_runtime_helpers(types, type_map, type_env, true));
    program.push('\\n');

    let mut per_law_active: Vec<Vec<usize>> = Vec::with_capacity(batch.len());
    let mut per_law_emit_errors: Vec<Vec<Option<String>>> = batch
        .iter()
        .map(|item| vec![None; item.mutants.len()])
        .collect();
    let mut any_active = false;

    for (bi, item) in batch.iter().enumerate() {
        let mut active_indices = Vec::new();
        for (mi, mutant) in item.mutants.iter().enumerate() {
            let mut mut_defs = item.cone_defs.to_vec();
            for d in &mut mut_defs {
                if d.name == mutant.def_name {
                    d.body = mutant.mutated_body.clone();
                }
            }
            let defs_rs = match emit_items_to_rust(&[], &mut_defs, type_env, 0, Some(10_000), false)
            {
                Ok(v) => v,
                Err(err) => {
                    per_law_emit_errors[bi][mi] = Some(err);
                    continue;
                }
            };
            let mut_def_map: HashMap<String, &Def> =
                mut_defs.iter().map(|d| (d.name.clone(), d)).collect();
            let check_fn = match emit_eval_law_checker(
                "check",
                item.law,
                &mut_defs,
                &mut_def_map,
                type_map,
                type_env,
                true,
            ) {
                Ok(v) => v,
                Err(err) => {
                    per_law_emit_errors[bi][mi] = Some(err);
                    continue;
                }
            };
            program.push_str(&format!("mod l_{bi}_m_{mi} {{\\n    use super::*;\\n"));
            for line in defs_rs.rust_source.lines() {
                program.push_str("    ");
                program.push_str(line);
                program.push('\\n');
            }
            for line in check_fn.lines() {
                program.push_str("    ");
                program.push_str(line);
                program.push('\\n');
            }
            program.push_str("}\\n\\n");
            active_indices.push(mi);
            any_active = true;
        }
        per_law_active.push(active_indices);
    }

    if !any_active {
        return Ok(batch
            .iter()
            .map(|item| EvaluatedLawResult::Complete {
                caught_by: None,
                outcomes: if full_report {
                    item.mutants
                        .iter()
                        .map(|m| MutantOutcome {
                            def_name: m.def_name.clone(),
                            operator: m.operator.clone(),
                            description: m.description.clone(),
                            status: MutantStatus::Survived,
                        })
                        .collect()
                } else {
                    Vec::new()
                },
            })
            .collect());
    }

    for (bi, active_indices) in per_law_active.iter().enumerate() {
        program.push_str(&format!("fn __rb_run_batch_law_{bi}() {{\\n"));
        for &mi in active_indices {
            if full_report {
                program.push_str(&format!(
                    "    match l_{bi}_m_{mi}::check() {{\\n        Some(ce) => println!(\\"CAUGHT\\\\t{bi}\\\\t{mi}\\\\t{{}}\\", ce.replace(['\\\\n', '\\\\r', '\\\\t'], \\" \\")),\\n        None => println!(\\"SURVIVED\\\\t{bi}\\\\t{mi}\\"),\\n    }}\\n"
                ));
            } else {
                program.push_str(&format!(
                    "    if let Some(ce) = l_{bi}_m_{mi}::check() {{ println!(\\"CAUGHT\\\\t{bi}\\\\t{mi}\\\\t{{}}\\", ce.replace(['\\\\n', '\\\\r', '\\\\t'], \\" \\")); return; }}\\n"
                ));
            }
        }
        program.push_str("}\\n\\n");
    }

    program.push_str("fn main() {\\n");
    for bi in 0..batch.len() {
        program.push_str(&format!("    __rb_run_batch_law_{bi}();\\n"));
    }
    program.push_str("}\\n");

    let eval_dir = create_temp_eval_dir(out_dir, "mut")?;
    let rs_path = eval_dir.0.join("mutate.rs");
    let bin_path = eval_dir.0.join("mutate_bin");
    fs::write(&rs_path, program).map_err(|_| HarnessError::Run)?;

    let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
    let compile = Command::new(&rustc)
        .args(["--edition", "2021", "-A", "warnings", "-o"])
        .arg(&bin_path)
        .arg(&rs_path)
        .output()
        .map_err(|e| format!("failed to invoke '{rustc}' for mutation testing: {e}"))?;
    if !compile.status.success() {
        return Err(HarnessError::Compile(
            String::from_utf8_lossy(&compile.stderr).into_owned(),
        ));
    }

    let run = Command::new(&bin_path)
        .output()
        .map_err(|e| format!("failed to run mutant binary: {e}"))?;
    if !run.status.success() {
        return Err(HarnessError::Run);
    }

    let mut per_law_caught: Vec<Option<(String, String)>> = vec![None; batch.len()];
    let mut per_law_statuses: Vec<Vec<Option<MutantStatus>>> = batch
        .iter()
        .map(|item| vec![None; item.mutants.len()])
        .collect();

    let stdout = String::from_utf8_lossy(&run.stdout);
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("CAUGHT\\t") {
            let mut parts = rest.splitn(3, '\\t');
            if let (Some(bi_str), Some(mi_str), Some(ce)) =
                (parts.next(), parts.next(), parts.next())
            {
                if let (Ok(bi), Ok(mi)) = (bi_str.parse::<usize>(), mi_str.parse::<usize>()) {
                    if let Some(item) = batch.get(bi) {
                        if let Some(m) = item.mutants.get(mi) {
                            let ce_clean = ce.trim().to_string();
                            if per_law_caught[bi].is_none() {
                                per_law_caught[bi] =
                                    Some((m.description.clone(), ce_clean.clone()));
                            }
                            if full_report {
                                per_law_statuses[bi][mi] = Some(MutantStatus::Caught(ce_clean));
                            }
                        }
                    }
                }
            }
        } else if full_report {
            if let Some(rest) = line.strip_prefix("SURVIVED\\t") {
                if let Some((bi_str, mi_str)) = rest.split_once('\\t') {
                    if let (Ok(bi), Ok(mi)) = (bi_str.parse::<usize>(), mi_str.parse::<usize>()) {
                        if let Some(statuses) = per_law_statuses.get_mut(bi) {
                            if mi < statuses.len() {
                                statuses[mi] = Some(MutantStatus::Survived);
                            }
                        }
                    }
                }
            }
        }
    }

    let mut results = Vec::with_capacity(batch.len());
    for (bi, item) in batch.iter().enumerate() {
        let outcomes = if full_report {
            item.mutants
                .iter()
                .enumerate()
                .map(|(mi, m)| MutantOutcome {
                    def_name: m.def_name.clone(),
                    operator: m.operator.clone(),
                    description: m.description.clone(),
                    status: per_law_statuses[bi][mi].clone().unwrap_or_else(|| {
                        if let Some(ref err) = per_law_emit_errors[bi][mi] {
                            MutantStatus::BuildError(err.clone())
                        } else {
                            MutantStatus::Survived
                        }
                    }),
                })
                .collect()
        } else {
            Vec::new()
        };
        results.push(EvaluatedLawResult::Complete {
            caught_by: per_law_caught[bi].take(),
            outcomes,
        });
    }
    Ok(results)
}

/// A candidate mutant before selection: \`(def, mutated body, description)\`.
type Candidate<'a> = (&'a Def, String, String);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct GeneratedMutants {
    pub mutants: Vec<Mutant>,
    pub generated_total: usize,
    pub dropped_by_budget: usize,
    pub dropped_by_site_cap: usize,
}

fn record_dropped(
    def: &Def,
    body: &str,
    seen: &HashSet<(String, String)>,
    dropped_seen: &mut HashSet<(String, String)>,
    dropped_by_budget: &mut usize,
) {
    let trimmed = body.trim().to_string();
    let key = (def.name.clone(), trimmed);
    if key.1 != def.body.trim() && !seen.contains(&key) && dropped_seen.insert(key) {
        *dropped_by_budget += 1;
    }
}

/// Generates small syntactic mutants for all live \`Def\`s in a law's dependency cone.
///
/// Legacy families (BoolFlip, NatCmpArith, DropBoolOperand, ReturnUnchanged, SwapMatchArms)
/// fill the first \`MAX_MUTANTS_PER_LAW\` slots in their original order. The bound-pushing
/// families (NatBound, SiblingCtor, BoolConst, FlipCmp) then take up to
/// \`MAX_BOUND_MUTANTS_PER_LAW\` more slots, round-robin across families. Finally ReturnCtor
/// and NatLit take up to \`MAX_RETURN_LIT_MUTANTS_PER_LAW\` slots, round-robin. Each mutant's
/// description ends with \`[<Operator>]\` so reports name the operator that caught a law.
#[cfg(test)]
pub(crate) fn generate_mutants_for_cone(
    cone_defs: &[Def],
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
) -> Vec<Mutant> {
    generate_mutants_for_cone_with_stats(cone_defs, def_map, ctor_map).mutants
}

pub(crate) fn generate_mutants_for_cone_with_stats(
    cone_defs: &[Def],
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
) -> GeneratedMutants {
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut dropped_seen: HashSet<(String, String)> = HashSet::new();
    let mut dropped_by_budget = 0usize;
    let mut dropped_by_site_cap = 0usize;

    let mut mutants = Vec::new();
    for def in cone_defs {
        let protected = compute_protected_ranges(&def.body);
        let legacy: Vec<(&str, Vec<(String, String)>)> = vec![
            // 1. Bool flip: True{} <-> False{}, true <-> false, Bool.pick branch swap
            ("BoolFlip", mutate_bool_flips(&def.body, &protected)),
            // 2. Nat comparison & arithmetic swaps
            ("NatCmpArith", mutate_nat_ops(&def.body, &protected)),
            // 3. Drop one operand of Bool.and / Bool.or / && / ||
            (
                "DropBoolOperand",
                mutate_drop_bool_operand(&def.body, &protected),
            ),
            // 4. Return parameter or matched constructor unchanged
            ("ReturnUnchanged", mutate_return_unchanged(def, ctor_map)),
            // 5. Swap two match arms with compatible binders
            (
                "SwapMatchArms",
                mutate_swap_match_arms(def, def_map, ctor_map),
            ),
        ];
        for (op, candidates) in legacy {
            for (body, desc) in candidates {
                if mutants.len() >= MAX_MUTANTS_PER_LAW {
                    record_dropped(def, &body, &seen, &mut dropped_seen, &mut dropped_by_budget);
                    continue;
                }
                if let Some(m) = make_mutant(op, desc, def, body, &mut seen) {
                    mutants.push(m);
                }
            }
        }
    }

    // Bound-pushing families (Issue #12): collected per family, then picked round-robin.
    let mut families: Vec<(&str, Vec<Candidate<'_>>)> = vec![
        ("NatBound", Vec::new()),
        ("SiblingCtor", Vec::new()),
        ("BoolConst", Vec::new()),
        ("FlipCmp", Vec::new()),
    ];
    for def in cone_defs {
        let protected = compute_protected_ranges(&def.body);
        for (body, desc) in mutate_nat_bound(def) {
            families[0].1.push((def, body, desc));
        }
        for (body, desc) in mutate_sibling_ctor(def, ctor_map, &protected) {
            families[1].1.push((def, body, desc));
        }
        for (body, desc) in mutate_bool_const(def, def_map, ctor_map, &protected) {
            families[2].1.push((def, body, desc));
        }
        for (body, desc) in mutate_flip_cmp(&def.body, &protected) {
            families[3].1.push((def, body, desc));
        }
    }
    pick_round_robin_with_stats(
        &families,
        MAX_BOUND_MUTANTS_PER_LAW,
        &mut seen,
        &mut dropped_seen,
        &mut dropped_by_budget,
        &mut mutants,
    );

    // Return-replacement and literal families (Issue #15), with their own budget.
    let mut families: Vec<(&str, Vec<Candidate<'_>>)> =
        vec![("ReturnCtor", Vec::new()), ("NatLit", Vec::new())];
    for def in cone_defs {
        let protected = compute_protected_ranges(&def.body);
        for (body, desc) in mutate_return_ctor(def, def_map, ctor_map) {
            families[0].1.push((def, body, desc));
        }
        let (lit_mutants, site_dropped) = mutate_nat_lit_with_stats(&def.body, &protected);
        dropped_by_site_cap += site_dropped;
        for (body, desc) in lit_mutants {
            families[1].1.push((def, body, desc));
        }
    }
    pick_round_robin_with_stats(
        &families,
        MAX_RETURN_LIT_MUTANTS_PER_LAW,
        &mut seen,
        &mut dropped_seen,
        &mut dropped_by_budget,
        &mut mutants,
    );

    // \`Nat.add\` <-> \`Nat.max\` / \`Nat.min\` (Issue #20), with its own budget.
    let mut families: Vec<(&str, Vec<Candidate<'_>>)> = vec![("NatAddMaxMin", Vec::new())];
    for def in cone_defs {
        let protected = compute_protected_ranges(&def.body);
        for (body, desc) in mutate_nat_add_max_min(&def.body, &protected) {
            families[0].1.push((def, body, desc));
        }
    }
    pick_round_robin_with_stats(
        &families,
        MAX_ADD_MAX_MIN_MUTANTS_PER_LAW,
        &mut seen,
        &mut dropped_seen,
        &mut dropped_by_budget,
        &mut mutants,
    );

    let generated_total = mutants.len() + dropped_by_budget + dropped_by_site_cap;
    GeneratedMutants {
        mutants,
        generated_total,
        dropped_by_budget,
        dropped_by_site_cap,
    }
}

fn make_mutant(
    operator: &str,
    desc: String,
    def: &Def,
    body: String,
    seen: &mut HashSet<(String, String)>,
) -> Option<Mutant> {
    let trimmed = body.trim().to_string();
    if trimmed == def.body.trim() || !seen.insert((def.name.clone(), trimmed)) {
        return None;
    }
    Some(Mutant {
        operator: operator.to_string(),
        description: format!("{}: {desc} [{operator}]", def.name),
        def_name: def.name.clone(),
        mutated_body: body,
    })
}

/// Appends up to \`cap\` mutants from \`families\`, taking one per family in turn so every family
/// is represented. Candidates rejected by \`make_mutant\` (unchanged or duplicate bodies) are
/// skipped; unique candidates left over after \`cap\` is reached are counted in \`dropped_by_budget\`.
fn pick_round_robin_with_stats(
    families: &[(&str, Vec<Candidate<'_>>)],
    cap: usize,
    seen: &mut HashSet<(String, String)>,
    dropped_seen: &mut HashSet<(String, String)>,
    dropped_by_budget: &mut usize,
    mutants: &mut Vec<Mutant>,
) {
    let mut cursors = vec![0usize; families.len()];
    let mut taken = 0usize;
    while taken < cap {
        let mut progressed = false;
        for (fi, (op, items)) in families.iter().enumerate() {
            if taken >= cap {
                break;
            }
            while cursors[fi] < items.len() {
                let (def, body, desc) = &items[cursors[fi]];
                cursors[fi] += 1;
                if let Some(m) = make_mutant(op, desc.clone(), def, body.clone(), seen) {
                    mutants.push(m);
                    taken += 1;
                    progressed = true;
                    break;
                }
            }
        }
        if !progressed {
            break;
        }
    }
    for (fi, (_, items)) in families.iter().enumerate() {
        for (def, body, _) in &items[cursors[fi]..] {
            record_dropped(def, body, seen, dropped_seen, dropped_by_budget);
        }
    }
}

/// NatAddMaxMin: swaps \`Nat.add\` with \`Nat.max\` / \`Nat.min\` (including parenthesized infix
/// \`(lhs + rhs : Nat)\`), and swaps \`Nat.max\` / \`Nat.min\` with \`Nat.add\`, so bound laws that
/// would hold if a sum were replaced by a maximum are exposed as survivors unless a lower-bound
/// law distinguishes them (Issue #20).
fn mutate_nat_add_max_min(body: &str, protected: &[(usize, usize)]) -> Vec<(String, String)> {
    let fn_swaps: &[(&str, &[&str])] = &[
        ("Nat.add", &["Nat.max", "Nat.min"]),
        ("Nat.max", &["Nat.add"]),
        ("Nat.min", &["Nat.add"]),
    ];
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if in_protected(i, protected) {
            i += 1;
            continue;
        }
        let prev_ident = i > 0
            && (bytes[i - 1].is_ascii_alphanumeric()
                || bytes[i - 1] == b'_'
                || bytes[i - 1] == b'.');
        if !prev_ident {
            let mut matched = false;
            for &(from, tos) in fn_swaps {
                if body[i..].starts_with(from) {
                    let end = i + from.len();
                    let next_ok = end == bytes.len()
                        || (!bytes[end].is_ascii_alphanumeric()
                            && bytes[end] != b'_'
                            && bytes[end] != b'.');
                    if next_ok {
                        for &to in tos {
                            out.push((replace_span(body, i, end, to), format!("{from} -> {to}")));
                        }
                        i = end;
                        matched = true;
                        break;
                    }
                }
            }
            if matched {
                continue;
            }
        }
        if bytes[i] == b'(' {
            if let Some(close_rel) = find_matching_paren(&body[i..]) {
                let close_abs = i + close_rel;
                let inner = body[i + 1..close_abs].trim();
                if split_top_level(inner, ',').len() == 1 {
                    if let Some((term_part, ty_part)) = split_top_level_once(inner, ':') {
                        if ty_part.trim() == "Nat" {
                            if let Some(('+', lhs, rhs)) = split_last_additive(term_part.trim()) {
                                if !lhs.is_empty() && !rhs.is_empty() {
                                    out.push((
                                        replace_span(
                                            body,
                                            i,
                                            close_abs + 1,
                                            &format!("Nat.max({lhs}, {rhs})"),
                                        ),
                                        "(+ : Nat) -> Nat.max".to_string(),
                                    ));
                                    out.push((
                                        replace_span(
                                            body,
                                            i,
                                            close_abs + 1,
                                            &format!("Nat.min({lhs}, {rhs})"),
                                        ),
                                        "(+ : Nat) -> Nat.min".to_string(),
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }
        i += 1;
    }
    out
}

/// Re-indents \`body\` by four spaces under \`let __rb_r =\` and returns \`<wrap>\` applied to the
/// bound result. The emitter lowers this as a block \`{ let __rb_r = <body>; <wrap> }\`.
fn wrap_result(body: &str, wrap: &str) -> String {
    let mut out = String::from("let __rb_r =\\n");
    for line in body.lines() {
        if line.trim().is_empty() {
            continue;
        }
        out.push_str("    ");
        out.push_str(line);
        out.push('\\n');
    }
    out.push_str(wrap);
    out
}

/// NatBound: pushes a \`Nat\` result past a bound (\`+ 1\`, \`- 1\`, or \`0n\`) so one-direction
/// bound laws such as \`Nat.is_le(f(l), l) == True{}\` are caught.
fn mutate_nat_bound(def: &Def) -> Vec<(String, String)> {
    if def.ret.trim() != "Nat" {
        return Vec::new();
    }
    vec![
        (
            wrap_result(&def.body, "Nat.add(__rb_r, 1n)"),
            "result -> Nat.add(result, 1n)".to_string(),
        ),
        (
            wrap_result(&def.body, "Nat.sub(__rb_r, 1n)"),
            "result -> Nat.sub(result, 1n)".to_string(),
        ),
        ("0n".to_string(), "result -> 0n".to_string()),
    ]
}

/// Small filler value for a constructor field of type \`ty\`, used when a sibling constructor's
/// fields differ from the original's.
fn filler_value(ty: &str, ctor_map: &HashMap<String, CtorInfo>) -> Option<String> {
    match ty.trim() {
        "Nat" => Some("0n".to_string()),
        "Bool" => Some("False{}".to_string()),
        other => {
            let mut nullary: Vec<&CtorInfo> = ctor_map
                .values()
                .filter(|c| c.type_name == other && c.arity == 0)
                .collect();
            nullary.sort_by(|a, b| a.variant_name.cmp(&b.variant_name));
            nullary
                .first()
                .map(|c| format!("{}.{}{{}}", c.type_name, c.variant_name))
        }
    }
}

fn find_matching_brace(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    for (idx, ch) in s.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(idx);
                }
            }
            _ => {}
        }
    }
    None
}

/// SiblingCtor: replaces a constructor of the function's return type with each sibling
/// constructor of the same type (same fields when the shapes match, small filler values
/// otherwise), so absorbing-state laws like \`step(Done{}, e) == Done{}\` are caught.
fn mutate_sibling_ctor(
    def: &Def,
    ctor_map: &HashMap<String, CtorInfo>,
    protected: &[(usize, usize)],
) -> Vec<(String, String)> {
    let ret = def.ret.trim();
    let mut siblings: Vec<&CtorInfo> = Vec::new();
    let mut seen_variants = HashSet::new();
    let mut infos: Vec<&CtorInfo> = ctor_map.values().filter(|c| c.type_name == ret).collect();
    infos.sort_by(|a, b| a.variant_name.cmp(&b.variant_name));
    for info in infos {
        if seen_variants.insert(info.variant_name.clone()) {
            siblings.push(info);
        }
    }
    if siblings.len() < 2 {
        return Vec::new();
    }

    let body = def.body.as_str();
    let bytes = body.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let starts_ident = (bytes[i].is_ascii_alphabetic() || bytes[i] == b'_')
            && (i == 0
                || !(bytes[i - 1].is_ascii_alphanumeric()
                    || bytes[i - 1] == b'_'
                    || bytes[i - 1] == b'.'));
        if !starts_ident || in_protected(i, protected) {
            i += 1;
            continue;
        }
        let mut end = i;
        while end < bytes.len()
            && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_' || bytes[end] == b'.')
        {
            end += 1;
        }
        let name = &body[i..end];
        let Some(info) = ctor_map.get(name).filter(|c| c.type_name == ret) else {
            i = end;
            continue;
        };
        if end >= bytes.len() || bytes[end] != b'{' {
            i = end;
            continue;
        }
        let Some(close_rel) = find_matching_brace(&body[end..]) else {
            i = end;
            continue;
        };
        let close_abs = end + close_rel;
        let inner = body[end + 1..close_abs].trim();
        for sib in &siblings {
            if sib.variant_name == info.variant_name {
                continue;
            }
            let args = if sib.field_types == info.field_types {
                Some(inner.to_string())
            } else {
                sib.field_types
                    .iter()
                    .map(|ft| filler_value(ft, ctor_map))
                    .collect::<Option<Vec<_>>>()
                    .map(|v| v.join(", "))
            };
            let Some(args) = args else {
                continue;
            };
            let repl = format!("{}.{}{{{args}}}", sib.type_name, sib.variant_name);
            out.push((
                replace_span(body, i, close_abs + 1, &repl),
                format!(
                    "{name}{{..}} -> {}.{}{{..}}",
                    sib.type_name, sib.variant_name
                ),
            ));
        }
        i = close_abs + 1;
    }
    out
}

struct BodyLine {
    code_lo: usize,
    code_hi: usize,
    indent: usize,
}

fn slice_non_empty_lines(body: &str, lo: usize, hi: usize) -> Vec<BodyLine> {
    let mut out = Vec::new();
    let mut offset = lo;
    for raw in body[lo..hi].split_inclusive('\\n') {
        let without_nl = raw.trim_end_matches(['\\n', '\\r']);
        if !without_nl.trim().is_empty() {
            let ws_start = without_nl.len() - without_nl.trim_start().len();
            let code_lo = offset + ws_start;
            let code_hi = offset + without_nl.trim_end().len();
            let line_start = body[..code_lo].rfind('\\n').map_or(0, |p| p + 1);
            let prefix = &body[line_start..code_lo];
            let indent = if prefix.bytes().all(|b| b == b' ' || b == b'\\t') {
                leading_indent(prefix)
            } else {
                0
            };
            out.push(BodyLine {
                code_lo,
                code_hi,
                indent,
            });
        }
        offset += raw.len();
    }
    out
}

fn delim_delta(s: &str) -> i32 {
    let bytes = s.as_bytes();
    let mut delta = 0i32;
    let mut in_string = false;
    let mut i = 0usize;
    while i < bytes.len() {
        if in_string {
            if bytes[i] == b'\\\\' && i + 1 < bytes.len() {
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match bytes[i] {
            b'"' => in_string = true,
            b'(' | b'{' | b'[' => delta += 1,
            b')' | b'}' | b']' => delta -= 1,
            _ => {}
        }
        i += 1;
    }
    delta
}

fn subslice_span(parent: &str, sub: &str) -> (usize, usize) {
    let lo = sub.as_ptr() as usize - parent.as_ptr() as usize;
    (lo, lo + sub.len())
}

fn split_matching_else(s: &str) -> Option<(&str, &str)> {
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut if_depth = 0usize;
    let mut in_string = false;
    let mut i = 0usize;
    while i < bytes.len() {
        if in_string {
            if bytes[i] == b'\\\\' && i + 1 < bytes.len() {
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match bytes[i] {
            b'"' => in_string = true,
            b'(' | b'{' | b'[' => depth += 1,
            b')' | b'}' | b']' => depth -= 1,
            _ if depth == 0 => {
                let prev_non_ident = i == 0
                    || (!bytes[i - 1].is_ascii_alphanumeric()
                        && bytes[i - 1] != b'_'
                        && bytes[i - 1] != b'.');
                if prev_non_ident
                    && s[i..].starts_with("if")
                    && bytes.get(i + 2).is_some_and(u8::is_ascii_whitespace)
                {
                    if_depth += 1;
                    i += 2;
                    continue;
                }
                if i > 0 && bytes[i - 1].is_ascii_whitespace() && s[i..].starts_with("else:") {
                    if if_depth == 0 {
                        return Some((&s[..i], &s[i + "else:".len()..]));
                    }
                    if_depth -= 1;
                    i += "else:".len();
                    continue;
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn split_inline_case_arms(inline_arms: &str) -> Vec<&str> {
    let bytes = inline_arms.as_bytes();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut markers = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if in_string {
            if bytes[i] == b'\\\\' && i + 1 < bytes.len() {
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match bytes[i] {
            b'"' => in_string = true,
            b'(' | b'{' | b'[' => depth += 1,
            b')' | b'}' | b']' => depth -= 1,
            _ if depth == 0 => {
                let prev_non_ident = i == 0
                    || (!bytes[i - 1].is_ascii_alphanumeric()
                        && bytes[i - 1] != b'_'
                        && bytes[i - 1] != b'.');
                if prev_non_ident
                    && inline_arms[i..].starts_with("case")
                    && bytes.get(i + 4).is_some_and(u8::is_ascii_whitespace)
                {
                    markers.push(i);
                    i += 4;
                    continue;
                }
            }
            _ => {}
        }
        i += 1;
    }

    let mut arms = Vec::with_capacity(markers.len());
    for (idx, &start) in markers.iter().enumerate() {
        let end = markers.get(idx + 1).copied().unwrap_or(inline_arms.len());
        let trimmed = inline_arms[start + "case".len()..end]
            .trim()
            .trim_end_matches(';')
            .trim();
        if !trimmed.is_empty() {
            arms.push(trimmed);
        }
    }
    arms
}

fn collect_return_leaf_spans(body: &str, lo: usize, hi: usize, out: &mut Vec<(usize, usize)>) {
    let lines = slice_non_empty_lines(body, lo, hi);
    let Some(first_line) = lines.first() else {
        return;
    };
    let span_lo = first_line.code_lo;
    let span_hi = lines.last().unwrap().code_hi;
    let first = &body[first_line.code_lo..first_line.code_hi];

    // 1. Multi-line \`let <pat> = <val>\\n  <body>\`
    if lines.len() > 1 && first.starts_with("let ") && split_top_level_once(first, ';').is_none() {
        if let Some((_, val_first)) = split_top_level_once(&first["let ".len()..], '=') {
            let let_indent = first_line.indent;
            let mut depth = delim_delta(val_first);
            let mut split_idx = 1;
            while split_idx < lines.len() && (depth > 0 || lines[split_idx].indent > let_indent) {
                let line_txt = &body[lines[split_idx].code_lo..lines[split_idx].code_hi];
                depth += delim_delta(line_txt);
                split_idx += 1;
            }
            if split_idx < lines.len() {
                collect_return_leaf_spans(body, lines[split_idx].code_lo, span_hi, out);
                return;
            }
        }
    }

    // 2. \`match <scrut>: ...\` (multi-line or single-line)
    if let Some(after_match) = first.strip_prefix("match ") {
        if lines.len() > 1 {
            let mut depth = delim_delta(first);
            let mut first_case = None;
            for (idx, line) in lines.iter().enumerate().skip(1) {
                let txt = &body[line.code_lo..line.code_hi];
                if depth == 0 && txt.starts_with("case ") {
                    first_case = Some(idx);
                    break;
                }
                depth += delim_delta(txt);
            }
            if let Some(fc) = first_case {
                let case_indent = lines[fc].indent;
                let mut arm_starts = Vec::new();
                let mut arm_depth = 0i32;
                for (idx, line) in lines.iter().enumerate().skip(fc) {
                    let txt = &body[line.code_lo..line.code_hi];
                    if arm_depth == 0 && line.indent == case_indent && txt.starts_with("case ") {
                        arm_starts.push(idx);
                    }
                    arm_depth += delim_delta(txt);
                }
                for (ai, &start_idx) in arm_starts.iter().enumerate() {
                    let end_idx = arm_starts.get(ai + 1).copied().unwrap_or(lines.len());
                    let arm_hdr = &body[lines[start_idx].code_lo..lines[start_idx].code_hi];
                    let Some(after_case) = arm_hdr.strip_prefix("case ") else {
                        continue;
                    };
                    let Some((_, inline_body)) = split_case_arm(after_case) else {
                        continue;
                    };
                    let arm_hi = lines[end_idx - 1].code_hi;
                    if !inline_body.is_empty() {
                        let (inline_lo, _) = subslice_span(body, inline_body);
                        collect_return_leaf_spans(body, inline_lo, arm_hi, out);
                    } else if start_idx + 1 < end_idx {
                        collect_return_leaf_spans(body, lines[start_idx + 1].code_lo, arm_hi, out);
                    }
                }
                return;
            }
        } else if let Some((_, inline_arms)) = split_top_level_once(after_match, ':') {
            for arm in split_inline_case_arms(inline_arms) {
                if let Some((_, inline_body)) = split_case_arm(arm) {
                    if !inline_body.is_empty() {
                        let (sub_lo, sub_hi) = subslice_span(body, inline_body);
                        collect_return_leaf_spans(body, sub_lo, sub_hi, out);
                    }
                }
            }
            return;
        }
    }

    let sub = &body[span_lo..span_hi];

    // 3. \`if <cond>: <then> else: <else>\` (single-line or multi-line)
    if let Some(rest) = sub.strip_prefix("if ") {
        if let Some((before_else, after_else)) = split_matching_else(rest) {
            if let Some((_, then_b)) = split_top_level_once(before_else, ':') {
                let then_t = then_b.trim();
                if !then_t.is_empty() {
                    let (tlo, thi) = subslice_span(body, then_t);
                    collect_return_leaf_spans(body, tlo, thi, out);
                }
                let else_t = after_else.trim();
                if !else_t.is_empty() {
                    let (elo, ehi) = subslice_span(body, else_t);
                    collect_return_leaf_spans(body, elo, ehi, out);
                }
                return;
            }
        }
    }

    // 4. Single-line \`let <pat> = <val>; <body>\`
    if let Some(rest) = sub.strip_prefix("let ") {
        if let Some((_, rest_body)) = split_top_level_once(rest, ';') {
            let rest_t = rest_body.trim();
            if !rest_t.is_empty() {
                let (rlo, rhi) = subslice_span(body, rest_t);
                collect_return_leaf_spans(body, rlo, rhi, out);
                return;
            }
        }
    }

    // 5. Outer parentheses or type annotation \`(term)\` / \`(term : Type)\` (excluding tuples)
    if crate::emit::is_wrapped_in_parens(sub) {
        let inner = sub[1..sub.len() - 1].trim();
        if split_top_level(inner, ',').len() == 1 {
            let target = split_top_level_once(inner, ':')
                .map(|(term_part, _)| term_part.trim())
                .unwrap_or(inner);
            if !target.is_empty() {
                let (tlo, thi) = subslice_span(body, target);
                collect_return_leaf_spans(body, tlo, thi, out);
                return;
            }
        }
    }

    // 6. Base case: whole returned expression (including multi-line calls).
    out.push((span_lo, span_hi));
}

/// Byte spans of returned leaf expressions in \`body\`, preserving whole multi-line calls while
/// skipping \`let\` RHS bindings, \`match\` scrutinees, \`if\` conditions, and nested arguments.
fn return_leaf_spans(body: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    collect_return_leaf_spans(body, 0, body.len(), &mut spans);
    spans
}

fn format_inline_leaf(leaf: &str) -> String {
    let mut out = String::with_capacity(leaf.len());
    let mut pending_space = false;
    for ch in leaf.chars() {
        if ch.is_whitespace() {
            if !out.is_empty() && !out.ends_with('(') {
                pending_space = true;
            }
            continue;
        }
        if pending_space && !matches!(ch, ')' | ',') {
            out.push(' ');
        }
        pending_space = false;
        out.push(ch);
    }
    out
}

/// True when \`s\` is exactly one call of a user \`def\`: \`f(...)\` with balanced parentheses.
fn is_user_call_expr(s: &str, def_map: &HashMap<String, &Def>) -> bool {
    let Some(open) = s.find('(') else {
        return false;
    };
    def_map.contains_key(s[..open].trim())
        && s.ends_with(')')
        && find_matching_paren(&s[open..]) == Some(s.len() - 1 - open)
}

/// ReturnCtor: replaces a returned variable or user-function call with each constructor of
/// the function's \`Data\` return type (small filler fields), or with \`True{}\` / \`False{}\` for a
/// returned call in a \`Bool\` function. Catches laws guarded only by a fallthrough such as
/// \`case st _: st\` or a delegated classifier call (Issue #15).
fn mutate_return_ctor(
    def: &Def,
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
) -> Vec<(String, String)> {
    let ret = def.ret.trim();
    let body = def.body.as_str();
    let mut replacements: Vec<String> = Vec::new();
    let mut seen_variants = HashSet::new();
    let mut infos: Vec<&CtorInfo> = ctor_map.values().filter(|c| c.type_name == ret).collect();
    infos.sort_by(|a, b| a.variant_name.cmp(&b.variant_name));
    for info in infos {
        if !seen_variants.insert(info.variant_name.clone()) {
            continue;
        }
        let fields = info
            .field_types
            .iter()
            .map(|ft| filler_value(ft, ctor_map))
            .collect::<Option<Vec<_>>>();
        if let Some(fields) = fields {
            replacements.push(format!(
                "{}.{}{{{}}}",
                info.type_name,
                info.variant_name,
                fields.join(", ")
            ));
        }
    }
    let is_bool = ret == "Bool";
    if replacements.is_empty() && !is_bool {
        return Vec::new();
    }

    let mut out = Vec::new();
    for (start, end) in return_leaf_spans(body) {
        let leaf = &body[start..end];
        let is_call = is_user_call_expr(leaf, def_map);
        let candidates: Vec<String> = if is_bool {
            // Bare Bool variables are BoolConst's; ReturnCtor takes returned calls.
            if !is_call {
                continue;
            }
            vec!["True{}".to_string(), "False{}".to_string()]
        } else {
            if !is_call && !is_bare_var_ident(leaf, def_map, ctor_map) {
                continue;
            }
            replacements.clone()
        };
        let kind = if is_call { "call" } else { "variable" };
        let label = format_inline_leaf(leaf);
        for repl in candidates {
            out.push((
                replace_span(body, start, end, &repl),
                format!("returned {kind} '{label}' -> {repl}"),
            ));
        }
    }
    out
}

/// NatLit: changes a \`Nat\` literal \`k\` to \`0n\`, \`k + 1\`, and \`k - 1\` (at most
/// \`MAX_NAT_LIT_SITES_PER_DEF\` sites per function). All \`-> 0n\` mutants come first, so
/// "zero is rejected" laws guarded by a constant such as \`Nat.is_eq(width, 256n)\` are caught.
#[cfg(test)]
fn mutate_nat_lit(body: &str, protected: &[(usize, usize)]) -> Vec<(String, String)> {
    mutate_nat_lit_with_stats(body, protected).0
}

fn mutate_nat_lit_with_stats(
    body: &str,
    protected: &[(usize, usize)],
) -> (Vec<(String, String)>, usize) {
    let bytes = body.as_bytes();
    let is_ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut sites: Vec<(usize, usize, u64)> = Vec::new();
    let mut extra_site_mutants = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let starts = bytes[i].is_ascii_digit()
            && (i == 0 || !(is_ident(bytes[i - 1]) || bytes[i - 1] == b'.'));
        if !starts {
            i += 1;
            continue;
        }
        let mut end = i;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        let is_nat = end < bytes.len()
            && bytes[end] == b'n'
            && (end + 1 >= bytes.len() || !is_ident(bytes[end + 1]));
        if is_nat && !in_protected(i, protected) {
            if let Ok(k) = body[i..end].parse::<u64>() {
                if sites.len() < MAX_NAT_LIT_SITES_PER_DEF {
                    sites.push((i, end + 1, k));
                } else {
                    if k != 0 {
                        extra_site_mutants += 1;
                    }
                    if k.checked_add(1).is_some() {
                        extra_site_mutants += 1;
                    }
                    if k > 1 {
                        extra_site_mutants += 1;
                    }
                }
            }
        }
        i = end.max(i + 1);
    }

    let mut out = Vec::new();
    let mut push = |start: usize, end: usize, k: u64, to: u64| {
        if to != k {
            out.push((
                replace_span(body, start, end, &format!("{to}n")),
                format!("{k}n -> {to}n"),
            ));
        }
    };
    for &(s0, e0, k) in &sites {
        push(s0, e0, k, 0);
    }
    for &(s0, e0, k) in &sites {
        if let Some(up) = k.checked_add(1) {
            push(s0, e0, k, up);
        }
    }
    for &(s0, e0, k) in &sites {
        if k > 1 {
            push(s0, e0, k, k - 1);
        }
    }
    (out, extra_site_mutants)
}

fn is_bare_var_ident(
    s: &str,
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
) -> bool {
    !s.is_empty()
        && s.chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !matches!(s, "true" | "false" | "_")
        && !def_map.contains_key(s)
        && !ctor_map.contains_key(s)
}

/// BoolConst: replaces a \`Bool\` variable with \`True{}\` / \`False{}\`. Applies to every use of a
/// live \`Bool\` parameter, and to bare variables in returned positions of a \`Bool\` function, so
/// implication laws such as \`Bool.or(allowed(c), Bool.not(requires(c)))\` are caught.
fn mutate_bool_const(
    def: &Def,
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
    protected: &[(usize, usize)],
) -> Vec<(String, String)> {
    let body = def.body.as_str();
    let bytes = body.as_bytes();
    let mut targets: BTreeSet<(usize, usize)> = BTreeSet::new();

    // (a) Every use of a live Bool parameter outside pattern/header positions.
    let bool_params: HashSet<&str> = def
        .params
        .iter()
        .filter(|p| p.q != Quantity::Dead && p.ty.trim() == "Bool")
        .map(|p| p.name.as_str())
        .collect();
    if !bool_params.is_empty() {
        let mut i = 0usize;
        while i < bytes.len() {
            let starts_ident = (bytes[i].is_ascii_alphabetic() || bytes[i] == b'_')
                && (i == 0
                    || !(bytes[i - 1].is_ascii_alphanumeric()
                        || bytes[i - 1] == b'_'
                        || bytes[i - 1] == b'.'));
            if !starts_ident {
                i += 1;
                continue;
            }
            let mut end = i;
            while end < bytes.len()
                && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_' || bytes[end] == b'.')
            {
                end += 1;
            }
            let followed_by_call = end < bytes.len() && matches!(bytes[end], b'(' | b'{');
            if !in_protected(i, protected)
                && bool_params.contains(&body[i..end])
                && !followed_by_call
            {
                targets.insert((i, end));
            }
            i = end;
        }
    }

    // (b) Bare variables in returned positions of a Bool function: a whole body line that is
    // just an identifier, or the inline body of a \`case <pat>: <ident>\` arm.
    if def.ret.trim() == "Bool" {
        for (start, end) in return_leaf_spans(body) {
            if is_bare_var_ident(&body[start..end], def_map, ctor_map) {
                targets.insert((start, end));
            }
        }
    }

    let mut out = Vec::new();
    for (start, end) in targets {
        let var = &body[start..end];
        for repl in ["True{}", "False{}"] {
            out.push((
                replace_span(body, start, end, repl),
                format!("Bool variable '{var}' -> {repl}"),
            ));
        }
    }
    out
}

/// FlipCmp: replaces a comparison with its mirror (\`Nat.is_le\` <-> \`Nat.is_ge\`,
/// \`Nat.is_lt\` <-> \`Nat.is_gt\`, \`<=\` <-> \`>=\`, \`<\` <-> \`>\`). Unlike NatCmpArith's
/// \`<=\` -> \`<\` (which only tightens), this loosens strict refusals like
/// \`ok(1n + m, m) == False{}\`.
fn mutate_flip_cmp(body: &str, protected: &[(usize, usize)]) -> Vec<(String, String)> {
    let fn_flips: &[(&str, &str)] = &[
        ("Nat.is_le", "Nat.is_ge"),
        ("Nat.is_ge", "Nat.is_le"),
        ("Nat.is_lt", "Nat.is_gt"),
        ("Nat.is_gt", "Nat.is_lt"),
        ("Nat.lte", "Nat.gte"),
        ("Nat.gte", "Nat.lte"),
        ("Nat.le", "Nat.ge"),
        ("Nat.ge", "Nat.le"),
        ("Nat.lt", "Nat.gt"),
        ("Nat.gt", "Nat.lt"),
    ];
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if in_protected(i, protected) {
            i += 1;
            continue;
        }
        let prev_ident = i > 0
            && (bytes[i - 1].is_ascii_alphanumeric()
                || bytes[i - 1] == b'_'
                || bytes[i - 1] == b'.');
        if !prev_ident {
            let mut matched = false;
            for &(from, to) in fn_flips {
                if body[i..].starts_with(from) {
                    let end = i + from.len();
                    let next_ok = end == bytes.len()
                        || (!bytes[end].is_ascii_alphanumeric()
                            && bytes[end] != b'_'
                            && bytes[end] != b'.');
                    if next_ok {
                        out.push((replace_span(body, i, end, to), format!("{from} -> {to}")));
                        i = end;
                        matched = true;
                        break;
                    }
                }
            }
            if matched {
                continue;
            }
        }
        let two = body.get(i..i + 2).unwrap_or("");
        if two == "<=" || two == ">=" {
            let to = if two == "<=" { ">=" } else { "<=" };
            out.push((replace_span(body, i, i + 2, to), format!("{two} -> {to}")));
            i += 2;
            continue;
        }
        let prev = if i > 0 { bytes[i - 1] } else { b' ' };
        let next = bytes.get(i + 1).copied().unwrap_or(b' ');
        if bytes[i] == b'<' && next != b'=' && next != b'-' && prev.is_ascii_whitespace() {
            out.push((replace_span(body, i, i + 1, ">"), "< -> >".to_string()));
        } else if bytes[i] == b'>'
            && next != b'='
            && prev != b'-'
            && prev != b'='
            && prev.is_ascii_whitespace()
        {
            out.push((replace_span(body, i, i + 1, "<"), "> -> <".to_string()));
        }
        i += 1;
    }
    out
}

/// Computes byte ranges \`(start, end)\` in \`body\` that belong to pattern/header positions
/// (\`case <pat>:\`, \`match <scrut>:\`, \`let <pat> =\`) and must never be mutated.
fn compute_protected_ranges(body: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut offset = 0usize;

    for raw_line in body.split_inclusive('\\n') {
        let line = raw_line.strip_suffix('\\n').unwrap_or(raw_line);
        let trimmed = line.trim_start();
        let ws = line.len() - trimmed.len();
        let line_code_start = offset + ws;

        if trimmed.starts_with("case ") {
            if let Some((pat, _)) = split_case_arm(trimmed) {
                let pat_end = (pat.as_ptr() as usize) - (trimmed.as_ptr() as usize) + pat.len();
                let mut delim_end = line_code_start + pat_end;
                let after = &line[ws + pat_end..];
                if let Some(pos) = after.find("=>") {
                    delim_end = offset + ws + pat_end + pos + 2;
                } else if let Some(pos) = after.find(':') {
                    delim_end = offset + ws + pat_end + pos + 1;
                }
                ranges.push((offset, delim_end));
            } else {
                ranges.push((offset, offset + line.len()));
            }
        } else if trimmed.starts_with("match ") {
            if let Some((_, _)) = split_top_level_once(trimmed, ':') {
                if let Some(colon) = line.rfind(':') {
                    ranges.push((offset, offset + colon + 1));
                }
            }
        } else if trimmed.starts_with("let ") {
            if let Some(eq) = line.find('=') {
                ranges.push((offset, offset + eq + 1));
            }
        }

        offset += raw_line.len();
    }

    ranges
}

fn in_protected(pos: usize, ranges: &[(usize, usize)]) -> bool {
    ranges.iter().any(|&(s, e)| pos >= s && pos < e)
}

fn replace_span(s: &str, start: usize, end: usize, repl: &str) -> String {
    let mut out = String::with_capacity(s.len() + repl.len());
    out.push_str(&s[..start]);
    out.push_str(repl);
    out.push_str(&s[end..]);
    out
}

fn mutate_bool_flips(body: &str, protected: &[(usize, usize)]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        if in_protected(i, protected) {
            i += 1;
            continue;
        }
        let prev_ident = i > 0 && (bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
        if !prev_ident {
            for (needle, repl) in [
                ("True{}", "False{}"),
                ("False{}", "True{}"),
                ("true", "false"),
                ("false", "true"),
            ] {
                if body[i..].starts_with(needle) {
                    let end = i + needle.len();
                    let next_ident = end < bytes.len()
                        && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_');
                    if !next_ident || needle.ends_with('}') {
                        out.push((
                            replace_span(body, i, end, repl),
                            format!("{needle} -> {repl}"),
                        ));
                        i = end;
                        continue;
                    }
                }
            }
            if body[i..].starts_with("Bool.pick(") {
                let paren_start = i + "Bool.pick".len();
                if let Some(close_rel) = find_matching_paren(&body[paren_start..]) {
                    let close_abs = paren_start + close_rel;
                    let inner = &body[paren_start + 1..close_abs];
                    let args = split_top_level(inner, ',');
                    if args.len() == 3 {
                        let swapped = format!("Bool.pick({}, {}, {})", args[0], args[2], args[1]);
                        out.push((
                            replace_span(body, i, close_abs + 1, &swapped),
                            "Bool.pick branches swapped".to_string(),
                        ));
                    } else if args.len() == 4 {
                        let swapped = format!(
                            "Bool.pick({}, {}, {}, {})",
                            args[0], args[1], args[3], args[2]
                        );
                        out.push((
                            replace_span(body, i, close_abs + 1, &swapped),
                            "Bool.pick branches swapped".to_string(),
                        ));
                    }
                }
            }
        }
        i += 1;
    }

    out
}

fn mutate_nat_ops(body: &str, protected: &[(usize, usize)]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0usize;

    let fn_swaps: &[(&str, &[&str])] = &[
        ("Nat.is_le", &["Nat.is_lt"]),
        ("Nat.is_lt", &["Nat.is_le"]),
        ("Nat.le", &["Nat.lt"]),
        ("Nat.lte", &["Nat.lt"]),
        ("Nat.lt", &["Nat.le"]),
        ("Nat.is_ge", &["Nat.is_gt"]),
        ("Nat.is_gt", &["Nat.is_ge"]),
        ("Nat.ge", &["Nat.gt"]),
        ("Nat.gte", &["Nat.gt"]),
        ("Nat.gt", &["Nat.ge"]),
        ("Nat.is_eq", &["Nat.is_ne"]),
        ("Nat.is_ne", &["Nat.is_eq"]),
        ("Nat.eq", &["Nat.ne"]),
        ("Nat.ne", &["Nat.eq"]),
        ("Nat.equal", &["Nat.is_ne"]),
        ("Nat.add", &["Nat.sub", "Nat.mul"]),
        ("Nat.sub", &["Nat.add"]),
        ("Nat.mul", &["Nat.add"]),
        ("Nat.min", &["Nat.max"]),
        ("Nat.max", &["Nat.min"]),
        ("Nat.succ", &["Nat.pred"]),
        ("Nat.pred", &["Nat.succ"]),
        ("Nat.div", &["Nat.mod"]),
    ];

    while i < bytes.len() {
        if in_protected(i, protected) {
            i += 1;
            continue;
        }
        let prev_ident = i > 0
            && (bytes[i - 1].is_ascii_alphanumeric()
                || bytes[i - 1] == b'_'
                || bytes[i - 1] == b'.');
        if !prev_ident {
            let mut matched_fn = false;
            for &(from, tos) in fn_swaps {
                if body[i..].starts_with(from) {
                    let end = i + from.len();
                    let next_ok = end == bytes.len()
                        || (!bytes[end].is_ascii_alphanumeric()
                            && bytes[end] != b'_'
                            && bytes[end] != b'.');
                    if next_ok {
                        for &to in tos {
                            out.push((replace_span(body, i, end, to), format!("{from} -> {to}")));
                        }
                        i = end;
                        matched_fn = true;
                        break;
                    }
                }
            }
            if matched_fn {
                continue;
            }
        }

        // Infix comparison and additive operators (avoiding ->, =>, {==}, and 1n+x Nat literals)
        let two = if i + 1 < bytes.len() {
            &body[i..i + 2]
        } else {
            ""
        };
        if two == "<=" {
            out.push((replace_span(body, i, i + 2, "<"), "<= -> <".to_string()));
            i += 2;
            continue;
        }
        if two == ">=" {
            out.push((replace_span(body, i, i + 2, ">"), ">= -> >".to_string()));
            i += 2;
            continue;
        }
        if two == "==" {
            let in_refl =
                i > 0 && bytes[i - 1] == b'{' && i + 2 < bytes.len() && bytes[i + 2] == b'}';
            if !in_refl {
                out.push((replace_span(body, i, i + 2, "!="), "== -> !=".to_string()));
            }
            i += 2;
            continue;
        }
        if two == "!=" {
            out.push((replace_span(body, i, i + 2, "=="), "!= -> ==".to_string()));
            i += 2;
            continue;
        }
        if bytes[i] == b'<' && (i + 1 >= bytes.len() || bytes[i + 1] != b'=') {
            out.push((replace_span(body, i, i + 1, "<="), "< -> <=".to_string()));
            i += 1;
            continue;
        }
        if bytes[i] == b'>'
            && (i + 1 >= bytes.len() || bytes[i + 1] != b'=')
            && (i == 0 || (bytes[i - 1] != b'-' && bytes[i - 1] != b'='))
        {
            out.push((replace_span(body, i, i + 1, ">="), "> -> >=".to_string()));
            i += 1;
            continue;
        }
        if bytes[i] == b'+' && i > 0 && bytes[i - 1].is_ascii_whitespace() {
            out.push((replace_span(body, i, i + 1, "-"), "+ -> -".to_string()));
            i += 1;
            continue;
        }
        if bytes[i] == b'-'
            && (i + 1 >= bytes.len() || bytes[i + 1] != b'>')
            && i > 0
            && bytes[i - 1].is_ascii_whitespace()
            && i + 1 < bytes.len()
            && bytes[i + 1].is_ascii_whitespace()
        {
            out.push((replace_span(body, i, i + 1, "+"), "- -> +".to_string()));
            i += 1;
            continue;
        }

        i += 1;
    }

    out
}

fn mutate_drop_bool_operand(body: &str, protected: &[(usize, usize)]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        if in_protected(i, protected) {
            i += 1;
            continue;
        }
        for fname in ["Bool.and(", "Bool.or("] {
            if body[i..].starts_with(fname) {
                let prev_ident =
                    i > 0 && (bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
                if !prev_ident {
                    let paren_start = i + fname.len() - 1;
                    if let Some(close_rel) = find_matching_paren(&body[paren_start..]) {
                        let close_abs = paren_start + close_rel;
                        let inner = &body[paren_start + 1..close_abs];
                        let args = split_top_level(inner, ',');
                        if args.len() == 2 {
                            let op_name = fname.trim_end_matches('(');
                            out.push((
                                replace_span(body, i, close_abs + 1, &format!("({})", args[0])),
                                format!("{op_name} dropped right operand"),
                            ));
                            out.push((
                                replace_span(body, i, close_abs + 1, &format!("({})", args[1])),
                                format!("{op_name} dropped left operand"),
                            ));
                        }
                    }
                }
            }
        }
        i += 1;
    }

    // Also handle top-level infix \`&&\` / \`||\` on single-line expressions
    for op in ["&&", "||"] {
        let trimmed = body.trim();
        if !trimmed.contains('\\n') {
            if let Some((lhs, rhs)) = crate::emit::split_top_level_str(trimmed, op) {
                out.push((lhs.to_string(), format!("{op} dropped right operand")));
                out.push((rhs.to_string(), format!("{op} dropped left operand")));
            }
        }
    }

    out
}

fn mutate_return_unchanged(
    def: &Def,
    ctor_map: &HashMap<String, CtorInfo>,
) -> Vec<(String, String)> {
    let mut out = Vec::new();

    // 4a. Whole-function identity return of a parameter with matching return type
    for p in &def.params {
        if p.q != Quantity::Dead && p.ty.trim() == def.ret.trim() && def.body.trim() != p.name {
            out.push((
                p.name.clone(),
                format!("return parameter '{}' unchanged", p.name),
            ));
        }
    }

    // 4b. Inside match arms, return a matched constructor unchanged when it produces def.ret
    let lines: Vec<&str> = def.body.lines().collect();
    let mut i = 0usize;
    while i < lines.len() {
        let trimmed = lines[i].trim();
        if let Some(after_case) = trimmed.strip_prefix("case ") {
            if let Some((pat_raw, inline_body)) = split_case_arm(after_case) {
                let case_indent = leading_indent(lines[i]);
                if let Some(ctor_expr) =
                    reconstruct_ctor_pattern_expr(pat_raw.trim(), &def.ret, ctor_map)
                {
                    if !inline_body.is_empty() {
                        if inline_body.trim() != ctor_expr {
                            let sep = if after_case.contains("=>") { "=>" } else { ":" };
                            let mut new_lines: Vec<String> =
                                lines.iter().map(|l| (*l).to_string()).collect();
                            let indent_str = &lines[i][..lines[i].len() - trimmed.len()];
                            new_lines[i] = format!("{indent_str}case {pat_raw} {sep} {ctor_expr}");
                            out.push((
                                new_lines.join("\\n"),
                                format!("return '{ctor_expr}' unchanged"),
                            ));
                        }
                    } else {
                        let mut end_idx = i + 1;
                        while end_idx < lines.len() {
                            let t = lines[end_idx].trim();
                            if !t.is_empty() && leading_indent(lines[end_idx]) <= case_indent {
                                break;
                            }
                            end_idx += 1;
                        }
                        let arm_body_str = lines[i + 1..end_idx].join("\\n");
                        if arm_body_str.trim() != ctor_expr && end_idx > i + 1 {
                            let mut new_lines: Vec<String> = Vec::new();
                            new_lines.extend(lines[..=i].iter().map(|l| (*l).to_string()));
                            let body_indent =
                                format!("{}  ", &lines[i][..lines[i].len() - trimmed.len()]);
                            new_lines.push(format!("{body_indent}{ctor_expr}"));
                            new_lines.extend(lines[end_idx..].iter().map(|l| (*l).to_string()));
                            out.push((
                                new_lines.join("\\n"),
                                format!("return '{ctor_expr}' unchanged"),
                            ));
                        }
                    }
                }
            }
        }
        i += 1;
    }

    out
}

fn reconstruct_ctor_pattern_expr(
    pat: &str,
    ret_ty: &str,
    ctor_map: &HashMap<String, CtorInfo>,
) -> Option<String> {
    let open = pat.find('{')?;
    if !pat.ends_with('}') {
        return None;
    }
    let head = pat[..open].trim();
    let info = ctor_map.get(head)?;
    if info.type_name != ret_ty.trim() {
        return None;
    }
    let inner = pat[open + 1..pat.len() - 1].trim();
    if inner.is_empty() {
        return Some(format!("{head}{{}}"));
    }
    let mut fields = Vec::new();
    for part in split_top_level(inner, ',') {
        let clean = part
            .trim()
            .trim_start_matches('+')
            .trim_start_matches('-')
            .trim();
        let var = if let Some((_, v)) = clean.split_once(':') {
            v.trim()
                .trim_start_matches('+')
                .trim_start_matches('-')
                .trim()
        } else {
            clean
        };
        if var == "_"
            || var.is_empty()
            || !var.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            || var.chars().next().is_some_and(|c| c.is_ascii_digit())
        {
            return None;
        }
        fields.push(var.to_string());
    }
    Some(format!("{head}{{{}}}", fields.join(", ")))
}

struct ArmSlice {
    case_line: usize,
    end_line: usize, // exclusive
    pat: String,
    inline_sep: Option<&'static str>, // Some(":") or Some("=>") if inline body
    body_text: String,
}

fn mutate_swap_match_arms(
    def: &Def,
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let lines: Vec<&str> = def.body.lines().collect();

    for m_idx in 0..lines.len() {
        let m_trim = lines[m_idx].trim();
        if !m_trim.starts_with("match ") || !m_trim.ends_with(':') {
            continue;
        }
        let m_indent = leading_indent(lines[m_idx]);
        let Some(first_case) = (m_idx + 1..lines.len()).find(|&idx| {
            let t = lines[idx].trim();
            !t.is_empty() && leading_indent(lines[idx]) > m_indent && t.starts_with("case ")
        }) else {
            continue;
        };
        let case_indent = leading_indent(lines[first_case]);

        // Determine the end of this match block
        let mut match_end = lines.len();
        for (idx, line) in lines.iter().enumerate().skip(m_idx + 1) {
            let t = line.trim();
            if !t.is_empty() && leading_indent(line) <= m_indent {
                match_end = idx;
                break;
            }
        }

        let mut arm_starts = Vec::new();
        for (idx, line) in lines.iter().enumerate().take(match_end).skip(first_case) {
            let t = line.trim();
            if !t.is_empty() && leading_indent(line) == case_indent && t.starts_with("case ") {
                arm_starts.push(idx);
            }
        }
        if arm_starts.len() < 2 {
            continue;
        }

        let mut arms = Vec::new();
        for (ai, &start) in arm_starts.iter().enumerate() {
            let end = arm_starts.get(ai + 1).copied().unwrap_or(match_end);
            let after_case = lines[start].trim().strip_prefix("case ").unwrap().trim();
            let Some((pat_raw, inline_body)) = split_case_arm(after_case) else {
                continue;
            };
            if !inline_body.is_empty() && end == start + 1 {
                let sep = if after_case.contains("=>") { "=>" } else { ":" };
                arms.push(ArmSlice {
                    case_line: start,
                    end_line: end,
                    pat: pat_raw.trim().to_string(),
                    inline_sep: Some(sep),
                    body_text: inline_body.trim().to_string(),
                });
            } else {
                let mut body_lines = Vec::new();
                if !inline_body.is_empty() {
                    let indent = format!(
                        "{}  ",
                        &lines[start][..lines[start].len() - lines[start].trim_start().len()]
                    );
                    body_lines.push(format!("{indent}{}", inline_body.trim()));
                }
                for &l in &lines[start + 1..end] {
                    body_lines.push(l.to_string());
                }
                arms.push(ArmSlice {
                    case_line: start,
                    end_line: end,
                    pat: pat_raw.trim().to_string(),
                    inline_sep: None,
                    body_text: body_lines.join("\\n"),
                });
            }
        }

        for i in 0..arms.len() {
            for j in i + 1..arms.len() {
                if arms[i].body_text.trim() == arms[j].body_text.trim() {
                    continue;
                }
                if !arms_binder_compatible(&arms[i], &arms[j], def, def_map, ctor_map) {
                    continue;
                }
                if let Some(swapped) = rebuild_with_swapped_arms(&lines, &arms[i], &arms[j]) {
                    out.push((
                        swapped,
                        format!("swap match arms '{}' and '{}'", arms[i].pat, arms[j].pat),
                    ));
                }
            }
        }
    }

    out
}

fn arms_binder_compatible(
    a: &ArmSlice,
    b: &ArmSlice,
    def: &Def,
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
) -> bool {
    let param_names: HashSet<String> = def.params.iter().map(|p| p.name.clone()).collect();
    let binds_a = extract_pattern_binders(&a.pat, ctor_map);
    let binds_b = extract_pattern_binders(&b.pat, ctor_map);

    let tokens_a: HashSet<String> = lock::tokenize_bend(&a.body_text)
        .into_iter()
        .filter(|t| !def_map.contains_key(t) && !ctor_map.contains_key(t))
        .collect();
    let tokens_b: HashSet<String> = lock::tokenize_bend(&b.body_text)
        .into_iter()
        .filter(|t| !def_map.contains_key(t) && !ctor_map.contains_key(t))
        .collect();

    for var in &binds_a {
        if !param_names.contains(var) && tokens_a.contains(var) && !binds_b.contains(var) {
            return false;
        }
    }
    for var in &binds_b {
        if !param_names.contains(var) && tokens_b.contains(var) && !binds_a.contains(var) {
            return false;
        }
    }
    true
}

fn extract_pattern_binders(pat: &str, ctor_map: &HashMap<String, CtorInfo>) -> HashSet<String> {
    let mut binders = HashSet::new();
    for tok in lock::tokenize_bend(pat) {
        if matches!(
            tok.as_str(),
            "_" | "true" | "false" | "True" | "False" | "Unit"
        ) || ctor_map.contains_key(&tok)
        {
            continue;
        }
        let first = tok.chars().next();
        if first.is_some_and(|c| c.is_ascii_lowercase() || c == '_')
            && tok.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            binders.insert(tok);
        }
    }
    binders
}

fn rebuild_with_swapped_arms(lines: &[&str], a: &ArmSlice, b: &ArmSlice) -> Option<String> {
    let mut result: Vec<String> = Vec::new();
    let mut idx = 0usize;
    while idx < lines.len() {
        if idx == a.case_line {
            emit_arm_with_body(lines, a, &b.body_text, &mut result);
            idx = a.end_line;
        } else if idx == b.case_line {
            emit_arm_with_body(lines, b, &a.body_text, &mut result);
            idx = b.end_line;
        } else {
            result.push(lines[idx].to_string());
            idx += 1;
        }
    }
    Some(result.join("\\n"))
}

fn emit_arm_with_body(lines: &[&str], target: &ArmSlice, new_body: &str, out: &mut Vec<String>) {
    let line = lines[target.case_line];
    let ws_len = line.len() - line.trim_start().len();
    let indent = &line[..ws_len];
    if let Some(sep) = target.inline_sep {
        if !new_body.contains('\\n') {
            out.push(format!(
                "{indent}case {} {sep} {}",
                target.pat,
                new_body.trim()
            ));
            return;
        }
    }
    out.push(format!("{indent}case {}:", target.pat));
    let body_indent = format!("{indent}  ");
    for bl in new_body.lines() {
        if bl.trim().is_empty() {
            continue;
        }
        if bl.starts_with(' ') || bl.starts_with('\\t') {
            out.push(bl.to_string());
        } else {
            out.push(format!("{body_indent}{}", bl.trim()));
        }
    }
}

fn find_matching_paren(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(idx);
                }
            }
            _ => {}
        }
    }
    None
}

fn precompute_def_callees<'a>(
    defs: &'a [Def],
    def_map: &HashMap<String, &'a Def>,
) -> HashMap<&'a str, Vec<&'a str>> {
    let mut map = HashMap::with_capacity(defs.len());
    for def in defs {
        let mut callees = Vec::new();
        let mut seen = HashSet::new();
        for tok in lock::tokenize_bend(&def.body) {
            if let Some(target) = def_map.get(&tok) {
                if seen.insert(target.name.as_str()) {
                    callees.push(target.name.as_str());
                }
            }
        }
        map.insert(def.name.as_str(), callees);
    }
    map
}

fn law_dependency_cone_fast<'a>(
    law: &ParsedLaw,
    def_map: &HashMap<String, &'a Def>,
    def_callees: &HashMap<&'a str, Vec<&'a str>>,
) -> Vec<String> {
    let mut visited = BTreeSet::new();
    let mut queue = VecDeque::new();
    for expr in std::iter::once(law.lhs.as_str())
        .chain(std::iter::once(law.rhs.as_str()))
        .chain(
            law.hypotheses
                .iter()
                .flat_map(|h| [h.lhs.as_str(), h.rhs.as_str()]),
        )
    {
        for tok in lock::tokenize_bend(expr) {
            if let Some(def) = def_map.get(&tok) {
                if visited.insert(def.name.clone()) {
                    queue.push_back(def.name.as_str());
                }
            }
        }
    }
    while let Some(name) = queue.pop_front() {
        if let Some(callees) = def_callees.get(name) {
            for &callee in callees {
                if visited.insert(callee.to_string()) {
                    queue.push_back(callee);
                }
            }
        }
    }
    visited.into_iter().collect()
}

fn compute_types_hash(types: &[TypeDef]) -> String {
    let mut sorted_types: Vec<&TypeDef> = types.iter().collect();
    sorted_types.sort_by(|a, b| a.name.cmp(&b.name));
    let mut buf = Vec::new();
    for td in sorted_types {
        buf.extend_from_slice(td.name.as_bytes());
        buf.push(0);
        for v in &td.variants {
            buf.extend_from_slice(v.name.as_bytes());
            for ft in &v.field_types {
                buf.push(b',');
                buf.extend_from_slice(ft.as_bytes());
            }
            buf.push(0);
        }
    }
    lock::fnv1a_hex(&buf)
}

fn precompute_def_hashes(defs: &[Def]) -> HashMap<&str, String> {
    let mut out = HashMap::with_capacity(defs.len());
    for def in defs {
        let mut buf = Vec::new();
        buf.extend_from_slice(def.name.as_bytes());
        buf.push(0);
        for p in &def.params {
            buf.extend_from_slice(p.name.as_bytes());
            buf.push(b':');
            buf.extend_from_slice(p.ty.as_bytes());
            buf.push(0);
        }
        buf.extend_from_slice(def.ret.as_bytes());
        buf.push(0);
        buf.push(u8::from(def.total));
        buf.push(0);
        buf.extend_from_slice(def.body.as_bytes());
        buf.push(0);
        out.insert(def.name.as_str(), lock::fnv1a_hex(&buf));
    }
    out
}

fn compute_cone_hash_fast(
    law: &ParsedLaw,
    cone: &[String],
    types_hash: &str,
    def_hashes: &HashMap<&str, String>,
) -> String {
    let mut buf = Vec::new();
    buf.extend_from_slice(b"rb-mutate-");
    buf.extend_from_slice(MUTATE_CACHE_VERSION.as_bytes());
    buf.push(0);
    buf.extend_from_slice(crate::BUILDER_HASH.as_bytes());
    buf.push(0);
    buf.extend_from_slice(law.name.as_bytes());
    buf.push(0);
    for v in &law.vars {
        buf.extend_from_slice(v.name.as_bytes());
        buf.push(b':');
        buf.extend_from_slice(v.ty.as_bytes());
        buf.push(0);
    }
    for h in &law.hypotheses {
        buf.extend_from_slice(h.lhs.as_bytes());
        buf.extend_from_slice(b"==");
        buf.extend_from_slice(h.rhs.as_bytes());
        buf.push(0);
    }
    buf.extend_from_slice(law.lhs.as_bytes());
    buf.extend_from_slice(b"==");
    buf.extend_from_slice(law.rhs.as_bytes());
    buf.push(b':');
    buf.extend_from_slice(law.eq_ty.as_bytes());
    buf.push(0);
    buf.extend_from_slice(types_hash.as_bytes());
    buf.push(0);
    for name in cone {
        if let Some(h) = def_hashes.get(name.as_str()) {
            buf.extend_from_slice(name.as_bytes());
            buf.push(b'=');
            buf.extend_from_slice(h.as_bytes());
            buf.push(0);
        }
    }
    lock::fnv1a_hex(&buf)
}

#[derive(Debug, Clone)]
enum MutateCacheEntry {
    First {
        total_mutants: usize,
        generated_mutants: usize,
        dropped_by_budget: usize,
        dropped_by_site_cap: usize,
        caught_by: Option<(String, String)>,
        survived_operators: Vec<String>,
        skipped_reason: Option<String>,
    },
    Full {
        total_mutants: usize,
        generated_mutants: usize,
        dropped_by_budget: usize,
        dropped_by_site_cap: usize,
        outcomes: Vec<MutantOutcome>,
        skipped_reason: Option<String>,
    },
}

fn cache_entry_from_report(report: &LawMutationReport, full_report: bool) -> MutateCacheEntry {
    if full_report {
        MutateCacheEntry::Full {
            total_mutants: report.total_mutants,
            generated_mutants: report.generated_mutants,
            dropped_by_budget: report.dropped_by_budget,
            dropped_by_site_cap: report.dropped_by_site_cap,
            outcomes: report.mutant_outcomes.clone(),
            skipped_reason: report.skipped_reason.clone(),
        }
    } else {
        MutateCacheEntry::First {
            total_mutants: report.total_mutants,
            generated_mutants: report.generated_mutants,
            dropped_by_budget: report.dropped_by_budget,
            dropped_by_site_cap: report.dropped_by_site_cap,
            caught_by: report.caught_by.clone(),
            survived_operators: report.survived_operators.clone(),
            skipped_reason: report.skipped_reason.clone(),
        }
    }
}

fn report_from_cache(
    item: &PreparedLaw<'_>,
    entry: &MutateCacheEntry,
    full_report: bool,
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
) -> Option<LawMutationReport> {
    match entry {
        MutateCacheEntry::Full {
            total_mutants,
            generated_mutants,
            dropped_by_budget,
            dropped_by_site_cap,
            outcomes,
            skipped_reason,
        } => {
            let caught_by = outcomes.iter().find_map(|o| match &o.status {
                MutantStatus::Caught(ce) => Some((o.description.clone(), ce.clone())),
                _ => None,
            });
            let survived_operators: Vec<String> = outcomes
                .iter()
                .map(|o| o.operator.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            Some(LawMutationReport {
                law_name: item.law.name.clone(),
                cone: item.cone.clone(),
                total_mutants: *total_mutants,
                generated_mutants: *generated_mutants,
                dropped_by_budget: *dropped_by_budget,
                dropped_by_site_cap: *dropped_by_site_cap,
                caught_by,
                survived_operators,
                mutant_outcomes: if full_report {
                    outcomes.clone()
                } else {
                    Vec::new()
                },
                skipped_reason: skipped_reason.clone(),
                from_cache: true,
            })
        }
        MutateCacheEntry::First {
            total_mutants,
            generated_mutants,
            dropped_by_budget,
            dropped_by_site_cap,
            caught_by,
            survived_operators,
            skipped_reason,
        } => {
            if full_report {
                if skipped_reason.is_some() {
                    return Some(LawMutationReport {
                        law_name: item.law.name.clone(),
                        cone: item.cone.clone(),
                        total_mutants: *total_mutants,
                        generated_mutants: *generated_mutants,
                        dropped_by_budget: *dropped_by_budget,
                        dropped_by_site_cap: *dropped_by_site_cap,
                        caught_by: None,
                        survived_operators: Vec::new(),
                        mutant_outcomes: Vec::new(),
                        skipped_reason: skipped_reason.clone(),
                        from_cache: true,
                    });
                }
                if caught_by.is_none() {
                    let generated =
                        generate_mutants_for_cone_with_stats(&item.cone_defs, def_map, ctor_map);
                    let outcomes = generated
                        .mutants
                        .into_iter()
                        .map(|m| MutantOutcome {
                            def_name: m.def_name,
                            operator: m.operator,
                            description: m.description,
                            status: MutantStatus::Survived,
                        })
                        .collect();
                    return Some(LawMutationReport {
                        law_name: item.law.name.clone(),
                        cone: item.cone.clone(),
                        total_mutants: *total_mutants,
                        generated_mutants: *generated_mutants,
                        dropped_by_budget: *dropped_by_budget,
                        dropped_by_site_cap: *dropped_by_site_cap,
                        caught_by: None,
                        survived_operators: survived_operators.clone(),
                        mutant_outcomes: outcomes,
                        skipped_reason: None,
                        from_cache: true,
                    });
                }
                // \`First::Caught\` must be upgraded to \`Full\` under \`Report\` mode.
                return None;
            }
            Some(LawMutationReport {
                law_name: item.law.name.clone(),
                cone: item.cone.clone(),
                total_mutants: *total_mutants,
                generated_mutants: *generated_mutants,
                dropped_by_budget: *dropped_by_budget,
                dropped_by_site_cap: *dropped_by_site_cap,
                caught_by: caught_by.clone(),
                survived_operators: survived_operators.clone(),
                mutant_outcomes: Vec::new(),
                skipped_reason: skipped_reason.clone(),
                from_cache: true,
            })
        }
    }
}

fn load_mutate_cache(path: &Path) -> BTreeMap<String, MutateCacheEntry> {
    let mut map = BTreeMap::new();
    let Ok(raw) = fs::read_to_string(path) else {
        return map;
    };
    let mut current_full_key: Option<String> = None;
    for line in raw.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("\\tM\\t") {
            let Some(ref key) = current_full_key else {
                continue;
            };
            let parts: Vec<&str> = rest.splitn(5, '\\t').collect();
            if parts.len() == 5 {
                let status = match parts[3] {
                    "CAUGHT" => MutantStatus::Caught(parts[4].to_string()),
                    "SURVIVED" => MutantStatus::Survived,
                    _ => continue,
                };
                if let Some(MutateCacheEntry::Full { outcomes, .. }) = map.get_mut(key) {
                    outcomes.push(MutantOutcome {
                        def_name: parts[0].to_string(),
                        operator: parts[1].to_string(),
                        description: parts[2].to_string(),
                        status,
                    });
                }
            }
            continue;
        }
        current_full_key = None;
        let parts: Vec<&str> = line.split('\\t').collect();
        if parts.len() < 7 {
            continue;
        }
        let key = parts[0].to_string();
        let Ok(total_mutants) = parts[3].parse::<usize>() else {
            continue;
        };
        let Ok(generated_mutants) = parts[4].parse::<usize>() else {
            continue;
        };
        let Ok(dropped_by_budget) = parts[5].parse::<usize>() else {
            continue;
        };
        let Ok(dropped_by_site_cap) = parts[6].parse::<usize>() else {
            continue;
        };
        match (parts[1], parts[2]) {
            ("FIRST", "CAUGHT") if parts.len() >= 9 => {
                map.insert(
                    key,
                    MutateCacheEntry::First {
                        total_mutants,
                        generated_mutants,
                        dropped_by_budget,
                        dropped_by_site_cap,
                        caught_by: Some((parts[7].to_string(), parts[8..].join("\\t"))),
                        survived_operators: Vec::new(),
                        skipped_reason: None,
                    },
                );
            }
            ("FIRST", "SURVIVED") => {
                let ops = parts
                    .get(7)
                    .map(|s| {
                        s.split(',')
                            .map(str::trim)
                            .filter(|x| !x.is_empty())
                            .map(ToOwned::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                map.insert(
                    key,
                    MutateCacheEntry::First {
                        total_mutants,
                        generated_mutants,
                        dropped_by_budget,
                        dropped_by_site_cap,
                        caught_by: None,
                        survived_operators: ops,
                        skipped_reason: None,
                    },
                );
            }
            ("FIRST", "SKIPPED") if parts.len() >= 8 => {
                map.insert(
                    key,
                    MutateCacheEntry::First {
                        total_mutants,
                        generated_mutants,
                        dropped_by_budget,
                        dropped_by_site_cap,
                        caught_by: None,
                        survived_operators: Vec::new(),
                        skipped_reason: Some(parts[7..].join("\\t")),
                    },
                );
            }
            ("FULL", "SKIPPED") if parts.len() >= 8 => {
                map.insert(
                    key,
                    MutateCacheEntry::Full {
                        total_mutants,
                        generated_mutants,
                        dropped_by_budget,
                        dropped_by_site_cap,
                        outcomes: Vec::new(),
                        skipped_reason: Some(parts[7..].join("\\t")),
                    },
                );
            }
            ("FULL", "DONE") => {
                current_full_key = Some(key.clone());
                map.insert(
                    key,
                    MutateCacheEntry::Full {
                        total_mutants,
                        generated_mutants,
                        dropped_by_budget,
                        dropped_by_site_cap,
                        outcomes: Vec::new(),
                        skipped_reason: None,
                    },
                );
            }
            _ => {}
        }
    }
    map
}

fn save_mutate_cache(path: &Path, map: &BTreeMap<String, MutateCacheEntry>) -> Result<(), String> {
    let mut lines = vec![format!("# rb-mutate-cache-{MUTATE_CACHE_VERSION}")];
    for (k, entry) in map {
        match entry {
            MutateCacheEntry::First {
                total_mutants,
                generated_mutants,
                dropped_by_budget,
                dropped_by_site_cap,
                caught_by,
                survived_operators,
                skipped_reason,
            } => {
                if let Some(reason) = skipped_reason {
                    lines.push(format!(
                        "{k}\\tFIRST\\tSKIPPED\\t{total_mutants}\\t{generated_mutants}\\t{dropped_by_budget}\\t{dropped_by_site_cap}\\t{}",
                        sanitize_cache_field(reason)
                    ));
                } else if let Some((desc, ce)) = caught_by {
                    lines.push(format!(
                        "{k}\\tFIRST\\tCAUGHT\\t{total_mutants}\\t{generated_mutants}\\t{dropped_by_budget}\\t{dropped_by_site_cap}\\t{}\\t{}",
                        sanitize_cache_field(desc),
                        sanitize_cache_field(ce)
                    ));
                } else {
                    lines.push(format!(
                        "{k}\\tFIRST\\tSURVIVED\\t{total_mutants}\\t{generated_mutants}\\t{dropped_by_budget}\\t{dropped_by_site_cap}\\t{}",
                        sanitize_cache_field(&survived_operators.join(","))
                    ));
                }
            }
            MutateCacheEntry::Full {
                total_mutants,
                generated_mutants,
                dropped_by_budget,
                dropped_by_site_cap,
                outcomes,
                skipped_reason,
            } => {
                if let Some(reason) = skipped_reason {
                    lines.push(format!(
                        "{k}\\tFULL\\tSKIPPED\\t{total_mutants}\\t{generated_mutants}\\t{dropped_by_budget}\\t{dropped_by_site_cap}\\t{}",
                        sanitize_cache_field(reason)
                    ));
                } else {
                    lines.push(format!(
                        "{k}\\tFULL\\tDONE\\t{total_mutants}\\t{generated_mutants}\\t{dropped_by_budget}\\t{dropped_by_site_cap}"
                    ));
                    for o in outcomes {
                        let (kind, extra) = match &o.status {
                            MutantStatus::Caught(ce) => ("CAUGHT", sanitize_cache_field(ce)),
                            MutantStatus::Survived => ("SURVIVED", String::new()),
                            MutantStatus::BuildError(_) => continue,
                        };
                        lines.push(format!(
                            "\\tM\\t{}\\t{}\\t{}\\t{kind}\\t{extra}",
                            sanitize_cache_field(&o.def_name),
                            sanitize_cache_field(&o.operator),
                            sanitize_cache_field(&o.description)
                        ));
                    }
                }
            }
        }
    }
    fs::write(path, format!("{}\\n", lines.join("\\n"))).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::law_test::law_dependency_cone;

    static MSEQ: AtomicUsize = AtomicUsize::new(0);

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let n = MSEQ.fetch_add(1, Ordering::SeqCst);
        let dir = env::temp_dir().join(format!("rb_mutate_{tag}_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_vacuous_laws_with_e_law_vacuous_and_skips_lock_write() {
        let dir = tmp_dir("vacuous");
        let core = dir.join("core.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let src = r#"import Base

def f(+x: Nat) -> Nat:
  Nat.add(x, 1n)

# promise: reflexive identity test fixture
law f_reflexive:
  for +x: Nat
  {f(x) == f(x) : Nat}
"#;
        fs::write(&core, src).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        let err = run_mutation_checks(src, &report, MutateMode::NewOnly, &out_dir)
            .expect_err("vacuous law {f(x) == f(x)} must fail mutation check");
        assert!(err.contains("E_LAW_VACUOUS"), "got: {err}");
        assert!(err.contains("f_reflexive"), "got: {err}");
        assert!(!lock_file.exists(), "lock must not be written on failure");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn passes_conservation_law_against_real_bend_and_caches_result() {
        let dir = tmp_dir("conserved");
        let core = dir.join("core.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let src = r#"import Base

type Bin is Data:
  Bin{alloc: Nat, free: Nat}

def bin_capacity(+p: Bin) -> Nat:
  match p:
    case Bin{alloc, free}:
      Nat.add(alloc, free)

def bin_take_if(+alloc: Nat, +free: Nat, +req: Nat, ok: Bool) -> Bin:
  match ok:
    case True{}:
      Bin{Nat.add(alloc, req), Nat.sub(free, req)}
    case False{}:
      Bin{alloc, free}

def bin_take(+p: Bin, +req: Nat) -> Bin:
  match p:
    case Bin{alloc, +free}:
      bin_take_if(alloc, free, req, Nat.is_le(req, free))

def add_zero_sym(+a: Nat) -> {a == Nat.add(a, 0n) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %add_zero_sym(ap) : {1n+ap == 1n+_ : Nat}
      {==}

def add_succ_sym(+a: Nat, +b: Nat) -> {1n+Nat.add(a, b) == Nat.add(a, 1n+b) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %add_succ_sym(ap, b) : {1n+1n+Nat.add(ap, b) == 1n+_ : Nat}
      {==}

def take_step(
  +rp: Nat,
  +fp: Nat,
  +alloc: Nat,
  ok: Bool,
  ih: {bin_capacity(bin_take_if(alloc, fp, rp, ok)) == Nat.add(alloc, fp) : Nat}
) -> {bin_capacity(bin_take_if(alloc, 1n+fp, 1n+rp, ok)) == Nat.add(alloc, 1n+fp) : Nat}:
  match ok:
    case False{}:
      {==}
    case True{}:
      %add_succ_sym(alloc, rp) : {Nat.add(_, Nat.sub(fp, rp)) == Nat.add(alloc, 1n+fp) : Nat}
      %add_succ_sym(alloc, fp) : {1n+Nat.add(Nat.add(alloc, rp), Nat.sub(fp, rp)) == _ : Nat}
      %ih : {1n+Nat.add(Nat.add(alloc, rp), Nat.sub(fp, rp)) == 1n+_ : Nat}
      {==}

def take_if_shift(+req: Nat, +free: Nat, +alloc: Nat) -> {bin_capacity(bin_take_if(alloc, free, req, Nat.is_le(req, free))) == Nat.add(alloc, free) : Nat}:
  match req free:
    case 0n 0n:
      %add_zero_sym(Nat.add(alloc, 0n)) : {_ == Nat.add(alloc, 0n) : Nat}
      {==}
    case 0n 1n+fp:
      %add_zero_sym(alloc) : {Nat.add(_, 1n+fp) == Nat.add(alloc, 1n+fp) : Nat}
      {==}
    case 1n+rp 0n:
      {==}
    case 1n+rp 1n+fp:
      take_step(rp, fp, alloc, Nat.is_le(rp, fp), take_if_shift(rp, fp, alloc))

# promise: taking from a bin conserves its total capacity
law take_conserves_capacity:
  for +alloc: Nat
  for +free: Nat
  for +req: Nat
  {bin_capacity(bin_take(Bin{alloc, free}, req)) == Nat.add(alloc, free) : Nat}

def take_conserves_capacity(alloc, free, req):
  take_if_shift(req, free, alloc)
"#;
        fs::write(&core, src).unwrap();

        let bend = crate::resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(std::path::PathBuf::from),
        );
        let output = Command::new(&bend)
            .arg(&core)
            .arg("--check-only")
            .output()
            .expect("bend binary should execute");
        assert!(
            output.status.success(),
            "bend --check-only failed:\\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );

        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        let summary = run_mutation_checks(src, &report, MutateMode::NewOnly, &out_dir)
            .expect("conservation law must catch Nat.add -> Nat.sub mutant");
        assert_eq!(summary.reports.len(), 1);
        assert!(summary.reports[0].caught_by.is_some());
        assert!(!summary.reports[0].from_cache);

        // Second run hits mutation cache
        let summary2 = run_mutation_checks(src, &report, MutateMode::NewOnly, &out_dir)
            .expect("cached mutation check succeeds");
        assert!(summary2.reports[0].from_cache);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mutate_mode_all_reports_locked_laws_without_failing() {
        let dir = tmp_dir("mode_all");
        let core = dir.join("core.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let src = r#"import Base

def inc(+n: Nat) -> Nat:
  Nat.add(n, 1n)

# promise: incrementing zero yields one
law inc_zero:
  {inc(0n) == 1n : Nat}

# promise: tautological placeholder fixture
law empty_tautology:
  for +n: Nat
  {inc(n) == inc(n) : Nat}
"#;
        fs::write(&core, src).unwrap();
        // Pre-seal both laws into the lock
        lock::enforce_law_lock(&lock_file, std::slice::from_ref(&core), true).unwrap();

        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        assert!(report.new_names.is_empty());
        assert_eq!(report.locked_names.len(), 2);

        let summary = run_mutation_checks(src, &report, MutateMode::All, &out_dir)
            .expect("MutateMode::All must report without failing on locked vacuous laws");
        assert_eq!(summary.warnings.len(), 2);
        assert!(
            summary
                .warnings
                .iter()
                .any(|w| w.contains("empty_tautology") && w.contains("SURVIVED")),
            "warnings: {:?}",
            summary.warnings
        );
        assert!(
            summary
                .warnings
                .iter()
                .any(|w| w.contains("inc_zero") && w.contains("caught by")),
            "warnings: {:?}",
            summary.warnings
        );

        let _ = fs::remove_dir_all(&dir);
    }

    const LEGACY_OPS: &[&str] = &[
        "BoolFlip",
        "NatCmpArith",
        "DropBoolOperand",
        "ReturnUnchanged",
        "SwapMatchArms",
    ];

    /// Runs only the mutants whose operator is in \`ops\` against \`law_name\`. Returns
    /// \`Err\` if the harness fails to compile, so a "survived" result is never a build error.
    fn eval_with_ops(
        src: &str,
        law_name: &str,
        ops: &[&str],
        out_dir: &Path,
    ) -> Result<Option<(String, String)>, String> {
        let laws = parse_laws(src);
        let law = laws.iter().find(|l| l.name == law_name).expect("law");
        let (types, defs) = parse_book_items(src)?;
        let extra = collect_law_source_slices(&laws);
        let type_env = TypeEnv::build(&types, &defs, &extra);
        let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
        let type_map: HashMap<String, &TypeDef> =
            types.iter().map(|t| (t.name.clone(), t)).collect();
        let cone = law_dependency_cone(law, &defs);
        let cone_defs: Vec<Def> = cone
            .iter()
            .filter_map(|n| def_map.get(n).map(|d| (*d).clone()))
            .collect();
        let mutants: Vec<Mutant> =
            generate_mutants_for_cone(&cone_defs, &def_map, &type_env.ctor_map)
                .into_iter()
                .filter(|m| ops.contains(&m.operator.as_str()))
                .collect();
        assert!(!mutants.is_empty(), "no {ops:?} mutants for {law_name}");
        fs::create_dir_all(out_dir).unwrap();
        run_mutant_harness(
            law, &mutants, &types, &cone_defs, &type_map, &type_env, out_dir,
        )
        .map_err(|e| match e {
            HarnessError::Compile(stderr) => format!("mutant harness did not compile:\\n{stderr}"),
            HarnessError::Run => "mutant harness failed to run".to_string(),
        })
    }

    /// Operators that existed before Issue #15 (legacy + bound-pushing).
    const PRE_ISSUE15_OPS: &[&str] = &[
        "BoolFlip",
        "NatCmpArith",
        "DropBoolOperand",
        "ReturnUnchanged",
        "SwapMatchArms",
        "NatBound",
        "SiblingCtor",
        "BoolConst",
        "FlipCmp",
    ];

    fn assert_new_operator_catches(src: &str, law_name: &str, op: &str, tag: &str) {
        assert_operator_closes_gap(src, law_name, op, tag, LEGACY_OPS);
    }

    /// Asserts every operator in \`prior_ops\` survives \`law_name\` (the gap), \`op\` alone catches
    /// it with an id naming \`op\`, and the full gate accepts the law as a new law.
    fn assert_operator_closes_gap(
        src: &str,
        law_name: &str,
        op: &str,
        tag: &str,
        prior_ops: &[&str],
    ) {
        let dir = tmp_dir(tag);
        let out = dir.join("out");
        let legacy = eval_with_ops(src, law_name, prior_ops, &out)
            .expect("prior-operator mutant harness must compile");
        assert!(
            legacy.is_none(),
            "{law_name}: expected {prior_ops:?} to survive (the gap), got {legacy:?}"
        );
        let caught = eval_with_ops(src, law_name, &[op], &out)
            .expect("new-operator harness must compile")
            .unwrap_or_else(|| panic!("{law_name}: {op} must catch a mutant"));
        assert!(
            caught.0.ends_with(&format!("[{op}]")),
            "mutant id must name the operator: {caught:?}"
        );

        // The full gate accepts the new law, naming the catching operator.
        let core = dir.join("core.bend");
        fs::write(&core, src).unwrap();
        let report = lock::check_law_lock(&dir.join("rusty-bends.lock"), &[core], false).unwrap();
        let summary = run_mutation_checks(src, &report, MutateMode::NewOnly, &out)
            .expect("law must no longer be vacuous");
        let (desc, _) = summary.reports[0].caught_by.clone().expect("caught");
        assert!(
            [
                "[NatBound]",
                "[SiblingCtor]",
                "[BoolConst]",
                "[FlipCmp]",
                "[ReturnCtor]",
                "[NatLit]"
            ]
            .iter()
            .any(|t| desc.ends_with(t)),
            "caught by a new operator: {desc}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nat_bound_catches_one_direction_bound_law() {
        let src = r#"import Base

def budget_after_step(+l: Nat) -> Nat:
  match l:
    case 0n:
      0n
    case 1n+p:
      p

# promise: taking a step never grows the remaining budget
law step_budget_never_grows:
  for +l: Nat
  {Nat.is_le(budget_after_step(l), l) == True{} : Bool}
"#;
        assert_new_operator_catches(src, "step_budget_never_grows", "NatBound", "bound");
    }

    #[test]
    fn sibling_ctor_catches_absorbing_state_law() {
        let src = r#"import Base

type Job is Data:
  Queued{n: Nat}
  Running{n: Nat}
  Done{}

def job_step(+s: Job, +ev: Nat) -> Job:
  match s:
    case Queued{n}:
      Running{Nat.add(n, ev)}
    case Running{n}:
      Running{n}
    case Done{}:
      Done{}

# promise: a finished job stays finished whatever event arrives
law done_job_absorbing:
  for +ev: Nat
  {job_step(Done{}, ev) == Done{} : Job}
"#;
        assert_new_operator_catches(src, "done_job_absorbing", "SiblingCtor", "absorb");
    }

    #[test]
    fn bool_const_catches_implication_law() {
        let src = r#"import Base

def allowed(+c: Nat, +granted: Bool) -> Bool:
  match c:
    case 0n:
      True{}
    case 1n+k:
      granted

def requires(+c: Nat, +granted: Bool) -> Bool:
  match c:
    case 0n:
      False{}
    case 1n+k:
      granted

# promise: whenever a request requires a grant, it is allowed
law required_implies_allowed:
  for +c: Nat
  for +g: Bool
  {Bool.or(allowed(c, g), Bool.not(requires(c, g))) == True{} : Bool}
"#;
        assert_new_operator_catches(src, "required_implies_allowed", "BoolConst", "implies");
    }

    #[test]
    fn flip_cmp_catches_strict_refusal_law() {
        let src = r#"import Base

def count_within_limit(+count: Nat, +max: Nat) -> Bool:
  Nat.is_le(count, max)

# promise: a count above the limit is always refused
law count_above_limit_refused:
  for +m: Nat
  for +extra: Nat
  {count_within_limit(Nat.add(Nat.add(1n, m), extra), m) == False{} : Bool}
"#;
        assert_new_operator_catches(src, "count_above_limit_refused", "FlipCmp", "refuse");
    }

    #[test]
    fn bound_operators_keep_their_own_budget_after_legacy_cap() {
        // Many comparison sites saturate the legacy budget; bound families still appear.
        let mut body = String::from("Bool.and(Nat.is_le(a, b), Nat.is_le(b, a))");
        for _ in 0..30 {
            body = format!("Bool.and({body}, Nat.is_lt(a, Nat.add(b, 1n)))");
        }
        let src = format!(
            "def busy(+a: Nat, +b: Nat, +t: Bool) -> Bool:\\n  Bool.and(t, {body})\\n\\ndef shrink(+x: Nat) -> Nat:\\n  Nat.sub(x, 1n)\\n"
        );
        let (types, defs) = parse_book_items(&src).unwrap();
        let env = TypeEnv::build(&types, &defs, &[]);
        let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
        let mutants = generate_mutants_for_cone(&defs, &def_map, &env.ctor_map);
        let legacy = mutants
            .iter()
            .filter(|m| LEGACY_OPS.contains(&m.operator.as_str()))
            .count();
        assert_eq!(legacy, MAX_MUTANTS_PER_LAW);
        for op in ["NatBound", "BoolConst", "FlipCmp"] {
            assert!(
                mutants.iter().any(|m| m.operator == op),
                "{op} missing after legacy cap"
            );
        }
        assert!(
            mutants.len()
                <= MAX_MUTANTS_PER_LAW
                    + MAX_BOUND_MUTANTS_PER_LAW
                    + MAX_RETURN_LIT_MUTANTS_PER_LAW
                    + MAX_ADD_MAX_MIN_MUTANTS_PER_LAW
        );
        assert!(mutants.iter().any(|m| m.operator == "NatLit"));
    }

    #[test]
    fn return_ctor_catches_fallthrough_variable_absorbing_law() {
        let src = r#"import Base

type Stage is Data:
  Draft{}
  Review{}
  Final{}

type StageEvent is Data:
  Submit{}
  Approve{}

def stage_step(p: Stage, ev: StageEvent) -> Stage:
  match p ev:
    case Draft{} Submit{}:
      Review{}
    case Review{} Approve{}:
      Final{}
    case st _:
      st

# promise: a final stage stays final whatever event arrives
law final_stage_absorbing:
  for ev: StageEvent
  {stage_step(Final{}, ev) == Final{} : Stage}
"#;
        assert_operator_closes_gap(
            src,
            "final_stage_absorbing",
            "ReturnCtor",
            "fallthrough",
            PRE_ISSUE15_OPS,
        );
    }

    #[test]
    fn return_ctor_catches_delegated_call_classifier_law() {
        let src = r#"import Base

type Size is Data:
  Small{}
  Medium{}
  Large{}

type Input is Data:
  Wrapped{a: Nat, b: Nat}
  Raw{hi: Nat}

def pair_size(+a: Nat, +b: Nat) -> Size:
  match a:
    case 10n:
      Medium{}
    case 127n:
      Large{}
    case _:
      Small{}

def raw_size(+hi: Nat) -> Size:
  match hi:
    case 0n:
      Large{}
    case _:
      Small{}

def input_size(+v: Input) -> Size:
  match v:
    case Wrapped{a, b}:
      pair_size(a, b)
    case Raw{hi}:
      raw_size(hi)

# promise: a wrapped pair is sized exactly like the pair itself
law wrapped_sized_like_pair:
  for +a: Nat
  for +b: Nat
  {input_size(Wrapped{a, b}) == pair_size(a, b) : Size}
"#;
        assert_operator_closes_gap(
            src,
            "wrapped_sized_like_pair",
            "ReturnCtor",
            "delegated_call",
            PRE_ISSUE15_OPS,
        );
    }

    #[test]
    fn nat_lit_catches_zero_rejected_law() {
        // \`width = 0\` is refused because width must equal 256n or 512n; changing a literal
        // (256n -> 0n) is what breaks the law.
        let src = r#"import Base

def config_valid(+n: Nat, +m: Nat, +width: Nat, +extra: Nat) -> Bool:
  Bool.and(Bool.or(Nat.is_eq(width, 256n), Nat.is_eq(width, 512n)), Nat.is_le(m, n))

# promise: a zero width is always rejected
law zero_width_rejected:
  for +n: Nat
  for +m: Nat
  for +e: Nat
  {config_valid(n, m, 0n, e) == False{} : Bool}
"#;
        let dir = tmp_dir("zero_width");
        let caught = eval_with_ops(src, "zero_width_rejected", &["NatLit"], &dir)
            .expect("harness compiles")
            .expect("NatLit catches the literal-guarded law");
        assert!(caught.0.contains("256n -> 0n [NatLit]"), "{caught:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nat_lit_respects_per_function_site_cap_and_skips_patterns() {
        let body = "match x:\\n  case 7n:\\n    1n\\n  case _:\\n    Nat.add(Nat.add(Nat.add(2n, 3n), Nat.add(4n, 5n)), Nat.add(Nat.add(6n, 8n), Nat.add(9n, 10n)))";
        let protected = compute_protected_ranges(body);
        let muts = mutate_nat_lit(body, &protected);
        assert!(
            muts.iter().all(|(_, d)| !d.starts_with("7n ")),
            "case pattern literal mutated"
        );
        let sites: HashSet<&str> = muts
            .iter()
            .map(|(_, d)| d.split(" -> ").next().unwrap())
            .collect();
        assert_eq!(sites.len(), MAX_NAT_LIT_SITES_PER_DEF);
        assert!(
            !sites.contains("10n"),
            "ninth site must be capped: {sites:?}"
        );
        assert_eq!(muts[0].1, "1n -> 0n", "-> 0n mutants come first");
    }

    const EXS_LAW_SRC: &str = r#"import Base

def double(+n: Nat) -> Nat:
  Nat.add(n, n)

# promise: some input doubles to four
law double_hits_four:
  exs n: Nat
  {double(n) == 4n : Nat}
"#;

    #[test]
    fn new_unevaluable_law_fails_with_e_law_unchecked() {
        let dir = tmp_dir("unchecked_fail");
        let core = dir.join("core.bend");
        let lock_file = dir.join("rusty-bends.lock");
        fs::write(&core, EXS_LAW_SRC).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), true).unwrap();
        let err = run_mutation_checks(EXS_LAW_SRC, &report, MutateMode::NewOnly, &dir.join("o"))
            .expect_err("an unevaluable new law must not be sealable without a marker");
        assert!(err.contains("[E_LAW_UNCHECKED]"), "got: {err}");
        assert!(err.contains("double_hits_four"), "got: {err}");
        assert!(err.contains("exs"), "reason must be named: {err}");
        assert!(
            err.contains("Supported forms"),
            "supported forms listed: {err}"
        );
        assert!(err.contains("# unchecked:"), "marker hint: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unchecked_marker_admits_law_and_is_locked_and_listed() {
        let dir = tmp_dir("unchecked_ok");
        let core = dir.join("core.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let src = EXS_LAW_SRC.replace(
            "# promise: some input doubles to four\\n",
            "# promise: some input doubles to four\\n# unchecked: existential witness is proved by Bend, not sampled\\n",
        );
        fs::write(&core, &src).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), true).unwrap();
        let summary = run_mutation_checks(&src, &report, MutateMode::NewOnly, &dir.join("o"))
            .expect("marked law passes");
        assert!(
            summary
                .warnings
                .iter()
                .any(|w| w.contains("UNCHECKED")
                    && w.contains("existential witness is proved by Bend")),
            "warnings: {:?}",
            summary.warnings
        );
        assert!(report.serialized.contains(
            "# unchecked double_hits_four: existential witness is proved by Bend, not sampled"
        ));
        let listing = lock::format_law_list(&report.current);
        assert_eq!(
            listing,
            "double_hits_four: some input doubles to four [unchecked: existential witness is proved by Bend, not sampled]"
        );

        // Once sealed, the law is locked and only warns (even with the marker removed).
        lock::write_law_lock(&lock_file, &report).unwrap();
        fs::write(&core, EXS_LAW_SRC).unwrap();
        let locked = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        assert!(locked.new_names.is_empty());
        let all = run_mutation_checks(EXS_LAW_SRC, &locked, MutateMode::All, &dir.join("o"))
            .expect("locked unevaluable laws warn, never fail");
        assert!(all.warnings.iter().any(|w| w.contains("skipped")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unnecessary_unchecked_marker_is_reported() {
        let dir = tmp_dir("unchecked_unneeded");
        let core = dir.join("core.bend");
        let src = r#"import Base

def inc(+n: Nat) -> Nat:
  Nat.add(n, 1n)

# promise: incrementing zero yields one
# unchecked: not really needed
law inc_zero:
  {inc(0n) == 1n : Nat}
"#;
        fs::write(&core, src).unwrap();
        let report = lock::check_law_lock(&dir.join("rusty-bends.lock"), &[core], false).unwrap();
        let summary = run_mutation_checks(src, &report, MutateMode::NewOnly, &dir.join("o"))
            .expect("checkable law passes");
        assert!(
            summary
                .warnings
                .iter()
                .any(|w| w.contains("is unnecessary")),
            "warnings: {:?}",
            summary.warnings
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rust_keyword_names_are_mutation_checked_not_vacuous() {
        // Exact reproducer from issue #16: \`as\` is a Rust keyword.
        let dir = tmp_dir("keyword_vacuous");
        let core = dir.join("core.bend");
        let src = r#"import Base

def keep(as: Nat) -> Nat:
  as

# promise: keep returns its input.
law keep_same:
  for as: Nat
  {keep(as) == as : Nat}

def keep_same(as):
  {==}
"#;
        fs::write(&core, src).unwrap();
        let report = lock::check_law_lock(&dir.join("rusty-bends.lock"), &[core], false).unwrap();
        let summary = run_mutation_checks(src, &report, MutateMode::NewOnly, &dir.join("o"))
            .expect("a keyword-named law must not be reported vacuous");
        let (desc, _) = summary.reports[0].caught_by.clone().expect("caught");
        assert!(desc.ends_with("[NatBound]"), "caught by: {desc}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mutant_that_does_not_compile_is_a_tool_error_not_a_survivor() {
        let dir = tmp_dir("mutant_build");
        let src = r#"import Base

def keep(+n: Nat) -> Nat:
  n

law keep_same:
  for +n: Nat
  {keep(n) == n : Nat}
"#;
        let laws = parse_laws(src);
        let law = &laws[0];
        let (types, defs) = parse_book_items(src).unwrap();
        let type_env = TypeEnv::build(&types, &defs, &collect_law_source_slices(&laws));
        let type_map: HashMap<String, &TypeDef> =
            types.iter().map(|t| (t.name.clone(), t)).collect();
        // \`True{}\` emits a Rust \`bool\` where a \`u64\` is expected, so rustc rejects it.
        let bad = Mutant {
            operator: "Test".to_string(),
            description: "keep: body -> True{} [Test]".to_string(),
            def_name: "keep".to_string(),
            mutated_body: "True{}".to_string(),
        };
        let err = evaluate_mutants_batch(law, &[bad], &types, &defs, &type_map, &type_env, &dir)
            .expect_err("an uncompilable mutant must not count as a survivor");
        assert!(err.contains("[E_MUTANT_BUILD]"), "{err}");
        assert!(err.contains("keep: body -> True{} [Test]"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mutate_mode_all_covers_new_laws_and_report_mode_lists_every_mutant_and_caches() {
        let dir = tmp_dir("issue19_report");
        let core = dir.join("ledger.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let base_src = r#"import Base

def total_items(+a: Nat, +b: Nat) -> Nat:
  Nat.add(a, b)

def bump(+n: Nat) -> Nat:
  1n+n

# promise: the total never drops below the first delivery
law total_covers_first:
  for +a: Nat
  for +b: Nat
  {Nat.is_le(a, total_items(a, b)) == True{} : Bool}

# promise: a write always changes the stamp
law bump_changes:
  for +m: Nat
  {Nat.is_eq(m, bump(m)) == False{} : Bool}
"#;
        fs::write(&core, base_src).unwrap();
        lock::enforce_law_lock(&lock_file, std::slice::from_ref(&core), true).unwrap();

        let with_new_src = format!(
            "{base_src}\\n# promise: the total never drops below the second delivery\\nlaw total_covers_second:\\n  for +a: Nat\\n  for +b: Nat\\n  {{Nat.is_le(b, total_items(a, b)) == True{{}} : Bool}}\\n"
        );
        fs::write(&core, &with_new_src).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        assert!(report.new_names.contains("total_covers_second"));
        assert!(report.locked_names.contains("total_covers_first"));
        assert!(report.locked_names.contains("bump_changes"));

        // \`RUSTY_BENDS_MUTATE=all\` covers both locked laws AND new laws.
        let all_summary = run_mutation_checks(&with_new_src, &report, MutateMode::All, &out_dir)
            .expect("MutateMode::All covers new and locked laws");
        assert!(all_summary.report_path.is_none());
        assert_eq!(all_summary.warnings.len(), 3, "{:?}", all_summary.warnings);
        for name in ["total_covers_first", "bump_changes", "total_covers_second"] {
            assert!(
                all_summary
                    .warnings
                    .iter()
                    .any(|w| w.contains(&format!("[{name}]"))),
                "missing {name} in =all output: {:?}",
                all_summary.warnings
            );
        }

        // \`RUSTY_BENDS_MUTATE=report\` evaluates EVERY mutant of every law and writes OUT_DIR/rusty-bends-mutants.txt.
        let rep_summary = run_mutation_checks(&with_new_src, &report, MutateMode::Report, &out_dir)
            .expect("MutateMode::Report evaluates every mutant");
        let report_path = rep_summary.report_path.as_ref().expect("report_path");
        assert!(report_path.ends_with("rusty-bends-mutants.txt"));
        assert!(report_path.exists());
        let file_text = fs::read_to_string(report_path).unwrap();

        let first = rep_summary
            .reports
            .iter()
            .find(|r| r.law_name == "total_covers_first")
            .unwrap();
        assert!(!first.from_cache, "upgrade from FIRST to FULL must re-run");
        for expected_desc in [
            "total_items: Nat.add -> Nat.sub [NatCmpArith]",
            "total_items: Nat.add -> Nat.mul [NatCmpArith]",
            "total_items: return parameter 'a' unchanged [ReturnUnchanged]",
            "total_items: return parameter 'b' unchanged [ReturnUnchanged]",
            "total_items: result -> Nat.add(result, 1n) [NatBound]",
            "total_items: result -> Nat.sub(result, 1n) [NatBound]",
            "total_items: result -> 0n [NatBound]",
        ] {
            assert!(
                first
                    .mutant_outcomes
                    .iter()
                    .any(|o| o.description == expected_desc),
                "missing {expected_desc} in {:?}",
                first.mutant_outcomes
            );
            assert!(
                file_text.contains(expected_desc),
                "missing {expected_desc} in file:\\n{file_text}"
            );
        }
        assert!(first.mutant_outcomes.iter().any(|o| {
            o.description == "total_items: result -> Nat.add(result, 1n) [NatBound]"
                && matches!(o.status, MutantStatus::Survived)
        }));
        assert!(first.mutant_outcomes.iter().any(|o| {
            o.description == "total_items: Nat.add -> Nat.sub [NatCmpArith]"
                && matches!(o.status, MutantStatus::Caught(_))
        }));

        // Second Report run hits cache with identical per-mutant outcomes.
        let rep_cached = run_mutation_checks(&with_new_src, &report, MutateMode::Report, &out_dir)
            .expect("cached report run succeeds");
        for r in &rep_cached.reports {
            assert!(r.from_cache, "expected {} to hit cache", r.law_name);
        }
        let first_cached = rep_cached
            .reports
            .iter()
            .find(|r| r.law_name == "total_covers_first")
            .unwrap();
        assert_eq!(first_cached.mutant_outcomes, first.mutant_outcomes);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mutation_reports_dropped_by_budget_and_site_cap_and_caches_survived() {
        let dir = tmp_dir("issue19_dropped_and_survived");
        let core = dir.join("core.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        // Build a def with > 8 Nat literal sites AND > 48 legacy comparisons so both caps trigger.
        let mut expr = String::from("Bool.and(Nat.is_eq(x, 1n), Nat.is_eq(x, 2n))");
        for k in 3..=45 {
            expr = format!("Bool.and({expr}, Nat.is_eq(x, {k}n))");
        }
        let src = format!(
            "import Base\\n\\ndef many_checks(+x: Nat) -> Bool:\\n  {expr}\\n\\n# promise: tautology fixture\\nlaw many_taut:\\n  for +x: Nat\\n  {{many_checks(x) == many_checks(x) : Bool}}\\n"
        );
        fs::write(&core, &src).unwrap();
        lock::enforce_law_lock(&lock_file, std::slice::from_ref(&core), true).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();

        let summary = run_mutation_checks(&src, &report, MutateMode::All, &out_dir)
            .expect("locked surviving law runs under MutateMode::All");
        assert_eq!(summary.reports.len(), 1);
        let r = &summary.reports[0];
        assert!(r.dropped_by_budget > 0, "{r:?}");
        assert!(r.dropped_by_site_cap > 0, "{r:?}");
        assert!(
            summary.warnings[0].contains("dropped by budget")
                && summary.warnings[0].contains("dropped by site cap"),
            "warnings: {:?}",
            summary.warnings
        );

        // Warm All run hits cached SURVIVED entry without recompiling.
        let summary2 = run_mutation_checks(&src, &report, MutateMode::All, &out_dir).unwrap();
        assert!(summary2.reports[0].from_cache);
        assert!(summary2.warnings[0].contains("[cached]"));

        // Warm Report run upgrades from First::Survived cleanly.
        let summary_rep = run_mutation_checks(&src, &report, MutateMode::Report, &out_dir).unwrap();
        assert!(summary_rep.reports[0].from_cache);
        assert!(!summary_rep.reports[0].mutant_outcomes.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn batched_multi_law_evaluation_handles_many_laws_and_keyword_report() {
        let dir = tmp_dir("issue19_batch");
        let core = dir.join("core.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let src = r#"import Base

def loop(+as: Nat) -> Nat:
  Nat.add(as, 1n)

def double(+x: Nat) -> Nat:
  Nat.add(x, x)

def clamp_zero(+x: Nat) -> Nat:
  Nat.sub(x, x)

def is_nonzero(+x: Nat) -> Bool:
  Nat.is_gt(x, 0n)

# promise: loop increments zero to one
law loop_zero:
  {loop(0n) == 1n : Nat}

# promise: loop is strictly above input
law loop_above:
  for +as: Nat
  {Nat.is_lt(as, loop(as)) == True{} : Bool}

# promise: doubling two gives four
law double_two:
  {double(2n) == 4n : Nat}

# promise: subtracting self gives zero
law clamp_zero_ok:
  for +x: Nat
  {clamp_zero(x) == 0n : Nat}

# promise: one is nonzero
law one_nonzero:
  {is_nonzero(1n) == True{} : Bool}
"#;
        fs::write(&core, src).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        let summary = run_mutation_checks(src, &report, MutateMode::Report, &out_dir)
            .expect("batched report over 5 laws including keyword names succeeds");
        assert_eq!(summary.reports.len(), 5);
        for r in &summary.reports {
            assert!(r.caught_by.is_some(), "{} was not caught", r.law_name);
        }

        // Verify batch fallback preserves valid laws while isolating an uncompilable mutant.
        let laws = parse_laws(src);
        let (types, defs) = parse_book_items(src).unwrap();
        let type_env = TypeEnv::build(&types, &defs, &collect_law_source_slices(&laws));
        let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
        let type_map: HashMap<String, &TypeDef> =
            types.iter().map(|t| (t.name.clone(), t)).collect();
        let bad_mutant = Mutant {
            operator: "Test".to_string(),
            description: "double: body -> True{} [Test]".to_string(),
            def_name: "double".to_string(),
            mutated_body: "True{}".to_string(),
        };
        let good_defs = vec![def_map["loop"].clone()];
        let good_muts = generate_mutants_for_cone(&good_defs, &def_map, &type_env.ctor_map);
        let bad_defs = vec![def_map["double"].clone()];
        let work = vec![
            LawWorkItem {
                prepared_idx: 0,
                law: &laws[0],
                is_locked: false,
                cone_defs: &good_defs,
                mutants: &good_muts,
            },
            LawWorkItem {
                prepared_idx: 1,
                law: &laws[2],
                is_locked: false,
                cone_defs: &bad_defs,
                mutants: std::slice::from_ref(&bad_mutant),
            },
        ];
        let res = evaluate_work_items_batched(&work, &types, &type_map, &type_env, true, &out_dir)
            .unwrap();
        assert!(matches!(res[0], EvaluatedLawResult::Complete { .. }));
        assert!(matches!(res[1], EvaluatedLawResult::BuildFailed { .. }));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nat_add_max_min_exposes_max_replacement_survivor_on_bound_laws_and_catches_sum_bound() {
        let dir = tmp_dir("issue20_add_max_min");
        let core = dir.join("ledger.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let bound_only_src = r#"import Base

def total_items(+a: Nat, +b: Nat) -> Nat:
  Nat.add(a, b)

# promise: the total never drops below the first delivery
law total_covers_first:
  for +a: Nat
  for +b: Nat
  {Nat.is_le(a, total_items(a, b)) == True{} : Bool}

# promise: the total never drops below the second delivery
law total_covers_second:
  for +a: Nat
  for +b: Nat
  {Nat.is_le(b, total_items(a, b)) == True{} : Bool}
"#;
        fs::write(&core, bound_only_src).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        let rep = run_mutation_checks(bound_only_src, &report, MutateMode::Report, &out_dir)
            .expect("bound laws catch other mutants while exposing Nat.add -> Nat.max");

        for law_name in ["total_covers_first", "total_covers_second"] {
            let r = rep.reports.iter().find(|r| r.law_name == law_name).unwrap();
            assert!(
                r.mutant_outcomes.iter().any(|o| {
                    o.description == "total_items: Nat.add -> Nat.max [NatAddMaxMin]"
                        && matches!(o.status, MutantStatus::Survived)
                }),
                "{law_name} must report Nat.add -> Nat.max as survived: {:?}",
                r.mutant_outcomes
            );
            assert!(
                r.mutant_outcomes.iter().any(|o| {
                    o.description == "total_items: Nat.add -> Nat.min [NatAddMaxMin]"
                        && matches!(o.status, MutantStatus::Caught(_))
                }),
                "{law_name} must catch Nat.add -> Nat.min: {:?}",
                r.mutant_outcomes
            );
        }

        // Adding a law requiring at least the sum catches \`Nat.add -> Nat.max\`.
        let with_sum_law = format!(
            "{bound_only_src}\\n# promise: the total is at least the sum of both deliveries\\nlaw total_at_least_sum:\\n  for +a: Nat\\n  for +b: Nat\\n  {{Nat.is_le(Nat.add(a, b), total_items(a, b)) == True{{}} : Bool}}\\n"
        );
        fs::write(&core, &with_sum_law).unwrap();
        let report2 = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        let rep2 = run_mutation_checks(&with_sum_law, &report2, MutateMode::Report, &out_dir)
            .expect("sum bound law passes");
        let sum_rep = rep2
            .reports
            .iter()
            .find(|r| r.law_name == "total_at_least_sum")
            .unwrap();
        assert!(
            sum_rep.mutant_outcomes.iter().any(|o| {
                o.description == "total_items: Nat.add -> Nat.max [NatAddMaxMin]"
                    && matches!(o.status, MutantStatus::Caught(_))
            }),
            "total_at_least_sum must catch Nat.add -> Nat.max: {:?}",
            sum_rep.mutant_outcomes
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nat_add_max_min_covers_max_min_to_add_infix_nat_and_keyword_names() {
        let dir = tmp_dir("issue20_variants");
        let core = dir.join("variants.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let src = r#"import Base

def loop(+as: Nat, +in: Nat) -> Nat:
  ((as + in : Nat) + 1n : Nat)

def pick_hi(+a: Nat, +b: Nat) -> Nat:
  Nat.max(a, b)

def pick_lo(+a: Nat, +b: Nat) -> Nat:
  Nat.min(a, b)

def wrap_u32(+a: U32, +b: U32) -> U32:
  (a + b : U32)

# promise: loop adds one past the sum
law loop_exact:
  for +as: Nat
  for +in: Nat
  {loop(as, in) == Nat.add(Nat.add(as, in), 1n) : Nat}

# promise: pick_hi matches Nat.max
law pick_hi_eq:
  for +a: Nat
  for +b: Nat
  {pick_hi(a, b) == Nat.max(a, b) : Nat}

# promise: pick_lo matches Nat.min
law pick_lo_eq:
  for +a: Nat
  for +b: Nat
  {pick_lo(a, b) == Nat.min(a, b) : Nat}

# promise: wrap_u32 wraps on addition
law wrap_u32_eq:
  for +a: U32
  for +b: U32
  {wrap_u32(a, b) == (a + b : U32) : U32}
"#;
        fs::write(&core, src).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        let summary = run_mutation_checks(src, &report, MutateMode::Report, &out_dir)
            .expect("NatAddMaxMin variants compile and evaluate cleanly");

        let loop_rep = summary
            .reports
            .iter()
            .find(|r| r.law_name == "loop_exact")
            .unwrap();
        assert!(
            loop_rep.mutant_outcomes.iter().any(|o| {
                o.description == "loop: (+ : Nat) -> Nat.max [NatAddMaxMin]"
                    && matches!(o.status, MutantStatus::Caught(_))
            }),
            "{:?}",
            loop_rep.mutant_outcomes
        );
        assert!(
            loop_rep.mutant_outcomes.iter().any(|o| {
                o.description == "loop: (+ : Nat) -> Nat.min [NatAddMaxMin]"
                    && matches!(o.status, MutantStatus::Caught(_))
            }),
            "{:?}",
            loop_rep.mutant_outcomes
        );

        let hi_rep = summary
            .reports
            .iter()
            .find(|r| r.law_name == "pick_hi_eq")
            .unwrap();
        assert!(
            hi_rep.mutant_outcomes.iter().any(|o| {
                o.description == "pick_hi: Nat.max -> Nat.add [NatAddMaxMin]"
                    && matches!(o.status, MutantStatus::Caught(_))
            }),
            "{:?}",
            hi_rep.mutant_outcomes
        );

        let lo_rep = summary
            .reports
            .iter()
            .find(|r| r.law_name == "pick_lo_eq")
            .unwrap();
        assert!(
            lo_rep.mutant_outcomes.iter().any(|o| {
                o.description == "pick_lo: Nat.min -> Nat.add [NatAddMaxMin]"
                    && matches!(o.status, MutantStatus::Caught(_))
            }),
            "{:?}",
            lo_rep.mutant_outcomes
        );

        let u32_rep = summary
            .reports
            .iter()
            .find(|r| r.law_name == "wrap_u32_eq")
            .unwrap();
        assert!(
            !u32_rep
                .mutant_outcomes
                .iter()
                .any(|o| o.operator == "NatAddMaxMin"),
            "U32 infix + must not produce NatAddMaxMin mutants: {:?}",
            u32_rep.mutant_outcomes
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn return_ctor_mutates_whole_multiline_call_and_skips_nested_args_and_let_rhs() {
        let dir = tmp_dir("issue23_multiline_return_ctor");
        let core = dir.join("steps.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let src = r#"import Base

type Step is Data:
  Go{}
  Stop{}

def is_done(+a: Nat, +b: Nat) -> Bool:
  Nat.is_le(
    a,
    b
  )

def step_pick(ready: Bool, done: Bool) -> Step:
  match ready:
    case True{}:
      Go{}
    case False{}:
      Stop{}

def step_next(+ready: Bool, +done: Bool) -> Step:
  step_pick(
    ready,
    done
  )

def step_with_call_arg(+ready: Bool, +a: Nat, +b: Nat) -> Step:
  step_pick(
    ready,
    is_done(a, b)
  )

def step_with_let_and_branch(+ready: Bool, +a: Nat, +b: Nat) -> Step:
  let ok =
    is_done(
      a,
      b)
  match step_pick(ready, ok):
    case Go{}:
      if ok:
        step_pick(
          ready,
          False{}
        )
      else:
        step_pick(
          ready,
          True{}
        )
    case Stop{}:
      Stop{}

def loop(+as: Bool, +self: Bool) -> Step:
  step_pick(
    as,
    self
  )

# promise: a ready step goes
law step_ready_goes:
  for +d: Bool
  {step_next(True{}, d) == Go{} : Step}

# promise: when a <= b a ready step goes cleanly
law step_call_arg_ready:
  for +a: Nat
  for +b: Nat
  {step_with_call_arg(True{}, a, b) == Go{} : Step}

# promise: a step with let/match/if returns Go when ready
law step_let_branch_ready:
  for +a: Nat
  for +b: Nat
  {step_with_let_and_branch(True{}, a, b) == Go{} : Step}

# promise: ordering check matches Nat.is_le
law is_done_ok:
  for +a: Nat
  for +b: Nat
  {is_done(a, b) == Nat.is_le(a, b) : Bool}

# promise: keyword-named wrapper delegates to step_pick
law loop_ready_goes:
  for +self: Bool
  {loop(True{}, self) == Go{} : Step}
"#;
        fs::write(&core, src).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        let summary = run_mutation_checks(src, &report, MutateMode::Report, &out_dir)
            .expect("multi-line calls and let/match/if bodies must compile without E_MUTANT_BUILD");

        for rep in &summary.reports {
            assert!(
                !rep.mutant_outcomes
                    .iter()
                    .any(|o| matches!(o.status, MutantStatus::BuildError(_))),
                "{} had build errors: {:?}",
                rep.law_name,
                rep.mutant_outcomes
            );
            for o in &rep.mutant_outcomes {
                assert!(
                    !o.description.contains('\\n'),
                    "mutant description must stay single-line: {:?}",
                    o.description
                );
            }
        }

        let next_rep = summary
            .reports
            .iter()
            .find(|r| r.law_name == "step_ready_goes")
            .unwrap();
        assert!(
            next_rep.mutant_outcomes.iter().any(|o| {
                o.operator == "ReturnCtor"
                    && o.description
                        == "step_next: returned call 'step_pick(ready, done)' -> Step.Stop{} [ReturnCtor]"
                    && matches!(o.status, MutantStatus::Caught(_))
            }),
            "{:?}",
            next_rep.mutant_outcomes
        );
        assert!(
            !next_rep
                .mutant_outcomes
                .iter()
                .any(|o| o.description.contains("returned variable 'done'")),
            "must never mutate last argument 'done': {:?}",
            next_rep.mutant_outcomes
        );

        let arg_rep = summary
            .reports
            .iter()
            .find(|r| r.law_name == "step_call_arg_ready")
            .unwrap();
        assert!(
            arg_rep.mutant_outcomes.iter().any(|o| {
                o.operator == "ReturnCtor"
                    && o.description
                        .contains("returned call 'step_pick(ready, is_done(a, b))'")
            }),
            "{:?}",
            arg_rep.mutant_outcomes
        );
        assert!(
            !arg_rep
                .mutant_outcomes
                .iter()
                .any(|o| o.description.contains("returned call 'is_done(a, b)'")),
            "must never mutate nested call argument 'is_done(a, b)': {:?}",
            arg_rep.mutant_outcomes
        );

        let kw_rep = summary
            .reports
            .iter()
            .find(|r| r.law_name == "loop_ready_goes")
            .unwrap();
        assert!(
            kw_rep.mutant_outcomes.iter().any(|o| {
                o.operator == "ReturnCtor"
                    && o.description
                        .contains("returned call 'step_pick(as, self)'")
                    && matches!(o.status, MutantStatus::Caught(_))
            }),
            "{:?}",
            kw_rep.mutant_outcomes
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn locked_mutant_build_error_emits_separate_single_line_warnings() {
        let dir = tmp_dir("issue23_locked_build_warn");
        let src = r#"import Base

def keep(+n: Nat) -> Nat:
  n

law keep_same:
  for +n: Nat
  {keep(n) == n : Nat}
"#;
        let laws = parse_laws(src);
        let law = &laws[0];
        let (types, defs) = parse_book_items(src).unwrap();
        let type_env = TypeEnv::build(&types, &defs, &collect_law_source_slices(&laws));
        let type_map: HashMap<String, &TypeDef> =
            types.iter().map(|t| (t.name.clone(), t)).collect();
        let bad = Mutant {
            operator: "Test".to_string(),
            description: "keep: body -> True{} [Test]".to_string(),
            def_name: "keep".to_string(),
            mutated_body: "True{}".to_string(),
        };
        let item = LawWorkItem {
            prepared_idx: 0,
            law,
            is_locked: true,
            cone_defs: &defs,
            mutants: std::slice::from_ref(&bad),
        };
        let EvaluatedLawResult::BuildFailed { error_message, .. } =
            run_single_law_per_mutant_fallback(&item, &types, &type_map, &type_env, false, &dir)
        else {
            panic!("expected BuildFailed for uncompilable mutant");
        };
        let mut warnings = Vec::new();
        emit_law_build_warnings(&law.name, &error_message, &mut warnings);
        assert_eq!(warnings.len(), 3, "{warnings:?}");
        for w in &warnings {
            assert!(!w.contains('\\n'), "warning must not contain newline: {w:?}");
            assert!(
                w.starts_with("RustyBends mutate [keep_same]: "),
                "unexpected prefix: {w:?}"
            );
        }
        assert!(warnings[0].contains("[E_MUTANT_BUILD]"), "{warnings:?}");
        assert!(
            warnings[1].contains("First failing mutant: keep: body -> True{} [Test]"),
            "{warnings:?}"
        );
        assert!(warnings[2].contains("rustc:"), "{warnings:?}");

        let _ = fs::remove_dir_all(&dir);
    }
}
`;

  const buildCrateCoverage = `//! Coverage listing linking emitted Bend 2 functions, laws, and host Rust call sites (Issue #21).
//!
//! Reports:
//! - for each emitted live \`def\`: which laws name it directly and which laws reach it
//!   through their dependency cone;
//! - which emitted functions no law reaches at all;
//! - optionally (when scanning \`src/\`, \`tests/\`, \`benches/\` under a crate root): which
//!   emitted functions are mentioned by name in Rust sources and which laws name only
//!   functions that the host crate never calls.

use crate::emit::{parse_book_items, resolve_import_aliases, rust_ident, Def};
use crate::lock::{extract_laws_from_source, tokenize_bend, CanonicalLaw};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionCoverage {
    pub name: String,
    pub direct_laws: Vec<String>,
    pub cone_laws: Vec<String>,
    pub mentioned_in_rust: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LawCoverage {
    pub name: String,
    pub direct_functions: Vec<String>,
    pub cone_functions: Vec<String>,
    pub unmentioned_direct_functions: Vec<String>,
    pub only_unmentioned_functions: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoverageReport {
    pub functions: Vec<FunctionCoverage>,
    pub laws: Vec<LawCoverage>,
    pub uncovered_functions: Vec<String>,
    pub laws_only_unmentioned: Vec<String>,
    pub rust_scanned: bool,
}

/// Computes law-to-function and optional Rust-source coverage from Bend source text.
pub fn analyze_coverage(
    combined_source: &str,
    crate_root: Option<&Path>,
) -> Result<CoverageReport, String> {
    let resolved = resolve_import_aliases(combined_source);
    let (_types, defs) = parse_book_items(&resolved)?;
    let laws = extract_laws_from_source(&resolved);

    let def_map: HashMap<&str, &Def> = defs.iter().map(|d| (d.name.as_str(), d)).collect();
    let def_names: BTreeSet<String> = defs.iter().map(|d| d.name.clone()).collect();

    let mut def_callees: HashMap<&str, Vec<String>> = HashMap::with_capacity(defs.len());
    for def in &defs {
        let mut callees = Vec::new();
        let mut seen = HashSet::new();
        for tok in tokenize_bend(&def.body) {
            if def_names.contains(&tok) && seen.insert(tok.clone()) {
                callees.push(tok);
            }
        }
        def_callees.insert(def.name.as_str(), callees);
    }

    let mut direct_laws_by_fn: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut cone_laws_by_fn: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for name in &def_names {
        direct_laws_by_fn.insert(name.clone(), BTreeSet::new());
        cone_laws_by_fn.insert(name.clone(), BTreeSet::new());
    }

    let mut rust_tokens: Option<HashSet<String>> = None;
    if let Some(root) = crate_root {
        if has_rust_source_dirs(root) {
            rust_tokens = Some(scan_crate_rust_idents(root)?);
        }
    }
    let rust_scanned = rust_tokens.is_some();

    let mentioned_map: BTreeMap<String, Option<bool>> = def_names
        .iter()
        .map(|name| {
            let mentioned = rust_tokens
                .as_ref()
                .map(|tokens| tokens.contains(&rust_ident(name)));
            (name.clone(), mentioned)
        })
        .collect();

    let mut law_coverages = Vec::with_capacity(laws.len());
    let mut laws_only_unmentioned = Vec::new();

    for law in &laws {
        let direct_set = direct_functions_for_law(law, &def_names);
        let cone_set = transitive_cone(&direct_set, &def_callees, &def_map);

        for fn_name in &direct_set {
            if let Some(set) = direct_laws_by_fn.get_mut(fn_name) {
                set.insert(law.name.clone());
            }
        }
        for fn_name in &cone_set {
            if let Some(set) = cone_laws_by_fn.get_mut(fn_name) {
                set.insert(law.name.clone());
            }
        }

        let direct_functions: Vec<String> = direct_set.into_iter().collect();
        let cone_functions: Vec<String> = cone_set.into_iter().collect();
        let unmentioned_direct_functions: Vec<String> = if rust_scanned {
            direct_functions
                .iter()
                .filter(|name| mentioned_map.get(*name).copied().flatten() == Some(false))
                .cloned()
                .collect()
        } else {
            Vec::new()
        };
        let only_unmentioned_functions = rust_scanned
            && !direct_functions.is_empty()
            && unmentioned_direct_functions.len() == direct_functions.len();
        if only_unmentioned_functions {
            laws_only_unmentioned.push(law.name.clone());
        }

        law_coverages.push(LawCoverage {
            name: law.name.clone(),
            direct_functions,
            cone_functions,
            unmentioned_direct_functions,
            only_unmentioned_functions,
        });
    }
    laws_only_unmentioned.sort();
    law_coverages.sort_by(|a, b| a.name.cmp(&b.name));

    let mut functions = Vec::with_capacity(def_names.len());
    let mut uncovered_functions = Vec::new();
    for name in &def_names {
        let direct_laws: Vec<String> = direct_laws_by_fn
            .get(name)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        let cone_laws: Vec<String> = cone_laws_by_fn
            .get(name)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        if cone_laws.is_empty() {
            uncovered_functions.push(name.clone());
        }
        functions.push(FunctionCoverage {
            name: name.clone(),
            direct_laws,
            cone_laws,
            mentioned_in_rust: mentioned_map.get(name).copied().flatten(),
        });
    }

    Ok(CoverageReport {
        functions,
        laws: law_coverages,
        uncovered_functions,
        laws_only_unmentioned,
        rust_scanned,
    })
}

/// Scans all \`.bend\` files under \`verified_dir\` and analyzes coverage against optional \`crate_root\`.
pub fn analyze_coverage_dir(
    verified_dir: &Path,
    crate_root: Option<&Path>,
) -> Result<CoverageReport, String> {
    let mut files = Vec::new();
    crate::collect_bend_files(verified_dir, &mut files)?;
    files.sort();
    let mut combined = String::new();
    for file in &files {
        let text = fs::read_to_string(file).map_err(|e| e.to_string())?;
        combined.push_str(&resolve_import_aliases(&text));
        combined.push('\\n');
    }
    analyze_coverage(&combined, crate_root)
}

/// Formats \`report\` as human-readable lines for \`cargo:warning=\` or \`rusty-bends-laws --coverage\`.
pub fn format_coverage_report(report: &CoverageReport) -> Vec<String> {
    let mut lines = Vec::new();
    for func in &report.functions {
        let direct = if func.direct_laws.is_empty() {
            "none".to_string()
        } else {
            func.direct_laws.join(", ")
        };
        let cone = if func.cone_laws.is_empty() {
            "none".to_string()
        } else {
            func.cone_laws.join(", ")
        };
        let rust_tag = match func.mentioned_in_rust {
            Some(true) => "; rust=mentioned",
            Some(false) => "; rust=unmentioned",
            None => "",
        };
        lines.push(format!(
            "RustyBends coverage [fn {}]: direct={direct}; cone={cone}{rust_tag}",
            func.name
        ));
    }

    if report.uncovered_functions.is_empty() {
        lines.push(format!(
            "RustyBends coverage [uncovered functions]: none (0 of {} emitted function(s) reached by no law)",
            report.functions.len()
        ));
    } else {
        lines.push(format!(
            "RustyBends coverage [uncovered functions]: {} ({} of {} emitted function(s) reached by no law)",
            report.uncovered_functions.join(", "),
            report.uncovered_functions.len(),
            report.functions.len()
        ));
    }

    if report.rust_scanned {
        if report.laws_only_unmentioned.is_empty() {
            lines.push(
                "RustyBends coverage [laws naming only unmentioned functions]: none".to_string(),
            );
        } else {
            for law in &report.laws {
                if law.only_unmentioned_functions {
                    lines.push(format!(
                        "RustyBends coverage [law {}]: names only functions not mentioned in Rust sources: {}",
                        law.name,
                        law.unmentioned_direct_functions.join(", ")
                    ));
                }
            }
        }
        lines.push(format!(
            "RustyBends coverage summary: {} emitted function(s) ({} uncovered), {} law(s) ({} naming only unmentioned Rust functions)",
            report.functions.len(),
            report.uncovered_functions.len(),
            report.laws.len(),
            report.laws_only_unmentioned.len()
        ));
    } else {
        lines.push(format!(
            "RustyBends coverage summary: {} emitted function(s) ({} uncovered), {} law(s)",
            report.functions.len(),
            report.uncovered_functions.len(),
            report.laws.len()
        ));
    }

    lines
}

fn direct_functions_for_law(law: &CanonicalLaw, def_names: &BTreeSet<String>) -> BTreeSet<String> {
    let tokens = tokenize_bend(&law.canonical_sig);
    let mut bound_vars: HashSet<&str> = HashSet::new();
    let mut i = 2usize;
    while i < tokens.len() {
        if matches!(tokens[i].as_str(), "for" | "exs") {
            let mut j = i + 1;
            if j < tokens.len() && matches!(tokens[j].as_str(), "+" | "-" | "~") {
                j += 1;
            }
            if j + 1 < tokens.len() && tokens[j + 1] == ":" {
                bound_vars.insert(tokens[j].as_str());
                i = j + 2;
                continue;
            }
        }
        i += 1;
    }

    let mut direct = BTreeSet::new();
    for idx in 2..tokens.len() {
        let tok = tokens[idx].as_str();
        if !def_names.contains(tok) {
            continue;
        }
        let is_call = tokens.get(idx + 1).is_some_and(|next| next == "(");
        if !bound_vars.contains(tok) || is_call {
            direct.insert(tok.to_string());
        }
    }
    direct
}

fn transitive_cone(
    roots: &BTreeSet<String>,
    def_callees: &HashMap<&str, Vec<String>>,
    def_map: &HashMap<&str, &Def>,
) -> BTreeSet<String> {
    let mut visited = BTreeSet::new();
    let mut queue = VecDeque::new();
    for root in roots {
        if def_map.contains_key(root.as_str()) && visited.insert(root.clone()) {
            queue.push_back(root.clone());
        }
    }
    while let Some(name) = queue.pop_front() {
        if let Some(callees) = def_callees.get(name.as_str()) {
            for callee in callees {
                if visited.insert(callee.clone()) {
                    queue.push_back(callee.clone());
                }
            }
        }
    }
    visited
}

pub fn has_rust_source_dirs(root: &Path) -> bool {
    ["src", "tests", "benches"]
        .iter()
        .any(|sub| root.join(sub).is_dir())
}

fn scan_crate_rust_idents(root: &Path) -> Result<HashSet<String>, String> {
    let mut rs_files = Vec::new();
    for sub in ["src", "tests", "benches"] {
        let dir = root.join(sub);
        if dir.is_dir() {
            collect_rust_files(&dir, &mut rs_files)?;
        }
    }
    rs_files.sort();
    let mut idents = HashSet::new();
    for file in rs_files {
        let text = fs::read_to_string(&file).map_err(|e| e.to_string())?;
        collect_rust_idents(&text, &mut idents);
    }
    Ok(idents)
}

fn collect_rust_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            let skip = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n == "target" || n == ".git");
            if !skip {
                collect_rust_files(&path, out)?;
            }
        } else if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            out.push(path);
        }
    }
    Ok(())
}

fn is_rust_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}

fn is_rust_ident_continue(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Tokenizes Rust source identifiers (including raw \`r#ident\` tokens) while ignoring
/// line/block comments, normal/byte/c/raw string literals, char literals, and lifetimes.
pub(crate) fn collect_rust_idents(source: &str, out: &mut HashSet<String>) {
    let bytes = source.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        let b = bytes[i];

        // Line comment: // ...
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\\n' {
                i += 1;
            }
            continue;
        }

        // Nested block comment: /* ... */
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            let mut depth = 1usize;
            i += 2;
            while i < bytes.len() && depth > 0 {
                if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'*' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }

        // Raw string literals: r"...", r#"..."#, br#"..."#, cr#"..."#
        let prev_ident = i > 0 && is_rust_ident_continue(bytes[i - 1]);
        if !prev_ident {
            let raw_prefix = if b == b'r' {
                Some(1usize)
            } else if (b == b'b' || b == b'c') && i + 1 < bytes.len() && bytes[i + 1] == b'r' {
                Some(2usize)
            } else {
                None
            };
            if let Some(plen) = raw_prefix {
                let mut p = i + plen;
                let mut hashes = 0usize;
                while p < bytes.len() && bytes[p] == b'#' {
                    hashes += 1;
                    p += 1;
                }
                if p < bytes.len() && bytes[p] == b'"' {
                    p += 1;
                    while p < bytes.len() {
                        if bytes[p] == b'"' {
                            let mut h = 0usize;
                            while h < hashes && p + 1 + h < bytes.len() && bytes[p + 1 + h] == b'#'
                            {
                                h += 1;
                            }
                            if h == hashes {
                                p += 1 + hashes;
                                break;
                            }
                        }
                        p += 1;
                    }
                    i = p;
                    continue;
                }
            }

            // Byte / C strings: b"...", c"..."
            if (b == b'b' || b == b'c') && i + 1 < bytes.len() && bytes[i + 1] == b'"' {
                i = skip_quoted_string(bytes, i + 2);
                continue;
            }
            // Byte char literal: b'...'
            if b == b'b' && i + 1 < bytes.len() && bytes[i + 1] == b'\\'' {
                i += 1;
                continue;
            }
            // Raw identifier: r#ident
            if b == b'r'
                && i + 2 < bytes.len()
                && bytes[i + 1] == b'#'
                && is_rust_ident_start(bytes[i + 2])
            {
                let start = i;
                i += 3;
                while i < bytes.len() && is_rust_ident_continue(bytes[i]) {
                    i += 1;
                }
                out.insert(source[start..i].to_string());
                continue;
            }
        }

        // Normal string literal: "..."
        if b == b'"' {
            i = skip_quoted_string(bytes, i + 1);
            continue;
        }

        // Char literal ('x', '\\'', '\\u{...}') vs lifetime ('a, 'static)
        if b == b'\\'' {
            if i + 1 < bytes.len() && bytes[i + 1] == b'\\\\' {
                i += 2;
                while i < bytes.len() && bytes[i] != b'\\'' && bytes[i] != b'\\n' {
                    if bytes[i] == b'\\\\' && i + 1 < bytes.len() {
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                if i < bytes.len() && bytes[i] == b'\\'' {
                    i += 1;
                }
                continue;
            }
            if let Some(ch) = source[i + 1..].chars().next() {
                let after = i + 1 + ch.len_utf8();
                if ch != '\\'' && ch != '\\n' && ch != '\\r' && bytes.get(after) == Some(&b'\\'') {
                    i = after + 1;
                    continue;
                }
            }
            // Lifetime: skip \`'\` and its identifier so \`'foo\` never counts as calling \`foo\`.
            i += 1;
            if i < bytes.len() && is_rust_ident_start(bytes[i]) {
                while i < bytes.len() && is_rust_ident_continue(bytes[i]) {
                    i += 1;
                }
            }
            continue;
        }

        if is_rust_ident_start(b) {
            let start = i;
            i += 1;
            while i < bytes.len() && is_rust_ident_continue(bytes[i]) {
                i += 1;
            }
            out.insert(source[start..i].to_string());
            continue;
        }

        i += 1;
    }
}

fn skip_quoted_string(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() {
        if bytes[i] == b'\\\\' && i + 1 < bytes.len() {
            i += 2;
            continue;
        }
        if bytes[i] == b'"' {
            return i + 1;
        }
        i += 1;
    }
    bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static CSEQ: AtomicUsize = AtomicUsize::new(0);

    fn tmp_crate(tag: &str) -> PathBuf {
        let n = CSEQ.fetch_add(1, Ordering::SeqCst);
        let dir = env::temp_dir().join(format!("rb_cov_{tag}_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("verified")).unwrap();
        fs::create_dir_all(dir.join("src")).unwrap();
        dir
    }

    #[test]
    fn coverage_flags_uncovered_functions_and_laws_naming_only_unmentioned_functions() {
        let root = tmp_crate("issue21_repro");
        let ledger = root.join("verified/ledger.bend");
        fs::write(
            &ledger,
            r#"import Base

def order_fits(+used: Nat, +want: Nat, +cap: Nat) -> Bool:
  Nat.is_le(want, Nat.sub(cap, used))

def order_fits_spec(+used: Nat, +want: Nat, +cap: Nat) -> Bool:
  Nat.is_le(Nat.add(used, want), cap)

def round_up(+x: Nat, +step: Nat) -> Nat:
  Nat.mul(Nat.div(Nat.add(x, Nat.sub(step, 1n)), step), step)

# promise: an empty order always fits
law order_fits_empty:
  for +cap: Nat
  {order_fits_spec(0n, 0n, cap) == True{} : Bool}
"#,
        )
        .unwrap();
        fs::write(
            root.join("src/main.rs"),
            r#"mod verified {
    include!(concat!(env!("OUT_DIR"), "/verified.rs"));
}
fn main() {
    let ok = verified::order_fits(3, 4, 10);
    let n = verified::round_up(5, 4);
    println!("{ok} {n}");
}
"#,
        )
        .unwrap();

        let report = analyze_coverage_dir(&root.join("verified"), Some(&root)).unwrap();
        assert!(report.rust_scanned);
        assert_eq!(report.uncovered_functions, vec!["order_fits", "round_up"]);
        assert_eq!(report.laws_only_unmentioned, vec!["order_fits_empty"]);

        let spec_cov = report
            .functions
            .iter()
            .find(|f| f.name == "order_fits_spec")
            .unwrap();
        assert_eq!(spec_cov.direct_laws, vec!["order_fits_empty"]);
        assert_eq!(spec_cov.mentioned_in_rust, Some(false));

        let fits_cov = report
            .functions
            .iter()
            .find(|f| f.name == "order_fits")
            .unwrap();
        assert!(fits_cov.direct_laws.is_empty());
        assert!(fits_cov.cone_laws.is_empty());
        assert_eq!(fits_cov.mentioned_in_rust, Some(true));

        let lines = format_coverage_report(&report);
        assert!(lines
            .iter()
            .any(|l| l.contains("uncovered functions]: order_fits, round_up")));
        assert!(lines
            .iter()
            .any(|l| l.contains("[law order_fits_empty]: names only functions not mentioned in Rust sources: order_fits_spec")));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn coverage_tracks_transitive_cones_bridging_laws_and_exs_laws() {
        let root = tmp_crate("cones_and_bridge");
        fs::write(
            root.join("verified/core.bend"),
            r#"import Base

def helper_inner(+x: Nat) -> Nat:
  Nat.add(x, 1n)

def outer(+x: Nat) -> Nat:
  helper_inner(x)

def outer_spec(+x: Nat) -> Nat:
  Nat.add(1n, x)

def orphan(+x: Nat) -> Nat:
  x

# promise: outer equals outer_spec
law outer_matches_spec:
  for +x: Nat
  {outer(x) == outer_spec(x) : Nat}

# promise: some input maps to two via helper_inner
law some_two:
  exs x: Nat
  {helper_inner(x) == 2n : Nat}
"#,
        )
        .unwrap();
        fs::write(
            root.join("src/main.rs"),
            "fn main() { let _ = verified::outer(1); }\\n",
        )
        .unwrap();

        let report = analyze_coverage_dir(&root.join("verified"), Some(&root)).unwrap();
        assert_eq!(report.uncovered_functions, vec!["orphan"]);
        // outer_matches_spec names both outer (mentioned) and outer_spec (unmentioned) -> NOT in laws_only_unmentioned.
        // some_two names only helper_inner, which main.rs does not call directly.
        assert_eq!(report.laws_only_unmentioned, vec!["some_two"]);

        let inner = report
            .functions
            .iter()
            .find(|f| f.name == "helper_inner")
            .unwrap();
        assert_eq!(inner.direct_laws, vec!["some_two"]);
        assert_eq!(inner.cone_laws, vec!["outer_matches_spec", "some_two"]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rust_lexer_ignores_comments_strings_lifetimes_and_distinguishes_keyword_idents() {
        let root = tmp_crate("lexer_edges");
        fs::write(
            root.join("verified/core.bend"),
            r#"import Base

def loop(+n: Nat) -> Nat:
  Nat.add(n, 1n)

def self(+n: Nat) -> Nat:
  Nat.add(n, 2n)

def a(+n: Nat) -> Nat:
  n

def hidden_in_comment(+n: Nat) -> Nat:
  n

# promise: loop adds one
law loop_ok:
  for +n: Nat
  {loop(n) == Nat.add(n, 1n) : Nat}

# promise: self adds two
law self_ok:
  for +n: Nat
  {self(n) == Nat.add(n, 2n) : Nat}

# promise: a is identity
law a_ok:
  for +n: Nat
  {a(n) == n : Nat}

# promise: hidden_in_comment is identity
law hidden_ok:
  for +n: Nat
  {hidden_in_comment(n) == n : Nat}
"#,
        )
        .unwrap();

        // Notice:
        // - \`loop { break; }\` and \`&self\` must NOT count as \`r#loop\` or \`__rb_self\`.
        // - \`&'a str\` must NOT count as \`a\`.
        // - comments, strings, raw strings, and char literals mentioning \`hidden_in_comment\` must be ignored.
        // - \`verified::r#loop(1)\` DOES mention \`def loop\`.
        fs::write(
            root.join("src/lib.rs"),
            r#####"
struct Holder;
impl Holder {
    fn demo<'a>(&self, _s: &'a str) {
        // hidden_in_comment
        /* nested /* hidden_in_comment */ comment */
        let _s1 = "hidden_in_comment \\"escaped\\"";
        let _s2 = r#"hidden_in_comment"#;
        let _c1 = '\\'';
        let _c2 = '\\\\';
        loop {
            let _ = verified::r#loop(1);
            break;
        }
    }
}
"#####,
        )
        .unwrap();

        let report = analyze_coverage_dir(&root.join("verified"), Some(&root)).unwrap();
        let by_fn: HashMap<&str, &FunctionCoverage> = report
            .functions
            .iter()
            .map(|f| (f.name.as_str(), f))
            .collect();
        assert_eq!(by_fn["loop"].mentioned_in_rust, Some(true));
        assert_eq!(by_fn["self"].mentioned_in_rust, Some(false));
        assert_eq!(by_fn["a"].mentioned_in_rust, Some(false));
        assert_eq!(by_fn["hidden_in_comment"].mentioned_in_rust, Some(false));
        assert_eq!(
            report.laws_only_unmentioned,
            vec!["a_ok", "hidden_ok", "self_ok"]
        );

        let _ = fs::remove_dir_all(&root);
    }
}
`;

  const buildCrateLawsBin = `use std::env;
use std::path::{Path, PathBuf};
use std::process;

fn infer_crate_root(verified_dir: &Path) -> Option<PathBuf> {
    let parent = match verified_dir.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    if rusty_bends_build::coverage::has_rust_source_dirs(&parent) {
        Some(parent)
    } else {
        None
    }
}

fn run_cli(args: &[String]) -> Result<Vec<String>, (i32, String)> {
    let mut coverage_mode = false;
    let mut no_rust_scan = false;
    let mut crate_root: Option<PathBuf> = None;
    let mut dir_arg: Option<PathBuf> = None;

    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "-h" | "--help" => {
                return Ok(vec![
                    "Usage: rusty-bends-laws [--coverage [--crate-root DIR | --no-rust-scan]] [VERIFIED_DIR]".to_string(),
                    "Lists every Bend 2 law as '<name>: <promise>', or with --coverage lists".to_string(),
                    "which emitted functions each law reaches and which laws name only uncalled functions.".to_string(),
                ]);
            }
            "--coverage" => coverage_mode = true,
            "--no-rust-scan" => no_rust_scan = true,
            "--crate-root" => {
                i += 1;
                let Some(val) = args.get(i) else {
                    return Err((2, "Missing argument for --crate-root".to_string()));
                };
                crate_root = Some(PathBuf::from(val));
            }
            _ if arg.starts_with("--crate-root=") => {
                let val = &arg["--crate-root=".len()..];
                crate_root = Some(PathBuf::from(val));
            }
            _ if arg.starts_with('-') => {
                return Err((2, format!("Unknown option '{arg}' (see --help)")));
            }
            _ => {
                if dir_arg.is_some() {
                    return Err((2, format!("Unexpected extra argument '{arg}'")));
                }
                dir_arg = Some(PathBuf::from(arg));
            }
        }
        i += 1;
    }

    let dir = dir_arg.unwrap_or_else(|| PathBuf::from("verified"));
    if !dir.exists() {
        return Err((
            1,
            format!(
                "[E_NO_VERIFIED_DIR] Directory '{}' does not exist.",
                dir.display()
            ),
        ));
    }

    let mut files = Vec::new();
    if let Err(err) = rusty_bends_build::collect_bend_files(&dir, &mut files) {
        return Err((1, format!("Failed to scan '{}': {err}", dir.display())));
    }
    files.sort();
    if files.is_empty() {
        return Err((
            1,
            format!(
                "[E_NO_BEND_FILES] No .bend files found under '{}'.",
                dir.display()
            ),
        ));
    }

    if coverage_mode {
        let root_opt = if no_rust_scan {
            None
        } else if crate_root.is_some() {
            crate_root
        } else {
            infer_crate_root(&dir)
        };
        let report = rusty_bends_build::coverage::analyze_coverage_dir(&dir, root_opt.as_deref())
            .map_err(|err| (1, format!("Failed to analyze coverage: {err}")))?;
        return Ok(rusty_bends_build::coverage::format_coverage_report(&report));
    }

    let laws = rusty_bends_build::lock::extract_canonical_laws(&files)
        .map_err(|err| (1, format!("Failed to extract laws: {err}")))?;
    let listing = rusty_bends_build::lock::format_law_list(&laws);
    if listing.is_empty() {
        Ok(Vec::new())
    } else {
        Ok(listing.lines().map(ToOwned::to_owned).collect())
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match run_cli(&args) {
        Ok(lines) => {
            for line in lines {
                println!("{line}");
            }
        }
        Err((code, msg)) => {
            eprintln!("{msg}");
            process::exit(code);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static BSEQ: AtomicUsize = AtomicUsize::new(0);

    fn tmp_dir(tag: &str) -> PathBuf {
        let n = BSEQ.fetch_add(1, Ordering::SeqCst);
        let dir = env::temp_dir().join(format!("rb_laws_bin_{tag}_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("verified")).unwrap();
        fs::create_dir_all(dir.join("src")).unwrap();
        dir
    }

    #[test]
    fn cli_coverage_flag_infers_crate_root_and_supports_no_rust_scan() {
        let root = tmp_dir("cov_cli");
        fs::write(
            root.join("verified/ledger.bend"),
            r#"import Base

def order_fits(+used: Nat, +want: Nat, +cap: Nat) -> Bool:
  Nat.is_le(want, Nat.sub(cap, used))

def order_fits_spec(+used: Nat, +want: Nat, +cap: Nat) -> Bool:
  Nat.is_le(Nat.add(used, want), cap)

# promise: an empty order always fits
law order_fits_empty:
  for +cap: Nat
  {order_fits_spec(0n, 0n, cap) == True{} : Bool}
"#,
        )
        .unwrap();
        fs::write(
            root.join("src/main.rs"),
            "fn main() { let _ = verified::order_fits(3, 4, 10); }\\n",
        )
        .unwrap();

        let verified_str = root.join("verified").to_string_lossy().into_owned();

        // Default listing mode unchanged.
        let list_out = run_cli(std::slice::from_ref(&verified_str)).unwrap();
        assert_eq!(
            list_out,
            vec!["order_fits_empty: an empty order always fits"]
        );

        // --coverage infers \`root\` from \`root/verified\` because \`root/src\` exists.
        let cov_out = run_cli(&["--coverage".to_string(), verified_str.clone()]).unwrap();
        assert!(
            cov_out
                .iter()
                .any(|l| l.contains("uncovered functions]: order_fits")),
            "{cov_out:?}"
        );
        assert!(
            cov_out
                .iter()
                .any(|l| l.contains("[law order_fits_empty]: names only functions not mentioned in Rust sources: order_fits_spec")),
            "{cov_out:?}"
        );

        // --no-rust-scan omits Rust call-site scanning.
        let no_rust = run_cli(&[
            "--coverage".to_string(),
            "--no-rust-scan".to_string(),
            verified_str,
        ])
        .unwrap();
        assert!(!no_rust.iter().any(|l| l.contains("rust=")), "{no_rust:?}");

        let _ = fs::remove_dir_all(&root);
    }
}
`;

  const bendPinFile = `# Optional Bend 2 compiler version pin (uncomment a version prefix to enforce in CI/local builds).
# Example:
# 2.0.40
#
# When uncommented (or when BEND_PIN_VERSION is set), rusty-bends-build runs 'bend version'
# and fails fast with E_BEND_VERSION_MISMATCH if upstream Bend 2 drifts unexpectedly.
`;

  const exampleCargo = `[package]
name = "my-verified-app"
version = "0.1.0"
edition = "2021"

[dependencies]
# Pure Rust runtime dependencies only — NO Bend 2 or proof libraries here!

[build-dependencies]
rusty-bends-build = { path = "../rusty-bends-build" }
`;

  const exampleBuildRs = `fn main() {
    // 1. Checks bend.pin / BEND_PIN_VERSION (if configured)
    // 2. Enforces token-canonical rusty-bends.lock (anti-cheat LAWS lock)
    // 3. Runs real 'bend --check-only' + 'bend --verdict' on verified/*.bend
    // 4. Erases q=0 types/laws and emits pure Rust (ADTs + match + defs) into OUT_DIR/verified.rs
    rusty_bends_build::verify_and_emit("verified");
}
`;

  const exampleBendCore = `# Real Bend 2 Verified Core (bendlang/bend 2.0.17+ syntax)
# Verified at Cargo build time with 'bend <file> --check-only' and '--verdict'.
# Every law and its matching proof def are erased before Rust emission.

import Base

type OrderState is Data:
  Draft{}
  Paid{amount: Nat}
  Shipped{amount: Nat}
  Cancelled{}

def deposit(bal: Nat, amt: Nat) -> Nat:
  Nat.add(bal, amt)

def minus_two(n: Nat) -> Nat:
  match n:
    case 0n:
      0n
    case 1n:
      0n
    case 1n+1n+q:
      q

# Multi-line parameter lists are valid Bend 2 and emit like single-line headers.
def is_between(
  +lo: Nat,
  +x: Nat,
  hi: Nat
) -> Bool:
  (lo <= x : Nat) && (x <= hi : Nat)

def cancel_order(s: OrderState) -> OrderState:
  match s:
    case Draft{}:
      Cancelled{}
    case Paid{amt}:
      Cancelled{}
    case Shipped{amt}:
      Shipped{amt}
    case Cancelled{}:
      Cancelled{}

# LAW 1: depositing into an empty balance equals amt (definitional)
# promise: depositing into a zero balance yields the deposited amount unchanged
# harm: an initial deposit could lose or inflate customer funds
law deposit_from_zero:
  for amt: Nat
  {deposit(0n, amt) == amt : Nat}

def deposit_from_zero(amt):
  {==}

# LAW 2: depositing 0n leaves any balance unchanged (inductive proof)
# promise: depositing zero leaves any existing balance unchanged
# harm: zero-value deposits could corrupt account balances
law deposit_zero:
  for bal: Nat
  {deposit(bal, 0n) == bal : Nat}

def deposit_zero(bal):
  match bal:
    case 0n:
      {==}
    case 1n+p:
      %deposit_zero(p) : {1n+Nat.add(p, 0n) == 1n+_ : Nat}
      {==}

# LAW 3: cancelling an order is idempotent across every ADT state
# promise: cancelling an order twice produces the same state as cancelling it once
# harm: retrying a cancel request could transition an order into an invalid state
law cancel_idempotent:
  for s: OrderState
  {cancel_order(cancel_order(s)) == cancel_order(s) : OrderState}

def cancel_idempotent(s):
  match s:
    case Draft{}:
      {==}
    case Paid{amt}:
      {==}
    case Shipped{amt}:
      {==}
    case Cancelled{}:
      {==}
`;

  const exampleMainRs = `//! Rust Shell: handles I/O, HTTP, DB, and CLI.
//! Calls pure verified types and functions emitted into OUT_DIR/verified.rs at build time.

#[allow(dead_code)]
mod verified {
    include!(concat!(env!("OUT_DIR"), "/verified.rs"));
}

fn main() {
    let total = verified::deposit(100, 25);
    let cancelled = verified::cancel_order(verified::OrderState::Paid(total));
    let shipped = verified::cancel_order(verified::OrderState::Shipped(total));
    let reuse = verified::is_between(4, 8, 16);
    println!(
        "RustyBends v1 Verified Core OK -> deposit(100, 25) = {total}, cancel(Paid) = {cancelled:?}, cancel(Shipped) = {shipped:?}, is_between(4, 8, 16) = {reuse}"
    );
}

#[cfg(test)]
mod tests {
    use super::verified::{cancel_order, deposit, is_between, minus_two, OrderState};

    #[test]
    fn verified_module_runs_with_zero_runtime_proof_overhead() {
        assert_eq!(deposit(100, 25), 125);
        assert_eq!(minus_two(0), 0);
        assert_eq!(minus_two(1), 0);
        assert_eq!(minus_two(2), 0);
        assert_eq!(minus_two(5), 3);
        assert_eq!(cancel_order(OrderState::Paid(50)), OrderState::Cancelled);
        assert!(is_between(4, 8, 16));
        assert!(!is_between(9, 8, 16));
        assert!(!is_between(4, 8, 7));
        assert_eq!(
            cancel_order(OrderState::Shipped(50)),
            OrderState::Shipped(50)
        );
    }
}
`;

  const buildCrateNatLemmas = `# Shared Nat arithmetic & order lemmas for RustyBends verified cores.
# Import into any file under verified/ via:
#   import nat_lemmas.bend as L
# Every definition here is a q=0 proof/type helper and is completely erased before Rust codegen.

import Base

# ==============================================================================
# Ex falso / Bool refutation
# ==============================================================================

def bool_pick_type(b: Bool, t: Type, f: Type) -> Type:
  match b:
    case True{}:
      t
    case False{}:
      f

def bool_false_ne_true(h: {False{} == True{} : Bool}) -> Empty:
  %h : bool_pick_type(_, Empty, Unit)
  Unit{}

def bool_true_ne_false(h: {True{} == False{} : Bool}) -> Empty:
  %h : bool_pick_type(_, Unit, Empty)
  Unit{}

def bool_absurd(-A: Type, h: {False{} == True{} : Bool}) -> A:
  Empty.absurd(A, bool_false_ne_true(h))

def bool_absurd_tf(-A: Type, h: {True{} == False{} : Bool}) -> A:
  Empty.absurd(A, bool_true_ne_false(h))

# ==============================================================================
# Order (Nat.is_le, Nat.is_lt, Nat.min, Nat.max)
# ==============================================================================

def nat_le_refl(a: Nat) -> {Nat.is_le(a, a) == True{} : Bool}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      nat_le_refl(ap)

def nat_le_zero(b: Nat) -> {Nat.is_le(0n, b) == True{} : Bool}:
  match b:
    case 0n:
      {==}
    case 1n+bp:
      {==}

def nat_le_succ_r(a: Nat, b: Nat, h: {Nat.is_le(a, b) == True{} : Bool}) -> {Nat.is_le(a, 1n+b) == True{} : Bool}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      match b:
        case 0n:
          bool_absurd({Nat.is_le(1n+ap, 1n) == True{} : Bool}, h)
        case 1n+bp:
          nat_le_succ_r(ap, bp, h)

def nat_lt_succ_self(a: Nat) -> {Nat.is_lt(a, 1n+a) == True{} : Bool}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      nat_lt_succ_self(ap)

def nat_lt_succ_eq_le(a: Nat, b: Nat) -> {Nat.is_lt(a, 1n+b) == Nat.is_le(a, b) : Bool}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      {==}
    case 1n 0n:
      {==}
    case 1n+1n+app 0n:
      {==}
    case 1n+ap 1n+bp:
      nat_lt_succ_eq_le(ap, bp)

def nat_lt_imp_le(a: Nat, b: Nat, h: {Nat.is_lt(a, b) == True{} : Bool}) -> {Nat.is_le(a, b) == True{} : Bool}:
  match a b:
    case 0n 0n:
      bool_absurd({Nat.is_le(0n, 0n) == True{} : Bool}, h)
    case 0n 1n+bp:
      {==}
    case 1n+ap 0n:
      bool_absurd({Nat.is_le(1n+ap, 0n) == True{} : Bool}, h)
    case 1n+ap 1n+bp:
      nat_lt_imp_le(ap, bp, h)

def nat_not_lt_imp_le(a: Nat, b: Nat, h: {Nat.is_lt(a, b) == False{} : Bool}) -> {Nat.is_le(b, a) == True{} : Bool}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      bool_absurd_tf({Nat.is_le(1n+bp, 0n) == True{} : Bool}, h)
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+bp:
      nat_not_lt_imp_le(ap, bp, h)

def nat_le_subst_r(-x: Nat, -y: Nat, -z: Nat, eq_yz: {y == z : Nat}, h: {Nat.is_le(x, y) == True{} : Bool}) -> {Nat.is_le(x, z) == True{} : Bool}:
  %eq_yz : {Nat.is_le(x, _) == True{} : Bool}
  h

def nat_lt_subst_r(-x: Nat, -y: Nat, -z: Nat, eq_yz: {y == z : Nat}, h: {Nat.is_lt(x, y) == True{} : Bool}) -> {Nat.is_lt(x, z) == True{} : Bool}:
  %eq_yz : {Nat.is_lt(x, _) == True{} : Bool}
  h

def nat_lt_subst_l(-a: Nat, -b: Nat, -c: Nat, eq_ab: {a == b : Nat}, h: {Nat.is_lt(a, c) == True{} : Bool}) -> {Nat.is_lt(b, c) == True{} : Bool}:
  %eq_ab : {Nat.is_lt(_, c) == True{} : Bool}
  h

def nat_le_trans(
  a: Nat,
  b: Nat,
  c: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool},
  bc: {Nat.is_le(b, c) == True{} : Bool}
) -> {Nat.is_le(a, c) == True{} : Bool}:
  match a:
    case 0n:
      nat_le_zero(c)
    case 1n+ap:
      match b:
        case 0n:
          bool_absurd({Nat.is_le(1n+ap, c) == True{} : Bool}, ab)
        case 1n+bp:
          match c:
            case 0n:
              bool_absurd({Nat.is_le(1n+ap, 0n) == True{} : Bool}, bc)
            case 1n+cp:
              nat_le_trans(ap, bp, cp, ab, bc)

def nat_lt_trans(
  a: Nat,
  b: Nat,
  c: Nat,
  ab: {Nat.is_lt(a, b) == True{} : Bool},
  bc: {Nat.is_lt(b, c) == True{} : Bool}
) -> {Nat.is_lt(a, c) == True{} : Bool}:
  match a:
    case 0n:
      match b:
        case 0n:
          bool_absurd({Nat.is_lt(0n, c) == True{} : Bool}, ab)
        case 1n+bp:
          match c:
            case 0n:
              bool_absurd({Nat.is_lt(0n, 0n) == True{} : Bool}, bc)
            case 1n+cp:
              {==}
    case 1n+ap:
      match b:
        case 0n:
          bool_absurd({Nat.is_lt(1n+ap, c) == True{} : Bool}, ab)
        case 1n+bp:
          match c:
            case 0n:
              bool_absurd({Nat.is_lt(1n+ap, 0n) == True{} : Bool}, bc)
            case 1n+cp:
              nat_lt_trans(ap, bp, cp, ab, bc)

def nat_lt_le_trans(
  a: Nat,
  b: Nat,
  c: Nat,
  ab: {Nat.is_lt(a, b) == True{} : Bool},
  bc: {Nat.is_le(b, c) == True{} : Bool}
) -> {Nat.is_lt(a, c) == True{} : Bool}:
  match a:
    case 0n:
      match b:
        case 0n:
          bool_absurd({Nat.is_lt(0n, c) == True{} : Bool}, ab)
        case 1n+bp:
          match c:
            case 0n:
              bool_absurd({Nat.is_lt(0n, 0n) == True{} : Bool}, bc)
            case 1n+cp:
              {==}
    case 1n+ap:
      match b:
        case 0n:
          bool_absurd({Nat.is_lt(1n+ap, c) == True{} : Bool}, ab)
        case 1n+bp:
          match c:
            case 0n:
              bool_absurd({Nat.is_lt(1n+ap, 0n) == True{} : Bool}, bc)
            case 1n+cp:
              nat_lt_le_trans(ap, bp, cp, ab, bc)

def nat_le_lt_trans(
  a: Nat,
  b: Nat,
  c: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool},
  bc: {Nat.is_lt(b, c) == True{} : Bool}
) -> {Nat.is_lt(a, c) == True{} : Bool}:
  match a:
    case 0n:
      match b:
        case 0n:
          bc
        case 1n+bp:
          match c:
            case 0n:
              bool_absurd({Nat.is_lt(0n, 0n) == True{} : Bool}, bc)
            case 1n+cp:
              {==}
    case 1n+ap:
      match b:
        case 0n:
          bool_absurd({Nat.is_lt(1n+ap, c) == True{} : Bool}, ab)
        case 1n+bp:
          match c:
            case 0n:
              bool_absurd({Nat.is_lt(1n+ap, 0n) == True{} : Bool}, bc)
            case 1n+cp:
              nat_le_lt_trans(ap, bp, cp, ab, bc)

def nat_lt_not_le(
  a: Nat,
  b: Nat,
  lt: {Nat.is_lt(a, b) == True{} : Bool},
  le: {Nat.is_le(b, a) == True{} : Bool}
) -> Empty:
  match a b:
    case 0n 0n:
      bool_false_ne_true(lt)
    case 0n 1n+bp:
      bool_false_ne_true(le)
    case 1n+ap 0n:
      bool_false_ne_true(lt)
    case 1n+ap 1n+bp:
      nat_lt_not_le(ap, bp, lt, le)

def nat_lt_le_false(
  a: Nat,
  b: Nat,
  lt: {Nat.is_lt(a, b) == True{} : Bool}
) -> {Nat.is_le(b, a) == False{} : Bool}:
  match a b:
    case 0n 0n:
      bool_absurd({Nat.is_le(0n, 0n) == False{} : Bool}, lt)
    case 0n 1n+bp:
      {==}
    case 1n+ap 0n:
      bool_absurd({Nat.is_le(0n, 1n+ap) == False{} : Bool}, lt)
    case 1n+ap 1n+bp:
      nat_lt_le_false(ap, bp, lt)

def nat_le_lt_false(
  a: Nat,
  b: Nat,
  le: {Nat.is_le(b, a) == True{} : Bool}
) -> {Nat.is_lt(a, b) == False{} : Bool}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      bool_absurd({Nat.is_lt(0n, 1n+bp) == False{} : Bool}, le)
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+bp:
      nat_le_lt_false(ap, bp, le)

def nat_le_antisym(
  a: Nat,
  b: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool},
  ba: {Nat.is_le(b, a) == True{} : Bool}
) -> {a == b : Nat}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      bool_absurd({0n == 1n+bp : Nat}, ba)
    case 1n+ap 0n:
      bool_absurd({1n+ap == 0n : Nat}, ab)
    case 1n+ap 1n+bp:
      %nat_le_antisym(ap, bp, ab, ba) : {1n+ap == 1n+_ : Nat}
      {==}

def nat_min_le_l.go(+a: Nat, +b: Nat) -> {Nat.is_le(Nat.min(a, b), a) == True{} : Bool}:
  match a b:
    case 0n _:
      {==}
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+bp:
      nat_min_le_l.go(ap, bp)

def nat_min_le_l(a: Nat, b: Nat) -> {Nat.is_le(Nat.min(a, b), a) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_min_le_l.go(a2, b2)

def nat_min_le_r.go(+a: Nat, +b: Nat) -> {Nat.is_le(Nat.min(a, b), b) == True{} : Bool}:
  match a b:
    case 0n _:
      nat_le_zero(b)
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+bp:
      nat_min_le_r.go(ap, bp)

def nat_min_le_r(a: Nat, b: Nat) -> {Nat.is_le(Nat.min(a, b), b) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_min_le_r.go(a2, b2)

def nat_max_ge_l.go(+a: Nat, +b: Nat) -> {Nat.is_le(a, Nat.max(a, b)) == True{} : Bool}:
  match a b:
    case 0n _:
      nat_le_zero(Nat.max(0n, b))
    case 1n+ap 0n:
      nat_le_refl(1n+ap)
    case 1n+ap 1n+bp:
      nat_max_ge_l.go(ap, bp)

def nat_max_ge_l(a: Nat, b: Nat) -> {Nat.is_le(a, Nat.max(a, b)) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_max_ge_l.go(a2, b2)

def nat_max_ge_r.go(+a: Nat, +b: Nat) -> {Nat.is_le(b, Nat.max(a, b)) == True{} : Bool}:
  match a b:
    case 0n _:
      nat_le_refl(b)
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+bp:
      nat_max_ge_r.go(ap, bp)

def nat_max_ge_r(a: Nat, b: Nat) -> {Nat.is_le(b, Nat.max(a, b)) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_max_ge_r.go(a2, b2)

def nat_min_comm.go(+a: Nat, +b: Nat) -> {Nat.min(a, b) == Nat.min(b, a) : Nat}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      {==}
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+bp:
      %nat_min_comm.go(ap, bp) : {1n+Nat.min(ap, bp) == 1n+_ : Nat}
      {==}

def nat_min_comm(a: Nat, b: Nat) -> {Nat.min(a, b) == Nat.min(b, a) : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_min_comm.go(a2, b2)

def nat_max_comm.go(+a: Nat, +b: Nat) -> {Nat.max(a, b) == Nat.max(b, a) : Nat}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      {==}
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+bp:
      %nat_max_comm.go(ap, bp) : {1n+Nat.max(ap, bp) == 1n+_ : Nat}
      {==}

def nat_max_comm(a: Nat, b: Nat) -> {Nat.max(a, b) == Nat.max(b, a) : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_max_comm.go(a2, b2)

# ==============================================================================
# Addition & subtraction
# ==============================================================================

def nat_add_zero_r(a: Nat) -> {Nat.add(a, 0n) == a : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %nat_add_zero_r(ap) : {1n+Nat.add(ap, 0n) == 1n+_ : Nat}
      {==}

def nat_add_succ_r(a: Nat, -b: Nat) -> {Nat.add(a, 1n+b) == 1n+Nat.add(a, b) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %nat_add_succ_r(ap, b) : {1n+Nat.add(ap, 1n+b) == 1n+_ : Nat}
      {==}

def nat_add_comm.go(a: Nat, +b: Nat) -> {Nat.add(a, b) == Nat.add(b, a) : Nat}:
  match a:
    case 0n:
      Equal.sym(Nat, Nat.add(b, 0n), b, nat_add_zero_r(b))
    case 1n+ap:
      %Equal.sym(Nat, Nat.add(b, 1n+ap), 1n+Nat.add(b, ap), nat_add_succ_r(b, ap)) : {1n+Nat.add(ap, b) == _ : Nat}
      %nat_add_comm.go(ap, b) : {1n+Nat.add(ap, b) == 1n+_ : Nat}
      {==}

def nat_add_comm(a: Nat, b: Nat) -> {Nat.add(a, b) == Nat.add(b, a) : Nat}:
  +b2 = {b : Nat}
  nat_add_comm.go(a, b2)

def nat_add_assoc(a: Nat, -b: Nat, -c: Nat) -> {Nat.add(Nat.add(a, b), c) == Nat.add(a, Nat.add(b, c)) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %nat_add_assoc(ap, b, c) : {1n+Nat.add(Nat.add(ap, b), c) == 1n+_ : Nat}
      {==}

def nat_add_le_l.go(+bp: Nat, +d: Nat) -> {Nat.is_le(d, Nat.add(bp, d)) == True{} : Bool}:
  match bp:
    case 0n:
      nat_le_refl(d)
    case 1n+bpp:
      nat_le_succ_r(d, Nat.add(bpp, d), nat_add_le_l.go(bpp, d))

def nat_add_le_l(a: Nat, b: Nat) -> {Nat.is_le(b, Nat.add(a, b)) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_add_le_l.go(a2, b2)

def nat_add_le_r(a: Nat, b: Nat) -> {Nat.is_le(a, Nat.add(a, b)) == True{} : Bool}:
  match a:
    case 0n:
      nat_le_zero(b)
    case 1n+ap:
      nat_add_le_r(ap, b)

def nat_add_le_mono.go(
  a: Nat,
  +b: Nat,
  +c: Nat,
  +d: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool},
  cd: {Nat.is_le(c, d) == True{} : Bool}
) -> {Nat.is_le(Nat.add(a, c), Nat.add(b, d)) == True{} : Bool}:
  match a b:
    case 0n 0n:
      cd
    case 0n 1n+bp:
      nat_le_succ_r(c, Nat.add(bp, d), nat_add_le_mono.go(0n, bp, c, d, nat_le_zero(bp), cd))
    case 1n+ap 0n:
      bool_absurd({Nat.is_le(1n+Nat.add(ap, c), d) == True{} : Bool}, ab)
    case 1n+ap 1n+bp:
      nat_add_le_mono.go(ap, bp, c, d, ab, cd)

def nat_add_le_mono(
  a: Nat,
  b: Nat,
  c: Nat,
  d: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool},
  cd: {Nat.is_le(c, d) == True{} : Bool}
) -> {Nat.is_le(Nat.add(a, c), Nat.add(b, d)) == True{} : Bool}:
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  +d2 = {d : Nat}
  nat_add_le_mono.go(a, b2, c2, d2, ab, cd)

def nat_add_lt_le_mono.go(
  a: Nat,
  +b: Nat,
  +c: Nat,
  +d: Nat,
  ab: {Nat.is_lt(a, b) == True{} : Bool},
  cd: {Nat.is_le(c, d) == True{} : Bool}
) -> {Nat.is_lt(Nat.add(a, c), Nat.add(b, d)) == True{} : Bool}:
  match a b:
    case 0n 0n:
      bool_absurd({Nat.is_lt(c, d) == True{} : Bool}, ab)
    case 0n 1n+bp:
      %Equal.sym(Bool, Nat.is_lt(c, 1n+Nat.add(bp, d)), Nat.is_le(c, Nat.add(bp, d)), nat_lt_succ_eq_le(c, Nat.add(bp, d))) : {_ == True{} : Bool}
      nat_le_trans(c, d, Nat.add(bp, d), cd, nat_add_le_l(bp, d))
    case 1n+ap 0n:
      bool_absurd({Nat.is_lt(1n+Nat.add(ap, c), d) == True{} : Bool}, ab)
    case 1n+ap 1n+bp:
      nat_add_lt_le_mono.go(ap, bp, c, d, ab, cd)

def nat_add_lt_le_mono(
  a: Nat,
  b: Nat,
  c: Nat,
  d: Nat,
  ab: {Nat.is_lt(a, b) == True{} : Bool},
  cd: {Nat.is_le(c, d) == True{} : Bool}
) -> {Nat.is_lt(Nat.add(a, c), Nat.add(b, d)) == True{} : Bool}:
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  +d2 = {d : Nat}
  nat_add_lt_le_mono.go(a, b2, c2, d2, ab, cd)

def nat_sub_zero_r(a: Nat) -> {Nat.sub(a, 0n) == a : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      {==}

def nat_sub_self(a: Nat) -> {Nat.sub(a, a) == 0n : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      nat_sub_self(ap)

def nat_add_sub_cancel_l(a: Nat, b: Nat) -> {Nat.sub(Nat.add(a, b), a) == b : Nat}:
  match a:
    case 0n:
      nat_sub_zero_r(b)
    case 1n+ap:
      nat_add_sub_cancel_l(ap, b)

def nat_add_sub_cancel_r(a: Nat, b: Nat) -> {Nat.sub(Nat.add(a, b), b) == a : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  %nat_add_comm(b2, a2) : {Nat.sub(_, b2) == a2 : Nat}
  nat_add_sub_cancel_l(b2, a2)

def nat_sub_add_cancel.go(
  +a: Nat,
  +b: Nat,
  h: {Nat.is_le(b, a) == True{} : Bool}
) -> {Nat.add(Nat.sub(a, b), b) == a : Nat}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      bool_absurd({1n+bp == 0n : Nat}, h)
    case 1n+ap 0n:
      nat_add_zero_r(1n+ap)
    case 1n+ap 1n+bp:
      %Equal.sym(Nat, Nat.add(Nat.sub(ap, bp), 1n+bp), 1n+Nat.add(Nat.sub(ap, bp), bp), nat_add_succ_r(Nat.sub(ap, bp), bp)) : {_ == 1n+ap : Nat}
      %nat_sub_add_cancel.go(ap, bp, h) : {1n+Nat.add(Nat.sub(ap, bp), bp) == 1n+_ : Nat}
      {==}

def nat_sub_add_cancel(
  a: Nat,
  b: Nat,
  h: {Nat.is_le(b, a) == True{} : Bool}
) -> {Nat.add(Nat.sub(a, b), b) == a : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_sub_add_cancel.go(a2, b2, h)

def nat_le_add_add(b: Nat, x: Nat, y: Nat) -> {Nat.is_le(b, Nat.add(Nat.add(b, x), y)) == True{} : Bool}:
  +b2 = {b : Nat}
  +x2 = {x : Nat}
  +y2 = {y : Nat}
  nat_le_trans(b2, Nat.add(b2, x2), Nat.add(Nat.add(b2, x2), y2), nat_add_le_r(b2, x2), nat_add_le_r(Nat.add(b2, x2), y2))

def nat_add_not_lt_l(b: Nat, x: Nat, h: {Nat.is_lt(Nat.add(b, x), b) == True{} : Bool}) -> Empty:
  +b2 = {b : Nat}
  +x2 = {x : Nat}
  nat_lt_not_le(Nat.add(b2, x2), b2, h, nat_add_le_r(b2, x2))

def nat_add_lt_l.go(
  k: Nat,
  +a: Nat,
  +b: Nat,
  h: {Nat.is_lt(a, b) == True{} : Bool}
) -> {Nat.is_lt(Nat.add(k, a), Nat.add(k, b)) == True{} : Bool}:
  match k:
    case 0n:
      h
    case 1n+kp:
      nat_add_lt_l.go(kp, a, b, h)

def nat_add_lt_l(
  k: Nat,
  a: Nat,
  b: Nat,
  h: {Nat.is_lt(a, b) == True{} : Bool}
) -> {Nat.is_lt(Nat.add(k, a), Nat.add(k, b)) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_add_lt_l.go(k, a2, b2, h)

def nat_add_cancel_l(k: Nat, x: Nat, y: Nat, e: {Nat.add(k, x) == Nat.add(k, y) : Nat}) -> {x == y : Nat}:
  +k2 = {k : Nat}
  +x2 = {x : Nat}
  +y2 = {y : Nat}
  %nat_add_sub_cancel_l(k2, x2) : {_ == y2 : Nat}
  %Equal.sym(Nat, Nat.add(k2, x2), Nat.add(k2, y2), e) : {Nat.sub(_, k2) == y2 : Nat}
  nat_add_sub_cancel_l(k2, y2)

def nat_sub_lt.go(
  +j: Nat,
  +k: Nat,
  +n: Nat,
  hn: {Nat.is_lt(0n, n) == True{} : Bool},
  h: {Nat.is_lt(j, Nat.add(k, n)) == True{} : Bool}
) -> {Nat.is_lt(Nat.sub(j, k), n) == True{} : Bool}:
  match j k:
    case 0n _:
      hn
    case 1n+jp 0n:
      h
    case 1n+jp 1n+kp:
      nat_sub_lt.go(jp, kp, n, hn, h)

def nat_sub_lt(
  j: Nat,
  k: Nat,
  n: Nat,
  hn: {Nat.is_lt(0n, n) == True{} : Bool},
  h: {Nat.is_lt(j, Nat.add(k, n)) == True{} : Bool}
) -> {Nat.is_lt(Nat.sub(j, k), n) == True{} : Bool}:
  +j2 = {j : Nat}
  +k2 = {k : Nat}
  +n2 = {n : Nat}
  nat_sub_lt.go(j2, k2, n2, hn, h)

# ==============================================================================
# Multiplication
# ==============================================================================

def nat_mul_zero_r(a: Nat) -> {Nat.mul(a, 0n) == 0n : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      nat_mul_zero_r(ap)

def nat_mul_one_r(a: Nat) -> {Nat.mul(a, 1n) == a : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %nat_mul_one_r(ap) : {1n+Nat.mul(ap, 1n) == 1n+_ : Nat}
      {==}

def nat_mul_succ_r.go(+a: Nat, +b: Nat) -> {Nat.mul(a, 1n+b) == Nat.add(a, Nat.mul(a, b)) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %Equal.sym(Nat, Nat.mul(ap, 1n+b), Nat.add(ap, Nat.mul(ap, b)), nat_mul_succ_r.go(ap, b)) : {1n+Nat.add(b, _) == 1n+Nat.add(ap, Nat.add(b, Nat.mul(ap, b))) : Nat}
      %nat_add_assoc(b, ap, Nat.mul(ap, b)) : {1n+_ == 1n+Nat.add(ap, Nat.add(b, Nat.mul(ap, b))) : Nat}
      %nat_add_comm(ap, b) : {1n+Nat.add(_, Nat.mul(ap, b)) == 1n+Nat.add(ap, Nat.add(b, Nat.mul(ap, b))) : Nat}
      %nat_add_assoc(ap, b, Nat.mul(ap, b)) : {1n+Nat.add(Nat.add(ap, b), Nat.mul(ap, b)) == 1n+_ : Nat}
      {==}

def nat_mul_succ_r(a: Nat, b: Nat) -> {Nat.mul(a, 1n+b) == Nat.add(a, Nat.mul(a, b)) : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_mul_succ_r.go(a2, b2)

def nat_mul_comm.go(+a: Nat, +b: Nat) -> {Nat.mul(a, b) == Nat.mul(b, a) : Nat}:
  match a:
    case 0n:
      Equal.sym(Nat, Nat.mul(b, 0n), 0n, nat_mul_zero_r(b))
    case 1n+ap:
      %Equal.sym(Nat, Nat.mul(b, 1n+ap), Nat.add(b, Nat.mul(b, ap)), nat_mul_succ_r(b, ap)) : {Nat.add(b, Nat.mul(ap, b)) == _ : Nat}
      %nat_mul_comm.go(ap, b) : {Nat.add(b, Nat.mul(ap, b)) == Nat.add(b, _) : Nat}
      {==}

def nat_mul_comm(a: Nat, b: Nat) -> {Nat.mul(a, b) == Nat.mul(b, a) : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_mul_comm.go(a2, b2)

def nat_mul_add_dist_r.go(a: Nat, +b: Nat, +c: Nat) -> {Nat.mul(Nat.add(a, b), c) == Nat.add(Nat.mul(a, c), Nat.mul(b, c)) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %Equal.sym(Nat, Nat.mul(Nat.add(ap, b), c), Nat.add(Nat.mul(ap, c), Nat.mul(b, c)), nat_mul_add_dist_r.go(ap, b, c)) : {Nat.add(c, _) == Nat.add(Nat.add(c, Nat.mul(ap, c)), Nat.mul(b, c)) : Nat}
      Equal.sym(Nat, Nat.add(Nat.add(c, Nat.mul(ap, c)), Nat.mul(b, c)), Nat.add(c, Nat.add(Nat.mul(ap, c), Nat.mul(b, c))), nat_add_assoc(c, Nat.mul(ap, c), Nat.mul(b, c)))

def nat_mul_add_dist_r(a: Nat, b: Nat, c: Nat) -> {Nat.mul(Nat.add(a, b), c) == Nat.add(Nat.mul(a, c), Nat.mul(b, c)) : Nat}:
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  nat_mul_add_dist_r.go(a, b2, c2)

def nat_mul_add_dist_l(a: Nat, b: Nat, c: Nat) -> {Nat.mul(a, Nat.add(b, c)) == Nat.add(Nat.mul(a, b), Nat.mul(a, c)) : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  %nat_mul_comm(Nat.add(b2, c2), a2) : {_ == Nat.add(Nat.mul(a2, b2), Nat.mul(a2, c2)) : Nat}
  %nat_mul_comm(b2, a2) : {Nat.mul(Nat.add(b2, c2), a2) == Nat.add(_, Nat.mul(a2, c2)) : Nat}
  %nat_mul_comm(c2, a2) : {Nat.mul(Nat.add(b2, c2), a2) == Nat.add(Nat.mul(b2, a2), _) : Nat}
  nat_mul_add_dist_r(b2, c2, a2)

def nat_mul_assoc.go(+a: Nat, +b: Nat, +c: Nat) -> {Nat.mul(Nat.mul(a, b), c) == Nat.mul(a, Nat.mul(b, c)) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %Equal.sym(Nat, Nat.mul(Nat.add(b, Nat.mul(ap, b)), c), Nat.add(Nat.mul(b, c), Nat.mul(Nat.mul(ap, b), c)), nat_mul_add_dist_r(b, Nat.mul(ap, b), c)) : {_ == Nat.add(Nat.mul(b, c), Nat.mul(ap, Nat.mul(b, c))) : Nat}
      %nat_mul_assoc.go(ap, b, c) : {Nat.add(Nat.mul(b, c), Nat.mul(Nat.mul(ap, b), c)) == Nat.add(Nat.mul(b, c), _) : Nat}
      {==}

def nat_mul_assoc(a: Nat, b: Nat, c: Nat) -> {Nat.mul(Nat.mul(a, b), c) == Nat.mul(a, Nat.mul(b, c)) : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  nat_mul_assoc.go(a2, b2, c2)

def nat_mul_le_mono_r.go(
  +a: Nat,
  +b: Nat,
  +c: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool}
) -> {Nat.is_le(Nat.mul(a, c), Nat.mul(b, c)) == True{} : Bool}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      nat_le_zero(Nat.add(c, Nat.mul(bp, c)))
    case 1n+ap 0n:
      bool_absurd({Nat.is_le(Nat.add(c, Nat.mul(ap, c)), 0n) == True{} : Bool}, ab)
    case 1n+ap 1n+bp:
      nat_add_le_mono(c, c, Nat.mul(ap, c), Nat.mul(bp, c), nat_le_refl(c), nat_mul_le_mono_r.go(ap, bp, c, ab))

def nat_mul_le_mono_r(
  a: Nat,
  b: Nat,
  c: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool}
) -> {Nat.is_le(Nat.mul(a, c), Nat.mul(b, c)) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  nat_mul_le_mono_r.go(a2, b2, c2, ab)

def nat_mul_le_mono_l(
  a: Nat,
  b: Nat,
  c: Nat,
  bc: {Nat.is_le(b, c) == True{} : Bool}
) -> {Nat.is_le(Nat.mul(a, b), Nat.mul(a, c)) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  %nat_mul_comm(b2, a2) : {Nat.is_le(_, Nat.mul(a2, c2)) == True{} : Bool}
  %nat_mul_comm(c2, a2) : {Nat.is_le(Nat.mul(b2, a2), _) == True{} : Bool}
  nat_mul_le_mono_r(b2, c2, a2, bc)

def nat_mul_le_mono(
  a: Nat,
  b: Nat,
  c: Nat,
  d: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool},
  cd: {Nat.is_le(c, d) == True{} : Bool}
) -> {Nat.is_le(Nat.mul(a, c), Nat.mul(b, d)) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  +d2 = {d : Nat}
  nat_le_trans(
    Nat.mul(a2, c2),
    Nat.mul(b2, c2),
    Nat.mul(b2, d2),
    nat_mul_le_mono_r(a2, b2, c2, ab),
    nat_mul_le_mono_l(b2, c2, d2, cd)
  )

# ==============================================================================
# Division & modulo (Nat.div, Nat.mod, Nat.divmod)
# ==============================================================================

def nat_divmod_go_mod_lt(
  n: Nat,
  +m: Nat,
  d: Nat,
  +r: Nat,
  +bp: Nat,
  eq_mr: {Nat.add(m, r) == bp : Nat}
) -> {Nat.is_lt(Pair.snd(Nat, Nat, Nat.divmod.go(n, m, d, r)), 1n+bp) == True{} : Bool}:
  match n:
    case 0n:
      %Equal.sym(Bool, Nat.is_lt(r, 1n+bp), Nat.is_le(r, bp), nat_lt_succ_eq_le(r, bp)) : {_ == True{} : Bool}
      %eq_mr : {Nat.is_le(r, _) == True{} : Bool}
      nat_add_le_l(m, r)
    case 1n+np:
      match m:
        case 0n:
          nat_divmod_go_mod_lt(np, r, 1n+d, 0n, bp, Equal.trans(Nat, Nat.add(r, 0n), r, bp, nat_add_zero_r(r), eq_mr))
        case 1n+mp:
          nat_divmod_go_mod_lt(
            np,
            mp,
            d,
            1n+r,
            bp,
            Equal.trans(Nat, Nat.add(mp, 1n+r), 1n+Nat.add(mp, r), bp, nat_add_succ_r(mp, r), eq_mr)
          )

# For b > 0, written as 1n+bp: a % (1n+bp) < 1n+bp
def nat_mod_lt(a: Nat, bp: Nat) -> {Nat.is_lt(Nat.mod(a, 1n+bp), 1n+bp) == True{} : Bool}:
  +bp2 = {bp : Nat}
  nat_divmod_go_mod_lt(a, bp2, 0n, 0n, bp2, nat_add_zero_r(bp2))

def nat_divmod_go_eq(
  +n: Nat,
  +m: Nat,
  +d: Nat,
  +r: Nat,
  +bp: Nat,
  +eq_mr: {Nat.add(m, r) == bp : Nat}
) -> {Nat.add(Pair.snd(Nat, Nat, Nat.divmod.go(n, m, d, r)), Nat.mul(Pair.fst(Nat, Nat, Nat.divmod.go(n, m, d, r)), 1n+bp)) == Nat.add(n, Nat.add(r, Nat.mul(d, 1n+bp))) : Nat}:
  match n:
    case 0n:
      {==}
    case 1n+np:
      match m:
        case 0n:
          ih = nat_divmod_go_eq(np, r, 1n+d, 0n, bp, Equal.trans(Nat, Nat.add(r, 0n), r, bp, nat_add_zero_r(r), eq_mr))
          %Equal.sym(Nat, r, bp, eq_mr) : {Nat.add(Pair.snd(Nat, Nat, Nat.divmod.go(np, r, 1n+d, 0n)), Nat.mul(Pair.fst(Nat, Nat, Nat.divmod.go(np, r, 1n+d, 0n)), 1n+bp)) == 1n+Nat.add(np, Nat.add(_, Nat.mul(d, 1n+bp))) : Nat}
          %nat_add_succ_r(np, Nat.add(bp, Nat.mul(d, 1n+bp))) : {Nat.add(Pair.snd(Nat, Nat, Nat.divmod.go(np, r, 1n+d, 0n)), Nat.mul(Pair.fst(Nat, Nat, Nat.divmod.go(np, r, 1n+d, 0n)), 1n+bp)) == _ : Nat}
          ih
        case 1n+mp:
          ih = nat_divmod_go_eq(
            np,
            mp,
            d,
            1n+r,
            bp,
            Equal.trans(Nat, Nat.add(mp, 1n+r), 1n+Nat.add(mp, r), bp, nat_add_succ_r(mp, r), eq_mr)
          )
          %nat_add_succ_r(np, Nat.add(r, Nat.mul(d, 1n+bp))) : {Nat.add(Pair.snd(Nat, Nat, Nat.divmod.go(np, mp, d, 1n+r)), Nat.mul(Pair.fst(Nat, Nat, Nat.divmod.go(np, mp, d, 1n+r)), 1n+bp)) == _ : Nat}
          ih

# For b > 0, written as 1n+bp: (a % (1n+bp)) + (a / (1n+bp)) * (1n+bp) == a
def nat_div_mod(a: Nat, bp: Nat) -> {Nat.add(Nat.mod(a, 1n+bp), Nat.mul(Nat.div(a, 1n+bp), 1n+bp)) == a : Nat}:
  +a2 = {a : Nat}
  +bp2 = {bp : Nat}
  %nat_add_zero_r(a2) : {Nat.add(Nat.mod(a2, 1n+bp2), Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2)) == _ : Nat}
  nat_divmod_go_eq(a2, bp2, 0n, 0n, bp2, nat_add_zero_r(bp2))

# Commuted orientation: (a / (1n+bp)) * (1n+bp) + (a % (1n+bp)) == a
def nat_div_mod_r(a: Nat, bp: Nat) -> {Nat.add(Nat.mul(Nat.div(a, 1n+bp), 1n+bp), Nat.mod(a, 1n+bp)) == a : Nat}:
  +a2 = {a : Nat}
  +bp2 = {bp : Nat}
  %nat_add_comm(Nat.mod(a2, 1n+bp2), Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2)) : {_ == a2 : Nat}
  nat_div_mod(a2, bp2)

def nat_div_lt_of_lt_mul_dec(
  +a: Nat,
  +n: Nat,
  +bp: Nat,
  h: {Nat.is_lt(a, Nat.mul(n, 1n+bp)) == True{} : Bool},
  b: Bool,
  eb: {b == Nat.is_lt(Nat.div(a, 1n+bp), n) : Bool}
) -> {Nat.is_lt(Nat.div(a, 1n+bp), n) == True{} : Bool}:
  match b:
    case True{}:
      Equal.sym(Bool, True{}, Nat.is_lt(Nat.div(a, 1n+bp), n), eb)
    case False{}:
      nq = nat_not_lt_imp_le(Nat.div(a, 1n+bp), n, Equal.sym(Bool, False{}, Nat.is_lt(Nat.div(a, 1n+bp), n), eb))
      nb_le_qb = nat_mul_le_mono_r(n, Nat.div(a, 1n+bp), 1n+bp, nq)
      qb_le_rqb = nat_add_le_l(Nat.mod(a, 1n+bp), Nat.mul(Nat.div(a, 1n+bp), 1n+bp))
      nb_le_rqb = nat_le_trans(
        Nat.mul(n, 1n+bp),
        Nat.mul(Nat.div(a, 1n+bp), 1n+bp),
        Nat.add(Nat.mod(a, 1n+bp), Nat.mul(Nat.div(a, 1n+bp), 1n+bp)),
        nb_le_qb,
        qb_le_rqb
      )
      nb_le_a = nat_le_subst_r(
        Nat.mul(n, 1n+bp),
        Nat.add(Nat.mod(a, 1n+bp), Nat.mul(Nat.div(a, 1n+bp), 1n+bp)),
        a,
        nat_div_mod(a, bp),
        nb_le_rqb
      )
      Empty.absurd({Nat.is_lt(Nat.div(a, 1n+bp), n) == True{} : Bool}, nat_lt_not_le(a, Nat.mul(n, 1n+bp), h, nb_le_a))

# For b > 0, written as 1n+bp: a < n * (1n+bp) -> a / (1n+bp) < n
def nat_div_lt_of_lt_mul(
  a: Nat,
  n: Nat,
  bp: Nat,
  h: {Nat.is_lt(a, Nat.mul(n, 1n+bp)) == True{} : Bool}
) -> {Nat.is_lt(Nat.div(a, 1n+bp), n) == True{} : Bool}:
  +a2 = {a : Nat}
  +n2 = {n : Nat}
  +bp2 = {bp : Nat}
  nat_div_lt_of_lt_mul_dec(a2, n2, bp2, h, Nat.is_lt(Nat.div(a2, 1n+bp2), n2), {==})

# For b > 0, written as 1n+bp: a < (1n+bp) * n -> a / (1n+bp) < n
def nat_div_lt_of_lt_mul_l(
  a: Nat,
  n: Nat,
  bp: Nat,
  h: {Nat.is_lt(a, Nat.mul(1n+bp, n)) == True{} : Bool}
) -> {Nat.is_lt(Nat.div(a, 1n+bp), n) == True{} : Bool}:
  +a2 = {a : Nat}
  +n2 = {n : Nat}
  +bp2 = {bp : Nat}
  nat_div_lt_of_lt_mul(
    a2,
    n2,
    bp2,
    nat_lt_subst_r(a2, Nat.mul(1n+bp2, n2), Nat.mul(n2, 1n+bp2), nat_mul_comm(1n+bp2, n2), h)
  )

# ==============================================================================
# Euclidean division & alignment (b = 1n+bp > 0, r < b)
# ==============================================================================

def nat_split_low_refuted(
  +bp: Nat,
  +m: Nat,
  +r1: Nat,
  +r2: Nat,
  h1: {Nat.is_lt(r1, 1n+bp) == True{} : Bool},
  e: {r1 == Nat.add(Nat.add(1n+bp, m), r2) : Nat}
) -> Empty:
  nat_lt_not_le(
    Nat.add(Nat.add(1n+bp, m), r2),
    1n+bp,
    nat_lt_subst_l(r1, Nat.add(Nat.add(1n+bp, m), r2), 1n+bp, e, h1),
    nat_le_add_add(1n+bp, m, r2)
  )

def nat_split_unique_q.go(
  +q1: Nat,
  +r1: Nat,
  +q2: Nat,
  +r2: Nat,
  +bp: Nat,
  h1: {Nat.is_lt(r1, 1n+bp) == True{} : Bool},
  h2: {Nat.is_lt(r2, 1n+bp) == True{} : Bool},
  e: {Nat.add(Nat.mul(q1, 1n+bp), r1) == Nat.add(Nat.mul(q2, 1n+bp), r2) : Nat}
) -> {q1 == q2 : Nat}:
  match q1 q2:
    case 0n 0n:
      {==}
    case 0n 1n+p2:
      Empty.absurd({0n == 1n+p2 : Nat}, nat_split_low_refuted(bp, Nat.mul(p2, 1n+bp), r1, r2, h1, e))
    case 1n+p1 0n:
      Empty.absurd(
        {1n+p1 == 0n : Nat},
        nat_split_low_refuted(
          bp,
          Nat.mul(p1, 1n+bp),
          r2,
          r1,
          h2,
          Equal.sym(Nat, Nat.add(Nat.add(1n+bp, Nat.mul(p1, 1n+bp)), r1), r2, e)
        )
      )
    case 1n+p1 1n+p2:
      e1 = Equal.trans(
        Nat,
        Nat.add(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1)),
        Nat.add(Nat.add(1n+bp, Nat.mul(p1, 1n+bp)), r1),
        Nat.add(Nat.add(1n+bp, Nat.mul(p2, 1n+bp)), r2),
        Equal.sym(
          Nat,
          Nat.add(Nat.add(1n+bp, Nat.mul(p1, 1n+bp)), r1),
          Nat.add(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1)),
          nat_add_assoc(1n+bp, Nat.mul(p1, 1n+bp), r1)
        ),
        e
      )
      e2 = Equal.trans(
        Nat,
        Nat.add(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1)),
        Nat.add(Nat.add(1n+bp, Nat.mul(p2, 1n+bp)), r2),
        Nat.add(1n+bp, Nat.add(Nat.mul(p2, 1n+bp), r2)),
        e1,
        nat_add_assoc(1n+bp, Nat.mul(p2, 1n+bp), r2)
      )
      %nat_split_unique_q.go(
        p1,
        r1,
        p2,
        r2,
        bp,
        h1,
        h2,
        nat_add_cancel_l(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1), Nat.add(Nat.mul(p2, 1n+bp), r2), e2)
      ) : {1n+p1 == 1n+_ : Nat}
      {==}

def nat_split_unique_q(
  q1: Nat,
  r1: Nat,
  q2: Nat,
  r2: Nat,
  bp: Nat,
  h1: {Nat.is_lt(r1, 1n+bp) == True{} : Bool},
  h2: {Nat.is_lt(r2, 1n+bp) == True{} : Bool},
  e: {Nat.add(Nat.mul(q1, 1n+bp), r1) == Nat.add(Nat.mul(q2, 1n+bp), r2) : Nat}
) -> {q1 == q2 : Nat}:
  +q1_2 = {q1 : Nat}
  +r1_2 = {r1 : Nat}
  +q2_2 = {q2 : Nat}
  +r2_2 = {r2 : Nat}
  +bp2 = {bp : Nat}
  nat_split_unique_q.go(q1_2, r1_2, q2_2, r2_2, bp2, h1, h2, e)

def nat_split_unique_r.go(
  +q1: Nat,
  +r1: Nat,
  +q2: Nat,
  +r2: Nat,
  +bp: Nat,
  h1: {Nat.is_lt(r1, 1n+bp) == True{} : Bool},
  h2: {Nat.is_lt(r2, 1n+bp) == True{} : Bool},
  e: {Nat.add(Nat.mul(q1, 1n+bp), r1) == Nat.add(Nat.mul(q2, 1n+bp), r2) : Nat}
) -> {r1 == r2 : Nat}:
  match q1 q2:
    case 0n 0n:
      e
    case 0n 1n+p2:
      Empty.absurd({r1 == r2 : Nat}, nat_split_low_refuted(bp, Nat.mul(p2, 1n+bp), r1, r2, h1, e))
    case 1n+p1 0n:
      Empty.absurd(
        {r1 == r2 : Nat},
        nat_split_low_refuted(
          bp,
          Nat.mul(p1, 1n+bp),
          r2,
          r1,
          h2,
          Equal.sym(Nat, Nat.add(Nat.add(1n+bp, Nat.mul(p1, 1n+bp)), r1), r2, e)
        )
      )
    case 1n+p1 1n+p2:
      e1 = Equal.trans(
        Nat,
        Nat.add(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1)),
        Nat.add(Nat.add(1n+bp, Nat.mul(p1, 1n+bp)), r1),
        Nat.add(Nat.add(1n+bp, Nat.mul(p2, 1n+bp)), r2),
        Equal.sym(
          Nat,
          Nat.add(Nat.add(1n+bp, Nat.mul(p1, 1n+bp)), r1),
          Nat.add(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1)),
          nat_add_assoc(1n+bp, Nat.mul(p1, 1n+bp), r1)
        ),
        e
      )
      e2 = Equal.trans(
        Nat,
        Nat.add(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1)),
        Nat.add(Nat.add(1n+bp, Nat.mul(p2, 1n+bp)), r2),
        Nat.add(1n+bp, Nat.add(Nat.mul(p2, 1n+bp), r2)),
        e1,
        nat_add_assoc(1n+bp, Nat.mul(p2, 1n+bp), r2)
      )
      nat_split_unique_r.go(
        p1,
        r1,
        p2,
        r2,
        bp,
        h1,
        h2,
        nat_add_cancel_l(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1), Nat.add(Nat.mul(p2, 1n+bp), r2), e2)
      )

def nat_split_unique_r(
  q1: Nat,
  r1: Nat,
  q2: Nat,
  r2: Nat,
  bp: Nat,
  h1: {Nat.is_lt(r1, 1n+bp) == True{} : Bool},
  h2: {Nat.is_lt(r2, 1n+bp) == True{} : Bool},
  e: {Nat.add(Nat.mul(q1, 1n+bp), r1) == Nat.add(Nat.mul(q2, 1n+bp), r2) : Nat}
) -> {r1 == r2 : Nat}:
  +q1_2 = {q1 : Nat}
  +r1_2 = {r1 : Nat}
  +q2_2 = {q2 : Nat}
  +r2_2 = {r2 : Nat}
  +bp2 = {bp : Nat}
  nat_split_unique_r.go(q1_2, r1_2, q2_2, r2_2, bp2, h1, h2, e)

# For b > 0, written as 1n+bp, and r < 1n+bp: (q * (1n+bp) + r) / (1n+bp) == q
def nat_div_split(
  q: Nat,
  r: Nat,
  bp: Nat,
  h: {Nat.is_lt(r, 1n+bp) == True{} : Bool}
) -> {Nat.div(Nat.add(Nat.mul(q, 1n+bp), r), 1n+bp) == q : Nat}:
  +q2 = {q : Nat}
  +r2 = {r : Nat}
  +bp2 = {bp : Nat}
  nat_split_unique_q(
    Nat.div(Nat.add(Nat.mul(q2, 1n+bp2), r2), 1n+bp2),
    Nat.mod(Nat.add(Nat.mul(q2, 1n+bp2), r2), 1n+bp2),
    q2,
    r2,
    bp2,
    nat_mod_lt(Nat.add(Nat.mul(q2, 1n+bp2), r2), bp2),
    h,
    nat_div_mod_r(Nat.add(Nat.mul(q2, 1n+bp2), r2), bp2)
  )

# For b > 0, written as 1n+bp, and r < 1n+bp: (q * (1n+bp) + r) % (1n+bp) == r
def nat_mod_split(
  q: Nat,
  r: Nat,
  bp: Nat,
  h: {Nat.is_lt(r, 1n+bp) == True{} : Bool}
) -> {Nat.mod(Nat.add(Nat.mul(q, 1n+bp), r), 1n+bp) == r : Nat}:
  +q2 = {q : Nat}
  +r2 = {r : Nat}
  +bp2 = {bp : Nat}
  nat_split_unique_r(
    Nat.div(Nat.add(Nat.mul(q2, 1n+bp2), r2), 1n+bp2),
    Nat.mod(Nat.add(Nat.mul(q2, 1n+bp2), r2), 1n+bp2),
    q2,
    r2,
    bp2,
    nat_mod_lt(Nat.add(Nat.mul(q2, 1n+bp2), r2), bp2),
    h,
    nat_div_mod_r(Nat.add(Nat.mul(q2, 1n+bp2), r2), bp2)
  )

# For b > 0, written as 1n+bp, and a < 1n+bp: a % (1n+bp) == a
def nat_mod_small(
  a: Nat,
  bp: Nat,
  h: {Nat.is_lt(a, 1n+bp) == True{} : Bool}
) -> {Nat.mod(a, 1n+bp) == a : Nat}:
  nat_mod_split(0n, a, bp, h)

# For b > 0, written as 1n+bp, and a < 1n+bp: a / (1n+bp) == 0n
def nat_div_small(
  a: Nat,
  bp: Nat,
  h: {Nat.is_lt(a, 1n+bp) == True{} : Bool}
) -> {Nat.div(a, 1n+bp) == 0n : Nat}:
  nat_div_split(0n, a, bp, h)

# Two numbers with the same quotient and remainder modulo 1n+bp are equal.
def nat_eq_of_div_mod(
  a: Nat,
  c: Nat,
  bp: Nat,
  hq: {Nat.div(a, 1n+bp) == Nat.div(c, 1n+bp) : Nat},
  hr: {Nat.mod(a, 1n+bp) == Nat.mod(c, 1n+bp) : Nat}
) -> {a == c : Nat}:
  +a2 = {a : Nat}
  +c2 = {c : Nat}
  +bp2 = {bp : Nat}
  %nat_div_mod_r(a2, bp2) : {_ == c2 : Nat}
  %nat_div_mod_r(c2, bp2) : {Nat.add(Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2), Nat.mod(a2, 1n+bp2)) == _ : Nat}
  %hq : {Nat.add(Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2), Nat.mod(a2, 1n+bp2)) == Nat.add(Nat.mul(_, 1n+bp2), Nat.mod(c2, 1n+bp2)) : Nat}
  %hr : {Nat.add(Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2), Nat.mod(a2, 1n+bp2)) == Nat.add(Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2), _) : Nat}
  {==}

def nat_split_lt.go(
  +q: Nat,
  +r: Nat,
  +n: Nat,
  +bp: Nat,
  hq: {Nat.is_lt(q, n) == True{} : Bool},
  hr: {Nat.is_lt(r, 1n+bp) == True{} : Bool}
) -> {Nat.is_lt(Nat.add(Nat.mul(q, 1n+bp), r), Nat.mul(n, 1n+bp)) == True{} : Bool}:
  match q n:
    case 0n 0n:
      bool_absurd({Nat.is_lt(r, 0n) == True{} : Bool}, hq)
    case 0n 1n+np:
      nat_lt_le_trans(r, 1n+bp, Nat.add(1n+bp, Nat.mul(np, 1n+bp)), hr, nat_add_le_r(1n+bp, Nat.mul(np, 1n+bp)))
    case 1n+qp 0n:
      bool_absurd({Nat.is_lt(Nat.add(Nat.add(1n+bp, Nat.mul(qp, 1n+bp)), r), 0n) == True{} : Bool}, hq)
    case 1n+qp 1n+np:
      %Equal.sym(
        Nat,
        Nat.add(Nat.add(1n+bp, Nat.mul(qp, 1n+bp)), r),
        Nat.add(1n+bp, Nat.add(Nat.mul(qp, 1n+bp), r)),
        nat_add_assoc(1n+bp, Nat.mul(qp, 1n+bp), r)
      ) : {Nat.is_lt(_, Nat.add(1n+bp, Nat.mul(np, 1n+bp))) == True{} : Bool}
      nat_add_lt_l(
        1n+bp,
        Nat.add(Nat.mul(qp, 1n+bp), r),
        Nat.mul(np, 1n+bp),
        nat_split_lt.go(qp, r, np, bp, hq, hr)
      )

# q < n, r < 1n+bp -> q * (1n+bp) + r < n * (1n+bp)
def nat_split_lt(
  q: Nat,
  r: Nat,
  n: Nat,
  bp: Nat,
  hq: {Nat.is_lt(q, n) == True{} : Bool},
  hr: {Nat.is_lt(r, 1n+bp) == True{} : Bool}
) -> {Nat.is_lt(Nat.add(Nat.mul(q, 1n+bp), r), Nat.mul(n, 1n+bp)) == True{} : Bool}:
  +q2 = {q : Nat}
  +r2 = {r : Nat}
  +n2 = {n : Nat}
  +bp2 = {bp : Nat}
  nat_split_lt.go(q2, r2, n2, bp2, hq, hr)

# (q * (1n+bp)) % (1n+bp) == 0n
def nat_mod_mul(q: Nat, bp: Nat) -> {Nat.mod(Nat.mul(q, 1n+bp), 1n+bp) == 0n : Nat}:
  +q2 = {q : Nat}
  +bp2 = {bp : Nat}
  %nat_add_zero_r(Nat.mul(q2, 1n+bp2)) : {Nat.mod(_, 1n+bp2) == 0n : Nat}
  nat_mod_split(q2, 0n, bp2, {==})

# (q * (1n+bp)) / (1n+bp) == q
def nat_div_mul(q: Nat, bp: Nat) -> {Nat.div(Nat.mul(q, 1n+bp), 1n+bp) == q : Nat}:
  +q2 = {q : Nat}
  +bp2 = {bp : Nat}
  %nat_add_zero_r(Nat.mul(q2, 1n+bp2)) : {Nat.div(_, 1n+bp2) == q2 : Nat}
  nat_div_split(q2, 0n, bp2, {==})

# (a / (1n+bp)) * (1n+bp) <= a
def nat_align_down_le(a: Nat, bp: Nat) -> {Nat.is_le(Nat.mul(Nat.div(a, 1n+bp), 1n+bp), a) == True{} : Bool}:
  +a2 = {a : Nat}
  +bp2 = {bp : Nat}
  %nat_div_mod_r(a2, bp2) : {Nat.is_le(Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2), _) == True{} : Bool}
  nat_add_le_r(Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2), Nat.mod(a2, 1n+bp2))
`;

  return [
    {
      path: 'rusty-bends-build/Cargo.toml',
      language: 'toml',
      summary: 'Zero-dependency v1.0.0 build crate manifest ([build-dependencies] only).',
      content: buildCrateCargo,
    },
    {
      path: 'rusty-bends-build/build.rs',
      language: 'rust',
      summary: 'Computes a compile-time source hash of rusty-bends-build so updates invalidate downstream build caches.',
      content: buildCrateBuildRs,
    },
    {
      path: 'rusty-bends-build/src/lib.rs',
      language: 'rust',
      summary: 'Cargo build.rs gate: bend.pin version check, AST law lock, bend --check-only & --verdict, hash cache, and OUT_DIR emitter (with #[cfg(test)] tests).',
      content: buildCrateLib,
    },
    {
      path: 'rusty-bends-build/src/lock.rs',
      language: 'rust',
      summary: 'AST/token-canonical multi-line LAWS lock (comment/whitespace-safe, catches deletion & weakening, with 4 #[cfg(test)] tests).',
      content: buildCrateLock,
    },
    {
      path: 'rusty-bends-build/src/emit.rs',
      language: 'rust',
      summary: 'Rust-native Bend 2.0.40 q=0 eraser & pure Rust emitter supporting Base Nat/Bool/Pair helpers, wrapping U32/U64 vs checked Nat, nested & multi-scrutinee match, 1n+p / 1n+1n+q patterns, and proof/lemma erasure.',
      content: buildCrateEmit,
    },
    {
      path: 'rusty-bends-build/src/law_test.rs',
      language: 'rust',
      summary: 'Law parser and per-law #[cfg(test)] test generator that evaluates every law directly against emitted Rust.',
      content: buildCrateLawTest,
    },
    {
      path: 'rusty-bends-build/src/mutate.rs',
      language: 'rust',
      summary: 'Mutation checker that rejects vacuous new laws (E_LAW_VACUOUS) before sealing and audits locked laws under RUSTY_BENDS_MUTATE=all.',
      content: buildCrateMutate,
    },
    {
      path: 'rusty-bends-build/src/coverage.rs',
      language: 'rust',
      summary: 'Coverage analyzer linking emitted Bend functions, laws, dependency cones, and host Rust call sites.',
      content: buildCrateCoverage,
    },
    {
      path: 'rusty-bends-build/src/bin/rusty-bends-laws.rs',
      language: 'rust',
      summary: 'CLI binary that prints every law as name: promise for PR descriptions.',
      content: buildCrateLawsBin,
    },
    {
      path: 'rusty-bends-build/lemmas/nat_lemmas.bend',
      language: 'bend',
      summary: 'Bundled Bend 2 Nat arithmetic, order, and division lemma library (erased before Rust codegen).',
      content: buildCrateNatLemmas,
    },
    {
      path: 'example-app/Cargo.toml',
      language: 'toml',
      summary: 'App manifest showing rusty-bends-build under [build-dependencies] (never in final binary).',
      content: exampleCargo,
    },
    {
      path: 'example-app/build.rs',
      language: 'rust',
      summary: 'One-line Cargo build script invoking verify_and_emit("verified").',
      content: exampleBuildRs,
    },
    {
      path: 'example-app/bend.pin',
      language: 'toml',
      summary: 'Optional Bend 2 version pin file to lock compiler versions on first signs of upstream breakage.',
      content: bendPinFile,
    },
    {
      path: 'example-app/verified/core.bend',
      language: 'bend',
      summary: 'Real Bend 2 Verified Core (import Base, ADTs, Nat.add, laws & proof defs ready for bend --check-only & --verdict).',
      content: exampleBendCore,
    },
    {
      path: 'example-app/src/main.rs',
      language: 'rust',
      summary: 'Pure Rust shell calling verified::deposit and verified::cancel_order from OUT_DIR/verified.rs.',
      content: exampleMainRs,
    },
    {
      path: 'BEND_GUIDE.md',
      language: 'markdown',
      summary: 'Drop-in v1 AI playbook covering real Bend 2 syntax (is Data, {}, law + proof def, {==}, % rewrites, operator annotations, bend.pin).',
      content: BEND_GUIDE_MD,
    },
  ];
}

/**
 * Generates a self-contained POSIX shell script that creates the complete local v1 Cargo workspace
 * (rusty-bends-build + example-app + bend.pin + BEND_GUIDE.md) in one command.
 */
export function buildWorkspaceSetupScript(files: KitFile[]): string {
  const sections = [
    '#!/usr/bin/env sh',
    'set -eu',
    '',
    'echo "Creating RustyBends v1 Cargo workspace..."',
    '',
  ];

  const dirs = new Set<string>();
  for (const file of files) {
    const idx = file.path.lastIndexOf('/');
    if (idx > 0) {
      dirs.add(file.path.slice(0, idx));
    }
  }
  for (const dir of Array.from(dirs).sort()) {
    sections.push(`mkdir -p "${dir}"`);
  }
  sections.push('');

  for (const file of files) {
    sections.push(`cat << 'RUSTY_BENDS_EOF' > "${file.path}"`);
    sections.push(file.content.replace(/\n+$/, ''));
    sections.push('RUSTY_BENDS_EOF');
    sections.push('');
  }

  sections.push('echo "Done! Next steps on desktop:"');
  sections.push('echo "  1. Run rusty-bends-build unit tests (22 tests):  (cd rusty-bends-build && cargo test)"');
  sections.push('echo "  2. Build & verify example app with bend CLI:     (cd example-app && cargo check && cargo run)"');
  sections.push('echo "  3. Optional: set BEND_VERDICT=require in CI or pin Bend version in example-app/bend.pin"');
  return `${sections.join('\n')}\n`;
}

export interface PromptPreset {
  id: string;
  label: string;
  appName: string;
  domain: string;
  invariants: string;
}

export const AI_PROMPT_PRESETS: PromptPreset[] = [
  {
    id: 'ledger',
    label: 'Billing Ledger',
    appName: 'ledger-service',
    domain: 'Double-entry account balance and fee calculation service with HTTP API',
    invariants:
      'Total balance is conserved across transfers; zero-amount deposit leaves balance unchanged; fees never exceed gross amount',
  },
  {
    id: 'rbac',
    label: 'RBAC Permissions',
    appName: 'authz-engine',
    domain: 'Role-based access control policy evaluator for multi-tenant SaaS',
    invariants:
      'Revoked roles never grant access; permission union is commutative and idempotent; deny rules always override allow rules',
  },
  {
    id: 'inventory',
    label: 'Inventory Reservation',
    appName: 'stock-allocator',
    domain: 'Warehouse stock reservation & release state machine',
    invariants:
      'Reserved + available always equals total stock; releasing a reservation restores exact available quantity; cannot reserve more than available',
  },
];

export function buildAiKickoffPrompt(
  appName: string,
  domain: string,
  invariants: string
): string {
  const safeName = appName.trim() || 'my-rusty-bends-app';
  const safeDomain =
    domain.trim() || 'A Rust service with mathematically proven core business logic';
  const invariantLines = invariants
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `- ${s}`)
    .join('\n');

  return `You are building "${safeName}" in Rust using **RustyBends v1** (compile-time Bend 2 proof verification).

### Application Goal
${safeDomain}

### Architecture ("Verified Core, Rust Shell")
1. Put ALL pure business logic, ADTs (\`type\`), state transitions (\`match\`), and math invariants inside \`verified/*.bend\`.
2. Put ALL I/O (HTTP, DB, CLI, async) inside normal Rust \`src/*.rs\`.
3. Wire \`rusty-bends-build\` under \`[build-dependencies]\` in \`Cargo.toml\` and call \`rusty_bends_build::verify_and_emit("verified")\` in \`build.rs\`. Zero Bend runtime or proof code ships in the final binary.
4. Keep unit tests minimal: rely on Bend 2 proofs in \`verified/\` for pure logic invariants, and write Rust integration tests ONLY for I/O boundaries.

### Required Laws to Prove in \`verified/\`
${invariantLines || '- Define and prove core conservation, state-machine, and idempotence invariants.'}

### Quick Bend 2 / BendTT v1 Primer (Read Carefully)
- Quantities on every parameter:
  - \`-T: Type\` = Dead (\`q=0\`): types/proofs, checked and erased before codegen. Never return in a live body.
  - \`x: T\` = Live (\`q=1\`): affine runtime value, used **at most once**.
  - \`+n: Nat\` = Data (\`q=2\`): duplicable pure data (safe to use multiple times; no lambdas inside).
- **Real Bend 2.0.17+ syntax**:
  - Start files with \`import Base\`.
  - ADTs use \`type Name is Data:\` with curly-brace constructors (\`Draft{}\`, \`Paid{amount: Nat}\`); \`match\` cases use \`case Draft{}:\` (no \`if/else\` keyword — match on \`True{}\` / \`False{}\`).
  - Operators MUST be type-annotated: write \`(a + b : U32)\` or \`Nat.add(a, b)\`, never bare \`a + b\`.
  - Laws use \`# promise: <one-sentence English statement>\` (required directly above every new \`law <name>:\`, with optional \`# harm:\`) paired with \`law name: for x: T {lhs == rhs : T}\`, and proofs are matching \`def name(x):\` functions using \`{==}\` and \`%lemma(p) : {goal}\` (erased automatically by \`rusty-bends-build\`).
- NEVER delete or weaken locked laws in \`verified/\` to make \`cargo check\` pass. If \`E_LAW_FALSE\` or a proof check fails, fix the implementation in \`verified/\`.

### Workflow
1. Write \`BEND_GUIDE.md\` and \`verified/core.bend\` first with types, functions, laws, and proofs.
2. Lock laws with \`rusty-bends.lock\` (human-approved updates only via \`RUSTY_BENDS_UPDATE_LAWS=1\`).
3. Run \`cargo check\` until \`bend --check-only\` and \`bend --verdict\` pass and \`OUT_DIR/verified.rs\` compiles cleanly.`;
}
