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
    split_case_arm, split_top_level, split_top_level_once, CtorInfo, Def, Quantity, TypeDef,
    TypeEnv,
};
use crate::law_test::{
    create_temp_eval_dir, emit_eval_law_checker, emit_pool_runtime_helpers, law_dependency_cone,
    parse_laws, ParsedLaw,
};
use crate::lock::{self, LockCheckReport};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;

/// Budget for the original operator families (selection order unchanged since Issue #6).
const MAX_MUTANTS_PER_LAW: usize = 48;
/// Separate budget for the bound-pushing operator families (Issue #12), shared round-robin
/// so every family is represented even when the legacy families fill their budget.
const MAX_BOUND_MUTANTS_PER_LAW: usize = 48;

/// Law shapes the mutation checker (and the generated per-law tests) can evaluate.
const SUPPORTED_LAW_FORMS: &str = "Supported forms: zero or more 'for x: T' binders (T = Nat, Bool, U32/U64/I32/I64, a user ADT, List<T>, or a tuple of these), optional '{a == b : T} ->' hypotheses, and an equality goal '{lhs == rhs : T}'. Not supported: 'exs' (existential), 'where' refinements, goals without '=='.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutateMode {
    NewOnly,
    All,
}

impl MutateMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "all" => Self::All,
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
pub struct LawMutationReport {
    pub law_name: String,
    pub cone: Vec<String>,
    pub total_mutants: usize,
    pub caught_by: Option<(String, String)>,
    pub survived_operators: Vec<String>,
    pub skipped_reason: Option<String>,
    pub from_cache: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationRunSummary {
    pub reports: Vec<LawMutationReport>,
    pub warnings: Vec<String>,
}

struct MutateCtx<'a> {
    types: &'a [TypeDef],
    defs: &'a [Def],
    def_map: &'a HashMap<String, &'a Def>,
    type_map: &'a HashMap<String, &'a TypeDef>,
    type_env: &'a TypeEnv,
    out_dir: &'a Path,
}

/// Runs mutation checks according to `mode`:
/// - Always checks every unlocked/new law in `lock_report.new_names` and fails with
///   `[E_LAW_VACUOUS]` if any testable new law fails to catch at least one mutant.
/// - Under `MutateMode::All`, also evaluates every locked law and emits one warning line
///   per locked law (`CAUGHT` or `SURVIVED`) without failing on locked laws.
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
        });
    }

    let check_targets: Vec<&ParsedLaw> = all_laws
        .iter()
        .filter(|l| {
            lock_report.new_names.contains(&l.name)
                || (mode == MutateMode::All && lock_report.locked_names.contains(&l.name))
        })
        .collect();

    if check_targets.is_empty() {
        return Ok(MutationRunSummary {
            reports: Vec::new(),
            warnings: Vec::new(),
        });
    }

    let (types, defs) = parse_book_items(combined_source)?;
    let extra_sources = collect_law_source_slices(&all_laws);
    let type_env = TypeEnv::build(&types, &defs, &extra_sources);
    let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
    let type_map: HashMap<String, &TypeDef> = types.iter().map(|t| (t.name.clone(), t)).collect();

    fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let cache_path = out_dir.join("rusty-bends-mutate.cache");
    let mut cache = load_mutate_cache(&cache_path);
    let mut cache_dirty = false;

    let mut reports = Vec::new();
    let mut warnings = Vec::new();

    let ctx = MutateCtx {
        types: &types,
        defs: &defs,
        def_map: &def_map,
        type_map: &type_map,
        type_env: &type_env,
        out_dir,
    };

    for law in check_targets {
        let is_locked = lock_report.locked_names.contains(&law.name);
        let cone = law_dependency_cone(law, &defs);
        let cone_key = compute_cone_hash(law, &cone, &types, &def_map);

        let report = if let Some((desc, ce)) = cache.get(&cone_key).cloned() {
            LawMutationReport {
                law_name: law.name.clone(),
                cone: cone.clone(),
                total_mutants: 1,
                caught_by: Some((desc, ce)),
                survived_operators: Vec::new(),
                skipped_reason: None,
                from_cache: true,
            }
        } else {
            let r = check_single_law(law, &cone, &ctx)?;
            if let Some((ref desc, ref ce)) = r.caught_by {
                cache.insert(cone_key, (desc.clone(), ce.clone()));
                cache_dirty = true;
            }
            r
        };

        let unchecked_marker = lock_report
            .current
            .get(&law.name)
            .and_then(|l| l.unchecked.as_deref());

        if is_locked && mode == MutateMode::All {
            warnings.push(format_locked_law_line(&report));
        } else if !is_locked {
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
                return Err(format!(
                    "[E_LAW_VACUOUS] Law '{}' is vacuous: it caught 0 mutants across [{cone_str}] (survived {} mutants: {ops_str}).\nHint: Strengthen '{}' so it fails when its target function is broken.",
                    report.law_name, report.total_mutants, report.law_name
                ));
            }
            if report.skipped_reason.is_none() {
                if let Some(marker) = unchecked_marker {
                    warnings.push(format!(
                        "RustyBends mutate [{}]: '# unchecked: {marker}' is unnecessary; the law is mutation-checkable, so remove the marker.",
                        report.law_name
                    ));
                }
            }
        }

        reports.push(report);
    }

    if cache_dirty {
        save_mutate_cache(&cache_path, &cache)?;
    }

    Ok(MutationRunSummary { reports, warnings })
}

pub fn format_locked_law_line(report: &LawMutationReport) -> String {
    if let Some((ref desc, ref ce)) = report.caught_by {
        let cached_tag = if report.from_cache { " [cached]" } else { "" };
        format!(
            "RustyBends mutate [{}]: caught by {desc} ({ce}){cached_tag}",
            report.law_name
        )
    } else if let Some(ref reason) = report.skipped_reason {
        format!(
            "RustyBends mutate [{}]: skipped ({reason})",
            report.law_name
        )
    } else {
        let ops = if report.survived_operators.is_empty() {
            "none".to_string()
        } else {
            report.survived_operators.join(", ")
        };
        format!(
            "RustyBends mutate [{}]: SURVIVED ({} mutants: {ops})",
            report.law_name, report.total_mutants
        )
    }
}

fn check_single_law(
    law: &ParsedLaw,
    cone: &[String],
    ctx: &MutateCtx<'_>,
) -> Result<LawMutationReport, String> {
    if let Some(ref reason) = law.unsupported_reason {
        return Ok(LawMutationReport {
            law_name: law.name.clone(),
            cone: cone.to_vec(),
            total_mutants: 0,
            caught_by: None,
            survived_operators: Vec::new(),
            skipped_reason: Some(reason.clone()),
            from_cache: false,
        });
    }

    let mut cone_defs: Vec<Def> = Vec::new();
    for name in cone {
        if let Some(def) = ctx.def_map.get(name) {
            cone_defs.push((*def).clone());
        }
    }

    let mutants = generate_mutants_for_cone(&cone_defs, ctx.def_map, &ctx.type_env.ctor_map);
    if mutants.is_empty() {
        return Ok(LawMutationReport {
            law_name: law.name.clone(),
            cone: cone.to_vec(),
            total_mutants: 0,
            caught_by: None,
            survived_operators: Vec::new(),
            skipped_reason: None,
            from_cache: false,
        });
    }

    // Verify the law expression itself can be lowered into an eval checker before mutating.
    if let Err(reason) = emit_eval_law_checker(
        "check",
        law,
        ctx.defs,
        ctx.def_map,
        ctx.type_map,
        ctx.type_env,
        true,
    ) {
        return Ok(LawMutationReport {
            law_name: law.name.clone(),
            cone: cone.to_vec(),
            total_mutants: mutants.len(),
            caught_by: None,
            survived_operators: Vec::new(),
            skipped_reason: Some(reason),
            from_cache: false,
        });
    }

    let ops: Vec<String> = mutants
        .iter()
        .map(|m| m.operator.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();

    let caught = evaluate_mutants_batch(
        law,
        &mutants,
        ctx.types,
        &cone_defs,
        ctx.type_map,
        ctx.type_env,
        ctx.out_dir,
    )?;
    Ok(LawMutationReport {
        law_name: law.name.clone(),
        cone: cone.to_vec(),
        total_mutants: mutants.len(),
        caught_by: caught,
        survived_operators: ops,
        skipped_reason: None,
        from_cache: false,
    })
}

fn evaluate_mutants_batch(
    law: &ParsedLaw,
    mutants: &[Mutant],
    types: &[TypeDef],
    cone_defs: &[Def],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    out_dir: &Path,
) -> Result<Option<(String, String)>, String> {
    match run_mutant_harness(law, mutants, types, cone_defs, type_map, type_env, out_dir) {
        Ok(res) => Ok(res),
        Err(_) => {
            // If one mutant produced a Rust compile/type error inside a combined module,
            // fall back to checking each mutant individually and skip invalid mutants.
            for m in mutants {
                if let Ok(Some(hit)) = run_mutant_harness(
                    law,
                    std::slice::from_ref(m),
                    types,
                    cone_defs,
                    type_map,
                    type_env,
                    out_dir,
                ) {
                    return Ok(Some(hit));
                }
            }
            Ok(None)
        }
    }
}

fn run_mutant_harness(
    law: &ParsedLaw,
    mutants: &[Mutant],
    types: &[TypeDef],
    cone_defs: &[Def],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    out_dir: &Path,
) -> Result<Option<(String, String)>, String> {
    let mut program = String::new();
    program.push_str("#![allow(clippy::all, non_snake_case, unused_variables, unused_parens, dead_code, unused_mut)]\n");

    let types_only = emit_items_to_rust(types, &[], type_env, 0, None, true)?;
    program.push_str(&types_only.rust_source);
    program.push('\n');
    program.push_str(&emit_pool_runtime_helpers(types, type_map, type_env, true));
    program.push('\n');

    let mut active_indices = Vec::new();
    for (idx, mutant) in mutants.iter().enumerate() {
        let mut mut_defs = cone_defs.to_vec();
        for d in &mut mut_defs {
            if d.name == mutant.def_name {
                d.body = mutant.mutated_body.clone();
            }
        }
        let Ok(defs_rs) = emit_items_to_rust(&[], &mut_defs, type_env, 0, Some(10_000), false)
        else {
            continue;
        };
        let mut_def_map: HashMap<String, &Def> =
            mut_defs.iter().map(|d| (d.name.clone(), d)).collect();
        let Ok(check_fn) = emit_eval_law_checker(
            "check",
            law,
            &mut_defs,
            &mut_def_map,
            type_map,
            type_env,
            true,
        ) else {
            continue;
        };
        program.push_str(&format!("mod m_{idx} {{\n    use super::*;\n"));
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
        active_indices.push(idx);
    }

    if active_indices.is_empty() {
        return Ok(None);
    }

    program.push_str("fn main() {\n");
    for idx in &active_indices {
        program.push_str(&format!(
            "    if let Some(ce) = m_{idx}::check() {{ println!(\"CAUGHT\\t{idx}\\t{{}}\", ce.replace(['\\n', '\\r', '\\t'], \" \")); return; }}\n"
        ));
    }
    program.push_str("}\n");

    let eval_dir = create_temp_eval_dir(out_dir, "mut")?;
    let rs_path = eval_dir.0.join("mutate.rs");
    let bin_path = eval_dir.0.join("mutate_bin");
    fs::write(&rs_path, program).map_err(|e| e.to_string())?;

    let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
    let compile = Command::new(&rustc)
        .args(["--edition", "2021", "-A", "warnings", "-o"])
        .arg(&bin_path)
        .arg(&rs_path)
        .output()
        .map_err(|e| format!("failed to invoke '{rustc}' for mutation testing: {e}"))?;
    if !compile.status.success() {
        return Err(format!(
            "rustc failed compiling mutant harness:\n{}",
            String::from_utf8_lossy(&compile.stderr)
        ));
    }

    let run = Command::new(&bin_path)
        .output()
        .map_err(|e| format!("failed to run mutant binary: {e}"))?;
    if !run.status.success() {
        return Err(format!(
            "mutant binary exited with failure:\n{}{}",
            String::from_utf8_lossy(&run.stdout),
            String::from_utf8_lossy(&run.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&run.stdout);
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("CAUGHT\t") {
            if let Some((idx_str, ce)) = rest.split_once('\t') {
                if let Ok(idx) = idx_str.parse::<usize>() {
                    if let Some(m) = mutants.get(idx) {
                        return Ok(Some((m.description.clone(), ce.trim().to_string())));
                    }
                }
            }
        }
    }

    Ok(None)
}

/// A candidate mutant before selection: `(def, mutated body, description)`.
type Candidate<'a> = (&'a Def, String, String);

/// Generates small syntactic mutants for all live `Def`s in a law's dependency cone.
///
/// Legacy families (BoolFlip, NatCmpArith, DropBoolOperand, ReturnUnchanged, SwapMatchArms)
/// fill the first `MAX_MUTANTS_PER_LAW` slots in their original order. The bound-pushing
/// families (NatBound, SiblingCtor, BoolConst, FlipCmp) then take up to
/// `MAX_BOUND_MUTANTS_PER_LAW` more slots, round-robin across families. Each mutant's
/// description ends with `[<Operator>]` so reports name the operator that caught a law.
pub(crate) fn generate_mutants_for_cone(
    cone_defs: &[Def],
    def_map: &HashMap<String, &Def>,
    ctor_map: &HashMap<String, CtorInfo>,
) -> Vec<Mutant> {
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut make = |operator: &str, desc: String, def: &Def, body: String| -> Option<Mutant> {
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
    };

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
                    break;
                }
                if let Some(m) = make(op, desc, def, body) {
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
    let mut cursors = vec![0usize; families.len()];
    let mut extra = 0usize;
    while extra < MAX_BOUND_MUTANTS_PER_LAW {
        let mut progressed = false;
        for (fi, (op, items)) in families.iter().enumerate() {
            if extra >= MAX_BOUND_MUTANTS_PER_LAW {
                break;
            }
            while cursors[fi] < items.len() {
                let (def, body, desc) = &items[cursors[fi]];
                cursors[fi] += 1;
                if let Some(m) = make(op, desc.clone(), def, body.clone()) {
                    mutants.push(m);
                    extra += 1;
                    progressed = true;
                    break;
                }
            }
        }
        if !progressed {
            break;
        }
    }

    mutants
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
/// otherwise), so absorbing-state laws like `step(Stopped{}, e) == Stopped{}` are caught.
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
/// implication laws such as `Bool.or(valid(c), Bool.not(forces(c)))` are caught.
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
        let mut offset = 0usize;
        for raw_line in body.split_inclusive('\n') {
            let line = raw_line.strip_suffix('\n').unwrap_or(raw_line);
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                let ws = line.len() - line.trim_start().len();
                if is_bare_var_ident(trimmed, def_map, ctor_map) {
                    targets.insert((offset + ws, offset + ws + trimmed.len()));
                } else if let Some(after_case) = line.trim_start().strip_prefix("case ") {
                    if let Some((_, inline_body)) = split_case_arm(after_case) {
                        let ib = inline_body.trim();
                        if is_bare_var_ident(ib, def_map, ctor_map) && line.ends_with(ib) {
                            let start = offset + line.len() - ib.len();
                            targets.insert((start, start + ib.len()));
                        }
                    }
                }
            }
            offset += raw_line.len();
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

fn compute_cone_hash(
    law: &ParsedLaw,
    cone: &[String],
    types: &[TypeDef],
    def_map: &HashMap<String, &Def>,
) -> String {
    let mut buf = Vec::new();
    buf.extend_from_slice(b"rb-mutate-v1\0");
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

    let mut sorted_types: Vec<&TypeDef> = types.iter().collect();
    sorted_types.sort_by(|a, b| a.name.cmp(&b.name));
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

    let mut sorted_cone = cone.to_vec();
    sorted_cone.sort();
    for name in sorted_cone {
        if let Some(def) = def_map.get(&name) {
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
            buf.extend_from_slice(def.body.as_bytes());
            buf.push(0);
        }
    }

    lock::fnv1a_hex(&buf)
}

fn load_mutate_cache(path: &Path) -> BTreeMap<String, (String, String)> {
    let mut map = BTreeMap::new();
    let Ok(raw) = fs::read_to_string(path) else {
        return map;
    };
    for line in raw.lines() {
        let parts: Vec<&str> = line.splitn(4, '\t').collect();
        if parts.len() == 4 && parts[1] == "CAUGHT" {
            map.insert(
                parts[0].to_string(),
                (parts[2].to_string(), parts[3].to_string()),
            );
        }
    }
    map
}

fn save_mutate_cache(path: &Path, map: &BTreeMap<String, (String, String)>) -> Result<(), String> {
    let mut lines = Vec::with_capacity(map.len());
    for (k, (desc, ce)) in map {
        lines.push(format!(
            "{k}\tCAUGHT\t{}\t{}",
            desc.replace(['\t', '\n', '\r'], " "),
            ce.replace(['\t', '\n', '\r'], " ")
        ));
    }
    fs::write(path, lines.join("\n")).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

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

type Pool is Data:
  Pool{alloc: Nat, free: Nat}

def pool_cap(+p: Pool) -> Nat:
  match p:
    case Pool{alloc, free}:
      Nat.add(alloc, free)

def pool_alloc_if(+alloc: Nat, +free: Nat, +req: Nat, ok: Bool) -> Pool:
  match ok:
    case True{}:
      Pool{Nat.add(alloc, req), Nat.sub(free, req)}
    case False{}:
      Pool{alloc, free}

def pool_alloc(+p: Pool, +req: Nat) -> Pool:
  match p:
    case Pool{alloc, +free}:
      pool_alloc_if(alloc, free, req, Nat.is_le(req, free))

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

def alloc_step(
  +rp: Nat,
  +fp: Nat,
  +alloc: Nat,
  ok: Bool,
  ih: {pool_cap(pool_alloc_if(alloc, fp, rp, ok)) == Nat.add(alloc, fp) : Nat}
) -> {pool_cap(pool_alloc_if(alloc, 1n+fp, 1n+rp, ok)) == Nat.add(alloc, 1n+fp) : Nat}:
  match ok:
    case False{}:
      {==}
    case True{}:
      %add_succ_sym(alloc, rp) : {Nat.add(_, Nat.sub(fp, rp)) == Nat.add(alloc, 1n+fp) : Nat}
      %add_succ_sym(alloc, fp) : {1n+Nat.add(Nat.add(alloc, rp), Nat.sub(fp, rp)) == _ : Nat}
      %ih : {1n+Nat.add(Nat.add(alloc, rp), Nat.sub(fp, rp)) == 1n+_ : Nat}
      {==}

def alloc_if_shift(+req: Nat, +free: Nat, +alloc: Nat) -> {pool_cap(pool_alloc_if(alloc, free, req, Nat.is_le(req, free))) == Nat.add(alloc, free) : Nat}:
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
      alloc_step(rp, fp, alloc, Nat.is_le(rp, fp), alloc_if_shift(rp, fp, alloc))

# promise: allocation conserves total pool capacity
law alloc_conserves_capacity:
  for +alloc: Nat
  for +free: Nat
  for +req: Nat
  {pool_cap(pool_alloc(Pool{alloc, free}, req)) == Nat.add(alloc, free) : Nat}

def alloc_conserves_capacity(alloc, free, req):
  alloc_if_shift(req, free, alloc)
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
    }

    fn assert_new_operator_catches(src: &str, law_name: &str, op: &str, tag: &str) {
        let dir = tmp_dir(tag);
        let out = dir.join("out");
        let legacy = eval_with_ops(src, law_name, LEGACY_OPS, &out)
            .expect("legacy mutant harness must compile");
        assert!(
            legacy.is_none(),
            "{law_name}: expected legacy operators to survive (the Issue #12 gap), got {legacy:?}"
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
            ["[NatBound]", "[SiblingCtor]", "[BoolConst]", "[FlipCmp]"]
                .iter()
                .any(|t| desc.ends_with(t)),
            "caught by a new operator: {desc}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nat_bound_catches_one_direction_bound_law() {
        let src = r#"import Base

def px_redirect_left(+l: Nat) -> Nat:
  match l:
    case 0n:
      0n
    case 1n+p:
      p

# promise: following a redirect never grows the remaining redirect budget
law px_redirect_budget_never_grows:
  for +l: Nat
  {Nat.is_le(px_redirect_left(l), l) == True{} : Bool}
"#;
        assert_new_operator_catches(src, "px_redirect_budget_never_grows", "NatBound", "bound");
    }

    #[test]
    fn sibling_ctor_catches_absorbing_state_law() {
        let src = r#"import Base

type Phase is Data:
  Ringing{n: Nat}
  Talking{n: Nat}
  Stopped{}

def call_step(+s: Phase, +ev: Nat) -> Phase:
  match s:
    case Ringing{n}:
      Talking{Nat.add(n, ev)}
    case Talking{n}:
      Talking{n}
    case Stopped{}:
      Stopped{}

# promise: a stopped call stays stopped whatever event arrives
law call_stopped_absorbing:
  for +ev: Nat
  {call_step(Stopped{}, ev) == Stopped{} : Phase}
"#;
        assert_new_operator_catches(src, "call_stopped_absorbing", "SiblingCtor", "absorb");
    }

    #[test]
    fn bool_const_catches_implication_law() {
        let src = r#"import Base

def valid(+c: Nat, +tools_given: Bool) -> Bool:
  match c:
    case 0n:
      True{}
    case 1n+k:
      tools_given

def forces(+c: Nat, +tools_given: Bool) -> Bool:
  match c:
    case 0n:
      False{}
    case 1n+k:
      tools_given

# promise: whenever a config forces tools, it is valid
law forced_implies_valid:
  for +c: Nat
  for +g: Bool
  {Bool.or(valid(c, g), Bool.not(forces(c, g))) == True{} : Bool}
"#;
        assert_new_operator_catches(src, "forced_implies_valid", "BoolConst", "implies");
    }

    #[test]
    fn flip_cmp_catches_strict_refusal_law() {
        let src = r#"import Base

def media_count_ok(+count: Nat, +max: Nat) -> Bool:
  Nat.is_le(count, max)

# promise: a media count above the limit is always refused
law media_count_refuses_overflow:
  for +m: Nat
  for +extra: Nat
  {media_count_ok(Nat.add(Nat.add(1n, m), extra), m) == False{} : Bool}
"#;
        assert_new_operator_catches(src, "media_count_refuses_overflow", "FlipCmp", "refuse");
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
        assert!(mutants.len() <= MAX_MUTANTS_PER_LAW + MAX_BOUND_MUTANTS_PER_LAW);
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
}
