//! Mutation testing gate for RustyBends laws (Issue #6).
//!
//! Before an unlocked/new law is accepted (and before `rusty-bends.lock` can be
//! created or updated), generates small mutants of every live `def` in the law's
//! transitive dependency cone and evaluates the law on concrete inputs using the
//! emitted Rust evaluator from `law_test`. If no mutant makes the law false, the
//! law is vacuous and fails the build with `[E_LAW_VACUOUS]`.
//!
//! `RUSTY_BENDS_MUTATE=all` additionally runs over already-locked laws and emits
//! one diagnostic line per law (`CAUGHT` or `SURVIVED`) without failing on them.
//!
//! A new law the checker cannot evaluate at all (unsupported clause, `exs`, a goal
//! without `==`) fails with `[E_LAW_UNCHECKED]` unless it carries an explicit
//! `# unchecked: <reason>` marker (Issue #14). Locked laws only warn.

use crate::emit::{
    collect_law_source_slices, emit_items_to_rust, leading_indent, parse_book_items,
    split_case_arm, split_last_additive, split_top_level, split_top_level_once, CtorInfo, Def,
    Quantity, TypeDef, TypeEnv,
};
use crate::law_test::{
    create_temp_eval_dir, emit_eval_law_checker, emit_pool_runtime_helpers, parse_laws, ParsedLaw,
};
use crate::lock::{self, LockCheckReport};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// Budget for the original operator families (selection order unchanged since Issue #6).
const MAX_MUTANTS_PER_LAW: usize = 48;
/// Separate budget for the bound-pushing operator families (Issue #12), shared round-robin
/// so every family is represented even when the legacy families fill their budget.
const MAX_BOUND_MUTANTS_PER_LAW: usize = 48;
/// Separate budget for the return-replacement and literal families (Issue #15), so adding
/// them never changes which bound-pushing mutants are selected.
const MAX_RETURN_LIT_MUTANTS_PER_LAW: usize = 32;
/// Separate budget for `Nat.add` <-> `Nat.max` / `Nat.min` swaps (Issue #20), so adding
/// them never shifts any existing operator family's selection.
const MAX_ADD_MAX_MIN_MUTANTS_PER_LAW: usize = 32;
/// At most this many `Nat` literal sites per function are mutated by `NatLit`.
const MAX_NAT_LIT_SITES_PER_DEF: usize = 8;
/// Version tag baked into mutation cone hashes so cache keys invalidate when mutators change.
const MUTATE_CACHE_VERSION: &str = "v4";
/// Maximum mutants packed into one compiled multi-law harness binary.
const BATCH_MAX_MUTANTS: usize = 160;
/// Maximum distinct laws packed into one compiled multi-law harness binary.
const BATCH_MAX_LAWS: usize = 16;

/// Law shapes the mutation checker (and the generated per-law tests) can evaluate.
const SUPPORTED_LAW_FORMS: &str = "Supported forms: zero or more 'for x: T' binders (T = Nat, Bool, U32/U64/I32/I64, a user ADT, List<T>, or a tuple of these), optional '{a == b : T} ->' hypotheses, and an equality goal '{lhs == rhs : T}'. Not supported: 'exs' (existential), 'where' refinements, goals without '=='.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutateMode {
    NewOnly,
    All,
    Report,
}

impl MutateMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "all" => Self::All,
            "report" => Self::Report,
            _ => Self::NewOnly,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mutant {
    pub operator: String,
    pub description: String,
    pub def_name: String,
    pub mutated_body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MutantStatus {
    Caught(String),
    Survived,
    BuildError(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutantOutcome {
    pub def_name: String,
    pub operator: String,
    pub description: String,
    pub status: MutantStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LawMutationReport {
    pub law_name: String,
    pub cone: Vec<String>,
    pub total_mutants: usize,
    pub generated_mutants: usize,
    pub dropped_by_budget: usize,
    pub dropped_by_site_cap: usize,
    pub caught_by: Option<(String, String)>,
    pub survived_operators: Vec<String>,
    pub mutant_outcomes: Vec<MutantOutcome>,
    pub skipped_reason: Option<String>,
    pub from_cache: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationRunSummary {
    pub reports: Vec<LawMutationReport>,
    pub warnings: Vec<String>,
    pub report_path: Option<PathBuf>,
}

struct PreparedLaw<'a> {
    law: &'a ParsedLaw,
    is_locked: bool,
    cone: Vec<String>,
    cone_key: String,
    cone_defs: Vec<Def>,
    generated: GeneratedMutants,
}

struct LawWorkItem<'a> {
    prepared_idx: usize,
    law: &'a ParsedLaw,
    is_locked: bool,
    cone_defs: &'a [Def],
    mutants: &'a [Mutant],
}

#[derive(Debug, Clone)]
enum EvaluatedLawResult {
    Complete {
        caught_by: Option<(String, String)>,
        outcomes: Vec<MutantOutcome>,
    },
    BuildFailed {
        error_message: String,
        outcomes: Vec<MutantOutcome>,
    },
}

fn sanitize_cache_field(s: &str) -> String {
    s.replace(['\t', '\n', '\r'], " ")
}

fn format_dropped_suffix(
    evaluated: usize,
    generated: usize,
    dropped_by_budget: usize,
    dropped_by_site_cap: usize,
) -> String {
    if dropped_by_budget + dropped_by_site_cap == 0 {
        return String::new();
    }
    let mut parts = Vec::new();
    if dropped_by_budget > 0 {
        parts.push(format!("{dropped_by_budget} dropped by budget"));
    }
    if dropped_by_site_cap > 0 {
        parts.push(format!("{dropped_by_site_cap} dropped by site cap"));
    }
    format!(" [evaluated {evaluated}/{generated}: {}]", parts.join(", "))
}

fn emit_law_build_warnings(law_name: &str, build_err: &str, warnings: &mut Vec<String>) {
    for line in build_err.lines() {
        warnings.push(format!("RustyBends mutate [{law_name}]: {line}"));
    }
}

/// Runs mutation checks according to `mode`:
/// - `NewOnly`: checks unlocked/new laws and fails with `[E_LAW_VACUOUS]` or `[E_LAW_UNCHECKED]`
///   when an unmarked new law fails to catch at least one mutant or cannot be evaluated.
/// - `All`: evaluates both new and locked laws and emits one diagnostic line per law.
/// - `Report`: evaluates every generated mutant of every checked law (new and locked), writes
///   the full report to `OUT_DIR/rusty-bends-mutants.txt`, and emits per-mutant lines.
pub fn run_mutation_checks(
    combined_source: &str,
    lock_report: &LockCheckReport,
    mode: MutateMode,
    out_dir: &Path,
) -> Result<MutationRunSummary, String> {
    let all_laws = parse_laws(combined_source);
    if all_laws.is_empty() {
        return Ok(MutationRunSummary {
            reports: Vec::new(),
            warnings: Vec::new(),
            report_path: None,
        });
    }

    let check_targets: Vec<&ParsedLaw> = all_laws
        .iter()
        .filter(|l| {
            lock_report.new_names.contains(&l.name)
                || (matches!(mode, MutateMode::All | MutateMode::Report)
                    && lock_report.locked_names.contains(&l.name))
        })
        .collect();

    if check_targets.is_empty() {
        return Ok(MutationRunSummary {
            reports: Vec::new(),
            warnings: Vec::new(),
            report_path: None,
        });
    }

    let (types, defs) = parse_book_items(combined_source)?;
    let extra_sources = collect_law_source_slices(&all_laws);
    let type_env = TypeEnv::build(&types, &defs, &extra_sources);
    let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
    let type_map: HashMap<String, &TypeDef> = types.iter().map(|t| (t.name.clone(), t)).collect();

    // Precompute call graph adjacency and structural fingerprints once across all laws.
    let def_callees = precompute_def_callees(&defs, &def_map);
    let types_hash = compute_types_hash(&types);
    let def_hashes = precompute_def_hashes(&defs);

    fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let cache_path = out_dir.join("rusty-bends-mutate.cache");
    let mut cache = load_mutate_cache(&cache_path);
    let mut cache_dirty = false;
    let full_report = mode == MutateMode::Report;

    let mut prepared: Vec<PreparedLaw<'_>> = Vec::with_capacity(check_targets.len());
    let mut report_slots: Vec<Option<LawMutationReport>> = vec![None; check_targets.len()];
    let mut build_errors: Vec<Option<String>> = vec![None; check_targets.len()];

    for law in &check_targets {
        let is_locked = lock_report.locked_names.contains(&law.name);
        let cone = law_dependency_cone_fast(law, &def_map, &def_callees);
        let cone_key = compute_cone_hash_fast(law, &cone, &types_hash, &def_hashes);
        let cone_defs: Vec<Def> = cone
            .iter()
            .filter_map(|name| def_map.get(name).map(|d| (*d).clone()))
            .collect();
        prepared.push(PreparedLaw {
            law,
            is_locked,
            cone,
            cone_key,
            cone_defs,
            generated: GeneratedMutants::default(),
        });
    }

    let mut pending_indices = Vec::new();
    for (idx, item) in prepared.iter_mut().enumerate() {
        if let Some(entry) = cache.get(&item.cone_key) {
            if let Some(cached_report) =
                report_from_cache(item, entry, full_report, &def_map, &type_env.ctor_map)
            {
                report_slots[idx] = Some(cached_report);
                continue;
            }
        }

        if let Some(ref reason) = item.law.unsupported_reason {
            let report = LawMutationReport {
                law_name: item.law.name.clone(),
                cone: item.cone.clone(),
                total_mutants: 0,
                generated_mutants: 0,
                dropped_by_budget: 0,
                dropped_by_site_cap: 0,
                caught_by: None,
                survived_operators: Vec::new(),
                mutant_outcomes: Vec::new(),
                skipped_reason: Some(reason.clone()),
                from_cache: false,
            };
            cache.insert(
                item.cone_key.clone(),
                cache_entry_from_report(&report, full_report),
            );
            cache_dirty = true;
            report_slots[idx] = Some(report);
            continue;
        }

        item.generated =
            generate_mutants_for_cone_with_stats(&item.cone_defs, &def_map, &type_env.ctor_map);
        if item.generated.mutants.is_empty() {
            let report = LawMutationReport {
                law_name: item.law.name.clone(),
                cone: item.cone.clone(),
                total_mutants: 0,
                generated_mutants: item.generated.generated_total,
                dropped_by_budget: item.generated.dropped_by_budget,
                dropped_by_site_cap: item.generated.dropped_by_site_cap,
                caught_by: None,
                survived_operators: Vec::new(),
                mutant_outcomes: Vec::new(),
                skipped_reason: None,
                from_cache: false,
            };
            cache.insert(
                item.cone_key.clone(),
                cache_entry_from_report(&report, full_report),
            );
            cache_dirty = true;
            report_slots[idx] = Some(report);
            continue;
        }

        if let Err(reason) = emit_eval_law_checker(
            "check", item.law, &defs, &def_map, &type_map, &type_env, true,
        ) {
            let report = LawMutationReport {
                law_name: item.law.name.clone(),
                cone: item.cone.clone(),
                total_mutants: item.generated.mutants.len(),
                generated_mutants: item.generated.generated_total,
                dropped_by_budget: item.generated.dropped_by_budget,
                dropped_by_site_cap: item.generated.dropped_by_site_cap,
                caught_by: None,
                survived_operators: Vec::new(),
                mutant_outcomes: Vec::new(),
                skipped_reason: Some(reason),
                from_cache: false,
            };
            cache.insert(
                item.cone_key.clone(),
                cache_entry_from_report(&report, full_report),
            );
            cache_dirty = true;
            report_slots[idx] = Some(report);
            continue;
        }

        pending_indices.push(idx);
    }

    if !pending_indices.is_empty() {
        let work_items: Vec<LawWorkItem<'_>> = pending_indices
            .iter()
            .map(|&idx| {
                let item = &prepared[idx];
                LawWorkItem {
                    prepared_idx: idx,
                    law: item.law,
                    is_locked: item.is_locked,
                    cone_defs: &item.cone_defs,
                    mutants: &item.generated.mutants,
                }
            })
            .collect();

        let eval_results = evaluate_work_items_batched(
            &work_items,
            &types,
            &type_map,
            &type_env,
            full_report,
            out_dir,
        )?;

        for (work, eval_res) in work_items.into_iter().zip(eval_results) {
            let item = &prepared[work.prepared_idx];
            let ops: Vec<String> = item
                .generated
                .mutants
                .iter()
                .map(|m| m.operator.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();

            match eval_res {
                EvaluatedLawResult::Complete {
                    caught_by,
                    outcomes,
                } => {
                    let report = LawMutationReport {
                        law_name: item.law.name.clone(),
                        cone: item.cone.clone(),
                        total_mutants: item.generated.mutants.len(),
                        generated_mutants: item.generated.generated_total,
                        dropped_by_budget: item.generated.dropped_by_budget,
                        dropped_by_site_cap: item.generated.dropped_by_site_cap,
                        caught_by,
                        survived_operators: ops,
                        mutant_outcomes: outcomes,
                        skipped_reason: None,
                        from_cache: false,
                    };
                    cache.insert(
                        item.cone_key.clone(),
                        cache_entry_from_report(&report, full_report),
                    );
                    cache_dirty = true;
                    report_slots[work.prepared_idx] = Some(report);
                }
                EvaluatedLawResult::BuildFailed {
                    error_message,
                    outcomes,
                } => {
                    let caught_by = outcomes.iter().find_map(|o| match &o.status {
                        MutantStatus::Caught(ce) => Some((o.description.clone(), ce.clone())),
                        _ => None,
                    });
                    let report = LawMutationReport {
                        law_name: item.law.name.clone(),
                        cone: item.cone.clone(),
                        total_mutants: item.generated.mutants.len(),
                        generated_mutants: item.generated.generated_total,
                        dropped_by_budget: item.generated.dropped_by_budget,
                        dropped_by_site_cap: item.generated.dropped_by_site_cap,
                        caught_by,
                        survived_operators: ops,
                        mutant_outcomes: outcomes,
                        skipped_reason: None,
                        from_cache: false,
                    };
                    build_errors[work.prepared_idx] = Some(error_message);
                    report_slots[work.prepared_idx] = Some(report);
                }
            }
        }
    }

    if cache_dirty {
        save_mutate_cache(&cache_path, &cache)?;
    }

    let reports: Vec<LawMutationReport> = report_slots
        .into_iter()
        .map(|slot| slot.expect("every target law has a mutation report"))
        .collect();
    let mut warnings = Vec::new();
    let mut report_path = None;

    if full_report {
        let report_file = out_dir.join("rusty-bends-mutants.txt");
        let mut all_lines = Vec::new();
        for report in &reports {
            all_lines.extend(format_full_law_report(report));
        }
        let caught_laws = reports
            .iter()
            .filter(|r| r.skipped_reason.is_none() && r.caught_by.is_some())
            .count();
        let survived_laws = reports
            .iter()
            .filter(|r| r.skipped_reason.is_none() && r.caught_by.is_none())
            .count();
        let skipped_laws = reports
            .iter()
            .filter(|r| r.skipped_reason.is_some())
            .count();
        all_lines.push(format!(
            "Summary: {} law(s), {caught_laws} caught, {survived_laws} survived, {skipped_laws} skipped",
            reports.len()
        ));
        fs::write(&report_file, format!("{}\n", all_lines.join("\n")))
            .map_err(|e| e.to_string())?;
        warnings.push(format!(
            "RustyBends mutate report written to {}",
            report_file.display()
        ));
        warnings.extend(all_lines);
        report_path = Some(report_file);
    }

    for (idx, report) in reports.iter().enumerate() {
        let is_locked = prepared[idx].is_locked;
        if let Some(ref build_err) = build_errors[idx] {
            if is_locked {
                emit_law_build_warnings(&report.law_name, build_err, &mut warnings);
                continue;
            }
            return Err(build_err.clone());
        }

        let unchecked_marker = lock_report
            .current
            .get(&report.law_name)
            .and_then(|l| l.unchecked.as_deref());

        if !is_locked {
            if let Some(ref reason) = report.skipped_reason {
                match unchecked_marker {
                    Some(marker) => warnings.push(format!(
                        "RustyBends mutate [{}]: UNCHECKED ({reason}); accepted by '# unchecked: {marker}'",
                        report.law_name
                    )),
                    None => {
                        return Err(format!(
                            "[E_LAW_UNCHECKED] New law '{}' cannot be mutation-checked: {reason}.\nHint: {SUPPORTED_LAW_FORMS}\nRewrite '{}' in a supported form, or, if it truly cannot be evaluated, add '# unchecked: <why>' directly above 'law {}:' so reviewers see the exemption (it is stored in rusty-bends.lock and shown by RUSTY_BENDS_LIST_LAWS=1).",
                            report.law_name, report.law_name, report.law_name
                        ));
                    }
                }
            } else if report.caught_by.is_none() {
                let cone_str = if report.cone.is_empty() {
                    "none".to_string()
                } else {
                    report.cone.join(", ")
                };
                let ops_str = if report.survived_operators.is_empty() {
                    "none (law references no live verified functions)".to_string()
                } else {
                    report.survived_operators.join(", ")
                };
                let dropped = format_dropped_suffix(
                    report.total_mutants,
                    report.generated_mutants,
                    report.dropped_by_budget,
                    report.dropped_by_site_cap,
                );
                return Err(format!(
                    "[E_LAW_VACUOUS] Law '{}' is vacuous: it caught 0 mutants across [{cone_str}] (survived {} mutants: {ops_str}){dropped}.\nHint: Strengthen '{}' so it fails when its target function is broken.",
                    report.law_name, report.total_mutants, report.law_name
                ));
            } else if let Some(marker) = unchecked_marker {
                warnings.push(format!(
                    "RustyBends mutate [{}]: '# unchecked: {marker}' is unnecessary; the law is mutation-checkable, so remove the marker.",
                    report.law_name
                ));
            }
        }

        if mode == MutateMode::All
            && (is_locked || (report.skipped_reason.is_none() && report.caught_by.is_some()))
        {
            warnings.push(format_locked_law_line(report));
        }
    }

    Ok(MutationRunSummary {
        reports,
        warnings,
        report_path,
    })
}

pub fn format_locked_law_line(report: &LawMutationReport) -> String {
    let cached_tag = if report.from_cache { " [cached]" } else { "" };
    let dropped_tag = format_dropped_suffix(
        report.total_mutants,
        report.generated_mutants,
        report.dropped_by_budget,
        report.dropped_by_site_cap,
    );
    if let Some((ref desc, ref ce)) = report.caught_by {
        format!(
            "RustyBends mutate [{}]: caught by {desc} ({ce}){dropped_tag}{cached_tag}",
            report.law_name
        )
    } else if let Some(ref reason) = report.skipped_reason {
        format!(
            "RustyBends mutate [{}]: skipped ({reason}){cached_tag}",
            report.law_name
        )
    } else {
        let ops = if report.survived_operators.is_empty() {
            "none".to_string()
        } else {
            report.survived_operators.join(", ")
        };
        format!(
            "RustyBends mutate [{}]: SURVIVED ({} mutants: {ops}){dropped_tag}{cached_tag}",
            report.law_name, report.total_mutants
        )
    }
}

pub fn format_full_law_report(report: &LawMutationReport) -> Vec<String> {
    let cached_tag = if report.from_cache { " [cached]" } else { "" };
    let dropped_tag = format_dropped_suffix(
        report.total_mutants,
        report.generated_mutants,
        report.dropped_by_budget,
        report.dropped_by_site_cap,
    );
    if let Some(ref reason) = report.skipped_reason {
        return vec![format!(
            "RustyBends mutate [{}]: skipped ({reason}){cached_tag}",
            report.law_name
        )];
    }
    let caught_count = report
        .mutant_outcomes
        .iter()
        .filter(|o| matches!(o.status, MutantStatus::Caught(_)))
        .count();
    let survived_count = report
        .mutant_outcomes
        .iter()
        .filter(|o| matches!(o.status, MutantStatus::Survived))
        .count();
    let err_count = report
        .mutant_outcomes
        .iter()
        .filter(|o| matches!(o.status, MutantStatus::BuildError(_)))
        .count();
    let err_part = if err_count > 0 {
        format!(", {err_count} build-error")
    } else {
        String::new()
    };
    let mut lines = vec![format!(
        "RustyBends mutate [{}]: {caught_count}/{} caught, {survived_count} survived{err_part}{dropped_tag}{cached_tag}",
        report.law_name, report.total_mutants
    )];
    for o in &report.mutant_outcomes {
        match &o.status {
            MutantStatus::Caught(ce) => {
                lines.push(format!("  caught   {} ({ce})", o.description));
            }
            MutantStatus::Survived => {
                lines.push(format!("  survived {}", o.description));
            }
            MutantStatus::BuildError(err) => {
                lines.push(format!("  build-error {} ({err})", o.description));
            }
        }
    }
    lines
}

fn evaluate_work_items_batched(
    work_items: &[LawWorkItem<'_>],
    types: &[TypeDef],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    full_report: bool,
    out_dir: &Path,
) -> Result<Vec<EvaluatedLawResult>, String> {
    let mut batches: Vec<&[LawWorkItem<'_>]> = Vec::new();
    let mut start = 0usize;
    while start < work_items.len() {
        let mut end = start;
        let mut mut_count = 0usize;
        while end < work_items.len() && (end - start) < BATCH_MAX_LAWS {
            let next_m = work_items[end].mutants.len();
            if end > start && mut_count + next_m > BATCH_MAX_MUTANTS {
                break;
            }
            mut_count += next_m;
            end += 1;
        }
        batches.push(&work_items[start..end]);
        start = end;
    }

    if batches.len() <= 1 {
        let mut out = Vec::with_capacity(work_items.len());
        for batch in batches {
            out.extend(run_batch_with_fallback(
                batch,
                types,
                type_map,
                type_env,
                full_report,
                out_dir,
            )?);
        }
        return Ok(out);
    }

    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .clamp(1, 8)
        .min(batches.len());
    let next_batch = AtomicUsize::new(0);
    type BatchSlot = Option<Result<Vec<EvaluatedLawResult>, String>>;
    let results: Mutex<Vec<BatchSlot>> = Mutex::new(vec![None; batches.len()]);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let bi = next_batch.fetch_add(1, Ordering::Relaxed);
                if bi >= batches.len() {
                    break;
                }
                let res = run_batch_with_fallback(
                    batches[bi],
                    types,
                    type_map,
                    type_env,
                    full_report,
                    out_dir,
                );
                let mut guard = results.lock().expect("batch results mutex");
                guard[bi] = Some(res);
            });
        }
    });

    let mut out = Vec::with_capacity(work_items.len());
    let slots = results.into_inner().expect("batch results mutex");
    for slot in slots {
        out.extend(slot.expect("every batch completed")?);
    }
    Ok(out)
}

fn run_batch_with_fallback(
    batch: &[LawWorkItem<'_>],
    types: &[TypeDef],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    full_report: bool,
    out_dir: &Path,
) -> Result<Vec<EvaluatedLawResult>, String> {
    match run_batch_harness(batch, types, type_map, type_env, full_report, out_dir) {
        Ok(res) => Ok(res),
        Err(_) if batch.len() > 1 => {
            let mut out = Vec::with_capacity(batch.len());
            for item in batch {
                out.push(run_single_law_per_mutant_fallback(
                    item,
                    types,
                    type_map,
                    type_env,
                    full_report,
                    out_dir,
                ));
            }
            Ok(out)
        }
        Err(_) => Ok(vec![run_single_law_per_mutant_fallback(
            &batch[0],
            types,
            type_map,
            type_env,
            full_report,
            out_dir,
        )]),
    }
}

fn run_single_law_per_mutant_fallback(
    item: &LawWorkItem<'_>,
    types: &[TypeDef],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    full_report: bool,
    out_dir: &Path,
) -> EvaluatedLawResult {
    // First try the single law as a batch (when coming from a failed multi-law batch).
    if let Ok(mut single) = run_batch_harness(
        std::slice::from_ref(item),
        types,
        type_map,
        type_env,
        full_report,
        out_dir,
    ) {
        if let Some(res) = single.pop() {
            return res;
        }
    }

    let mut outcomes = Vec::with_capacity(item.mutants.len());
    let mut build_failures: Vec<(String, String)> = Vec::new();
    for m in item.mutants {
        let single_item = LawWorkItem {
            prepared_idx: item.prepared_idx,
            law: item.law,
            is_locked: item.is_locked,
            cone_defs: item.cone_defs,
            mutants: std::slice::from_ref(m),
        };
        match run_batch_harness(
            &[single_item],
            types,
            type_map,
            type_env,
            full_report,
            out_dir,
        ) {
            Ok(mut res) => {
                if let Some(EvaluatedLawResult::Complete {
                    caught_by,
                    outcomes: mut sub_outcomes,
                }) = res.pop()
                {
                    if !full_report {
                        if let Some(hit) = caught_by {
                            return EvaluatedLawResult::Complete {
                                caught_by: Some(hit),
                                outcomes: Vec::new(),
                            };
                        }
                    } else if let Some(first) = sub_outcomes.pop() {
                        outcomes.push(first);
                    }
                }
            }
            Err(HarnessError::Run) => {
                if full_report {
                    outcomes.push(MutantOutcome {
                        def_name: m.def_name.clone(),
                        operator: m.operator.clone(),
                        description: m.description.clone(),
                        status: MutantStatus::Survived,
                    });
                }
            }
            Err(HarnessError::Compile(stderr)) => {
                let first_error = first_rustc_error(&stderr);
                build_failures.push((m.description.clone(), first_error.clone()));
                if full_report {
                    outcomes.push(MutantOutcome {
                        def_name: m.def_name.clone(),
                        operator: m.operator.clone(),
                        description: m.description.clone(),
                        status: MutantStatus::BuildError(first_error),
                    });
                }
            }
        }
    }

    if let Some((desc, first_error)) = build_failures.first() {
        let msg = format!(
            "[E_MUTANT_BUILD] Law '{}': {} of {} mutants did not compile, so the law could not be mutation-checked. This is a RustyBends bug, not a problem with the law; please report it.\nFirst failing mutant: {desc}\nrustc: {first_error}",
            item.law.name,
            build_failures.len(),
            item.mutants.len()
        );
        return EvaluatedLawResult::BuildFailed {
            error_message: msg,
            outcomes,
        };
    }

    let caught_by = outcomes.iter().find_map(|o| match &o.status {
        MutantStatus::Caught(ce) => Some((o.description.clone(), ce.clone())),
        _ => None,
    });
    EvaluatedLawResult::Complete {
        caught_by,
        outcomes,
    }
}

fn first_rustc_error(stderr: &str) -> String {
    stderr
        .lines()
        .find(|l| l.trim_start().starts_with("error"))
        .unwrap_or("(no rustc error line)")
        .trim()
        .to_string()
}

#[cfg(test)]
fn evaluate_mutants_batch(
    law: &ParsedLaw,
    mutants: &[Mutant],
    types: &[TypeDef],
    cone_defs: &[Def],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    out_dir: &Path,
) -> Result<Option<(String, String)>, String> {
    let item = LawWorkItem {
        prepared_idx: 0,
        law,
        is_locked: false,
        cone_defs,
        mutants,
    };
    match run_single_law_per_mutant_fallback(&item, types, type_map, type_env, false, out_dir) {
        EvaluatedLawResult::Complete { caught_by, .. } => Ok(caught_by),
        EvaluatedLawResult::BuildFailed { error_message, .. } => Err(error_message),
    }
}

#[cfg(test)]
fn run_mutant_harness(
    law: &ParsedLaw,
    mutants: &[Mutant],
    types: &[TypeDef],
    cone_defs: &[Def],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    out_dir: &Path,
) -> Result<Option<(String, String)>, HarnessError> {
    let item = LawWorkItem {
        prepared_idx: 0,
        law,
        is_locked: false,
        cone_defs,
        mutants,
    };
    let res = run_batch_harness(&[item], types, type_map, type_env, false, out_dir)?;
    match res.into_iter().next() {
        Some(EvaluatedLawResult::Complete { caught_by, .. }) => Ok(caught_by),
        _ => Ok(None),
    }
}

/// Why a mutant harness produced no verdict.
enum HarnessError {
    /// rustc rejected the generated program (carries its stderr).
    Compile(String),
    /// Anything else: emitting, writing, launching or running the program. A mutant
    /// that crashes its binary is treated as not caught, as before.
    Run,
}

impl From<String> for HarnessError {
    fn from(_: String) -> Self {
        HarnessError::Run
    }
}

fn run_batch_harness(
    batch: &[LawWorkItem<'_>],
    types: &[TypeDef],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    full_report: bool,
    out_dir: &Path,
) -> Result<Vec<EvaluatedLawResult>, HarnessError> {
    let mut program = String::new();
    program.push_str("#![allow(clippy::all, non_snake_case, unused_variables, unused_parens, dead_code, unused_mut)]\n");

    let types_only = emit_items_to_rust(types, &[], type_env, 0, None, true)?;
    program.push_str(&types_only.rust_source);
    program.push('\n');
    program.push_str(&emit_pool_runtime_helpers(types, type_map, type_env, true));
    program.push('\n');

    let mut per_law_active: Vec<Vec<usize>> = Vec::with_capacity(batch.len());
    let mut per_law_emit_errors: Vec<Vec<Option<String>>> = batch
        .iter()
        .map(|item| vec![None; item.mutants.len()])
        .collect();
    let mut any_active = false;

    for (bi, item) in batch.iter().enumerate() {
        let mut active_indices = Vec::new();
        for (mi, mutant) in item.mutants.iter().enumerate() {
            let mut mut_defs = item.cone_defs.to_vec();
            for d in &mut mut_defs {
                if d.name == mutant.def_name {
                    d.body = mutant.mutated_body.clone();
                }
            }
            let defs_rs = match emit_items_to_rust(&[], &mut_defs, type_env, 0, Some(10_000), false)
            {
                Ok(v) => v,
                Err(err) => {
                    per_law_emit_errors[bi][mi] = Some(err);
                    continue;
                }
            };
            let mut_def_map: HashMap<String, &Def> =
                mut_defs.iter().map(|d| (d.name.clone(), d)).collect();
            let check_fn = match emit_eval_law_checker(
                "check",
                item.law,
                &mut_defs,
                &mut_def_map,
                type_map,
                type_env,
                true,
            ) {
                Ok(v) => v,
                Err(err) => {
                    per_law_emit_errors[bi][mi] = Some(err);
                    continue;
                }
            };
            program.push_str(&format!("mod l_{bi}_m_{mi} {{\n    use super::*;\n"));
            for line in defs_rs.rust_source.lines() {
                program.push_str("    ");
                program.push_str(line);
                program.push('\n');
            }
            for line in check_fn.lines() {
                program.push_str("    ");
                program.push_str(line);
                program.push('\n');
            }
            program.push_str("}\n\n");
            active_indices.push(mi);
            any_active = true;
        }
        per_law_active.push(active_indices);
    }

    if !any_active {
        return Ok(batch
            .iter()
            .map(|item| EvaluatedLawResult::Complete {
                caught_by: None,
                outcomes: if full_report {
                    item.mutants
                        .iter()
                        .map(|m| MutantOutcome {
                            def_name: m.def_name.clone(),
                            operator: m.operator.clone(),
                            description: m.description.clone(),
                            status: MutantStatus::Survived,
                        })
                        .collect()
                } else {
                    Vec::new()
                },
            })
            .collect());
    }

    for (bi, active_indices) in per_law_active.iter().enumerate() {
        program.push_str(&format!("fn __rb_run_batch_law_{bi}() {{\n"));
        for &mi in active_indices {
            if full_report {
                program.push_str(&format!(
                    "    match l_{bi}_m_{mi}::check() {{\n        Some(ce) => println!(\"CAUGHT\\t{bi}\\t{mi}\\t{{}}\", ce.replace(['\\n', '\\r', '\\t'], \" \")),\n        None => println!(\"SURVIVED\\t{bi}\\t{mi}\"),\n    }}\n"
                ));
            } else {
                program.push_str(&format!(
                    "    if let Some(ce) = l_{bi}_m_{mi}::check() {{ println!(\"CAUGHT\\t{bi}\\t{mi}\\t{{}}\", ce.replace(['\\n', '\\r', '\\t'], \" \")); return; }}\n"
                ));
            }
        }
        program.push_str("}\n\n");
    }

    program.push_str("fn main() {\n");
    for bi in 0..batch.len() {
        program.push_str(&format!("    __rb_run_batch_law_{bi}();\n"));
    }
    program.push_str("}\n");

    let eval_dir = create_temp_eval_dir(out_dir, "mut")?;
    let rs_path = eval_dir.0.join("mutate.rs");
    let bin_path = eval_dir.0.join("mutate_bin");
    fs::write(&rs_path, program).map_err(|_| HarnessError::Run)?;

    let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
    let compile = Command::new(&rustc)
        .args(["--edition", "2021", "-A", "warnings", "-o"])
        .arg(&bin_path)
        .arg(&rs_path)
        .output()
        .map_err(|e| format!("failed to invoke '{rustc}' for mutation testing: {e}"))?;
    if !compile.status.success() {
        return Err(HarnessError::Compile(
            String::from_utf8_lossy(&compile.stderr).into_owned(),
        ));
    }

    let run = Command::new(&bin_path)
        .output()
        .map_err(|e| format!("failed to run mutant binary: {e}"))?;
    if !run.status.success() {
        return Err(HarnessError::Run);
    }

    let mut per_law_caught: Vec<Option<(String, String)>> = vec![None; batch.len()];
    let mut per_law_statuses: Vec<Vec<Option<MutantStatus>>> = batch
        .iter()
        .map(|item| vec![None; item.mutants.len()])
        .collect();

    let stdout = String::from_utf8_lossy(&run.stdout);
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("CAUGHT\t") {
            let mut parts = rest.splitn(3, '\t');
            if let (Some(bi_str), Some(mi_str), Some(ce)) =
                (parts.next(), parts.next(), parts.next())
            {
                if let (Ok(bi), Ok(mi)) = (bi_str.parse::<usize>(), mi_str.parse::<usize>()) {
                    if let Some(item) = batch.get(bi) {
                        if let Some(m) = item.mutants.get(mi) {
                            let ce_clean = ce.trim().to_string();
                            if per_law_caught[bi].is_none() {
                                per_law_caught[bi] =
                                    Some((m.description.clone(), ce_clean.clone()));
                            }
                            if full_report {
                                per_law_statuses[bi][mi] = Some(MutantStatus::Caught(ce_clean));
                            }
                        }
                    }
                }
            }
        } else if full_report {
            if let Some(rest) = line.strip_prefix("SURVIVED\t") {
                if let Some((bi_str, mi_str)) = rest.split_once('\t') {
                    if let (Ok(bi), Ok(mi)) = (bi_str.parse::<usize>(), mi_str.parse::<usize>()) {
                        if let Some(statuses) = per_law_statuses.get_mut(bi) {
                            if mi < statuses.len() {
                                statuses[mi] = Some(MutantStatus::Survived);
                            }
                        }
                    }
                }
            }
        }
    }

    let mut results = Vec::with_capacity(batch.len());
    for (bi, item) in batch.iter().enumerate() {
        let outcomes = if full_report {
            item.mutants
                .iter()
                .enumerate()
                .map(|(mi, m)| MutantOutcome {
                    def_name: m.def_name.clone(),
                    operator: m.operator.clone(),
                    description: m.description.clone(),
                    status: per_law_statuses[bi][mi].clone().unwrap_or_else(|| {
                        if let Some(ref err) = per_law_emit_errors[bi][mi] {
                            MutantStatus::BuildError(err.clone())
                        } else {
                            MutantStatus::Survived
                        }
                    }),
                })
                .collect()
        } else {
            Vec::new()
        };
        results.push(EvaluatedLawResult::Complete {
            caught_by: per_law_caught[bi].take(),
            outcomes,
        });
    }
    Ok(results)
}

/// A candidate mutant before selection: `(def, mutated body, description)`.
type Candidate<'a> = (&'a Def, String, String);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct GeneratedMutants {
    pub mutants: Vec<Mutant>,
    pub generated_total: usize,
    pub dropped_by_budget: usize,
    pub dropped_by_site_cap: usize,
}

fn record_dropped(
    def: &Def,
    body: &str,
    seen: &HashSet<(String, String)>,
    dropped_seen: &mut HashSet<(String, String)>,
    dropped_by_budget: &mut usize,
) {
    let trimmed = body.trim().to_string();
    let key = (def.name.clone(), trimmed);
    if key.1 != def.body.trim() && !seen.contains(&key) && dropped_seen.insert(key) {
        *dropped_by_budget += 1;
    }
}

/// Generates small syntactic mutants for all live `Def`s in a law's dependency cone.
///
/// Legacy families (BoolFlip, NatCmpArith, DropBoolOperand, ReturnUnchanged, SwapMatchArms)
/// fill the first `MAX_MUTANTS_PER_LAW` slots in their original order. The bound-pushing
/// families (NatBound, SiblingCtor, BoolConst, FlipCmp) then take up to
/// `MAX_BOUND_MUTANTS_PER_LAW` more slots, round-robin across families. Finally ReturnCtor
/// and NatLit take up to `MAX_RETURN_LIT_MUTANTS_PER_LAW` slots, round-robin. Each mutant's
/// description ends with `[<Operator>]` so reports name the operator that caught a law.
#[cfg(test)]
pub(crate) fn generate_mutants_for_cone(
    cone_defs: &[Def],
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
) -> Vec<Mutant> {
    generate_mutants_for_cone_with_stats(cone_defs, def_map, ctor_map).mutants
}

pub(crate) fn generate_mutants_for_cone_with_stats(
    cone_defs: &[Def],
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
) -> GeneratedMutants {
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut dropped_seen: HashSet<(String, String)> = HashSet::new();
    let mut dropped_by_budget = 0usize;
    let mut dropped_by_site_cap = 0usize;

    let mut mutants = Vec::new();
    for def in cone_defs {
        let protected = compute_protected_ranges(&def.body);
        let legacy: Vec<(&str, Vec<(String, String)>)> = vec![
            // 1. Bool flip: True{} <-> False{}, true <-> false, Bool.pick branch swap
            ("BoolFlip", mutate_bool_flips(&def.body, &protected)),
            // 2. Nat comparison & arithmetic swaps
            ("NatCmpArith", mutate_nat_ops(&def.body, &protected)),
            // 3. Drop one operand of Bool.and / Bool.or / && / ||
            (
                "DropBoolOperand",
                mutate_drop_bool_operand(&def.body, &protected),
            ),
            // 4. Return parameter or matched constructor unchanged
            ("ReturnUnchanged", mutate_return_unchanged(def, ctor_map)),
            // 5. Swap two match arms with compatible binders
            (
                "SwapMatchArms",
                mutate_swap_match_arms(def, def_map, ctor_map),
            ),
        ];
        for (op, candidates) in legacy {
            for (body, desc) in candidates {
                if mutants.len() >= MAX_MUTANTS_PER_LAW {
                    record_dropped(def, &body, &seen, &mut dropped_seen, &mut dropped_by_budget);
                    continue;
                }
                if let Some(m) = make_mutant(op, desc, def, body, &mut seen) {
                    mutants.push(m);
                }
            }
        }
    }

    // Bound-pushing families (Issue #12): collected per family, then picked round-robin.
    let mut families: Vec<(&str, Vec<Candidate<'_>>)> = vec![
        ("NatBound", Vec::new()),
        ("SiblingCtor", Vec::new()),
        ("BoolConst", Vec::new()),
        ("FlipCmp", Vec::new()),
    ];
    for def in cone_defs {
        let protected = compute_protected_ranges(&def.body);
        for (body, desc) in mutate_nat_bound(def) {
            families[0].1.push((def, body, desc));
        }
        for (body, desc) in mutate_sibling_ctor(def, ctor_map, &protected) {
            families[1].1.push((def, body, desc));
        }
        for (body, desc) in mutate_bool_const(def, def_map, ctor_map, &protected) {
            families[2].1.push((def, body, desc));
        }
        for (body, desc) in mutate_flip_cmp(&def.body, &protected) {
            families[3].1.push((def, body, desc));
        }
    }
    pick_round_robin_with_stats(
        &families,
        MAX_BOUND_MUTANTS_PER_LAW,
        &mut seen,
        &mut dropped_seen,
        &mut dropped_by_budget,
        &mut mutants,
    );

    // Return-replacement and literal families (Issue #15), with their own budget.
    let mut families: Vec<(&str, Vec<Candidate<'_>>)> =
        vec![("ReturnCtor", Vec::new()), ("NatLit", Vec::new())];
    for def in cone_defs {
        let protected = compute_protected_ranges(&def.body);
        for (body, desc) in mutate_return_ctor(def, def_map, ctor_map) {
            families[0].1.push((def, body, desc));
        }
        let (lit_mutants, site_dropped) = mutate_nat_lit_with_stats(&def.body, &protected);
        dropped_by_site_cap += site_dropped;
        for (body, desc) in lit_mutants {
            families[1].1.push((def, body, desc));
        }
    }
    pick_round_robin_with_stats(
        &families,
        MAX_RETURN_LIT_MUTANTS_PER_LAW,
        &mut seen,
        &mut dropped_seen,
        &mut dropped_by_budget,
        &mut mutants,
    );

    // `Nat.add` <-> `Nat.max` / `Nat.min` (Issue #20), with its own budget.
    let mut families: Vec<(&str, Vec<Candidate<'_>>)> = vec![("NatAddMaxMin", Vec::new())];
    for def in cone_defs {
        let protected = compute_protected_ranges(&def.body);
        for (body, desc) in mutate_nat_add_max_min(&def.body, &protected) {
            families[0].1.push((def, body, desc));
        }
    }
    pick_round_robin_with_stats(
        &families,
        MAX_ADD_MAX_MIN_MUTANTS_PER_LAW,
        &mut seen,
        &mut dropped_seen,
        &mut dropped_by_budget,
        &mut mutants,
    );

    let generated_total = mutants.len() + dropped_by_budget + dropped_by_site_cap;
    GeneratedMutants {
        mutants,
        generated_total,
        dropped_by_budget,
        dropped_by_site_cap,
    }
}

fn make_mutant(
    operator: &str,
    desc: String,
    def: &Def,
    body: String,
    seen: &mut HashSet<(String, String)>,
) -> Option<Mutant> {
    let trimmed = body.trim().to_string();
    if trimmed == def.body.trim() || !seen.insert((def.name.clone(), trimmed)) {
        return None;
    }
    Some(Mutant {
        operator: operator.to_string(),
        description: format!("{}: {desc} [{operator}]", def.name),
        def_name: def.name.clone(),
        mutated_body: body,
    })
}

/// Appends up to `cap` mutants from `families`, taking one per family in turn so every family
/// is represented. Candidates rejected by `make_mutant` (unchanged or duplicate bodies) are
/// skipped; unique candidates left over after `cap` is reached are counted in `dropped_by_budget`.
fn pick_round_robin_with_stats(
    families: &[(&str, Vec<Candidate<'_>>)],
    cap: usize,
    seen: &mut HashSet<(String, String)>,
    dropped_seen: &mut HashSet<(String, String)>,
    dropped_by_budget: &mut usize,
    mutants: &mut Vec<Mutant>,
) {
    let mut cursors = vec![0usize; families.len()];
    let mut taken = 0usize;
    while taken < cap {
        let mut progressed = false;
        for (fi, (op, items)) in families.iter().enumerate() {
            if taken >= cap {
                break;
            }
            while cursors[fi] < items.len() {
                let (def, body, desc) = &items[cursors[fi]];
                cursors[fi] += 1;
                if let Some(m) = make_mutant(op, desc.clone(), def, body.clone(), seen) {
                    mutants.push(m);
                    taken += 1;
                    progressed = true;
                    break;
                }
            }
        }
        if !progressed {
            break;
        }
    }
    for (fi, (_, items)) in families.iter().enumerate() {
        for (def, body, _) in &items[cursors[fi]..] {
            record_dropped(def, body, seen, dropped_seen, dropped_by_budget);
        }
    }
}

/// NatAddMaxMin: swaps `Nat.add` with `Nat.max` / `Nat.min` (including parenthesized infix
/// `(lhs + rhs : Nat)`), and swaps `Nat.max` / `Nat.min` with `Nat.add`, so bound laws that
/// would hold if a sum were replaced by a maximum are exposed as survivors unless a lower-bound
/// law distinguishes them (Issue #20).
fn mutate_nat_add_max_min(body: &str, protected: &[(usize, usize)]) -> Vec<(String, String)> {
    let fn_swaps: &[(&str, &[&str])] = &[
        ("Nat.add", &["Nat.max", "Nat.min"]),
        ("Nat.max", &["Nat.add"]),
        ("Nat.min", &["Nat.add"]),
    ];
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if in_protected(i, protected) {
            i += 1;
            continue;
        }
        let prev_ident = i > 0
            && (bytes[i - 1].is_ascii_alphanumeric()
                || bytes[i - 1] == b'_'
                || bytes[i - 1] == b'.');
        if !prev_ident {
            let mut matched = false;
            for &(from, tos) in fn_swaps {
                if body[i..].starts_with(from) {
                    let end = i + from.len();
                    let next_ok = end == bytes.len()
                        || (!bytes[end].is_ascii_alphanumeric()
                            && bytes[end] != b'_'
                            && bytes[end] != b'.');
                    if next_ok {
                        for &to in tos {
                            out.push((replace_span(body, i, end, to), format!("{from} -> {to}")));
                        }
                        i = end;
                        matched = true;
                        break;
                    }
                }
            }
            if matched {
                continue;
            }
        }
        if bytes[i] == b'(' {
            if let Some(close_rel) = find_matching_paren(&body[i..]) {
                let close_abs = i + close_rel;
                let inner = body[i + 1..close_abs].trim();
                if split_top_level(inner, ',').len() == 1 {
                    if let Some((term_part, ty_part)) = split_top_level_once(inner, ':') {
                        if ty_part.trim() == "Nat" {
                            if let Some(('+', lhs, rhs)) = split_last_additive(term_part.trim()) {
                                if !lhs.is_empty() && !rhs.is_empty() {
                                    out.push((
                                        replace_span(
                                            body,
                                            i,
                                            close_abs + 1,
                                            &format!("Nat.max({lhs}, {rhs})"),
                                        ),
                                        "(+ : Nat) -> Nat.max".to_string(),
                                    ));
                                    out.push((
                                        replace_span(
                                            body,
                                            i,
                                            close_abs + 1,
                                            &format!("Nat.min({lhs}, {rhs})"),
                                        ),
                                        "(+ : Nat) -> Nat.min".to_string(),
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }
        i += 1;
    }
    out
}

/// Re-indents `body` by four spaces under `let __rb_r =` and returns `<wrap>` applied to the
/// bound result. The emitter lowers this as a block `{ let __rb_r = <body>; <wrap> }`.
fn wrap_result(body: &str, wrap: &str) -> String {
    let mut out = String::from("let __rb_r =\n");
    for line in body.lines() {
        if line.trim().is_empty() {
            continue;
        }
        out.push_str("    ");
        out.push_str(line);
        out.push('\n');
    }
    out.push_str(wrap);
    out
}

/// NatBound: pushes a `Nat` result past a bound (`+ 1`, `- 1`, or `0n`) so one-direction
/// bound laws such as `Nat.is_le(f(l), l) == True{}` are caught.
fn mutate_nat_bound(def: &Def) -> Vec<(String, String)> {
    if def.ret.trim() != "Nat" {
        return Vec::new();
    }
    vec![
        (
            wrap_result(&def.body, "Nat.add(__rb_r, 1n)"),
            "result -> Nat.add(result, 1n)".to_string(),
        ),
        (
            wrap_result(&def.body, "Nat.sub(__rb_r, 1n)"),
            "result -> Nat.sub(result, 1n)".to_string(),
        ),
        ("0n".to_string(), "result -> 0n".to_string()),
    ]
}

/// Small filler value for a constructor field of type `ty`, used when a sibling constructor's
/// fields differ from the original's.
fn filler_value(ty: &str, ctor_map: &HashMap<String, CtorInfo>) -> Option<String> {
    match ty.trim() {
        "Nat" => Some("0n".to_string()),
        "Bool" => Some("False{}".to_string()),
        other => {
            let mut nullary: Vec<&CtorInfo> = ctor_map
                .values()
                .filter(|c| c.type_name == other && c.arity == 0)
                .collect();
            nullary.sort_by(|a, b| a.variant_name.cmp(&b.variant_name));
            nullary
                .first()
                .map(|c| format!("{}.{}{{}}", c.type_name, c.variant_name))
        }
    }
}

fn find_matching_brace(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    for (idx, ch) in s.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(idx);
                }
            }
            _ => {}
        }
    }
    None
}

/// SiblingCtor: replaces a constructor of the function's return type with each sibling
/// constructor of the same type (same fields when the shapes match, small filler values
/// otherwise), so absorbing-state laws like `step(Done{}, e) == Done{}` are caught.
fn mutate_sibling_ctor(
    def: &Def,
    ctor_map: &HashMap<String, CtorInfo>,
    protected: &[(usize, usize)],
) -> Vec<(String, String)> {
    let ret = def.ret.trim();
    let mut siblings: Vec<&CtorInfo> = Vec::new();
    let mut seen_variants = HashSet::new();
    let mut infos: Vec<&CtorInfo> = ctor_map.values().filter(|c| c.type_name == ret).collect();
    infos.sort_by(|a, b| a.variant_name.cmp(&b.variant_name));
    for info in infos {
        if seen_variants.insert(info.variant_name.clone()) {
            siblings.push(info);
        }
    }
    if siblings.len() < 2 {
        return Vec::new();
    }

    let body = def.body.as_str();
    let bytes = body.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let starts_ident = (bytes[i].is_ascii_alphabetic() || bytes[i] == b'_')
            && (i == 0
                || !(bytes[i - 1].is_ascii_alphanumeric()
                    || bytes[i - 1] == b'_'
                    || bytes[i - 1] == b'.'));
        if !starts_ident || in_protected(i, protected) {
            i += 1;
            continue;
        }
        let mut end = i;
        while end < bytes.len()
            && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_' || bytes[end] == b'.')
        {
            end += 1;
        }
        let name = &body[i..end];
        let Some(info) = ctor_map.get(name).filter(|c| c.type_name == ret) else {
            i = end;
            continue;
        };
        if end >= bytes.len() || bytes[end] != b'{' {
            i = end;
            continue;
        }
        let Some(close_rel) = find_matching_brace(&body[end..]) else {
            i = end;
            continue;
        };
        let close_abs = end + close_rel;
        let inner = body[end + 1..close_abs].trim();
        for sib in &siblings {
            if sib.variant_name == info.variant_name {
                continue;
            }
            let args = if sib.field_types == info.field_types {
                Some(inner.to_string())
            } else {
                sib.field_types
                    .iter()
                    .map(|ft| filler_value(ft, ctor_map))
                    .collect::<Option<Vec<_>>>()
                    .map(|v| v.join(", "))
            };
            let Some(args) = args else {
                continue;
            };
            let repl = format!("{}.{}{{{args}}}", sib.type_name, sib.variant_name);
            out.push((
                replace_span(body, i, close_abs + 1, &repl),
                format!(
                    "{name}{{..}} -> {}.{}{{..}}",
                    sib.type_name, sib.variant_name
                ),
            ));
        }
        i = close_abs + 1;
    }
    out
}

struct BodyLine {
    code_lo: usize,
    code_hi: usize,
    indent: usize,
}

fn slice_non_empty_lines(body: &str, lo: usize, hi: usize) -> Vec<BodyLine> {
    let mut out = Vec::new();
    let mut offset = lo;
    for raw in body[lo..hi].split_inclusive('\n') {
        let without_nl = raw.trim_end_matches(['\n', '\r']);
        if !without_nl.trim().is_empty() {
            let ws_start = without_nl.len() - without_nl.trim_start().len();
            let code_lo = offset + ws_start;
            let code_hi = offset + without_nl.trim_end().len();
            let line_start = body[..code_lo].rfind('\n').map_or(0, |p| p + 1);
            let prefix = &body[line_start..code_lo];
            let indent = if prefix.bytes().all(|b| b == b' ' || b == b'\t') {
                leading_indent(prefix)
            } else {
                0
            };
            out.push(BodyLine {
                code_lo,
                code_hi,
                indent,
            });
        }
        offset += raw.len();
    }
    out
}

fn delim_delta(s: &str) -> i32 {
    let bytes = s.as_bytes();
    let mut delta = 0i32;
    let mut in_string = false;
    let mut i = 0usize;
    while i < bytes.len() {
        if in_string {
            if bytes[i] == b'\\' && i + 1 < bytes.len() {
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match bytes[i] {
            b'"' => in_string = true,
            b'(' | b'{' | b'[' => delta += 1,
            b')' | b'}' | b']' => delta -= 1,
            _ => {}
        }
        i += 1;
    }
    delta
}

fn subslice_span(parent: &str, sub: &str) -> (usize, usize) {
    let lo = sub.as_ptr() as usize - parent.as_ptr() as usize;
    (lo, lo + sub.len())
}

fn split_matching_else(s: &str) -> Option<(&str, &str)> {
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut if_depth = 0usize;
    let mut in_string = false;
    let mut i = 0usize;
    while i < bytes.len() {
        if in_string {
            if bytes[i] == b'\\' && i + 1 < bytes.len() {
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match bytes[i] {
            b'"' => in_string = true,
            b'(' | b'{' | b'[' => depth += 1,
            b')' | b'}' | b']' => depth -= 1,
            _ if depth == 0 => {
                let prev_non_ident = i == 0
                    || (!bytes[i - 1].is_ascii_alphanumeric()
                        && bytes[i - 1] != b'_'
                        && bytes[i - 1] != b'.');
                if prev_non_ident
                    && s[i..].starts_with("if")
                    && bytes.get(i + 2).is_some_and(u8::is_ascii_whitespace)
                {
                    if_depth += 1;
                    i += 2;
                    continue;
                }
                if i > 0 && bytes[i - 1].is_ascii_whitespace() && s[i..].starts_with("else:") {
                    if if_depth == 0 {
                        return Some((&s[..i], &s[i + "else:".len()..]));
                    }
                    if_depth -= 1;
                    i += "else:".len();
                    continue;
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn split_inline_case_arms(inline_arms: &str) -> Vec<&str> {
    let bytes = inline_arms.as_bytes();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut markers = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if in_string {
            if bytes[i] == b'\\' && i + 1 < bytes.len() {
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match bytes[i] {
            b'"' => in_string = true,
            b'(' | b'{' | b'[' => depth += 1,
            b')' | b'}' | b']' => depth -= 1,
            _ if depth == 0 => {
                let prev_non_ident = i == 0
                    || (!bytes[i - 1].is_ascii_alphanumeric()
                        && bytes[i - 1] != b'_'
                        && bytes[i - 1] != b'.');
                if prev_non_ident
                    && inline_arms[i..].starts_with("case")
                    && bytes.get(i + 4).is_some_and(u8::is_ascii_whitespace)
                {
                    markers.push(i);
                    i += 4;
                    continue;
                }
            }
            _ => {}
        }
        i += 1;
    }

    let mut arms = Vec::with_capacity(markers.len());
    for (idx, &start) in markers.iter().enumerate() {
        let end = markers.get(idx + 1).copied().unwrap_or(inline_arms.len());
        let trimmed = inline_arms[start + "case".len()..end]
            .trim()
            .trim_end_matches(';')
            .trim();
        if !trimmed.is_empty() {
            arms.push(trimmed);
        }
    }
    arms
}

fn collect_return_leaf_spans(body: &str, lo: usize, hi: usize, out: &mut Vec<(usize, usize)>) {
    let lines = slice_non_empty_lines(body, lo, hi);
    let Some(first_line) = lines.first() else {
        return;
    };
    let span_lo = first_line.code_lo;
    let span_hi = lines.last().unwrap().code_hi;
    let first = &body[first_line.code_lo..first_line.code_hi];

    // 1. Multi-line `let <pat> = <val>\n  <body>`
    if lines.len() > 1 && first.starts_with("let ") && split_top_level_once(first, ';').is_none() {
        if let Some((_, val_first)) = split_top_level_once(&first["let ".len()..], '=') {
            let let_indent = first_line.indent;
            let mut depth = delim_delta(val_first);
            let mut split_idx = 1;
            while split_idx < lines.len() && (depth > 0 || lines[split_idx].indent > let_indent) {
                let line_txt = &body[lines[split_idx].code_lo..lines[split_idx].code_hi];
                depth += delim_delta(line_txt);
                split_idx += 1;
            }
            if split_idx < lines.len() {
                collect_return_leaf_spans(body, lines[split_idx].code_lo, span_hi, out);
                return;
            }
        }
    }

    // 2. `match <scrut>: ...` (multi-line or single-line)
    if let Some(after_match) = first.strip_prefix("match ") {
        if lines.len() > 1 {
            let mut depth = delim_delta(first);
            let mut first_case = None;
            for (idx, line) in lines.iter().enumerate().skip(1) {
                let txt = &body[line.code_lo..line.code_hi];
                if depth == 0 && txt.starts_with("case ") {
                    first_case = Some(idx);
                    break;
                }
                depth += delim_delta(txt);
            }
            if let Some(fc) = first_case {
                let case_indent = lines[fc].indent;
                let mut arm_starts = Vec::new();
                let mut arm_depth = 0i32;
                for (idx, line) in lines.iter().enumerate().skip(fc) {
                    let txt = &body[line.code_lo..line.code_hi];
                    if arm_depth == 0 && line.indent == case_indent && txt.starts_with("case ") {
                        arm_starts.push(idx);
                    }
                    arm_depth += delim_delta(txt);
                }
                for (ai, &start_idx) in arm_starts.iter().enumerate() {
                    let end_idx = arm_starts.get(ai + 1).copied().unwrap_or(lines.len());
                    let arm_hdr = &body[lines[start_idx].code_lo..lines[start_idx].code_hi];
                    let Some(after_case) = arm_hdr.strip_prefix("case ") else {
                        continue;
                    };
                    let Some((_, inline_body)) = split_case_arm(after_case) else {
                        continue;
                    };
                    let arm_hi = lines[end_idx - 1].code_hi;
                    if !inline_body.is_empty() {
                        let (inline_lo, _) = subslice_span(body, inline_body);
                        collect_return_leaf_spans(body, inline_lo, arm_hi, out);
                    } else if start_idx + 1 < end_idx {
                        collect_return_leaf_spans(body, lines[start_idx + 1].code_lo, arm_hi, out);
                    }
                }
                return;
            }
        } else if let Some((_, inline_arms)) = split_top_level_once(after_match, ':') {
            for arm in split_inline_case_arms(inline_arms) {
                if let Some((_, inline_body)) = split_case_arm(arm) {
                    if !inline_body.is_empty() {
                        let (sub_lo, sub_hi) = subslice_span(body, inline_body);
                        collect_return_leaf_spans(body, sub_lo, sub_hi, out);
                    }
                }
            }
            return;
        }
    }

    let sub = &body[span_lo..span_hi];

    // 3. `if <cond>: <then> else: <else>` (single-line or multi-line)
    if let Some(rest) = sub.strip_prefix("if ") {
        if let Some((before_else, after_else)) = split_matching_else(rest) {
            if let Some((_, then_b)) = split_top_level_once(before_else, ':') {
                let then_t = then_b.trim();
                if !then_t.is_empty() {
                    let (tlo, thi) = subslice_span(body, then_t);
                    collect_return_leaf_spans(body, tlo, thi, out);
                }
                let else_t = after_else.trim();
                if !else_t.is_empty() {
                    let (elo, ehi) = subslice_span(body, else_t);
                    collect_return_leaf_spans(body, elo, ehi, out);
                }
                return;
            }
        }
    }

    // 4. Single-line `let <pat> = <val>; <body>`
    if let Some(rest) = sub.strip_prefix("let ") {
        if let Some((_, rest_body)) = split_top_level_once(rest, ';') {
            let rest_t = rest_body.trim();
            if !rest_t.is_empty() {
                let (rlo, rhi) = subslice_span(body, rest_t);
                collect_return_leaf_spans(body, rlo, rhi, out);
                return;
            }
        }
    }

    // 5. Outer parentheses or type annotation `(term)` / `(term : Type)` (excluding tuples)
    if crate::emit::is_wrapped_in_parens(sub) {
        let inner = sub[1..sub.len() - 1].trim();
        if split_top_level(inner, ',').len() == 1 {
            let target = split_top_level_once(inner, ':')
                .map(|(term_part, _)| term_part.trim())
                .unwrap_or(inner);
            if !target.is_empty() {
                let (tlo, thi) = subslice_span(body, target);
                collect_return_leaf_spans(body, tlo, thi, out);
                return;
            }
        }
    }

    // 6. Base case: whole returned expression (including multi-line calls).
    out.push((span_lo, span_hi));
}

/// Byte spans of returned leaf expressions in `body`, preserving whole multi-line calls while
/// skipping `let` RHS bindings, `match` scrutinees, `if` conditions, and nested arguments.
fn return_leaf_spans(body: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    collect_return_leaf_spans(body, 0, body.len(), &mut spans);
    spans
}

fn format_inline_leaf(leaf: &str) -> String {
    let mut out = String::with_capacity(leaf.len());
    let mut pending_space = false;
    for ch in leaf.chars() {
        if ch.is_whitespace() {
            if !out.is_empty() && !out.ends_with('(') {
                pending_space = true;
            }
            continue;
        }
        if pending_space && !matches!(ch, ')' | ',') {
            out.push(' ');
        }
        pending_space = false;
        out.push(ch);
    }
    out
}

/// True when `s` is exactly one call of a user `def`: `f(...)` with balanced parentheses.
fn is_user_call_expr(s: &str, def_map: &HashMap<String, &Def>) -> bool {
    let Some(open) = s.find('(') else {
        return false;
    };
    def_map.contains_key(s[..open].trim())
        && s.ends_with(')')
        && find_matching_paren(&s[open..]) == Some(s.len() - 1 - open)
}

/// ReturnCtor: replaces a returned variable or user-function call with each constructor of
/// the function's `Data` return type (small filler fields), or with `True{}` / `False{}` for a
/// returned call in a `Bool` function. Catches laws guarded only by a fallthrough such as
/// `case st _: st` or a delegated classifier call (Issue #15).
fn mutate_return_ctor(
    def: &Def,
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
) -> Vec<(String, String)> {
    let ret = def.ret.trim();
    let body = def.body.as_str();
    let mut replacements: Vec<String> = Vec::new();
    let mut seen_variants = HashSet::new();
    let mut infos: Vec<&CtorInfo> = ctor_map.values().filter(|c| c.type_name == ret).collect();
    infos.sort_by(|a, b| a.variant_name.cmp(&b.variant_name));
    for info in infos {
        if !seen_variants.insert(info.variant_name.clone()) {
            continue;
        }
        let fields = info
            .field_types
            .iter()
            .map(|ft| filler_value(ft, ctor_map))
            .collect::<Option<Vec<_>>>();
        if let Some(fields) = fields {
            replacements.push(format!(
                "{}.{}{{{}}}",
                info.type_name,
                info.variant_name,
                fields.join(", ")
            ));
        }
    }
    let is_bool = ret == "Bool";
    if replacements.is_empty() && !is_bool {
        return Vec::new();
    }

    let mut out = Vec::new();
    for (start, end) in return_leaf_spans(body) {
        let leaf = &body[start..end];
        let is_call = is_user_call_expr(leaf, def_map);
        let candidates: Vec<String> = if is_bool {
            // Bare Bool variables are BoolConst's; ReturnCtor takes returned calls.
            if !is_call {
                continue;
            }
            vec!["True{}".to_string(), "False{}".to_string()]
        } else {
            if !is_call && !is_bare_var_ident(leaf, def_map, ctor_map) {
                continue;
            }
            replacements.clone()
        };
        let kind = if is_call { "call" } else { "variable" };
        let label = format_inline_leaf(leaf);
        for repl in candidates {
            out.push((
                replace_span(body, start, end, &repl),
                format!("returned {kind} '{label}' -> {repl}"),
            ));
        }
    }
    out
}

/// NatLit: changes a `Nat` literal `k` to `0n`, `k + 1`, and `k - 1` (at most
/// `MAX_NAT_LIT_SITES_PER_DEF` sites per function). All `-> 0n` mutants come first, so
/// "zero is rejected" laws guarded by a constant such as `Nat.is_eq(width, 256n)` are caught.
#[cfg(test)]
fn mutate_nat_lit(body: &str, protected: &[(usize, usize)]) -> Vec<(String, String)> {
    mutate_nat_lit_with_stats(body, protected).0
}

fn mutate_nat_lit_with_stats(
    body: &str,
    protected: &[(usize, usize)],
) -> (Vec<(String, String)>, usize) {
    let bytes = body.as_bytes();
    let is_ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut sites: Vec<(usize, usize, u64)> = Vec::new();
    let mut extra_site_mutants = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let starts = bytes[i].is_ascii_digit()
            && (i == 0 || !(is_ident(bytes[i - 1]) || bytes[i - 1] == b'.'));
        if !starts {
            i += 1;
            continue;
        }
        let mut end = i;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        let is_nat = end < bytes.len()
            && bytes[end] == b'n'
            && (end + 1 >= bytes.len() || !is_ident(bytes[end + 1]));
        if is_nat && !in_protected(i, protected) {
            if let Ok(k) = body[i..end].parse::<u64>() {
                if sites.len() < MAX_NAT_LIT_SITES_PER_DEF {
                    sites.push((i, end + 1, k));
                } else {
                    if k != 0 {
                        extra_site_mutants += 1;
                    }
                    if k.checked_add(1).is_some() {
                        extra_site_mutants += 1;
                    }
                    if k > 1 {
                        extra_site_mutants += 1;
                    }
                }
            }
        }
        i = end.max(i + 1);
    }

    let mut out = Vec::new();
    let mut push = |start: usize, end: usize, k: u64, to: u64| {
        if to != k {
            out.push((
                replace_span(body, start, end, &format!("{to}n")),
                format!("{k}n -> {to}n"),
            ));
        }
    };
    for &(s0, e0, k) in &sites {
        push(s0, e0, k, 0);
    }
    for &(s0, e0, k) in &sites {
        if let Some(up) = k.checked_add(1) {
            push(s0, e0, k, up);
        }
    }
    for &(s0, e0, k) in &sites {
        if k > 1 {
            push(s0, e0, k, k - 1);
        }
    }
    (out, extra_site_mutants)
}

fn is_bare_var_ident(
    s: &str,
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
) -> bool {
    !s.is_empty()
        && s.chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !matches!(s, "true" | "false" | "_")
        && !def_map.contains_key(s)
        && !ctor_map.contains_key(s)
}

/// BoolConst: replaces a `Bool` variable with `True{}` / `False{}`. Applies to every use of a
/// live `Bool` parameter, and to bare variables in returned positions of a `Bool` function, so
/// implication laws such as `Bool.or(allowed(c), Bool.not(requires(c)))` are caught.
fn mutate_bool_const(
    def: &Def,
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
    protected: &[(usize, usize)],
) -> Vec<(String, String)> {
    let body = def.body.as_str();
    let bytes = body.as_bytes();
    let mut targets: BTreeSet<(usize, usize)> = BTreeSet::new();

    // (a) Every use of a live Bool parameter outside pattern/header positions.
    let bool_params: HashSet<&str> = def
        .params
        .iter()
        .filter(|p| p.q != Quantity::Dead && p.ty.trim() == "Bool")
        .map(|p| p.name.as_str())
        .collect();
    if !bool_params.is_empty() {
        let mut i = 0usize;
        while i < bytes.len() {
            let starts_ident = (bytes[i].is_ascii_alphabetic() || bytes[i] == b'_')
                && (i == 0
                    || !(bytes[i - 1].is_ascii_alphanumeric()
                        || bytes[i - 1] == b'_'
                        || bytes[i - 1] == b'.'));
            if !starts_ident {
                i += 1;
                continue;
            }
            let mut end = i;
            while end < bytes.len()
                && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_' || bytes[end] == b'.')
            {
                end += 1;
            }
            let followed_by_call = end < bytes.len() && matches!(bytes[end], b'(' | b'{');
            if !in_protected(i, protected)
                && bool_params.contains(&body[i..end])
                && !followed_by_call
            {
                targets.insert((i, end));
            }
            i = end;
        }
    }

    // (b) Bare variables in returned positions of a Bool function: a whole body line that is
    // just an identifier, or the inline body of a `case <pat>: <ident>` arm.
    if def.ret.trim() == "Bool" {
        for (start, end) in return_leaf_spans(body) {
            if is_bare_var_ident(&body[start..end], def_map, ctor_map) {
                targets.insert((start, end));
            }
        }
    }

    let mut out = Vec::new();
    for (start, end) in targets {
        let var = &body[start..end];
        for repl in ["True{}", "False{}"] {
            out.push((
                replace_span(body, start, end, repl),
                format!("Bool variable '{var}' -> {repl}"),
            ));
        }
    }
    out
}

/// FlipCmp: replaces a comparison with its mirror (`Nat.is_le` <-> `Nat.is_ge`,
/// `Nat.is_lt` <-> `Nat.is_gt`, `<=` <-> `>=`, `<` <-> `>`). Unlike NatCmpArith's
/// `<=` -> `<` (which only tightens), this loosens strict refusals like
/// `ok(1n + m, m) == False{}`.
fn mutate_flip_cmp(body: &str, protected: &[(usize, usize)]) -> Vec<(String, String)> {
    let fn_flips: &[(&str, &str)] = &[
        ("Nat.is_le", "Nat.is_ge"),
        ("Nat.is_ge", "Nat.is_le"),
        ("Nat.is_lt", "Nat.is_gt"),
        ("Nat.is_gt", "Nat.is_lt"),
        ("Nat.lte", "Nat.gte"),
        ("Nat.gte", "Nat.lte"),
        ("Nat.le", "Nat.ge"),
        ("Nat.ge", "Nat.le"),
        ("Nat.lt", "Nat.gt"),
        ("Nat.gt", "Nat.lt"),
    ];
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if in_protected(i, protected) {
            i += 1;
            continue;
        }
        let prev_ident = i > 0
            && (bytes[i - 1].is_ascii_alphanumeric()
                || bytes[i - 1] == b'_'
                || bytes[i - 1] == b'.');
        if !prev_ident {
            let mut matched = false;
            for &(from, to) in fn_flips {
                if body[i..].starts_with(from) {
                    let end = i + from.len();
                    let next_ok = end == bytes.len()
                        || (!bytes[end].is_ascii_alphanumeric()
                            && bytes[end] != b'_'
                            && bytes[end] != b'.');
                    if next_ok {
                        out.push((replace_span(body, i, end, to), format!("{from} -> {to}")));
                        i = end;
                        matched = true;
                        break;
                    }
                }
            }
            if matched {
                continue;
            }
        }
        let two = body.get(i..i + 2).unwrap_or("");
        if two == "<=" || two == ">=" {
            let to = if two == "<=" { ">=" } else { "<=" };
            out.push((replace_span(body, i, i + 2, to), format!("{two} -> {to}")));
            i += 2;
            continue;
        }
        let prev = if i > 0 { bytes[i - 1] } else { b' ' };
        let next = bytes.get(i + 1).copied().unwrap_or(b' ');
        if bytes[i] == b'<' && next != b'=' && next != b'-' && prev.is_ascii_whitespace() {
            out.push((replace_span(body, i, i + 1, ">"), "< -> >".to_string()));
        } else if bytes[i] == b'>'
            && next != b'='
            && prev != b'-'
            && prev != b'='
            && prev.is_ascii_whitespace()
        {
            out.push((replace_span(body, i, i + 1, "<"), "> -> <".to_string()));
        }
        i += 1;
    }
    out
}

/// Computes byte ranges `(start, end)` in `body` that belong to pattern/header positions
/// (`case <pat>:`, `match <scrut>:`, `let <pat> =`) and must never be mutated.
fn compute_protected_ranges(body: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut offset = 0usize;

    for raw_line in body.split_inclusive('\n') {
        let line = raw_line.strip_suffix('\n').unwrap_or(raw_line);
        let trimmed = line.trim_start();
        let ws = line.len() - trimmed.len();
        let line_code_start = offset + ws;

        if trimmed.starts_with("case ") {
            if let Some((pat, _)) = split_case_arm(trimmed) {
                let pat_end = (pat.as_ptr() as usize) - (trimmed.as_ptr() as usize) + pat.len();
                let mut delim_end = line_code_start + pat_end;
                let after = &line[ws + pat_end..];
                if let Some(pos) = after.find("=>") {
                    delim_end = offset + ws + pat_end + pos + 2;
                } else if let Some(pos) = after.find(':') {
                    delim_end = offset + ws + pat_end + pos + 1;
                }
                ranges.push((offset, delim_end));
            } else {
                ranges.push((offset, offset + line.len()));
            }
        } else if trimmed.starts_with("match ") {
            if let Some((_, _)) = split_top_level_once(trimmed, ':') {
                if let Some(colon) = line.rfind(':') {
                    ranges.push((offset, offset + colon + 1));
                }
            }
        } else if trimmed.starts_with("let ") {
            if let Some(eq) = line.find('=') {
                ranges.push((offset, offset + eq + 1));
            }
        }

        offset += raw_line.len();
    }

    ranges
}

fn in_protected(pos: usize, ranges: &[(usize, usize)]) -> bool {
    ranges.iter().any(|&(s, e)| pos >= s && pos < e)
}

fn replace_span(s: &str, start: usize, end: usize, repl: &str) -> String {
    let mut out = String::with_capacity(s.len() + repl.len());
    out.push_str(&s[..start]);
    out.push_str(repl);
    out.push_str(&s[end..]);
    out
}

fn mutate_bool_flips(body: &str, protected: &[(usize, usize)]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        if in_protected(i, protected) {
            i += 1;
            continue;
        }
        let prev_ident = i > 0 && (bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
        if !prev_ident {
            for (needle, repl) in [
                ("True{}", "False{}"),
                ("False{}", "True{}"),
                ("true", "false"),
                ("false", "true"),
            ] {
                if body[i..].starts_with(needle) {
                    let end = i + needle.len();
                    let next_ident = end < bytes.len()
                        && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_');
                    if !next_ident || needle.ends_with('}') {
                        out.push((
                            replace_span(body, i, end, repl),
                            format!("{needle} -> {repl}"),
                        ));
                        i = end;
                        continue;
                    }
                }
            }
            if body[i..].starts_with("Bool.pick(") {
                let paren_start = i + "Bool.pick".len();
                if let Some(close_rel) = find_matching_paren(&body[paren_start..]) {
                    let close_abs = paren_start + close_rel;
                    let inner = &body[paren_start + 1..close_abs];
                    let args = split_top_level(inner, ',');
                    if args.len() == 3 {
                        let swapped = format!("Bool.pick({}, {}, {})", args[0], args[2], args[1]);
                        out.push((
                            replace_span(body, i, close_abs + 1, &swapped),
                            "Bool.pick branches swapped".to_string(),
                        ));
                    } else if args.len() == 4 {
                        let swapped = format!(
                            "Bool.pick({}, {}, {}, {})",
                            args[0], args[1], args[3], args[2]
                        );
                        out.push((
                            replace_span(body, i, close_abs + 1, &swapped),
                            "Bool.pick branches swapped".to_string(),
                        ));
                    }
                }
            }
        }
        i += 1;
    }

    out
}

fn mutate_nat_ops(body: &str, protected: &[(usize, usize)]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0usize;

    let fn_swaps: &[(&str, &[&str])] = &[
        ("Nat.is_le", &["Nat.is_lt"]),
        ("Nat.is_lt", &["Nat.is_le"]),
        ("Nat.le", &["Nat.lt"]),
        ("Nat.lte", &["Nat.lt"]),
        ("Nat.lt", &["Nat.le"]),
        ("Nat.is_ge", &["Nat.is_gt"]),
        ("Nat.is_gt", &["Nat.is_ge"]),
        ("Nat.ge", &["Nat.gt"]),
        ("Nat.gte", &["Nat.gt"]),
        ("Nat.gt", &["Nat.ge"]),
        ("Nat.is_eq", &["Nat.is_ne"]),
        ("Nat.is_ne", &["Nat.is_eq"]),
        ("Nat.eq", &["Nat.ne"]),
        ("Nat.ne", &["Nat.eq"]),
        ("Nat.equal", &["Nat.is_ne"]),
        ("Nat.add", &["Nat.sub", "Nat.mul"]),
        ("Nat.sub", &["Nat.add"]),
        ("Nat.mul", &["Nat.add"]),
        ("Nat.min", &["Nat.max"]),
        ("Nat.max", &["Nat.min"]),
        ("Nat.succ", &["Nat.pred"]),
        ("Nat.pred", &["Nat.succ"]),
        ("Nat.div", &["Nat.mod"]),
    ];

    while i < bytes.len() {
        if in_protected(i, protected) {
            i += 1;
            continue;
        }
        let prev_ident = i > 0
            && (bytes[i - 1].is_ascii_alphanumeric()
                || bytes[i - 1] == b'_'
                || bytes[i - 1] == b'.');
        if !prev_ident {
            let mut matched_fn = false;
            for &(from, tos) in fn_swaps {
                if body[i..].starts_with(from) {
                    let end = i + from.len();
                    let next_ok = end == bytes.len()
                        || (!bytes[end].is_ascii_alphanumeric()
                            && bytes[end] != b'_'
                            && bytes[end] != b'.');
                    if next_ok {
                        for &to in tos {
                            out.push((replace_span(body, i, end, to), format!("{from} -> {to}")));
                        }
                        i = end;
                        matched_fn = true;
                        break;
                    }
                }
            }
            if matched_fn {
                continue;
            }
        }

        // Infix comparison and additive operators (avoiding ->, =>, {==}, and 1n+x Nat literals)
        let two = if i + 1 < bytes.len() {
            &body[i..i + 2]
        } else {
            ""
        };
        if two == "<=" {
            out.push((replace_span(body, i, i + 2, "<"), "<= -> <".to_string()));
            i += 2;
            continue;
        }
        if two == ">=" {
            out.push((replace_span(body, i, i + 2, ">"), ">= -> >".to_string()));
            i += 2;
            continue;
        }
        if two == "==" {
            let in_refl =
                i > 0 && bytes[i - 1] == b'{' && i + 2 < bytes.len() && bytes[i + 2] == b'}';
            if !in_refl {
                out.push((replace_span(body, i, i + 2, "!="), "== -> !=".to_string()));
            }
            i += 2;
            continue;
        }
        if two == "!=" {
            out.push((replace_span(body, i, i + 2, "=="), "!= -> ==".to_string()));
            i += 2;
            continue;
        }
        if bytes[i] == b'<' && (i + 1 >= bytes.len() || bytes[i + 1] != b'=') {
            out.push((replace_span(body, i, i + 1, "<="), "< -> <=".to_string()));
            i += 1;
            continue;
        }
        if bytes[i] == b'>'
            && (i + 1 >= bytes.len() || bytes[i + 1] != b'=')
            && (i == 0 || (bytes[i - 1] != b'-' && bytes[i - 1] != b'='))
        {
            out.push((replace_span(body, i, i + 1, ">="), "> -> >=".to_string()));
            i += 1;
            continue;
        }
        if bytes[i] == b'+' && i > 0 && bytes[i - 1].is_ascii_whitespace() {
            out.push((replace_span(body, i, i + 1, "-"), "+ -> -".to_string()));
            i += 1;
            continue;
        }
        if bytes[i] == b'-'
            && (i + 1 >= bytes.len() || bytes[i + 1] != b'>')
            && i > 0
            && bytes[i - 1].is_ascii_whitespace()
            && i + 1 < bytes.len()
            && bytes[i + 1].is_ascii_whitespace()
        {
            out.push((replace_span(body, i, i + 1, "+"), "- -> +".to_string()));
            i += 1;
            continue;
        }

        i += 1;
    }

    out
}

fn mutate_drop_bool_operand(body: &str, protected: &[(usize, usize)]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        if in_protected(i, protected) {
            i += 1;
            continue;
        }
        for fname in ["Bool.and(", "Bool.or("] {
            if body[i..].starts_with(fname) {
                let prev_ident =
                    i > 0 && (bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
                if !prev_ident {
                    let paren_start = i + fname.len() - 1;
                    if let Some(close_rel) = find_matching_paren(&body[paren_start..]) {
                        let close_abs = paren_start + close_rel;
                        let inner = &body[paren_start + 1..close_abs];
                        let args = split_top_level(inner, ',');
                        if args.len() == 2 {
                            let op_name = fname.trim_end_matches('(');
                            out.push((
                                replace_span(body, i, close_abs + 1, &format!("({})", args[0])),
                                format!("{op_name} dropped right operand"),
                            ));
                            out.push((
                                replace_span(body, i, close_abs + 1, &format!("({})", args[1])),
                                format!("{op_name} dropped left operand"),
                            ));
                        }
                    }
                }
            }
        }
        i += 1;
    }

    // Also handle top-level infix `&&` / `||` on single-line expressions
    for op in ["&&", "||"] {
        let trimmed = body.trim();
        if !trimmed.contains('\n') {
            if let Some((lhs, rhs)) = crate::emit::split_top_level_str(trimmed, op) {
                out.push((lhs.to_string(), format!("{op} dropped right operand")));
                out.push((rhs.to_string(), format!("{op} dropped left operand")));
            }
        }
    }

    out
}

fn mutate_return_unchanged(
    def: &Def,
    ctor_map: &HashMap<String, CtorInfo>,
) -> Vec<(String, String)> {
    let mut out = Vec::new();

    // 4a. Whole-function identity return of a parameter with matching return type
    for p in &def.params {
        if p.q != Quantity::Dead && p.ty.trim() == def.ret.trim() && def.body.trim() != p.name {
            out.push((
                p.name.clone(),
                format!("return parameter '{}' unchanged", p.name),
            ));
        }
    }

    // 4b. Inside match arms, return a matched constructor unchanged when it produces def.ret
    let lines: Vec<&str> = def.body.lines().collect();
    let mut i = 0usize;
    while i < lines.len() {
        let trimmed = lines[i].trim();
        if let Some(after_case) = trimmed.strip_prefix("case ") {
            if let Some((pat_raw, inline_body)) = split_case_arm(after_case) {
                let case_indent = leading_indent(lines[i]);
                if let Some(ctor_expr) =
                    reconstruct_ctor_pattern_expr(pat_raw.trim(), &def.ret, ctor_map)
                {
                    if !inline_body.is_empty() {
                        if inline_body.trim() != ctor_expr {
                            let sep = if after_case.contains("=>") { "=>" } else { ":" };
                            let mut new_lines: Vec<String> =
                                lines.iter().map(|l| (*l).to_string()).collect();
                            let indent_str = &lines[i][..lines[i].len() - trimmed.len()];
                            new_lines[i] = format!("{indent_str}case {pat_raw} {sep} {ctor_expr}");
                            out.push((
                                new_lines.join("\n"),
                                format!("return '{ctor_expr}' unchanged"),
                            ));
                        }
                    } else {
                        let mut end_idx = i + 1;
                        while end_idx < lines.len() {
                            let t = lines[end_idx].trim();
                            if !t.is_empty() && leading_indent(lines[end_idx]) <= case_indent {
                                break;
                            }
                            end_idx += 1;
                        }
                        let arm_body_str = lines[i + 1..end_idx].join("\n");
                        if arm_body_str.trim() != ctor_expr && end_idx > i + 1 {
                            let mut new_lines: Vec<String> = Vec::new();
                            new_lines.extend(lines[..=i].iter().map(|l| (*l).to_string()));
                            let body_indent =
                                format!("{}  ", &lines[i][..lines[i].len() - trimmed.len()]);
                            new_lines.push(format!("{body_indent}{ctor_expr}"));
                            new_lines.extend(lines[end_idx..].iter().map(|l| (*l).to_string()));
                            out.push((
                                new_lines.join("\n"),
                                format!("return '{ctor_expr}' unchanged"),
                            ));
                        }
                    }
                }
            }
        }
        i += 1;
    }

    out
}

fn reconstruct_ctor_pattern_expr(
    pat: &str,
    ret_ty: &str,
    ctor_map: &HashMap<String, CtorInfo>,
) -> Option<String> {
    let open = pat.find('{')?;
    if !pat.ends_with('}') {
        return None;
    }
    let head = pat[..open].trim();
    let info = ctor_map.get(head)?;
    if info.type_name != ret_ty.trim() {
        return None;
    }
    let inner = pat[open + 1..pat.len() - 1].trim();
    if inner.is_empty() {
        return Some(format!("{head}{{}}"));
    }
    let mut fields = Vec::new();
    for part in split_top_level(inner, ',') {
        let clean = part
            .trim()
            .trim_start_matches('+')
            .trim_start_matches('-')
            .trim();
        let var = if let Some((_, v)) = clean.split_once(':') {
            v.trim()
                .trim_start_matches('+')
                .trim_start_matches('-')
                .trim()
        } else {
            clean
        };
        if var == "_"
            || var.is_empty()
            || !var.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            || var.chars().next().is_some_and(|c| c.is_ascii_digit())
        {
            return None;
        }
        fields.push(var.to_string());
    }
    Some(format!("{head}{{{}}}", fields.join(", ")))
}

struct ArmSlice {
    case_line: usize,
    end_line: usize, // exclusive
    pat: String,
    inline_sep: Option<&'static str>, // Some(":") or Some("=>") if inline body
    body_text: String,
}

fn mutate_swap_match_arms(
    def: &Def,
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let lines: Vec<&str> = def.body.lines().collect();

    for m_idx in 0..lines.len() {
        let m_trim = lines[m_idx].trim();
        if !m_trim.starts_with("match ") || !m_trim.ends_with(':') {
            continue;
        }
        let m_indent = leading_indent(lines[m_idx]);
        let Some(first_case) = (m_idx + 1..lines.len()).find(|&idx| {
            let t = lines[idx].trim();
            !t.is_empty() && leading_indent(lines[idx]) > m_indent && t.starts_with("case ")
        }) else {
            continue;
        };
        let case_indent = leading_indent(lines[first_case]);

        // Determine the end of this match block
        let mut match_end = lines.len();
        for (idx, line) in lines.iter().enumerate().skip(m_idx + 1) {
            let t = line.trim();
            if !t.is_empty() && leading_indent(line) <= m_indent {
                match_end = idx;
                break;
            }
        }

        let mut arm_starts = Vec::new();
        for (idx, line) in lines.iter().enumerate().take(match_end).skip(first_case) {
            let t = line.trim();
            if !t.is_empty() && leading_indent(line) == case_indent && t.starts_with("case ") {
                arm_starts.push(idx);
            }
        }
        if arm_starts.len() < 2 {
            continue;
        }

        let mut arms = Vec::new();
        for (ai, &start) in arm_starts.iter().enumerate() {
            let end = arm_starts.get(ai + 1).copied().unwrap_or(match_end);
            let after_case = lines[start].trim().strip_prefix("case ").unwrap().trim();
            let Some((pat_raw, inline_body)) = split_case_arm(after_case) else {
                continue;
            };
            if !inline_body.is_empty() && end == start + 1 {
                let sep = if after_case.contains("=>") { "=>" } else { ":" };
                arms.push(ArmSlice {
                    case_line: start,
                    end_line: end,
                    pat: pat_raw.trim().to_string(),
                    inline_sep: Some(sep),
                    body_text: inline_body.trim().to_string(),
                });
            } else {
                let mut body_lines = Vec::new();
                if !inline_body.is_empty() {
                    let indent = format!(
                        "{}  ",
                        &lines[start][..lines[start].len() - lines[start].trim_start().len()]
                    );
                    body_lines.push(format!("{indent}{}", inline_body.trim()));
                }
                for &l in &lines[start + 1..end] {
                    body_lines.push(l.to_string());
                }
                arms.push(ArmSlice {
                    case_line: start,
                    end_line: end,
                    pat: pat_raw.trim().to_string(),
                    inline_sep: None,
                    body_text: body_lines.join("\n"),
                });
            }
        }

        for i in 0..arms.len() {
            for j in i + 1..arms.len() {
                if arms[i].body_text.trim() == arms[j].body_text.trim() {
                    continue;
                }
                if !arms_binder_compatible(&arms[i], &arms[j], def, def_map, ctor_map) {
                    continue;
                }
                if let Some(swapped) = rebuild_with_swapped_arms(&lines, &arms[i], &arms[j]) {
                    out.push((
                        swapped,
                        format!("swap match arms '{}' and '{}'", arms[i].pat, arms[j].pat),
                    ));
                }
            }
        }
    }

    out
}

fn arms_binder_compatible(
    a: &ArmSlice,
    b: &ArmSlice,
    def: &Def,
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
) -> bool {
    let param_names: HashSet<String> = def.params.iter().map(|p| p.name.clone()).collect();
    let binds_a = extract_pattern_binders(&a.pat, ctor_map);
    let binds_b = extract_pattern_binders(&b.pat, ctor_map);

    let tokens_a: HashSet<String> = lock::tokenize_bend(&a.body_text)
        .into_iter()
        .filter(|t| !def_map.contains_key(t) && !ctor_map.contains_key(t))
        .collect();
    let tokens_b: HashSet<String> = lock::tokenize_bend(&b.body_text)
        .into_iter()
        .filter(|t| !def_map.contains_key(t) && !ctor_map.contains_key(t))
        .collect();

    for var in &binds_a {
        if !param_names.contains(var) && tokens_a.contains(var) && !binds_b.contains(var) {
            return false;
        }
    }
    for var in &binds_b {
        if !param_names.contains(var) && tokens_b.contains(var) && !binds_a.contains(var) {
            return false;
        }
    }
    true
}

fn extract_pattern_binders(pat: &str, ctor_map: &HashMap<String, CtorInfo>) -> HashSet<String> {
    let mut binders = HashSet::new();
    for tok in lock::tokenize_bend(pat) {
        if matches!(
            tok.as_str(),
            "_" | "true" | "false" | "True" | "False" | "Unit"
        ) || ctor_map.contains_key(&tok)
        {
            continue;
        }
        let first = tok.chars().next();
        if first.is_some_and(|c| c.is_ascii_lowercase() || c == '_')
            && tok.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            binders.insert(tok);
        }
    }
    binders
}

fn rebuild_with_swapped_arms(lines: &[&str], a: &ArmSlice, b: &ArmSlice) -> Option<String> {
    let mut result: Vec<String> = Vec::new();
    let mut idx = 0usize;
    while idx < lines.len() {
        if idx == a.case_line {
            emit_arm_with_body(lines, a, &b.body_text, &mut result);
            idx = a.end_line;
        } else if idx == b.case_line {
            emit_arm_with_body(lines, b, &a.body_text, &mut result);
            idx = b.end_line;
        } else {
            result.push(lines[idx].to_string());
            idx += 1;
        }
    }
    Some(result.join("\n"))
}

fn emit_arm_with_body(lines: &[&str], target: &ArmSlice, new_body: &str, out: &mut Vec<String>) {
    let line = lines[target.case_line];
    let ws_len = line.len() - line.trim_start().len();
    let indent = &line[..ws_len];
    if let Some(sep) = target.inline_sep {
        if !new_body.contains('\n') {
            out.push(format!(
                "{indent}case {} {sep} {}",
                target.pat,
                new_body.trim()
            ));
            return;
        }
    }
    out.push(format!("{indent}case {}:", target.pat));
    let body_indent = format!("{indent}  ");
    for bl in new_body.lines() {
        if bl.trim().is_empty() {
            continue;
        }
        if bl.starts_with(' ') || bl.starts_with('\t') {
            out.push(bl.to_string());
        } else {
            out.push(format!("{body_indent}{}", bl.trim()));
        }
    }
}

fn find_matching_paren(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(idx);
                }
            }
            _ => {}
        }
    }
    None
}

fn precompute_def_callees<'a>(
    defs: &'a [Def],
    def_map: &HashMap<String, &'a Def>,
) -> HashMap<&'a str, Vec<&'a str>> {
    let mut map = HashMap::with_capacity(defs.len());
    for def in defs {
        let mut callees = Vec::new();
        let mut seen = HashSet::new();
        for tok in lock::tokenize_bend(&def.body) {
            if let Some(target) = def_map.get(&tok) {
                if seen.insert(target.name.as_str()) {
                    callees.push(target.name.as_str());
                }
            }
        }
        map.insert(def.name.as_str(), callees);
    }
    map
}

fn law_dependency_cone_fast<'a>(
    law: &ParsedLaw,
    def_map: &HashMap<String, &'a Def>,
    def_callees: &HashMap<&'a str, Vec<&'a str>>,
) -> Vec<String> {
    let mut visited = BTreeSet::new();
    let mut queue = VecDeque::new();
    for expr in std::iter::once(law.lhs.as_str())
        .chain(std::iter::once(law.rhs.as_str()))
        .chain(
            law.hypotheses
                .iter()
                .flat_map(|h| [h.lhs.as_str(), h.rhs.as_str()]),
        )
    {
        for tok in lock::tokenize_bend(expr) {
            if let Some(def) = def_map.get(&tok) {
                if visited.insert(def.name.clone()) {
                    queue.push_back(def.name.as_str());
                }
            }
        }
    }
    while let Some(name) = queue.pop_front() {
        if let Some(callees) = def_callees.get(name) {
            for &callee in callees {
                if visited.insert(callee.to_string()) {
                    queue.push_back(callee);
                }
            }
        }
    }
    visited.into_iter().collect()
}

fn compute_types_hash(types: &[TypeDef]) -> String {
    let mut sorted_types: Vec<&TypeDef> = types.iter().collect();
    sorted_types.sort_by(|a, b| a.name.cmp(&b.name));
    let mut buf = Vec::new();
    for td in sorted_types {
        buf.extend_from_slice(td.name.as_bytes());
        buf.push(0);
        for v in &td.variants {
            buf.extend_from_slice(v.name.as_bytes());
            for ft in &v.field_types {
                buf.push(b',');
                buf.extend_from_slice(ft.as_bytes());
            }
            buf.push(0);
        }
    }
    lock::fnv1a_hex(&buf)
}

fn precompute_def_hashes(defs: &[Def]) -> HashMap<&str, String> {
    let mut out = HashMap::with_capacity(defs.len());
    for def in defs {
        let mut buf = Vec::new();
        buf.extend_from_slice(def.name.as_bytes());
        buf.push(0);
        for p in &def.params {
            buf.extend_from_slice(p.name.as_bytes());
            buf.push(b':');
            buf.extend_from_slice(p.ty.as_bytes());
            buf.push(0);
        }
        buf.extend_from_slice(def.ret.as_bytes());
        buf.push(0);
        buf.push(u8::from(def.total));
        buf.push(0);
        buf.extend_from_slice(def.body.as_bytes());
        buf.push(0);
        out.insert(def.name.as_str(), lock::fnv1a_hex(&buf));
    }
    out
}

fn compute_cone_hash_fast(
    law: &ParsedLaw,
    cone: &[String],
    types_hash: &str,
    def_hashes: &HashMap<&str, String>,
) -> String {
    let mut buf = Vec::new();
    buf.extend_from_slice(b"rb-mutate-");
    buf.extend_from_slice(MUTATE_CACHE_VERSION.as_bytes());
    buf.push(0);
    buf.extend_from_slice(crate::BUILDER_HASH.as_bytes());
    buf.push(0);
    buf.extend_from_slice(law.name.as_bytes());
    buf.push(0);
    for v in &law.vars {
        buf.extend_from_slice(v.name.as_bytes());
        buf.push(b':');
        buf.extend_from_slice(v.ty.as_bytes());
        buf.push(0);
    }
    for h in &law.hypotheses {
        buf.extend_from_slice(h.lhs.as_bytes());
        buf.extend_from_slice(b"==");
        buf.extend_from_slice(h.rhs.as_bytes());
        buf.push(0);
    }
    buf.extend_from_slice(law.lhs.as_bytes());
    buf.extend_from_slice(b"==");
    buf.extend_from_slice(law.rhs.as_bytes());
    buf.push(b':');
    buf.extend_from_slice(law.eq_ty.as_bytes());
    buf.push(0);
    buf.extend_from_slice(types_hash.as_bytes());
    buf.push(0);
    for name in cone {
        if let Some(h) = def_hashes.get(name.as_str()) {
            buf.extend_from_slice(name.as_bytes());
            buf.push(b'=');
            buf.extend_from_slice(h.as_bytes());
            buf.push(0);
        }
    }
    lock::fnv1a_hex(&buf)
}

#[derive(Debug, Clone)]
enum MutateCacheEntry {
    First {
        total_mutants: usize,
        generated_mutants: usize,
        dropped_by_budget: usize,
        dropped_by_site_cap: usize,
        caught_by: Option<(String, String)>,
        survived_operators: Vec<String>,
        skipped_reason: Option<String>,
    },
    Full {
        total_mutants: usize,
        generated_mutants: usize,
        dropped_by_budget: usize,
        dropped_by_site_cap: usize,
        outcomes: Vec<MutantOutcome>,
        skipped_reason: Option<String>,
    },
}

fn cache_entry_from_report(report: &LawMutationReport, full_report: bool) -> MutateCacheEntry {
    if full_report {
        MutateCacheEntry::Full {
            total_mutants: report.total_mutants,
            generated_mutants: report.generated_mutants,
            dropped_by_budget: report.dropped_by_budget,
            dropped_by_site_cap: report.dropped_by_site_cap,
            outcomes: report.mutant_outcomes.clone(),
            skipped_reason: report.skipped_reason.clone(),
        }
    } else {
        MutateCacheEntry::First {
            total_mutants: report.total_mutants,
            generated_mutants: report.generated_mutants,
            dropped_by_budget: report.dropped_by_budget,
            dropped_by_site_cap: report.dropped_by_site_cap,
            caught_by: report.caught_by.clone(),
            survived_operators: report.survived_operators.clone(),
            skipped_reason: report.skipped_reason.clone(),
        }
    }
}

fn report_from_cache(
    item: &PreparedLaw<'_>,
    entry: &MutateCacheEntry,
    full_report: bool,
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
) -> Option<LawMutationReport> {
    match entry {
        MutateCacheEntry::Full {
            total_mutants,
            generated_mutants,
            dropped_by_budget,
            dropped_by_site_cap,
            outcomes,
            skipped_reason,
        } => {
            let caught_by = outcomes.iter().find_map(|o| match &o.status {
                MutantStatus::Caught(ce) => Some((o.description.clone(), ce.clone())),
                _ => None,
            });
            let survived_operators: Vec<String> = outcomes
                .iter()
                .map(|o| o.operator.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            Some(LawMutationReport {
                law_name: item.law.name.clone(),
                cone: item.cone.clone(),
                total_mutants: *total_mutants,
                generated_mutants: *generated_mutants,
                dropped_by_budget: *dropped_by_budget,
                dropped_by_site_cap: *dropped_by_site_cap,
                caught_by,
                survived_operators,
                mutant_outcomes: if full_report {
                    outcomes.clone()
                } else {
                    Vec::new()
                },
                skipped_reason: skipped_reason.clone(),
                from_cache: true,
            })
        }
        MutateCacheEntry::First {
            total_mutants,
            generated_mutants,
            dropped_by_budget,
            dropped_by_site_cap,
            caught_by,
            survived_operators,
            skipped_reason,
        } => {
            if full_report {
                if skipped_reason.is_some() {
                    return Some(LawMutationReport {
                        law_name: item.law.name.clone(),
                        cone: item.cone.clone(),
                        total_mutants: *total_mutants,
                        generated_mutants: *generated_mutants,
                        dropped_by_budget: *dropped_by_budget,
                        dropped_by_site_cap: *dropped_by_site_cap,
                        caught_by: None,
                        survived_operators: Vec::new(),
                        mutant_outcomes: Vec::new(),
                        skipped_reason: skipped_reason.clone(),
                        from_cache: true,
                    });
                }
                if caught_by.is_none() {
                    let generated =
                        generate_mutants_for_cone_with_stats(&item.cone_defs, def_map, ctor_map);
                    let outcomes = generated
                        .mutants
                        .into_iter()
                        .map(|m| MutantOutcome {
                            def_name: m.def_name,
                            operator: m.operator,
                            description: m.description,
                            status: MutantStatus::Survived,
                        })
                        .collect();
                    return Some(LawMutationReport {
                        law_name: item.law.name.clone(),
                        cone: item.cone.clone(),
                        total_mutants: *total_mutants,
                        generated_mutants: *generated_mutants,
                        dropped_by_budget: *dropped_by_budget,
                        dropped_by_site_cap: *dropped_by_site_cap,
                        caught_by: None,
                        survived_operators: survived_operators.clone(),
                        mutant_outcomes: outcomes,
                        skipped_reason: None,
                        from_cache: true,
                    });
                }
                // `First::Caught` must be upgraded to `Full` under `Report` mode.
                return None;
            }
            Some(LawMutationReport {
                law_name: item.law.name.clone(),
                cone: item.cone.clone(),
                total_mutants: *total_mutants,
                generated_mutants: *generated_mutants,
                dropped_by_budget: *dropped_by_budget,
                dropped_by_site_cap: *dropped_by_site_cap,
                caught_by: caught_by.clone(),
                survived_operators: survived_operators.clone(),
                mutant_outcomes: Vec::new(),
                skipped_reason: skipped_reason.clone(),
                from_cache: true,
            })
        }
    }
}

fn load_mutate_cache(path: &Path) -> BTreeMap<String, MutateCacheEntry> {
    let mut map = BTreeMap::new();
    let Ok(raw) = fs::read_to_string(path) else {
        return map;
    };
    let mut current_full_key: Option<String> = None;
    for line in raw.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("\tM\t") {
            let Some(ref key) = current_full_key else {
                continue;
            };
            let parts: Vec<&str> = rest.splitn(5, '\t').collect();
            if parts.len() == 5 {
                let status = match parts[3] {
                    "CAUGHT" => MutantStatus::Caught(parts[4].to_string()),
                    "SURVIVED" => MutantStatus::Survived,
                    _ => continue,
                };
                if let Some(MutateCacheEntry::Full { outcomes, .. }) = map.get_mut(key) {
                    outcomes.push(MutantOutcome {
                        def_name: parts[0].to_string(),
                        operator: parts[1].to_string(),
                        description: parts[2].to_string(),
                        status,
                    });
                }
            }
            continue;
        }
        current_full_key = None;
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 7 {
            continue;
        }
        let key = parts[0].to_string();
        let Ok(total_mutants) = parts[3].parse::<usize>() else {
            continue;
        };
        let Ok(generated_mutants) = parts[4].parse::<usize>() else {
            continue;
        };
        let Ok(dropped_by_budget) = parts[5].parse::<usize>() else {
            continue;
        };
        let Ok(dropped_by_site_cap) = parts[6].parse::<usize>() else {
            continue;
        };
        match (parts[1], parts[2]) {
            ("FIRST", "CAUGHT") if parts.len() >= 9 => {
                map.insert(
                    key,
                    MutateCacheEntry::First {
                        total_mutants,
                        generated_mutants,
                        dropped_by_budget,
                        dropped_by_site_cap,
                        caught_by: Some((parts[7].to_string(), parts[8..].join("\t"))),
                        survived_operators: Vec::new(),
                        skipped_reason: None,
                    },
                );
            }
            ("FIRST", "SURVIVED") => {
                let ops = parts
                    .get(7)
                    .map(|s| {
                        s.split(',')
                            .map(str::trim)
                            .filter(|x| !x.is_empty())
                            .map(ToOwned::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                map.insert(
                    key,
                    MutateCacheEntry::First {
                        total_mutants,
                        generated_mutants,
                        dropped_by_budget,
                        dropped_by_site_cap,
                        caught_by: None,
                        survived_operators: ops,
                        skipped_reason: None,
                    },
                );
            }
            ("FIRST", "SKIPPED") if parts.len() >= 8 => {
                map.insert(
                    key,
                    MutateCacheEntry::First {
                        total_mutants,
                        generated_mutants,
                        dropped_by_budget,
                        dropped_by_site_cap,
                        caught_by: None,
                        survived_operators: Vec::new(),
                        skipped_reason: Some(parts[7..].join("\t")),
                    },
                );
            }
            ("FULL", "SKIPPED") if parts.len() >= 8 => {
                map.insert(
                    key,
                    MutateCacheEntry::Full {
                        total_mutants,
                        generated_mutants,
                        dropped_by_budget,
                        dropped_by_site_cap,
                        outcomes: Vec::new(),
                        skipped_reason: Some(parts[7..].join("\t")),
                    },
                );
            }
            ("FULL", "DONE") => {
                current_full_key = Some(key.clone());
                map.insert(
                    key,
                    MutateCacheEntry::Full {
                        total_mutants,
                        generated_mutants,
                        dropped_by_budget,
                        dropped_by_site_cap,
                        outcomes: Vec::new(),
                        skipped_reason: None,
                    },
                );
            }
            _ => {}
        }
    }
    map
}

fn save_mutate_cache(path: &Path, map: &BTreeMap<String, MutateCacheEntry>) -> Result<(), String> {
    let mut lines = vec![format!("# rb-mutate-cache-{MUTATE_CACHE_VERSION}")];
    for (k, entry) in map {
        match entry {
            MutateCacheEntry::First {
                total_mutants,
                generated_mutants,
                dropped_by_budget,
                dropped_by_site_cap,
                caught_by,
                survived_operators,
                skipped_reason,
            } => {
                if let Some(reason) = skipped_reason {
                    lines.push(format!(
                        "{k}\tFIRST\tSKIPPED\t{total_mutants}\t{generated_mutants}\t{dropped_by_budget}\t{dropped_by_site_cap}\t{}",
                        sanitize_cache_field(reason)
                    ));
                } else if let Some((desc, ce)) = caught_by {
                    lines.push(format!(
                        "{k}\tFIRST\tCAUGHT\t{total_mutants}\t{generated_mutants}\t{dropped_by_budget}\t{dropped_by_site_cap}\t{}\t{}",
                        sanitize_cache_field(desc),
                        sanitize_cache_field(ce)
                    ));
                } else {
                    lines.push(format!(
                        "{k}\tFIRST\tSURVIVED\t{total_mutants}\t{generated_mutants}\t{dropped_by_budget}\t{dropped_by_site_cap}\t{}",
                        sanitize_cache_field(&survived_operators.join(","))
                    ));
                }
            }
            MutateCacheEntry::Full {
                total_mutants,
                generated_mutants,
                dropped_by_budget,
                dropped_by_site_cap,
                outcomes,
                skipped_reason,
            } => {
                if let Some(reason) = skipped_reason {
                    lines.push(format!(
                        "{k}\tFULL\tSKIPPED\t{total_mutants}\t{generated_mutants}\t{dropped_by_budget}\t{dropped_by_site_cap}\t{}",
                        sanitize_cache_field(reason)
                    ));
                } else {
                    lines.push(format!(
                        "{k}\tFULL\tDONE\t{total_mutants}\t{generated_mutants}\t{dropped_by_budget}\t{dropped_by_site_cap}"
                    ));
                    for o in outcomes {
                        let (kind, extra) = match &o.status {
                            MutantStatus::Caught(ce) => ("CAUGHT", sanitize_cache_field(ce)),
                            MutantStatus::Survived => ("SURVIVED", String::new()),
                            MutantStatus::BuildError(_) => continue,
                        };
                        lines.push(format!(
                            "\tM\t{}\t{}\t{}\t{kind}\t{extra}",
                            sanitize_cache_field(&o.def_name),
                            sanitize_cache_field(&o.operator),
                            sanitize_cache_field(&o.description)
                        ));
                    }
                }
            }
        }
    }
    fs::write(path, format!("{}\n", lines.join("\n"))).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::law_test::law_dependency_cone;

    static MSEQ: AtomicUsize = AtomicUsize::new(0);

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let n = MSEQ.fetch_add(1, Ordering::SeqCst);
        let dir = env::temp_dir().join(format!("rb_mutate_{tag}_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_vacuous_laws_with_e_law_vacuous_and_skips_lock_write() {
        let dir = tmp_dir("vacuous");
        let core = dir.join("core.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let src = r#"import Base

def f(+x: Nat) -> Nat:
  Nat.add(x, 1n)

# promise: reflexive identity test fixture
law f_reflexive:
  for +x: Nat
  {f(x) == f(x) : Nat}
"#;
        fs::write(&core, src).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        let err = run_mutation_checks(src, &report, MutateMode::NewOnly, &out_dir)
            .expect_err("vacuous law {f(x) == f(x)} must fail mutation check");
        assert!(err.contains("E_LAW_VACUOUS"), "got: {err}");
        assert!(err.contains("f_reflexive"), "got: {err}");
        assert!(!lock_file.exists(), "lock must not be written on failure");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn passes_conservation_law_against_real_bend_and_caches_result() {
        let dir = tmp_dir("conserved");
        let core = dir.join("core.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let src = r#"import Base

type Bin is Data:
  Bin{alloc: Nat, free: Nat}

def bin_capacity(+p: Bin) -> Nat:
  match p:
    case Bin{alloc, free}:
      Nat.add(alloc, free)

def bin_take_if(+alloc: Nat, +free: Nat, +req: Nat, ok: Bool) -> Bin:
  match ok:
    case True{}:
      Bin{Nat.add(alloc, req), Nat.sub(free, req)}
    case False{}:
      Bin{alloc, free}

def bin_take(+p: Bin, +req: Nat) -> Bin:
  match p:
    case Bin{alloc, +free}:
      bin_take_if(alloc, free, req, Nat.is_le(req, free))

def add_zero_sym(+a: Nat) -> {a == Nat.add(a, 0n) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %add_zero_sym(ap) : {1n+ap == 1n+_ : Nat}
      {==}

def add_succ_sym(+a: Nat, +b: Nat) -> {1n+Nat.add(a, b) == Nat.add(a, 1n+b) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %add_succ_sym(ap, b) : {1n+1n+Nat.add(ap, b) == 1n+_ : Nat}
      {==}

def take_step(
  +rp: Nat,
  +fp: Nat,
  +alloc: Nat,
  ok: Bool,
  ih: {bin_capacity(bin_take_if(alloc, fp, rp, ok)) == Nat.add(alloc, fp) : Nat}
) -> {bin_capacity(bin_take_if(alloc, 1n+fp, 1n+rp, ok)) == Nat.add(alloc, 1n+fp) : Nat}:
  match ok:
    case False{}:
      {==}
    case True{}:
      %add_succ_sym(alloc, rp) : {Nat.add(_, Nat.sub(fp, rp)) == Nat.add(alloc, 1n+fp) : Nat}
      %add_succ_sym(alloc, fp) : {1n+Nat.add(Nat.add(alloc, rp), Nat.sub(fp, rp)) == _ : Nat}
      %ih : {1n+Nat.add(Nat.add(alloc, rp), Nat.sub(fp, rp)) == 1n+_ : Nat}
      {==}

def take_if_shift(+req: Nat, +free: Nat, +alloc: Nat) -> {bin_capacity(bin_take_if(alloc, free, req, Nat.is_le(req, free))) == Nat.add(alloc, free) : Nat}:
  match req free:
    case 0n 0n:
      %add_zero_sym(Nat.add(alloc, 0n)) : {_ == Nat.add(alloc, 0n) : Nat}
      {==}
    case 0n 1n+fp:
      %add_zero_sym(alloc) : {Nat.add(_, 1n+fp) == Nat.add(alloc, 1n+fp) : Nat}
      {==}
    case 1n+rp 0n:
      {==}
    case 1n+rp 1n+fp:
      take_step(rp, fp, alloc, Nat.is_le(rp, fp), take_if_shift(rp, fp, alloc))

# promise: taking from a bin conserves its total capacity
law take_conserves_capacity:
  for +alloc: Nat
  for +free: Nat
  for +req: Nat
  {bin_capacity(bin_take(Bin{alloc, free}, req)) == Nat.add(alloc, free) : Nat}

def take_conserves_capacity(alloc, free, req):
  take_if_shift(req, free, alloc)
"#;
        fs::write(&core, src).unwrap();

        let bend = crate::resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(std::path::PathBuf::from),
        );
        let output = Command::new(&bend)
            .arg(&core)
            .arg("--check-only")
            .output()
            .expect("bend binary should execute");
        assert!(
            output.status.success(),
            "bend --check-only failed:\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );

        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        let summary = run_mutation_checks(src, &report, MutateMode::NewOnly, &out_dir)
            .expect("conservation law must catch Nat.add -> Nat.sub mutant");
        assert_eq!(summary.reports.len(), 1);
        assert!(summary.reports[0].caught_by.is_some());
        assert!(!summary.reports[0].from_cache);

        // Second run hits mutation cache
        let summary2 = run_mutation_checks(src, &report, MutateMode::NewOnly, &out_dir)
            .expect("cached mutation check succeeds");
        assert!(summary2.reports[0].from_cache);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mutate_mode_all_reports_locked_laws_without_failing() {
        let dir = tmp_dir("mode_all");
        let core = dir.join("core.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let src = r#"import Base

def inc(+n: Nat) -> Nat:
  Nat.add(n, 1n)

# promise: incrementing zero yields one
law inc_zero:
  {inc(0n) == 1n : Nat}

# promise: tautological placeholder fixture
law empty_tautology:
  for +n: Nat
  {inc(n) == inc(n) : Nat}
"#;
        fs::write(&core, src).unwrap();
        // Pre-seal both laws into the lock
        lock::enforce_law_lock(&lock_file, std::slice::from_ref(&core), true).unwrap();

        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        assert!(report.new_names.is_empty());
        assert_eq!(report.locked_names.len(), 2);

        let summary = run_mutation_checks(src, &report, MutateMode::All, &out_dir)
            .expect("MutateMode::All must report without failing on locked vacuous laws");
        assert_eq!(summary.warnings.len(), 2);
        assert!(
            summary
                .warnings
                .iter()
                .any(|w| w.contains("empty_tautology") && w.contains("SURVIVED")),
            "warnings: {:?}",
            summary.warnings
        );
        assert!(
            summary
                .warnings
                .iter()
                .any(|w| w.contains("inc_zero") && w.contains("caught by")),
            "warnings: {:?}",
            summary.warnings
        );

        let _ = fs::remove_dir_all(&dir);
    }

    const LEGACY_OPS: &[&str] = &[
        "BoolFlip",
        "NatCmpArith",
        "DropBoolOperand",
        "ReturnUnchanged",
        "SwapMatchArms",
    ];

    /// Runs only the mutants whose operator is in `ops` against `law_name`. Returns
    /// `Err` if the harness fails to compile, so a "survived" result is never a build error.
    fn eval_with_ops(
        src: &str,
        law_name: &str,
        ops: &[&str],
        out_dir: &Path,
    ) -> Result<Option<(String, String)>, String> {
        let laws = parse_laws(src);
        let law = laws.iter().find(|l| l.name == law_name).expect("law");
        let (types, defs) = parse_book_items(src)?;
        let extra = collect_law_source_slices(&laws);
        let type_env = TypeEnv::build(&types, &defs, &extra);
        let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
        let type_map: HashMap<String, &TypeDef> =
            types.iter().map(|t| (t.name.clone(), t)).collect();
        let cone = law_dependency_cone(law, &defs);
        let cone_defs: Vec<Def> = cone
            .iter()
            .filter_map(|n| def_map.get(n).map(|d| (*d).clone()))
            .collect();
        let mutants: Vec<Mutant> =
            generate_mutants_for_cone(&cone_defs, &def_map, &type_env.ctor_map)
                .into_iter()
                .filter(|m| ops.contains(&m.operator.as_str()))
                .collect();
        assert!(!mutants.is_empty(), "no {ops:?} mutants for {law_name}");
        fs::create_dir_all(out_dir).unwrap();
        run_mutant_harness(
            law, &mutants, &types, &cone_defs, &type_map, &type_env, out_dir,
        )
        .map_err(|e| match e {
            HarnessError::Compile(stderr) => format!("mutant harness did not compile:\n{stderr}"),
            HarnessError::Run => "mutant harness failed to run".to_string(),
        })
    }

    /// Operators that existed before Issue #15 (legacy + bound-pushing).
    const PRE_ISSUE15_OPS: &[&str] = &[
        "BoolFlip",
        "NatCmpArith",
        "DropBoolOperand",
        "ReturnUnchanged",
        "SwapMatchArms",
        "NatBound",
        "SiblingCtor",
        "BoolConst",
        "FlipCmp",
    ];

    fn assert_new_operator_catches(src: &str, law_name: &str, op: &str, tag: &str) {
        assert_operator_closes_gap(src, law_name, op, tag, LEGACY_OPS);
    }

    /// Asserts every operator in `prior_ops` survives `law_name` (the gap), `op` alone catches
    /// it with an id naming `op`, and the full gate accepts the law as a new law.
    fn assert_operator_closes_gap(
        src: &str,
        law_name: &str,
        op: &str,
        tag: &str,
        prior_ops: &[&str],
    ) {
        let dir = tmp_dir(tag);
        let out = dir.join("out");
        let legacy = eval_with_ops(src, law_name, prior_ops, &out)
            .expect("prior-operator mutant harness must compile");
        assert!(
            legacy.is_none(),
            "{law_name}: expected {prior_ops:?} to survive (the gap), got {legacy:?}"
        );
        let caught = eval_with_ops(src, law_name, &[op], &out)
            .expect("new-operator harness must compile")
            .unwrap_or_else(|| panic!("{law_name}: {op} must catch a mutant"));
        assert!(
            caught.0.ends_with(&format!("[{op}]")),
            "mutant id must name the operator: {caught:?}"
        );

        // The full gate accepts the new law, naming the catching operator.
        let core = dir.join("core.bend");
        fs::write(&core, src).unwrap();
        let report = lock::check_law_lock(&dir.join("rusty-bends.lock"), &[core], false).unwrap();
        let summary = run_mutation_checks(src, &report, MutateMode::NewOnly, &out)
            .expect("law must no longer be vacuous");
        let (desc, _) = summary.reports[0].caught_by.clone().expect("caught");
        assert!(
            [
                "[NatBound]",
                "[SiblingCtor]",
                "[BoolConst]",
                "[FlipCmp]",
                "[ReturnCtor]",
                "[NatLit]"
            ]
            .iter()
            .any(|t| desc.ends_with(t)),
            "caught by a new operator: {desc}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nat_bound_catches_one_direction_bound_law() {
        let src = r#"import Base

def budget_after_step(+l: Nat) -> Nat:
  match l:
    case 0n:
      0n
    case 1n+p:
      p

# promise: taking a step never grows the remaining budget
law step_budget_never_grows:
  for +l: Nat
  {Nat.is_le(budget_after_step(l), l) == True{} : Bool}
"#;
        assert_new_operator_catches(src, "step_budget_never_grows", "NatBound", "bound");
    }

    #[test]
    fn sibling_ctor_catches_absorbing_state_law() {
        let src = r#"import Base

type Job is Data:
  Queued{n: Nat}
  Running{n: Nat}
  Done{}

def job_step(+s: Job, +ev: Nat) -> Job:
  match s:
    case Queued{n}:
      Running{Nat.add(n, ev)}
    case Running{n}:
      Running{n}
    case Done{}:
      Done{}

# promise: a finished job stays finished whatever event arrives
law done_job_absorbing:
  for +ev: Nat
  {job_step(Done{}, ev) == Done{} : Job}
"#;
        assert_new_operator_catches(src, "done_job_absorbing", "SiblingCtor", "absorb");
    }

    #[test]
    fn bool_const_catches_implication_law() {
        let src = r#"import Base

def allowed(+c: Nat, +granted: Bool) -> Bool:
  match c:
    case 0n:
      True{}
    case 1n+k:
      granted

def requires(+c: Nat, +granted: Bool) -> Bool:
  match c:
    case 0n:
      False{}
    case 1n+k:
      granted

# promise: whenever a request requires a grant, it is allowed
law required_implies_allowed:
  for +c: Nat
  for +g: Bool
  {Bool.or(allowed(c, g), Bool.not(requires(c, g))) == True{} : Bool}
"#;
        assert_new_operator_catches(src, "required_implies_allowed", "BoolConst", "implies");
    }

    #[test]
    fn flip_cmp_catches_strict_refusal_law() {
        let src = r#"import Base

def count_within_limit(+count: Nat, +max: Nat) -> Bool:
  Nat.is_le(count, max)

# promise: a count above the limit is always refused
law count_above_limit_refused:
  for +m: Nat
  for +extra: Nat
  {count_within_limit(Nat.add(Nat.add(1n, m), extra), m) == False{} : Bool}
"#;
        assert_new_operator_catches(src, "count_above_limit_refused", "FlipCmp", "refuse");
    }

    #[test]
    fn bound_operators_keep_their_own_budget_after_legacy_cap() {
        // Many comparison sites saturate the legacy budget; bound families still appear.
        let mut body = String::from("Bool.and(Nat.is_le(a, b), Nat.is_le(b, a))");
        for _ in 0..30 {
            body = format!("Bool.and({body}, Nat.is_lt(a, Nat.add(b, 1n)))");
        }
        let src = format!(
            "def busy(+a: Nat, +b: Nat, +t: Bool) -> Bool:\n  Bool.and(t, {body})\n\ndef shrink(+x: Nat) -> Nat:\n  Nat.sub(x, 1n)\n"
        );
        let (types, defs) = parse_book_items(&src).unwrap();
        let env = TypeEnv::build(&types, &defs, &[]);
        let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
        let mutants = generate_mutants_for_cone(&defs, &def_map, &env.ctor_map);
        let legacy = mutants
            .iter()
            .filter(|m| LEGACY_OPS.contains(&m.operator.as_str()))
            .count();
        assert_eq!(legacy, MAX_MUTANTS_PER_LAW);
        for op in ["NatBound", "BoolConst", "FlipCmp"] {
            assert!(
                mutants.iter().any(|m| m.operator == op),
                "{op} missing after legacy cap"
            );
        }
        assert!(
            mutants.len()
                <= MAX_MUTANTS_PER_LAW
                    + MAX_BOUND_MUTANTS_PER_LAW
                    + MAX_RETURN_LIT_MUTANTS_PER_LAW
                    + MAX_ADD_MAX_MIN_MUTANTS_PER_LAW
        );
        assert!(mutants.iter().any(|m| m.operator == "NatLit"));
    }

    #[test]
    fn return_ctor_catches_fallthrough_variable_absorbing_law() {
        let src = r#"import Base

type Stage is Data:
  Draft{}
  Review{}
  Final{}

type StageEvent is Data:
  Submit{}
  Approve{}

def stage_step(p: Stage, ev: StageEvent) -> Stage:
  match p ev:
    case Draft{} Submit{}:
      Review{}
    case Review{} Approve{}:
      Final{}
    case st _:
      st

# promise: a final stage stays final whatever event arrives
law final_stage_absorbing:
  for ev: StageEvent
  {stage_step(Final{}, ev) == Final{} : Stage}
"#;
        assert_operator_closes_gap(
            src,
            "final_stage_absorbing",
            "ReturnCtor",
            "fallthrough",
            PRE_ISSUE15_OPS,
        );
    }

    #[test]
    fn return_ctor_catches_delegated_call_classifier_law() {
        let src = r#"import Base

type Size is Data:
  Small{}
  Medium{}
  Large{}

type Input is Data:
  Wrapped{a: Nat, b: Nat}
  Raw{hi: Nat}

def pair_size(+a: Nat, +b: Nat) -> Size:
  match a:
    case 10n:
      Medium{}
    case 127n:
      Large{}
    case _:
      Small{}

def raw_size(+hi: Nat) -> Size:
  match hi:
    case 0n:
      Large{}
    case _:
      Small{}

def input_size(+v: Input) -> Size:
  match v:
    case Wrapped{a, b}:
      pair_size(a, b)
    case Raw{hi}:
      raw_size(hi)

# promise: a wrapped pair is sized exactly like the pair itself
law wrapped_sized_like_pair:
  for +a: Nat
  for +b: Nat
  {input_size(Wrapped{a, b}) == pair_size(a, b) : Size}
"#;
        assert_operator_closes_gap(
            src,
            "wrapped_sized_like_pair",
            "ReturnCtor",
            "delegated_call",
            PRE_ISSUE15_OPS,
        );
    }

    #[test]
    fn nat_lit_catches_zero_rejected_law() {
        // `width = 0` is refused because width must equal 256n or 512n; changing a literal
        // (256n -> 0n) is what breaks the law.
        let src = r#"import Base

def config_valid(+n: Nat, +m: Nat, +width: Nat, +extra: Nat) -> Bool:
  Bool.and(Bool.or(Nat.is_eq(width, 256n), Nat.is_eq(width, 512n)), Nat.is_le(m, n))

# promise: a zero width is always rejected
law zero_width_rejected:
  for +n: Nat
  for +m: Nat
  for +e: Nat
  {config_valid(n, m, 0n, e) == False{} : Bool}
"#;
        let dir = tmp_dir("zero_width");
        let caught = eval_with_ops(src, "zero_width_rejected", &["NatLit"], &dir)
            .expect("harness compiles")
            .expect("NatLit catches the literal-guarded law");
        assert!(caught.0.contains("256n -> 0n [NatLit]"), "{caught:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nat_lit_respects_per_function_site_cap_and_skips_patterns() {
        let body = "match x:\n  case 7n:\n    1n\n  case _:\n    Nat.add(Nat.add(Nat.add(2n, 3n), Nat.add(4n, 5n)), Nat.add(Nat.add(6n, 8n), Nat.add(9n, 10n)))";
        let protected = compute_protected_ranges(body);
        let muts = mutate_nat_lit(body, &protected);
        assert!(
            muts.iter().all(|(_, d)| !d.starts_with("7n ")),
            "case pattern literal mutated"
        );
        let sites: HashSet<&str> = muts
            .iter()
            .map(|(_, d)| d.split(" -> ").next().unwrap())
            .collect();
        assert_eq!(sites.len(), MAX_NAT_LIT_SITES_PER_DEF);
        assert!(
            !sites.contains("10n"),
            "ninth site must be capped: {sites:?}"
        );
        assert_eq!(muts[0].1, "1n -> 0n", "-> 0n mutants come first");
    }

    const EXS_LAW_SRC: &str = r#"import Base

def double(+n: Nat) -> Nat:
  Nat.add(n, n)

# promise: some input doubles to four
law double_hits_four:
  exs n: Nat
  {double(n) == 4n : Nat}
"#;

    #[test]
    fn new_unevaluable_law_fails_with_e_law_unchecked() {
        let dir = tmp_dir("unchecked_fail");
        let core = dir.join("core.bend");
        let lock_file = dir.join("rusty-bends.lock");
        fs::write(&core, EXS_LAW_SRC).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), true).unwrap();
        let err = run_mutation_checks(EXS_LAW_SRC, &report, MutateMode::NewOnly, &dir.join("o"))
            .expect_err("an unevaluable new law must not be sealable without a marker");
        assert!(err.contains("[E_LAW_UNCHECKED]"), "got: {err}");
        assert!(err.contains("double_hits_four"), "got: {err}");
        assert!(err.contains("exs"), "reason must be named: {err}");
        assert!(
            err.contains("Supported forms"),
            "supported forms listed: {err}"
        );
        assert!(err.contains("# unchecked:"), "marker hint: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unchecked_marker_admits_law_and_is_locked_and_listed() {
        let dir = tmp_dir("unchecked_ok");
        let core = dir.join("core.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let src = EXS_LAW_SRC.replace(
            "# promise: some input doubles to four\n",
            "# promise: some input doubles to four\n# unchecked: existential witness is proved by Bend, not sampled\n",
        );
        fs::write(&core, &src).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), true).unwrap();
        let summary = run_mutation_checks(&src, &report, MutateMode::NewOnly, &dir.join("o"))
            .expect("marked law passes");
        assert!(
            summary
                .warnings
                .iter()
                .any(|w| w.contains("UNCHECKED")
                    && w.contains("existential witness is proved by Bend")),
            "warnings: {:?}",
            summary.warnings
        );
        assert!(report.serialized.contains(
            "# unchecked double_hits_four: existential witness is proved by Bend, not sampled"
        ));
        let listing = lock::format_law_list(&report.current);
        assert_eq!(
            listing,
            "double_hits_four: some input doubles to four [unchecked: existential witness is proved by Bend, not sampled]"
        );

        // Once sealed, the law is locked and only warns (even with the marker removed).
        lock::write_law_lock(&lock_file, &report).unwrap();
        fs::write(&core, EXS_LAW_SRC).unwrap();
        let locked = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        assert!(locked.new_names.is_empty());
        let all = run_mutation_checks(EXS_LAW_SRC, &locked, MutateMode::All, &dir.join("o"))
            .expect("locked unevaluable laws warn, never fail");
        assert!(all.warnings.iter().any(|w| w.contains("skipped")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unnecessary_unchecked_marker_is_reported() {
        let dir = tmp_dir("unchecked_unneeded");
        let core = dir.join("core.bend");
        let src = r#"import Base

def inc(+n: Nat) -> Nat:
  Nat.add(n, 1n)

# promise: incrementing zero yields one
# unchecked: not really needed
law inc_zero:
  {inc(0n) == 1n : Nat}
"#;
        fs::write(&core, src).unwrap();
        let report = lock::check_law_lock(&dir.join("rusty-bends.lock"), &[core], false).unwrap();
        let summary = run_mutation_checks(src, &report, MutateMode::NewOnly, &dir.join("o"))
            .expect("checkable law passes");
        assert!(
            summary
                .warnings
                .iter()
                .any(|w| w.contains("is unnecessary")),
            "warnings: {:?}",
            summary.warnings
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rust_keyword_names_are_mutation_checked_not_vacuous() {
        // Exact reproducer from issue #16: `as` is a Rust keyword.
        let dir = tmp_dir("keyword_vacuous");
        let core = dir.join("core.bend");
        let src = r#"import Base

def keep(as: Nat) -> Nat:
  as

# promise: keep returns its input.
law keep_same:
  for as: Nat
  {keep(as) == as : Nat}

def keep_same(as):
  {==}
"#;
        fs::write(&core, src).unwrap();
        let report = lock::check_law_lock(&dir.join("rusty-bends.lock"), &[core], false).unwrap();
        let summary = run_mutation_checks(src, &report, MutateMode::NewOnly, &dir.join("o"))
            .expect("a keyword-named law must not be reported vacuous");
        let (desc, _) = summary.reports[0].caught_by.clone().expect("caught");
        assert!(desc.ends_with("[NatBound]"), "caught by: {desc}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mutant_that_does_not_compile_is_a_tool_error_not_a_survivor() {
        let dir = tmp_dir("mutant_build");
        let src = r#"import Base

def keep(+n: Nat) -> Nat:
  n

law keep_same:
  for +n: Nat
  {keep(n) == n : Nat}
"#;
        let laws = parse_laws(src);
        let law = &laws[0];
        let (types, defs) = parse_book_items(src).unwrap();
        let type_env = TypeEnv::build(&types, &defs, &collect_law_source_slices(&laws));
        let type_map: HashMap<String, &TypeDef> =
            types.iter().map(|t| (t.name.clone(), t)).collect();
        // `True{}` emits a Rust `bool` where a `u64` is expected, so rustc rejects it.
        let bad = Mutant {
            operator: "Test".to_string(),
            description: "keep: body -> True{} [Test]".to_string(),
            def_name: "keep".to_string(),
            mutated_body: "True{}".to_string(),
        };
        let err = evaluate_mutants_batch(law, &[bad], &types, &defs, &type_map, &type_env, &dir)
            .expect_err("an uncompilable mutant must not count as a survivor");
        assert!(err.contains("[E_MUTANT_BUILD]"), "{err}");
        assert!(err.contains("keep: body -> True{} [Test]"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mutate_mode_all_covers_new_laws_and_report_mode_lists_every_mutant_and_caches() {
        let dir = tmp_dir("issue19_report");
        let core = dir.join("ledger.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let base_src = r#"import Base

def total_items(+a: Nat, +b: Nat) -> Nat:
  Nat.add(a, b)

def bump(+n: Nat) -> Nat:
  1n+n

# promise: the total never drops below the first delivery
law total_covers_first:
  for +a: Nat
  for +b: Nat
  {Nat.is_le(a, total_items(a, b)) == True{} : Bool}

# promise: a write always changes the stamp
law bump_changes:
  for +m: Nat
  {Nat.is_eq(m, bump(m)) == False{} : Bool}
"#;
        fs::write(&core, base_src).unwrap();
        lock::enforce_law_lock(&lock_file, std::slice::from_ref(&core), true).unwrap();

        let with_new_src = format!(
            "{base_src}\n# promise: the total never drops below the second delivery\nlaw total_covers_second:\n  for +a: Nat\n  for +b: Nat\n  {{Nat.is_le(b, total_items(a, b)) == True{{}} : Bool}}\n"
        );
        fs::write(&core, &with_new_src).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        assert!(report.new_names.contains("total_covers_second"));
        assert!(report.locked_names.contains("total_covers_first"));
        assert!(report.locked_names.contains("bump_changes"));

        // `RUSTY_BENDS_MUTATE=all` covers both locked laws AND new laws.
        let all_summary = run_mutation_checks(&with_new_src, &report, MutateMode::All, &out_dir)
            .expect("MutateMode::All covers new and locked laws");
        assert!(all_summary.report_path.is_none());
        assert_eq!(all_summary.warnings.len(), 3, "{:?}", all_summary.warnings);
        for name in ["total_covers_first", "bump_changes", "total_covers_second"] {
            assert!(
                all_summary
                    .warnings
                    .iter()
                    .any(|w| w.contains(&format!("[{name}]"))),
                "missing {name} in =all output: {:?}",
                all_summary.warnings
            );
        }

        // `RUSTY_BENDS_MUTATE=report` evaluates EVERY mutant of every law and writes OUT_DIR/rusty-bends-mutants.txt.
        let rep_summary = run_mutation_checks(&with_new_src, &report, MutateMode::Report, &out_dir)
            .expect("MutateMode::Report evaluates every mutant");
        let report_path = rep_summary.report_path.as_ref().expect("report_path");
        assert!(report_path.ends_with("rusty-bends-mutants.txt"));
        assert!(report_path.exists());
        let file_text = fs::read_to_string(report_path).unwrap();

        let first = rep_summary
            .reports
            .iter()
            .find(|r| r.law_name == "total_covers_first")
            .unwrap();
        assert!(!first.from_cache, "upgrade from FIRST to FULL must re-run");
        for expected_desc in [
            "total_items: Nat.add -> Nat.sub [NatCmpArith]",
            "total_items: Nat.add -> Nat.mul [NatCmpArith]",
            "total_items: return parameter 'a' unchanged [ReturnUnchanged]",
            "total_items: return parameter 'b' unchanged [ReturnUnchanged]",
            "total_items: result -> Nat.add(result, 1n) [NatBound]",
            "total_items: result -> Nat.sub(result, 1n) [NatBound]",
            "total_items: result -> 0n [NatBound]",
        ] {
            assert!(
                first
                    .mutant_outcomes
                    .iter()
                    .any(|o| o.description == expected_desc),
                "missing {expected_desc} in {:?}",
                first.mutant_outcomes
            );
            assert!(
                file_text.contains(expected_desc),
                "missing {expected_desc} in file:\n{file_text}"
            );
        }
        assert!(first.mutant_outcomes.iter().any(|o| {
            o.description == "total_items: result -> Nat.add(result, 1n) [NatBound]"
                && matches!(o.status, MutantStatus::Survived)
        }));
        assert!(first.mutant_outcomes.iter().any(|o| {
            o.description == "total_items: Nat.add -> Nat.sub [NatCmpArith]"
                && matches!(o.status, MutantStatus::Caught(_))
        }));

        // Second Report run hits cache with identical per-mutant outcomes.
        let rep_cached = run_mutation_checks(&with_new_src, &report, MutateMode::Report, &out_dir)
            .expect("cached report run succeeds");
        for r in &rep_cached.reports {
            assert!(r.from_cache, "expected {} to hit cache", r.law_name);
        }
        let first_cached = rep_cached
            .reports
            .iter()
            .find(|r| r.law_name == "total_covers_first")
            .unwrap();
        assert_eq!(first_cached.mutant_outcomes, first.mutant_outcomes);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mutation_reports_dropped_by_budget_and_site_cap_and_caches_survived() {
        let dir = tmp_dir("issue19_dropped_and_survived");
        let core = dir.join("core.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        // Build a def with > 8 Nat literal sites AND > 48 legacy comparisons so both caps trigger.
        let mut expr = String::from("Bool.and(Nat.is_eq(x, 1n), Nat.is_eq(x, 2n))");
        for k in 3..=45 {
            expr = format!("Bool.and({expr}, Nat.is_eq(x, {k}n))");
        }
        let src = format!(
            "import Base\n\ndef many_checks(+x: Nat) -> Bool:\n  {expr}\n\n# promise: tautology fixture\nlaw many_taut:\n  for +x: Nat\n  {{many_checks(x) == many_checks(x) : Bool}}\n"
        );
        fs::write(&core, &src).unwrap();
        lock::enforce_law_lock(&lock_file, std::slice::from_ref(&core), true).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();

        let summary = run_mutation_checks(&src, &report, MutateMode::All, &out_dir)
            .expect("locked surviving law runs under MutateMode::All");
        assert_eq!(summary.reports.len(), 1);
        let r = &summary.reports[0];
        assert!(r.dropped_by_budget > 0, "{r:?}");
        assert!(r.dropped_by_site_cap > 0, "{r:?}");
        assert!(
            summary.warnings[0].contains("dropped by budget")
                && summary.warnings[0].contains("dropped by site cap"),
            "warnings: {:?}",
            summary.warnings
        );

        // Warm All run hits cached SURVIVED entry without recompiling.
        let summary2 = run_mutation_checks(&src, &report, MutateMode::All, &out_dir).unwrap();
        assert!(summary2.reports[0].from_cache);
        assert!(summary2.warnings[0].contains("[cached]"));

        // Warm Report run upgrades from First::Survived cleanly.
        let summary_rep = run_mutation_checks(&src, &report, MutateMode::Report, &out_dir).unwrap();
        assert!(summary_rep.reports[0].from_cache);
        assert!(!summary_rep.reports[0].mutant_outcomes.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn batched_multi_law_evaluation_handles_many_laws_and_keyword_report() {
        let dir = tmp_dir("issue19_batch");
        let core = dir.join("core.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let src = r#"import Base

def loop(+as: Nat) -> Nat:
  Nat.add(as, 1n)

def double(+x: Nat) -> Nat:
  Nat.add(x, x)

def clamp_zero(+x: Nat) -> Nat:
  Nat.sub(x, x)

def is_nonzero(+x: Nat) -> Bool:
  Nat.is_gt(x, 0n)

# promise: loop increments zero to one
law loop_zero:
  {loop(0n) == 1n : Nat}

# promise: loop is strictly above input
law loop_above:
  for +as: Nat
  {Nat.is_lt(as, loop(as)) == True{} : Bool}

# promise: doubling two gives four
law double_two:
  {double(2n) == 4n : Nat}

# promise: subtracting self gives zero
law clamp_zero_ok:
  for +x: Nat
  {clamp_zero(x) == 0n : Nat}

# promise: one is nonzero
law one_nonzero:
  {is_nonzero(1n) == True{} : Bool}
"#;
        fs::write(&core, src).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        let summary = run_mutation_checks(src, &report, MutateMode::Report, &out_dir)
            .expect("batched report over 5 laws including keyword names succeeds");
        assert_eq!(summary.reports.len(), 5);
        for r in &summary.reports {
            assert!(r.caught_by.is_some(), "{} was not caught", r.law_name);
        }

        // Verify batch fallback preserves valid laws while isolating an uncompilable mutant.
        let laws = parse_laws(src);
        let (types, defs) = parse_book_items(src).unwrap();
        let type_env = TypeEnv::build(&types, &defs, &collect_law_source_slices(&laws));
        let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
        let type_map: HashMap<String, &TypeDef> =
            types.iter().map(|t| (t.name.clone(), t)).collect();
        let bad_mutant = Mutant {
            operator: "Test".to_string(),
            description: "double: body -> True{} [Test]".to_string(),
            def_name: "double".to_string(),
            mutated_body: "True{}".to_string(),
        };
        let good_defs = vec![def_map["loop"].clone()];
        let good_muts = generate_mutants_for_cone(&good_defs, &def_map, &type_env.ctor_map);
        let bad_defs = vec![def_map["double"].clone()];
        let work = vec![
            LawWorkItem {
                prepared_idx: 0,
                law: &laws[0],
                is_locked: false,
                cone_defs: &good_defs,
                mutants: &good_muts,
            },
            LawWorkItem {
                prepared_idx: 1,
                law: &laws[2],
                is_locked: false,
                cone_defs: &bad_defs,
                mutants: std::slice::from_ref(&bad_mutant),
            },
        ];
        let res = evaluate_work_items_batched(&work, &types, &type_map, &type_env, true, &out_dir)
            .unwrap();
        assert!(matches!(res[0], EvaluatedLawResult::Complete { .. }));
        assert!(matches!(res[1], EvaluatedLawResult::BuildFailed { .. }));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nat_add_max_min_exposes_max_replacement_survivor_on_bound_laws_and_catches_sum_bound() {
        let dir = tmp_dir("issue20_add_max_min");
        let core = dir.join("ledger.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let bound_only_src = r#"import Base

def total_items(+a: Nat, +b: Nat) -> Nat:
  Nat.add(a, b)

# promise: the total never drops below the first delivery
law total_covers_first:
  for +a: Nat
  for +b: Nat
  {Nat.is_le(a, total_items(a, b)) == True{} : Bool}

# promise: the total never drops below the second delivery
law total_covers_second:
  for +a: Nat
  for +b: Nat
  {Nat.is_le(b, total_items(a, b)) == True{} : Bool}
"#;
        fs::write(&core, bound_only_src).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        let rep = run_mutation_checks(bound_only_src, &report, MutateMode::Report, &out_dir)
            .expect("bound laws catch other mutants while exposing Nat.add -> Nat.max");

        for law_name in ["total_covers_first", "total_covers_second"] {
            let r = rep.reports.iter().find(|r| r.law_name == law_name).unwrap();
            assert!(
                r.mutant_outcomes.iter().any(|o| {
                    o.description == "total_items: Nat.add -> Nat.max [NatAddMaxMin]"
                        && matches!(o.status, MutantStatus::Survived)
                }),
                "{law_name} must report Nat.add -> Nat.max as survived: {:?}",
                r.mutant_outcomes
            );
            assert!(
                r.mutant_outcomes.iter().any(|o| {
                    o.description == "total_items: Nat.add -> Nat.min [NatAddMaxMin]"
                        && matches!(o.status, MutantStatus::Caught(_))
                }),
                "{law_name} must catch Nat.add -> Nat.min: {:?}",
                r.mutant_outcomes
            );
        }

        // Adding a law requiring at least the sum catches `Nat.add -> Nat.max`.
        let with_sum_law = format!(
            "{bound_only_src}\n# promise: the total is at least the sum of both deliveries\nlaw total_at_least_sum:\n  for +a: Nat\n  for +b: Nat\n  {{Nat.is_le(Nat.add(a, b), total_items(a, b)) == True{{}} : Bool}}\n"
        );
        fs::write(&core, &with_sum_law).unwrap();
        let report2 = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        let rep2 = run_mutation_checks(&with_sum_law, &report2, MutateMode::Report, &out_dir)
            .expect("sum bound law passes");
        let sum_rep = rep2
            .reports
            .iter()
            .find(|r| r.law_name == "total_at_least_sum")
            .unwrap();
        assert!(
            sum_rep.mutant_outcomes.iter().any(|o| {
                o.description == "total_items: Nat.add -> Nat.max [NatAddMaxMin]"
                    && matches!(o.status, MutantStatus::Caught(_))
            }),
            "total_at_least_sum must catch Nat.add -> Nat.max: {:?}",
            sum_rep.mutant_outcomes
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nat_add_max_min_covers_max_min_to_add_infix_nat_and_keyword_names() {
        let dir = tmp_dir("issue20_variants");
        let core = dir.join("variants.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let src = r#"import Base

def loop(+as: Nat, +in: Nat) -> Nat:
  ((as + in : Nat) + 1n : Nat)

def pick_hi(+a: Nat, +b: Nat) -> Nat:
  Nat.max(a, b)

def pick_lo(+a: Nat, +b: Nat) -> Nat:
  Nat.min(a, b)

def wrap_u32(+a: U32, +b: U32) -> U32:
  (a + b : U32)

# promise: loop adds one past the sum
law loop_exact:
  for +as: Nat
  for +in: Nat
  {loop(as, in) == Nat.add(Nat.add(as, in), 1n) : Nat}

# promise: pick_hi matches Nat.max
law pick_hi_eq:
  for +a: Nat
  for +b: Nat
  {pick_hi(a, b) == Nat.max(a, b) : Nat}

# promise: pick_lo matches Nat.min
law pick_lo_eq:
  for +a: Nat
  for +b: Nat
  {pick_lo(a, b) == Nat.min(a, b) : Nat}

# promise: wrap_u32 wraps on addition
law wrap_u32_eq:
  for +a: U32
  for +b: U32
  {wrap_u32(a, b) == (a + b : U32) : U32}
"#;
        fs::write(&core, src).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        let summary = run_mutation_checks(src, &report, MutateMode::Report, &out_dir)
            .expect("NatAddMaxMin variants compile and evaluate cleanly");

        let loop_rep = summary
            .reports
            .iter()
            .find(|r| r.law_name == "loop_exact")
            .unwrap();
        assert!(
            loop_rep.mutant_outcomes.iter().any(|o| {
                o.description == "loop: (+ : Nat) -> Nat.max [NatAddMaxMin]"
                    && matches!(o.status, MutantStatus::Caught(_))
            }),
            "{:?}",
            loop_rep.mutant_outcomes
        );
        assert!(
            loop_rep.mutant_outcomes.iter().any(|o| {
                o.description == "loop: (+ : Nat) -> Nat.min [NatAddMaxMin]"
                    && matches!(o.status, MutantStatus::Caught(_))
            }),
            "{:?}",
            loop_rep.mutant_outcomes
        );

        let hi_rep = summary
            .reports
            .iter()
            .find(|r| r.law_name == "pick_hi_eq")
            .unwrap();
        assert!(
            hi_rep.mutant_outcomes.iter().any(|o| {
                o.description == "pick_hi: Nat.max -> Nat.add [NatAddMaxMin]"
                    && matches!(o.status, MutantStatus::Caught(_))
            }),
            "{:?}",
            hi_rep.mutant_outcomes
        );

        let lo_rep = summary
            .reports
            .iter()
            .find(|r| r.law_name == "pick_lo_eq")
            .unwrap();
        assert!(
            lo_rep.mutant_outcomes.iter().any(|o| {
                o.description == "pick_lo: Nat.min -> Nat.add [NatAddMaxMin]"
                    && matches!(o.status, MutantStatus::Caught(_))
            }),
            "{:?}",
            lo_rep.mutant_outcomes
        );

        let u32_rep = summary
            .reports
            .iter()
            .find(|r| r.law_name == "wrap_u32_eq")
            .unwrap();
        assert!(
            !u32_rep
                .mutant_outcomes
                .iter()
                .any(|o| o.operator == "NatAddMaxMin"),
            "U32 infix + must not produce NatAddMaxMin mutants: {:?}",
            u32_rep.mutant_outcomes
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn return_ctor_mutates_whole_multiline_call_and_skips_nested_args_and_let_rhs() {
        let dir = tmp_dir("issue23_multiline_return_ctor");
        let core = dir.join("steps.bend");
        let lock_file = dir.join("rusty-bends.lock");
        let out_dir = dir.join("out");

        let src = r#"import Base

type Step is Data:
  Go{}
  Stop{}

def is_done(+a: Nat, +b: Nat) -> Bool:
  Nat.is_le(
    a,
    b
  )

def step_pick(ready: Bool, done: Bool) -> Step:
  match ready:
    case True{}:
      Go{}
    case False{}:
      Stop{}

def step_next(+ready: Bool, +done: Bool) -> Step:
  step_pick(
    ready,
    done
  )

def step_with_call_arg(+ready: Bool, +a: Nat, +b: Nat) -> Step:
  step_pick(
    ready,
    is_done(a, b)
  )

def step_with_let_and_branch(+ready: Bool, +a: Nat, +b: Nat) -> Step:
  let ok =
    is_done(
      a,
      b)
  match step_pick(ready, ok):
    case Go{}:
      if ok:
        step_pick(
          ready,
          False{}
        )
      else:
        step_pick(
          ready,
          True{}
        )
    case Stop{}:
      Stop{}

def loop(+as: Bool, +self: Bool) -> Step:
  step_pick(
    as,
    self
  )

# promise: a ready step goes
law step_ready_goes:
  for +d: Bool
  {step_next(True{}, d) == Go{} : Step}

# promise: when a <= b a ready step goes cleanly
law step_call_arg_ready:
  for +a: Nat
  for +b: Nat
  {step_with_call_arg(True{}, a, b) == Go{} : Step}

# promise: a step with let/match/if returns Go when ready
law step_let_branch_ready:
  for +a: Nat
  for +b: Nat
  {step_with_let_and_branch(True{}, a, b) == Go{} : Step}

# promise: ordering check matches Nat.is_le
law is_done_ok:
  for +a: Nat
  for +b: Nat
  {is_done(a, b) == Nat.is_le(a, b) : Bool}

# promise: keyword-named wrapper delegates to step_pick
law loop_ready_goes:
  for +self: Bool
  {loop(True{}, self) == Go{} : Step}
"#;
        fs::write(&core, src).unwrap();
        let report = lock::check_law_lock(&lock_file, std::slice::from_ref(&core), false).unwrap();
        let summary = run_mutation_checks(src, &report, MutateMode::Report, &out_dir)
            .expect("multi-line calls and let/match/if bodies must compile without E_MUTANT_BUILD");

        for rep in &summary.reports {
            assert!(
                !rep.mutant_outcomes
                    .iter()
                    .any(|o| matches!(o.status, MutantStatus::BuildError(_))),
                "{} had build errors: {:?}",
                rep.law_name,
                rep.mutant_outcomes
            );
            for o in &rep.mutant_outcomes {
                assert!(
                    !o.description.contains('\n'),
                    "mutant description must stay single-line: {:?}",
                    o.description
                );
            }
        }

        let next_rep = summary
            .reports
            .iter()
            .find(|r| r.law_name == "step_ready_goes")
            .unwrap();
        assert!(
            next_rep.mutant_outcomes.iter().any(|o| {
                o.operator == "ReturnCtor"
                    && o.description
                        == "step_next: returned call 'step_pick(ready, done)' -> Step.Stop{} [ReturnCtor]"
                    && matches!(o.status, MutantStatus::Caught(_))
            }),
            "{:?}",
            next_rep.mutant_outcomes
        );
        assert!(
            !next_rep
                .mutant_outcomes
                .iter()
                .any(|o| o.description.contains("returned variable 'done'")),
            "must never mutate last argument 'done': {:?}",
            next_rep.mutant_outcomes
        );

        let arg_rep = summary
            .reports
            .iter()
            .find(|r| r.law_name == "step_call_arg_ready")
            .unwrap();
        assert!(
            arg_rep.mutant_outcomes.iter().any(|o| {
                o.operator == "ReturnCtor"
                    && o.description
                        .contains("returned call 'step_pick(ready, is_done(a, b))'")
            }),
            "{:?}",
            arg_rep.mutant_outcomes
        );
        assert!(
            !arg_rep
                .mutant_outcomes
                .iter()
                .any(|o| o.description.contains("returned call 'is_done(a, b)'")),
            "must never mutate nested call argument 'is_done(a, b)': {:?}",
            arg_rep.mutant_outcomes
        );

        let kw_rep = summary
            .reports
            .iter()
            .find(|r| r.law_name == "loop_ready_goes")
            .unwrap();
        assert!(
            kw_rep.mutant_outcomes.iter().any(|o| {
                o.operator == "ReturnCtor"
                    && o.description
                        .contains("returned call 'step_pick(as, self)'")
                    && matches!(o.status, MutantStatus::Caught(_))
            }),
            "{:?}",
            kw_rep.mutant_outcomes
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn locked_mutant_build_error_emits_separate_single_line_warnings() {
        let dir = tmp_dir("issue23_locked_build_warn");
        let src = r#"import Base

def keep(+n: Nat) -> Nat:
  n

law keep_same:
  for +n: Nat
  {keep(n) == n : Nat}
"#;
        let laws = parse_laws(src);
        let law = &laws[0];
        let (types, defs) = parse_book_items(src).unwrap();
        let type_env = TypeEnv::build(&types, &defs, &collect_law_source_slices(&laws));
        let type_map: HashMap<String, &TypeDef> =
            types.iter().map(|t| (t.name.clone(), t)).collect();
        let bad = Mutant {
            operator: "Test".to_string(),
            description: "keep: body -> True{} [Test]".to_string(),
            def_name: "keep".to_string(),
            mutated_body: "True{}".to_string(),
        };
        let item = LawWorkItem {
            prepared_idx: 0,
            law,
            is_locked: true,
            cone_defs: &defs,
            mutants: std::slice::from_ref(&bad),
        };
        let EvaluatedLawResult::BuildFailed { error_message, .. } =
            run_single_law_per_mutant_fallback(&item, &types, &type_map, &type_env, false, &dir)
        else {
            panic!("expected BuildFailed for uncompilable mutant");
        };
        let mut warnings = Vec::new();
        emit_law_build_warnings(&law.name, &error_message, &mut warnings);
        assert_eq!(warnings.len(), 3, "{warnings:?}");
        for w in &warnings {
            assert!(!w.contains('\n'), "warning must not contain newline: {w:?}");
            assert!(
                w.starts_with("RustyBends mutate [keep_same]: "),
                "unexpected prefix: {w:?}"
            );
        }
        assert!(warnings[0].contains("[E_MUTANT_BUILD]"), "{warnings:?}");
        assert!(
            warnings[1].contains("First failing mutant: keep: body -> True{} [Test]"),
            "{warnings:?}"
        );
        assert!(warnings[2].contains("rustc:"), "{warnings:?}");

        let _ = fs::remove_dir_all(&dir);
    }
}
