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

pub mod coverage;
pub mod emit;
pub mod law_test;
pub mod lock;
pub mod mutate;

pub use lock::LockUpdateMode;
pub use mutate::MutateMode;

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

#[derive(Debug, Clone)]
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
    pub lock_update: LockUpdateMode,
    pub emit_rust: bool,
    pub mutate_mode: MutateMode,
    pub list_laws: bool,
    /// `RUSTY_BENDS_LIST_PANICS=1`: print every checked-growth panic site as
    /// `function: op at file:line` (Issue #13).
    pub list_panics: bool,
    /// `RUSTY_BENDS_LIST_COVERAGE=1`: print which emitted functions each law covers,
    /// which emitted functions no law reaches, and which laws name only uncalled functions.
    pub list_coverage: bool,
    /// Optional crate root (`CARGO_MANIFEST_DIR`) scanned under `list_coverage` for `src/`,
    /// `tests/`, and `benches/` call-site checks.
    pub crate_root: Option<PathBuf>,
    /// `RUSTY_BENDS_NO_CACHE=1`: bypass the incremental build cache in `OUT_DIR`
    /// and re-run verification and code generation.
    pub no_cache: bool,
}

impl Default for Config {
    fn default() -> Self {
        let verdict_mode = env::var("BEND_VERDICT")
            .map(|v| VerdictMode::parse(&v))
            .unwrap_or(VerdictMode::Auto);
        let mutate_mode = env::var("RUSTY_BENDS_MUTATE")
            .map(|v| MutateMode::parse(&v))
            .unwrap_or(MutateMode::NewOnly);
        let env_flag = |name: &str| {
            env::var(name)
                .map(|v| {
                    matches!(
                        v.trim().to_ascii_lowercase().as_str(),
                        "1" | "true" | "yes" | "on"
                    )
                })
                .unwrap_or(false)
        };
        let list_laws = env_flag("RUSTY_BENDS_LIST_LAWS");
        let list_panics = env_flag("RUSTY_BENDS_LIST_PANICS");
        let list_coverage = env_flag("RUSTY_BENDS_LIST_COVERAGE");
        let no_cache = env_flag("RUSTY_BENDS_NO_CACHE");
        let crate_root = env::var_os("CARGO_MANIFEST_DIR").map(PathBuf::from);
        let lock_update = env::var("RUSTY_BENDS_UPDATE_LAWS")
            .map(|v| LockUpdateMode::parse(&v))
            .unwrap_or(LockUpdateMode::None);
        let allow_lock_update = lock_update == LockUpdateMode::All;
        Self {
            verified_dir: PathBuf::from("verified"),
            bend_bin: resolve_bend_bin(
                env::var("BEND_BIN").ok(),
                env::var_os("PATH"),
                env::var_os("HOME").map(PathBuf::from),
            ),
            check_flag: env::var("BEND_CHECK_FLAG").unwrap_or_else(|_| "--check-only".to_string()),
            verdict_flag: env::var("BEND_VERDICT_FLAG").unwrap_or_else(|_| "--verdict".to_string()),
            verdict_mode,
            lock_file: PathBuf::from("rusty-bends.lock"),
            pin_file: PathBuf::from("bend.pin"),
            pinned_version: env::var("BEND_PIN_VERSION")
                .ok()
                .filter(|v| !v.trim().is_empty()),
            out_dir: PathBuf::from(env::var("OUT_DIR").unwrap_or_else(|_| "target".to_string())),
            allow_lock_update,
            lock_update,
            emit_rust: true,
            mutate_mode,
            list_laws,
            list_panics,
            list_coverage,
            crate_root,
            no_cache,
        }
    }
}

impl Config {
    fn effective_lock_update(&self) -> LockUpdateMode {
        if self.allow_lock_update && self.lock_update == LockUpdateMode::None {
            LockUpdateMode::All
        } else {
            self.lock_update.clone()
        }
    }
}

/// Shared Bend 2 Nat arithmetic, order, and division lemma library (`nat_lemmas.bend`).
/// Every definition is a `q=0` proof/type helper and is completely erased before Rust codegen.
pub const NAT_LEMMAS_BEND: &str = include_str!("../lemmas/nat_lemmas.bend");

/// Compile-time hash of this `rusty-bends-build` crate's sources (`build.rs`, `Cargo.toml`,
/// `src/`, `lemmas/`), baked into `OUT_DIR` cache stamps so updating the build crate
/// invalidates stale generated Rust and mutation caches automatically.
pub const BUILDER_HASH: &str = env!("RUSTY_BENDS_BUILD_HASH");

/// Writes the bundled `nat_lemmas.bend` into `dir` (typically `"verified"`), creating
/// the directory if needed. Only writes when the file is missing or differs, keeping
/// mtime stable for Cargo incremental rebuilds.
pub fn write_nat_lemmas(dir: impl AsRef<Path>) -> Result<PathBuf, String> {
    let dir = dir.as_ref();
    fs::create_dir_all(dir).map_err(|e| {
        format!(
            "[E_NAT_LEMMAS_WRITE] Failed to create '{}': {e}",
            dir.display()
        )
    })?;
    let dest = dir.join("nat_lemmas.bend");
    let unchanged = fs::read_to_string(&dest)
        .map(|existing| existing == NAT_LEMMAS_BEND)
        .unwrap_or(false);
    if !unchanged {
        fs::write(&dest, NAT_LEMMAS_BEND).map_err(|e| {
            format!(
                "[E_NAT_LEMMAS_WRITE] Failed to write '{}': {e}",
                dest.display()
            )
        })?;
    }
    Ok(dest)
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
    println!("cargo:rerun-if-env-changed=RUSTY_BENDS_MUTATE");
    println!("cargo:rerun-if-env-changed=RUSTY_BENDS_LIST_LAWS");
    println!("cargo:rerun-if-env-changed=RUSTY_BENDS_LIST_PANICS");
    println!("cargo:rerun-if-env-changed=RUSTY_BENDS_LIST_COVERAGE");
    println!("cargo:rerun-if-env-changed=RUSTY_BENDS_NO_CACHE");
    println!("cargo:rerun-if-env-changed=BEND_BIN");
    println!("cargo:rerun-if-env-changed=BEND_PIN_VERSION");
    println!("cargo:rerun-if-env-changed=BEND_CHECK_FLAG");
    println!("cargo:rerun-if-env-changed=BEND_VERDICT_FLAG");
    println!("cargo:rerun-if-env-changed=BEND_VERDICT");
    println!("cargo:rerun-if-env-changed=BENDTT");

    // Verify Bend CLI version pin if bend.pin or BEND_PIN_VERSION is configured,
    // and capture the active Bend version so upgrades invalidate the build cache.
    let bend_version = if let Some(expected_pin) = read_active_pin(cfg)? {
        let actual_ver = query_bend_version(&cfg.bend_bin)?;
        verify_bend_version_str(&expected_pin, &actual_ver)?;
        Some(actual_ver)
    } else {
        query_bend_version(&cfg.bend_bin).ok()
    };

    run_pipeline(
        cfg,
        bend_version.as_deref(),
        has_verdict_runtime(),
        |file, has_laws| {
            println!("cargo:rerun-if-changed={}", file.display());
            verify_with_bend_cli(cfg, file, has_laws)
        },
    )
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

/// Picks the 'bend' executable: '$BEND_BIN' when set, else 'bend' if it is on 'PATH', else
/// '~/.bend/bin/bend' (the default Bend 2 install location, often missing from the PATH of
/// non-interactive Cargo shells) when it exists, else plain 'bend'.
pub fn resolve_bend_bin(
    bend_bin_env: Option<String>,
    path: Option<std::ffi::OsString>,
    home: Option<PathBuf>,
) -> String {
    if let Some(bin) = bend_bin_env.filter(|v| !v.trim().is_empty()) {
        return bin;
    }
    let on_path = path
        .map(|p| env::split_paths(&p).any(|dir| dir.join("bend").is_file()))
        .unwrap_or(false);
    if !on_path {
        if let Some(home) = home {
            let installed = home.join(".bend").join("bin").join("bend");
            if installed.is_file() {
                return installed.to_string_lossy().into_owned();
            }
        }
    }
    "bend".to_string()
}

/// Checks whether the installed 'bend version' string satisfies the pinned prefix.
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

/// Asks the Bend CLI for its version. Bend 2 (2.0.40+) only accepts the 'version'
/// subcommand ('--version' is rejected as an unknown option), so try that first and fall
/// back to '--version' for older releases.
fn query_bend_version(bend_bin: &str) -> Result<String, String> {
    let mut failures = Vec::new();
    for arg in ["version", "--version"] {
        let output = Command::new(bend_bin).arg(arg).output().map_err(|e| {
            format!("[E_BEND_MISSING] Failed to run '{bend_bin} {arg}': {e}\nHint: Install Bend 2 (~/.bend/bin) or set BEND_BIN=/path/to/bend")
        })?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let text = format!("{stdout}{stderr}");
        if output.status.success() {
            return Ok(text);
        }
        failures.push(format!("'{bend_bin} {arg}': {}", text.trim()));
    }
    Err(format!(
        "[E_BEND_VERSION_QUERY] Could not read the Bend version:\n{}\nHint: Set BEND_BIN to a working Bend 2 binary or remove the bend.pin / BEND_PIN_VERSION pin.",
        failures.join("\n")
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VerdictApplied {
    Ran,
    Skipped,
    Off,
}

impl VerdictApplied {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ran => "ran",
            Self::Skipped => "skipped",
            Self::Off => "off",
        }
    }
}

fn expected_verdict_applied(cfg: &Config, verdict_runtime_available: bool) -> VerdictApplied {
    if cfg.verdict_mode == VerdictMode::Off || cfg.verdict_flag.trim().is_empty() {
        VerdictApplied::Off
    } else if cfg.verdict_mode == VerdictMode::Auto && !verdict_runtime_available {
        VerdictApplied::Skipped
    } else {
        VerdictApplied::Ran
    }
}

fn sanitize_cache_field(s: &str) -> String {
    s.replace(['\r', '\n'], " ").trim().to_string()
}

fn format_cargo_warning_lines(msg: &str) -> Vec<String> {
    msg.lines()
        .map(|line| format!("cargo:warning={line}"))
        .collect()
}

fn emit_cargo_warning(msg: &str) {
    for line in format_cargo_warning_lines(msg) {
        println!("{line}");
    }
}

fn format_cache_stamp(
    cfg: &Config,
    files_hash: &str,
    builder_hash: &str,
    verdict: VerdictApplied,
    bend_version: &str,
) -> String {
    format!(
        "v4\nhash={files_hash}\nbuilder={}\nverdict={}\nbend_bin={}\nbend_version={}\ncheck_flag={}\nverdict_flag={}\n",
        sanitize_cache_field(builder_hash),
        verdict.as_str(),
        sanitize_cache_field(&cfg.bend_bin),
        sanitize_cache_field(bend_version),
        sanitize_cache_field(&cfg.check_flag),
        sanitize_cache_field(&cfg.verdict_flag),
    )
}

fn is_bend_cli_invocation_error(err: &str) -> bool {
    err.starts_with("[E_BEND_MISSING]")
        || is_missing_lean_error(err)
        || err.contains("unknown option")
        || err.contains("see bend --help")
}

/// Core pipeline with pluggable 'bend' runner for deterministic unit testing.
pub fn run_with_checker<F>(cfg: &Config, mut checker: F) -> Result<Option<PathBuf>, String>
where
    F: FnMut(&Path, bool) -> Result<(), String>,
{
    let runtime_ok = has_verdict_runtime();
    let expected = expected_verdict_applied(cfg, runtime_ok);
    run_pipeline(cfg, Some(""), runtime_ok, |file, has_laws| {
        checker(file, has_laws)?;
        Ok(expected)
    })
}

fn run_pipeline<F>(
    cfg: &Config,
    bend_version: Option<&str>,
    verdict_runtime_available: bool,
    checker: F,
) -> Result<Option<PathBuf>, String>
where
    F: FnMut(&Path, bool) -> Result<VerdictApplied, String>,
{
    run_pipeline_with_builder(
        cfg,
        bend_version,
        BUILDER_HASH,
        verdict_runtime_available,
        checker,
    )
}

fn run_pipeline_with_builder<F>(
    cfg: &Config,
    bend_version: Option<&str>,
    builder_hash: &str,
    verdict_runtime_available: bool,
    mut checker: F,
) -> Result<Option<PathBuf>, String>
where
    F: FnMut(&Path, bool) -> Result<VerdictApplied, String>,
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

    // Record which laws were already locked before this build for failure diagnostics.
    let pre_locked_laws = lock::read_locked_law_names(&cfg.lock_file);

    // 1. Check AST/token-canonical LAWS lock (defer writing until Bend & mutation checks pass)
    let effective_lock_mode = cfg.effective_lock_update();
    let lock_report =
        lock::check_law_lock_with_mode(&cfg.lock_file, &bend_files, &effective_lock_mode)?;
    let law_count = lock_report.current.len();

    for w in &lock_report.warnings {
        emit_cargo_warning(w);
    }
    if effective_lock_mode != LockUpdateMode::None && !lock_report.needs_write {
        emit_cargo_warning("RustyBends lock: no lock changes to write");
    }
    if cfg.list_laws {
        let listing = lock::format_law_list(&lock_report.current);
        emit_cargo_warning(&listing);
    }

    // 2. Check incremental build cache (file contents, builder hash, verdict mode/status, flags, and bend version)
    fs::create_dir_all(&cfg.out_dir).map_err(|e| e.to_string())?;
    let cache_file = cfg.out_dir.join("rusty-bends.cache");
    let verified_rs = cfg.out_dir.join("verified.rs");
    let combined_hash = hash_files(&bend_files)?;
    let expected_verdict = expected_verdict_applied(cfg, verdict_runtime_available);
    let expected_stamp = bend_version
        .map(|ver| format_cache_stamp(cfg, &combined_hash, builder_hash, expected_verdict, ver));

    let cache_hit = !cfg.no_cache
        && expected_stamp.as_ref().is_some_and(|stamp| {
            fs::read_to_string(&cache_file)
                .map(|s| s == *stamp)
                .unwrap_or(false)
        });
    if cache_hit
        && (!cfg.emit_rust || verified_rs.exists())
        && !lock_report.needs_write
        && lock_report.new_names.is_empty()
        && cfg.mutate_mode == MutateMode::NewOnly
        && !cfg.list_panics
        && !cfg.list_coverage
    {
        return Ok(if cfg.emit_rust {
            Some(verified_rs)
        } else {
            None
        });
    }

    // 3. Pre-read all sources and run real Bend 2 checker (--check-only, plus --verdict when laws are present)
    let mut file_sources: Vec<(&PathBuf, String)> = Vec::with_capacity(bend_files.len());
    let mut combined_source = String::new();
    for file in &bend_files {
        let text = fs::read_to_string(file).map_err(|e| e.to_string())?;
        combined_source.push_str(&emit::resolve_import_aliases(&text));
        combined_source.push('\n');
        file_sources.push((file, text));
    }

    let mut saw_verdict_skipped = false;
    for (file, text) in &file_sources {
        let is_laws_file = file
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case("LAWS.bend"))
            .unwrap_or(false);
        let has_laws = is_laws_file || !lock::extract_laws_from_source(text).is_empty();

        match checker(file, has_laws) {
            Ok(VerdictApplied::Skipped) => {
                saw_verdict_skipped = true;
            }
            Ok(VerdictApplied::Ran | VerdictApplied::Off) => {}
            Err(err) => {
                if !is_bend_cli_invocation_error(&err) {
                    let file_laws = law_test::parse_laws(text);
                    if !file_laws.is_empty() {
                        let target_names = match law_test::extract_failed_def_name(&err) {
                            Some(failed) if file_laws.iter().any(|l| l.name == failed) => {
                                vec![failed]
                            }
                            _ => file_laws.iter().map(|l| l.name.clone()).collect(),
                        };
                        if let Ok(outcomes) = law_test::evaluate_laws_for_counterexamples(
                            &combined_source,
                            &target_names,
                            &cfg.out_dir,
                        ) {
                            let diagnosis = law_test::format_counterexample_diagnosis(
                                &outcomes,
                                &pre_locked_laws,
                            );
                            if !diagnosis.is_empty() {
                                return Err(format!("{diagnosis}\n\n{err}"));
                            }
                        }
                    }
                }
                return Err(err);
            }
        }
    }
    let applied_verdict =
        if cfg.verdict_mode == VerdictMode::Off || cfg.verdict_flag.trim().is_empty() {
            VerdictApplied::Off
        } else if saw_verdict_skipped {
            VerdictApplied::Skipped
        } else {
            VerdictApplied::Ran
        };

    // 4. Mutation-check every unlocked/new law before sealing (and report all locked laws under RUSTY_BENDS_MUTATE=all)
    let mut_summary = mutate::run_mutation_checks(
        &combined_source,
        &lock_report,
        cfg.mutate_mode,
        &cfg.out_dir,
    )?;
    for w in &mut_summary.warnings {
        emit_cargo_warning(w);
    }

    // 5. Persist rusty-bends.lock only after Bend proofs and mutation checks succeed
    if lock_report.needs_write {
        lock::write_law_lock(&cfg.lock_file, &lock_report)?;
        for note in lock::format_lock_update_notes(&lock_report.update_summary) {
            emit_cargo_warning(&note);
        }
    }

    // 6. Erase q=0 parts and emit pure Rust (ADTs + match + defs) into OUT_DIR/verified.rs
    let summary = if cfg.emit_rust || cfg.list_panics {
        Some(emit::emit_verified_rust(&combined_source, law_count)?)
    } else {
        None
    };
    if let (true, Some(summary)) = (cfg.list_panics, summary.as_ref()) {
        let files: Vec<(&Path, &str)> = file_sources
            .iter()
            .map(|(f, t)| (f.as_path(), t.as_str()))
            .collect();
        for line in format_panic_sites(&summary.panic_sites, &files) {
            emit_cargo_warning(&line);
        }
    }
    if cfg.list_coverage {
        let cov = coverage::analyze_coverage(&combined_source, cfg.crate_root.as_deref())?;
        for line in coverage::format_coverage_report(&cov) {
            emit_cargo_warning(&line);
        }
    }
    let emitted_path = match summary {
        Some(summary) if cfg.emit_rust => {
            fs::write(&verified_rs, summary.rust_source).map_err(|e| e.to_string())?;
            Some(verified_rs)
        }
        _ => None,
    };

    // 7. Persist passing build cache stamp (skip if Bend version could not be read so stale runs never hit)
    if let Some(ver) = bend_version {
        let stamp = format_cache_stamp(cfg, &combined_hash, builder_hash, applied_verdict, ver);
        fs::write(&cache_file, stamp).map_err(|e| e.to_string())?;
    }
    Ok(emitted_path)
}

fn verify_with_bend_cli(
    cfg: &Config,
    file: &Path,
    has_laws: bool,
) -> Result<VerdictApplied, String> {
    run_bend_step(&cfg.bend_bin, &cfg.check_flag, file)?;
    if cfg.verdict_mode == VerdictMode::Off || cfg.verdict_flag.trim().is_empty() {
        return Ok(VerdictApplied::Off);
    }
    if !has_laws {
        return Ok(expected_verdict_applied(cfg, has_verdict_runtime()));
    }

    match cfg.verdict_mode {
        VerdictMode::Off => Ok(VerdictApplied::Off),
        VerdictMode::Require => {
            run_bend_step(&cfg.bend_bin, &cfg.verdict_flag, file)?;
            Ok(VerdictApplied::Ran)
        }
        VerdictMode::Auto => {
            if !has_verdict_runtime() {
                println!(
                    "cargo:warning=RustyBends: {} passed --check-only; skipping optional --verdict Lean cross-check (install Lean/elan or set BEND_VERDICT=require in CI).",
                    file.display()
                );
                return Ok(VerdictApplied::Skipped);
            }
            match run_bend_step(&cfg.bend_bin, &cfg.verdict_flag, file) {
                Ok(()) => Ok(VerdictApplied::Ran),
                Err(err) if is_missing_lean_error(&err) => {
                    println!(
                        "cargo:warning=RustyBends: {} passed --check-only; skipping optional --verdict (Lean kernel unavailable). Set BEND_VERDICT=require to enforce.",
                        file.display()
                    );
                    Ok(VerdictApplied::Skipped)
                }
                Err(err) => Err(err),
            }
        }
    }
}

fn has_verdict_runtime() -> bool {
    if env::var("BENDTT")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .is_some()
    {
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

/// Locates `def <name>` in `files`: returns `(file index, header line, end line exclusive)`.
fn locate_def(name: &str, files: &[(&Path, &str)]) -> Option<(usize, usize, usize)> {
    for (fi, (_, text)) in files.iter().enumerate() {
        let lines: Vec<&str> = text.lines().collect();
        for (li, raw) in lines.iter().enumerate() {
            let Some(rest) = raw.strip_prefix("def ") else {
                continue;
            };
            let def_name = rest
                .trim_start()
                .split(|c: char| c == '(' || c == ':' || c.is_whitespace())
                .next()
                .unwrap_or("");
            if def_name != name {
                continue;
            }
            let mut end = li + 1;
            while end < lines.len() {
                let trimmed = emit::strip_comment(lines[end]).trim();
                if !trimmed.is_empty() && emit::is_top_level_start(lines[end], trimmed) {
                    break;
                }
                end += 1;
            }
            return Some((fi, li, end));
        }
    }
    None
}

/// Number of places in `line` where the Bend source of a checked-growth `op` appears.
fn op_occurrences(line: &str, op: &str) -> usize {
    let is_ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'.';
    let count_calls = |callee: &str| {
        let needle = format!("{callee}(");
        line.match_indices(&needle)
            .filter(|(i, _)| *i == 0 || !is_ident(line.as_bytes()[*i - 1]))
            .count()
    };
    match op {
        "Nat.add" => {
            let bytes = line.as_bytes();
            let infix = line.matches(" + ").count();
            // Successor literals in expressions: `1n+x`.
            let succ_lit = (1..bytes.len())
                .filter(|&i| {
                    bytes[i] == b'+'
                        && bytes[i - 1] == b'n'
                        && i >= 2
                        && bytes[i - 2].is_ascii_digit()
                })
                .count();
            count_calls("Nat.add") + infix + succ_lit
        }
        "Nat.mul" => count_calls("Nat.mul") + line.matches(" * ").count(),
        "Nat.succ" => count_calls("Nat.succ"),
        other => other.strip_prefix("call ").map(count_calls).unwrap_or(0),
    }
}

/// Formats checked-growth panic sites as `RustyBends panic [function]: op at file:line`, plus a
/// one-line summary. Source lines are matched by op kind in source order; an op that cannot
/// be matched to a body line is reported at the `def` header line.
pub fn format_panic_sites(sites: &[emit::PanicSite], files: &[(&Path, &str)]) -> Vec<String> {
    use std::collections::BTreeMap;
    let mut grouped: BTreeMap<(&str, &str), usize> = BTreeMap::new();
    for site in sites {
        *grouped
            .entry((site.function.as_str(), site.op.as_str()))
            .or_default() += 1;
    }

    let mut located: Vec<(String, usize, String, String)> = Vec::new();
    for ((function, op), count) in grouped {
        let Some((fi, header, end)) = locate_def(function, files) else {
            for _ in 0..count {
                located.push((String::from("?"), 0, function.to_string(), op.to_string()));
            }
            continue;
        };
        let path = files[fi].0.display().to_string();
        let lines: Vec<&str> = files[fi].1.lines().collect();
        let mut candidates = Vec::new();
        for (li, raw) in lines.iter().enumerate().take(end).skip(header + 1) {
            let code = emit::strip_comment(raw);
            let t = code.trim_start();
            if t.starts_with("case ") || t.starts_with("match ") {
                continue;
            }
            for _ in 0..op_occurrences(code, op) {
                candidates.push(li + 1);
            }
        }
        for k in 0..count {
            let line_no = candidates.get(k).copied().unwrap_or(header + 1);
            located.push((path.clone(), line_no, function.to_string(), op.to_string()));
        }
    }
    located.sort();

    let functions: std::collections::BTreeSet<&str> =
        sites.iter().map(|s| s.function.as_str()).collect();
    let mut out: Vec<String> = located
        .iter()
        .map(|(path, line, function, op)| {
            format!("RustyBends panic [{function}]: {op} at {path}:{line}")
        })
        .collect();
    if sites.is_empty() {
        out.push("RustyBends panics: no checked-growth panic sites in emitted Rust".to_string());
    } else {
        out.push(format!(
            "RustyBends panics: {} checked-growth panic site(s) in {} function(s); mark a def '# {}' to return Option (None on overflow) instead of panicking",
            sites.len(),
            functions.len(),
            emit::TOTAL_MARKER
        ));
    }
    out
}

pub fn collect_bend_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
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
    let mut buf = b"rb-cache-v2\0".to_vec();
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
        let dir = env::temp_dir().join(format!("rusty_bends_v1_{name}_{}_{n}", std::process::id()));
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
            lock_update: LockUpdateMode::None,
            emit_rust: true,
            mutate_mode: MutateMode::NewOnly,
            list_laws: false,
            list_panics: false,
            list_coverage: false,
            crate_root: Some(root.to_path_buf()),
            no_cache: false,
        }
    }

    #[test]
    fn verify_and_emit_generates_adt_rust_and_caches() {
        let root = temp_workspace("emit_adt_cache");
        fs::write(
            root.join("verified/core.bend"),
            "type Status:\n  Open\n  Closed\n\ndef close(+s: Status) -> Status:\n  match s:\n    case Status.Open => Status.Closed\n    case Status.Closed => Status.Closed\n\n# promise: closing any status yields Closed\nlaw close_always_closed(for +s: Status):\n  close(s) == Status.Closed\n\nproof close_always_closed:\n  match s:\n    case Status.Open => refl\n    case Status.Closed => refl\n",
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
        let (runtime_part, tests_part) = emitted
            .split_once("#[cfg(test)]")
            .expect("expected generated #[cfg(test)] law module");
        assert!(runtime_part.contains("pub enum Status"));
        assert!(runtime_part.contains("Status::Open => Status::Closed,"));
        assert!(!runtime_part.contains("law close_always_closed"));
        assert!(tests_part.contains("fn law_close_always_closed()"));

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
    fn lock_blocks_weakened_law_and_approves_non_vacuous_human_update() {
        let root = temp_workspace("lock_tamper");
        let core = root.join("verified/core.bend");
        fs::write(
            &core,
            "def inc(+n: Nat) -> Nat:\n  n + 1n\n\n# promise: inc(2n) returns 3n\nlaw inc_two:\n  inc(2n) == 3n\n\nproof inc_two:\n  refl\n",
        )
        .unwrap();

        let cfg = make_cfg(&root);
        run_with_checker(&cfg, |_, _| Ok(())).expect("initial lock creation");
        let original_lock = fs::read_to_string(&cfg.lock_file).unwrap();

        // Tampering with a locked law to a vacuous tautology must fail with E_LAW_LOCK_TAMPERED
        fs::write(
            &core,
            "def inc(+n: Nat) -> Nat:\n  n + 1n\n\n# promise: tautology\nlaw inc_two:\n  3n == 3n\n\nproof inc_two:\n  refl\n",
        )
        .unwrap();

        let err = run_with_checker(&cfg, |_, _| Ok(())).expect_err("must fail on tampered law");
        assert!(err.contains("E_LAW_LOCK_TAMPERED"));

        // Even with RUSTY_BENDS_UPDATE_LAWS=1, sealing a vacuous law is blocked with E_LAW_VACUOUS
        // and the existing lock file must remain untouched.
        let mut approved_cfg = make_cfg(&root);
        approved_cfg.allow_lock_update = true;
        let vacuous_err =
            run_with_checker(&approved_cfg, |_, _| Ok(())).expect_err("vacuous update blocked");
        assert!(vacuous_err.contains("E_LAW_VACUOUS"));
        assert_eq!(fs::read_to_string(&cfg.lock_file).unwrap(), original_lock);

        // Updating to a non-vacuous law with RUSTY_BENDS_UPDATE_LAWS=1 succeeds and updates the lock.
        fs::write(
            &core,
            "def inc(+n: Nat) -> Nat:\n  n + 1n\n\n# promise: inc(3n) returns 4n\nlaw inc_two:\n  inc(3n) == 4n\n\nproof inc_two:\n  refl\n",
        )
        .unwrap();
        run_with_checker(&approved_cfg, |_, _| Ok(()))
            .expect("approved non-vacuous update succeeds");
        assert_ne!(fs::read_to_string(&cfg.lock_file).unwrap(), original_lock);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bend_version_pin_detects_mismatch() {
        assert!(verify_bend_version_str("0.2.38", "bend 0.2.38 (commit abc123)").is_ok());
        let err = verify_bend_version_str("0.2.38", "bend 0.3.0").unwrap_err();
        assert!(err.contains("E_BEND_VERSION_MISMATCH"));
    }

    #[test]
    fn bend_bin_resolution_prefers_env_then_path_then_home_install() {
        let root = temp_workspace("bend_bin_resolve");
        let home = root.join("home");
        let path_dir = root.join("pathdir");
        fs::create_dir_all(home.join(".bend/bin")).unwrap();
        fs::create_dir_all(&path_dir).unwrap();
        let installed = home.join(".bend/bin/bend");
        fs::write(&installed, "").unwrap();
        let empty_path = Some(env::join_paths([&path_dir]).unwrap());

        // Explicit BEND_BIN always wins.
        assert_eq!(
            resolve_bend_bin(
                Some("/opt/bend".into()),
                empty_path.clone(),
                Some(home.clone())
            ),
            "/opt/bend"
        );
        // Not on PATH -> fall back to ~/.bend/bin/bend.
        assert_eq!(
            resolve_bend_bin(None, empty_path.clone(), Some(home.clone())),
            installed.to_string_lossy()
        );
        // Blank BEND_BIN is treated as unset.
        assert_eq!(
            resolve_bend_bin(Some("  ".into()), empty_path.clone(), Some(home.clone())),
            installed.to_string_lossy()
        );
        // On PATH -> keep plain 'bend'.
        fs::write(path_dir.join("bend"), "").unwrap();
        assert_eq!(
            resolve_bend_bin(None, empty_path, Some(home.clone())),
            "bend"
        );
        // Nothing installed anywhere -> plain 'bend' (fails later with E_BEND_MISSING).
        assert_eq!(
            resolve_bend_bin(None, None, Some(root.join("nohome"))),
            "bend"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn bend_version_query_uses_subcommand_and_falls_back() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_workspace("bend_version_query");
        let script = |name: &str, body: &str| {
            let p = root.join(name);
            fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
            p.to_string_lossy().into_owned()
        };
        // Bend 2.0.40: 'version' works, '--version' is an unknown option.
        let new_bend = script(
            "bend_new",
            r#"if [ "$1" = version ]; then echo "bend 2.0.40"; else echo "bend: unknown option $1" >&2; exit 1; fi"#,
        );
        let v = query_bend_version(&new_bend).unwrap();
        assert!(v.contains("2.0.40"));
        assert!(verify_bend_version_str("2.0.40", &v).is_ok());

        // Older releases: only '--version' works.
        let old_bend = script(
            "bend_old",
            r#"if [ "$1" = --version ]; then echo "bend 0.2.38"; else exit 2; fi"#,
        );
        assert!(query_bend_version(&old_bend).unwrap().contains("0.2.38"));

        // Neither works: report the failure instead of matching the pin against error text.
        let broken = script("bend_broken", "echo boom >&2; exit 1");
        let err = query_bend_version(&broken).unwrap_err();
        assert!(err.contains("E_BEND_VERSION_QUERY"));
        assert!(err.contains("boom"));

        let _ = fs::remove_dir_all(&root);
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

    #[test]
    fn failed_law_distinguishes_false_law_counterexample_from_incomplete_proof() {
        let root = temp_workspace("issue7_diag");
        let core = root.join("verified/core.bend");
        let mut cfg = make_cfg(&root);
        cfg.bend_bin = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        cfg.verdict_mode = VerdictMode::Off;

        // 1. Valid locked release_conserves_total first
        let valid_src = r#"import Base

type Ledger is Data:
  Ledger{a: Nat, f: Nat}

def ledger_total(+p: Ledger) -> Nat:
  match p:
    case Ledger{a, f}:
      Nat.add(a, f)

def ledger_release_if(+a: Nat, +f: Nat, +rel: Nat, ok: Bool) -> Ledger:
  match ok:
    case True{}:
      Ledger{Nat.sub(a, rel), Nat.add(f, rel)}
    case False{}:
      Ledger{a, f}

def ledger_release(+p: Ledger, +rel: Nat) -> Ledger:
  match p:
    case Ledger{+a, f}:
      ledger_release_if(a, f, rel, Nat.is_le(rel, a))

# promise: releasing from a ledger conserves its total
law release_conserves_total:
  for +a: Nat
  for +f: Nat
  for +rel: Nat
  {ledger_total(ledger_release(Ledger{a, f}, rel)) == Nat.add(a, f) : Nat}
"#;
        // Seed the lock as if the law was previously sealed, then break the function (False{} drops sub, adding rel unconditionally).
        fs::write(&core, valid_src).unwrap();
        let _ = lock::enforce_law_lock(&cfg.lock_file, std::slice::from_ref(&core), false).unwrap();

        let broken_src = r#"import Base

type Ledger is Data:
  Ledger{a: Nat, f: Nat}

def ledger_total(+p: Ledger) -> Nat:
  match p:
    case Ledger{a, f}:
      Nat.add(a, f)

def ledger_release_if(+a: Nat, +f: Nat, +rel: Nat, ok: Bool) -> Ledger:
  match ok:
    case True{}:
      Ledger{Nat.sub(a, rel), Nat.add(f, rel)}
    case False{}:
      Ledger{a, Nat.add(f, rel)}

def ledger_release(+p: Ledger, +rel: Nat) -> Ledger:
  match p:
    case Ledger{+a, f}:
      ledger_release_if(a, f, rel, Nat.is_le(rel, a))

# promise: releasing from a ledger conserves its total
law release_conserves_total:
  for +a: Nat
  for +f: Nat
  for +rel: Nat
  {ledger_total(ledger_release(Ledger{a, f}, rel)) == Nat.add(a, f) : Nat}

def release_conserves_total(a, f, rel):
  {==}
"#;
        fs::write(&core, broken_src).unwrap();
        let err_false = run(&cfg).expect_err("broken function must fail build");
        assert!(
            err_false.contains("[E_LAW_FALSE] law release_conserves_total is FALSE for this code (evaluated with emitted Rust)"),
            "expected counterexample header, got:\n{err_false}"
        );
        assert!(err_false.contains("lhs ledger_total(ledger_release(Ledger{"));
        assert!(err_false.contains("rhs Nat.add("));
        assert!(err_false.contains("stop: the law is locked"));

        // 2. True law with an incomplete proof -> no counterexample found, reports proof failure.
        let root2 = temp_workspace("issue7_proof_only");
        let core2 = root2.join("verified/core.bend");
        let mut cfg2 = make_cfg(&root2);
        cfg2.bend_bin = cfg.bend_bin.clone();
        cfg2.verdict_mode = VerdictMode::Off;

        let incomplete_proof_src = r#"import Base

def deposit(+bal: Nat, +amt: Nat) -> Nat:
  Nat.add(bal, amt)

# promise: depositing zero leaves balance unchanged
law deposit_zero:
  for +bal: Nat
  {deposit(bal, 0n) == bal : Nat}

def deposit_zero(bal):
  match bal:
    case 0n:
      {==}
    case 1n+p:
      {==}
"#;
        fs::write(&core2, incomplete_proof_src).unwrap();
        let err_proof = run(&cfg2).expect_err("incomplete proof must fail build");
        assert!(
            err_proof.contains("law deposit_zero: no counterexample up to"),
            "expected no-counterexample line, got:\n{err_proof}"
        );
        assert!(err_proof.contains("evaluated with emitted Rust"));
        assert!(err_proof.contains("the law may be true; the proof is what failed"));
        assert!(err_proof.contains("SOME PROOFS FAIL"));

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&root2);
    }

    #[test]
    fn new_law_requires_promise_and_wording_change_preserves_lock() {
        let root = temp_workspace("issue8_promise");
        let core = root.join("verified/core.bend");
        let cfg = make_cfg(&root);

        fs::write(
            &core,
            "def inc(+n: Nat) -> Nat:\n  n + 1n\n\nlaw inc_two:\n  inc(2n) == 3n\n",
        )
        .unwrap();
        let err = run_with_checker(&cfg, |_, _| Ok(())).expect_err("must require # promise:");
        assert!(err.contains("E_LAW_NO_PROMISE"), "got: {err}");
        assert!(!cfg.lock_file.exists(), "lock must not be written on error");

        fs::write(
            &core,
            "def inc(+n: Nat) -> Nat:\n  n + 1n\n\n# promise: inc adds one to two\nlaw inc_two:\n  inc(2n) == 3n\n",
        )
        .unwrap();
        run_with_checker(&cfg, |_, _| Ok(())).expect("law with # promise: passes");

        // Editing only the promise wording must not trigger E_LAW_LOCK_TAMPERED
        fs::write(
            &core,
            "def inc(+n: Nat) -> Nat:\n  n + 1n\n\n# promise: incrementing two always returns three\n# harm: off-by-one increment bug\nlaw inc_two:\n  inc(2n) == 3n\n",
        )
        .unwrap();
        run_with_checker(&cfg, |_, _| Ok(()))
            .expect("promise wording edit must pass without E_LAW_LOCK_TAMPERED");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn issue9_recursive_chain_and_base_list_laws_verify_and_run_generated_rust_tests() {
        let root = temp_workspace("issue9_recursive");
        let chain_file = root.join("verified/chain.bend");
        let list_file = root.join("verified/lists.bend");

        fs::write(
            &chain_file,
            r#"import Base

type Chain is Data:
  ChainEnd{}
  ChainLink{has_limit: Bool, limit: Nat, in_use: Nat, rest: Chain}

def chain_step(+so_far: Nat, has_limit: Bool, limit: Nat, in_use: Nat) -> Nat:
  match has_limit:
    case True{}:
      Nat.min(so_far, Nat.sub(limit, in_use))
    case False{}:
      so_far

def chain_available(c: Chain, +so_far: Nat) -> Nat:
  match c:
    case ChainEnd{}:
      so_far
    case ChainLink{h, l, u, rest}:
      chain_available(rest, chain_step(so_far, h, l, u))

# promise: zero starting host capacity stays zero along any cgroup chain
law chain_available_zero:
  for c: Chain
  {chain_available(c, 0n) == 0n : Nat}

def chain_available_zero(c):
  match c:
    case ChainEnd{}:
      {==}
    case ChainLink{h, l, u, rest}:
      match h:
        case True{}:
          chain_available_zero(rest)
        case False{}:
          chain_available_zero(rest)
"#,
        )
        .unwrap();

        fs::write(
            &list_file,
            r#"import Base

def sum_list(xs: List<&2, Nat>) -> Nat:
  match xs:
    case Nil{}:
      0n
    case Con{h, t}:
      Nat.add(h, sum_list(t))

def list_cat(xs: List<&2, Nat>, ys: List<&2, Nat>) -> List<&2, Nat>:
  match xs:
    case Nil{}:
      ys
    case Con{h, t}:
      Con{h, list_cat(t, ys)}

def add_assoc(a: Nat, b: Nat, c: Nat) -> {Nat.add(a, Nat.add(b, c)) == Nat.add(Nat.add(a, b), c) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %add_assoc(ap, b, c) : {1n+Nat.add(ap, Nat.add(b, c)) == 1n+_ : Nat}
      {==}

# promise: summing two concatenated lists equals the sum of their individual sums
law sum_list_cat:
  for +xs: List<&2, Nat>
  for +ys: List<&2, Nat>
  {sum_list(list_cat(xs, ys)) == Nat.add(sum_list(xs), sum_list(ys)) : Nat}

def sum_list_cat(xs, ys):
  match xs:
    case Nil{}:
      {==}
    case Con{+h, +t}:
      %Equal.sym(Nat, sum_list(list_cat(t, ys)), Nat.add(sum_list(t), sum_list(ys)), sum_list_cat(t, ys)) : {Nat.add(h, _) == Nat.add(Nat.add(h, sum_list(t)), sum_list(ys)) : Nat}
      add_assoc(h, sum_list(t), sum_list(ys))
"#,
        )
        .unwrap();

        let mut cfg = make_cfg(&root);
        cfg.bend_bin = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        cfg.verdict_mode = if has_verdict_runtime() {
            VerdictMode::Require
        } else {
            VerdictMode::Off
        };

        let out_rs = run(&cfg)
            .expect("recursive Chain and Base List laws must pass bend, mutation check, and emit")
            .expect("expected emitted verified.rs");
        let emitted = fs::read_to_string(&out_rs).unwrap();
        assert!(emitted.contains("ChainLink(bool, u64, u64, Box<Chain>),"));
        assert!(emitted.contains("pub enum List<T>"));
        assert!(emitted.contains("fn law_chain_available_zero()"));
        assert!(emitted.contains("fn law_sum_list_cat()"));

        let bin_path = root.join("out/test_bin");
        let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = Command::new(&rustc)
            .args(["--edition", "2021", "--test", "-D", "warnings", "-o"])
            .arg(&bin_path)
            .arg(&out_rs)
            .output()
            .expect("rustc --test must execute");
        assert!(
            compile.status.success(),
            "rustc --test failed:\n{}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run_tests = Command::new(&bin_path)
            .output()
            .expect("generated law test binary must run");
        assert!(
            run_tests.status.success(),
            "generated law tests failed:\n{}{}",
            String::from_utf8_lossy(&run_tests.stdout),
            String::from_utf8_lossy(&run_tests.stderr)
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn issue10_sibling_import_aliases_verify_mutate_and_compile_end_to_end() {
        let root = temp_workspace("issue10_imports");
        let base_rules = root.join("verified/base_rules.bend");
        let uses = root.join("verified/uses.bend");

        fs::write(
            &base_rules,
            r#"import Base

type Status is Data:
  Open{}
  Closed{}

def within_limit(pos: Nat, limit: Nat) -> Bool:
  Nat.is_le(pos, limit)
"#,
        )
        .unwrap();

        fs::write(
            &uses,
            r#"import Base
import base_rules.bend as B

def within_both(+pos: Nat, a: Nat, b: Nat) -> Bool:
  Bool.and(B.within_limit(pos, a), Nat.is_le(pos, b))

def open_or(s: B.Status, flag: Bool) -> Bool:
  match s:
    case B.Open{}: True{}
    case B.Closed{}: flag

def diag_aux(a: Bool) -> {Bool.and(a, a) == a : Bool}:
  match a:
    case True{}: {==}
    case False{}: {==}

# promise: checking both limits when they are equal matches within_limit
law within_both_diag:
  for +pos: Nat
  for +a: Nat
  {within_both(pos, a, a) == B.within_limit(pos, a) : Bool}

def within_both_diag(pos, a):
  diag_aux(B.within_limit(pos, a))

# promise: an open status always permits the action regardless of fallback flag
law open_or_open:
  for flag: Bool
  {open_or(B.Open{}, flag) == True{} : Bool}

def open_or_open(flag):
  {==}
"#,
        )
        .unwrap();

        let mut cfg = make_cfg(&root);
        cfg.bend_bin = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        cfg.verdict_mode = if has_verdict_runtime() {
            VerdictMode::Require
        } else {
            VerdictMode::Off
        };

        let out_rs = run(&cfg)
            .expect("sibling import aliases must pass bend, mutation check, lock, and emit")
            .expect("expected emitted verified.rs");
        let emitted = fs::read_to_string(&out_rs).unwrap();
        assert!(!emitted.contains("B::"), "emitted leaked B::\n{emitted}");
        assert!(emitted.contains("within_limit(pos, a)"), "got:\n{emitted}");
        assert!(emitted.contains("pub enum Status"), "got:\n{emitted}");

        let bin_path = root.join("out/test_bin");
        let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = Command::new(&rustc)
            .args(["--edition", "2021", "--test", "-D", "warnings", "-o"])
            .arg(&bin_path)
            .arg(&out_rs)
            .output()
            .expect("rustc --test must execute");
        assert!(
            compile.status.success(),
            "rustc --test failed:\n{}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run_tests = Command::new(&bin_path)
            .output()
            .expect("generated law test binary must run");
        assert!(
            run_tests.status.success(),
            "generated law tests failed:\n{}{}",
            String::from_utf8_lossy(&run_tests.stdout),
            String::from_utf8_lossy(&run_tests.stderr)
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nat_lemmas_bend_checks_with_bend_verdict_and_erases_completely() {
        let root = temp_workspace("issue11_lemmas_only");
        let lemma_path = write_nat_lemmas(root.join("verified"))
            .expect("write_nat_lemmas should create nat_lemmas.bend");
        assert!(lemma_path.ends_with("verified/nat_lemmas.bend"));
        assert_eq!(fs::read_to_string(&lemma_path).unwrap(), NAT_LEMMAS_BEND);

        // Idempotent second write preserves content.
        let lemma_path_2 =
            write_nat_lemmas(root.join("verified")).expect("idempotent write_nat_lemmas");
        assert_eq!(lemma_path_2, lemma_path);

        let erased =
            emit::emit_verified_rust(NAT_LEMMAS_BEND, 0).expect("nat_lemmas.bend must emit");
        assert_eq!(erased.types_emitted, 0);
        assert_eq!(erased.defs_emitted, 0);

        let bend_bin = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        if Path::new(&bend_bin).is_file() || env::var("BEND_BIN").is_ok() {
            run_bend_step(&bend_bin, "--check-only", &lemma_path)
                .expect("nat_lemmas.bend must pass bend --check-only");
            if has_verdict_runtime() {
                run_bend_step(&bend_bin, "--verdict", &lemma_path)
                    .expect("nat_lemmas.bend must pass bend --verdict");
            }
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn chunk_split_laws_verified_with_bundled_nat_lemmas() {
        let root = temp_workspace("issue11_chunk_split");
        let _ = write_nat_lemmas(root.join("verified"))
            .expect("write_nat_lemmas should populate verified/");
        let chunks_file = root.join("verified/chunks.bend");
        fs::write(
            &chunks_file,
            r#"import Base
import nat_lemmas.bend as L

def chunk_of(t: Nat, per: Nat) -> Nat:
  Nat.div(t, 1n+per)

def slot_of(t: Nat, per: Nat) -> Nat:
  Nat.mod(t, 1n+per)

def index_of(chunk: Nat, slot: Nat, per: Nat) -> Nat:
  Nat.add(slot, Nat.mul(chunk, 1n+per))

# promise: every index maps to a slot strictly below the chunk size
law slot_below_size:
  for t: Nat
  for per: Nat
  {Nat.is_lt(slot_of(t, per), 1n+per) == True{} : Bool}

def slot_below_size(t, per):
  L.nat_mod_lt(t, per)

# promise: splitting an index into chunk and slot reconstructs the original index
law split_reconstructs_index:
  for t: Nat
  for per: Nat
  {index_of(chunk_of(t, per), slot_of(t, per), per) == t : Nat}

def split_reconstructs_index(t, per):
  L.nat_div_mod(t, per)

# promise: every index below chunks * chunk size maps to a chunk strictly below chunks
law chunk_in_bounds:
  for t: Nat
  for chunks: Nat
  for per: Nat
  for h: {Nat.is_lt(t, Nat.mul(chunks, 1n+per)) == True{} : Bool}
  {Nat.is_lt(chunk_of(t, per), chunks) == True{} : Bool}

def chunk_in_bounds(t, chunks, per, h):
  L.nat_div_lt_of_lt_mul(t, chunks, per, h)
"#,
        )
        .unwrap();

        let mut cfg = make_cfg(&root);
        cfg.bend_bin = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        cfg.verdict_mode = if has_verdict_runtime() {
            VerdictMode::Require
        } else {
            VerdictMode::Off
        };

        let out_rs = run(&cfg)
            .expect("chunk split laws using nat_lemmas.bend must pass bend, mutation check, lock, and emit")
            .expect("expected emitted verified.rs");
        let emitted = fs::read_to_string(&out_rs).unwrap();
        assert!(emitted.contains("pub fn chunk_of("), "got:\n{emitted}");
        assert!(emitted.contains("pub fn slot_of("), "got:\n{emitted}");
        assert!(emitted.contains("pub fn index_of("), "got:\n{emitted}");
        assert!(
            !emitted.contains("nat_mod_lt"),
            "emitted leaked proof helper:\n{emitted}"
        );
        assert!(
            !emitted.contains("nat_div_mod"),
            "emitted leaked proof helper:\n{emitted}"
        );
        assert!(
            !emitted.contains("bool_pick_type"),
            "emitted leaked type helper:\n{emitted}"
        );
        assert!(
            !emitted.contains("L::"),
            "emitted leaked alias L:::\n{emitted}"
        );

        let bin_path = root.join("out/test_bin");
        let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = Command::new(&rustc)
            .args(["--edition", "2021", "--test", "-D", "warnings", "-o"])
            .arg(&bin_path)
            .arg(&out_rs)
            .output()
            .expect("rustc --test must execute");
        assert!(
            compile.status.success(),
            "rustc --test failed:\n{}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run_tests = Command::new(&bin_path)
            .output()
            .expect("generated law test binary must run");
        assert!(
            run_tests.status.success(),
            "generated law tests failed:\n{}{}",
            String::from_utf8_lossy(&run_tests.stdout),
            String::from_utf8_lossy(&run_tests.stderr)
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn euclidean_division_lemmas_verify_with_verdict_and_run_rust_tests() {
        let root = temp_workspace("issue22_euclidean");
        let _ = write_nat_lemmas(root.join("verified"))
            .expect("write_nat_lemmas should populate verified/");
        let grid_file = root.join("verified/grid.bend");
        fs::write(
            &grid_file,
            r#"import Base
import nat_lemmas.bend as L

def slot_of(+i: Nat) -> Nat:
  Nat.mod(i, 4n)

def row_of(+i: Nat) -> Nat:
  Nat.div(i, 4n)

def make_index(+q: Nat, +r: Nat) -> Nat:
  Nat.add(Nat.mul(q, 4n), r)

# promise: the slot of row q and slot r (r < 4) is r
law slot_of_split:
  for +q: Nat
  for +r: Nat
  for h: {Nat.is_lt(r, 4n) == True{} : Bool}
  {slot_of(make_index(q, r)) == r : Nat}

def slot_of_split(q, r, h):
  L.nat_mod_split(q, r, 3n, h)

# promise: the row of row q and slot r (r < 4) is q
law row_of_split:
  for q: Nat
  for r: Nat
  for h: {Nat.is_lt(r, 4n) == True{} : Bool}
  {row_of(make_index(q, r)) == q : Nat}

def row_of_split(q, r, h):
  L.nat_div_split(q, r, 3n, h)

# promise: an index below four keeps its value as its slot
law slot_of_small:
  for a: Nat
  for h: {Nat.is_lt(a, 4n) == True{} : Bool}
  {slot_of(a) == a : Nat}

def slot_of_small(a, h):
  L.nat_mod_small(a, 3n, h)

# promise: an index below four has row zero
law row_of_small:
  for a: Nat
  for h: {Nat.is_lt(a, 4n) == True{} : Bool}
  {row_of(a) == 0n : Nat}

def row_of_small(a, h):
  L.nat_div_small(a, 3n, h)

# promise: two indices with the same row and slot are equal
law eq_of_row_and_slot:
  for a: Nat
  for c: Nat
  for hq: {row_of(a) == row_of(c) : Nat}
  for hr: {slot_of(a) == slot_of(c) : Nat}
  {a == c : Nat}

def eq_of_row_and_slot(a, c, hq, hr):
  L.nat_eq_of_div_mod(a, c, 3n, hq, hr)

# promise: row q below n with slot r below 4 stays below n * 4
law split_in_bounds:
  for q: Nat
  for r: Nat
  for n: Nat
  for hq: {Nat.is_lt(q, n) == True{} : Bool}
  for hr: {Nat.is_lt(r, 4n) == True{} : Bool}
  {Nat.is_lt(make_index(q, r), Nat.mul(n, 4n)) == True{} : Bool}

def split_in_bounds(q, r, n, hq, hr):
  L.nat_split_lt(q, r, n, 3n, hq, hr)

# promise: multiples of four have slot zero
law aligned_slot_zero:
  for q: Nat
  {slot_of(Nat.mul(q, 4n)) == 0n : Nat}

def aligned_slot_zero(q):
  L.nat_mod_mul(q, 3n)

# promise: dividing a multiple of four recovers the row
law aligned_row:
  for q: Nat
  {row_of(Nat.mul(q, 4n)) == q : Nat}

def aligned_row(q):
  L.nat_div_mul(q, 3n)

# promise: the aligned-down index never exceeds the original index
law align_down_le:
  for a: Nat
  {Nat.is_le(Nat.mul(row_of(a), 4n), a) == True{} : Bool}

def align_down_le(a):
  L.nat_align_down_le(a, 3n)
"#,
        )
        .unwrap();

        let mut cfg = make_cfg(&root);
        cfg.bend_bin = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        cfg.verdict_mode = if has_verdict_runtime() {
            VerdictMode::Require
        } else {
            VerdictMode::Off
        };

        let out_rs = run(&cfg)
            .expect("Euclidean division laws must pass bend, verdict, mutation check, and emit")
            .expect("expected emitted verified.rs");
        let emitted = fs::read_to_string(&out_rs).unwrap();
        assert!(emitted.contains("pub fn slot_of("), "got:\n{emitted}");
        assert!(emitted.contains("pub fn row_of("), "got:\n{emitted}");
        assert!(emitted.contains("pub fn make_index("), "got:\n{emitted}");
        for leaked in [
            "nat_mod_split",
            "nat_div_split",
            "nat_split_unique_q",
            "nat_split_unique_r",
            "nat_eq_of_div_mod",
            "nat_align_down_le",
        ] {
            assert!(
                !emitted.contains(leaked),
                "emitted leaked proof helper {leaked}:\n{emitted}"
            );
        }

        let bin_path = root.join("out/test_bin");
        let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = Command::new(&rustc)
            .args(["--edition", "2021", "--test", "-D", "warnings", "-o"])
            .arg(&bin_path)
            .arg(&out_rs)
            .output()
            .expect("rustc --test must execute");
        assert!(
            compile.status.success(),
            "rustc --test failed:\n{}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run_tests = Command::new(&bin_path)
            .output()
            .expect("generated law test binary must run");
        assert!(
            run_tests.status.success(),
            "generated law tests failed:\n{}{}",
            String::from_utf8_lossy(&run_tests.stdout),
            String::from_utf8_lossy(&run_tests.stderr)
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_rejects_verdict_require_after_off_or_skipped_build_and_tracks_flags() {
        let root = temp_workspace("issue18_cache");
        let _ = write_nat_lemmas(root.join("verified")).unwrap();
        let ledger = root.join("verified/ledger.bend");
        fs::write(
            &ledger,
            r#"import Base
import nat_lemmas.bend as L

def total_items(+a: Nat, +b: Nat) -> Nat:
  Nat.add(a, b)

def bump(+n: Nat) -> Nat:
  1n+n

# promise: the total never drops below the first delivery
law total_covers_first:
  for +a: Nat
  for +b: Nat
  {Nat.is_le(a, total_items(a, b)) == True{} : Bool}

def total_covers_first(a, b):
  L.nat_add_le_r(a, b)

# promise: a write always changes the stamp
law bump_changes:
  for +m: Nat
  {Nat.is_eq(m, bump(m)) == False{} : Bool}

def bump_changes(m):
  match m:
    case 0n:
      {==}
    case 1n+mp:
      bump_changes(mp)
"#,
        )
        .unwrap();

        let real_bend = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );

        // 1. Failing --verdict invocation (unknown flag) fails directly without misleading proof note.
        let mut bad_req = make_cfg(&root);
        bad_req.bend_bin = real_bend.clone();
        bad_req.verdict_mode = VerdictMode::Require;
        bad_req.verdict_flag = "--no-such-flag".to_string();
        let err1 = run(&bad_req).expect_err("unknown verdict flag must fail");
        assert!(err1.contains("unknown option --no-such-flag"), "{err1}");
        assert!(
            !err1.contains("the proof is what failed"),
            "CLI error must not misdiagnose proof failure:\n{err1}"
        );

        // 2. BEND_VERDICT=off succeeds and records verdict=off in cache.
        let mut off_cfg = make_cfg(&root);
        off_cfg.bend_bin = real_bend.clone();
        off_cfg.verdict_mode = VerdictMode::Off;
        run(&off_cfg).expect("off build passes");
        let cache_off = fs::read_to_string(root.join("out/rusty-bends.cache")).unwrap();
        assert!(cache_off.contains("verdict=off\n"), "{cache_off}");

        // 3. Subsequent BEND_VERDICT=require with bad flag must NOT hit cache.
        let err2 = run(&bad_req).expect_err("require build after off build must miss cache");
        assert!(err2.contains("unknown option --no-such-flag"), "{err2}");

        // 4. Skipped Auto verdict (no Lean runtime) followed by Require must also miss cache.
        let mut auto_cfg = make_cfg(&root);
        auto_cfg.verdict_mode = VerdictMode::Auto;
        let mut calls = 0usize;
        run_pipeline(&auto_cfg, Some("bend 2.0.40"), false, |_file, _has_laws| {
            calls += 1;
            Ok(VerdictApplied::Skipped)
        })
        .expect("auto skipped build passes");
        assert_eq!(calls, 2);
        let cache_skip = fs::read_to_string(root.join("out/rusty-bends.cache")).unwrap();
        assert!(cache_skip.contains("verdict=skipped\n"), "{cache_skip}");

        let mut req_cfg = make_cfg(&root);
        req_cfg.verdict_mode = VerdictMode::Require;
        run_pipeline(&req_cfg, Some("bend 2.0.40"), true, |_file, _has_laws| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .expect("require build runs checker");
        assert_eq!(calls, 4, "require after skipped must miss cache");

        // Repeating Require with identical config hits cache.
        run_pipeline(&req_cfg, Some("bend 2.0.40"), true, |_file, _has_laws| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .expect("matching require build hits cache");
        assert_eq!(calls, 4);

        // 5. Changing flags, bend_bin, bend_version, or no_cache misses cache.
        let mut diff_check = req_cfg.clone();
        diff_check.check_flag = "--check-only-alt".to_string();
        run_pipeline(&diff_check, Some("bend 2.0.40"), true, |_, _| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .unwrap();
        assert_eq!(calls, 6);

        let mut diff_verdict_flag = req_cfg.clone();
        diff_verdict_flag.verdict_flag = "--verdict-alt".to_string();
        run_pipeline(&diff_verdict_flag, Some("bend 2.0.40"), true, |_, _| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .unwrap();
        assert_eq!(calls, 8);

        let mut diff_bin = req_cfg.clone();
        diff_bin.bend_bin = "/opt/bend".to_string();
        run_pipeline(&diff_bin, Some("bend 2.0.40"), true, |_, _| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .unwrap();
        assert_eq!(calls, 10);

        run_pipeline(&diff_bin, Some("bend 2.0.41"), true, |_, _| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .unwrap();
        assert_eq!(calls, 12);

        let mut no_cache_cfg = diff_bin.clone();
        no_cache_cfg.no_cache = true;
        run_pipeline(&no_cache_cfg, Some("bend 2.0.41"), true, |_, _| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .unwrap();
        assert_eq!(calls, 14);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn selective_lock_update_blocks_vacuous_named_law_without_touching_lock() {
        let root = temp_workspace("issue17_e2e");
        let core = root.join("verified/core.bend");
        fs::write(
            &core,
            "import Base\n\ndef inc(+n: Nat) -> Nat:\n  Nat.add(n, 1n)\n\n# promise: zero increments to one\nlaw inc_zero:\n  {inc(0n) == 1n : Nat}\n",
        )
        .unwrap();

        let cfg = make_cfg(&root);
        run_with_checker(&cfg, |_, _| Ok(())).expect("initial lock creation");
        let original_lock = fs::read_to_string(&cfg.lock_file).unwrap();

        fs::write(
            &core,
            "import Base\n\ndef inc(+n: Nat) -> Nat:\n  Nat.add(n, 1n)\n\n# promise: zero increments to one\nlaw inc_zero:\n  {inc(0n) == 1n : Nat}\n\n# promise: vacuous identity\nlaw inc_refl:\n  for +n: Nat\n  {inc(n) == inc(n) : Nat}\n",
        )
        .unwrap();

        let mut seal_vacuous = make_cfg(&root);
        seal_vacuous.lock_update = LockUpdateMode::parse("inc_refl");
        let err = run_with_checker(&seal_vacuous, |_, _| Ok(()))
            .expect_err("vacuous named law must fail before lock write");
        assert!(err.contains("E_LAW_VACUOUS"), "{err}");
        assert_eq!(fs::read_to_string(&cfg.lock_file).unwrap(), original_lock);

        // Replace vacuous law with two valid new laws and seal only one by name.
        fs::write(
            &core,
            "import Base\n\ndef inc(+n: Nat) -> Nat:\n  Nat.add(n, 1n)\n\n# promise: zero increments to one\nlaw inc_zero:\n  {inc(0n) == 1n : Nat}\n\n# promise: one increments to two\nlaw inc_one:\n  {inc(1n) == 2n : Nat}\n\n# promise: two increments to three\nlaw inc_two:\n  {inc(2n) == 3n : Nat}\n",
        )
        .unwrap();
        let mut seal_one = make_cfg(&root);
        seal_one.lock_update = LockUpdateMode::parse("inc_one");
        run_with_checker(&seal_one, |_, _| Ok(())).expect("named seal of inc_one succeeds");
        let lock_after = fs::read_to_string(&cfg.lock_file).unwrap();
        assert!(lock_after.contains("inc_zero"));
        assert!(lock_after.contains("inc_one"));
        assert!(!lock_after.contains("inc_two"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_coverage_runs_through_pipeline_and_bypasses_warm_cache() {
        let root = temp_workspace("issue21_pipeline");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("verified/ledger.bend"),
            r#"import Base

def order_fits(+used: Nat, +want: Nat, +cap: Nat) -> Bool:
  Nat.is_le(want, Nat.sub(cap, used))

def order_fits_spec(+used: Nat, +want: Nat, +cap: Nat) -> Bool:
  Nat.is_le(Nat.add(used, want), cap)

def round_up(+x: Nat, +step: Nat) -> Nat:
  Nat.mul(Nat.div(Nat.add(x, Nat.sub(step, 1n)), step), step)

# promise: an empty order always fits
law order_fits_empty:
  for +cap: Nat
  {order_fits_spec(0n, 0n, cap) == True{} : Bool}
"#,
        )
        .unwrap();
        fs::write(
            root.join("src/main.rs"),
            "fn main() { let _ = (verified::order_fits(3, 4, 10), verified::round_up(5, 4)); }\n",
        )
        .unwrap();

        let cfg = make_cfg(&root);
        let mut calls = 0usize;
        run_with_checker(&cfg, |_, _| {
            calls += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(calls, 1);

        // With list_coverage = true, the build bypasses warm cache and runs coverage listing.
        let mut cov_cfg = make_cfg(&root);
        cov_cfg.list_coverage = true;
        run_with_checker(&cov_cfg, |_, _| {
            calls += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(calls, 2);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn multiline_warning_formats_one_cargo_warning_per_line() {
        let lines = format_cargo_warning_lines(
            "[E_MUTANT_BUILD] Law 'foo': 1 of 2 mutants did not compile\nFirst failing mutant: f: x -> Y\nrustc: error[E0308]: mismatched types",
        );
        assert_eq!(
            lines,
            vec![
                "cargo:warning=[E_MUTANT_BUILD] Law 'foo': 1 of 2 mutants did not compile",
                "cargo:warning=First failing mutant: f: x -> Y",
                "cargo:warning=rustc: error[E0308]: mismatched types",
            ]
        );
        for line in &lines {
            assert!(!line.contains('\n'));
        }
    }

    #[test]
    fn cache_invalidates_when_builder_hash_changes() {
        assert_eq!(BUILDER_HASH.len(), 32, "BUILDER_HASH={BUILDER_HASH}");
        assert!(
            BUILDER_HASH.chars().all(|c| c.is_ascii_hexdigit()),
            "BUILDER_HASH={BUILDER_HASH}"
        );

        let root = temp_workspace("issue24_builder_hash");
        fs::write(
            root.join("verified/core.bend"),
            "import Base\n\ndef add_one(+n: Nat) -> Nat:\n  Nat.add(n, 1n)\n\n# promise: zero increments to one\nlaw add_one_zero:\n  {add_one(0n) == 1n : Nat}\n",
        )
        .unwrap();

        let cfg = make_cfg(&root);
        let mut calls = 0usize;
        let out_rs =
            run_pipeline_with_builder(&cfg, Some("bend 2.0.40"), "builder_a", true, |_, _| {
                calls += 1;
                Ok(VerdictApplied::Ran)
            })
            .expect("first build with builder_a succeeds")
            .expect("verified.rs emitted");
        assert_eq!(calls, 1);
        let cache_a = fs::read_to_string(root.join("out/rusty-bends.cache")).unwrap();
        assert!(cache_a.starts_with("v4\n"), "{cache_a}");
        assert!(cache_a.contains("builder=builder_a\n"), "{cache_a}");

        // Repeating with identical builder hash hits cache.
        run_pipeline_with_builder(&cfg, Some("bend 2.0.40"), "builder_a", true, |_, _| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .expect("second build with builder_a hits cache");
        assert_eq!(calls, 1);

        // Switching builder hash invalidates the warm stamp and regenerates verified.rs.
        fs::write(&out_rs, "// stale-verified\n").unwrap();
        run_pipeline_with_builder(&cfg, Some("bend 2.0.40"), "builder_b", true, |_, _| {
            calls += 1;
            Ok(VerdictApplied::Ran)
        })
        .expect("build with builder_b misses cache and regenerates");
        assert_eq!(calls, 2);
        let emitted_b = fs::read_to_string(&out_rs).unwrap();
        assert!(
            !emitted_b.contains("stale-verified"),
            "expected regenerated verified.rs, got:\n{emitted_b}"
        );
        let cache_b = fs::read_to_string(root.join("out/rusty-bends.cache")).unwrap();
        assert!(cache_b.contains("builder=builder_b\n"), "{cache_b}");

        let _ = fs::remove_dir_all(&root);
    }

    fn copy_dir_recursive(src: &Path, dst: &Path) {
        fs::create_dir_all(dst).unwrap();
        for entry in fs::read_dir(src).unwrap() {
            let entry = entry.unwrap();
            let src_path = entry.path();
            let dst_path = dst.join(entry.file_name());
            if src_path.is_dir() {
                copy_dir_recursive(&src_path, &dst_path);
            } else if src_path.is_file() {
                fs::copy(&src_path, &dst_path).unwrap();
            }
        }
    }

    fn find_app_out_file(build_dir: &Path, file_name: &str) -> PathBuf {
        let mut matches = Vec::new();
        for entry in fs::read_dir(build_dir).unwrap() {
            let path = entry.unwrap().path();
            let is_app = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("app-"));
            if is_app {
                let candidate = path.join("out").join(file_name);
                if candidate.is_file() {
                    matches.push(candidate);
                }
            }
        }
        assert_eq!(
            matches.len(),
            1,
            "expected exactly one {file_name} under {}, got {matches:?}",
            build_dir.display()
        );
        matches.pop().unwrap()
    }

    #[test]
    fn cargo_rebuild_invalidates_cache_when_rusty_bends_build_changes() {
        let root = temp_workspace("issue24_cargo_rebuild");
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let rb = root.join("rb");
        fs::create_dir_all(&rb).unwrap();
        fs::copy(manifest.join("Cargo.toml"), rb.join("Cargo.toml")).unwrap();
        fs::copy(manifest.join("build.rs"), rb.join("build.rs")).unwrap();
        copy_dir_recursive(&manifest.join("src"), &rb.join("src"));
        copy_dir_recursive(&manifest.join("lemmas"), &rb.join("lemmas"));

        let app = root.join("app");
        fs::create_dir_all(app.join("verified")).unwrap();
        fs::create_dir_all(app.join("src")).unwrap();
        fs::write(
            app.join("Cargo.toml"),
            "[package]\nname = \"app\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[workspace]\n\n[build-dependencies]\nrusty-bends-build = { path = \"../rb\" }\n",
        )
        .unwrap();
        fs::write(
            app.join("build.rs"),
            "fn main() {\n    rusty_bends_build::write_nat_lemmas(\"verified\").unwrap();\n    rusty_bends_build::verify_and_emit(\"verified\");\n}\n",
        )
        .unwrap();
        fs::write(
            app.join("verified/ledger.bend"),
            r#"import Base
import nat_lemmas.bend as L

# Items held after two deliveries arrive.
def total_items(+a: Nat, +b: Nat) -> Nat:
  Nat.add(a, b)

# promise: the total never drops below the first delivery
law total_covers_first:
  for +a: Nat
  for +b: Nat
  {Nat.is_le(a, total_items(a, b)) == True{} : Bool}

def total_covers_first(a, b):
  L.nat_add_le_r(a, b)
"#,
        )
        .unwrap();
        fs::write(
            app.join("src/main.rs"),
            "mod verified {\n    include!(concat!(env!(\"OUT_DIR\"), \"/verified.rs\"));\n}\n\nfn main() {\n    println!(\"{}\", verified::total_items(2, 3));\n}\n",
        )
        .unwrap();

        let cargo_bin = env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
        let real_bend = resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        let run_cargo = || {
            let out = Command::new(&cargo_bin)
                .current_dir(&app)
                .args(["check", "--offline"])
                .env("CARGO_TARGET_DIR", app.join("target"))
                .env_remove("RUSTY_BENDS_NO_CACHE")
                .env_remove("RUSTY_BENDS_UPDATE_LAWS")
                .env_remove("RUSTY_BENDS_MUTATE")
                .env("BEND_VERDICT", "off")
                .env("BEND_BIN", &real_bend)
                .output()
                .expect("failed to invoke cargo check");
            assert!(
                out.status.success(),
                "cargo check --offline failed:\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        };

        run_cargo();
        let build_out_dir = app.join("target/debug/build");
        let verified_path = find_app_out_file(&build_out_dir, "verified.rs");
        let cache_path = find_app_out_file(&build_out_dir, "rusty-bends.cache");
        let before_rs = fs::read_to_string(&verified_path).unwrap();
        let before_first_line = before_rs.lines().next().unwrap_or("");
        assert!(
            before_first_line.starts_with("// @generated by rusty-bends-build v1")
                && !before_first_line.contains("NEW-EMITTER"),
            "unexpected initial header: {before_first_line}"
        );
        let cache_before = fs::read_to_string(&cache_path).unwrap();

        // Update only `rb/src/emit.rs`; the app's `.bend` files stay untouched.
        let emit_path = rb.join("src/emit.rs");
        let emit_src = fs::read_to_string(&emit_path).unwrap();
        let patched_emit = emit_src.replacen(
            "// @generated by rusty-bends-build v1 (Verified Core -> Pure Rust)",
            "// @generated by rusty-bends-build v1 (Verified Core -> Pure Rust) NEW-EMITTER",
            1,
        );
        assert_ne!(patched_emit, emit_src, "expected header literal in emit.rs");
        fs::write(&emit_path, patched_emit).unwrap();

        run_cargo();
        let after_rs = fs::read_to_string(&verified_path).unwrap();
        let after_first_line = after_rs.lines().next().unwrap_or("");
        assert!(
            after_first_line.contains("NEW-EMITTER"),
            "expected regenerated verified.rs after rb change, still got: {after_first_line}"
        );
        let cache_after = fs::read_to_string(&cache_path).unwrap();
        assert_ne!(
            cache_after, cache_before,
            "cache stamp must update with new builder hash"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
