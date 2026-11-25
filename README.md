# RustyBends

RustyBends puts **proved [Bend 2](https://github.com/bendlang/bend) logic inside an ordinary
Rust build**. You write the pure decision logic of a program (state machines, accounting,
bounds and budget arithmetic) in `.bend` files together with `law`s and their proofs.
At `cargo build` time RustyBends checks every proof with the real `bend` toolchain, erases
the proofs, and emits the remaining functions and data types as plain Rust that your crate
`include!`s. If the laws do not hold, the build fails. Nothing of Bend ships in the binary.

The pattern is called **"Verified Core, Rust Shell"**: the verified core is `verified/*.bend`,
and the Rust shell (I/O, FFI, threads, networking, CLI) calls into it.

## What `rusty-bends-build` does

On each build, for every `.bend` file in the verified directory:

1. **Version pin.** If `bend.pin` (or `BEND_PIN_VERSION`) names a version, it runs
   `bend version` and fails with `E_BEND_VERSION_MISMATCH` when the installed Bend differs.
2. **Proof gate and counterexample diagnosis.** It runs `bend <file> --check-only`, and `bend <file> --verdict` (Lean
   kernel check of the proofs) according to `BEND_VERDICT`. When a proof fails, it evaluates
   the emitted Rust on concrete inputs to distinguish a false law (`E_LAW_FALSE` with concrete
   `lhs` vs `rhs` values) from an incomplete proof.
3. **Law lock, `# promise:` gate (`E_LAW_NO_PROMISE`), and mutation check (`E_LAW_VACUOUS`, `E_LAW_UNCHECKED`).** It compares every `law` with the token-canonical copy in
   `rusty-bends.lock`. A locked law that was edited, weakened or deleted fails the build
   with `E_LAW_LOCK_TAMPERED`. Every new unlocked law must carry a plain-English
   `# promise:` comment directly above `law <name>:` (`E_LAW_NO_PROMISE` otherwise;
   locked laws warn if missing). Promise text is recorded in `rusty-bends.lock` outside
   each law's hash, so wording edits are reported in build output without tripping
   `E_LAW_LOCK_TAMPERED`. Before any new law is accepted or sealed, `rusty-bends-build`
   mutates the live functions the law depends on and checks that concrete evaluation catches at
   least one broken mutant (`E_LAW_VACUOUS` otherwise). The mutants include bound-pushing
   operators (`NatBound`, `SiblingCtor`, `BoolConst`, `FlipCmp`), returned-value replacement
   (`ReturnCtor`), literal changes (`NatLit`), and `Nat.add` / `Nat.max` / `Nat.min` swaps (`NatAddMaxMin`), so bound and safety laws are
   checked as well as exact formulas. A new law the checker cannot evaluate (`exs`, a goal
   without `==`, ...) fails with `E_LAW_UNCHECKED` unless an `# unchecked: <why>` comment sits
   above it; the marker is recorded in the lock and shown in the law listing. Building with `RUSTY_BENDS_UPDATE_LAWS=<name>[,<name>...]`
   seals or re-accepts only the named laws (leaving other new laws unsealed and keeping tampered checks active for all other laws), `RUSTY_BENDS_UPDATE_LAWS=comments` refreshes `# promise` / `# harm` / `# unchecked` lines without sealing new laws, and `RUSTY_BENDS_UPDATE_LAWS=1`
   rewrites the whole lock from current sources once proofs and mutation checks pass; every update reports what was sealed, re-accepted, removed, or reworded.
   Build once without it first, and review the lock's diff.
4. **Erasure, emission, and per-law tests.** It drops laws, proof `def`s, equality lemmas and
   other `q=0` terms from the runtime output, resolves sibling file import aliases
   (`import sibling.bend as X`), writes the remaining functions and ADTs
   (`pub enum`, `Box<T>`-indirected recursive ADTs and built-in `List<T>`, `match`, `Nat` / fixed-width integers / `Bool` / pairs) to
   `$OUT_DIR/verified.rs`, and appends generated `#[cfg(test)]` per-law tests so
   `cargo test` checks the emitted Rust directly.

`Nat` arithmetic emits `checked_add` / `checked_mul` (panicking on `u64` overflow so
emitted Rust agrees with mathematical `Nat` wherever it returns) together with
`saturating_sub` and total division (`0 - x == 0`, `a / 0 == 0`, `a % 0 == a`).
`RUSTY_BENDS_LIST_PANICS=1` lists every such panic site as `function: op at file:line`.
A `def` with `# rusty-bends: total` directly above it emits as `Option<T>` instead,
returning `None` on overflow, for functions fed by untrusted input.

The crate has no dependencies beyond the Rust standard library.

## Using it in a crate

```toml
# Cargo.toml — build dependency only, never a regular dependency
[build-dependencies]
rusty-bends-build = { git = "https://github.com/Josephur/RustyBends" }
```

```rust
// build.rs
fn main() {
    rusty_bends_build::verify_and_emit("verified");
}
```

```rust
// src/main.rs
mod verified {
    include!(concat!(env!("OUT_DIR"), "/verified.rs"));
}

fn main() {
    let total = verified::deposit(100, 25);
    println!("{total}");
}
```

```bend
# verified/core.bend
import Base

def deposit(bal: Nat, amt: Nat) -> Nat:
  Nat.add(bal, amt)

# promise: depositing into a zero balance yields the deposited amount unchanged
# harm: an initial deposit could lose or inflate customer funds
law deposit_from_zero:
  for amt: Nat
  {deposit(0n, amt) == amt : Nat}

def deposit_from_zero(amt):
  {==}
```

[`example-app/`](example-app) is a complete working crate (ADTs, `match`, multi-line
headers, laws and proofs). [`BEND_GUIDE.md`](BEND_GUIDE.md) is the guide to the Bend 2
syntax and emitter conventions that RustyBends supports; read it before writing `.bend`
code, and hand it to a coding agent working on a RustyBends project.

## Bundled `Nat` arithmetic lemma library (`nat_lemmas.bend`)

`rusty-bends-build` bundles [`rusty-bends-build/lemmas/nat_lemmas.bend`](rusty-bends-build/lemmas/nat_lemmas.bend)
(also exposed as `rusty_bends_build::NAT_LEMMAS_BEND` and materialized idempotently into `verified/` by
`rusty_bends_build::write_nat_lemmas("verified")` before `verify_and_emit("verified")`).
Import it in any file under `verified/` with `import nat_lemmas.bend as L`. Every definition is
`q=0` and completely erased before Rust emission, and provides:

- **Ex falso / Bool refutation:** `bool_pick_type`, `bool_false_ne_true`, `bool_true_ne_false`, `bool_absurd`, `bool_absurd_tf`.
- **Order & `min`/`max`:** `nat_le_refl`, `nat_le_zero`, `nat_le_succ_r`, `nat_lt_succ_self`, `nat_lt_succ_eq_le`, `nat_lt_imp_le`, `nat_not_lt_imp_le`, `nat_le_subst_r`, `nat_lt_subst_r`, `nat_lt_subst_l`, `nat_le_trans`, `nat_lt_trans`, `nat_lt_le_trans`, `nat_le_lt_trans`, `nat_lt_not_le`, `nat_lt_le_false`, `nat_le_lt_false`, `nat_le_antisym`, `nat_le_add_add`, `nat_add_not_lt_l`, `nat_min_le_l`, `nat_min_le_r`, `nat_max_ge_l`, `nat_max_ge_r`, `nat_min_comm`, `nat_max_comm`.
- **Addition & subtraction:** `nat_add_zero_r`, `nat_add_succ_r`, `nat_add_comm`, `nat_add_assoc`, `nat_add_le_l`, `nat_add_le_r`, `nat_add_lt_l`, `nat_add_le_mono`, `nat_add_lt_le_mono`, `nat_sub_zero_r`, `nat_sub_self`, `nat_add_sub_cancel_l`, `nat_add_sub_cancel_r`, `nat_add_cancel_l`, `nat_sub_add_cancel`, `nat_sub_lt`.
- **Multiplication:** `nat_mul_zero_r`, `nat_mul_one_r`, `nat_mul_succ_r`, `nat_mul_comm`, `nat_mul_add_dist_r`, `nat_mul_add_dist_l`, `nat_mul_assoc`, `nat_mul_le_mono_r`, `nat_mul_le_mono_l`, `nat_mul_le_mono`.
- **Division, modulo & alignment (`1n+bp > 0`):** `nat_mod_lt`, `nat_div_mod`, `nat_div_mod_r`, `nat_div_lt_of_lt_mul`, `nat_div_lt_of_lt_mul_l`, `nat_split_unique_q`, `nat_split_unique_r`, `nat_div_split`, `nat_mod_split`, `nat_div_small`, `nat_mod_small`, `nat_eq_of_div_mod`, `nat_split_lt`, `nat_mod_mul`, `nat_div_mul`, and `nat_align_down_le`.

## Requirements

- Rust (stable).
- Bend 2 (2.0.40 or later), looked up at `~/.bend/bin/bend`, on `PATH`, or at `BEND_BIN`.
- Lean, for `--verdict` proof checking, looked up at `~/.elan/bin` or on `PATH`.

## Environment variables

| Variable | Effect |
|---|---|
| `BEND_VERDICT` | `auto` (default): run `--verdict` when Lean is available, warn otherwise. `require`: fail the build without Lean (use in CI). `off`: `--check-only` only. |
| `BEND_BIN` | Path of the `bend` binary. |
| `BEND_PIN_VERSION` | Required Bend version prefix (overrides `bend.pin`). |
| `BEND_CHECK_FLAG`, `BEND_VERDICT_FLAG` | Override the `--check-only` / `--verdict` flags. |
| `BENDTT` | When set, `--verdict` counts as available even if `lean` is not in `~/.elan/bin` or on `PATH`. |
| `RUSTY_BENDS_UPDATE_LAWS` | `<name>[,<name>...]`: seal, re-accept, or remove only the named laws (leaving other new laws unsealed and failing on tampering elsewhere). `comments`: update `# promise` / `# harm` / `# unchecked` comment lines of locked laws without sealing new laws. `1`: rewrite the entire `rusty-bends.lock` from current sources. Every update reports sealed, re-accepted, removed, and comment-updated laws. |
| `RUSTY_BENDS_MUTATE` | `all`: evaluates both new and locked laws and prints one caught/survived summary line per law (plus any dropped-mutant counts). `report`: evaluates every generated mutant of every law (new and locked), prints per-mutant `caught`/`survived` lines, and writes `OUT_DIR/rusty-bends-mutants.txt`. |
| `RUSTY_BENDS_LIST_LAWS` | `1`: prints each law as `name: promise` during builds so reviewers can read plain-English guarantees without reading Bend 2 syntax (also available via `cargo run -p rusty-bends-build --bin rusty-bends-laws -- [dir]`). Laws with an `# unchecked:` marker show `[unchecked: <why>]`. |
| `RUSTY_BENDS_LIST_PANICS` | `1`: prints every checked-growth `Nat` panic site in the emitted Rust as `RustyBends panic [function]: op at file:line`, plus a total. Non-total functions that reach a panicking function through calls are listed as `call <callee>`. |
| `RUSTY_BENDS_LIST_COVERAGE` | `1`: prints each emitted function's direct and transitive law coverage, functions reached by no law, and laws naming only functions that production code never calls (also via `rusty-bends-laws --coverage [dir]`). Only calls, `path::name` references, and `use` imports count; same-named fields, locals, and methods do not. Calls from `tests/`, `benches/`, `#[cfg(test)]`, or `#[test]` code are reported as `rust=tests-only`. |
| `RUSTY_BENDS_NO_CACHE` | `1`: bypasses the incremental `OUT_DIR/rusty-bends.cache` check and the `OUT_DIR/rusty-bends-mutate.cache` mutation results for that build (the cache is also keyed by the `rusty-bends-build` source hash, verdict status, CLI flags, and Bend binary/version). |

## Repository layout

| Path | What |
|---|---|
| `rusty-bends-build/` | The build crate: proof gate (`lib.rs`), law lock & `# promise:` parser (`lock.rs`), Rust emitter (`emit.rs`), per-law test & counterexample evaluator (`law_test.rs`), mutation checker (`mutate.rs`), coverage analyzer (`coverage.rs`), bundled `Nat` lemma library (`lemmas/nat_lemmas.bend`), and CLI lister (`src/bin/rusty-bends-laws.rs`). |
| `example-app/` | A minimal crate using it. |
| `BEND_GUIDE.md` | Bend 2 + RustyBends coding guide. |
| `src/`, `index.html`, `package.json` | **BendTT Kernel Workbench**, a browser tool (React + Vite) to parse Bend, inspect the AST and quantity erasure, trace proofs, suggest laws and preview the emitted Rust. Run it with `npm install && npm run dev`. It is an exploration aid; the build crate is the authority. |
| `setup-rusty-bends.sh` | Script that writes a fresh workspace (`rusty-bends-build` + `example-app`). |
| `upstream/bend`, `upstream/rust` | Read-only git submodules of [bendlang/bend](https://github.com/bendlang/bend) and [rust-lang/rust](https://github.com/rust-lang/rust), kept as reference. Not needed to build; fetch with `git submodule update --init` if you want them (`upstream/rust` is shallow). |

## Building and testing

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
BEND_VERDICT=require cargo test
```

## Status

RustyBends supports the subset of Bend 2 that a verified core needs (see `BEND_GUIDE.md`),
and grows as real projects need more. If you hit an emitter limitation or a Bend 2 form that
the emitter rejects, please open an issue with a minimal `.bend` reproducer and the exact
error.

## License

[Apache License 2.0](LICENSE).
