# BEND_GUIDE.md — AI Coding Guide for Rust + RustyBends v1 (Real Bend 2 Syntax)

You are working in a Rust project protected by **RustyBends v1** (compile-time Bend 2 proofs).
Nothing from Bend 2 ships in the final runtime binary: all proofs and `q=0` types are checked
during `cargo build` / `cargo check` via `bend <file> --check-only` and `bend <file> --verdict`,
proof `def`s are erased, and only pure verified Rust (`pub enum` ADTs, `match`, and functions)
is emitted into `OUT_DIR/verified.rs`.

## 1. Architecture Rule: "Verified Core, Rust Shell"

- **Put pure invariants, ADTs, state machines & math in `verified/*.bend`**:
  balance/accounting math, order/workflow state machines (`type ... is Data:` + `match`), permission checks (`Bool`), bounds.
- **Put all I/O in `src/*.rs`**:
  HTTP servers, SQL/databases, async tasks, CLI, filesystem, networking.
- **Minimize unit test bloat**:
  Do NOT write dozens of repetitive unit tests for pure logic already proven in `verified/`.
  Write thin Rust integration tests for I/O boundaries only.

## 2. Bend 2 / BendTT Quantities (Required Knowledge)

| Prefix | Quantity | Meaning | Rule |
| :--- | :--- | :--- | :--- |
| `-T: Type` | **Dead (`q=0`)** | Types, motives, proofs | Checked at compile time, **erased before codegen**. Never return in a live body. |
| `x: T` | **Live (`q=1`)** | Affine runtime value | Used **at most once**. |
| `+n: U32` / `type T is Data:` | **Data (`q=2`)** | Duplicable pure data | May be copied/used multiple times. **No lambdas or live calls inside.** |

## 3. Real Bend 2 Syntax Cheat Sheet (Matches `bendlang/bend` 2.0.17+)

```bend
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
```

## 4. Supported Bend 2.0.40 `Base` Helpers & Exact Rust Semantics

`rusty-bends-build/src/emit.rs` lowers Bend 2 `Base` stdlib calls directly to zero-overhead Rust:

- **`Nat` arithmetic (checked `u64` on growth, saturating subtraction, total division):**
  - `Nat.add`, `Nat.mul`, `Nat.succ` -> `checked_add` / `checked_mul` (panics with `"rusty-bends: Nat overflow"` on `u64` overflow, so emitted Rust agrees with mathematical `Nat` wherever it returns and never silently saturates past `u64::MAX` into a law-violating state).
  - `Nat.sub`, `Nat.pred` -> `saturating_sub` (exact match for Peano `0n - x == 0n`).
  - `Nat.div(a, b)` / `Nat.mod(a, b)` / `Nat.divmod(a, b)` -> total div/mod matching Bend 2 (`Nat.div(a, 0n) == 0n`, `Nat.mod(a, 0n) == a`)
  - `Nat.min`, `Nat.max`, `Nat.is_zero`
  - `Nat.is_le`, `Nat.is_lt`, `Nat.is_ge`, `Nat.is_gt`, `Nat.is_eq`, `Nat.is_ne`
- **`Bool` & `Pair` helpers:**
  - `Bool.and`, `Bool.or`, `Bool.not`, `Bool.xor`, `Bool.is_eq`, `Bool.is_ne`, `Bool.pick`
  - `A & B` pair types -> `(A, B)`, `Pair.fst`, `Pair.snd`
- **Fixed-width integers vs `Nat`:**
  - `(a + b : Nat)` / `(a * b : Nat)` emit **checked** `u64` ops (panicking on `u64` overflow), while `(a - b : Nat)` emits `saturating_sub`.
  - `(a + b : U32)` / `U64` / `I32` / `I64` emit **wrapping** ops (`wrapping_add`, `wrapping_sub`, `wrapping_mul`) matching Bend 2's fixed-width integer semantics.
- **Control flow & patterns:** nested `match`, multi-scrutinee `match a b:`, `case 1n+p:` and nested `case 1n+1n+q:` successor patterns, and multi-line `let` bindings are all supported.
- **Recursive ADTs & built-in `List`:** direct or mutually recursive `type` definitions automatically box cycle-forming fields (`Box<T>`), omit `Copy` (`#[derive(Debug, Clone, PartialEq, Eq)]`) across recursive types and any wrappers containing them, unbox patterns (`*__rb_box` + nested guards), and insert `.clone()` on multi-use non-`Copy` values. Built-in `Base` `List<T>` / `List<&2, T>`, `Nil{}` / `Con{head, tail}`, and list literals `[]` / `[a, b]` emit `pub enum List<T> { Nil, Con(T, Box<List<T>>) }`.
- **Cross-file sibling imports (`import sibling.bend as X`):** files under `verified/` can import sibling `.bend` files (`import base_rules.bend as B`) to share functions, types, laws, and helper lemmas (`B.fn_name(...)`, `B.TypeName`, `B.Ctor{}`). Keep top-level names unique across `verified/*.bend`; the emitter resolves each file's import aliases into the single emitted `verified.rs` module, and `rusty-bends.lock` normalizes aliases so renaming `as B` does not trip `E_LAW_LOCK_TAMPERED`.
- **Bundled `Nat` arithmetic lemma library (`nat_lemmas.bend`):** `rusty-bends-build` ships `rusty_bends_build::lemmas/nat_lemmas.bend` via `rusty_bends_build::NAT_LEMMAS_BEND` and `rusty_bends_build::write_nat_lemmas("verified")` (called in `build.rs` before `verify_and_emit("verified")`, or copied into `verified/`). Import it with `import nat_lemmas.bend as L`. All definitions in `nat_lemmas.bend` are `q=0` proof/type helpers and are erased completely before Rust codegen, covering:
  - **Ex falso / Bool refutation:** `bool_pick_type`, `bool_false_ne_true`, `bool_true_ne_false`, `bool_absurd`, `bool_absurd_tf`.
  - **Order & min/max:** `nat_le_refl`, `nat_le_zero`, `nat_le_succ_r`, `nat_lt_succ_self`, `nat_lt_succ_eq_le`, `nat_lt_imp_le`, `nat_not_lt_imp_le`, `nat_le_subst_r`, `nat_lt_subst_r`, `nat_le_trans`, `nat_lt_trans`, `nat_lt_le_trans`, `nat_le_lt_trans`, `nat_lt_not_le`, `nat_lt_le_false`, `nat_le_lt_false`, `nat_le_antisym`, `nat_min_le_l`, `nat_min_le_r`, `nat_max_ge_l`, `nat_max_ge_r`, `nat_min_comm`, `nat_max_comm`.
  - **Addition & subtraction:** `nat_add_zero_r`, `nat_add_succ_r`, `nat_add_comm`, `nat_add_assoc`, `nat_add_le_l`, `nat_add_le_r`, `nat_add_le_mono`, `nat_add_lt_le_mono`, `nat_sub_zero_r`, `nat_sub_self`, `nat_add_sub_cancel_l`, `nat_add_sub_cancel_r`, `nat_sub_add_cancel`.
  - **Multiplication:** `nat_mul_zero_r`, `nat_mul_one_r`, `nat_mul_succ_r`, `nat_mul_comm`, `nat_mul_add_dist_r`, `nat_mul_add_dist_l`, `nat_mul_assoc`, `nat_mul_le_mono_r`, `nat_mul_le_mono_l`, `nat_mul_le_mono`.
  - **Division & modulo (`b = 1n+bp > 0`):** `nat_mod_lt(a, bp)` (`a % (1n+bp) < 1n+bp`), `nat_div_mod(a, bp)` (`a % (1n+bp) + (a / (1n+bp)) * (1n+bp) == a`), `nat_div_mod_r(a, bp)` (`(a / (1n+bp)) * (1n+bp) + a % (1n+bp) == a`), `nat_div_lt_of_lt_mul(a, n, bp, h)` (`a < n * (1n+bp) -> a / (1n+bp) < n`), and `nat_div_lt_of_lt_mul_l(a, n, bp, h)` (`a < (1n+bp) * n -> a / (1n+bp) < n`).
- **Generated per-law Rust tests:** every `law` also emits a `#[cfg(test)]` Rust test into `OUT_DIR/verified.rs` (run automatically by `cargo test`) that checks the emitted functions across small values, `u64::MAX - 1`, `u64::MAX`, ADT constructors, and deterministic PRNG samples (skipping only checked `Nat` overflow panics).
- **Counterexample vs proof-failure diagnosis:** when `bend --check-only` fails on a law, `rusty-bends-build` evaluates the emitted Rust on concrete inputs first and reports `[E_LAW_FALSE]` with aligned `lhs`/`rhs` values if the law is false, or notes `"no counterexample up to ...: the law may be true; the proof is what failed"` if no counterexample exists.
- **Mutation checking before sealing (`E_LAW_VACUOUS`):** every unlocked/new law is checked against small mutants of the live functions in its dependency cone (`True{}`/`False{}` swap, `Nat.is_le`/`Nat.is_lt` swap, `Nat.add`/`Nat.sub` swap, `Bool.and`/`Bool.or` operand drop, returning a constructor argument unchanged, swapping match arms) and fails with `[E_LAW_VACUOUS]` if it catches none. Run `RUSTY_BENDS_MUTATE=all cargo check` to report caught/survived status for already-locked laws without failing.

## 5. Mandatory Rules for AI Agents

1. **Always type-annotate operators (Bend 2.0.17+).** Write `(a + b : U32)` (wrapping) or `Nat.add(a, b)` / `(a + b : Nat)` (checked `Nat` add) — never bare `a + b`.
2. **Use real Bend 2 `law` + proof `def` syntax.** Never invent `proof foo: refl`; write `law foo: for x: T {lhs == rhs : T}` paired with `def foo(x): ... {==}`. Helper lemmas returning `{lhs == rhs : T}` are also erased automatically.
3. **Run `cargo check` after every edit.** Cargo runs `build.rs` -> `rusty_bends_build::verify_and_emit("verified")`.
4. **NEVER delete, comment out, or weaken laws in `verified/`.**
   `rusty-bends.lock` uses an AST/token canonicalizer (safe across whitespace/comment edits, strict on law changes) and fails with `E_LAW_LOCK_TAMPERED`.
5. **Every new law MUST have a plain-English `# promise:` comment directly above `law <name>:`** (`# harm:` is optional). Missing promises on new laws fail with `E_LAW_NO_PROMISE` (locked laws warn if missing). Promises are stored in `rusty-bends.lock` outside the law hash, so improving `# promise:` wording is reported in build output without tripping `E_LAW_LOCK_TAMPERED`. Run `RUSTY_BENDS_LIST_LAWS=1 cargo check` or `cargo run -p rusty-bends-build --bin rusty-bends-laws -- verified` to print every law as `name: promise`.
6. **Lean `--verdict` kernel cross-check**: `rusty-bends-build` always runs `bend <file> --check-only` (which checks all laws and proofs). By default (`BEND_VERDICT=auto`), it also runs `--verdict` whenever Lean (`~/.elan/bin/lean`) or `$BENDTT` is installed, and skips `--verdict` with a warning otherwise. Set `BEND_VERDICT=require` in CI to enforce Lean cross-checking, or `BEND_VERDICT=off` to disable it.
7. **Pin Bend 2 if upstream drifts**: uncomment the version prefix (e.g. `2.0.`) in `bend.pin` or set `BEND_PIN_VERSION`.
