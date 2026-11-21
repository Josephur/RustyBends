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
#    - Theorem  = 'law <name>: for <var>: <Type> {<lhs> == <rhs> : <Type>}'
#    - Proof    = 'def <name>(<var>):' with the SAME name (erased automatically by rusty-bends-build!)
#    - Refl     = '{==}'
#    - Rewrite  = '%<lemma>(<args>) : {<goal_with_underscore>}'
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
```

## 4. Supported Bend 2.0.40 `Base` Helpers & Exact Rust Semantics

`rusty-bends-build/src/emit.rs` lowers Bend 2 `Base` stdlib calls directly to zero-overhead Rust:

- **`Nat` arithmetic (saturating `u64`, total division — never panics):**
  - `Nat.add`, `Nat.sub`, `Nat.mul` -> `saturating_add`, `saturating_sub`, `saturating_mul`
  - `Nat.div(a, b)` / `Nat.mod(a, b)` / `Nat.divmod(a, b)` -> total div/mod matching Bend 2 (`Nat.div(a, 0n) == 0n`, `Nat.mod(a, 0n) == a`)
  - `Nat.min`, `Nat.max`, `Nat.succ`, `Nat.pred`, `Nat.is_zero`
  - `Nat.is_le`, `Nat.is_lt`, `Nat.is_ge`, `Nat.is_gt`, `Nat.is_eq`, `Nat.is_ne`
- **`Bool` & `Pair` helpers:**
  - `Bool.and`, `Bool.or`, `Bool.not`, `Bool.xor`, `Bool.is_eq`, `Bool.is_ne`, `Bool.pick`
  - `A & B` pair types -> `(A, B)`, `Pair.fst`, `Pair.snd`
- **Fixed-width integers vs `Nat`:**
  - `(a + b : Nat)` / `(a - b : Nat)` / `(a * b : Nat)` emit **saturating** `u64` ops (exact match for Peano `Nat` non-underflow proofs).
  - `(a + b : U32)` / `U64` / `I32` / `I64` emit **wrapping** ops (`wrapping_add`, `wrapping_sub`, `wrapping_mul`) matching Bend 2's fixed-width integer semantics.
- **Control flow & patterns:** nested `match`, multi-scrutinee `match a b:`, `case 1n+p:` successor patterns, and multi-line `let` bindings are all supported.

## 5. Mandatory Rules for AI Agents

1. **Always type-annotate operators (Bend 2.0.17+).** Write `(a + b : U32)` (wrapping) or `Nat.add(a, b)` / `(a + b : Nat)` (saturating) — never bare `a + b`.
2. **Use real Bend 2 `law` + proof `def` syntax.** Never invent `proof foo: refl`; write `law foo: for x: T {lhs == rhs : T}` paired with `def foo(x): ... {==}`. Helper lemmas returning `{lhs == rhs : T}` are also erased automatically.
3. **Run `cargo check` after every edit.** Cargo runs `build.rs` -> `rusty_bends_build::verify_and_emit("verified")`.
4. **NEVER delete, comment out, or weaken laws in `verified/`.**
   `rusty-bends.lock` uses an AST/token canonicalizer (safe across whitespace/comment edits, strict on law changes) and fails with `E_LAW_LOCK_TAMPERED`.
5. **Lean `--verdict` kernel cross-check**: `rusty-bends-build` always runs `bend <file> --check-only` (which checks all laws and proofs). By default (`BEND_VERDICT=auto`), it also runs `--verdict` whenever Lean (`~/.elan/bin/lean`) or `$BENDTT` is installed, and skips `--verdict` with a warning otherwise. Set `BEND_VERDICT=require` in CI to enforce Lean cross-checking, or `BEND_VERDICT=off` to disable it.
6. **Pin Bend 2 if upstream drifts**: uncomment the version prefix (e.g. `2.0.`) in `bend.pin` or set `BEND_PIN_VERSION`.
