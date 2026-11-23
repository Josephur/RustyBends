//! Generated per-law Rust tests for RustyBends.
//!
//! Parses `law` declarations from Bend 2 sources and emits `#[cfg(test)]` tests
//! into `OUT_DIR/verified.rs` so `cargo test` evaluates every law directly against
//! the emitted Rust code (catching translation bugs and `Nat`/`u64` edge divergence).

use crate::emit::{
    arith_mode_for_type, bend_type_to_rust, collect_law_source_slices, emit_expr_with_mode,
    emit_items_to_rust, is_top_level_start, is_wrapped_in_parens, parse_book_items,
    parse_list_elem_type, split_top_level_once, split_top_level_str, split_type_args,
    strip_comment, type_contains_non_copy, ArithMode, Def, TypeDef, TypeEnv,
};
use crate::lock;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static EVAL_SEQ: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LawVar {
    pub name: String,
    pub ty: String,
    pub is_type_param: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LawHypothesis {
    pub lhs: String,
    pub rhs: String,
    pub ty: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedLaw {
    pub name: String,
    pub vars: Vec<LawVar>,
    pub hypotheses: Vec<LawHypothesis>,
    pub lhs: String,
    pub rhs: String,
    pub eq_ty: String,
    pub unsupported_reason: Option<String>,
}

/// Parses all `law` declarations from Bend source (Bend 2 `for ... {lhs == rhs : Ty}`
/// as well as legacy `law name(for ...): lhs == rhs` syntax).
pub fn parse_laws(source: &str) -> Vec<ParsedLaw> {
    let resolved = crate::emit::resolve_import_aliases(source);
    let lines: Vec<&str> = resolved.lines().collect();
    let mut laws = Vec::new();
    let mut i = 0usize;

    while i < lines.len() {
        let stripped = strip_comment(lines[i]).trim();
        if stripped.starts_with("law ") {
            let mut block_parts = vec![stripped.to_string()];
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
                block_parts.push(trimmed.to_string());
                i += 1;
            }
            let block = block_parts.join(" ");
            if let Some(parsed) = parse_single_law_block(&block) {
                laws.push(parsed);
            }
            continue;
        }
        i += 1;
    }

    laws
}

fn parse_single_law_block(block: &str) -> Option<ParsedLaw> {
    let after_law = block.trim().strip_prefix("law ")?.trim();
    let (header_raw, body_raw) = split_top_level_once(after_law, ':')?;

    let mut vars = Vec::new();
    let mut hypotheses = Vec::new();
    let mut unsupported_reason = None;

    let name = if let Some(open) = header_raw.find('(') {
        let nm = header_raw[..open].trim().to_string();
        if header_raw.trim_end().ends_with(')') {
            let inner = header_raw[open + 1..header_raw.trim_end().len() - 1].trim();
            if !inner.is_empty() {
                for clause in split_type_args(inner, ',') {
                    let c = clause.trim();
                    if let Some(after_for) = c.strip_prefix("for ") {
                        parse_clause_binder(after_for, &mut vars, &mut hypotheses);
                    } else if c.starts_with("exs ") {
                        unsupported_reason =
                            Some("existential quantifier 'exs' is not testable".to_string());
                    }
                }
            }
        }
        nm
    } else {
        header_raw.trim().to_string()
    };

    if name.is_empty() {
        return None;
    }

    let mut rest = body_raw.trim();
    while unsupported_reason.is_none() {
        if let Some(after_for) = strip_kw_prefix(rest, "for") {
            let (clause_str, next_rest) = split_law_clause(after_for);
            if !parse_clause_binder(clause_str, &mut vars, &mut hypotheses) {
                unsupported_reason = Some(format!("could not parse law clause 'for {clause_str}'"));
                break;
            }
            rest = next_rest.trim();
            if strip_kw_prefix(rest, "where").is_some() {
                unsupported_reason =
                    Some("'where' refinement clause in law is not testable".to_string());
                break;
            }
        } else if strip_kw_prefix(rest, "exs").is_some() {
            unsupported_reason = Some("existential quantifier 'exs' is not testable".to_string());
            break;
        } else {
            break;
        }
    }

    if let Some(reason) = unsupported_reason {
        return Some(ParsedLaw {
            name,
            vars,
            hypotheses,
            lhs: String::new(),
            rhs: String::new(),
            eq_ty: String::new(),
            unsupported_reason: Some(reason),
        });
    }

    let goal_str = rest.trim();
    let (prop_str, eq_ty) = if is_wrapped_in_braces(goal_str) {
        let inner = goal_str[1..goal_str.len() - 1].trim();
        if let Some((prop, ty)) = split_last_top_level_colon(inner) {
            (prop.trim().to_string(), ty.trim().to_string())
        } else {
            (inner.to_string(), String::new())
        }
    } else {
        (goal_str.to_string(), String::new())
    };

    if let Some((lhs, rhs)) = split_top_level_str(&prop_str, "==") {
        Some(ParsedLaw {
            name,
            vars,
            hypotheses,
            lhs: lhs.trim().to_string(),
            rhs: rhs.trim().to_string(),
            eq_ty,
            unsupported_reason: None,
        })
    } else {
        Some(ParsedLaw {
            name,
            vars,
            hypotheses,
            lhs: String::new(),
            rhs: String::new(),
            eq_ty,
            unsupported_reason: Some("law goal is not an equality ('==')".to_string()),
        })
    }
}

fn strip_kw_prefix<'a>(s: &'a str, kw: &str) -> Option<&'a str> {
    let t = s.trim_start();
    let after = t.strip_prefix(kw)?;
    if after.chars().next().is_some_and(char::is_whitespace) {
        Some(after.trim_start())
    } else {
        None
    }
}

fn split_law_clause(after_for: &str) -> (&str, &str) {
    // Handle `binder: {lhs == rhs : Ty}` vs `binder: TypeExpr`
    if let Some((_lhs, rhs)) = split_top_level_once(after_for, ':') {
        let rhs_trim = rhs.trim_start();
        if rhs_trim.starts_with('{') {
            if let Some(end_brace) = find_matching_brace(rhs_trim) {
                let total_end = (after_for.len() - rhs_trim.len()) + end_brace + 1;
                return (after_for[..total_end].trim(), after_for[total_end..].trim());
            }
        }
    }

    // Scan top-level (depth 0 over (), {}, [], <>) until next `for `, `exs `, `where `, or `{`
    let bytes = after_for.as_bytes();
    let mut depth = 0i32;
    let mut saw_colon = false;
    for (idx, ch) in after_for.char_indices() {
        match ch {
            '(' | '[' | '<' => depth += 1,
            ')' | ']' | '>' => depth -= 1,
            '{' => {
                if depth == 0 && saw_colon {
                    return (after_for[..idx].trim(), after_for[idx..].trim());
                }
                depth += 1;
            }
            '}' => depth -= 1,
            ':' if depth == 0 => saw_colon = true,
            _ if depth == 0 && saw_colon && ch.is_whitespace() => {
                let tail = after_for[idx..].trim_start();
                if strip_kw_prefix(tail, "for").is_some()
                    || strip_kw_prefix(tail, "exs").is_some()
                    || strip_kw_prefix(tail, "where").is_some()
                {
                    return (after_for[..idx].trim(), tail);
                }
            }
            _ => {}
        }
        let _ = bytes;
    }

    (after_for.trim(), "")
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

fn parse_clause_binder(
    clause: &str,
    vars: &mut Vec<LawVar>,
    hypotheses: &mut Vec<LawHypothesis>,
) -> bool {
    let Some((raw_name, raw_ty)) = split_top_level_once(clause, ':') else {
        return false;
    };
    let clean_name = raw_name
        .trim()
        .trim_start_matches('+')
        .trim_start_matches('-')
        .trim_start_matches('~')
        .trim();
    let ty = raw_ty.trim();
    if clean_name.is_empty() || ty.is_empty() {
        return false;
    }

    if is_wrapped_in_braces(ty) {
        let inner = ty[1..ty.len() - 1].trim();
        let (prop, eq_ty) = if let Some((p, t)) = split_last_top_level_colon(inner) {
            (p.trim(), t.trim())
        } else {
            (inner, "")
        };
        if let Some((lhs, rhs)) = split_top_level_str(prop, "==") {
            hypotheses.push(LawHypothesis {
                lhs: lhs.trim().to_string(),
                rhs: rhs.trim().to_string(),
                ty: eq_ty.to_string(),
            });
            return true;
        }
        return false;
    }

    let is_type_param = matches!(ty, "Type" | "Data" | "*1" | "*2");
    vars.push(LawVar {
        name: clean_name.to_string(),
        ty: ty.to_string(),
        is_type_param,
    });
    true
}

fn is_wrapped_in_braces(s: &str) -> bool {
    if !(s.starts_with('{') && s.ends_with('}')) {
        return false;
    }
    find_matching_brace(s) == Some(s.len() - 1)
}

fn split_last_top_level_colon(s: &str) -> Option<(&str, &str)> {
    let mut depth = 0i32;
    let mut last = None;
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            ':' if depth == 0 => last = Some(idx),
            _ => {}
        }
    }
    last.map(|idx| (s[..idx].trim(), s[idx + 1..].trim()))
}

/// Computes the transitive live `def` dependency cone referenced by a law.
pub fn law_dependency_cone(law: &ParsedLaw, defs: &[Def]) -> Vec<String> {
    let def_map: HashMap<&str, &Def> = defs.iter().map(|d| (d.name.as_str(), d)).collect();
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
            if def_map.contains_key(tok.as_str()) && visited.insert(tok.clone()) {
                queue.push_back(tok);
            }
        }
    }

    while let Some(name) = queue.pop_front() {
        if let Some(def) = def_map.get(name.as_str()) {
            for tok in lock::tokenize_bend(&def.body) {
                if def_map.contains_key(tok.as_str()) && visited.insert(tok.clone()) {
                    queue.push_back(tok);
                }
            }
        }
    }

    visited.into_iter().collect()
}

/// Returns `true` if the induced call graph over `cone` contains any cycle (including self-recursion).
pub fn cone_is_recursive(cone: &[String], defs: &[Def]) -> bool {
    let cone_set: HashSet<&str> = cone.iter().map(String::as_str).collect();
    let mut edges: HashMap<&str, Vec<&str>> = HashMap::new();
    for def in defs {
        if !cone_set.contains(def.name.as_str()) {
            continue;
        }
        let mut callees = Vec::new();
        for tok in lock::tokenize_bend(&def.body) {
            if let Some(&target) = cone_set.get(tok.as_str()) {
                if !callees.contains(&target) {
                    callees.push(target);
                }
            }
        }
        edges.insert(def.name.as_str(), callees);
    }

    // 0 = unvisited, 1 = visiting, 2 = done
    let mut state: HashMap<&str, u8> = HashMap::new();
    fn dfs<'a>(
        node: &'a str,
        edges: &HashMap<&'a str, Vec<&'a str>>,
        state: &mut HashMap<&'a str, u8>,
    ) -> bool {
        state.insert(node, 1);
        if let Some(nexts) = edges.get(node) {
            for &next in nexts {
                match state.get(next).copied().unwrap_or(0) {
                    1 => return true,
                    0 if dfs(next, edges, state) => return true,
                    _ => {}
                }
            }
        }
        state.insert(node, 2);
        false
    }

    for &node in &cone_set {
        if state.get(node).copied().unwrap_or(0) == 0 && dfs(node, &edges, &mut state) {
            return true;
        }
    }
    false
}

/// Emits a `#[cfg(test)] mod __rusty_bends_law_tests` block checking every law against emitted Rust.
pub(crate) fn emit_law_tests_module(
    laws: &[ParsedLaw],
    types: &[TypeDef],
    defs: &[Def],
    type_env: &TypeEnv,
) -> String {
    if laws.is_empty() {
        return String::new();
    }

    let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
    let type_map: HashMap<String, &TypeDef> = types.iter().map(|t| (t.name.clone(), t)).collect();

    let mut out = String::new();
    out.push_str("#[cfg(test)]\n");
    out.push_str("#[allow(clippy::all, non_snake_case, unused_variables, unused_parens, dead_code, unused_mut)]\n");
    out.push_str("mod __rusty_bends_law_tests {\n");
    out.push_str("    use super::*;\n\n");
    out.push_str(&emit_pool_runtime_helpers(
        types, &type_map, type_env, false,
    ));

    let mut used_fn_names: HashSet<String> = HashSet::new();
    for (idx, law) in laws.iter().enumerate() {
        let mut fn_name = format!("law_{}", sanitize_ident(&law.name));
        if !used_fn_names.insert(fn_name.clone()) {
            fn_name = format!("{fn_name}_{idx}");
            used_fn_names.insert(fn_name.clone());
        }
        out.push_str(&emit_single_law_test(
            &fn_name, law, types, defs, &def_map, &type_map, type_env,
        ));
        out.push('\n');
    }

    out.push_str("}\n");
    out
}

pub(crate) fn sanitize_ident(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() || out.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        out.insert(0, '_');
    }
    out
}

pub(crate) fn emit_pool_runtime_helpers(
    types: &[TypeDef],
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    eval_mode: bool,
) -> String {
    let mut s = String::new();
    s.push_str(
        r#"    fn __rb_next_u64(state: &mut u64) -> u64 {
        *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn __rb_is_nat_overflow(payload: &(dyn std::any::Any + Send)) -> bool {
        let msg = if let Some(m) = payload.downcast_ref::<&str>() {
            *m
        } else if let Some(m) = payload.downcast_ref::<String>() {
            m.as_str()
        } else {
            return false;
        };
        msg.contains("rusty-bends: Nat overflow") || msg.contains("rusty-bends: step limit")
    }
"#,
    );
    if eval_mode {
        s.push_str(
            r#"
    fn __rb_pool_nat(rng: &mut u64, recursive: bool) -> Vec<u64> {
        let _ = rng;
        if recursive {
            (0_u64..=12).collect()
        } else {
            vec![0_u64, 1, 2, 3, 4, 5, 6, 7, 8, 16, 1000, u64::MAX - 1, u64::MAX]
        }
    }

    fn __rb_pool_u32(rng: &mut u64) -> Vec<u32> {
        let _ = rng;
        vec![0_u32, 1, 2, 3, 4, 7, 1000, u32::MAX - 1, u32::MAX]
    }

    fn __rb_pool_u64(rng: &mut u64) -> Vec<u64> {
        let _ = rng;
        vec![0_u64, 1, 2, 3, 4, 7, 1000, u64::MAX - 1, u64::MAX]
    }

    fn __rb_pool_i32(rng: &mut u64) -> Vec<i32> {
        let _ = rng;
        vec![0_i32, 1, -1, 2, -2, 3, i32::MIN, i32::MAX]
    }

    fn __rb_pool_i64(rng: &mut u64) -> Vec<i64> {
        let _ = rng;
        vec![0_i64, 1, -1, 2, -2, 3, i64::MIN, i64::MAX]
    }
"#,
        );
    } else {
        s.push_str(
            r#"
    fn __rb_pool_nat(rng: &mut u64, recursive: bool) -> Vec<u64> {
        if recursive {
            let mut v = vec![0_u64, 1, 2, 3, 4, 5, 7, 10, 16, 32];
            for _ in 0..4 {
                v.push(__rb_next_u64(rng) % 48);
            }
            v
        } else {
            let mut v = vec![0_u64, 1, 2, 3, 5, 7, 16, 1000, u64::MAX - 1, u64::MAX];
            for _ in 0..2 {
                v.push(__rb_next_u64(rng) % 10_000);
            }
            for _ in 0..2 {
                v.push(__rb_next_u64(rng));
            }
            v
        }
    }

    fn __rb_pool_u32(rng: &mut u64) -> Vec<u32> {
        let mut v = vec![0_u32, 1, 2, 7, 1000, u32::MAX - 1, u32::MAX];
        for _ in 0..4 {
            v.push(__rb_next_u64(rng) as u32);
        }
        v
    }

    fn __rb_pool_u64(rng: &mut u64) -> Vec<u64> {
        let mut v = vec![0_u64, 1, 2, 7, 1000, u64::MAX - 1, u64::MAX];
        for _ in 0..4 {
            v.push(__rb_next_u64(rng));
        }
        v
    }

    fn __rb_pool_i32(rng: &mut u64) -> Vec<i32> {
        let mut v = vec![0_i32, 1, -1, 2, -2, i32::MIN, i32::MAX];
        for _ in 0..4 {
            v.push(__rb_next_u64(rng) as i32);
        }
        v
    }

    fn __rb_pool_i64(rng: &mut u64) -> Vec<i64> {
        let mut v = vec![0_i64, 1, -1, 2, -2, i64::MIN, i64::MAX];
        for _ in 0..4 {
            v.push(__rb_next_u64(rng) as i64);
        }
        v
    }
"#,
        );
    }

    s.push_str(
        r#"
    fn __rb_combine2<A: Clone, B: Clone>(a: &[A], b: &[B], cap: usize) -> Vec<(A, B)> {
        let mut out = Vec::new();
        if a.is_empty() || b.is_empty() {
            return out;
        }
        if a.len().saturating_mul(b.len()) <= cap {
            for x in a {
                for y in b {
                    out.push((x.clone(), y.clone()));
                }
            }
            return out;
        }
        let s0 = a.len().min(4);
        let s1 = b.len().min(4);
        for x in &a[..s0] {
            for y in &b[..s1] {
                if out.len() >= cap {
                    break;
                }
                out.push((x.clone(), y.clone()));
            }
        }
        for x in a {
            if out.len() >= cap {
                break;
            }
            out.push((x.clone(), b[0].clone()));
        }
        for y in b {
            if out.len() >= cap {
                break;
            }
            out.push((a[0].clone(), y.clone()));
        }
        if out.len() < cap {
            out.push((a[a.len() - 1].clone(), b[b.len() - 1].clone()));
        }
        out
    }

"#,
    );

    if type_env.uses_builtin_list {
        s.push_str(
            r#"
    fn __rb_pool_list<T: Clone>(elems: &[T], depth: usize) -> Vec<List<T>> {
        let mut out = vec![List::Nil];
        if depth == 0 || elems.is_empty() {
            return out;
        }
        let sub = __rb_pool_list(elems, depth - 1);
        for e in &elems[..elems.len().min(4)] {
            out.push(List::Con(e.clone(), Box::new(List::Nil)));
        }
        for (i, e) in elems[..elems.len().min(4)].iter().enumerate() {
            if let Some(tail) = sub.get((i + 1) % sub.len()) {
                out.push(List::Con(e.clone(), Box::new(tail.clone())));
            }
            if sub.len() > 1 {
                out.push(List::Con(e.clone(), Box::new(sub[sub.len() - 1].clone())));
            }
        }
        out
    }

"#,
        );
    }

    let empty_params = HashSet::new();
    for td in types {
        s.push_str(&emit_adt_pool_fn(
            td,
            type_map,
            type_env,
            &empty_params,
            eval_mode,
        ));
        s.push('\n');
    }
    s
}

fn wrap_ctor_pool_arg(arg_expr: String, is_boxed: bool) -> String {
    if is_boxed {
        format!("Box::new({arg_expr})")
    } else {
        arg_expr
    }
}

fn emit_adt_pool_fn(
    td: &TypeDef,
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    type_params: &HashSet<String>,
    eval_mode: bool,
) -> String {
    let mut s = format!(
        "    fn __rb_pool_adt_{}(rng: &mut u64, depth: usize, recursive: bool) -> Vec<{}> {{\n",
        td.name, td.name
    );
    s.push_str("        let mut out = Vec::new();\n");
    for v in &td.variants {
        let has_adt_field = v
            .field_types
            .iter()
            .any(|ft| type_references_adt(ft, type_map));
        let indent = if has_adt_field {
            s.push_str("        if depth > 0 {\n");
            "            "
        } else {
            "        "
        };
        let next_depth = if has_adt_field { "depth - 1" } else { "depth" };
        let info_opt = type_env.ctor_map.get(&format!("{}.{}", td.name, v.name));
        let field_is_boxed = |fi: usize| -> bool {
            info_opt
                .and_then(|c| c.boxed_fields.get(fi).copied())
                .unwrap_or(false)
        };
        let supported_fields = v
            .field_types
            .iter()
            .all(|ft| can_generate_pool(ft, type_map, type_params));
        if !supported_fields {
            s.push_str(&format!(
                "{indent}// Skipped variant {}::{}: unsupported field type\n",
                td.name, v.name
            ));
        } else if v.field_types.is_empty() {
            s.push_str(&format!("{indent}out.push({}::{});\n", td.name, v.name));
        } else if v.field_types.len() == 1 {
            let expr = emit_pool_expr(
                &v.field_types[0],
                type_map,
                type_params,
                "recursive",
                next_depth,
            );
            let pushed = wrap_ctor_pool_arg("f0".to_string(), field_is_boxed(0));
            s.push_str(&format!("{indent}for f0 in {expr} {{\n"));
            s.push_str(&format!(
                "{indent}    out.push({}::{}({pushed}));\n",
                td.name, v.name
            ));
            s.push_str(&format!("{indent}}}\n"));
        } else {
            for (fi, ft) in v.field_types.iter().enumerate() {
                let expr = emit_pool_expr(ft, type_map, type_params, "recursive", next_depth);
                s.push_str(&format!("{indent}let __f{fi} = {expr};\n"));
            }
            let non_empty_guard = (0..v.field_types.len())
                .map(|fi| format!("!__f{fi}.is_empty()"))
                .collect::<Vec<_>>()
                .join(" && ");
            s.push_str(&format!("{indent}if {non_empty_guard} {{\n"));
            let inner_indent = format!("{indent}    ");
            // Small combinations first so counterexamples stay minimal
            let small_cap = if v.field_types.len() == 2 { 4 } else { 2 };
            let mut loop_ind = inner_indent.clone();
            for fi in 0..v.field_types.len() {
                s.push_str(&format!(
                    "{loop_ind}for __s{fi} in &__f{fi}[..__f{fi}.len().min({small_cap})] {{\n"
                ));
                loop_ind.push_str("    ");
            }
            let small_args = (0..v.field_types.len())
                .map(|fi| wrap_ctor_pool_arg(format!("__s{fi}.clone()"), field_is_boxed(fi)))
                .collect::<Vec<_>>()
                .join(", ");
            s.push_str(&format!(
                "{loop_ind}out.push({}::{}({small_args}));\n",
                td.name, v.name
            ));
            for _ in 0..v.field_types.len() {
                loop_ind.truncate(loop_ind.len() - 4);
                s.push_str(&format!("{loop_ind}}}\n"));
            }
            let max_expr = (0..v.field_types.len()).fold("0usize".to_string(), |acc, fi| {
                format!("{acc}.max(__f{fi}.len())")
            });
            s.push_str(&format!(
                "{inner_indent}let __limit = ({max_expr}).min(24);\n"
            ));
            s.push_str(&format!("{inner_indent}for __i in 0..__limit {{\n"));
            let args_sweep = (0..v.field_types.len())
                .map(|fi| {
                    wrap_ctor_pool_arg(
                        format!("__f{fi}[__i % __f{fi}.len()].clone()"),
                        field_is_boxed(fi),
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            s.push_str(&format!(
                "{inner_indent}    out.push({}::{}({args_sweep}));\n",
                td.name, v.name
            ));
            s.push_str(&format!("{inner_indent}}}\n"));
            let edge_args = (0..v.field_types.len())
                .map(|fi| {
                    wrap_ctor_pool_arg(
                        format!("__f{fi}[__f{fi}.len() - 1].clone()"),
                        field_is_boxed(fi),
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            s.push_str(&format!(
                "{inner_indent}out.push({}::{}({edge_args}));\n",
                td.name, v.name
            ));
            if !eval_mode {
                s.push_str(&format!("{inner_indent}for _ in 0..4 {{\n"));
                let args_rng = (0..v.field_types.len())
                    .map(|fi| {
                        wrap_ctor_pool_arg(
                            format!(
                                "__f{fi}[(__rb_next_u64(rng) as usize) % __f{fi}.len()].clone()"
                            ),
                            field_is_boxed(fi),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                s.push_str(&format!(
                    "{inner_indent}    out.push({}::{}({args_rng}));\n",
                    td.name, v.name
                ));
                s.push_str(&format!("{inner_indent}}}\n"));
            }
            s.push_str(&format!("{indent}}}\n"));
        }
        if has_adt_field {
            s.push_str("        }\n");
        }
    }
    s.push_str("        out\n    }\n");
    s
}

fn type_references_adt(ty: &str, type_map: &HashMap<String, &TypeDef>) -> bool {
    let t = ty.trim();
    if type_map.contains_key(t) {
        return true;
    }
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
        return parts.iter().any(|p| type_references_adt(p, type_map));
    }
    let amp = split_type_args(t, '&');
    if amp.len() > 1 {
        return amp.iter().any(|p| type_references_adt(p, type_map));
    }
    if let Some(elem) = parse_list_elem_type(t) {
        return type_references_adt(elem, type_map);
    }
    false
}

pub(crate) fn can_generate_pool(
    ty: &str,
    type_map: &HashMap<String, &TypeDef>,
    type_params: &HashSet<String>,
) -> bool {
    let t = ty.trim();
    if t.contains("->") {
        return false;
    }
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
        if parts.len() > 1 {
            return parts
                .iter()
                .all(|p| can_generate_pool(p, type_map, type_params));
        }
        return can_generate_pool(inner, type_map, type_params);
    }
    let amp = split_type_args(t, '&');
    if amp.len() > 1 {
        return amp
            .iter()
            .all(|p| can_generate_pool(p, type_map, type_params));
    }
    if let Some(elem) = parse_list_elem_type(t) {
        return can_generate_pool(elem, type_map, type_params);
    }
    matches!(
        t,
        "Nat" | "U32" | "U64" | "I32" | "I64" | "Bool" | "Unit" | "()"
    ) || type_params.contains(t)
        || type_map.contains_key(t)
}

pub(crate) fn emit_pool_expr(
    ty: &str,
    type_map: &HashMap<String, &TypeDef>,
    type_params: &HashSet<String>,
    recursive_expr: &str,
    depth_expr: &str,
) -> String {
    let t = ty.trim();
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
        if parts.len() > 1 {
            return emit_tuple_pool_expr(&parts, type_map, type_params, recursive_expr, depth_expr);
        }
        return emit_pool_expr(inner, type_map, type_params, recursive_expr, depth_expr);
    }
    let amp = split_type_args(t, '&');
    if amp.len() > 1 {
        return emit_tuple_pool_expr(&amp, type_map, type_params, recursive_expr, depth_expr);
    }
    if let Some(elem) = parse_list_elem_type(t) {
        let elem_pool = emit_pool_expr(elem, type_map, type_params, recursive_expr, depth_expr);
        return format!("__rb_pool_list(&{elem_pool}, {depth_expr})");
    }
    match t {
        "Nat" => format!("__rb_pool_nat(rng, {recursive_expr})"),
        "U32" => "__rb_pool_u32(rng)".to_string(),
        "U64" => "__rb_pool_u64(rng)".to_string(),
        "I32" => "__rb_pool_i32(rng)".to_string(),
        "I64" => "__rb_pool_i64(rng)".to_string(),
        "Bool" => "vec![false, true]".to_string(),
        "Unit" | "()" => "vec![()]".to_string(),
        _ if type_params.contains(t) => format!("__rb_pool_nat(rng, {recursive_expr})"),
        _ => format!("__rb_pool_adt_{t}(rng, {depth_expr}, {recursive_expr})"),
    }
}

fn emit_tuple_pool_expr(
    parts: &[&str],
    type_map: &HashMap<String, &TypeDef>,
    type_params: &HashSet<String>,
    recursive_expr: &str,
    depth_expr: &str,
) -> String {
    if parts.len() == 2 {
        let p0 = emit_pool_expr(parts[0], type_map, type_params, recursive_expr, depth_expr);
        let p1 = emit_pool_expr(parts[1], type_map, type_params, recursive_expr, depth_expr);
        return format!("__rb_combine2(&{p0}, &{p1}, 24)");
    }
    let mut s = String::from("{\n");
    for (idx, part) in parts.iter().enumerate() {
        let p = emit_pool_expr(part, type_map, type_params, recursive_expr, depth_expr);
        s.push_str(&format!("            let __tp{idx} = {p};\n"));
    }
    let non_empty = (0..parts.len())
        .map(|i| format!("!__tp{i}.is_empty()"))
        .collect::<Vec<_>>()
        .join(" && ");
    s.push_str("            let mut __tout = Vec::new();\n");
    s.push_str(&format!("            if {non_empty} {{\n"));
    let max_expr = (0..parts.len()).fold("0usize".to_string(), |acc, i| {
        format!("{acc}.max(__tp{i}.len())")
    });
    s.push_str(&format!(
        "                let __lim = ({max_expr}).min(24);\n"
    ));
    s.push_str("                for __i in 0..__lim {\n");
    let elem = (0..parts.len())
        .map(|i| format!("__tp{i}[__i % __tp{i}.len()].clone()"))
        .collect::<Vec<_>>()
        .join(", ");
    s.push_str(&format!("                    __tout.push(({elem}));\n"));
    s.push_str("                }\n");
    s.push_str("            }\n");
    s.push_str("            __tout\n        }");
    s
}

fn emit_single_law_test(
    fn_name: &str,
    law: &ParsedLaw,
    _types: &[TypeDef],
    defs: &[Def],
    def_map: &HashMap<String, &Def>,
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
) -> String {
    if let Some(reason) = &law.unsupported_reason {
        return format!("    // Skipped law {}: {reason}\n", law.name);
    }

    let type_param_set: HashSet<String> = law
        .vars
        .iter()
        .filter(|v| v.is_type_param)
        .map(|v| v.name.clone())
        .collect();
    let runtime_vars: Vec<&LawVar> = law.vars.iter().filter(|v| !v.is_type_param).collect();

    for v in &runtime_vars {
        if !can_generate_pool(&v.ty, type_map, &type_param_set) {
            return format!(
                "    // Skipped law {}: unsupported variable type '{}'\n",
                law.name, v.ty
            );
        }
    }

    let law_clone_vars: HashSet<String> = runtime_vars
        .iter()
        .filter(|v| type_contains_non_copy(&v.ty, &type_env.non_copy_types))
        .map(|v| v.name.clone())
        .collect();

    let default_mode = arith_mode_for_type(&law.eq_ty, ArithMode::NatChecked);
    let lhs_rs =
        match emit_expr_with_mode(&law.lhs, def_map, type_env, &law_clone_vars, default_mode) {
            Ok(s) => s,
            Err(e) => return format!("    // Skipped law {}: {e}\n", law.name),
        };
    let rhs_rs =
        match emit_expr_with_mode(&law.rhs, def_map, type_env, &law_clone_vars, default_mode) {
            Ok(s) => s,
            Err(e) => return format!("    // Skipped law {}: {e}\n", law.name),
        };

    let mut hyp_pairs = Vec::new();
    for h in &law.hypotheses {
        let h_mode = arith_mode_for_type(&h.ty, ArithMode::NatChecked);
        let hl = match emit_expr_with_mode(&h.lhs, def_map, type_env, &law_clone_vars, h_mode) {
            Ok(s) => s,
            Err(e) => return format!("    // Skipped law {}: {e}\n", law.name),
        };
        let hr = match emit_expr_with_mode(&h.rhs, def_map, type_env, &law_clone_vars, h_mode) {
            Ok(s) => s,
            Err(e) => return format!("    // Skipped law {}: {e}\n", law.name),
        };
        hyp_pairs.push((hl, hr));
    }

    let mut s = String::new();
    s.push_str("    #[test]\n");
    s.push_str(&format!("    fn {fn_name}() {{\n"));

    if runtime_vars.is_empty() {
        let eval_block = emit_eval_closure(&hyp_pairs, &lhs_rs, &rhs_rs);
        s.push_str(&format!("        let __res = {eval_block};\n"));
        s.push_str("        match __res {\n");
        s.push_str("            Err(__p) if __rb_is_nat_overflow(&*__p) => return,\n");
        s.push_str("            Err(__p) => std::panic::resume_unwind(__p),\n");
        s.push_str("            Ok(None) => return,\n");
        s.push_str("            Ok(Some((__lhs, __rhs))) => {\n");
        s.push_str(&format!(
            "                assert_eq!(__lhs, __rhs, \"law {} failed on emitted Rust:\\n  lhs = {{:?}}\\n  rhs = {{:?}}\", __lhs, __rhs);\n",
            escape_rust_str(&law.name)
        ));
        s.push_str("            }\n");
        s.push_str("        }\n");
        s.push_str("    }\n");
        return s;
    }

    let cone = law_dependency_cone(law, defs);
    let recursive = cone_is_recursive(&cone, defs);
    let seed = 0x517c_c1b7_2722_0a95_u64
        ^ u64::from_str_radix(&lock::fnv1a_hex(law.name.as_bytes()), 16).unwrap_or(0);
    s.push_str(&format!("        let mut __rng_val: u64 = {seed}_u64;\n"));
    s.push_str("        let rng = &mut __rng_val;\n");
    for (vi, v) in runtime_vars.iter().enumerate() {
        let pool_expr = emit_pool_expr(
            &v.ty,
            type_map,
            &type_param_set,
            if recursive { "true" } else { "false" },
            "2",
        );
        s.push_str(&format!("        let __p{vi} = {pool_expr};\n"));
    }

    let var_names_fmt = runtime_vars
        .iter()
        .map(|v| format!("{} = {{:?}}", v.name))
        .collect::<Vec<_>>()
        .join(", ");
    let var_args_fmt = runtime_vars
        .iter()
        .map(|v| v.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");

    // Helper closure for evaluating one combination
    s.push_str("        let mut __checked: usize = 0;\n");
    s.push_str("        let mut __run_case = |");
    for (vi, v) in runtime_vars.iter().enumerate() {
        if vi > 0 {
            s.push_str(", ");
        }
        let rty = bend_type_to_rust_with_u64_params(&v.ty, &type_param_set);
        s.push_str(&format!("__arg{vi}: &{rty}"));
    }
    s.push_str("| {\n");
    for (vi, v) in runtime_vars.iter().enumerate() {
        s.push_str(&format!(
            "            let {} = __arg{vi}.clone();\n",
            v.name
        ));
    }
    let eval_block = emit_eval_closure(&hyp_pairs, &lhs_rs, &rhs_rs);
    s.push_str(&format!("            match {eval_block} {{\n"));
    s.push_str("                Err(__p) if __rb_is_nat_overflow(&*__p) => {}\n");
    s.push_str("                Err(__p) => std::panic::resume_unwind(__p),\n");
    s.push_str("                Ok(None) => {}\n");
    s.push_str("                Ok(Some((__lhs, __rhs))) => {\n");
    s.push_str("                    __checked += 1;\n");
    s.push_str(&format!(
        "                    assert_eq!(__lhs, __rhs, \"law {} failed on emitted Rust for {var_names_fmt}:\\n  lhs = {{:?}}\\n  rhs = {{:?}}\", {var_args_fmt}, __lhs, __rhs);\n",
        escape_rust_str(&law.name)
    ));
    s.push_str("                }\n");
    s.push_str("            }\n");
    s.push_str("        };\n");

    let lens_prod = runtime_vars
        .iter()
        .enumerate()
        .map(|(vi, _)| format!("__p{vi}.len()"))
        .fold("1usize".to_string(), |acc, x| {
            format!("{acc}.saturating_mul({x})")
        });
    s.push_str(&format!("        let __total = {lens_prod};\n"));
    s.push_str("        if __total <= 4096 {\n");
    let mut indent = "            ".to_string();
    for vi in 0..runtime_vars.len() {
        s.push_str(&format!("{indent}for __v{vi} in &__p{vi} {{\n"));
        indent.push_str("    ");
    }
    let tuple_call = (0..runtime_vars.len())
        .map(|vi| format!("__v{vi}"))
        .collect::<Vec<_>>()
        .join(", ");
    s.push_str(&format!("{indent}__run_case({tuple_call});\n"));
    for _ in 0..runtime_vars.len() {
        indent.truncate(indent.len() - 4);
        s.push_str(&format!("{indent}}}\n"));
    }
    s.push_str("        } else {\n");
    for vi in 0..runtime_vars.len() {
        s.push_str(&format!(
            "            for (__idx, __val) in __p{vi}.iter().enumerate() {{\n"
        ));
        let args_zero = (0..runtime_vars.len())
            .map(|k| {
                if k == vi {
                    "__val".to_string()
                } else {
                    format!("&__p{k}[0]")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        s.push_str(&format!("                __run_case({args_zero});\n"));
        let args_diag = (0..runtime_vars.len())
            .map(|k| {
                if k == vi {
                    "__val".to_string()
                } else {
                    format!("&__p{k}[(__idx + {k}) % __p{k}.len()]")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        s.push_str(&format!("                __run_case({args_diag});\n"));
        s.push_str("            }\n");
    }
    s.push_str("            for _ in 0..1024 {\n");
    let args_sample = (0..runtime_vars.len())
        .map(|k| format!("&__p{k}[(__rb_next_u64(rng) as usize) % __p{k}.len()]"))
        .collect::<Vec<_>>()
        .join(", ");
    s.push_str(&format!("                __run_case({args_sample});\n"));
    s.push_str("            }\n");
    s.push_str("        }\n");

    if law.hypotheses.is_empty() {
        s.push_str(&format!(
            "        assert!(__checked > 0, \"law {} had 0 non-overflowing test cases\");\n",
            escape_rust_str(&law.name)
        ));
    }
    s.push_str("    }\n");
    s
}

fn bend_type_to_rust_with_u64_params(ty: &str, type_params: &HashSet<String>) -> String {
    let t = ty.trim();
    if type_params.contains(t) {
        return "u64".to_string();
    }
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
        if parts.len() > 1 {
            let mapped = parts
                .into_iter()
                .map(|p| bend_type_to_rust_with_u64_params(p, type_params))
                .collect::<Vec<_>>()
                .join(", ");
            return format!("({mapped})");
        }
        return bend_type_to_rust_with_u64_params(inner, type_params);
    }
    let amp = split_type_args(t, '&');
    if amp.len() > 1 {
        let mapped = amp
            .into_iter()
            .map(|p| bend_type_to_rust_with_u64_params(p, type_params))
            .collect::<Vec<_>>()
            .join(", ");
        return format!("({mapped})");
    }
    if let Some(elem) = parse_list_elem_type(t) {
        return format!(
            "List<{}>",
            bend_type_to_rust_with_u64_params(elem, type_params)
        );
    }
    bend_type_to_rust(t, type_params)
}

fn emit_eval_closure(hyp_pairs: &[(String, String)], lhs_rs: &str, rhs_rs: &str) -> String {
    let mut hyp_checks = String::new();
    for (hl, hr) in hyp_pairs {
        hyp_checks.push_str(&format!("if ({hl}) != ({hr}) {{ return None; }} "));
    }
    format!(
        "std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {{ {hyp_checks}Some(({lhs_rs}, {rhs_rs})) }}))"
    )
}

fn escape_rust_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Counterexample {
    pub law_name: String,
    pub bindings: Vec<(String, String)>,
    pub lhs_display: String,
    pub rhs_display: String,
    pub lhs_val: String,
    pub rhs_val: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LawEvalOutcome {
    Counterexample(Counterexample),
    NoCounterexample {
        law_name: String,
        checked: usize,
        bounds: String,
    },
    Skipped {
        law_name: String,
        reason: String,
    },
}

pub(crate) struct TempEvalDir(pub(crate) PathBuf);

impl Drop for TempEvalDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn create_temp_eval_dir(base_dir: &Path, tag: &str) -> Result<TempEvalDir, String> {
    fs::create_dir_all(base_dir).map_err(|e| e.to_string())?;
    let n = EVAL_SEQ.fetch_add(1, Ordering::SeqCst);
    let path = base_dir.join(format!(".rb_{tag}_{}_{n}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(TempEvalDir(path))
}

/// Extracts the failing definition/law name from Bend CLI error output (`Location: <name>`).
pub fn extract_failed_def_name(bend_err: &str) -> Option<String> {
    for line in bend_err.lines() {
        let trimmed = line.trim();
        if let Some(after) = trimmed.strip_prefix("Location:") {
            let rest = after.trim();
            if !rest.is_empty() {
                if let Some(tok) = rest.split_whitespace().next() {
                    let clean = tok.rsplit(':').next().unwrap_or(tok);
                    if !clean.is_empty() {
                        return Some(clean.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Evaluates `target_law_names` (or all laws in `combined_source` if empty) on concrete inputs
/// using the emitted Rust (compiled with `rustc` under a 10,000-step recursion guard).
pub fn evaluate_laws_for_counterexamples(
    combined_source: &str,
    target_law_names: &[String],
    out_dir: &Path,
) -> Result<Vec<LawEvalOutcome>, String> {
    let (types, defs) = parse_book_items(combined_source)?;
    let all_laws = parse_laws(combined_source);
    let extra_sources = collect_law_source_slices(&all_laws);
    let type_env = TypeEnv::build(&types, &defs, &extra_sources);

    let targets: Vec<&ParsedLaw> = if target_law_names.is_empty() {
        all_laws.iter().collect()
    } else {
        all_laws
            .iter()
            .filter(|l| target_law_names.iter().any(|t| t == &l.name))
            .collect()
    };

    if targets.is_empty() {
        return Ok(Vec::new());
    }

    let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
    let type_map: HashMap<String, &TypeDef> = types.iter().map(|t| (t.name.clone(), t)).collect();

    let runtime = emit_items_to_rust(&types, &defs, &type_env, 0, Some(10_000), true)?;
    let mut outcomes: Vec<LawEvalOutcome> = Vec::new();
    let mut runnable: Vec<(&ParsedLaw, String)> = Vec::new();
    let mut law_by_name: HashMap<String, &ParsedLaw> = HashMap::new();

    for law in targets {
        law_by_name.insert(law.name.clone(), law);
        match emit_eval_law_checker(
            &format!("__rb_eval_law_{}", sanitize_ident(&law.name)),
            law,
            &defs,
            &def_map,
            &type_map,
            &type_env,
            false,
        ) {
            Ok(code) => runnable.push((law, code)),
            Err(reason) => outcomes.push(LawEvalOutcome::Skipped {
                law_name: law.name.clone(),
                reason,
            }),
        }
    }

    if runnable.is_empty() {
        return Ok(outcomes);
    }

    let mut program = String::new();
    program.push_str("#![allow(clippy::all, non_snake_case, unused_variables, unused_parens, dead_code, unused_mut)]\n");
    program.push_str(&runtime.rust_source);
    program.push('\n');
    program.push_str(&emit_pool_runtime_helpers(
        &types, &type_map, &type_env, true,
    ));
    for (_, code) in &runnable {
        program.push_str(code);
        program.push('\n');
    }
    program.push_str("fn main() {\n");
    for (law, _) in &runnable {
        let fn_name = format!("__rb_eval_law_{}", sanitize_ident(&law.name));
        program.push_str(&format!("    {fn_name}();\n"));
    }
    program.push_str("}\n");

    let eval_dir = create_temp_eval_dir(out_dir, "eval")?;
    let rs_path = eval_dir.0.join("eval.rs");
    let bin_path = eval_dir.0.join("eval_bin");
    fs::write(&rs_path, program).map_err(|e| e.to_string())?;

    let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
    let compile = Command::new(&rustc)
        .args(["--edition", "2021", "-A", "warnings", "-o"])
        .arg(&bin_path)
        .arg(&rs_path)
        .output()
        .map_err(|e| format!("failed to invoke '{rustc}' for counterexample search: {e}"))?;
    if !compile.status.success() {
        return Err(format!(
            "rustc failed compiling counterexample harness:\n{}",
            String::from_utf8_lossy(&compile.stderr)
        ));
    }

    let run = Command::new(&bin_path)
        .output()
        .map_err(|e| format!("failed to run counterexample binary: {e}"))?;
    if !run.status.success() {
        return Err(format!(
            "counterexample binary exited with failure:\n{}{}",
            String::from_utf8_lossy(&run.stdout),
            String::from_utf8_lossy(&run.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&run.stdout);
    let mut parsed = parse_eval_protocol(&stdout, &law_by_name);
    outcomes.append(&mut parsed);
    Ok(outcomes)
}

/// Emits a standalone Rust function that evaluates `law` across small and edge inputs and prints
/// either `CE_BEGIN ... CE_END` (or `CAUGHT` in mutation mode) or `NONE\t...`.
pub(crate) fn emit_eval_law_checker(
    fn_name: &str,
    law: &ParsedLaw,
    defs: &[Def],
    def_map: &HashMap<String, &Def>,
    type_map: &HashMap<String, &TypeDef>,
    type_env: &TypeEnv,
    compact_mutant_mode: bool,
) -> Result<String, String> {
    if let Some(reason) = &law.unsupported_reason {
        return Err(reason.clone());
    }

    let type_param_set: HashSet<String> = law
        .vars
        .iter()
        .filter(|v| v.is_type_param)
        .map(|v| v.name.clone())
        .collect();
    let runtime_vars: Vec<&LawVar> = law.vars.iter().filter(|v| !v.is_type_param).collect();

    for v in &runtime_vars {
        if !can_generate_pool(&v.ty, type_map, &type_param_set) {
            return Err(format!("unsupported variable type '{}'", v.ty));
        }
    }

    let law_clone_vars: HashSet<String> = runtime_vars
        .iter()
        .filter(|v| type_contains_non_copy(&v.ty, &type_env.non_copy_types))
        .map(|v| v.name.clone())
        .collect();

    let default_mode = arith_mode_for_type(&law.eq_ty, ArithMode::NatChecked);
    let lhs_rs = emit_expr_with_mode(&law.lhs, def_map, type_env, &law_clone_vars, default_mode)?;
    let rhs_rs = emit_expr_with_mode(&law.rhs, def_map, type_env, &law_clone_vars, default_mode)?;

    let mut hyp_pairs = Vec::new();
    for h in &law.hypotheses {
        let h_mode = arith_mode_for_type(&h.ty, ArithMode::NatChecked);
        let hl = emit_expr_with_mode(&h.lhs, def_map, type_env, &law_clone_vars, h_mode)?;
        let hr = emit_expr_with_mode(&h.rhs, def_map, type_env, &law_clone_vars, h_mode)?;
        hyp_pairs.push((hl, hr));
    }

    let cone = law_dependency_cone(law, defs);
    let recursive = cone_is_recursive(&cone, defs);
    let bounds_desc = if runtime_vars.is_empty() {
        "ground term".to_string()
    } else if recursive {
        "Nat in 0..=12, Bool in {false, true}, ADT depth <= 2".to_string()
    } else {
        "Nat in [0..=8, 16, 1000, u64::MAX-1, u64::MAX], Bool in {false, true}, ADT depth <= 2"
            .to_string()
    };

    let mut hyp_checks = String::new();
    for (hl, hr) in &hyp_pairs {
        hyp_checks.push_str(&format!("if ({hl}) != ({hr}) {{ return None; }} "));
    }
    let eval_expr = format!(
        "std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {{ __rb_reset_steps(); {hyp_checks}Some(({lhs_rs}, {rhs_rs})) }}))"
    );

    let mut s = String::new();
    let vis = if compact_mutant_mode { "pub " } else { "" };
    let ret_sig = if compact_mutant_mode {
        " -> Option<String>"
    } else {
        ""
    };
    s.push_str(&format!("{vis}fn {fn_name}(){ret_sig} {{\n"));

    if runtime_vars.is_empty() {
        s.push_str(&format!("    match {eval_expr} {{\n"));
        s.push_str("        Ok(Some((__lhs, __rhs))) if __lhs != __rhs => {\n");
        if compact_mutant_mode {
            s.push_str("            return Some(format!(\"lhs={:?}, rhs={:?}\", __lhs, __rhs));\n");
        } else {
            s.push_str("            println!(\"CE_BEGIN\");\n");
            s.push_str(&format!(
                "            println!(\"LAW {{}}\", \"{}\");\n",
                escape_rust_str(&law.name)
            ));
            s.push_str("            println!(\"LHS {:?}\", __lhs);\n");
            s.push_str("            println!(\"RHS {:?}\", __rhs);\n");
            s.push_str("            println!(\"CE_END\");\n");
        }
        s.push_str("        }\n");
        s.push_str("        Ok(Some(_)) => {\n");
        if compact_mutant_mode {
            s.push_str("            return None;\n");
        } else {
            s.push_str(&format!(
                "            println!(\"NONE\\t{{}}\\t1\\t{{}}\", \"{}\", \"{}\");\n",
                escape_rust_str(&law.name),
                escape_rust_str(&bounds_desc)
            ));
        }
        s.push_str("        }\n");
        s.push_str("        _ => {\n");
        if compact_mutant_mode {
            s.push_str("            return None;\n");
        } else {
            s.push_str(&format!(
                "            println!(\"NONE\\t{{}}\\t0\\t{{}}\", \"{}\", \"{}\");\n",
                escape_rust_str(&law.name),
                escape_rust_str(&bounds_desc)
            ));
        }
        s.push_str("        }\n");
        s.push_str("    }\n");
        s.push_str("}\n");
        return Ok(s);
    }

    let seed = 0x517c_c1b7_2722_0a95_u64
        ^ u64::from_str_radix(&lock::fnv1a_hex(law.name.as_bytes()), 16).unwrap_or(0);
    s.push_str(&format!("    let mut __rng_val: u64 = {seed}_u64;\n"));
    s.push_str("    let rng = &mut __rng_val;\n");
    for (vi, v) in runtime_vars.iter().enumerate() {
        let pool_expr = emit_pool_expr(
            &v.ty,
            type_map,
            &type_param_set,
            if recursive { "true" } else { "false" },
            "2",
        );
        s.push_str(&format!("    let __p{vi} = {pool_expr};\n"));
    }
    s.push_str("    let mut __checked: usize = 0;\n");
    s.push_str("    let mut __found_ce = false;\n");
    s.push_str("    let mut __ce_summary: Option<String> = None;\n");
    s.push_str("    let __try_case = |__checked: &mut usize, __ce_out: &mut Option<String>");
    for (vi, v) in runtime_vars.iter().enumerate() {
        let rty = bend_type_to_rust_with_u64_params(&v.ty, &type_param_set);
        s.push_str(&format!(", __arg{vi}: &{rty}"));
    }
    s.push_str("| -> bool {\n");
    for (vi, v) in runtime_vars.iter().enumerate() {
        s.push_str(&format!("        let {} = __arg{vi}.clone();\n", v.name));
    }
    s.push_str(&format!("        match {eval_expr} {{\n"));
    s.push_str("            Err(__p) if __rb_is_nat_overflow(&*__p) => false,\n");
    s.push_str("            Err(__p) => std::panic::resume_unwind(__p),\n");
    s.push_str("            Ok(None) => false,\n");
    s.push_str("            Ok(Some((__lhs, __rhs))) => {\n");
    s.push_str("                *__checked += 1;\n");
    s.push_str("                if __lhs != __rhs {\n");
    if compact_mutant_mode {
        let bind_fmt = runtime_vars
            .iter()
            .map(|v| format!("{}={{:?}}", v.name))
            .collect::<Vec<_>>()
            .join(", ");
        let bind_args = runtime_vars
            .iter()
            .map(|v| v.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        s.push_str(&format!(
            "                    *__ce_out = Some(format!(\"{bind_fmt}: lhs={{:?}}, rhs={{:?}}\", {bind_args}, __lhs, __rhs));\n"
        ));
    } else {
        s.push_str("                    let _ = __ce_out;\n");
        s.push_str("                    println!(\"CE_BEGIN\");\n");
        s.push_str(&format!(
            "                    println!(\"LAW {{}}\", \"{}\");\n",
            escape_rust_str(&law.name)
        ));
        for v in &runtime_vars {
            s.push_str(&format!(
                "                    println!(\"BIND {}={{:?}}\", {});\n",
                escape_rust_str(&v.name),
                v.name
            ));
        }
        s.push_str("                    println!(\"LHS {:?}\", __lhs);\n");
        s.push_str("                    println!(\"RHS {:?}\", __rhs);\n");
        s.push_str("                    println!(\"CE_END\");\n");
    }
    s.push_str("                    true\n");
    s.push_str("                } else {\n");
    s.push_str("                    false\n");
    s.push_str("                }\n");
    s.push_str("            }\n");
    s.push_str("        }\n");
    s.push_str("    };\n");

    // Phase 1: small combinations first so minimal counterexamples (e.g. a=3, f=0, rel=4) appear first.
    let small_cap = if runtime_vars.len() <= 3 {
        6
    } else if runtime_vars.len() == 4 {
        4
    } else {
        2
    };
    let mut indent = "    ".to_string();
    for vi in 0..runtime_vars.len() {
        s.push_str(&format!(
            "{indent}for __v{vi} in &__p{vi}[..__p{vi}.len().min({small_cap})] {{\n"
        ));
        indent.push_str("    ");
    }
    let small_call = (0..runtime_vars.len())
        .map(|vi| format!("__v{vi}"))
        .collect::<Vec<_>>()
        .join(", ");
    s.push_str(&format!(
        "{indent}if __try_case(&mut __checked, &mut __ce_summary, {small_call}) {{ __found_ce = true; break; }}\n"
    ));
    for vi in (0..runtime_vars.len()).rev() {
        indent.truncate(indent.len() - 4);
        s.push_str(&format!("{indent}}}\n"));
        if vi > 0 {
            s.push_str(&format!("{indent}if __found_ce {{ break; }}\n"));
        }
    }

    // Phase 2: full Cartesian product (up to 8192) or sweeps + seeded PRNG samples
    let lens_prod = runtime_vars
        .iter()
        .enumerate()
        .map(|(vi, _)| format!("__p{vi}.len()"))
        .fold("1usize".to_string(), |acc, x| {
            format!("{acc}.saturating_mul({x})")
        });
    s.push_str("    if !__found_ce {\n");
    s.push_str(&format!("        let __total = {lens_prod};\n"));
    s.push_str("        if __total <= 8192 {\n");
    let mut ind2 = "            ".to_string();
    for vi in 0..runtime_vars.len() {
        s.push_str(&format!("{ind2}for __v{vi} in &__p{vi} {{\n"));
        ind2.push_str("    ");
    }
    let full_call = (0..runtime_vars.len())
        .map(|vi| format!("__v{vi}"))
        .collect::<Vec<_>>()
        .join(", ");
    s.push_str(&format!(
        "{ind2}if __try_case(&mut __checked, &mut __ce_summary, {full_call}) {{ __found_ce = true; break; }}\n"
    ));
    for vi in (0..runtime_vars.len()).rev() {
        ind2.truncate(ind2.len() - 4);
        s.push_str(&format!("{ind2}}}\n"));
        if vi > 0 {
            s.push_str(&format!("{ind2}if __found_ce {{ break; }}\n"));
        }
    }
    s.push_str("        } else {\n");
    for vi in 0..runtime_vars.len() {
        s.push_str("            if !__found_ce {\n");
        s.push_str(&format!(
            "                for (__idx, __val) in __p{vi}.iter().enumerate() {{\n"
        ));
        let args_zero = (0..runtime_vars.len())
            .map(|k| {
                if k == vi {
                    "__val".to_string()
                } else {
                    format!("&__p{k}[0]")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        s.push_str(&format!(
            "                    if __try_case(&mut __checked, &mut __ce_summary, {args_zero}) {{ __found_ce = true; break; }}\n"
        ));
        let args_diag = (0..runtime_vars.len())
            .map(|k| {
                if k == vi {
                    "__val".to_string()
                } else {
                    format!("&__p{k}[(__idx + {k}) % __p{k}.len()]")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        s.push_str(&format!(
            "                    if __try_case(&mut __checked, &mut __ce_summary, {args_diag}) {{ __found_ce = true; break; }}\n"
        ));
        s.push_str("                }\n");
        s.push_str("            }\n");
    }
    s.push_str("            if !__found_ce {\n");
    s.push_str("                for _ in 0..2048 {\n");
    let args_sample = (0..runtime_vars.len())
        .map(|k| format!("&__p{k}[(__rb_next_u64(rng) as usize) % __p{k}.len()]"))
        .collect::<Vec<_>>()
        .join(", ");
    s.push_str(&format!(
        "                    if __try_case(&mut __checked, &mut __ce_summary, {args_sample}) {{ __found_ce = true; break; }}\n"
    ));
    s.push_str("                }\n");
    s.push_str("            }\n");
    s.push_str("        }\n");
    s.push_str("    }\n");

    if compact_mutant_mode {
        s.push_str("    __ce_summary\n");
    } else {
        s.push_str("    if !__found_ce {\n");
        s.push_str(&format!(
            "        println!(\"NONE\\t{{}}\\t{{}}\\t{{}}\", \"{}\", __checked, \"{}\");\n",
            escape_rust_str(&law.name),
            escape_rust_str(&bounds_desc)
        ));
        s.push_str("    }\n");
    }
    s.push_str("}\n");
    Ok(s)
}

fn parse_eval_protocol(
    stdout: &str,
    law_by_name: &HashMap<String, &ParsedLaw>,
) -> Vec<LawEvalOutcome> {
    let mut outcomes = Vec::new();
    let mut in_ce = false;
    let mut cur_law = String::new();
    let mut cur_binds: Vec<(String, String)> = Vec::new();
    let mut cur_lhs = String::new();
    let mut cur_rhs = String::new();

    for line in stdout.lines() {
        if line == "CE_BEGIN" {
            in_ce = true;
            cur_law.clear();
            cur_binds.clear();
            cur_lhs.clear();
            cur_rhs.clear();
            continue;
        }
        if line == "CE_END" && in_ce {
            in_ce = false;
            let (lhs_raw, rhs_raw) = law_by_name
                .get(&cur_law)
                .map(|l| (l.lhs.as_str(), l.rhs.as_str()))
                .unwrap_or(("", ""));
            outcomes.push(LawEvalOutcome::Counterexample(Counterexample {
                law_name: cur_law.clone(),
                bindings: cur_binds.clone(),
                lhs_display: substitute_bindings(lhs_raw, &cur_binds),
                rhs_display: substitute_bindings(rhs_raw, &cur_binds),
                lhs_val: cur_lhs.clone(),
                rhs_val: cur_rhs.clone(),
            }));
            continue;
        }
        if in_ce {
            if let Some(name) = line.strip_prefix("LAW ") {
                cur_law = name.trim().to_string();
            } else if let Some(bind) = line.strip_prefix("BIND ") {
                if let Some((k, v)) = bind.split_once('=') {
                    cur_binds.push((k.trim().to_string(), v.trim().to_string()));
                }
            } else if let Some(val) = line.strip_prefix("LHS ") {
                cur_lhs = val.trim().to_string();
            } else if let Some(val) = line.strip_prefix("RHS ") {
                cur_rhs = val.trim().to_string();
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("NONE\t") {
            let parts: Vec<&str> = rest.splitn(3, '\t').collect();
            if parts.len() == 3 {
                outcomes.push(LawEvalOutcome::NoCounterexample {
                    law_name: parts[0].to_string(),
                    checked: parts[1].parse().unwrap_or(0),
                    bounds: parts[2].to_string(),
                });
            }
        }
    }
    outcomes
}

fn substitute_bindings(expr: &str, bindings: &[(String, String)]) -> String {
    let bind_map: HashMap<&str, &str> = bindings
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let chars: Vec<char> = expr.chars().collect();
    let mut out = String::with_capacity(expr.len());
    let mut i = 0usize;

    while i < chars.len() {
        if chars[i].is_ascii_alphabetic() || chars[i] == '_' {
            let prev_is_dot_or_ident = i > 0
                && (chars[i - 1] == '.'
                    || chars[i - 1].is_ascii_alphanumeric()
                    || chars[i - 1] == '_');
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let ident: String = chars[start..i].iter().collect();
            let next_is_dot = i < chars.len() && chars[i] == '.';
            if !prev_is_dot_or_ident && !next_is_dot {
                if let Some(val) = bind_map.get(ident.as_str()) {
                    out.push_str(val);
                    continue;
                }
            }
            out.push_str(&ident);
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }

    out
}

/// Formats counterexample or proof-only failure diagnostics for display before the Bend error.
pub fn format_counterexample_diagnosis(
    outcomes: &[LawEvalOutcome],
    locked_laws: &BTreeSet<String>,
) -> String {
    let counterexamples: Vec<&Counterexample> = outcomes
        .iter()
        .filter_map(|o| match o {
            LawEvalOutcome::Counterexample(ce) => Some(ce),
            _ => None,
        })
        .collect();

    if !counterexamples.is_empty() {
        return counterexamples
            .iter()
            .map(|ce| {
                let binds = if ce.bindings.is_empty() {
                    "(ground expression)".to_string()
                } else {
                    ce.bindings
                        .iter()
                        .map(|(k, v)| format!("{k} = {v}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                let width = ce.lhs_display.len().max(ce.rhs_display.len());
                let hint = if locked_laws.contains(&ce.law_name) {
                    "fix the function (or, if the change is meant to break this law, stop: the law is locked)"
                } else {
                    "fix the function (or revise the unlocked law if the specification changed)"
                };
                format!(
                    "[E_LAW_FALSE] law {} is FALSE for this code (evaluated with emitted Rust):\n  {binds}\n  lhs {:<width$} = {}\n  rhs {:<width$} = {}\n{hint}",
                    ce.law_name, ce.lhs_display, ce.lhs_val, ce.rhs_display, ce.rhs_val
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
    }

    outcomes
        .iter()
        .filter_map(|o| match o {
            LawEvalOutcome::NoCounterexample {
                law_name,
                checked,
                bounds,
            } => Some(format!(
                "law {law_name}: no counterexample up to {bounds} ({checked} cases checked, evaluated with emitted Rust): the law may be true; the proof is what failed"
            )),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::emit::emit_verified_rust;
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn tmp_dir(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = env::temp_dir().join(format!("rb_law_test_{tag}_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_bend2_and_legacy_laws_with_hypotheses_and_deps() {
        let src = r#"
import Base

def helper(x: Nat) -> Nat:
  Nat.add(x, 1n)

def top(x: Nat) -> Nat:
  helper(x)

law simple_law:
  for x: Nat
  for h: {x == x : Nat}
  {top(x) == Nat.add(x, 1n) : Nat}

law legacy_law(for +a: Nat, for +b: Bool):
  a == a
"#;
        let laws = parse_laws(src);
        assert_eq!(laws.len(), 2);
        assert_eq!(laws[0].name, "simple_law");
        assert_eq!(laws[0].vars.len(), 1);
        assert_eq!(laws[0].hypotheses.len(), 1);
        assert_eq!(laws[0].eq_ty, "Nat");
        assert!(laws[0].unsupported_reason.is_none());

        let (_, defs) = crate::emit::parse_book_items(src).unwrap();
        let cone = law_dependency_cone(&laws[0], &defs);
        assert_eq!(cone, vec!["helper".to_string(), "top".to_string()]);
        assert!(!cone_is_recursive(&cone, &defs));
    }

    #[test]
    fn issue5_reproducer_checked_nat_passes_generated_test_and_catches_buggy_code() {
        // Exact reproducer from issue #5, completed with its Bend 2 proof.
        let bend_src = r#"import Base

type Ledger is Data:
  Ledger{a: Nat, f: Nat}

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

def add_le_false_lt(+a: Nat, +k: Nat) -> {False{} == Nat.is_le(Nat.add(a, 1n+k), a) : Bool}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %add_le_false_lt(ap, k) : {False{} == _ : Bool}
      {==}

law over_release_is_noop:
  for +a: Nat
  for +f: Nat
  for +extra: Nat
  {ledger_release(Ledger{a, f}, Nat.add(a, 1n+extra)) == Ledger{a, f} : Ledger}

def over_release_is_noop(a, f, extra):
  %add_le_false_lt(a, extra) : {ledger_release_if(a, f, Nat.add(a, 1n+extra), _) == Ledger{a, f} : Ledger}
  {==}
"#;
        let dir = tmp_dir("issue5");
        let bend_file = dir.join("ledger.bend");
        fs::write(&bend_file, bend_src).unwrap();

        let bend_bin = crate::resolve_bend_bin(
            env::var("BEND_BIN").ok(),
            env::var_os("PATH"),
            env::var_os("HOME").map(PathBuf::from),
        );
        if let Ok(out) = Command::new(&bend_bin)
            .arg(&bend_file)
            .arg("--check-only")
            .output()
        {
            assert!(
                out.status.success(),
                "bend --check-only failed: {}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        }

        let summary = emit_verified_rust(bend_src, 1).expect("emit ledger reproducer");
        assert!(summary
            .rust_source
            .contains("fn law_over_release_is_noop()"));

        // 1. Checked Nat arithmetic passes the generated test AND explicitly refuses u64::MAX overflow.
        let overflow_check = format!(
            "{}\n#[cfg(test)]\n#[test]\nfn overflow_panics_instead_of_saturating() {{\n    let res = std::panic::catch_unwind(|| ledger_release(Ledger::Ledger(u64::MAX, 7), u64::MAX));\n    let _ = res;\n    let add_overflow = std::panic::catch_unwind(|| {{\n        let a = u64::MAX;\n        let rel = (a).checked_add((1_u64).checked_add(0).expect(\"rusty-bends: Nat overflow\")).expect(\"rusty-bends: Nat overflow\");\n        ledger_release(Ledger::Ledger(a, 7), rel)\n    }});\n    assert!(add_overflow.is_err(), \"overflow in Nat.add must panic instead of saturating\");\n}}\n",
            summary.rust_source
        );
        let rs_ok = dir.join("ledger_ok.rs");
        let bin_ok = dir.join("ledger_ok_bin");
        fs::write(&rs_ok, overflow_check).unwrap();
        let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = Command::new(&rustc)
            .args(["--edition", "2021", "--test", "-o"])
            .arg(&bin_ok)
            .arg(&rs_ok)
            .output()
            .expect("rustc must run");
        assert!(
            compile.status.success(),
            "rustc --test failed: {}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run_ok = Command::new(&bin_ok).output().expect("run test binary");
        assert!(
            run_ok.status.success(),
            "generated law test should pass:\n{}{}",
            String::from_utf8_lossy(&run_ok.stdout),
            String::from_utf8_lossy(&run_ok.stderr)
        );

        // 2. If the emitted Rust had saturating_add instead of checked_add, law_over_release_is_noop MUST fail at u64::MAX!
        let buggy_sat = summary
            .rust_source
            .replace(
                ".checked_add((1_u64).checked_add(extra).expect(\"rusty-bends: Nat overflow\")).expect(\"rusty-bends: Nat overflow\")",
                ".saturating_add((1_u64).saturating_add(extra))",
            )
            .replace(
                ".checked_add(extra).expect(\"rusty-bends: Nat overflow\")",
                ".saturating_add(extra)",
            )
            .replace(
                ".checked_add(rel).expect(\"rusty-bends: Nat overflow\")",
                ".saturating_add(rel)",
            );
        let rs_bug = dir.join("ledger_bug.rs");
        let bin_bug = dir.join("ledger_bug_bin");
        fs::write(&rs_bug, buggy_sat).unwrap();
        let compile_bug = Command::new(&rustc)
            .args(["--edition", "2021", "--test", "-o"])
            .arg(&bin_bug)
            .arg(&rs_bug)
            .output()
            .expect("rustc must run");
        assert!(compile_bug.status.success());
        let run_bug = Command::new(&bin_bug).output().expect("run buggy binary");
        assert!(
            !run_bug.status.success(),
            "generated law test must catch saturating u64::MAX failure"
        );
        let combined_out = format!(
            "{}{}",
            String::from_utf8_lossy(&run_bug.stdout),
            String::from_utf8_lossy(&run_bug.stderr)
        );
        assert!(
            combined_out.contains("law over_release_is_noop failed on emitted Rust"),
            "output should name the failing law and inputs: {combined_out}"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recursive_nat_cone_bounds_inputs_and_passes_compiled_test() {
        let bend_src = r#"import Base

def rec_id(n: Nat) -> Nat:
  match n:
    case 0n: 0n
    case 1n+p: Nat.add(1n, rec_id(p))

law rec_id_same:
  for n: Nat
  {rec_id(n) == n : Nat}
"#;
        let (_, defs) = crate::emit::parse_book_items(bend_src).unwrap();
        let laws = parse_laws(bend_src);
        let cone = law_dependency_cone(&laws[0], &defs);
        assert!(cone_is_recursive(&cone, &defs));

        let summary = emit_verified_rust(bend_src, 1).expect("emit recursive law");
        assert!(summary.rust_source.contains("__rb_pool_nat(rng, true)"));

        let dir = tmp_dir("rec");
        let rs = dir.join("rec.rs");
        let bin = dir.join("rec_bin");
        fs::write(&rs, &summary.rust_source).unwrap();
        let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = Command::new(&rustc)
            .args(["--edition", "2021", "--test", "-o"])
            .arg(&bin)
            .arg(&rs)
            .output()
            .expect("rustc must run");
        assert!(
            compile.status.success(),
            "rustc --test failed: {}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run = Command::new(&bin).output().expect("run test binary");
        assert!(
            run.status.success(),
            "recursive law test failed:\n{}{}",
            String::from_utf8_lossy(&run.stdout),
            String::from_utf8_lossy(&run.stderr)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn evaluates_broken_law_counterexample_directly() {
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

law release_conserves_total:
  for +a: Nat
  for +f: Nat
  for +rel: Nat
  {ledger_total(ledger_release(Ledger{a, f}, rel)) == Nat.add(a, f) : Nat}

def release_conserves_total(a, f, rel):
  {==}
"#;
        let dir = tmp_dir("direct_ce");
        let outcomes = evaluate_laws_for_counterexamples(
            broken_src,
            &["release_conserves_total".to_string()],
            &dir,
        )
        .expect("counterexample evaluation must succeed");
        assert_eq!(outcomes.len(), 1);
        assert!(matches!(outcomes[0], LawEvalOutcome::Counterexample(_)));
        let _ = fs::remove_dir_all(&dir);
    }
}
