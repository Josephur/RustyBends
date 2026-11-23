//! Generated per-law Rust tests for RustyBends.
//!
//! Parses `law` declarations from Bend 2 sources and emits `#[cfg(test)]` tests
//! into `OUT_DIR/verified.rs` so `cargo test` evaluates every law directly against
//! the emitted Rust code (catching translation bugs and `Nat`/`u64` edge divergence).

use crate::emit::{
    arith_mode_for_type, bend_type_to_rust, emit_expr_with_mode, is_top_level_start,
    is_wrapped_in_parens, split_top_level, split_top_level_once, split_top_level_str,
    strip_comment, ArithMode, CtorInfo, Def, TypeDef,
};
use crate::lock;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

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
    let lines: Vec<&str> = source.lines().collect();
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
                for clause in split_top_level(inner, ',') {
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
    ctor_map: &HashMap<String, CtorInfo>,
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
    out.push_str(&emit_pool_runtime_helpers(types, &type_map));

    let mut used_fn_names: HashSet<String> = HashSet::new();
    for (idx, law) in laws.iter().enumerate() {
        let mut fn_name = format!("law_{}", sanitize_ident(&law.name));
        if !used_fn_names.insert(fn_name.clone()) {
            fn_name = format!("{fn_name}_{idx}");
            used_fn_names.insert(fn_name.clone());
        }
        out.push_str(&emit_single_law_test(
            &fn_name, law, types, defs, &def_map, &type_map, ctor_map,
        ));
        out.push('\n');
    }

    out.push_str("}\n");
    out
}

fn sanitize_ident(s: &str) -> String {
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

fn emit_pool_runtime_helpers(types: &[TypeDef], type_map: &HashMap<String, &TypeDef>) -> String {
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
        if let Some(msg) = payload.downcast_ref::<&str>() {
            return msg.contains("rusty-bends: Nat overflow");
        }
        if let Some(msg) = payload.downcast_ref::<String>() {
            return msg.contains("rusty-bends: Nat overflow");
        }
        false
    }

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
        out.push((a[0].clone(), b[0].clone()));
        out.push((a[a.len() - 1].clone(), b[b.len() - 1].clone()));
        out.push((a[a.len() - 1].clone(), b[0].clone()));
        out.push((a[0].clone(), b[b.len() - 1].clone()));
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
        let max_len = a.len().max(b.len());
        for i in 0..max_len {
            if out.len() >= cap {
                break;
            }
            out.push((a[i % a.len()].clone(), b[i % b.len()].clone()));
        }
        out
    }

"#,
    );

    let empty_params = HashSet::new();
    for td in types {
        s.push_str(&emit_adt_pool_fn(td, type_map, &empty_params));
        s.push('\n');
    }
    s
}

fn emit_adt_pool_fn(
    td: &TypeDef,
    type_map: &HashMap<String, &TypeDef>,
    type_params: &HashSet<String>,
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
            s.push_str(&format!("{indent}for f0 in {expr} {{\n"));
            s.push_str(&format!(
                "{indent}    out.push({}::{}(f0));\n",
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
            let max_expr = (0..v.field_types.len()).fold("0usize".to_string(), |acc, fi| {
                format!("{acc}.max(__f{fi}.len())")
            });
            s.push_str(&format!(
                "{inner_indent}let __limit = ({max_expr}).min(24);\n"
            ));
            // Always cover edge corners across first two fields and uniform edge tuple
            let edge_args = (0..v.field_types.len())
                .map(|fi| format!("__f{fi}[__f{fi}.len() - 1].clone()"))
                .collect::<Vec<_>>()
                .join(", ");
            s.push_str(&format!(
                "{inner_indent}out.push({}::{}({edge_args}));\n",
                td.name, v.name
            ));
            s.push_str(&format!("{inner_indent}for __i in 0..__limit {{\n"));
            let args_sweep = (0..v.field_types.len())
                .map(|fi| format!("__f{fi}[__i % __f{fi}.len()].clone()"))
                .collect::<Vec<_>>()
                .join(", ");
            s.push_str(&format!(
                "{inner_indent}    out.push({}::{}({args_sweep}));\n",
                td.name, v.name
            ));
            s.push_str(&format!("{inner_indent}}}\n"));
            s.push_str(&format!("{inner_indent}for _ in 0..4 {{\n"));
            let args_rng = (0..v.field_types.len())
                .map(|fi| format!("__f{fi}[(__rb_next_u64(rng) as usize) % __f{fi}.len()].clone()"))
                .collect::<Vec<_>>()
                .join(", ");
            s.push_str(&format!(
                "{inner_indent}    out.push({}::{}({args_rng}));\n",
                td.name, v.name
            ));
            s.push_str(&format!("{inner_indent}}}\n"));
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
        let parts = split_top_level(inner, ',');
        return parts.iter().any(|p| type_references_adt(p, type_map));
    }
    let amp = split_top_level(t, '&');
    if amp.len() > 1 {
        return amp.iter().any(|p| type_references_adt(p, type_map));
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
        let parts = split_top_level(inner, ',');
        if parts.len() > 1 {
            return parts
                .iter()
                .all(|p| can_generate_pool(p, type_map, type_params));
        }
        return can_generate_pool(inner, type_map, type_params);
    }
    let amp = split_top_level(t, '&');
    if amp.len() > 1 {
        return amp
            .iter()
            .all(|p| can_generate_pool(p, type_map, type_params));
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
        let parts = split_top_level(inner, ',');
        if parts.len() > 1 {
            return emit_tuple_pool_expr(&parts, type_map, type_params, recursive_expr, depth_expr);
        }
        return emit_pool_expr(inner, type_map, type_params, recursive_expr, depth_expr);
    }
    let amp = split_top_level(t, '&');
    if amp.len() > 1 {
        return emit_tuple_pool_expr(&amp, type_map, type_params, recursive_expr, depth_expr);
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
    ctor_map: &HashMap<String, CtorInfo>,
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

    let default_mode = arith_mode_for_type(&law.eq_ty, ArithMode::NatChecked);
    let lhs_rs = match emit_expr_with_mode(&law.lhs, def_map, ctor_map, default_mode) {
        Ok(s) => s,
        Err(e) => return format!("    // Skipped law {}: {e}\n", law.name),
    };
    let rhs_rs = match emit_expr_with_mode(&law.rhs, def_map, ctor_map, default_mode) {
        Ok(s) => s,
        Err(e) => return format!("    // Skipped law {}: {e}\n", law.name),
    };

    let mut hyp_pairs = Vec::new();
    for h in &law.hypotheses {
        let h_mode = arith_mode_for_type(&h.ty, ArithMode::NatChecked);
        let hl = match emit_expr_with_mode(&h.lhs, def_map, ctor_map, h_mode) {
            Ok(s) => s,
            Err(e) => return format!("    // Skipped law {}: {e}\n", law.name),
        };
        let hr = match emit_expr_with_mode(&h.rhs, def_map, ctor_map, h_mode) {
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
        let parts = split_top_level(inner, ',');
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
    let amp = split_top_level(t, '&');
    if amp.len() > 1 {
        let mapped = amp
            .into_iter()
            .map(|p| bend_type_to_rust_with_u64_params(p, type_params))
            .collect::<Vec<_>>()
            .join(", ");
        return format!("({mapped})");
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

type PoolAcct is Data:
  PoolAcct{a: Nat, f: Nat}

def pool_free_if(+a: Nat, +f: Nat, +rel: Nat, ok: Bool) -> PoolAcct:
  match ok:
    case True{}:
      PoolAcct{Nat.sub(a, rel), Nat.add(f, rel)}
    case False{}:
      PoolAcct{a, f}

def pool_free(+p: PoolAcct, +rel: Nat) -> PoolAcct:
  match p:
    case PoolAcct{+a, f}:
      pool_free_if(a, f, rel, Nat.is_le(rel, a))

def add_le_false_lt(+a: Nat, +k: Nat) -> {False{} == Nat.is_le(Nat.add(a, 1n+k), a) : Bool}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %add_le_false_lt(ap, k) : {False{} == _ : Bool}
      {==}

law pool_double_free_noop:
  for +a: Nat
  for +f: Nat
  for +extra: Nat
  {pool_free(PoolAcct{a, f}, Nat.add(a, 1n+extra)) == PoolAcct{a, f} : PoolAcct}

def pool_double_free_noop(a, f, extra):
  %add_le_false_lt(a, extra) : {pool_free_if(a, f, Nat.add(a, 1n+extra), _) == PoolAcct{a, f} : PoolAcct}
  {==}
"#;
        let dir = tmp_dir("issue5");
        let bend_file = dir.join("pool.bend");
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

        let summary = emit_verified_rust(bend_src, 1).expect("emit pool reproducer");
        assert!(summary
            .rust_source
            .contains("fn law_pool_double_free_noop()"));

        // 1. Checked Nat arithmetic passes the generated test AND explicitly refuses u64::MAX overflow.
        let overflow_check = format!(
            "{}\n#[cfg(test)]\n#[test]\nfn overflow_panics_instead_of_saturating() {{\n    let res = std::panic::catch_unwind(|| pool_free(PoolAcct::PoolAcct(u64::MAX, 7), u64::MAX));\n    let _ = res;\n    let add_overflow = std::panic::catch_unwind(|| {{\n        let a = u64::MAX;\n        let rel = (a).checked_add((1_u64).checked_add(0).expect(\"rusty-bends: Nat overflow\")).expect(\"rusty-bends: Nat overflow\");\n        pool_free(PoolAcct::PoolAcct(a, 7), rel)\n    }});\n    assert!(add_overflow.is_err(), \"overflow in Nat.add must panic instead of saturating\");\n}}\n",
            summary.rust_source
        );
        let rs_ok = dir.join("pool_ok.rs");
        let bin_ok = dir.join("pool_ok_bin");
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

        // 2. If the emitted Rust had saturating_add instead of checked_add, law_pool_double_free_noop MUST fail at u64::MAX!
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
        let rs_bug = dir.join("pool_bug.rs");
        let bin_bug = dir.join("pool_bug_bin");
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
            combined_out.contains("law pool_double_free_noop failed on emitted Rust"),
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
}
