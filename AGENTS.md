# AGENTS.md — RustyBends working conventions

Goal: a Rust crate that parses, checks (laws and proofs included), and
compiles Bend 2 programs, so a Rust build fails when a Bend law is unproven.
If it compiles, the laws hold.

## Layout

- `crates/` — our code. All new Rust code lives here, one crate per
  directory. Tests live next to the code (`#[cfg(test)]` or `tests/`).
- `upstream/` — read-only reference checkouts (git submodules). **Never
  edit, never commit inside them.** The Bend 2 compiler sources are at
  `upstream/bend/bend2/`; the language kernel spec is
  `upstream/bend/bend2/bendtt.lean`.
- `Cargo.toml` (root) — workspace only. No code at the root.

## Upstream rules

- Read `upstream/` freely; write to it never. A dirty submodule blocks
  every commit — check `git submodule status` before committing.
- Pin bumps are their own commits: `git submodule update --remote
  upstream/<name>`, then `git add upstream/<name>`.
- `upstream/rust` is shallow (`--depth 1`). Deepen only if history is
  actually needed: `git -C upstream/rust fetch --unshallow`.

## Source of truth

- Behavior is defined by the reference implementation, not by these docs:
  when in doubt, run `bend` (installed at `~/.bend/bin`) against
  `upstream/bend` demos/tests and match it.
- Semantics must mirror BendTT (`bendtt.lean`): the dead/live split is
  load-bearing. `q=0` parts are checked and erased — they must never reach
  codegen or runtime. Preserve this in every port.
- Lean (`~/.elan/bin`) checks the formal kernel only. It never runs
  programs and never touches the GPU.

## Verification before finishing

- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
  `cargo test` — all green, every time. No exceptions for scaffolding.
- New behavior needs differential coverage: test against the reference
  `bend --check-only` (and `--verdict` for proofs) on real `.bend` files
  from `upstream/bend/demos` and `upstream/bend/tests`.
- Proofs live at compile time. Nothing proof-related ships in a runtime
  binary; keep checking code out of runtime-emit paths.

## Hygiene

- `target/` is gitignored — never commit build output.
- Keep diffs focused: one concern per commit, conventional message
  (`feat:`, `fix:`, `chore:`, `docs:`).
- Do not add dependencies without a note in the commit message saying why
  the stdlib or existing deps couldn't cover it.
