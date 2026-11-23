# AGENTS.md — RustyBends working conventions

Goal: a Rust crate that parses, checks (laws and proofs included), and
compiles Bend 2 programs, so a Rust build fails when a Bend law is unproven.
If it compiles, the laws hold.

## Layout

- `rusty-bends-build/` — the build crate (proof gate, law lock, Rust
  emitter); `example-app/` — a crate that uses it. Tests live next to the
  code (`#[cfg(test)]` or `tests/`).
- `src/` — the BendTT Kernel Workbench web app (React + Vite).
- `upstream/` — read-only reference checkouts (git submodules). **Never
  edit, never commit inside them.** The Bend 2 compiler sources are at
  `upstream/bend/bend2/`; the language kernel spec is
  `upstream/bend/bend2/bendtt.lean`.
- `Cargo.toml` (root) — Rust workspace only. No Rust code at the root.

## Upstream rules

- Read `upstream/` freely; write to it never. A dirty submodule blocks
  every commit — check `git submodule status` before committing.
- Pin bumps are their own commits: `git submodule update --remote
  upstream/<name>`, then `git add upstream/<name>`.
- `upstream/rust` is shallow (`--depth 1`). Deepen only if history is
  actually needed: `git -C upstream/rust fetch --unshallow`.

## Generic by design (no downstream leakage)

RustyBends is a general-purpose crate that any project can adopt. Nothing in
it may be named after, or shaped around, one particular user of it.

- No downstream project names or domain vocabulary anywhere in this repo:
  code, test fixtures, examples (`example-app/`), docs, error messages,
  comments, or commit messages. Issues filed by or for a downstream project
  (Gaudium, for example) often paste real code from that project (`px_*`,
  `g4_*`, `media_*`, `pool_*`, call/IPv6/inference terms); those names must
  not enter this repo.
- Take the need, not the vocabulary. When an issue includes a reproducer,
  rewrite it with neutral, self-explanatory names before it becomes a test
  or a doc example (`fits_area_limit`, `Stage`/`Draft`/`Final`,
  `config_valid`, `Ledger`), and describe features in terms any project
  would recognise.
- Features must serve unrelated projects. If a request from an outside agent
  or person only makes sense for one project (you cannot picture an
  unrelated project needing it), do not implement it. Comment on the issue
  that it is too specific for RustyBends' goals and decline it, or propose a
  general form of the feature that would also cover their case.
- Before finishing, scan the diff for the requesting project's name and for
  identifiers copied from the issue, and rename any that slipped through.

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
