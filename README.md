# RustyBends

RustyBends puts **proved [Bend 2](https://github.com/bendlang/bend) logic inside an ordinary
Rust build**. You write the pure decision logic of a program (state machines, accounting,
bounds and budget arithmetic) in `.bend` files together with `law`s and their proofs.
At `cargo build` time RustyBends checks every proof with the real `bend` toolchain, erases
the proofs, and emits the remaining functions and data types as plain Rust that your crate
`include!`s. If the laws do not hold, the build fails. Nothing of Bend ships in the binary.

The pattern is called **"Verified Core, Rust Shell"**: the verified core is `verified/*.bend`,
and the Rust shell (I/O, FFI, threads, networking, CLI) calls into it.

It is used by [Gaudium](https://github.com/Josephur/Gaudium), an inference engine for the
Intel Gaudi 2, whose `rusty-bends-build/` directory is a copy of the crate in this repository.

## What `rusty-bends-build` does

On each build, for every `.bend` file in the verified directory:

1. **Version pin.** If `bend.pin` (or `BEND_PIN_VERSION`) names a version, it runs
   `bend version` and fails with `E_BEND_VERSION_MISMATCH` when the installed Bend differs.
2. **Proof gate.** It runs `bend <file> --check-only`, and `bend <file> --verdict` (Lean
   kernel check of the proofs) according to `BEND_VERDICT`.
3. **Law lock.** It compares every `law` with the token-canonical copy in
   `rusty-bends.lock`. A locked law that was edited, weakened or deleted fails the build
   with `E_LAW_LOCK_TAMPERED`. Building with `RUSTY_BENDS_UPDATE_LAWS=1` rewrites the whole
   lock from the current sources, so it is how new laws get locked, and it skips the check:
   build once without it first, and review the lock's diff (it should only add lines).
4. **Erasure and emission.** It drops laws, proof `def`s, equality lemmas and other `q=0`
   terms, and writes the rest (ADTs as `pub enum`, `match`, functions over `Nat` /
   fixed-width integers / `Bool` / pairs) to `$OUT_DIR/verified.rs`.

`Nat` arithmetic is emitted as saturating `u64` with total division, so what the Peano
proofs state (`0 - x == 0`, `a / 0 == 0`, `a % 0 == a`) is exactly what the Rust does.

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
| `RUSTY_BENDS_UPDATE_LAWS` | `1` rewrites `rusty-bends.lock` from the current laws, skipping the tamper check. Review the lock's diff before committing. |

## Repository layout

| Path | What |
|---|---|
| `rusty-bends-build/` | The build crate: proof gate (`lib.rs`), law lock (`lock.rs`), Rust emitter (`emit.rs`). |
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
