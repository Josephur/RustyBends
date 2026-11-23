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
pub(crate) struct CtorInfo {
    pub(crate) type_name: String,
    pub(crate) variant_name: String,
    pub(crate) arity: usize,
}

pub(crate) fn build_ctor_map(types: &[TypeDef]) -> HashMap<String, CtorInfo> {
    let mut ctor_map: HashMap<String, CtorInfo> = HashMap::new();
    for td in types {
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
    ctor_map
}

/// Parses Bend v1 'type' and 'def' items from verified source, erases all q=0 parts and laws,
/// and emits zero-dependency Rust (plus generated `#[cfg(test)]` per-law checks) ready for
/// `include!(concat!(env!("OUT_DIR"), "/verified.rs"))`.
pub fn emit_verified_rust(source: &str, laws_verified: usize) -> Result<EmitSummary, String> {
    let (types, defs) = parse_book_items(source)?;
    let ctor_map = build_ctor_map(&types);
    let mut summary = emit_items_to_rust(&types, &defs, &ctor_map, laws_verified, None)?;

    let laws = crate::law_test::parse_laws(source);
    if !laws.is_empty() {
        let test_mod = crate::law_test::emit_law_tests_module(&laws, &types, &defs, &ctor_map);
        if !test_mod.is_empty() {
            summary.rust_source.push('\n');
            summary.rust_source.push_str(&test_mod);
        }
    }

    Ok(summary)
}

/// Emits pure runtime Rust only (without `#[cfg(test)]` law harnesses).
pub fn emit_runtime_only(source: &str, laws_verified: usize) -> Result<EmitSummary, String> {
    let (types, defs) = parse_book_items(source)?;
    let ctor_map = build_ctor_map(&types);
    emit_items_to_rust(&types, &defs, &ctor_map, laws_verified, None)
}

pub(crate) fn emit_items_to_rust(
    types: &[TypeDef],
    defs: &[Def],
    ctor_map: &HashMap<String, CtorInfo>,
    laws_verified: usize,
    step_limit: Option<usize>,
) -> Result<EmitSummary, String> {
    let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
    let mut dead_params_erased = 0usize;
    let mut blocks = Vec::new();
    let empty_set = HashSet::new();

    if let Some(limit) = step_limit {
        blocks.push(format!(
            "std::thread_local! {{\n    static __RB_STEPS: std::cell::Cell<usize> = const {{ std::cell::Cell::new(0) }};\n}}\n\nfn __rb_reset_steps() {{\n    __RB_STEPS.with(|c| c.set(0));\n}}\n\nfn __rb_tick() {{\n    __RB_STEPS.with(|c| {{\n        let next = c.get().saturating_add(1);\n        c.set(next);\n        if next > {limit} {{\n            panic!(\"rusty-bends: step limit\");\n        }}\n    }});\n}}"
        ));
    }

    for td in types {
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

    for def in defs {
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

        let default_mode = arith_mode_for_type(&def.ret, ArithMode::NatChecked);
        let body_expr = emit_expr_with_mode(&def.body, &def_map, ctor_map, default_mode)?;
        let ret_ty = infer_return_type(&def.body, &def.ret, &type_param_set);
        let guard_prefix = if step_limit.is_some() {
            "__rb_tick();\n    "
        } else {
            ""
        };

        blocks.push(format!(
            "#[inline]\n#[allow(unused_variables, unused_parens, clippy::let_and_return, clippy::double_parens, clippy::unnecessary_cast)]\npub fn {name}{generics}({rust_params}) -> {ret_ty} {{\n    {guard_prefix}{body_expr}\n}}",
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

        if stripped.starts_with("def ") {
            // Bend 2 allows the parameter list (and an equality return type) to span lines:
            //   def f(
            //     +a: Nat,
            //     b: Nat
            //   ) -> Bool:
            let (header, last_header_line) = collect_header(&lines, i);
            i = last_header_line;
            let rest = &header["def ".len()..];
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
                return Err(format!(
                    "[E_EMIT_EMPTY_BODY] Empty body in 'def {header_part}'"
                ));
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

pub(crate) fn is_top_level_start(raw_line: &str, trimmed: &str) -> bool {
    let not_indented = !raw_line.starts_with(' ') && !raw_line.starts_with('\t');
    not_indented
        && (trimmed.starts_with("import ")
            || trimmed.starts_with("type ")
            || trimmed.starts_with("def ")
            || trimmed.starts_with("law ")
            || trimmed.starts_with("proof "))
}

pub(crate) fn strip_comment(line: &str) -> &str {
    let mut end = line.len();
    if let Some(pos) = line.find('#') {
        end = end.min(pos);
    }
    if let Some(pos) = line.find("--") {
        end = end.min(pos);
    }
    &line[..end]
}

/// Net bracket depth change of a (comment-stripped) source fragment, over '()', '{}' and '[]'.
fn bracket_depth_delta(s: &str) -> i32 {
    s.chars().fold(0, |depth, ch| match ch {
        '(' | '{' | '[' => depth + 1,
        ')' | '}' | ']' => depth - 1,
        _ => depth,
    })
}

/// Joins a top-level item header starting at 'lines[start]' with its continuation lines
/// while any '(' / '{' / '[' is still open, so multi-line parameter lists parse like
/// single-line ones. Returns the flattened, comment-stripped header and the index of the
/// last line it consumed.
fn collect_header(lines: &[&str], start: usize) -> (String, usize) {
    let mut header = strip_comment(lines[start]).trim().to_string();
    let mut depth = bracket_depth_delta(&header);
    let mut last = start;
    while depth > 0 && last + 1 < lines.len() {
        last += 1;
        let piece = strip_comment(lines[last]).trim();
        if piece.is_empty() {
            continue;
        }
        if !header.ends_with('(') && !header.ends_with('{') && !header.ends_with('[') {
            header.push(' ');
        }
        header.push_str(piece);
        depth += bracket_depth_delta(piece);
    }
    (header, last)
}

fn split_header_colon(rest: &str) -> Result<(&str, &str), String> {
    let mut depth = 0i32;
    for (idx, ch) in rest.char_indices() {
        match ch {
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
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
pub(crate) enum ArithMode {
    NatChecked,
    Wrapping,
}

pub(crate) fn arith_mode_for_type(ty: &str, fallback: ArithMode) -> ArithMode {
    match ty.trim() {
        "U32" | "U64" | "I32" | "I64" => ArithMode::Wrapping,
        "Nat" => ArithMode::NatChecked,
        _ => fallback,
    }
}

pub(crate) fn bend_type_to_rust(ty: &str, type_params: &HashSet<String>) -> String {
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

enum NatPattern {
    Const(u64),
    Succ { offset: u64, var: String },
}

fn is_valid_rust_ident_or_wildcard(s: &str) -> bool {
    if s == "_" {
        return true;
    }
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn parse_nat_succ_pattern(p: &str) -> Result<Option<NatPattern>, String> {
    let mut cur = unwrap_outer_parens(p.trim());
    let mut offset: u64 = 0;
    let mut saw_succ = false;

    while let Some((lhs, rhs)) = split_top_level_once(cur, '+') {
        let lhs_trim = unwrap_outer_parens(lhs.trim());
        if lhs_trim.is_empty() {
            // Leading '+' on a Data binder like `+q` (or inside `1n++q`) leaves an empty LHS.
            break;
        }
        let Some(digits) = lhs_trim.strip_suffix('n') else {
            if saw_succ {
                return Err(format!(
                    "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported nested Nat pattern '{p}'"
                ));
            }
            return Ok(None);
        };
        if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
            if saw_succ {
                return Err(format!(
                    "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported nested Nat pattern '{p}'"
                ));
            }
            return Ok(None);
        }
        let k: u64 = digits.parse().map_err(|_| {
            format!("[E_EMIT_UNSUPPORTED_PATTERN] Nat literal overflow in pattern '{p}'")
        })?;
        offset = offset.checked_add(k).ok_or_else(|| {
            format!("[E_EMIT_UNSUPPORTED_PATTERN] Nat offset overflow in pattern '{p}'")
        })?;
        saw_succ = true;
        cur = unwrap_outer_parens(rhs.trim());
    }

    if !saw_succ {
        return Ok(None);
    }

    if let Some(digits) = cur.strip_suffix('n') {
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            let tail_k: u64 = digits.parse().map_err(|_| {
                format!("[E_EMIT_UNSUPPORTED_PATTERN] Nat literal overflow in pattern '{p}'")
            })?;
            let total = offset.checked_add(tail_k).ok_or_else(|| {
                format!("[E_EMIT_UNSUPPORTED_PATTERN] Nat offset overflow in pattern '{p}'")
            })?;
            return Ok(Some(NatPattern::Const(total)));
        }
    }

    let var = cur.trim_start_matches('+').trim_start_matches('-').trim();
    if !is_valid_rust_ident_or_wildcard(var) {
        return Err(format!(
            "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported successor tail '{cur}' in pattern '{p}'"
        ));
    }

    Ok(Some(NatPattern::Succ {
        offset,
        var: var.to_string(),
    }))
}

fn emit_single_pattern(
    pat: &str,
    ctors: &HashMap<String, CtorInfo>,
    succ_counter: &mut usize,
) -> Result<(String, Vec<String>), String> {
    let p = pat.trim();
    if p == "_" || p == "true" || p == "false" || p == "()" {
        return Ok((p.to_string(), Vec::new()));
    }
    if p == "True{}" {
        return Ok(("true".to_string(), Vec::new()));
    }
    if p == "False{}" {
        return Ok(("false".to_string(), Vec::new()));
    }
    if p == "Unit{}" {
        return Ok(("()".to_string(), Vec::new()));
    }
    if let Some(nat_pat) = parse_nat_succ_pattern(p)? {
        return match nat_pat {
            NatPattern::Const(total) => Ok((format!("{total}_u64"), Vec::new())),
            NatPattern::Succ { offset: 0, var } => Ok((var, Vec::new())),
            NatPattern::Succ { offset, var } if var == "_" => {
                Ok((format!("{offset}_u64..=u64::MAX"), Vec::new()))
            }
            NatPattern::Succ { offset, var } => {
                let idx = *succ_counter;
                *succ_counter += 1;
                let tmp = format!("__rb_n{idx}");
                Ok((
                    format!("{tmp} @ {offset}_u64..=u64::MAX"),
                    vec![format!("let {var} = {tmp} - {offset}_u64;")],
                ))
            }
        };
    }
    if let Some(digits) = p.strip_suffix('n') {
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            return Ok((format!("{digits}_u64"), Vec::new()));
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
                let (rp, mut b) = emit_single_pattern(part, ctors, succ_counter)?;
                rust_parts.push(rp);
                bindings.append(&mut b);
            }
            return Ok((format!("({})", rust_parts.join(", ")), bindings));
        }
    }
    // Real Bend 2 curly-brace pattern: Draft{}, Paid{amt}, Circle{+r}
    if let Some(open) = p.find('{') {
        if p.ends_with('}') {
            let head = p[..open].trim();
            if !is_valid_path_ident(head) {
                return Err(format!(
                    "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported constructor pattern '{p}'"
                ));
            }
            let inner = p[open + 1..p.len() - 1].trim();
            let rust_head = resolve_ctor_path(head, ctors);
            if inner.is_empty() {
                return Ok((rust_head, Vec::new()));
            }
            let mut bindings = Vec::new();
            let mut fields = Vec::new();
            for b in split_top_level(inner, ',') {
                let clean = b
                    .trim()
                    .trim_start_matches('+')
                    .trim_start_matches('-')
                    .trim();
                let rhs = if let Some((_, v)) = clean.split_once(':') {
                    v.trim()
                        .trim_start_matches('+')
                        .trim_start_matches('-')
                        .trim()
                } else {
                    clean
                };
                let (rp, mut bs) = emit_single_pattern(rhs, ctors, succ_counter)?;
                bindings.append(&mut bs);
                fields.push(rp);
            }
            return Ok((format!("{rust_head}({})", fields.join(", ")), bindings));
        }
    }
    if let Some(open) = p.find('(') {
        if p.ends_with(')') {
            let head = p[..open].trim();
            if !is_valid_path_ident(head) {
                return Err(format!(
                    "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported constructor pattern '{p}'"
                ));
            }
            let args = p[open + 1..p.len() - 1].trim();
            let rust_head = resolve_ctor_path(head, ctors);
            if args.is_empty() {
                return Ok((rust_head, Vec::new()));
            }
            let mut bindings = Vec::new();
            let mut fields = Vec::new();
            for arg in split_top_level(args, ',') {
                let (rp, mut bs) = emit_single_pattern(arg, ctors, succ_counter)?;
                bindings.append(&mut bs);
                fields.push(rp);
            }
            return Ok((format!("{rust_head}({})", fields.join(", ")), bindings));
        }
    }
    let clean = p.trim_start_matches('+').trim_start_matches('-').trim();
    if clean.is_empty() || !clean.split('.').all(is_valid_rust_ident_or_wildcard) {
        return Err(format!(
            "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported match pattern '{p}'"
        ));
    }
    Ok((resolve_ctor_path(clean, ctors), Vec::new()))
}

fn emit_match_pattern(
    pat: &str,
    scrut_count: usize,
    ctors: &HashMap<String, CtorInfo>,
) -> Result<(String, Vec<String>), String> {
    let mut succ_counter = 0usize;
    if scrut_count > 1 {
        let parts = split_pattern_tokens(pat);
        if parts.len() > 1 {
            let mut rust_parts = Vec::new();
            let mut bindings = Vec::new();
            for part in &parts {
                let (rp, mut b) = emit_single_pattern(part, ctors, &mut succ_counter)?;
                rust_parts.push(rp);
                bindings.append(&mut b);
            }
            return Ok((format!("({})", rust_parts.join(", ")), bindings));
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
    t.trim_start_matches('+')
        .trim_start_matches('-')
        .trim()
        .to_string()
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
            "+" | "-"
                | "*"
                | "/"
                | "%"
                | "=="
                | "!="
                | "<"
                | ">"
                | "<="
                | ">="
                | "&&"
                | "||"
                | "if"
                | "let"
                | "match"
                | "else:"
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
        let mut cur = raw[i].to_string();
        while i + 2 < raw.len() && cur.ends_with('n') && raw[i + 1] == "+" {
            cur.push('+');
            cur.push_str(raw[i + 2]);
            i += 2;
        }
        out.push(cur);
        i += 1;
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

pub(crate) fn emit_expr_with_mode(
    expr: &str,
    defs: &HashMap<String, &Def>,
    ctors: &HashMap<String, CtorInfo>,
    mode: ArithMode,
) -> Result<String, String> {
    let lines: Vec<&str> = expr.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return Ok("()".to_string());
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
                return Ok(format!(
                    "{{\n        let {} = {};\n        {}\n    }}",
                    clean_let_binding(lhs_raw),
                    emit_expr_with_mode(&val_src, defs, ctors, mode)?,
                    emit_expr_with_mode(&rest_src, defs, ctors, mode)?
                ));
            }
        }
    }

    // Handle match expressions: indentation-aware nested match, multi-scrutinee match, and single-line match
    if let Some(after_match) = first_trim.strip_prefix("match ") {
        if let Some((scrut_raw, inline_arms)) = split_top_level_once(after_match, ':') {
            let scrut_parts = split_match_scrutinees(scrut_raw);
            let rust_scrut = if scrut_parts.len() > 1 {
                let mut emitted = Vec::with_capacity(scrut_parts.len());
                for p in &scrut_parts {
                    emitted.push(emit_expr_with_mode(p, defs, ctors, mode)?);
                }
                format!("({})", emitted.join(", "))
            } else {
                emit_expr_with_mode(scrut_raw, defs, ctors, mode)?
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
                let (rust_pat, bindings) = emit_match_pattern(&pat, scrut_parts.len(), ctors)?;
                let emitted_body = emit_expr_with_mode(&arm_body, defs, ctors, mode)?;
                if bindings.is_empty() {
                    rust_arms.push(format!("        {rust_pat} => {emitted_body},"));
                } else {
                    rust_arms.push(format!(
                        "        {rust_pat} => {{ {} {emitted_body} }},",
                        bindings.join(" ")
                    ));
                }
            }
            return Ok(format!(
                "match {rust_scrut} {{\n{}\n    }}",
                rust_arms.join("\n")
            ));
        }
    }

    // Collapse remaining multi-line expressions (e.g. multi-line if/else, calls, annotations)
    let owned_flat;
    let s = if lines.len() == 1 {
        first_trim
    } else {
        owned_flat = lines.iter().map(|l| l.trim()).collect::<Vec<_>>().join(" ");
        owned_flat.as_str()
    };

    if s == "True{}" {
        return Ok("true".to_string());
    }
    if s == "False{}" {
        return Ok("false".to_string());
    }
    if s == "Unit{}" || s == "()" {
        return Ok("()".to_string());
    }

    // Handle conditionals: if cond: then_branch else: else_branch
    if let Some(rest) = s.strip_prefix("if ") {
        if let Some((before_else, after_else)) = split_keyword(rest, " else:") {
            if let Some((cond, then_b)) = split_top_level_once(before_else, ':') {
                return Ok(format!(
                    "if {} {{ {} }} else {{ {} }}",
                    emit_expr_with_mode(cond, defs, ctors, mode)?,
                    emit_expr_with_mode(then_b, defs, ctors, mode)?,
                    emit_expr_with_mode(after_else, defs, ctors, mode)?
                ));
            }
        }
    }

    // Unwrap outer parentheses and handle annotations (term : ty) or tuples (a, b, ...)
    if is_wrapped_in_parens(s) {
        let inner = s[1..s.len() - 1].trim();
        let tuple_parts = split_top_level(inner, ',');
        if tuple_parts.len() >= 2 {
            let mut emitted = Vec::with_capacity(tuple_parts.len());
            for p in &tuple_parts {
                emitted.push(emit_expr_with_mode(p, defs, ctors, mode)?);
            }
            return Ok(format!("({})", emitted.join(", ")));
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
                return Ok(format!(
                    "{{\n        let {} = {};\n        {}\n    }}",
                    clean_let_binding(name),
                    emit_expr_with_mode(val, defs, ctors, mode)?,
                    emit_expr_with_mode(body, defs, ctors, mode)?
                ));
            }
        }
    }

    // Logical and comparison binary operators (lowest to highest precedence)
    for op in ["||", "&&", "==", "!=", "<=", ">=", "<", ">"] {
        if let Some((lhs, rhs)) = split_top_level_str(s, op) {
            return Ok(format!(
                "({} {op} {})",
                emit_expr_with_mode(lhs, defs, ctors, mode)?,
                emit_expr_with_mode(rhs, defs, ctors, mode)?
            ));
        }
    }

    // Right-to-left top-level '+' or '-' (checked add / saturating sub for Nat; wrapping for U32/U64/I32/I64)
    if let Some((op, lhs, rhs)) = split_last_additive(s) {
        let l = emit_expr_with_mode(lhs, defs, ctors, mode)?;
        let r = emit_expr_with_mode(rhs, defs, ctors, mode)?;
        return Ok(match (mode, op) {
            (ArithMode::NatChecked, '+') => {
                format!("({l}).checked_add({r}).expect(\"rusty-bends: Nat overflow\")")
            }
            (ArithMode::NatChecked, '-') => format!("({l}).saturating_sub({r})"),
            (ArithMode::Wrapping, '+') => format!("({l}).wrapping_add({r})"),
            (ArithMode::Wrapping, '-') => format!("({l}).wrapping_sub({r})"),
            _ => unreachable!(),
        });
    }

    // Right-to-left top-level '*', '/', '%'
    if let Some((op, lhs, rhs)) = split_last_multiplicative(s) {
        let l = emit_expr_with_mode(lhs, defs, ctors, mode)?;
        let r = emit_expr_with_mode(rhs, defs, ctors, mode)?;
        return Ok(match (mode, op) {
            (ArithMode::NatChecked, '*') => {
                format!("({l}).checked_mul({r}).expect(\"rusty-bends: Nat overflow\")")
            }
            (ArithMode::Wrapping, '*') => format!("({l}).wrapping_mul({r})"),
            (ArithMode::NatChecked, '/') => {
                format!("{{ let __a = {l}; let __b = {r}; if __b == 0_u64 {{ 0_u64 }} else {{ __a / __b }} }}")
            }
            (ArithMode::Wrapping, '/') => {
                format!("{{ let __a = {l}; let __b = {r}; if __b == 0 {{ 0 }} else {{ __a.wrapping_div(__b) }} }}")
            }
            (ArithMode::NatChecked, '%') => {
                format!("{{ let __a = {l}; let __b = {r}; if __b == 0_u64 {{ __a }} else {{ __a % __b }} }}")
            }
            (ArithMode::Wrapping, '%') => {
                format!("{{ let __a = {l}; let __b = {r}; if __b == 0 {{ 0 }} else {{ __a.wrapping_rem(__b) }} }}")
            }
            _ => unreachable!(),
        });
    }

    // Unary boolean negation
    if let Some(operand) = s.strip_prefix('!') {
        return Ok(format!(
            "!({})",
            emit_expr_with_mode(operand, defs, ctors, mode)?
        ));
    }

    // Real Bend 2 curly-brace ADT constructor: Draft{}, Paid{amt}, OrderState.Paid{10n}
    if let Some(open) = s.find('{') {
        if s.ends_with('}') && is_valid_path_ident(s[..open].trim()) {
            let callee = s[..open].trim();
            let args_inner = s[open + 1..s.len() - 1].trim();
            let rust_ctor = resolve_ctor_path(callee, ctors);
            if args_inner.is_empty() {
                return Ok(rust_ctor);
            }
            let parts = split_top_level(args_inner, ',');
            let mut emitted_args = Vec::with_capacity(parts.len());
            for a in parts {
                let trimmed = a.trim();
                let val = if let Some((_, v)) = split_top_level_once(trimmed, ':') {
                    v
                } else {
                    trimmed
                };
                emitted_args.push(emit_expr_with_mode(val, defs, ctors, mode)?);
            }
            return Ok(format!("{rust_ctor}({})", emitted_args.join(", ")));
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
            if let Some(builtin) = emit_base_builtin(callee, &raw_args, defs, ctors, mode)? {
                return Ok(builtin);
            }

            if let Some(info) = ctors.get(callee) {
                let mut emitted_args = Vec::with_capacity(raw_args.len());
                for a in &raw_args {
                    emitted_args.push(emit_expr_with_mode(a, defs, ctors, mode)?);
                }
                return Ok(format!(
                    "{}::{}({})",
                    info.type_name,
                    info.variant_name,
                    emitted_args.join(", ")
                ));
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
                emitted_args.push(emit_expr_with_mode(arg, defs, ctors, mode)?);
            }
            return Ok(format!(
                "{}({})",
                callee.replace('.', "::"),
                emitted_args.join(", ")
            ));
        }
    }

    // Natural number literals (0n, 42n)
    if let Some(digits) = s.strip_suffix('n') {
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            return Ok(format!("{digits}_u64"));
        }
    }

    // Unit ADT constructor (e.g. OrderState.Draft or Draft)
    if let Some(info) = ctors.get(s) {
        if info.arity == 0 {
            return Ok(format!("{}::{}", info.type_name, info.variant_name));
        }
    }

    Ok(s.replace('.', "::"))
}

fn emit_base_builtin(
    callee: &str,
    raw_args: &[&str],
    defs: &HashMap<String, &Def>,
    ctors: &HashMap<String, CtorInfo>,
    mode: ArithMode,
) -> Result<Option<String>, String> {
    let e = |a: &str, m: ArithMode| emit_expr_with_mode(a, defs, ctors, m);
    Ok(match (callee, raw_args.len()) {
        // Unary Bool / Nat / Pair helpers
        ("Bool.not", 1) => Some(format!("(!({}))", e(raw_args[0], mode)?)),
        ("Nat.is_zero", 1) => Some(format!(
            "(({}) == 0_u64)",
            e(raw_args[0], ArithMode::NatChecked)?
        )),
        ("Nat.succ", 1) => Some(format!(
            "({}).checked_add(1_u64).expect(\"rusty-bends: Nat overflow\")",
            e(raw_args[0], ArithMode::NatChecked)?
        )),
        ("Nat.pred", 1) => Some(format!(
            "({}).saturating_sub(1_u64)",
            e(raw_args[0], ArithMode::NatChecked)?
        )),
        ("Pair.fst", 1) => Some(format!("({}).0", e(raw_args[0], mode)?)),
        ("Pair.snd", 1) => Some(format!("({}).1", e(raw_args[0], mode)?)),

        // Binary Nat arithmetic (checked add/mul, saturating sub, total div/mod matching Bend 2)
        ("Nat.add", 2) => Some(format!(
            "({}).checked_add({}).expect(\"rusty-bends: Nat overflow\")",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.sub", 2) => Some(format!(
            "({}).saturating_sub({})",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.mul", 2) => Some(format!(
            "({}).checked_mul({}).expect(\"rusty-bends: Nat overflow\")",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.div", 2) => Some(format!(
            "{{ let __a = {}; let __b = {}; if __b == 0_u64 {{ 0_u64 }} else {{ __a / __b }} }}",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.mod", 2) => Some(format!(
            "{{ let __a = {}; let __b = {}; if __b == 0_u64 {{ __a }} else {{ __a % __b }} }}",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.divmod", 2) => Some(format!(
            "{{ let __a = {}; let __b = {}; if __b == 0_u64 {{ (0_u64, __a) }} else {{ (__a / __b, __a % __b) }} }}",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.min", 2) => Some(format!(
            "({}).min({})",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.max", 2) => Some(format!(
            "({}).max({})",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),

        // Binary Nat comparisons
        ("Nat.is_le" | "Nat.le" | "Nat.lte", 2) => Some(format!(
            "(({}) <= ({}))",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.is_lt" | "Nat.lt", 2) => Some(format!(
            "(({}) < ({}))",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.is_ge" | "Nat.ge" | "Nat.gte", 2) => Some(format!(
            "(({}) >= ({}))",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.is_gt" | "Nat.gt", 2) => Some(format!(
            "(({}) > ({}))",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.is_eq" | "Nat.eq" | "Nat.equal", 2) => Some(format!(
            "(({}) == ({}))",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.is_ne" | "Nat.ne", 2) => Some(format!(
            "(({}) != ({}))",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),

        // Binary Bool logic
        ("Bool.and", 2) => Some(format!(
            "(({}) && ({}))",
            e(raw_args[0], mode)?,
            e(raw_args[1], mode)?
        )),
        ("Bool.or", 2) => Some(format!(
            "(({}) || ({}))",
            e(raw_args[0], mode)?,
            e(raw_args[1], mode)?
        )),
        ("Bool.xor", 2) => Some(format!(
            "(({}) ^ ({}))",
            e(raw_args[0], mode)?,
            e(raw_args[1], mode)?
        )),
        ("Bool.is_eq" | "Bool.eq", 2) => Some(format!(
            "(({}) == ({}))",
            e(raw_args[0], mode)?,
            e(raw_args[1], mode)?
        )),
        ("Bool.is_ne" | "Bool.ne", 2) => Some(format!(
            "(({}) != ({}))",
            e(raw_args[0], mode)?,
            e(raw_args[1], mode)?
        )),

        // Polymorphic Pair / Bool.pick helpers (with or without erased type args)
        ("Pair.fst", 3) => Some(format!("({}).0", e(raw_args[2], mode)?)),
        ("Pair.snd", 3) => Some(format!("({}).1", e(raw_args[2], mode)?)),
        ("Bool.pick", 3) => Some(format!(
            "if {} {{ {} }} else {{ {} }}",
            e(raw_args[0], mode)?,
            e(raw_args[1], mode)?,
            e(raw_args[2], mode)?
        )),
        ("Bool.pick", 4) => Some(format!(
            "if {} {{ {} }} else {{ {} }}",
            e(raw_args[1], mode)?,
            e(raw_args[2], mode)?,
            e(raw_args[3], mode)?
        )),
        _ => None,
    })
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

pub(crate) fn split_top_level_str<'a>(s: &'a str, op: &str) -> Option<(&'a str, &'a str)> {
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

pub(crate) fn is_wrapped_in_parens(s: &str) -> bool {
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

pub(crate) fn unwrap_outer_parens(s: &str) -> &str {
    let mut cur = s.trim();
    while is_wrapped_in_parens(cur) {
        cur = cur[1..cur.len() - 1].trim();
    }
    cur
}

pub(crate) fn split_top_level(s: &str, delim: char) -> Vec<&str> {
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

pub(crate) fn split_top_level_once(s: &str, delim: char) -> Option<(&str, &str)> {
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
    fn emits_checked_nat_math_and_erases_laws() {
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
        let (runtime_part, tests_part) = summary
            .rust_source
            .split_once("#[cfg(test)]")
            .expect("expected generated #[cfg(test)] law module");
        let code_only: String = runtime_part
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(summary.defs_emitted, 2);
        assert!(code_only.contains("pub fn deposit(bal: u64, amt: u64) -> u64"));
        assert!(code_only.contains("(bal).checked_add(amt).expect(\"rusty-bends: Nat overflow\")"));
        assert!(code_only.contains("(gross).saturating_sub(fee)"));
        assert!(!code_only.contains("law "));
        assert!(!code_only.contains("proof "));
        assert!(!code_only.contains("refl"));
        assert!(tests_part.contains("fn law_deposit_zero()"));
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
        assert!(summary
            .rust_source
            .contains("pub fn dup(n: u64) -> (u64, u64)"));
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
        let (runtime_part, tests_part) = summary
            .rust_source
            .split_once("#[cfg(test)]")
            .expect("expected generated #[cfg(test)] law module");
        assert_eq!(summary.types_emitted, 1);
        assert_eq!(summary.defs_emitted, 1);
        assert!(runtime_part.contains("pub enum OrderState"));
        assert!(runtime_part.contains("Paid(u64),"));
        assert!(runtime_part.contains("OrderState::Draft => OrderState::Cancelled,"));
        assert!(runtime_part.contains("OrderState::Paid(amt) => OrderState::Cancelled,"));
        assert!(!runtime_part.contains("cancel_idempotent"));
        assert!(!runtime_part.contains("refl"));
        assert!(tests_part.contains("fn law_cancel_idempotent()"));
    }

    #[test]
    fn emits_bool_if_else_and_logical_operators() {
        let src = r#"
def can_write(+is_admin: Bool, +is_revoked: Bool) -> Bool:
  if is_revoked: false else: is_admin
"#;
        let summary = emit_verified_rust(src, 0).expect("emit succeeded");
        assert!(summary
            .rust_source
            .contains("pub fn can_write(is_admin: bool, is_revoked: bool) -> bool"));
        assert!(summary
            .rust_source
            .contains("if is_revoked { false } else { is_admin }"));
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
        let (runtime_part, tests_part) = summary
            .rust_source
            .split_once("#[cfg(test)]")
            .expect("expected generated #[cfg(test)] law module");
        assert_eq!(summary.types_emitted, 1);
        assert_eq!(summary.defs_emitted, 2);
        assert!(runtime_part.contains("pub enum OrderState"));
        assert!(runtime_part.contains("Draft,"));
        assert!(runtime_part.contains("Paid(u64),"));
        assert!(
            runtime_part.contains("(bal).checked_add(amt).expect(\"rusty-bends: Nat overflow\")")
        );
        assert!(runtime_part.contains("OrderState::Draft => OrderState::Cancelled,"));
        assert!(runtime_part.contains("OrderState::Paid(amt) => OrderState::Cancelled,"));
        assert!(runtime_part.contains("OrderState::Shipped(amt) => OrderState::Shipped(amt),"));
        assert!(!runtime_part.contains("deposit_zero"));
        assert!(!runtime_part.contains("cancel_idempotent"));
        assert!(!runtime_part.contains("{==}"));
        assert!(tests_part.contains("fn law_deposit_zero()"));
        assert!(tests_part.contains("fn law_cancel_idempotent()"));
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
        assert!(summary
            .rust_source
            .contains("if __b == 0_u64 { 0_u64 } else { __a / __b }"));
        assert!(summary
            .rust_source
            .contains("if __b == 0_u64 { __a } else { __a % __b }"));
        assert!(summary.rust_source.contains("if (({ let __a = tokens;"));
        assert!(summary
            .rust_source
            .contains("(((a) < (b))) && (((b) >= (a)))"));
        assert!(!summary.rust_source.contains("Nat::"));
        assert!(!summary.rust_source.contains("Bool::"));
    }

    #[test]
    fn emits_wrapping_for_u32_and_checked_for_nat() {
        let src = r#"
def wrap_u32(a: U32, b: U32) -> U32:
  ((a + b : U32) * (a - b : U32) : U32)

def checked_nat(a: Nat, b: Nat) -> Nat:
  (a + b : Nat)

def sub_nat(a: Nat, b: Nat) -> Nat:
  (a - b : Nat)
"#;
        let summary = emit_verified_rust(src, 0).expect("arith mode emit succeeded");
        assert!(summary
            .rust_source
            .contains("pub fn wrap_u32(a: u32, b: u32) -> u32"));
        assert!(summary
            .rust_source
            .contains("((a).wrapping_add(b)).wrapping_mul((a).wrapping_sub(b))"));
        assert!(summary
            .rust_source
            .contains("pub fn checked_nat(a: u64, b: u64) -> u64"));
        assert!(summary
            .rust_source
            .contains("(a).checked_add(b).expect(\"rusty-bends: Nat overflow\")"));
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
        assert!(summary
            .rust_source
            .contains("true => PoolState::Ready((free).saturating_sub(req)),"));
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
        assert!(summary
            .rust_source
            .contains("pub fn split_tiles(n: u64, tile: u64) -> (u64, u64)"));
        assert!(summary
            .rust_source
            .contains("if __b == 0_u64 { (0_u64, __a) } else { (__a / __b, __a % __b) }"));
        assert!(summary
            .rust_source
            .contains("pub fn first_of_pair(p: (u64, u64)) -> u64"));
        assert!(summary.rust_source.contains("(p).0"));
    }

    #[test]
    fn parses_multi_line_def_headers_and_erases_multi_line_lemmas() {
        // Accepted by 'bend --check-only' on Bend 2.0.40.
        let src = r#"
import Base

def pfx_reuse_valid(
  +snap_pos: Nat,  # comment inside the header
  +lcp: Nat,
  prompt_len: Nat,
  +tile: Nat
) -> Bool:
  (snap_pos <= lcp : Nat) && (lcp <= prompt_len : Nat)

def add_zero_eq(
  n: Nat
) -> {Nat.add(n, 0n) == n : Nat}:
  match n:
    case 0n:
      {==}
    case 1n+p:
      %add_zero_eq(p) : {1n+Nat.add(p, 0n) == 1n+_ : Nat}
      {==}

def one_liner(n: Nat) -> Nat: Nat.add(n, 1n)
"#;
        let summary = emit_verified_rust(src, 0).expect("multi-line headers emit");
        assert_eq!(summary.defs_emitted, 2);
        assert!(summary.rust_source.contains(
            "pub fn pfx_reuse_valid(snap_pos: u64, lcp: u64, prompt_len: u64, tile: u64) -> bool"
        ));
        assert!(summary
            .rust_source
            .contains("pub fn one_liner(n: u64) -> u64"));
        assert!(!summary.rust_source.contains("add_zero_eq"));
        assert!(summary.rust_source.contains(
            "#[allow(unused_variables, unused_parens, clippy::let_and_return, clippy::double_parens, clippy::unnecessary_cast)]"
        ));
    }

    #[test]
    fn lowers_nested_successor_patterns_and_rejects_unsupported_patterns() {
        let src = r#"
import Base

type Box is Data:
  Wrap{x: Nat}

def minus_two(n: Nat) -> Nat:
  match n:
    case 0n:
      0n
    case 1n:
      0n
    case 1n+1n+q:
      q

def px_net_span_match(a: Nat, b: Nat, span: Nat) -> Bool:
  match span:
    case 0n:
      True{}
    case 1n:
      Nat.is_eq(a, b)
    case 1n+1n+q:
      Nat.is_le(a, Nat.add(b, 1n+1n+q))

def nested_const_and_three(n: Nat) -> Nat:
  match n:
    case 0n:
      0n
    case 1n+1n+0n:
      10n
    case 2n+1n+q:
      q

def nested_data_binder(+m: Nat) -> Nat:
  match m:
    case 0n: 0n
    case 1n: 0n
    case 1n+1n++q: Nat.add(q, q)

def nested_in_box(b: Box) -> Nat:
  match b:
    case Wrap{0n}: 0n
    case Wrap{1n}: 0n
    case Wrap{1n+1n+1n+_}: 42n

def nested_multi(x: Nat, y: Nat) -> Nat:
  match x y:
    case 0n _: 0n
    case 1n _: 0n
    case 1n+1n+q 1n+p: Nat.add(q, p)
"#;
        let summary = emit_verified_rust(src, 0).expect("nested successor patterns should emit");
        assert!(summary
            .rust_source
            .contains("__rb_n0 @ 2_u64..=u64::MAX => { let q = __rb_n0 - 2_u64; q }"));
        assert!(summary.rust_source.contains("2_u64 => 10_u64,"));
        assert!(summary
            .rust_source
            .contains("__rb_n0 @ 3_u64..=u64::MAX => { let q = __rb_n0 - 3_u64; q }"));
        assert!(summary
            .rust_source
            .contains("Box::Wrap(3_u64..=u64::MAX) => 42_u64,"));
        assert!(summary.rust_source.contains("(__rb_n0 @ 2_u64..=u64::MAX, __rb_n1 @ 1_u64..=u64::MAX) => { let q = __rb_n0 - 2_u64; let p = __rb_n1 - 1_u64;"));
        assert!(!summary.rust_source.contains("1n+1n+q"));

        // Unsupported patterns must fail cleanly with E_EMIT_UNSUPPORTED_PATTERN instead of emitting unparseable Rust.
        let bad_add = "def bad(n: Nat) -> Nat:\n  match n:\n    case a+b: a\n";
        let err = emit_verified_rust(bad_add, 0).expect_err("a+b pattern must be rejected");
        assert!(err.contains("E_EMIT_UNSUPPORTED_PATTERN"), "got: {err}");

        let bad_tail = "def bad2(n: Nat) -> Nat:\n  match n:\n    case 1n+Foo{}: 0n\n";
        let err2 = emit_verified_rust(bad_tail, 0).expect_err("1n+Foo{} pattern must be rejected");
        assert!(err2.contains("E_EMIT_UNSUPPORTED_PATTERN"), "got: {err2}");
    }

    #[test]
    fn differential_nested_successor_matches_bend_and_compiles_with_rustc() {
        let bend_src = r#"import Base

def minus_two(n: Nat) -> Nat:
  match n:
    case 0n:
      0n
    case 1n:
      0n
    case 1n+1n+q:
      q

def px_net_span_match(a: Nat, b: Nat, span: Nat) -> Bool:
  match span:
    case 0n:
      True{}
    case 1n:
      Nat.is_eq(a, b)
    case 1n+1n+q:
      Nat.is_le(a, Nat.add(b, 1n+1n+q))
"#;
        let dir = std::env::temp_dir().join(format!("rb_nested_succ_diff_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bend_path = dir.join("nested.bend");
        std::fs::write(&bend_path, bend_src).unwrap();

        let bend_bin = crate::resolve_bend_bin(
            std::env::var("BEND_BIN").ok(),
            std::env::var_os("PATH"),
            std::env::var_os("HOME").map(std::path::PathBuf::from),
        );
        if let Ok(out) = std::process::Command::new(&bend_bin)
            .arg(&bend_path)
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

        let summary = emit_verified_rust(bend_src, 0).expect("emit nested succ");
        let rs_path = dir.join("test.rs");
        let bin_path = dir.join("test_bin");
        let harness = format!(
            "{}\nfn main() {{\n    assert_eq!(minus_two(0), 0);\n    assert_eq!(minus_two(1), 0);\n    assert_eq!(minus_two(2), 0);\n    assert_eq!(minus_two(5), 3);\n    assert!(px_net_span_match(10, 20, 0));\n    assert!(px_net_span_match(7, 7, 1));\n    assert!(!px_net_span_match(7, 8, 1));\n    assert!(px_net_span_match(5, 3, 2));\n    assert!(!px_net_span_match(10, 3, 2));\n}}\n",
            summary.rust_source
        );
        std::fs::write(&rs_path, harness).unwrap();
        let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = std::process::Command::new(&rustc)
            .args(["--edition", "2021", "-o"])
            .arg(&bin_path)
            .arg(&rs_path)
            .output()
            .expect("rustc must run");
        assert!(
            compile.status.success(),
            "rustc failed: {}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run = std::process::Command::new(&bin_path)
            .output()
            .expect("run compiled binary");
        assert!(run.status.success(), "runtime assertions failed");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
