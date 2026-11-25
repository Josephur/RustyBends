//! Build script for `rusty-bends-build`.
//!
//! Computes a deterministic compile-time hash of this crate's own manifest,
//! build script, `src/`, and `lemmas/` sources and exposes it via
//! `RUSTY_BENDS_BUILD_HASH`. Downstream build caches include this hash so
//! updating or patching `rusty-bends-build` automatically invalidates cached
//! `OUT_DIR/verified.rs` and mutation results without needing `cargo clean`.

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
    dirs.push(rel.to_string_lossy().replace('\\', "/"));
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
            files.push(child_rel.to_string_lossy().replace('\\', "/"));
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
    fnv1a_update(&mut hash, b"rb-builder-v1\0");
    for file in &files {
        let full = manifest_dir.join(file);
        let bytes =
            fs::read(&full).unwrap_or_else(|e| panic!("failed to read {}: {e}", full.display()));
        fnv1a_update(&mut hash, file.as_bytes());
        fnv1a_update(&mut hash, b"\0");
        fnv1a_update(&mut hash, &(bytes.len() as u64).to_le_bytes());
        fnv1a_update(&mut hash, &bytes);
        fnv1a_update(&mut hash, b"\0");
    }

    println!("cargo:rustc-env=RUSTY_BENDS_BUILD_HASH={hash:032x}");
}
