#!/usr/bin/env sh
set -eu

echo "Creating RustyBends v1 Cargo workspace..."

mkdir -p "example-app"
mkdir -p "example-app/src"
mkdir -p "example-app/verified"
mkdir -p "rusty-bends-build"
mkdir -p "rusty-bends-build/src"

cat << 'RUSTY_BENDS_EOF' > "rusty-bends-build/Cargo.toml"
[package]
name = "rusty-bends-build"
version = "1.0.0"
edition = "2021"
description = "Build-time Bend 2 proof gate (--check-only / --verdict), token-canonical LAWS lock, bend.pin check, and pure Rust ADT/match OUT_DIR emitter"
license = "Apache-2.0"

[dependencies]
# Zero external dependencies — Rust stdlib only!
RUSTY_BENDS_EOF

cat << 'RUSTY_BENDS_EOF' > "rusty-bends-build/src/lib.rs"
//! rusty-bends-build v1: compile-time Bend 2 proof gate, AST/token law lock,
//! Bend version-pin checker, and pure Rust ADT/match OUT_DIR emitter.
//!
//! Add this crate under '[build-dependencies]' (never '[dependencies]') so nothing
//! proof-related ever links into your final binary:
//!
//! // build.rs
//! fn main() {
//!     rusty_bends_build::verify_and_emit("verified");
//! }

pub mod emit;
pub mod lock;

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
    pub emit_rust: bool,
}

impl Default for Config {
    fn default() -> Self {
        let verdict_mode = env::var("BEND_VERDICT")
            .map(|v| VerdictMode::parse(&v))
            .unwrap_or(VerdictMode::Auto);
        Self {
            verified_dir: PathBuf::from("verified"),
            bend_bin: env::var("BEND_BIN").unwrap_or_else(|_| "bend".to_string()),
            check_flag: env::var("BEND_CHECK_FLAG").unwrap_or_else(|_| "--check-only".to_string()),
            verdict_flag: env::var("BEND_VERDICT_FLAG").unwrap_or_else(|_| "--verdict".to_string()),
            verdict_mode,
            lock_file: PathBuf::from("rusty-bends.lock"),
            pin_file: PathBuf::from("bend.pin"),
            pinned_version: env::var("BEND_PIN_VERSION").ok().filter(|v| !v.trim().is_empty()),
            out_dir: PathBuf::from(env::var("OUT_DIR").unwrap_or_else(|_| "target".to_string())),
            allow_lock_update: env::var("RUSTY_BENDS_UPDATE_LAWS").ok().as_deref() == Some("1"),
            emit_rust: true,
        }
    }
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
                "compile_error!(\"RustyBends verification failed — fix Bend 2 proofs or lock violations.\");\n",
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
    println!("cargo:rerun-if-env-changed=BEND_BIN");
    println!("cargo:rerun-if-env-changed=BEND_PIN_VERSION");
    println!("cargo:rerun-if-env-changed=BEND_VERDICT");
    println!("cargo:rerun-if-env-changed=BENDTT");

    // Verify Bend CLI version pin if bend.pin or BEND_PIN_VERSION is configured
    if let Some(expected_pin) = read_active_pin(cfg)? {
        let actual_ver = query_bend_version(&cfg.bend_bin)?;
        verify_bend_version_str(&expected_pin, &actual_ver)?;
    }

    run_with_checker(cfg, |file, has_laws| {
        println!("cargo:rerun-if-changed={}", file.display());
        verify_with_bend_cli(cfg, file, has_laws)
    })
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

/// Checks whether the installed 'bend --version' string satisfies the pinned prefix.
pub fn verify_bend_version_str(expected_pin: &str, actual_output: &str) -> Result<(), String> {
    let trimmed_pin = expected_pin.trim();
    if trimmed_pin.is_empty() || actual_output.contains(trimmed_pin) {
        return Ok(());
    }
    Err(format!(
        "[E_BEND_VERSION_MISMATCH] Pinned Bend version '{trimmed_pin}' does not match installed '{}'.\nHint: Install the pinned Bend 2 release or update bend.pin / BEND_PIN_VERSION.",
        actual_output.trim()
    ))
}

fn query_bend_version(bend_bin: &str) -> Result<String, String> {
    let output = Command::new(bend_bin)
        .arg("--version")
        .output()
        .map_err(|e| {
            format!("[E_BEND_MISSING] Failed to run '{bend_bin} --version': {e}\nHint: Install Bend 2 (~/.bend/bin) or set BEND_BIN=/path/to/bend")
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(format!("{stdout}{stderr}"))
}

/// Core pipeline with pluggable 'bend' runner for deterministic unit testing.
pub fn run_with_checker<F>(cfg: &Config, mut checker: F) -> Result<Option<PathBuf>, String>
where
    F: FnMut(&Path, bool) -> Result<(), String>,
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

    // 1. Enforce AST/token-canonical LAWS lock before running Bend
    let law_count = lock::enforce_law_lock(&cfg.lock_file, &bend_files, cfg.allow_lock_update)?;

    // 2. Check incremental content-hash cache for fast no-op rebuilds
    fs::create_dir_all(&cfg.out_dir).map_err(|e| e.to_string())?;
    let cache_file = cfg.out_dir.join("rusty-bends.cache");
    let verified_rs = cfg.out_dir.join("verified.rs");
    let combined_hash = hash_files(&bend_files)?;

    let cache_hit = fs::read_to_string(&cache_file)
        .map(|s| s.trim() == combined_hash)
        .unwrap_or(false);
    if cache_hit && (!cfg.emit_rust || verified_rs.exists()) {
        return Ok(if cfg.emit_rust { Some(verified_rs) } else { None });
    }

    // 3. Run real Bend 2 checker (--check-only, plus --verdict when laws are present)
    let mut combined_source = String::new();
    for file in &bend_files {
        let text = fs::read_to_string(file).map_err(|e| e.to_string())?;
        let is_laws_file = file
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case("LAWS.bend"))
            .unwrap_or(false);
        let has_laws = is_laws_file || !lock::extract_laws_from_source(&text).is_empty();

        checker(file, has_laws)?;
        combined_source.push_str(&text);
        combined_source.push('\n');
    }

    // 4. Erase q=0 parts and emit pure Rust (ADTs + match + defs) into OUT_DIR/verified.rs
    let emitted_path = if cfg.emit_rust {
        let summary = emit::emit_verified_rust(&combined_source, law_count)?;
        fs::write(&verified_rs, summary.rust_source).map_err(|e| e.to_string())?;
        Some(verified_rs)
    } else {
        None
    };

    // 5. Persist passing content hash
    fs::write(&cache_file, &combined_hash).map_err(|e| e.to_string())?;
    Ok(emitted_path)
}

fn verify_with_bend_cli(cfg: &Config, file: &Path, has_laws: bool) -> Result<(), String> {
    run_bend_step(&cfg.bend_bin, &cfg.check_flag, file)?;
    if !has_laws || cfg.verdict_flag.trim().is_empty() || cfg.verdict_mode == VerdictMode::Off {
        return Ok(());
    }

    match cfg.verdict_mode {
        VerdictMode::Off => Ok(()),
        VerdictMode::Require => run_bend_step(&cfg.bend_bin, &cfg.verdict_flag, file),
        VerdictMode::Auto => {
            if !has_verdict_runtime() {
                println!(
                    "cargo:warning=RustyBends: {} passed --check-only; skipping optional --verdict Lean cross-check (install Lean/elan or set BEND_VERDICT=require in CI).",
                    file.display()
                );
                return Ok(());
            }
            match run_bend_step(&cfg.bend_bin, &cfg.verdict_flag, file) {
                Ok(()) => Ok(()),
                Err(err) if is_missing_lean_error(&err) => {
                    println!(
                        "cargo:warning=RustyBends: {} passed --check-only; skipping optional --verdict (Lean kernel unavailable). Set BEND_VERDICT=require to enforce.",
                        file.display()
                    );
                    Ok(())
                }
                Err(err) => Err(err),
            }
        }
    }
}

fn has_verdict_runtime() -> bool {
    if env::var("BENDTT").ok().filter(|v| !v.trim().is_empty()).is_some() {
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
        || err.contains("Executable not found in $PATH: \"lean\"")
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
            "[E_BEND_MISSING] Failed to run '{bend_bin} {} {flag}': {e}\nHint: Install Bend 2 (~/.bend/bin) or set BEND_BIN=/path/to/bend",
            file.display()
        )
    })?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "[E_BEND_CHECK_FAILED] '{bend_bin} {} {flag}' failed:\n{stdout}{stderr}",
            file.display()
        ));
    }
    Ok(())
}

fn collect_bend_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
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
    let mut buf = Vec::new();
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
        let dir = env::temp_dir().join(format!(
            "rusty_bends_v1_{name}_{}_{n}",
            std::process::id()
        ));
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
            emit_rust: true,
        }
    }

    #[test]
    fn verify_and_emit_generates_adt_rust_and_caches() {
        let root = temp_workspace("emit_adt_cache");
        fs::write(
            root.join("verified/core.bend"),
            "type Status:\n  Open\n  Closed\n\ndef close(+s: Status) -> Status:\n  match s:\n    case Status.Open => Status.Closed\n    case Status.Closed => Status.Closed\n\nlaw close_idem(for +s: Status):\n  close(close(s)) == close(s)\n\nproof close_idem:\n  match s:\n    case Status.Open => refl\n    case Status.Closed => refl\n",
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
        assert!(emitted.contains("pub enum Status"));
        assert!(emitted.contains("Status::Open => Status::Closed,"));
        assert!(!emitted.contains("law close_idem"));

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
    fn lock_blocks_weakened_law_and_approves_human_update() {
        let root = temp_workspace("lock_tamper");
        let core = root.join("verified/core.bend");
        fs::write(
            &core,
            "def inc(+n: Nat) -> Nat:\n  n + 1n\n\nlaw inc_two:\n  inc(2n) == 3n\n\nproof inc_two:\n  refl\n",
        )
        .unwrap();

        let cfg = make_cfg(&root);
        run_with_checker(&cfg, |_, _| Ok(())).expect("initial lock creation");

        fs::write(
            &core,
            "def inc(+n: Nat) -> Nat:\n  n + 1n\n\nlaw inc_two:\n  3n == 3n\n\nproof inc_two:\n  refl\n",
        )
        .unwrap();

        let err = run_with_checker(&cfg, |_, _| Ok(())).expect_err("must fail on tampered law");
        assert!(err.contains("E_LAW_LOCK_TAMPERED"));

        let mut approved_cfg = make_cfg(&root);
        approved_cfg.allow_lock_update = true;
        run_with_checker(&approved_cfg, |_, _| Ok(())).expect("approved update succeeds");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bend_version_pin_detects_mismatch() {
        assert!(verify_bend_version_str("0.2.38", "bend 0.2.38 (commit abc123)").is_ok());
        let err = verify_bend_version_str("0.2.38", "bend 0.3.0").unwrap_err();
        assert!(err.contains("E_BEND_VERSION_MISMATCH"));
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
}
RUSTY_BENDS_EOF

cat << 'RUSTY_BENDS_EOF' > "rusty-bends-build/src/lock.rs"
//! AST/token-aware anti-cheat law lock for RustyBends v1.
//!
//! Unlike naive line scanners, this module strips comments (# and --), tokenizes the full
//! multi-line `law ...` declaration up to the next top-level item (`type`, `def`, `law`, `proof`),
//! and hashes the canonical token stream.
//!
//! Guarantees:
//! - Reformatting whitespace or adding comments inside a law NEVER triggers false lock failures.
//! - Editing any quantifier, operator, or expression inside a multi-line law trips E_LAW_LOCK_TAMPERED.
//! - Deleting a locked law trips E_LAW_LOCK_TAMPERED.
//! - Adding a brand-new law is allowed without unlocking.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalLaw {
    pub name: String,
    pub canonical_sig: String,
    pub hash: String,
}

/// Extracts all `law` blocks across the provided `.bend` files in canonical token form.
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

/// Tokenizes Bend source (stripping comments and whitespace) and extracts every full multi-line `law`.
pub fn extract_laws_from_source(source: &str) -> Vec<CanonicalLaw> {
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
            let canonical_sig = tokens[start..i].join(" ");
            let hash = fnv1a_hex(canonical_sig.as_bytes());
            laws.push(CanonicalLaw {
                name,
                canonical_sig,
                hash,
            });
            continue;
        }
        i += 1;
    }

    laws
}

/// Enforces `rusty-bends.lock` against the canonicalized laws in `files`.
pub fn enforce_law_lock(
    lock_file: &Path,
    files: &[PathBuf],
    allow_lock_update: bool,
) -> Result<usize, String> {
    let current = extract_canonical_laws(files)?;
    let serialized = current
        .values()
        .map(|law| format!("{}  {}  {}", law.hash, law.name, law.canonical_sig))
        .collect::<Vec<_>>()
        .join("\n");

    if allow_lock_update || !lock_file.exists() {
        fs::write(lock_file, &serialized).map_err(|e| e.to_string())?;
        return Ok(current.len());
    }

    let expected_raw = fs::read_to_string(lock_file).map_err(|e| e.to_string())?;
    for line in expected_raw.lines().filter(|l| !l.trim().is_empty()) {
        let parts: Vec<&str> = line.splitn(3, "  ").collect();
        if parts.len() < 2 {
            // Backward compatibility with legacy lock lines
            if !serialized.lines().any(|cur| cur == line) {
                return Err(format!(
                    "[E_LAW_LOCK_TAMPERED] Locked law altered or deleted: '{line}'.\nHint: Restore the original law or run RUSTY_BENDS_UPDATE_LAWS=1 cargo check."
                ));
            }
            continue;
        }
        let expected_hash = parts[0].trim();
        let law_name = parts[1].trim();
        match current.get(law_name) {
            None => {
                return Err(format!(
                    "[E_LAW_LOCK_TAMPERED] Locked law '{law_name}' was deleted.\nHint: Restore 'law {law_name}' in verified/, or approve intentionally with RUSTY_BENDS_UPDATE_LAWS=1 cargo check."
                ));
            }
            Some(actual) if actual.hash != expected_hash => {
                return Err(format!(
                    "[E_LAW_LOCK_TAMPERED] Locked law '{law_name}' was modified (expected {expected_hash}, got {}).\nHint: Restore the original law statement, or approve intentionally with RUSTY_BENDS_UPDATE_LAWS=1 cargo check.",
                    actual.hash
                ));
            }
            Some(_) => {}
        }
    }

    Ok(current.len())
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
            while i < chars.len() && chars[i] != '\n' {
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
            "law conserved(for +a: Nat, for +b: Nat):\n  deposit(a, b) == deposit(b, a)\nproof conserved:\n  refl\n",
        )
        .unwrap();
        assert_eq!(enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap(), 1);

        // Multi-line reformat + comments inside the law must remain locked-valid!
        fs::write(
            &file,
            "# header comment\nlaw conserved(\n  for +a: Nat,\n  -- inline note\n  for +b: Nat\n):\n  deposit(a, b)\n    ==\n  deposit(b, a)\n\nproof conserved:\n  refl\n",
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
            "law cancel_idempotent(\n  for +s: OrderState\n):\n  cancel_order(\n    cancel_order(s)\n  ) == cancel_order(s)\n\nproof cancel_idempotent:\n  refl\n",
        )
        .unwrap();
        enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap();

        // Subtle change on line 6 of the multi-line law must be caught
        fs::write(
            &file,
            "law cancel_idempotent(\n  for +s: OrderState\n):\n  cancel_order(\n    s\n  ) == cancel_order(s)\n\nproof cancel_idempotent:\n  refl\n",
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

        fs::write(&file, "law keep_me:\n  1n == 1n\nproof keep_me:\n  refl\n").unwrap();
        enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap();

        fs::write(&file, "def x(+n: Nat) -> Nat:\n  n\n").unwrap();
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

        fs::write(&file, "law first:\n  1n == 1n\nproof first:\n  refl\n").unwrap();
        enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap();

        fs::write(
            &file,
            "law first:\n  1n == 1n\nproof first:\n  refl\n\nlaw second:\n  2n == 2n\nproof second:\n  refl\n",
        )
        .unwrap();
        assert_eq!(enforce_law_lock(&lock, &[file], false).unwrap(), 2);
        let _ = fs::remove_dir_all(&dir);
    }
}
RUSTY_BENDS_EOF

cat << 'RUSTY_BENDS_EOF' > "rusty-bends-build/src/emit.rs"
//! Erased-core BendTT v1 -> Pure Rust code emitter.
//!
//! Runs *only after* the real 'bend' proof checker approves every type, definition, and law.
//! Strictly enforces the BendTT dead/live split:
//! - 'type' ADTs emit '#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum ...'.
//! - 'match' and 'if/else' emit idiomatic Rust pattern matching and conditionals.
//! - 'Dead' (q=0) parameters ('-T: Type') and annotations ('(x : T)') are erased.
//! - 'law' and 'proof' blocks (including match/rewrite proofs) are completely stripped.

use std::collections::{HashMap, HashSet};

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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitSummary {
    pub rust_source: String,
    pub types_emitted: usize,
    pub defs_emitted: usize,
    pub dead_params_erased: usize,
}

#[derive(Debug, Clone)]
struct CtorInfo {
    type_name: String,
    variant_name: String,
    arity: usize,
}

/// Parses Bend v1 'type' and 'def' items from verified source, erases all q=0 parts and laws,
/// and emits zero-dependency Rust ready for include!(concat!(env!("OUT_DIR"), "/verified.rs")).
pub fn emit_verified_rust(source: &str, laws_verified: usize) -> Result<EmitSummary, String> {
    let (types, defs) = parse_book_items(source)?;
    let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
    let mut ctor_map: HashMap<String, CtorInfo> = HashMap::new();
    for td in &types {
        for v in &td.variants {
            let info = CtorInfo {
                type_name: td.name.clone(),
                variant_name: v.name.clone(),
                arity: v.field_types.len(),
            };
            ctor_map.insert(format!("{}.{}", td.name, v.name), info.clone());
            ctor_map.entry(v.name.clone()).or_insert(info);
        }
    }

    let mut dead_params_erased = 0usize;
    let mut blocks = Vec::new();
    let empty_set = HashSet::new();

    for td in &types {
        let mut variants_rs = Vec::new();
        for v in &td.variants {
            if v.field_types.is_empty() {
                variants_rs.push(format!("    {},", v.name));
            } else {
                let mapped: Vec<String> = v
                    .field_types
                    .iter()
                    .map(|t| bend_type_to_rust(t, &empty_set))
                    .collect();
                variants_rs.push(format!("    {}({}),", v.name, mapped.join(", ")));
            }
        }
        blocks.push(format!(
            "#[derive(Debug, Clone, Copy, PartialEq, Eq)]\npub enum {} {{\n{}\n}}",
            td.name,
            variants_rs.join("\n")
        ));
    }

    for def in &defs {
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

        let generics = if type_params.is_empty() {
            String::new()
        } else {
            format!("<{}>", type_params.join(", "))
        };

        let rust_params = live_params
            .iter()
            .map(|p| format!("{}: {}", p.name, bend_type_to_rust(&p.ty, &type_param_set)))
            .collect::<Vec<_>>()
            .join(", ");

        let default_mode = arith_mode_for_type(&def.ret, ArithMode::Saturating);
        let body_expr = emit_expr_with_mode(&def.body, &def_map, &ctor_map, default_mode);
        let ret_ty = infer_return_type(&def.body, &def.ret, &type_param_set);

        blocks.push(format!(
            "#[inline]\n#[allow(unused_variables)]\npub fn {name}{generics}({rust_params}) -> {ret_ty} {{\n    {body_expr}\n}}",
            name = def.name
        ));
    }

    let mut out = String::new();
    out.push_str("// @generated by rusty-bends-build v1 (Verified Core -> Pure Rust)\n");
    out.push_str("// Zero Bend runtime. Zero proof code. All q=0 types and laws were erased.\n");
    out.push_str(&format!(
        "// Types: {} | Verified laws: {laws_verified} | Defs emitted: {} | Dead params erased: {dead_params_erased}\n\n",
        types.len(),
        defs.len()
    ));

    if blocks.is_empty() {
        out.push_str("// No live definitions found in verified/*.bend\n");
    } else {
        out.push_str(&blocks.join("\n\n"));
        out.push('\n');
    }

    Ok(EmitSummary {
        rust_source: out,
        types_emitted: types.len(),
        defs_emitted: defs.len(),
        dead_params_erased,
    })
}

pub fn parse_book_items(source: &str) -> Result<(Vec<TypeDef>, Vec<Def>), String> {
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

        if let Some(rest) = stripped.strip_prefix("def ") {
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

            let body = body_lines.join("\n");
            let def_name = header_part.split('(').next().unwrap_or("").trim();
            let is_eq_proof_ret = header_part
                .split_once("->")
                .map(|(_, ret)| ret.trim().starts_with('{'))
                .unwrap_or(false);

            // Real Bend 2 proof definitions share their law's name, return an equality type '{...}',
            // or omit '->' and return '{==}'. Erase all proof definitions before Rust codegen.
            if law_names.contains(def_name)
                || is_eq_proof_ret
                || (!header_part.contains("->") && body.contains("{==}"))
            {
                continue;
            }

            if body.trim().is_empty() {
                return Err(format!("[E_EMIT_EMPTY_BODY] Empty body in 'def {header_part}'"));
            }
            defs.push(parse_def_header(header_part, body)?);
            continue;
        }

        i += 1;
    }

    Ok((types, defs))
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
        for part in split_top_level(inner, ',') {
            let p = part.trim();
            if p.is_empty() {
                continue;
            }
            if let Some((_fname, fty)) = split_top_level_once(p, ':') {
                field_types.push(fty.trim().to_string());
            } else {
                field_types.push(p.to_string());
            }
        }
    }
    Ok(Variant { name, field_types })
}

fn is_top_level_start(raw_line: &str, trimmed: &str) -> bool {
    let not_indented = !raw_line.starts_with(' ') && !raw_line.starts_with('\t');
    not_indented
        && (trimmed.starts_with("import ")
            || trimmed.starts_with("type ")
            || trimmed.starts_with("def ")
            || trimmed.starts_with("law ")
            || trimmed.starts_with("proof "))
}

fn strip_comment(line: &str) -> &str {
    let mut end = line.len();
    if let Some(pos) = line.find('#') {
        end = end.min(pos);
    }
    if let Some(pos) = line.find("--") {
        end = end.min(pos);
    }
    &line[..end]
}

fn split_header_colon(rest: &str) -> Result<(&str, &str), String> {
    let mut depth = 0i32;
    for (idx, ch) in rest.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
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
        for chunk in split_top_level(params_raw, ',') {
            let item = chunk.trim();
            if item.is_empty() {
                continue;
            }
            let (lhs, ty) = item
                .split_once(':')
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
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArithMode {
    Saturating,
    Wrapping,
}

fn arith_mode_for_type(ty: &str, fallback: ArithMode) -> ArithMode {
    match ty.trim() {
        "U32" | "U64" | "I32" | "I64" => ArithMode::Wrapping,
        "Nat" => ArithMode::Saturating,
        _ => fallback,
    }
}

fn bend_type_to_rust(ty: &str, type_params: &HashSet<String>) -> String {
    let t = ty.trim();
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_top_level(inner, ',');
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
    let amp_parts = split_top_level(t, '&');
    if amp_parts.len() > 1 {
        let mapped = amp_parts
            .into_iter()
            .map(|p| bend_type_to_rust(p, type_params))
            .collect::<Vec<_>>()
            .join(", ");
        return format!("({mapped})");
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
    if !trimmed.contains('\n')
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

fn parse_nat_succ_pattern(p: &str) -> Option<(u64, String)> {
    let (lhs, rhs) = split_top_level_once(p, '+')?;
    let digits = lhs.trim().strip_suffix('n')?;
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let k: u64 = digits.parse().ok()?;
    if k == 0 {
        return None;
    }
    let var = rhs.trim().trim_start_matches('+').trim_start_matches('-').trim();
    if var.is_empty() || !var.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    Some((k, var.to_string()))
}

fn emit_single_pattern(
    pat: &str,
    ctors: &HashMap<String, CtorInfo>,
    succ_counter: &mut usize,
) -> (String, Vec<String>) {
    let p = pat.trim();
    if p == "_" || p == "true" || p == "false" || p == "()" {
        return (p.to_string(), Vec::new());
    }
    if p == "True{}" {
        return ("true".to_string(), Vec::new());
    }
    if p == "False{}" {
        return ("false".to_string(), Vec::new());
    }
    if p == "Unit{}" {
        return ("()".to_string(), Vec::new());
    }
    if let Some((k, var)) = parse_nat_succ_pattern(p) {
        if var == "_" {
            return (format!("{k}_u64..=u64::MAX"), Vec::new());
        }
        let idx = *succ_counter;
        *succ_counter += 1;
        let tmp = format!("__rb_n{idx}");
        return (
            format!("{tmp} @ {k}_u64..=u64::MAX"),
            vec![format!("let {var} = {tmp} - {k}_u64;")],
        );
    }
    if let Some(digits) = p.strip_suffix('n') {
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            return (format!("{digits}_u64"), Vec::new());
        }
    }
    // Tuple pattern: (a, b)
    if is_wrapped_in_parens(p) {
        let inner = p[1..p.len() - 1].trim();
        let parts = split_top_level(inner, ',');
        if parts.len() > 1 {
            let mut rust_parts = Vec::new();
            let mut bindings = Vec::new();
            for part in parts {
                let (rp, mut b) = emit_single_pattern(part, ctors, succ_counter);
                rust_parts.push(rp);
                bindings.append(&mut b);
            }
            return (format!("({})", rust_parts.join(", ")), bindings);
        }
    }
    // Real Bend 2 curly-brace pattern: Draft{}, Paid{amt}, Circle{+r}
    if let Some(open) = p.find('{') {
        if p.ends_with('}') {
            let head = p[..open].trim();
            let inner = p[open + 1..p.len() - 1].trim();
            let rust_head = resolve_ctor_path(head, ctors);
            if inner.is_empty() {
                return (rust_head, Vec::new());
            }
            let mut bindings = Vec::new();
            let fields: Vec<String> = split_top_level(inner, ',')
                .into_iter()
                .map(|b| {
                    let clean = b.trim().trim_start_matches('+').trim_start_matches('-').trim();
                    let rhs = if let Some((_, v)) = clean.split_once(':') {
                        v.trim().trim_start_matches('+').trim_start_matches('-').trim()
                    } else {
                        clean
                    };
                    let (rp, mut bs) = emit_single_pattern(rhs, ctors, succ_counter);
                    bindings.append(&mut bs);
                    rp
                })
                .collect();
            return (format!("{rust_head}({})", fields.join(", ")), bindings);
        }
    }
    if let Some(open) = p.find('(') {
        if p.ends_with(')') {
            let head = p[..open].trim();
            let args = p[open + 1..p.len() - 1].trim();
            let rust_head = resolve_ctor_path(head, ctors);
            return (format!("{rust_head}({args})"), Vec::new());
        }
    }
    (resolve_ctor_path(p, ctors), Vec::new())
}

fn emit_match_pattern(
    pat: &str,
    scrut_count: usize,
    ctors: &HashMap<String, CtorInfo>,
) -> (String, Vec<String>) {
    let mut succ_counter = 0usize;
    if scrut_count > 1 {
        let parts = split_pattern_tokens(pat);
        if parts.len() > 1 {
            let mut rust_parts = Vec::new();
            let mut bindings = Vec::new();
            for part in &parts {
                let (rp, mut b) = emit_single_pattern(part, ctors, &mut succ_counter);
                rust_parts.push(rp);
                bindings.append(&mut b);
            }
            return (format!("({})", rust_parts.join(", ")), bindings);
        }
    }
    emit_single_pattern(pat, ctors, &mut succ_counter)
}

fn resolve_ctor_path(name: &str, ctors: &HashMap<String, CtorInfo>) -> String {
    if let Some(info) = ctors.get(name) {
        return format!("{}::{}", info.type_name, info.variant_name);
    }
    name.replace('.', "::")
}

fn leading_indent(line: &str) -> usize {
    line.chars()
        .take_while(|c| *c == ' ' || *c == '\t')
        .map(|c| if c == '\t' { 4 } else { 1 })
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
    t.trim_start_matches('+').trim_start_matches('-').trim().to_string()
}

fn split_top_level_ws(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start: Option<usize> = None;
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' => {
                if start.is_none() {
                    start = Some(idx);
                }
                depth += 1;
            }
            ')' | '}' => {
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
            "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | ">" | "<=" | ">=" | "&&" | "||"
                | "if" | "let" | "match" | "else:"
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
        if i + 2 < raw.len() && raw[i].ends_with('n') && raw[i + 1] == "+" {
            out.push(format!("{}+{}", raw[i], raw[i + 2]));
            i += 3;
        } else {
            out.push(raw[i].to_string());
            i += 1;
        }
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
                arms.push((prev_pat, cur_body.join("\n")));
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
        arms.push((prev_pat, cur_body.join("\n")));
    }
    arms
}

fn emit_expr_with_mode(
    expr: &str,
    defs: &HashMap<String, &Def>,
    ctors: &HashMap<String, CtorInfo>,
    mode: ArithMode,
) -> String {
    let lines: Vec<&str> = expr.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return "()".to_string();
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
                let val_src = val_lines.join("\n");
                let rest_src = lines[split_idx..].join("\n");
                return format!(
                    "{{\n        let {} = {};\n        {}\n    }}",
                    clean_let_binding(lhs_raw),
                    emit_expr_with_mode(&val_src, defs, ctors, mode),
                    emit_expr_with_mode(&rest_src, defs, ctors, mode)
                );
            }
        }
    }

    // Handle match expressions: indentation-aware nested match, multi-scrutinee match, and single-line match
    if let Some(after_match) = first_trim.strip_prefix("match ") {
        if let Some((scrut_raw, inline_arms)) = split_top_level_once(after_match, ':') {
            let scrut_parts = split_match_scrutinees(scrut_raw);
            let rust_scrut = if scrut_parts.len() > 1 {
                let emitted: Vec<String> = scrut_parts
                    .iter()
                    .map(|p| emit_expr_with_mode(p, defs, ctors, mode))
                    .collect();
                format!("({})", emitted.join(", "))
            } else {
                emit_expr_with_mode(scrut_raw, defs, ctors, mode)
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
            for (pat, arm_body) in parsed_arms {
                let (rust_pat, bindings) = emit_match_pattern(&pat, scrut_parts.len(), ctors);
                let emitted_body = emit_expr_with_mode(&arm_body, defs, ctors, mode);
                if bindings.is_empty() {
                    rust_arms.push(format!("        {rust_pat} => {emitted_body},"));
                } else {
                    rust_arms.push(format!(
                        "        {rust_pat} => {{ {} {emitted_body} }},",
                        bindings.join(" ")
                    ));
                }
            }
            return format!("match {rust_scrut} {{\n{}\n    }}", rust_arms.join("\n"));
        }
    }

    // Collapse remaining multi-line expressions (e.g. multi-line if/else, calls, annotations)
    let owned_flat;
    let s = if lines.len() == 1 {
        first_trim
    } else {
        owned_flat = lines
            .iter()
            .map(|l| l.trim())
            .collect::<Vec<_>>()
            .join(" ");
        owned_flat.as_str()
    };

    if s == "True{}" {
        return "true".to_string();
    }
    if s == "False{}" {
        return "false".to_string();
    }
    if s == "Unit{}" || s == "()" {
        return "()".to_string();
    }

    // Handle conditionals: if cond: then_branch else: else_branch
    if let Some(rest) = s.strip_prefix("if ") {
        if let Some((before_else, after_else)) = split_keyword(rest, " else:") {
            if let Some((cond, then_b)) = split_top_level_once(before_else, ':') {
                return format!(
                    "if {} {{ {} }} else {{ {} }}",
                    emit_expr_with_mode(cond, defs, ctors, mode),
                    emit_expr_with_mode(then_b, defs, ctors, mode),
                    emit_expr_with_mode(after_else, defs, ctors, mode)
                );
            }
        }
    }

    // Unwrap outer parentheses and handle annotations (term : ty) or tuples (a, b, ...)
    if is_wrapped_in_parens(s) {
        let inner = s[1..s.len() - 1].trim();
        let tuple_parts = split_top_level(inner, ',');
        if tuple_parts.len() >= 2 {
            let emitted: Vec<String> = tuple_parts
                .iter()
                .map(|p| emit_expr_with_mode(p, defs, ctors, mode))
                .collect();
            return format!("({})", emitted.join(", "));
        }
        if let Some((term_part, ty_part)) = split_top_level_once(inner, ':') {
            let inner_mode = arith_mode_for_type(ty_part, mode);
            return emit_expr_with_mode(term_part, defs, ctors, inner_mode);
        }
        return emit_expr_with_mode(inner, defs, ctors, mode);
    }

    // Handle single-line let bindings: let x = val; body
    if let Some(rest) = s.strip_prefix("let ") {
        if let Some((binding, body)) = split_top_level_once(rest, ';') {
            if let Some((name, val)) = split_top_level_once(binding, '=') {
                return format!(
                    "{{\n        let {} = {};\n        {}\n    }}",
                    clean_let_binding(name),
                    emit_expr_with_mode(val, defs, ctors, mode),
                    emit_expr_with_mode(body, defs, ctors, mode)
                );
            }
        }
    }

    // Logical and comparison binary operators (lowest to highest precedence)
    for op in ["||", "&&", "==", "!=", "<=", ">=", "<", ">"] {
        if let Some((lhs, rhs)) = split_top_level_str(s, op) {
            return format!(
                "({} {op} {})",
                emit_expr_with_mode(lhs, defs, ctors, mode),
                emit_expr_with_mode(rhs, defs, ctors, mode)
            );
        }
    }

    // Right-to-left top-level '+' or '-' (saturating for Nat, wrapping for U32/U64/I32/I64)
    if let Some((op, lhs, rhs)) = split_last_additive(s) {
        let l = emit_expr_with_mode(lhs, defs, ctors, mode);
        let r = emit_expr_with_mode(rhs, defs, ctors, mode);
        return match (mode, op) {
            (ArithMode::Saturating, '+') => format!("({l}).saturating_add({r})"),
            (ArithMode::Saturating, '-') => format!("({l}).saturating_sub({r})"),
            (ArithMode::Wrapping, '+') => format!("({l}).wrapping_add({r})"),
            (ArithMode::Wrapping, '-') => format!("({l}).wrapping_sub({r})"),
            _ => unreachable!(),
        };
    }

    // Right-to-left top-level '*', '/', '%'
    if let Some((op, lhs, rhs)) = split_last_multiplicative(s) {
        let l = emit_expr_with_mode(lhs, defs, ctors, mode);
        let r = emit_expr_with_mode(rhs, defs, ctors, mode);
        return match (mode, op) {
            (ArithMode::Saturating, '*') => format!("({l}).saturating_mul({r})"),
            (ArithMode::Wrapping, '*') => format!("({l}).wrapping_mul({r})"),
            (ArithMode::Saturating, '/') => {
                format!("{{ let __a = {l}; let __b = {r}; if __b == 0_u64 {{ 0_u64 }} else {{ __a / __b }} }}")
            }
            (ArithMode::Wrapping, '/') => {
                format!("{{ let __a = {l}; let __b = {r}; if __b == 0 {{ 0 }} else {{ __a.wrapping_div(__b) }} }}")
            }
            (ArithMode::Saturating, '%') => {
                format!("{{ let __a = {l}; let __b = {r}; if __b == 0_u64 {{ __a }} else {{ __a % __b }} }}")
            }
            (ArithMode::Wrapping, '%') => {
                format!("{{ let __a = {l}; let __b = {r}; if __b == 0 {{ 0 }} else {{ __a.wrapping_rem(__b) }} }}")
            }
            _ => unreachable!(),
        };
    }

    // Unary boolean negation
    if let Some(operand) = s.strip_prefix('!') {
        return format!("!({})", emit_expr_with_mode(operand, defs, ctors, mode));
    }

    // Real Bend 2 curly-brace ADT constructor: Draft{}, Paid{amt}, OrderState.Paid{10n}
    if let Some(open) = s.find('{') {
        if s.ends_with('}') && is_valid_path_ident(s[..open].trim()) {
            let callee = s[..open].trim();
            let args_inner = s[open + 1..s.len() - 1].trim();
            let rust_ctor = resolve_ctor_path(callee, ctors);
            if args_inner.is_empty() {
                return rust_ctor;
            }
            let emitted_args: Vec<String> = split_top_level(args_inner, ',')
                .iter()
                .map(|a| {
                    let trimmed = a.trim();
                    let val = if let Some((_, v)) = split_top_level_once(trimmed, ':') {
                        v
                    } else {
                        trimmed
                    };
                    emit_expr_with_mode(val, defs, ctors, mode)
                })
                .collect();
            return format!("{rust_ctor}({})", emitted_args.join(", "));
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
            if let Some(builtin) = emit_base_builtin(callee, &raw_args, defs, ctors, mode) {
                return builtin;
            }

            if let Some(info) = ctors.get(callee) {
                let emitted_args: Vec<String> = raw_args
                    .iter()
                    .map(|a| emit_expr_with_mode(a, defs, ctors, mode))
                    .collect();
                return format!(
                    "{}::{}({})",
                    info.type_name,
                    info.variant_name,
                    emitted_args.join(", ")
                );
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
                emitted_args.push(emit_expr_with_mode(arg, defs, ctors, mode));
            }
            return format!(
                "{}({})",
                callee.replace('.', "::"),
                emitted_args.join(", ")
            );
        }
    }

    // Natural number literals (0n, 42n)
    if let Some(digits) = s.strip_suffix('n') {
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            return format!("{digits}_u64");
        }
    }

    // Unit ADT constructor (e.g. OrderState.Draft or Draft)
    if let Some(info) = ctors.get(s) {
        if info.arity == 0 {
            return format!("{}::{}", info.type_name, info.variant_name);
        }
    }

    s.replace('.', "::")
}

fn emit_base_builtin(
    callee: &str,
    raw_args: &[&str],
    defs: &HashMap<String, &Def>,
    ctors: &HashMap<String, CtorInfo>,
    mode: ArithMode,
) -> Option<String> {
    let e = |a: &str, m: ArithMode| emit_expr_with_mode(a, defs, ctors, m);
    match (callee, raw_args.len()) {
        // Unary Bool / Nat / Pair helpers
        ("Bool.not", 1) => Some(format!("(!({}))", e(raw_args[0], mode))),
        ("Nat.is_zero", 1) => Some(format!("(({}) == 0_u64)", e(raw_args[0], ArithMode::Saturating))),
        ("Nat.succ", 1) => Some(format!("({}).saturating_add(1_u64)", e(raw_args[0], ArithMode::Saturating))),
        ("Nat.pred", 1) => Some(format!("({}).saturating_sub(1_u64)", e(raw_args[0], ArithMode::Saturating))),
        ("Pair.fst", 1) => Some(format!("({}).0", e(raw_args[0], mode))),
        ("Pair.snd", 1) => Some(format!("({}).1", e(raw_args[0], mode))),

        // Binary Nat arithmetic (saturating u64 + total div/mod matching Bend 2 base.bend)
        ("Nat.add", 2) => Some(format!(
            "({}).saturating_add({})",
            e(raw_args[0], ArithMode::Saturating),
            e(raw_args[1], ArithMode::Saturating)
        )),
        ("Nat.sub", 2) => Some(format!(
            "({}).saturating_sub({})",
            e(raw_args[0], ArithMode::Saturating),
            e(raw_args[1], ArithMode::Saturating)
        )),
        ("Nat.mul", 2) => Some(format!(
            "({}).saturating_mul({})",
            e(raw_args[0], ArithMode::Saturating),
            e(raw_args[1], ArithMode::Saturating)
        )),
        ("Nat.div", 2) => Some(format!(
            "{{ let __a = {}; let __b = {}; if __b == 0_u64 {{ 0_u64 }} else {{ __a / __b }} }}",
            e(raw_args[0], ArithMode::Saturating),
            e(raw_args[1], ArithMode::Saturating)
        )),
        ("Nat.mod", 2) => Some(format!(
            "{{ let __a = {}; let __b = {}; if __b == 0_u64 {{ __a }} else {{ __a % __b }} }}",
            e(raw_args[0], ArithMode::Saturating),
            e(raw_args[1], ArithMode::Saturating)
        )),
        ("Nat.divmod", 2) => Some(format!(
            "{{ let __a = {}; let __b = {}; if __b == 0_u64 {{ (0_u64, __a) }} else {{ (__a / __b, __a % __b) }} }}",
            e(raw_args[0], ArithMode::Saturating),
            e(raw_args[1], ArithMode::Saturating)
        )),
        ("Nat.min", 2) => Some(format!(
            "({}).min({})",
            e(raw_args[0], ArithMode::Saturating),
            e(raw_args[1], ArithMode::Saturating)
        )),
        ("Nat.max", 2) => Some(format!(
            "({}).max({})",
            e(raw_args[0], ArithMode::Saturating),
            e(raw_args[1], ArithMode::Saturating)
        )),

        // Binary Nat comparisons
        ("Nat.is_le" | "Nat.le" | "Nat.lte", 2) => Some(format!(
            "(({}) <= ({}))",
            e(raw_args[0], ArithMode::Saturating),
            e(raw_args[1], ArithMode::Saturating)
        )),
        ("Nat.is_lt" | "Nat.lt", 2) => Some(format!(
            "(({}) < ({}))",
            e(raw_args[0], ArithMode::Saturating),
            e(raw_args[1], ArithMode::Saturating)
        )),
        ("Nat.is_ge" | "Nat.ge" | "Nat.gte", 2) => Some(format!(
            "(({}) >= ({}))",
            e(raw_args[0], ArithMode::Saturating),
            e(raw_args[1], ArithMode::Saturating)
        )),
        ("Nat.is_gt" | "Nat.gt", 2) => Some(format!(
            "(({}) > ({}))",
            e(raw_args[0], ArithMode::Saturating),
            e(raw_args[1], ArithMode::Saturating)
        )),
        ("Nat.is_eq" | "Nat.eq" | "Nat.equal", 2) => Some(format!(
            "(({}) == ({}))",
            e(raw_args[0], ArithMode::Saturating),
            e(raw_args[1], ArithMode::Saturating)
        )),
        ("Nat.is_ne" | "Nat.ne", 2) => Some(format!(
            "(({}) != ({}))",
            e(raw_args[0], ArithMode::Saturating),
            e(raw_args[1], ArithMode::Saturating)
        )),

        // Binary Bool logic
        ("Bool.and", 2) => Some(format!(
            "(({}) && ({}))",
            e(raw_args[0], mode),
            e(raw_args[1], mode)
        )),
        ("Bool.or", 2) => Some(format!(
            "(({}) || ({}))",
            e(raw_args[0], mode),
            e(raw_args[1], mode)
        )),
        ("Bool.xor", 2) => Some(format!(
            "(({}) ^ ({}))",
            e(raw_args[0], mode),
            e(raw_args[1], mode)
        )),
        ("Bool.is_eq" | "Bool.eq", 2) => Some(format!(
            "(({}) == ({}))",
            e(raw_args[0], mode),
            e(raw_args[1], mode)
        )),
        ("Bool.is_ne" | "Bool.ne", 2) => Some(format!(
            "(({}) != ({}))",
            e(raw_args[0], mode),
            e(raw_args[1], mode)
        )),

        // Polymorphic Pair / Bool.pick helpers (with or without erased type args)
        ("Pair.fst", 3) => Some(format!("({}).0", e(raw_args[2], mode))),
        ("Pair.snd", 3) => Some(format!("({}).1", e(raw_args[2], mode))),
        ("Bool.pick", 3) => Some(format!(
            "if {} {{ {} }} else {{ {} }}",
            e(raw_args[0], mode),
            e(raw_args[1], mode),
            e(raw_args[2], mode)
        )),
        ("Bool.pick", 4) => Some(format!(
            "if {} {{ {} }} else {{ {} }}",
            e(raw_args[1], mode),
            e(raw_args[2], mode),
            e(raw_args[3], mode)
        )),
        _ => None,
    }
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
                '(' | '{' => depth += 1,
                ')' | '}' => depth -= 1,
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

fn split_case_arm(arm: &str) -> Option<(&str, &str)> {
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
            b'(' | b'{' => depth += 1,
            b')' | b'}' => depth -= 1,
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
            b'(' | b'{' => depth += 1,
            b')' | b'}' => depth -= 1,
            _ if depth == 0 && s[i..].starts_with(needle) => {
                return Some((s[..i].trim(), s[i + needle.len()..].trim()));
            }
            _ => {}
        }
    }
    None
}

fn split_top_level_str<'a>(s: &'a str, op: &str) -> Option<(&'a str, &'a str)> {
    let mut depth = 0i32;
    let bytes = s.as_bytes();
    for i in 0..bytes.len() {
        match bytes[i] {
            b'(' | b'{' => depth += 1,
            b')' | b'}' => depth -= 1,
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

fn is_wrapped_in_parens(s: &str) -> bool {
    if !(s.starts_with('(') && s.ends_with(')')) {
        return false;
    }
    let mut depth = 0i32;
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
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

fn unwrap_outer_parens(s: &str) -> &str {
    let mut cur = s.trim();
    while is_wrapped_in_parens(cur) {
        cur = cur[1..cur.len() - 1].trim();
    }
    cur
}

fn split_top_level(s: &str, delim: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' => depth += 1,
            ')' | '}' => depth -= 1,
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

fn split_top_level_once(s: &str, delim: char) -> Option<(&str, &str)> {
    let mut depth = 0i32;
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' => depth += 1,
            ')' | '}' => depth -= 1,
            c if c == delim && depth == 0 => {
                return Some((s[..idx].trim(), s[idx + ch.len_utf8()..].trim()));
            }
            _ => {}
        }
    }
    None
}

fn split_last_additive(s: &str) -> Option<(char, &str, &str)> {
    let mut depth = 0i32;
    let mut found = None;
    let bytes = s.as_bytes();
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' => depth += 1,
            ')' | '}' => depth -= 1,
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
            '(' | '{' => depth += 1,
            ')' | '}' => depth -= 1,
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
        let src = "def id(-T: Type, x: T) -> T:\n  (x : T)\n";
        let summary = emit_verified_rust(src, 1).expect("emit succeeded");
        assert_eq!(summary.defs_emitted, 1);
        assert_eq!(summary.dead_params_erased, 1);
        assert!(summary.rust_source.contains("pub fn id<T>(x: T) -> T"));
        assert!(summary.rust_source.contains("    x\n}"));
    }

    #[test]
    fn emits_saturating_nat_math_and_erases_laws() {
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
        let code_only: String = summary
            .rust_source
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(summary.defs_emitted, 2);
        assert!(code_only.contains("pub fn deposit(bal: u64, amt: u64) -> u64"));
        assert!(code_only.contains("(bal).saturating_add(amt)"));
        assert!(code_only.contains("(gross).saturating_sub(fee)"));
        assert!(!code_only.contains("law "));
        assert!(!code_only.contains("proof "));
        assert!(!code_only.contains("refl"));
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
        let src = "def dup(+n: Nat) -> Nat:\n  (n, n)\n";
        let summary = emit_verified_rust(src, 0).expect("emit succeeded");
        assert!(summary.rust_source.contains("pub fn dup(n: u64) -> (u64, u64)"));
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
        assert_eq!(summary.types_emitted, 1);
        assert_eq!(summary.defs_emitted, 1);
        assert!(summary.rust_source.contains("pub enum OrderState"));
        assert!(summary.rust_source.contains("Paid(u64),"));
        assert!(summary.rust_source.contains("OrderState::Draft => OrderState::Cancelled,"));
        assert!(summary.rust_source.contains("OrderState::Paid(amt) => OrderState::Cancelled,"));
        assert!(!summary.rust_source.contains("cancel_idempotent"));
        assert!(!summary.rust_source.contains("refl"));
    }

    #[test]
    fn emits_bool_if_else_and_logical_operators() {
        let src = r#"
def can_write(+is_admin: Bool, +is_revoked: Bool) -> Bool:
  if is_revoked: false else: is_admin
"#;
        let summary = emit_verified_rust(src, 0).expect("emit succeeded");
        assert!(summary.rust_source.contains("pub fn can_write(is_admin: bool, is_revoked: bool) -> bool"));
        assert!(summary.rust_source.contains("if is_revoked { false } else { is_admin }"));
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
        assert_eq!(summary.types_emitted, 1);
        assert_eq!(summary.defs_emitted, 2);
        assert!(summary.rust_source.contains("pub enum OrderState"));
        assert!(summary.rust_source.contains("Draft,"));
        assert!(summary.rust_source.contains("Paid(u64),"));
        assert!(summary.rust_source.contains("(bal).saturating_add(amt)"));
        assert!(summary.rust_source.contains("OrderState::Draft => OrderState::Cancelled,"));
        assert!(summary.rust_source.contains("OrderState::Paid(amt) => OrderState::Cancelled,"));
        assert!(summary.rust_source.contains("OrderState::Shipped(amt) => OrderState::Shipped(amt),"));
        assert!(!summary.rust_source.contains("deposit_zero"));
        assert!(!summary.rust_source.contains("cancel_idempotent"));
        assert!(!summary.rust_source.contains("{==}"));
    }

    #[test]
    fn emits_bend2_base_nat_and_bool_helpers() {
        let src = r#"
import Base

def can_fit(used: Nat, req: Nat, cap: Nat, enabled: Bool) -> Bool:
  Bool.and(enabled, Bool.or(Nat.is_le(Nat.add(used, req), cap), Bool.not(Nat.is_gt(req, 0n))))

def clamp_blocks(n: Nat, lo: Nat, hi: Nat) -> Nat:
  Nat.min(Nat.max(n, lo), hi)

def tiles_needed(tokens: Nat, tile: Nat) -> Nat:
  Nat.add(Nat.div(tokens, tile), Bool.pick(Nat, Nat.is_eq(Nat.mod(tokens, tile), 0n), 0n, 1n))

def cmp_flags(a: Nat, b: Nat) -> Bool:
  Bool.and(Nat.is_lt(a, b), Nat.is_ge(b, a))
"#;
        let summary = emit_verified_rust(src, 0).expect("base helpers emit succeeded");
        assert_eq!(summary.defs_emitted, 4);
        assert!(summary.rust_source.contains("((enabled) && ("));
        assert!(summary.rust_source.contains("<= (cap)"));
        assert!(summary.rust_source.contains("(!(((req) > (0_u64))))"));
        assert!(summary.rust_source.contains("((n).max(lo)).min(hi)"));
        assert!(summary.rust_source.contains("if __b == 0_u64 { 0_u64 } else { __a / __b }"));
        assert!(summary.rust_source.contains("if __b == 0_u64 { __a } else { __a % __b }"));
        assert!(summary.rust_source.contains("if (({ let __a = tokens;"));
        assert!(summary.rust_source.contains("(((a) < (b))) && (((b) >= (a)))"));
        assert!(!summary.rust_source.contains("Nat::"));
        assert!(!summary.rust_source.contains("Bool::"));
    }

    #[test]
    fn emits_wrapping_for_u32_and_saturating_for_nat() {
        let src = r#"
def wrap_u32(a: U32, b: U32) -> U32:
  ((a + b : U32) * (a - b : U32) : U32)

def sat_nat(a: Nat, b: Nat) -> Nat:
  (a - b : Nat)
"#;
        let summary = emit_verified_rust(src, 0).expect("arith mode emit succeeded");
        assert!(summary.rust_source.contains("pub fn wrap_u32(a: u32, b: u32) -> u32"));
        assert!(summary.rust_source.contains("((a).wrapping_add(b)).wrapping_mul((a).wrapping_sub(b))"));
        assert!(summary.rust_source.contains("pub fn sat_nat(a: u64, b: u64) -> u64"));
        assert!(summary.rust_source.contains("(a).saturating_sub(b)"));
    }

    #[test]
    fn emits_nested_match_multi_scrutinee_succ_and_let() {
        let src = r#"
import Base

type PoolState is Data:
  Ready{free: Nat}
  Exhausted{}

def try_alloc(state: PoolState, req: Nat) -> PoolState:
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
        assert!(summary.rust_source.contains("true => PoolState::Ready((free).saturating_sub(req)),"));
        assert!(summary.rust_source.contains("match (a, b) {"));
        assert!(summary.rust_source.contains("(0_u64, _) => 0_u64,"));
        assert!(summary.rust_source.contains("(__rb_n0 @ 1_u64..=u64::MAX, __rb_n1 @ 1_u64..=u64::MAX) => { let ap = __rb_n0 - 1_u64; let bp = __rb_n1 - 1_u64;"));
        assert!(!summary.rust_source.contains("helper_lemma"));
    }

    #[test]
    fn emits_pair_types_and_pair_accessors() {
        let src = r#"
import Base

def split_tiles(n: Nat, tile: Nat) -> Nat & Nat:
  Nat.divmod(n, tile)

def first_of_pair(p: Nat & Nat) -> Nat:
  Pair.fst(Nat, Nat, p)
"#;
        let summary = emit_verified_rust(src, 0).expect("pair emit succeeded");
        assert!(summary.rust_source.contains("pub fn split_tiles(n: u64, tile: u64) -> (u64, u64)"));
        assert!(summary.rust_source.contains("if __b == 0_u64 { (0_u64, __a) } else { (__a / __b, __a % __b) }"));
        assert!(summary.rust_source.contains("pub fn first_of_pair(p: (u64, u64)) -> u64"));
        assert!(summary.rust_source.contains("(p).0"));
    }
}
RUSTY_BENDS_EOF

cat << 'RUSTY_BENDS_EOF' > "example-app/Cargo.toml"
[package]
name = "my-verified-app"
version = "0.1.0"
edition = "2021"

[dependencies]
# Pure Rust runtime dependencies only — NO Bend 2 or proof libraries here!

[build-dependencies]
rusty-bends-build = { path = "../rusty-bends-build" }
RUSTY_BENDS_EOF

cat << 'RUSTY_BENDS_EOF' > "example-app/build.rs"
fn main() {
    // 1. Checks bend.pin / BEND_PIN_VERSION (if configured)
    // 2. Enforces token-canonical rusty-bends.lock (anti-cheat LAWS lock)
    // 3. Runs real 'bend --check-only' + 'bend --verdict' on verified/*.bend
    // 4. Erases q=0 types/laws and emits pure Rust (ADTs + match + defs) into OUT_DIR/verified.rs
    rusty_bends_build::verify_and_emit("verified");
}
RUSTY_BENDS_EOF

cat << 'RUSTY_BENDS_EOF' > "example-app/bend.pin"
# Optional Bend 2 compiler version pin (uncomment a version prefix to enforce in CI/local builds).
# Example:
# 0.2.38
#
# When uncommented (or when BEND_PIN_VERSION is set), rusty-bends-build runs 'bend --version'
# and fails fast with E_BEND_VERSION_MISMATCH if upstream Bend 2 drifts unexpectedly.
RUSTY_BENDS_EOF

cat << 'RUSTY_BENDS_EOF' > "example-app/verified/core.bend"
# Real Bend 2 Verified Core (bendlang/bend 2.0.17+ syntax)
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
law deposit_from_zero:
  for amt: Nat
  {deposit(0n, amt) == amt : Nat}

def deposit_from_zero(amt):
  {==}

# LAW 2: depositing 0n leaves any balance unchanged (inductive proof)
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
RUSTY_BENDS_EOF

cat << 'RUSTY_BENDS_EOF' > "example-app/src/main.rs"
//! Rust Shell: handles I/O, HTTP, DB, and CLI.
//! Calls pure verified types and functions emitted into OUT_DIR/verified.rs at build time.

#[allow(dead_code)]
mod verified {
    include!(concat!(env!("OUT_DIR"), "/verified.rs"));
}

fn main() {
    let total = verified::deposit(100, 25);
    let cancelled = verified::cancel_order(verified::OrderState::Paid(total));
    let shipped = verified::cancel_order(verified::OrderState::Shipped(total));
    println!(
        "RustyBends v1 Verified Core OK -> deposit(100, 25) = {total}, cancel(Paid) = {cancelled:?}, cancel(Shipped) = {shipped:?}"
    );
}

#[cfg(test)]
mod tests {
    use super::verified::{cancel_order, deposit, OrderState};

    #[test]
    fn verified_module_runs_with_zero_runtime_proof_overhead() {
        assert_eq!(deposit(100, 25), 125);
        assert_eq!(cancel_order(OrderState::Paid(50)), OrderState::Cancelled);
        assert_eq!(cancel_order(OrderState::Shipped(50)), OrderState::Shipped(50));
    }
}
RUSTY_BENDS_EOF

cat << 'RUSTY_BENDS_EOF' > "BEND_GUIDE.md"
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
RUSTY_BENDS_EOF

echo "Done! Next steps on desktop:"
echo "  1. Run rusty-bends-build unit tests (19 tests):  (cd rusty-bends-build && cargo test)"
echo "  2. Build & verify example app with bend CLI:     (cd example-app && cargo check && cargo run)"
echo "  3. Optional: set BEND_VERDICT=require in CI or pin Bend version in example-app/bend.pin"
