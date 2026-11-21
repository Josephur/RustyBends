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
