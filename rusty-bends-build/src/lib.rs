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
pub mod law_test;
pub mod lock;
pub mod mutate;

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
    pub mutate_mode: MutateMode,
    pub list_laws: bool,
    /// `RUSTY_BENDS_LIST_PANICS=1`: print every checked-growth panic site as
    /// `function: op at file:line` (Issue #13).
    pub list_panics: bool,
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
            allow_lock_update: env::var("RUSTY_BENDS_UPDATE_LAWS").ok().as_deref() == Some("1"),
            emit_rust: true,
            mutate_mode,
            list_laws,
            list_panics,
        }
    }
}

/// Shared Bend 2 Nat arithmetic, order, and division lemma library (`nat_lemmas.bend`).
/// Every definition is a `q=0` proof/type helper and is completely erased before Rust codegen.
pub const NAT_LEMMAS_BEND: &str = include_str!("../lemmas/nat_lemmas.bend");

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

    // Record which laws were already locked before this build for failure diagnostics.
    let pre_locked_laws = lock::read_locked_law_names(&cfg.lock_file);

    // 1. Check AST/token-canonical LAWS lock (defer writing until Bend & mutation checks pass)
    let lock_report = lock::check_law_lock(&cfg.lock_file, &bend_files, cfg.allow_lock_update)?;
    let law_count = lock_report.current.len();

    for w in &lock_report.warnings {
        println!("cargo:warning={w}");
    }
    if cfg.list_laws {
        let listing = lock::format_law_list(&lock_report.current);
        for line in listing.lines() {
            println!("cargo:warning={line}");
        }
    }

    // 2. Check incremental content-hash cache for fast no-op rebuilds
    fs::create_dir_all(&cfg.out_dir).map_err(|e| e.to_string())?;
    let cache_file = cfg.out_dir.join("rusty-bends.cache");
    let verified_rs = cfg.out_dir.join("verified.rs");
    let combined_hash = hash_files(&bend_files)?;

    let cache_hit = fs::read_to_string(&cache_file)
        .map(|s| s.trim() == combined_hash)
        .unwrap_or(false);
    if cache_hit
        && (!cfg.emit_rust || verified_rs.exists())
        && !lock_report.needs_write
        && lock_report.new_names.is_empty()
        && cfg.mutate_mode == MutateMode::NewOnly
        && !cfg.list_panics
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

    for (file, text) in &file_sources {
        let is_laws_file = file
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case("LAWS.bend"))
            .unwrap_or(false);
        let has_laws = is_laws_file || !lock::extract_laws_from_source(text).is_empty();

        if let Err(err) = checker(file, has_laws) {
            let file_laws = law_test::parse_laws(text);
            if !file_laws.is_empty() {
                let target_names = match law_test::extract_failed_def_name(&err) {
                    Some(failed) if file_laws.iter().any(|l| l.name == failed) => vec![failed],
                    _ => file_laws.iter().map(|l| l.name.clone()).collect(),
                };
                if let Ok(outcomes) = law_test::evaluate_laws_for_counterexamples(
                    &combined_source,
                    &target_names,
                    &cfg.out_dir,
                ) {
                    let diagnosis =
                        law_test::format_counterexample_diagnosis(&outcomes, &pre_locked_laws);
                    if !diagnosis.is_empty() {
                        return Err(format!("{diagnosis}\n\n{err}"));
                    }
                }
            }
            return Err(err);
        }
    }

    // 4. Mutation-check every unlocked/new law before sealing (and report all locked laws under RUSTY_BENDS_MUTATE=all)
    let mut_summary = mutate::run_mutation_checks(
        &combined_source,
        &lock_report,
        cfg.mutate_mode,
        &cfg.out_dir,
    )?;
    for w in &mut_summary.warnings {
        println!("cargo:warning={w}");
    }

    // 5. Persist rusty-bends.lock only after Bend proofs and mutation checks succeed
    if lock_report.needs_write {
        lock::write_law_lock(&cfg.lock_file, &lock_report)?;
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
            println!("cargo:warning={line}");
        }
    }
    let emitted_path = match summary {
        Some(summary) if cfg.emit_rust => {
            fs::write(&verified_rs, summary.rust_source).map_err(|e| e.to_string())?;
            Some(verified_rs)
        }
        _ => None,
    };

    // 7. Persist passing content hash
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
            emit_rust: true,
            mutate_mode: MutateMode::NewOnly,
            list_laws: false,
            list_panics: false,
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
}
