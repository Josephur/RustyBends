# RustyBends

Rust implementation of [Bend 2](https://github.com/bendlang/bend) as a
reusable crate: parse, check, and compile Bend 2 programs from Rust.

## Layout

- `upstream/bend` — git submodule pointing at the canonical Bend 2
  source ([bendlang/bend](https://github.com/bendlang/bend)). Read-only
  reference; do not edit. The Bend 2 compiler sources live under
  `upstream/bend/bend2/`.
- `upstream/rust` — shallow (`--depth 1`) git submodule of the Rust
  compiler source ([rust-lang/rust](https://github.com/rust-lang/rust)).
  Read-only reference for compiler internals (`compiler/`,
  `library/`); do not edit. To deepen later:
  `git -C upstream/rust fetch --unshallow`.
- `crates/` — our Rust crates (planned; not yet scaffolded).

## Upstream pin

See `.gitmodules` for the tracked upstream URL. The pinned commit is
recorded in the `upstream/bend` gitlink (`git submodule status`).

Update the reference with:

```sh
git submodule update --remote upstream/bend
git add upstream/bend
git commit -m "chore: bump upstream bend pin"
```
