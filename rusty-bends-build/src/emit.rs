//! Erased-core BendTT v1 -> Pure Rust code emitter.
//!
//! Runs *only after* the real 'bend' proof checker approves every type, definition, and law.
//! Strictly enforces the BendTT dead/live split:
//! - 'type' ADTs emit '#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum ...' (or Clone-only with Box<T> indirection when recursive).
//! - 'match' and 'if/else' emit idiomatic Rust pattern matching and conditionals.
//! - 'Dead' (q=0) parameters ('-T: Type') and annotations ('(x : T)') are erased.
//! - 'law' and 'proof' blocks (including match/rewrite proofs) are completely stripped.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};

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
    /// `# rusty-bends: total` above the `def`: emit as `Option<T>` (`None` on `Nat`
    /// overflow) instead of panicking (Issue #13).
    pub total: bool,
}

/// One checked-growth panic site in emitted Rust: `function` panics with
/// `rusty-bends: Nat overflow` when `op` overflows `u64`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanicSite {
    pub function: String,
    /// `Nat.add`, `Nat.mul`, `Nat.succ`, or `call <f>` (a call to a total function).
    pub op: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitSummary {
    pub rust_source: String,
    pub types_emitted: usize,
    pub defs_emitted: usize,
    pub dead_params_erased: usize,
    /// Every checked-growth op that can panic, per public emitted function, in emission order.
    pub panic_sites: Vec<PanicSite>,
}

#[derive(Debug, Clone)]
pub(crate) struct CtorInfo {
    pub(crate) type_name: String,
    pub(crate) variant_name: String,
    pub(crate) arity: usize,
    pub(crate) field_types: Vec<String>,
    pub(crate) boxed_fields: Vec<bool>,
}

#[derive(Debug, Clone)]
pub(crate) struct TypeEnv {
    pub(crate) ctor_map: HashMap<String, CtorInfo>,
    pub(crate) non_copy_types: HashSet<String>,
    pub(crate) uses_builtin_list: bool,
}

impl TypeEnv {
    pub(crate) fn build(types: &[TypeDef], defs: &[Def], extra_sources: &[&str]) -> Self {
        let type_names: HashSet<&str> = types.iter().map(|t| t.name.as_str()).collect();
        let user_ctor_names: HashSet<&str> = types
            .iter()
            .flat_map(|t| t.variants.iter().map(|v| v.name.as_str()))
            .collect();

        // Build ADT dependency graph: A -> B if any variant of A mentions user ADT B.
        let mut deps: HashMap<&str, HashSet<String>> = HashMap::new();
        for td in types {
            let mut refs = HashSet::new();
            for v in &td.variants {
                for ft in &v.field_types {
                    collect_referenced_adts(ft, &type_names, &mut refs);
                }
            }
            deps.insert(td.name.as_str(), refs);
        }

        let mut uses_builtin_list = false;
        if !type_names.contains("List") {
            'scan_list: for td in types {
                for v in &td.variants {
                    for ft in &v.field_types {
                        if mentions_builtin_list(ft, &user_ctor_names) {
                            uses_builtin_list = true;
                            break 'scan_list;
                        }
                    }
                }
            }
            if !uses_builtin_list {
                'scan_defs: for d in defs {
                    if mentions_builtin_list(&d.ret, &user_ctor_names)
                        || mentions_builtin_list(&d.body, &user_ctor_names)
                        || d.params
                            .iter()
                            .any(|p| mentions_builtin_list(&p.ty, &user_ctor_names))
                    {
                        uses_builtin_list = true;
                        break 'scan_defs;
                    }
                }
            }
            if !uses_builtin_list {
                for src in extra_sources {
                    if mentions_builtin_list(src, &user_ctor_names) {
                        uses_builtin_list = true;
                        break;
                    }
                }
            }
        }

        let mut ctor_map: HashMap<String, CtorInfo> = HashMap::new();
        let mut non_copy_types: HashSet<String> = HashSet::new();
        if uses_builtin_list {
            non_copy_types.insert("List".to_string());
        }

        for td in types {
            let mut has_boxed = false;
            for v in &td.variants {
                let mut boxed_fields = Vec::with_capacity(v.field_types.len());
                for ft in &v.field_types {
                    let mut field_refs = HashSet::new();
                    collect_referenced_adts(ft, &type_names, &mut field_refs);
                    let needs_box = field_refs
                        .iter()
                        .any(|b| b == &td.name || can_reach(b, &td.name, &deps));
                    if needs_box {
                        has_boxed = true;
                    }
                    boxed_fields.push(needs_box);
                }
                let info = CtorInfo {
                    type_name: td.name.clone(),
                    variant_name: v.name.clone(),
                    arity: v.field_types.len(),
                    field_types: v.field_types.clone(),
                    boxed_fields,
                };
                ctor_map.insert(format!("{}.{}", td.name, v.name), info.clone());
                ctor_map.entry(v.name.clone()).or_insert(info);
            }
            if has_boxed {
                non_copy_types.insert(td.name.clone());
            }
        }

        // Fixed-point propagation of non-Copy across non-recursive wrapper ADTs.
        loop {
            let mut changed = false;
            for td in types {
                if non_copy_types.contains(&td.name) {
                    continue;
                }
                let refs_non_copy = td.variants.iter().any(|v| {
                    v.field_types
                        .iter()
                        .any(|ft| type_contains_non_copy(ft, &non_copy_types))
                });
                if refs_non_copy {
                    non_copy_types.insert(td.name.clone());
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }

        if uses_builtin_list && !type_names.contains("List") {
            let nil_info = CtorInfo {
                type_name: "List".to_string(),
                variant_name: "Nil".to_string(),
                arity: 0,
                field_types: Vec::new(),
                boxed_fields: Vec::new(),
            };
            let con_info = CtorInfo {
                type_name: "List".to_string(),
                variant_name: "Con".to_string(),
                arity: 2,
                field_types: vec!["_".to_string(), "List".to_string()],
                boxed_fields: vec![false, true],
            };
            ctor_map.insert("List.Nil".to_string(), nil_info.clone());
            ctor_map.entry("Nil".to_string()).or_insert(nil_info);
            ctor_map.insert("List.Con".to_string(), con_info.clone());
            ctor_map.entry("Con".to_string()).or_insert(con_info);
        }

        Self {
            ctor_map,
            non_copy_types,
            uses_builtin_list,
        }
    }
}

fn can_reach(start: &str, target: &str, deps: &HashMap<&str, HashSet<String>>) -> bool {
    let mut visited = HashSet::new();
    let mut queue = VecDeque::new();
    visited.insert(start.to_string());
    queue.push_back(start.to_string());
    while let Some(cur) = queue.pop_front() {
        if let Some(nexts) = deps.get(cur.as_str()) {
            for next in nexts {
                if next == target {
                    return true;
                }
                if visited.insert(next.clone()) {
                    queue.push_back(next.clone());
                }
            }
        }
    }
    false
}

pub(crate) fn parse_list_elem_type(ty: &str) -> Option<&str> {
    let t = ty.trim();
    let rest = t.strip_prefix("List")?.trim_start();
    if !(rest.starts_with('<') && rest.ends_with('>')) || !is_wrapped_in_angles(rest) {
        return None;
    }
    let inner = rest[1..rest.len() - 1].trim();
    let parts = split_type_args(inner, ',');
    parts
        .last()
        .copied()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn collect_referenced_adts(ty: &str, type_names: &HashSet<&str>, out: &mut HashSet<String>) {
    let t = ty.trim();
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
        if parts.len() > 1 {
            for p in parts {
                collect_referenced_adts(p, type_names, out);
            }
            return;
        }
        collect_referenced_adts(inner, type_names, out);
        return;
    }
    let amp = split_type_args(t, '&');
    if amp.len() > 1 {
        for p in amp {
            collect_referenced_adts(p, type_names, out);
        }
        return;
    }
    if let Some(elem) = parse_list_elem_type(t) {
        collect_referenced_adts(elem, type_names, out);
        return;
    }
    if type_names.contains(t) {
        out.insert(t.to_string());
    }
}

pub(crate) fn type_contains_non_copy(ty: &str, non_copy_types: &HashSet<String>) -> bool {
    let t = ty.trim();
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
        if parts.len() > 1 {
            return parts
                .iter()
                .any(|p| type_contains_non_copy(p, non_copy_types));
        }
        return type_contains_non_copy(inner, non_copy_types);
    }
    let amp = split_type_args(t, '&');
    if amp.len() > 1 {
        return amp
            .iter()
            .any(|p| type_contains_non_copy(p, non_copy_types));
    }
    if parse_list_elem_type(t).is_some() {
        return true;
    }
    non_copy_types.contains(t)
}

fn mentions_builtin_list(s: &str, user_ctors: &HashSet<&str>) -> bool {
    if s.contains("List<") || s.contains("List.Nil") || s.contains("List.Con") || s.contains('[') {
        return true;
    }
    for tok in crate::lock::tokenize_bend(s) {
        if tok == "List"
            || (!user_ctors.contains("Nil") && tok == "Nil")
            || (!user_ctors.contains("Con") && tok == "Con")
        {
            return true;
        }
    }
    false
}

/// Parses Bend v1 'type' and 'def' items from verified source, erases all q=0 parts and laws,
/// and emits zero-dependency Rust (plus generated `#[cfg(test)]` per-law checks) ready for
/// `include!(concat!(env!("OUT_DIR"), "/verified.rs"))`.
pub fn emit_verified_rust(source: &str, laws_verified: usize) -> Result<EmitSummary, String> {
    let (types, defs) = parse_book_items(source)?;
    let laws = crate::law_test::parse_laws(source);
    let extra_sources = collect_law_source_slices(&laws);
    let type_env = TypeEnv::build(&types, &defs, &extra_sources);
    let mut summary = emit_items_to_rust(&types, &defs, &type_env, laws_verified, None, true)?;

    if !laws.is_empty() {
        let unchecked: HashSet<String> = crate::lock::extract_law_doc_comments(source)
            .into_iter()
            .filter(|(_, docs)| docs.unchecked.is_some())
            .map(|(name, _)| name)
            .collect();
        let test_mod =
            crate::law_test::emit_law_tests_module(&laws, &types, &defs, &type_env, &unchecked);
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
    let type_env = TypeEnv::build(&types, &defs, &[]);
    emit_items_to_rust(&types, &defs, &type_env, laws_verified, None, true)
}

pub(crate) fn collect_law_source_slices(laws: &[crate::law_test::ParsedLaw]) -> Vec<&str> {
    let mut slices = Vec::new();
    for l in laws {
        if !l.lhs.is_empty() {
            slices.push(l.lhs.as_str());
        }
        if !l.rhs.is_empty() {
            slices.push(l.rhs.as_str());
        }
        if !l.eq_ty.is_empty() {
            slices.push(l.eq_ty.as_str());
        }
        for v in &l.vars {
            slices.push(v.ty.as_str());
        }
        for h in &l.hypotheses {
            slices.push(h.lhs.as_str());
            slices.push(h.rhs.as_str());
            slices.push(h.ty.as_str());
        }
    }
    slices
}

/// Adds a `call <callee>` panic site to every non-total def that calls a non-total def
/// that can panic (directly or through its own callees), so `RUSTY_BENDS_LIST_PANICS`
/// also names the public entry points whose checked growth happens further down.
fn add_transitive_panic_sites(
    defs: &[Def],
    def_map: &HashMap<String, &Def>,
    panic_sites: &mut Vec<PanicSite>,
) {
    let callees: Vec<(String, Vec<String>)> = defs
        .iter()
        .filter(|d| !d.total)
        .map(|d| {
            let toks = crate::lock::tokenize_bend(&d.body);
            let mut called = Vec::new();
            for (i, tok) in toks.iter().enumerate() {
                let is_call = toks.get(i + 1).is_some_and(|t| t == "(");
                let is_callee = def_map
                    .get(tok)
                    .is_some_and(|c| !c.total && c.name != d.name);
                if is_call && is_callee && !called.contains(tok) {
                    called.push(tok.clone());
                }
            }
            (d.name.clone(), called)
        })
        .collect();
    let mut panicking: HashSet<String> = panic_sites.iter().map(|p| p.function.clone()).collect();
    let mut recorded: HashSet<(String, String)> = HashSet::new();
    loop {
        let mut changed = false;
        for (caller, called) in &callees {
            for callee in called {
                if panicking.contains(callee) && recorded.insert((caller.clone(), callee.clone())) {
                    panic_sites.push(PanicSite {
                        function: caller.clone(),
                        op: format!("call {callee}"),
                    });
                    changed |= panicking.insert(caller.clone());
                }
            }
        }
        if !changed {
            break;
        }
    }
}

pub(crate) fn emit_items_to_rust(
    types: &[TypeDef],
    defs: &[Def],
    type_env: &TypeEnv,
    laws_verified: usize,
    step_limit: Option<usize>,
    emit_types: bool,
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

    if emit_types && type_env.uses_builtin_list {
        blocks.push(
            "#[derive(Debug, Clone, PartialEq, Eq)]\npub enum List<T> {\n    Nil,\n    Con(T, Box<List<T>>),\n}"
                .to_string(),
        );
    }

    // Types holding an F32 (directly or through another type) cannot derive Eq.
    let mut float_types: HashSet<&str> = HashSet::new();
    loop {
        let before = float_types.len();
        for td in types {
            let holds_float = td.variants.iter().any(|v| {
                v.field_types.iter().any(|ft| {
                    crate::lock::tokenize_bend(ft)
                        .iter()
                        .any(|t| t == "F32" || float_types.contains(t.as_str()))
                })
            });
            if holds_float {
                float_types.insert(td.name.as_str());
            }
        }
        if float_types.len() == before {
            break;
        }
    }

    if emit_types {
        for td in types {
            let mut variants_rs = Vec::new();
            for v in &td.variants {
                if v.field_types.is_empty() {
                    variants_rs.push(format!("    {},", rust_ident(&v.name)));
                } else {
                    let info = type_env.ctor_map.get(&format!("{}.{}", td.name, v.name));
                    let mapped: Vec<String> = v
                        .field_types
                        .iter()
                        .enumerate()
                        .map(|(idx, t)| {
                            let rty = bend_type_to_rust(t, &empty_set);
                            let is_boxed = info
                                .and_then(|c| c.boxed_fields.get(idx).copied())
                                .unwrap_or(false);
                            if is_boxed {
                                format!("Box<{rty}>")
                            } else {
                                rty
                            }
                        })
                        .collect();
                    variants_rs.push(format!(
                        "    {}({}),",
                        rust_ident(&v.name),
                        mapped.join(", ")
                    ));
                }
            }
            let eq = if float_types.contains(td.name.as_str()) {
                ""
            } else {
                ", Eq"
            };
            let derive_line = if type_env.non_copy_types.contains(&td.name) {
                format!("#[derive(Debug, Clone, PartialEq{eq})]")
            } else {
                format!("#[derive(Debug, Clone, Copy, PartialEq{eq})]")
            };
            // Bend allows lowercase type and constructor names; keep them as written.
            let is_camel =
                |n: &str| n.starts_with(|c: char| c.is_ascii_uppercase()) && !n.contains('_');
            let lint_allow = if is_camel(&td.name) && td.variants.iter().all(|v| is_camel(&v.name))
            {
                ""
            } else {
                "#[allow(non_camel_case_types)]\n"
            };
            blocks.push(format!(
                "{derive_line}\n{lint_allow}pub enum {} {{\n{}\n}}",
                rust_ident(&td.name),
                variants_rs.join("\n")
            ));
        }
    }

    let total_cone = total_def_cone(defs, &def_map);
    let mut panic_sites = Vec::new();

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

        let has_generics = !type_params.is_empty();
        let generics = if !has_generics {
            String::new()
        } else {
            format!(
                "<{}>",
                type_params
                    .iter()
                    .map(|t| rust_ident(t))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };

        let rust_params = live_params
            .iter()
            .map(|p| {
                format!(
                    "{}: {}",
                    rust_ident(&p.name),
                    bend_type_to_rust(&p.ty, &type_param_set)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");

        let mut clone_vars = HashSet::new();
        if !has_generics {
            for p in &live_params {
                if type_contains_non_copy(&p.ty, &type_env.non_copy_types)
                    && count_ident_uses(&def.body, &p.name) > 1
                {
                    clone_vars.insert(p.name.clone());
                }
            }
        }

        let default_mode = arith_mode_for_type(&def.ret, ArithMode::NatChecked);
        let ret_ty = infer_return_type(&def.body, &def.ret, &type_param_set);
        let guard_prefix = if step_limit.is_some() {
            "__rb_tick();\n    "
        } else {
            ""
        };
        const FN_ALLOWS: &str = "unused_variables, unused_parens, unreachable_patterns, irrefutable_let_patterns, clippy::let_and_return, clippy::double_parens, clippy::unnecessary_cast, clippy::clone_on_copy, clippy::match_like_matches_macro";

        // Variants to emit: the public function (total when marked), plus a private
        // `Option` shadow when an unmarked def is called from a total function.
        let mut variants = vec![(rust_ident(&def.name), def.total, true)];
        if !def.total && total_cone.contains(&def.name) {
            variants.push((rust_ident(&total_fn_name(def)), true, false));
        }
        let param_locals: HashSet<String> = def.params.iter().map(|p| p.name.clone()).collect();
        for (fn_name, total, public) in variants {
            let ops = RefCell::new(Vec::new());
            let ctx = EmitCtx {
                locals: &param_locals,
                defs: &def_map,
                type_env,
                clone_vars: &clone_vars,
                has_generics,
                total,
                total_cone: &total_cone,
                panic_ops: &ops,
            };
            let body_expr = emit_expr_with_ctx(&def.body, &ctx, default_mode)?;
            if public {
                for op in ops.into_inner() {
                    panic_sites.push(PanicSite {
                        function: def.name.clone(),
                        op,
                    });
                }
            }
            if total {
                let (vis, extra_allow) = if public {
                    ("pub ", "")
                } else {
                    ("", "dead_code, ")
                };
                blocks.push(format!(
                    "#[inline]\n#[allow({extra_allow}{FN_ALLOWS}, clippy::needless_question_mark, clippy::question_mark, clippy::unnecessary_lazy_evaluations)]\n{vis}fn {fn_name}{generics}({rust_params}) -> Option<{ret_ty}> {{\n    {guard_prefix}Some({body_expr})\n}}"
                ));
            } else {
                blocks.push(format!(
                    "#[inline]\n#[allow({FN_ALLOWS})]\npub fn {fn_name}{generics}({rust_params}) -> {ret_ty} {{\n    {guard_prefix}{body_expr}\n}}"
                ));
            }
        }
    }

    add_transitive_panic_sites(defs, &def_map, &mut panic_sites);

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
        panic_sites,
    })
}

fn is_valid_alias_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn parse_import_alias_line(raw_line: &str) -> Option<String> {
    if raw_line.starts_with(|c: char| c.is_whitespace() && c != '\r') {
        return None;
    }
    let clean = strip_comment(raw_line).trim();
    let parts: Vec<&str> = clean.split_whitespace().collect();
    if parts.len() == 4
        && parts[0] == "import"
        && parts[1].ends_with(".bend")
        && parts[2] == "as"
        && is_valid_alias_ident(parts[3])
        && parts[3] != "Base"
    {
        Some(parts[3].to_string())
    } else {
        None
    }
}

/// Parses unindented `import <path>.bend as <Alias>` directives from a Bend 2 source file.
pub fn parse_import_aliases(source: &str) -> HashSet<String> {
    let mut aliases = HashSet::new();
    for raw in source.lines() {
        if let Some(alias) = parse_import_alias_line(raw) {
            aliases.insert(alias);
        }
    }
    aliases
}

fn split_code_and_comment(line: &str) -> (&str, &str) {
    let bytes = line.as_bytes();
    let mut i = 0usize;
    let mut in_string = false;
    while i < bytes.len() {
        if in_string {
            if bytes[i] == b'\\' && i + 1 < bytes.len() {
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                in_string = false;
            }
            let ch = line[i..].chars().next().unwrap();
            i += ch.len_utf8();
            continue;
        }
        if bytes[i] == b'"' {
            in_string = true;
            i += 1;
            continue;
        }
        if bytes[i] == b'#' || (bytes[i] == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-') {
            return (&line[..i], &line[i..]);
        }
        let ch = line[i..].chars().next().unwrap();
        i += ch.len_utf8();
    }
    (line, "")
}

fn strip_aliases_in_code(code: &str, aliases: &HashSet<String>) -> String {
    let bytes = code.as_bytes();
    let mut out = String::with_capacity(code.len());
    let mut i = 0usize;
    let mut in_string = false;

    while i < bytes.len() {
        if in_string {
            if bytes[i] == b'\\' && i + 1 < bytes.len() {
                out.push(bytes[i] as char);
                let next_ch = code[i + 1..].chars().next().unwrap();
                out.push(next_ch);
                i += 1 + next_ch.len_utf8();
                continue;
            }
            if bytes[i] == b'"' {
                in_string = false;
            }
            let ch = code[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        if bytes[i] == b'"' {
            in_string = true;
            out.push('"');
            i += 1;
            continue;
        }
        let prev_is_ident_or_dot = i > 0
            && (bytes[i - 1].is_ascii_alphanumeric()
                || bytes[i - 1] == b'_'
                || bytes[i - 1] == b'.');
        if !prev_is_ident_or_dot && (bytes[i].is_ascii_alphabetic() || bytes[i] == b'_') {
            let seg_start = i;
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let seg = &code[seg_start..i];
            if aliases.contains(seg)
                && i + 1 < bytes.len()
                && bytes[i] == b'.'
                && (bytes[i + 1].is_ascii_alphabetic() || bytes[i + 1] == b'_')
            {
                i += 1;
                let next_start = i;
                i += 1;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                    i += 1;
                }
                out.push_str(&code[next_start..i]);
                continue;
            }
            out.push_str(seg);
            continue;
        }
        let ch = code[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Resolves sibling `.bend` import aliases (`import foo.bend as X`) within a single file's
/// source by dropping the import directive line and stripping `X.` qualifiers from code tokens,
/// leaving comments and string literals untouched. Idempotent by construction.
pub fn resolve_import_aliases(source: &str) -> String {
    let aliases = parse_import_aliases(source);
    if aliases.is_empty() {
        return source.to_string();
    }
    let mut out_lines = Vec::new();
    for raw in source.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let cr = if raw.ends_with('\r') { "\r" } else { "" };
        if parse_import_alias_line(line).is_some() {
            out_lines.push(cr.to_string());
            continue;
        }
        let (code, comment) = split_code_and_comment(line);
        let rewritten = strip_aliases_in_code(code, &aliases);
        out_lines.push(format!("{rewritten}{comment}{cr}"));
    }
    out_lines.join("\n")
}

pub fn parse_book_items(source: &str) -> Result<(Vec<TypeDef>, Vec<Def>), String> {
    let resolved = resolve_import_aliases(source);
    let source = resolved.as_str();
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
            let total = has_total_marker(&lines, i);
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

            // Real Bend 2 proof and type-level definitions (matching law names, equality
            // return types '{...}', Type/Data/Empty/Kind return types, equality/Empty proof
            // arguments, or body '{==}' without '->') are q=0 and erased before codegen.
            if is_erased_proof_or_type_def(header_part, &body, &law_names) {
                continue;
            }

            if body.trim().is_empty() {
                return Err(format!(
                    "[E_EMIT_EMPTY_BODY] Empty body in 'def {header_part}'"
                ));
            }
            let mut def = parse_def_header(header_part, body)?;
            def.total = total;
            defs.push(def);
            continue;
        }

        i += 1;
    }

    let mut ctor_owner: HashMap<&str, &str> = HashMap::new();
    for td in &types {
        for v in &td.variants {
            if !is_valid_rust_ident_or_wildcard(&v.name) || v.name == "_" {
                continue;
            }
            if let Some(other) = ctor_owner.insert(v.name.as_str(), td.name.as_str()) {
                return Err(format!(
                    "[E_NAME_COLLISION] Constructor '{}' is declared by both '{other}' and '{}'.\nHint: RustyBends emits all of verified/ into one Rust module, where bare constructor names must be unique; rename one of them.",
                    v.name, td.name
                ));
            }
        }
    }

    Ok((types, defs))
}

/// Every def reachable from a `# rusty-bends: total` def (including the total defs themselves).
/// Each needs an `Option`-returning variant so overflow anywhere below a total function
/// propagates as `None` instead of panicking.
pub(crate) fn total_def_cone(defs: &[Def], def_map: &HashMap<String, &Def>) -> HashSet<String> {
    let mut cone = HashSet::new();
    let mut queue: VecDeque<String> = defs
        .iter()
        .filter(|d| d.total)
        .map(|d| d.name.clone())
        .collect();
    while let Some(name) = queue.pop_front() {
        if !cone.insert(name.clone()) {
            continue;
        }
        if let Some(def) = def_map.get(&name) {
            for tok in crate::lock::tokenize_bend(&def.body) {
                if def_map.contains_key(&tok) && !cone.contains(&tok) {
                    queue.push_back(tok);
                }
            }
        }
    }
    cone
}

/// The comment line that opts a `def` into non-panicking `Option<T>` emission.
pub const TOTAL_MARKER: &str = "rusty-bends: total";

/// True when the contiguous comment block directly above `lines[def_idx]` contains
/// `# rusty-bends: total` (blank or non-comment lines end the block).
pub(crate) fn has_total_marker(lines: &[&str], def_idx: usize) -> bool {
    let mut k = def_idx;
    while k > 0 {
        let prev = lines[k - 1].trim();
        let body = if let Some(rest) = prev.strip_prefix('#') {
            rest
        } else if let Some(rest) = prev.strip_prefix("--") {
            rest
        } else {
            return false;
        };
        if body.trim().eq_ignore_ascii_case(TOTAL_MARKER) {
            return true;
        }
        k -= 1;
    }
    false
}

fn is_erased_proof_or_type_def(header_part: &str, body: &str, law_names: &HashSet<String>) -> bool {
    let def_name = header_part.split('(').next().unwrap_or("").trim();
    if law_names.contains(def_name) {
        return true;
    }

    let mut params_raw = "";
    let mut tail = header_part;
    if let Some(open) = header_part.find('(') {
        let mut depth = 0i32;
        let mut close = None;
        for (idx, ch) in header_part[open..].char_indices() {
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
        if let Some(c) = close {
            params_raw = header_part[open + 1..c].trim();
            tail = header_part[c + 1..].trim();
        }
    }

    if let Some(ret) = tail.strip_prefix("->").map(str::trim) {
        if ret.starts_with('{')
            || matches!(ret, "Type" | "Data" | "Empty" | "*0" | "*1" | "*2")
            || ret.starts_with("Kind(")
            || (ret.contains('{') && ret.contains("=="))
        {
            return true;
        }
    } else if body.contains("{==}") {
        return true;
    }

    if !params_raw.is_empty() {
        for chunk in split_type_args(params_raw, ',') {
            let item = chunk.trim();
            if item.is_empty() {
                continue;
            }
            if let Some((lhs, ty)) = split_type_args_once(item, ':') {
                let lhs = lhs.trim();
                let ty = ty.trim();
                if !lhs.starts_with('-') && (ty.starts_with('{') || ty == "Empty") {
                    return true;
                }
            }
        }
    }

    false
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
        for part in split_type_args(inner, ',') {
            let p = part.trim();
            if p.is_empty() {
                continue;
            }
            if let Some((_fname, fty)) = split_type_args_once(p, ':') {
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
        for chunk in split_type_args(params_raw, ',') {
            let item = chunk.trim();
            if item.is_empty() {
                continue;
            }
            let (lhs, ty) = split_type_args_once(item, ':')
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
        total: false,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArithMode {
    NatChecked,
    Wrapping,
    /// `F32`: IEEE arithmetic, plain Rust operators on `f32`.
    Float,
}

pub(crate) fn arith_mode_for_type(ty: &str, fallback: ArithMode) -> ArithMode {
    match ty.trim() {
        "U32" | "U64" | "I32" | "I64" => ArithMode::Wrapping,
        "Nat" => ArithMode::NatChecked,
        "F32" => ArithMode::Float,
        _ => fallback,
    }
}

pub(crate) fn bend_type_to_rust(ty: &str, type_params: &HashSet<String>) -> String {
    let t = ty.trim();
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
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
    let amp_parts = split_type_args(t, '&');
    if amp_parts.len() > 1 {
        let mapped = amp_parts
            .into_iter()
            .map(|p| bend_type_to_rust(p, type_params))
            .collect::<Vec<_>>()
            .join(", ");
        return format!("({mapped})");
    }
    if let Some(elem) = parse_list_elem_type(t) {
        return format!("List<{}>", bend_type_to_rust(elem, type_params));
    }
    match t {
        "Nat" | "U64" => "u64".to_string(),
        "U32" => "u32".to_string(),
        "I32" => "i32".to_string(),
        "I64" => "i64".to_string(),
        "Bool" => "bool".to_string(),
        "F32" => "f32".to_string(),
        "Unit" | "()" => "()".to_string(),
        _ if type_params.contains(t) => rust_ident(t),
        _ if t.split('.').all(is_valid_rust_ident_or_wildcard) => rust_path(t),
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

/// Rust strict, reserved and edition-reserved keywords. A Bend name that equals one of
/// these is legal in Bend but must never be emitted as a bare Rust identifier.
/// `true`/`false` are left out: they are Bend literals too and must stay literals.
const RUST_KEYWORDS: &[&str] = &[
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern",
    "fn", "for", "gen", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
    "ref", "return", "self", "Self", "static", "struct", "super", "trait", "try", "type", "unsafe",
    "use", "where", "while", "abstract", "become", "box", "do", "final", "macro", "override",
    "priv", "typeof", "unsized", "virtual", "yield",
];

/// Keywords that cannot be written as raw identifiers (`r#self` is rejected by rustc).
const NON_RAW_KEYWORDS: &[&str] = &["self", "Self", "super", "crate"];

/// Maps a Bend identifier to a Rust identifier that cannot clash with a Rust keyword:
/// `as` becomes `r#as`, and `self`/`Self`/`super`/`crate` become `__rb_self` and so on.
/// Every place that turns a Bend value name (def, parameter, binder, law variable) into
/// Rust source must go through this (or [`rust_path`]).
pub(crate) fn rust_ident(name: &str) -> String {
    if NON_RAW_KEYWORDS.contains(&name) {
        format!("__rb_{name}")
    } else if RUST_KEYWORDS.contains(&name) {
        format!("r#{name}")
    } else {
        name.to_string()
    }
}

/// Like [`rust_ident`] for a dotted Bend path (`Mod.name` -> `Mod::name`), escaping each
/// segment.
pub(crate) fn rust_path(path: &str) -> String {
    path.split('.')
        .map(rust_ident)
        .collect::<Vec<_>>()
        .join("::")
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

#[derive(Default)]
struct PatState {
    succ_counter: usize,
    box_counter: usize,
    guard_counter: usize,
    bindings: Vec<String>,
    guards: Vec<String>,
    bound_vars: Vec<(String, Option<String>)>,
}

fn is_nat_literal(s: &str) -> bool {
    s.strip_suffix('n')
        .is_some_and(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
}

fn is_plain_binder_ident(s: &str, ctors: &HashMap<String, CtorInfo>) -> bool {
    !matches!(
        s,
        "_" | "true" | "false" | "True{}" | "False{}" | "Unit{}" | "()" | "[]"
    ) && !is_nat_literal(s)
        && !ctors.contains_key(s)
        && !s.contains('.')
        && is_valid_rust_ident_or_wildcard(s)
}

fn split_expected_tuple_types(expected_ty: Option<&str>) -> Option<Vec<&str>> {
    let t = expected_ty?.trim();
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        let parts = split_type_args(inner, ',');
        if parts.len() > 1 {
            return Some(parts);
        }
        return split_expected_tuple_types(Some(inner));
    }
    let amp = split_type_args(t, '&');
    if amp.len() > 1 {
        return Some(amp);
    }
    None
}

fn emit_pattern_guard(
    pat: &str,
    target: &str,
    ctors: &HashMap<String, CtorInfo>,
    guard_counter: &mut usize,
) -> Result<String, String> {
    let p = pat.trim();
    if p == "_" || p == "Unit{}" || p == "()" {
        return Ok("true".to_string());
    }
    // Guard targets are references (boxed fields, sub-bindings of a borrowed match):
    // dereference before matching a literal so every Rust edition and version accepts it.
    if p == "true" || p == "True{}" {
        return Ok(format!("matches!(*({target}), true)"));
    }
    if p == "false" || p == "False{}" {
        return Ok(format!("matches!(*({target}), false)"));
    }
    if p == "[]" {
        return Ok(format!("matches!({target}, List::Nil)"));
    }
    if let Some(nat_pat) = parse_nat_succ_pattern(p)? {
        return Ok(match nat_pat {
            NatPattern::Const(total) => format!("matches!(*({target}), {total}_u64)"),
            NatPattern::Succ { offset: 0, .. } => "true".to_string(),
            NatPattern::Succ { offset, .. } => {
                format!("matches!(*({target}), {offset}_u64..=u64::MAX)")
            }
        });
    }
    if let Some(digits) = p.strip_suffix('n') {
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            return Ok(format!("matches!(*({target}), {digits}_u64)"));
        }
    }
    if is_wrapped_in_parens(p) {
        let inner = p[1..p.len() - 1].trim();
        let parts = split_top_level(inner, ',');
        if parts.len() > 1 {
            let mut vars = Vec::with_capacity(parts.len());
            let mut sub_guards = Vec::with_capacity(parts.len());
            for part in parts {
                let gv = format!("__rb_g{}", *guard_counter);
                *guard_counter += 1;
                let sg = emit_pattern_guard(part, &gv, ctors, guard_counter)?;
                vars.push(gv);
                sub_guards.push(sg);
            }
            return Ok(format!(
                "match {target} {{ ({}) => {} }}",
                vars.join(", "),
                sub_guards.join(" && ")
            ));
        }
    }
    if let Some((head, inner, is_curly)) = split_ctor_pattern(p)? {
        let info_opt = ctors.get(head);
        let rust_head = resolve_ctor_path(head, ctors);
        if inner.is_empty() {
            return Ok(format!("matches!({target}, {rust_head})"));
        }
        let parts = split_top_level(inner, ',');
        let mut vars = Vec::with_capacity(parts.len());
        let mut sub_guards = Vec::with_capacity(parts.len());
        for (idx, part) in parts.iter().enumerate() {
            let rhs = extract_ctor_pattern_field_rhs(part, is_curly);
            let is_boxed = info_opt
                .and_then(|i| i.boxed_fields.get(idx).copied())
                .unwrap_or(false);
            let gv = format!("__rb_g{}", *guard_counter);
            *guard_counter += 1;
            let sub_target = if is_boxed {
                format!("&**{gv}")
            } else {
                gv.clone()
            };
            let sg = emit_pattern_guard(rhs, &sub_target, ctors, guard_counter)?;
            vars.push(gv);
            sub_guards.push(sg);
        }
        return Ok(format!(
            "match {target} {{ {rust_head}({}) => {}, _ => false }}",
            vars.join(", "),
            sub_guards.join(" && ")
        ));
    }
    let clean = p.trim_start_matches('+').trim_start_matches('-').trim();
    if is_plain_binder_ident(clean, ctors) {
        return Ok("true".to_string());
    }
    if clean.is_empty() || !clean.split('.').all(is_valid_rust_ident_or_wildcard) {
        return Err(format!(
            "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported match pattern '{p}'"
        ));
    }
    let rust_head = resolve_ctor_path(clean, ctors);
    Ok(format!("matches!({target}, {rust_head})"))
}

fn split_ctor_pattern(p: &str) -> Result<Option<(&str, &str, bool)>, String> {
    if let Some(open) = p.find('{') {
        if p.ends_with('}') {
            let head = p[..open].trim();
            if !is_valid_path_ident(head) {
                return Err(format!(
                    "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported constructor pattern '{p}'"
                ));
            }
            return Ok(Some((head, p[open + 1..p.len() - 1].trim(), true)));
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
            return Ok(Some((head, p[open + 1..p.len() - 1].trim(), false)));
        }
    }
    Ok(None)
}

fn extract_ctor_pattern_field_rhs(raw: &str, is_curly: bool) -> &str {
    let clean = raw
        .trim()
        .trim_start_matches('+')
        .trim_start_matches('-')
        .trim();
    if is_curly {
        if let Some((_, v)) = split_top_level_once(clean, ':') {
            return v
                .trim()
                .trim_start_matches('+')
                .trim_start_matches('-')
                .trim();
        }
    }
    clean
}

fn emit_single_pattern(
    pat: &str,
    ctors: &HashMap<String, CtorInfo>,
    expected_ty: Option<&str>,
    state: &mut PatState,
) -> Result<String, String> {
    let p = pat.trim();
    if p == "_" || p == "true" || p == "false" || p == "()" {
        return Ok(p.to_string());
    }
    if p == "True{}" {
        return Ok("true".to_string());
    }
    if p == "False{}" {
        return Ok("false".to_string());
    }
    if p == "Unit{}" {
        return Ok("()".to_string());
    }
    if p == "[]" {
        return Ok("List::Nil".to_string());
    }
    if let Some(nat_pat) = parse_nat_succ_pattern(p)? {
        return match nat_pat {
            NatPattern::Const(total) => Ok(format!("{total}_u64")),
            NatPattern::Succ { offset: 0, var } => {
                if var != "_" {
                    state
                        .bound_vars
                        .push((var.clone(), Some("Nat".to_string())));
                }
                Ok(rust_ident(&var))
            }
            NatPattern::Succ { offset, var } if var == "_" => {
                Ok(format!("{offset}_u64..=u64::MAX"))
            }
            NatPattern::Succ { offset, var } => {
                let idx = state.succ_counter;
                state.succ_counter += 1;
                let tmp = format!("__rb_n{idx}");
                state
                    .bindings
                    .push(format!("let {} = {tmp} - {offset}_u64;", rust_ident(&var)));
                state.bound_vars.push((var, Some("Nat".to_string())));
                Ok(format!("{tmp} @ {offset}_u64..=u64::MAX"))
            }
        };
    }
    if let Some(digits) = p.strip_suffix('n') {
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            return Ok(format!("{digits}_u64"));
        }
    }
    // Tuple pattern: (a, b)
    if is_wrapped_in_parens(p) {
        let inner = p[1..p.len() - 1].trim();
        let parts = split_top_level(inner, ',');
        if parts.len() > 1 {
            let elem_tys = split_expected_tuple_types(expected_ty);
            let mut rust_parts = Vec::new();
            for (idx, part) in parts.iter().enumerate() {
                let sub_ty = elem_tys.as_ref().and_then(|ts| ts.get(idx).copied());
                let rp = emit_single_pattern(part, ctors, sub_ty, state)?;
                rust_parts.push(rp);
            }
            return Ok(format!("({})", rust_parts.join(", ")));
        }
    }
    // Real Bend 2 curly-brace or paren constructor pattern
    if let Some((head, inner, is_curly)) = split_ctor_pattern(p)? {
        let info_opt = ctors.get(head);
        let rust_head = resolve_ctor_path(head, ctors);
        if inner.is_empty() {
            return Ok(rust_head);
        }
        let mut fields = Vec::new();
        for (idx, b) in split_top_level(inner, ',').iter().enumerate() {
            let rhs = extract_ctor_pattern_field_rhs(b, is_curly);
            let is_boxed = info_opt
                .and_then(|i| i.boxed_fields.get(idx).copied())
                .unwrap_or(false);
            let field_ty = info_opt.and_then(|i| i.field_types.get(idx).cloned());
            if !is_boxed {
                fields.push(emit_single_pattern(rhs, ctors, field_ty.as_deref(), state)?);
            } else if rhs == "_" {
                fields.push("_".to_string());
            } else if is_plain_binder_ident(rhs, ctors) {
                let box_tmp = format!("__rb_box{}", state.box_counter);
                state.box_counter += 1;
                state
                    .bindings
                    .push(format!("let {} = *{box_tmp};", rust_ident(rhs)));
                state.bound_vars.push((rhs.to_string(), field_ty));
                fields.push(box_tmp);
            } else {
                let box_tmp = format!("__rb_box{}", state.box_counter);
                state.box_counter += 1;
                let guard = emit_pattern_guard(
                    rhs,
                    &format!("&*{box_tmp}"),
                    ctors,
                    &mut state.guard_counter,
                )?;
                state.guards.push(guard);

                let mut sub_state = PatState {
                    succ_counter: state.succ_counter,
                    box_counter: state.box_counter,
                    guard_counter: state.guard_counter,
                    ..Default::default()
                };
                let inner_pat =
                    emit_single_pattern(rhs, ctors, field_ty.as_deref(), &mut sub_state)?;
                state.succ_counter = sub_state.succ_counter;
                state.box_counter = sub_state.box_counter;
                state.guard_counter = sub_state.guard_counter;
                if !sub_state.bound_vars.is_empty() || !sub_state.bindings.is_empty() {
                    state.bindings.push(format!(
                        "let {inner_pat} = *{box_tmp} else {{ unreachable!() }};"
                    ));
                    state.bindings.extend(sub_state.bindings);
                    state.bound_vars.extend(sub_state.bound_vars);
                }
                fields.push(box_tmp);
            }
        }
        return Ok(format!("{rust_head}({})", fields.join(", ")));
    }
    let clean = p.trim_start_matches('+').trim_start_matches('-').trim();
    if clean.is_empty() || !clean.split('.').all(is_valid_rust_ident_or_wildcard) {
        return Err(format!(
            "[E_EMIT_UNSUPPORTED_PATTERN] Unsupported match pattern '{p}'"
        ));
    }
    if is_plain_binder_ident(clean, ctors) {
        state
            .bound_vars
            .push((clean.to_string(), expected_ty.map(str::to_string)));
        return Ok(rust_ident(clean));
    }
    Ok(resolve_ctor_path(clean, ctors))
}

fn emit_match_pattern(
    pat: &str,
    scrut_count: usize,
    ctors: &HashMap<String, CtorInfo>,
) -> Result<(String, PatState), String> {
    let mut state = PatState::default();
    if scrut_count > 1 {
        let parts = split_pattern_tokens(pat);
        if parts.len() > 1 {
            let mut rust_parts = Vec::new();
            for part in &parts {
                let rp = emit_single_pattern(part, ctors, None, &mut state)?;
                rust_parts.push(rp);
            }
            return Ok((format!("({})", rust_parts.join(", ")), state));
        }
    }
    let rp = emit_single_pattern(pat, ctors, None, &mut state)?;
    Ok((rp, state))
}

fn resolve_ctor_path(name: &str, ctors: &HashMap<String, CtorInfo>) -> String {
    if let Some(info) = ctors.get(name) {
        return ctor_rust_path(info);
    }
    rust_path(name)
}

/// Keyword-safe Rust path `Type::Variant` of a constructor.
fn ctor_rust_path(info: &CtorInfo) -> String {
    format!(
        "{}::{}",
        rust_ident(&info.type_name),
        rust_ident(&info.variant_name)
    )
}

pub(crate) fn leading_indent(line: &str) -> usize {
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
    rust_ident(t.trim_start_matches('+').trim_start_matches('-').trim())
}

fn extract_let_bound_names(raw: &str) -> Vec<String> {
    let t = raw.trim();
    if is_wrapped_in_parens(t) {
        let inner = t[1..t.len() - 1].trim();
        return split_top_level(inner, ',')
            .into_iter()
            .flat_map(extract_let_bound_names)
            .collect();
    }
    let clean = t.trim_start_matches('+').trim_start_matches('-').trim();
    if !clean.is_empty() && clean != "_" && is_valid_rust_ident_or_wildcard(clean) {
        vec![clean.to_string()]
    } else {
        Vec::new()
    }
}

fn is_obviously_copy_expr(expr: &str) -> bool {
    let s = expr.trim();
    s == "True{}"
        || s == "False{}"
        || s == "Unit{}"
        || s == "()"
        || is_nat_literal(s)
        || s.starts_with("Nat.is_")
        || s.starts_with("Nat.add(")
        || s.starts_with("Nat.sub(")
        || s.starts_with("Nat.mul(")
        || s.starts_with("Nat.div(")
        || s.starts_with("Nat.mod(")
        || s.starts_with("Nat.min(")
        || s.starts_with("Nat.max(")
        || s.starts_with("Nat.succ(")
        || s.starts_with("Nat.pred(")
        || s.starts_with("Bool.")
}

pub(crate) fn count_ident_uses(src: &str, name: &str) -> usize {
    if name.is_empty() {
        return 0;
    }
    let bytes = src.as_bytes();
    let nbytes = name.as_bytes();
    let mut count = 0usize;
    let mut i = 0usize;
    let mut in_string = false;

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
        if bytes[i] == b'"' {
            in_string = true;
            i += 1;
            continue;
        }
        if bytes[i] == b'#' || (bytes[i] == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if bytes[i..].starts_with(nbytes) {
            let prev_ok = i == 0
                || (!bytes[i - 1].is_ascii_alphanumeric()
                    && bytes[i - 1] != b'_'
                    && bytes[i - 1] != b'.');
            let end = i + nbytes.len();
            let next_ok =
                end == bytes.len() || (!bytes[end].is_ascii_alphanumeric() && bytes[end] != b'_');
            if prev_ok && next_ok {
                count += 1;
                i = end;
                continue;
            }
        }
        i += 1;
    }
    count
}

fn split_top_level_ws(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start: Option<usize> = None;
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' | '[' => {
                if start.is_none() {
                    start = Some(idx);
                }
                depth += 1;
            }
            ')' | '}' | ']' => {
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

#[derive(Clone, Copy)]
pub(crate) struct EmitCtx<'a> {
    pub(crate) defs: &'a HashMap<String, &'a Def>,
    pub(crate) type_env: &'a TypeEnv,
    pub(crate) clone_vars: &'a HashSet<String>,
    pub(crate) has_generics: bool,
    /// Emitting an `Option<T>` body: overflow and total calls propagate `None` with `?`.
    pub(crate) total: bool,
    /// Defs with an `Option`-returning variant (`# rusty-bends: total` defs and their callees).
    pub(crate) total_cone: &'a HashSet<String>,
    /// Records each panicking checked-growth op emitted (ignored in total mode).
    pub(crate) panic_ops: &'a RefCell<Vec<String>>,
    /// Names bound in scope (parameters, pattern binders, `let`s): a bare name in this
    /// set is the local, never a nullary constructor of the same name.
    pub(crate) locals: &'a HashSet<String>,
}

const OVERFLOW_EXPECT: &str = ".expect(\"rusty-bends: Nat overflow\")";

impl EmitCtx<'_> {
    /// Suffix for a `checked_*` result: `?` in total mode, otherwise a recorded panic site.
    fn overflow(&self, op: &str) -> &'static str {
        if self.total {
            "?"
        } else {
            self.panic_ops.borrow_mut().push(op.to_string());
            OVERFLOW_EXPECT
        }
    }
}

/// Name of the `Option`-returning variant of `def`.
pub(crate) fn total_fn_name(def: &Def) -> String {
    if def.total {
        def.name.clone()
    } else {
        format!("__rb_total_{}", def.name)
    }
}

pub(crate) fn emit_expr_with_mode(
    expr: &str,
    defs: &HashMap<String, &Def>,
    type_env: &TypeEnv,
    clone_vars: &HashSet<String>,
    mode: ArithMode,
) -> Result<String, String> {
    let no_cone = HashSet::new();
    let no_locals = HashSet::new();
    let ops = RefCell::new(Vec::new());
    let ctx = EmitCtx {
        defs,
        type_env,
        clone_vars,
        has_generics: false,
        total: false,
        total_cone: &no_cone,
        panic_ops: &ops,
        locals: &no_locals,
    };
    emit_expr_with_ctx(expr, &ctx, mode)
}

fn emit_expr_with_ctx(expr: &str, ctx: &EmitCtx<'_>, mode: ArithMode) -> Result<String, String> {
    let defs = ctx.defs;
    let ctors = &ctx.type_env.ctor_map;
    let lines: Vec<&str> = expr.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return Ok("()".to_string());
    }

    let first_trim = lines[0].trim();

    // Bend 2 binding `x = e` / `+x = e` (no `let`); a dead `-x = e` is erased (q=0).
    let bend2_binding = if lines.len() > 1 && !first_trim.starts_with("let ") {
        bend2_binding_lhs(first_trim)
    } else {
        None
    };
    if let Some((_, true)) = bend2_binding {
        let let_indent = leading_indent(lines[0]);
        let mut rest_idx = 1;
        while rest_idx < lines.len() && leading_indent(lines[rest_idx]) > let_indent {
            rest_idx += 1;
        }
        if rest_idx < lines.len() {
            return emit_expr_with_ctx(&lines[rest_idx..].join("\n"), ctx, mode);
        }
    }

    // Multi-line let bindings:
    //   let x = expr        (or Bend 2: x = expr)
    //   body
    let let_source = if first_trim.starts_with("let ") {
        first_trim.strip_prefix("let ")
    } else if let Some((bind_start, false)) = bend2_binding {
        Some(&first_trim[bind_start..])
    } else {
        None
    };
    let let_split = let_source
        .filter(|_| lines.len() > 1 && split_top_level_once(first_trim, ';').is_none())
        .and_then(|src| split_top_level_once(src, '='));
    if let Some((lhs_raw, val_first)) = let_split {
        let let_indent = leading_indent(lines[0]);
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
                let mut body_clone_vars = ctx.clone_vars.clone();
                let bound_names = extract_let_bound_names(lhs_raw);
                for b in &bound_names {
                    body_clone_vars.remove(b);
                }
                if !ctx.has_generics
                    && !ctx.type_env.non_copy_types.is_empty()
                    && !is_obviously_copy_expr(&val_src)
                {
                    for b in bound_names {
                        if count_ident_uses(&rest_src, &b) > 1 {
                            body_clone_vars.insert(b);
                        }
                    }
                }
                let mut body_locals = ctx.locals.clone();
                body_locals.extend(extract_let_bound_names(lhs_raw));
                let body_ctx = EmitCtx {
                    clone_vars: &body_clone_vars,
                    locals: &body_locals,
                    ..*ctx
                };
                return Ok(format!(
                    "{{\n        let {} = {};\n        {}\n    }}",
                    clean_let_binding(lhs_raw),
                    emit_expr_with_ctx(&val_src, ctx, mode)?,
                    emit_expr_with_ctx(&rest_src, &body_ctx, mode)?
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
                    emitted.push(emit_expr_with_ctx(p, ctx, mode)?);
                }
                format!("({})", emitted.join(", "))
            } else {
                emit_expr_with_ctx(scrut_raw, ctx, mode)?
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
            let mut any_guarded = false;
            for (pat, arm_body) in parsed_arms {
                let (rust_pat, pat_state) = emit_match_pattern(&pat, scrut_parts.len(), ctors)?;
                let mut arm_clone_vars = ctx.clone_vars.clone();
                for (var, _) in &pat_state.bound_vars {
                    arm_clone_vars.remove(var);
                }
                if !ctx.has_generics {
                    for (var, field_ty) in &pat_state.bound_vars {
                        // Binders of unknown type (tuple scrutinees, wildcards) may hold a
                        // non-Copy value: clone on reuse, which is a no-op cost for Copy.
                        let maybe_non_copy = match field_ty.as_deref() {
                            Some("_") | None => !ctx.type_env.non_copy_types.is_empty(),
                            Some(ty) => type_contains_non_copy(ty, &ctx.type_env.non_copy_types),
                        };
                        if maybe_non_copy && count_ident_uses(&arm_body, var) > 1 {
                            arm_clone_vars.insert(var.clone());
                        }
                    }
                }
                let mut arm_locals = ctx.locals.clone();
                arm_locals.extend(pat_state.bound_vars.iter().map(|(v, _)| v.clone()));
                let arm_ctx = EmitCtx {
                    clone_vars: &arm_clone_vars,
                    locals: &arm_locals,
                    ..*ctx
                };
                let emitted_body = emit_expr_with_ctx(&arm_body, &arm_ctx, mode)?;
                let guard_clause = if pat_state.guards.is_empty() {
                    String::new()
                } else {
                    any_guarded = true;
                    format!(" if {}", pat_state.guards.join(" && "))
                };
                if pat_state.bindings.is_empty() {
                    rust_arms.push(format!(
                        "        {rust_pat}{guard_clause} => {emitted_body},"
                    ));
                } else {
                    rust_arms.push(format!(
                        "        {rust_pat}{guard_clause} => {{ {} {emitted_body} }},",
                        pat_state.bindings.join(" ")
                    ));
                }
            }
            if any_guarded {
                rust_arms.push("        _ => unreachable!(),".to_string());
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

    // String literal: Bend's String maps to an owned Rust String.
    if is_string_literal(s) {
        return Ok(format!("String::from({s})"));
    }
    // F32 literal (`1.5`), or an integer literal in F32 context.
    if is_float_literal(s) || (mode == ArithMode::Float && is_int_literal(s)) {
        return Ok(format!("{s}_f32"));
    }

    // Handle conditionals: if cond: then_branch else: else_branch
    if let Some(rest) = s.strip_prefix("if ") {
        if let Some((before_else, after_else)) = split_keyword(rest, " else:") {
            if let Some((cond, then_b)) = split_top_level_once(before_else, ':') {
                return Ok(format!(
                    "if {} {{ {} }} else {{ {} }}",
                    emit_expr_with_ctx(cond, ctx, mode)?,
                    emit_expr_with_ctx(then_b, ctx, mode)?,
                    emit_expr_with_ctx(after_else, ctx, mode)?
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
                emitted.push(emit_expr_with_ctx(p, ctx, mode)?);
            }
            return Ok(format!("({})", emitted.join(", ")));
        }
        if let Some((term_part, ty_part)) = split_top_level_once(inner, ':') {
            let inner_mode = arith_mode_for_type(ty_part, mode);
            return emit_expr_with_ctx(term_part, ctx, inner_mode);
        }
        return emit_expr_with_ctx(inner, ctx, mode);
    }

    // List literal sugar: [] or [e1, e2, ...]
    if is_wrapped_in_brackets(s) {
        let inner = s[1..s.len() - 1].trim();
        if inner.is_empty() {
            return Ok("List::Nil".to_string());
        }
        let elems = split_top_level(inner, ',');
        let mut acc = "List::Nil".to_string();
        for elem in elems.into_iter().rev() {
            let emitted = emit_expr_with_ctx(elem, ctx, mode)?;
            acc = format!("List::Con({emitted}, Box::new({acc}))");
        }
        return Ok(acc);
    }

    // Handle single-line let bindings: let x = val; body
    if let Some(rest) = s.strip_prefix("let ") {
        if let Some((binding, body)) = split_top_level_once(rest, ';') {
            if let Some((name, val)) = split_top_level_once(binding, '=') {
                let mut body_clone_vars = ctx.clone_vars.clone();
                let bound_names = extract_let_bound_names(name);
                for b in &bound_names {
                    body_clone_vars.remove(b);
                }
                if !ctx.has_generics
                    && !ctx.type_env.non_copy_types.is_empty()
                    && !is_obviously_copy_expr(val)
                {
                    for b in bound_names {
                        if count_ident_uses(body, &b) > 1 {
                            body_clone_vars.insert(b);
                        }
                    }
                }
                let mut body_locals = ctx.locals.clone();
                body_locals.extend(extract_let_bound_names(name));
                let body_ctx = EmitCtx {
                    clone_vars: &body_clone_vars,
                    locals: &body_locals,
                    ..*ctx
                };
                return Ok(format!(
                    "{{\n        let {} = {};\n        {}\n    }}",
                    clean_let_binding(name),
                    emit_expr_with_ctx(val, ctx, mode)?,
                    emit_expr_with_ctx(body, &body_ctx, mode)?
                ));
            }
        }
    }

    // Logical and comparison binary operators (lowest to highest precedence)
    for op in ["||", "&&", "==", "!=", "<=", ">=", "<", ">"] {
        if let Some((lhs, rhs)) = split_top_level_str(s, op) {
            return Ok(format!(
                "({} {op} {})",
                emit_expr_with_ctx(lhs, ctx, mode)?,
                emit_expr_with_ctx(rhs, ctx, mode)?
            ));
        }
    }

    // String concatenation `a ++ b` (Base String.append).
    if let Some((_, lhs, rhs)) = split_last_spaced_op(s, &["++"]) {
        return Ok(format!(
            "format!(\"{{}}{{}}\", {}, {})",
            emit_expr_with_ctx(lhs, ctx, mode)?,
            emit_expr_with_ctx(rhs, ctx, mode)?
        ));
    }

    // Bitwise `.|.` < `.^.` < `.&.` < shifts `<<` `>>` (Bend 2 precedence), fixed-width only.
    for ops in [&[".|."][..], &[".^."], &[".&."], &["<<", ">>"]] {
        if let Some((op, lhs, rhs)) = split_last_spaced_op(s, ops) {
            if mode != ArithMode::Wrapping {
                return Err(format!(
                    "[E_EMIT_UNSUPPORTED] '{op}' needs a fixed-width type annotation such as '(a {op} b : U32)' in '{s}'"
                ));
            }
            let l = emit_expr_with_ctx(lhs, ctx, mode)?;
            return Ok(match op {
                ".|." => format!("({l} | {})", emit_expr_with_ctx(rhs, ctx, mode)?),
                ".^." => format!("({l} ^ {})", emit_expr_with_ctx(rhs, ctx, mode)?),
                ".&." => format!("({l} & {})", emit_expr_with_ctx(rhs, ctx, mode)?),
                // U32.shln / U32.shrn: the shift amount is a Nat; 32 or more gives 0.
                _ => {
                    let r = emit_expr_with_ctx(rhs, ctx, ArithMode::NatChecked)?;
                    let rust_op = if op == "<<" { "<<" } else { ">>" };
                    format!("{{ let __a = {l}; let __b: u64 = {r}; if __b >= 32 {{ 0 }} else {{ __a {rust_op} __b }} }}")
                }
            });
        }
    }

    // Right-to-left top-level '+' or '-' (checked add / saturating sub for Nat; wrapping for U32/U64/I32/I64)
    if let Some((op, lhs, rhs)) = split_last_additive(s) {
        // `1n+x` (no spaces) is Bend's Nat successor sugar: Nat whatever the context.
        let mode = if op == '+' && is_nat_successor(s, lhs) {
            ArithMode::NatChecked
        } else {
            mode
        };
        let l = emit_expr_with_ctx(lhs, ctx, mode)?;
        let r = emit_expr_with_ctx(rhs, ctx, mode)?;
        return Ok(match (mode, op) {
            (ArithMode::NatChecked, '+') => {
                format!("({l}).checked_add({r}){}", ctx.overflow("Nat.add"))
            }
            (ArithMode::NatChecked, '-') => format!("({l}).saturating_sub({r})"),
            (ArithMode::Wrapping, '+') => format!("({l}).wrapping_add({r})"),
            (ArithMode::Wrapping, '-') => format!("({l}).wrapping_sub({r})"),
            (ArithMode::Float, _) => format!("({l} {op} {r})"),
            _ => unreachable!(),
        });
    }

    // Right-to-left top-level '*', '/', '%'
    if let Some((op, lhs, rhs)) = split_last_multiplicative(s) {
        let l = emit_expr_with_ctx(lhs, ctx, mode)?;
        let r = emit_expr_with_ctx(rhs, ctx, mode)?;
        return Ok(match (mode, op) {
            (ArithMode::NatChecked, '*') => {
                format!("({l}).checked_mul({r}){}", ctx.overflow("Nat.mul"))
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
                format!("{{ let __a = {l}; let __b = {r}; if __b == 0 {{ __a }} else {{ __a.wrapping_rem(__b) }} }}")
            }
            // F32.mod is C fmod, which Rust's '%' on f32 matches.
            (ArithMode::Float, _) => format!("({l} {op} {r})"),
            _ => unreachable!(),
        });
    }

    // Unary boolean negation
    if let Some(operand) = s.strip_prefix('!') {
        return Ok(format!("!({})", emit_expr_with_ctx(operand, ctx, mode)?));
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
            let info_opt = ctors.get(callee);
            let parts = split_top_level(args_inner, ',');
            let mut emitted_args = Vec::with_capacity(parts.len());
            for (idx, a) in parts.iter().enumerate() {
                let trimmed = a.trim();
                let val = if let Some((_, v)) = split_top_level_once(trimmed, ':') {
                    v
                } else {
                    trimmed
                };
                let field_mode = info_opt
                    .and_then(|i| i.field_types.get(idx))
                    .map_or(mode, |ty| arith_mode_for_type(ty, mode));
                let emitted = emit_expr_with_ctx(val, ctx, field_mode)?;
                let is_boxed = info_opt
                    .and_then(|i| i.boxed_fields.get(idx).copied())
                    .unwrap_or(false);
                if is_boxed {
                    emitted_args.push(format!("Box::new({emitted})"));
                } else {
                    emitted_args.push(emitted);
                }
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
            if let Some(builtin) = emit_base_builtin(callee, &raw_args, ctx, mode)? {
                return Ok(builtin);
            }

            if let Some(info) = ctors.get(callee) {
                let mut emitted_args = Vec::with_capacity(raw_args.len());
                for (idx, a) in raw_args.iter().enumerate() {
                    let field_mode = info
                        .field_types
                        .get(idx)
                        .map_or(mode, |ty| arith_mode_for_type(ty, mode));
                    let emitted = emit_expr_with_ctx(a, ctx, field_mode)?;
                    let is_boxed = info.boxed_fields.get(idx).copied().unwrap_or(false);
                    if is_boxed {
                        emitted_args.push(format!("Box::new({emitted})"));
                    } else {
                        emitted_args.push(emitted);
                    }
                }
                return Ok(format!(
                    "{}({})",
                    ctor_rust_path(info),
                    emitted_args.join(", ")
                ));
            }

            let mut emitted_args = Vec::new();
            let target_def = defs.get(callee);
            for (idx, arg) in raw_args.iter().enumerate() {
                let mut arg_mode = mode;
                if let Some(def) = target_def {
                    if let Some(param) = def.params.get(idx) {
                        if param.q == Quantity::Dead {
                            continue;
                        }
                        // Arguments take the callee's parameter type, not the caller's.
                        arg_mode = arith_mode_for_type(&param.ty, mode);
                    }
                }
                emitted_args.push(emit_expr_with_ctx(arg, ctx, arg_mode)?);
            }
            if let Some(def) = target_def {
                if ctx.total && ctx.total_cone.contains(callee) {
                    return Ok(format!(
                        "{}({})?",
                        rust_path(&total_fn_name(def)),
                        emitted_args.join(", ")
                    ));
                }
                if def.total {
                    // A total function called from panicking code keeps panicking semantics.
                    return Ok(format!(
                        "{}({}){}",
                        rust_path(callee),
                        emitted_args.join(", "),
                        ctx.overflow(&format!("call {callee}"))
                    ));
                }
            }
            return Ok(format!(
                "{}({})",
                rust_path(callee),
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
    // A bare name is a local before it is a nullary constructor (Bend 2 writes those `C{}`).
    if let Some(info) = ctors.get(s) {
        if info.arity == 0 && !ctx.locals.contains(s) {
            return Ok(ctor_rust_path(info));
        }
    }

    if ctx.clone_vars.contains(s) {
        return Ok(format!("{}.clone()", rust_ident(s)));
    }

    if s.split('.').all(is_valid_rust_ident_or_wildcard) {
        return Ok(rust_path(s));
    }
    Ok(s.replace('.', "::"))
}

fn emit_base_builtin(
    callee: &str,
    raw_args: &[&str],
    ctx: &EmitCtx<'_>,
    mode: ArithMode,
) -> Result<Option<String>, String> {
    let e = |a: &str, m: ArithMode| emit_expr_with_ctx(a, ctx, m);
    Ok(match (callee, raw_args.len()) {
        // Unary Bool / Nat / Pair helpers
        ("Bool.not", 1) => Some(format!("(!({}))", e(raw_args[0], mode)?)),
        ("Nat.is_zero", 1) => Some(format!(
            "(({}) == 0_u64)",
            e(raw_args[0], ArithMode::NatChecked)?
        )),
        ("Nat.succ", 1) => Some(format!(
            "({}).checked_add(1_u64){}",
            e(raw_args[0], ArithMode::NatChecked)?,
            ctx.overflow("Nat.succ")
        )),
        ("Nat.pred", 1) => Some(format!(
            "({}).saturating_sub(1_u64)",
            e(raw_args[0], ArithMode::NatChecked)?
        )),
        ("Pair.fst", 1) => Some(format!("({}).0", e(raw_args[0], mode)?)),
        ("Pair.snd", 1) => Some(format!("({}).1", e(raw_args[0], mode)?)),

        // Binary Nat arithmetic (checked add/mul, saturating sub, total div/mod matching Bend 2)
        ("Nat.add", 2) => Some(format!(
            "({}).checked_add({}){}",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?,
            ctx.overflow("Nat.add")
        )),
        ("Nat.sub", 2) => Some(format!(
            "({}).saturating_sub({})",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?
        )),
        ("Nat.mul", 2) => Some(format!(
            "({}).checked_mul({}){}",
            e(raw_args[0], ArithMode::NatChecked)?,
            e(raw_args[1], ArithMode::NatChecked)?,
            ctx.overflow("Nat.mul")
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
                '(' | '{' | '[' => depth += 1,
                ')' | '}' | ']' => depth -= 1,
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

pub(crate) fn split_case_arm(arm: &str) -> Option<(&str, &str)> {
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
            b'(' | b'{' | b'[' => depth += 1,
            b')' | b'}' | b']' => depth -= 1,
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
            b'(' | b'{' | b'[' => depth += 1,
            b')' | b'}' | b']' => depth -= 1,
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
    let mut in_string = false;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            if b == b'\\' {
                i += 1;
            } else if b == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'(' | b'{' | b'[' => depth += 1,
            b')' | b'}' | b']' => depth -= 1,
            _ if depth == 0 && i > 0 && s[i..].starts_with(op) => {
                let prev = bytes[i - 1];
                let next = bytes.get(i + op.len()).copied().unwrap_or(b' ');
                // '<' and '>' alone must not match inside '<=', '>=', '<<', '>>', '->',
                // '<-', '<>', '<&>', or '=>'.
                let part_of_longer = match op {
                    "<" => matches!(next, b'=' | b'<' | b'-' | b'>' | b'&') || prev == b'<',
                    ">" => {
                        matches!(next, b'=' | b'>')
                            || matches!(prev, b'=' | b'-' | b'>' | b'&' | b'<')
                    }
                    _ => false,
                };
                if !part_of_longer {
                    return Some((s[..i].trim(), s[i + op.len()..].trim()));
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Splits `s` at the last top-level ` op ` (spaced, as Bend 2 requires for infix
/// operators) among `ops`, outside brackets and string literals: left-associative.
fn split_last_spaced_op<'a>(
    s: &'a str,
    ops: &[&'static str],
) -> Option<(&'static str, &'a str, &'a str)> {
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut found = None;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            if b == b'\\' {
                i += 1;
            } else if b == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'(' | b'{' | b'[' => depth += 1,
            b')' | b'}' | b']' => depth -= 1,
            b' ' if depth == 0 => {
                for op in ops {
                    let end = i + 1 + op.len();
                    if s[i + 1..].starts_with(op) && bytes.get(end) == Some(&b' ') {
                        found = Some((*op, s[..i].trim(), s[end + 1..].trim()));
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    found
}

fn is_valid_path_ident(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

pub(crate) fn is_wrapped_in_parens(s: &str) -> bool {
    is_wrapped_in_delims(s, '(', ')')
}

fn is_wrapped_in_brackets(s: &str) -> bool {
    is_wrapped_in_delims(s, '[', ']')
}

fn is_wrapped_in_delims(s: &str, open: char, close: char) -> bool {
    if !(s.starts_with(open) && s.ends_with(close)) {
        return false;
    }
    let mut depth = 0i32;
    for (idx, ch) in s.char_indices() {
        if ch == open {
            depth += 1;
        } else if ch == close {
            depth -= 1;
            if depth == 0 && idx < s.len() - close.len_utf8() {
                return false;
            }
        }
    }
    depth == 0
}

fn is_wrapped_in_angles(s: &str) -> bool {
    if !(s.starts_with('<') && s.ends_with('>')) {
        return false;
    }
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    for (idx, ch) in s.char_indices() {
        match ch {
            '<' => depth += 1,
            '>' => {
                if idx > 0 && bytes[idx - 1] == b'-' {
                    continue;
                }
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

pub(crate) fn split_type_args(s: &str, delim: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    let bytes = s.as_bytes();
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' | '[' | '<' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            '>' => {
                if idx > 0 && bytes[idx - 1] == b'-' {
                    continue;
                }
                depth -= 1;
            }
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

fn split_type_args_once(s: &str, delim: char) -> Option<(&str, &str)> {
    let mut depth = 0i32;
    let bytes = s.as_bytes();
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' | '{' | '[' | '<' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            '>' => {
                if idx > 0 && bytes[idx - 1] == b'-' {
                    continue;
                }
                depth -= 1;
            }
            c if c == delim && depth == 0 => {
                return Some((s[..idx].trim(), s[idx + ch.len_utf8()..].trim()));
            }
            _ => {}
        }
    }
    None
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
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
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
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            c if c == delim && depth == 0 => {
                return Some((s[..idx].trim(), s[idx + ch.len_utf8()..].trim()));
            }
            _ => {}
        }
    }
    None
}

/// For a Bend 2 binding line `x = e`, `+x = e`, `~x = e`, `(a, b) = e`, or a dead
/// `-x = e`: the byte offset where the binder starts (after its quantity sigil) and
/// whether the binding is dead (erased).
fn bend2_binding_lhs(line: &str) -> Option<(usize, bool)> {
    let (start, dead) = match line.as_bytes().first()? {
        b'+' | b'~' => (1, false),
        b'-' => (1, true),
        _ => (0, false),
    };
    let rest = &line[start..];
    let lhs_end = if rest.starts_with('(') {
        let close = rest.find(')')?;
        let inner = &rest[1..close];
        if !inner
            .split(',')
            .all(|p| is_valid_rust_ident_or_wildcard(p.trim()))
        {
            return None;
        }
        close + 1
    } else {
        rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))?
    };
    let name = &rest[..lhs_end];
    if name.is_empty() || name.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let after = rest[lhs_end..].trim_start();
    let is_bind = after.starts_with('=') && !after.starts_with("==") && !after.starts_with("=>");
    is_bind.then_some((start, dead))
}

/// `"..."` with no unescaped quote inside.
fn is_string_literal(s: &str) -> bool {
    if s.len() < 2 || !s.starts_with('"') || !s.ends_with('"') {
        return false;
    }
    let inner = &s[1..s.len() - 1];
    let mut escaped = false;
    for ch in inner.chars() {
        if escaped {
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            return false;
        }
    }
    !escaped
}

fn is_int_literal(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

/// `1.5`, `0.25`: digits, one dot, digits.
fn is_float_literal(s: &str) -> bool {
    s.split_once('.')
        .is_some_and(|(a, b)| is_int_literal(a) && is_int_literal(b))
}

/// True when `s` is `lhs+rhs` written as Bend's Nat successor sugar: `lhs` ends in a
/// Nat literal (`1n`, `1n+1n`) and the `+` touches both operands. Bend requires spaces and
/// a type annotation around a real infix `+`, so this form is never fixed-width.
fn is_nat_successor(s: &str, lhs: &str) -> bool {
    let lb = lhs.as_bytes();
    let n = lb.len();
    let ends_in_nat_lit = n >= 2 && lb[n - 1] == b'n' && lb[n - 2].is_ascii_digit();
    let tight = s
        .get(lhs.len()..)
        .is_some_and(|rest| rest.starts_with('+') && !rest[1..].starts_with(char::is_whitespace));
    ends_in_nat_lit && tight && !s.starts_with(char::is_whitespace)
}

pub(crate) fn split_last_additive(s: &str) -> Option<(char, &str, &str)> {
    let mut depth = 0i32;
    let mut found = None;
    let bytes = s.as_bytes();
    let mut in_string = false;
    let mut escaped = false;
    for (idx, ch) in s.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            '+' | '-' if depth == 0 && idx > 0 => {
                if ch == '-' && idx + 1 < bytes.len() && bytes[idx + 1] == b'>' {
                    continue;
                }
                if ch == '+' && (bytes.get(idx + 1) == Some(&b'+') || bytes[idx - 1] == b'+') {
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
    let mut in_string = false;
    let mut escaped = false;
    for (idx, ch) in s.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
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

def clamp_range(n: Nat, lo: Nat, hi: Nat) -> Nat:
  Nat.min(Nat.max(n, lo), hi)

def chunks_needed(items: Nat, size: Nat) -> Nat:
  Nat.add(Nat.div(items, size), Bool.pick(Nat, Nat.is_eq(Nat.mod(items, size), 0n), 0n, 1n))

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
        assert!(summary.rust_source.contains("if (({ let __a = items;"));
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

type Store is Data:
  Ready{free: Nat}
  Exhausted{}

def try_take(state: Store, req: Nat) -> Store:
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
            .contains("true => Store::Ready((free).saturating_sub(req)),"));
        assert!(summary.rust_source.contains("match (a, b) {"));
        assert!(summary.rust_source.contains("(0_u64, _) => 0_u64,"));
        assert!(summary.rust_source.contains("(__rb_n0 @ 1_u64..=u64::MAX, __rb_n1 @ 1_u64..=u64::MAX) => { let ap = __rb_n0 - 1_u64; let bp = __rb_n1 - 1_u64;"));
        assert!(!summary.rust_source.contains("helper_lemma"));
    }

    #[test]
    fn emits_pair_types_and_pair_accessors() {
        let src = r#"
import Base

def split_chunks(n: Nat, size: Nat) -> Nat & Nat:
  Nat.divmod(n, size)

def first_of_pair(p: Nat & Nat) -> Nat:
  Pair.fst(Nat, Nat, p)
"#;
        let summary = emit_verified_rust(src, 0).expect("pair emit succeeded");
        assert!(summary
            .rust_source
            .contains("pub fn split_chunks(n: u64, size: u64) -> (u64, u64)"));
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

def in_order(
  +lo: Nat,  # comment inside the header
  +mid: Nat,
  hi: Nat,
  +step: Nat
) -> Bool:
  (lo <= mid : Nat) && (mid <= hi : Nat)

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
        assert!(summary
            .rust_source
            .contains("pub fn in_order(lo: u64, mid: u64, hi: u64, step: u64) -> bool"));
        assert!(summary
            .rust_source
            .contains("pub fn one_liner(n: u64) -> u64"));
        assert!(!summary.rust_source.contains("add_zero_eq"));
        assert!(summary.rust_source.contains(
            "#[allow(unused_variables, unused_parens, unreachable_patterns, irrefutable_let_patterns, clippy::let_and_return, clippy::double_parens, clippy::unnecessary_cast, clippy::clone_on_copy, clippy::match_like_matches_macro)]"
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

def within_span(a: Nat, b: Nat, span: Nat) -> Bool:
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

def within_span(a: Nat, b: Nat, span: Nat) -> Bool:
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
            "{}\nfn main() {{\n    assert_eq!(minus_two(0), 0);\n    assert_eq!(minus_two(1), 0);\n    assert_eq!(minus_two(2), 0);\n    assert_eq!(minus_two(5), 3);\n    assert!(within_span(10, 20, 0));\n    assert!(within_span(7, 7, 1));\n    assert!(!within_span(7, 8, 1));\n    assert!(within_span(5, 3, 2));\n    assert!(!within_span(10, 3, 2));\n}}\n",
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

    #[test]
    fn emits_recursive_adts_with_box_indirection_and_non_copy_handling() {
        // Covers Issue #9: self-recursion (Chain), non-recursive wrapper (Wrap),
        // mutual recursion (Tree/Forest), nested boxed patterns, and multi-use non-Copy +c.
        let src = r#"import Base

type Chain is Data:
  ChainEnd{}
  ChainLink{has_limit: Bool, limit: Nat, in_use: Nat, rest: Chain}

type Wrap is Data:
  Wrap{inner: Chain}

type Tree is Data:
  Leaf{val: Nat}
  Branch{children: Forest}

type Forest is Data:
  FEmpty{}
  FCons{head: Tree, tail: Forest}

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

def chain_is_two_deep(c: Chain) -> Bool:
  match c:
    case ChainEnd{}:
      False{}
    case ChainLink{_, _, _, ChainEnd{}}:
      False{}
    case ChainLink{_, _, _, ChainLink{_, _, _, ChainEnd{}}}:
      True{}
    case ChainLink{_, _, _, _}:
      False{}

def chain_head_sum_plus_rest(+c: Chain) -> Nat:
  match c:
    case ChainEnd{}:
      0n
    case ChainLink{_, l, _, rest}:
      Nat.add(l, chain_available(rest, chain_available(c, 100n)))

def unwrap_available(w: Wrap, +so_far: Nat) -> Nat:
  match w:
    case Wrap{inner}:
      chain_available(inner, so_far)

def sum_tree(t: Tree) -> Nat:
  match t:
    case Leaf{v}:
      v
    case Branch{children}:
      sum_forest(children)

def sum_forest(f: Forest) -> Nat:
  match f:
    case FEmpty{}:
      0n
    case FCons{head, tail}:
      Nat.add(sum_tree(head), sum_forest(tail))
"#;
        let summary = emit_verified_rust(src, 0).expect("recursive ADTs should emit");
        // Chain: non-Copy + boxed rest
        assert!(summary.rust_source.contains(
            "#[derive(Debug, Clone, PartialEq, Eq)]\npub enum Chain {\n    ChainEnd,\n    ChainLink(bool, u64, u64, Box<Chain>),\n}"
        ), "got:\n{}", summary.rust_source);
        // Wrap: non-recursive (no Box), but non-Copy because it contains Chain
        assert!(
            summary.rust_source.contains(
                "#[derive(Debug, Clone, PartialEq, Eq)]\npub enum Wrap {\n    Wrap(Chain),\n}"
            ),
            "got:\n{}",
            summary.rust_source
        );
        // Mutual recursion: Tree <-> Forest both boxed and non-Copy
        assert!(summary.rust_source.contains("Branch(Box<Forest>),"));
        assert!(summary
            .rust_source
            .contains("FCons(Box<Tree>, Box<Forest>),"));
        // Multi-use +c clones when passed multiple times
        assert!(summary.rust_source.contains("c.clone()"));

        let dir = std::env::temp_dir().join(format!("rb_rec_adt_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rs_path = dir.join("rec_adt.rs");
        let bin_path = dir.join("rec_adt_bin");
        let harness = format!(
            "{}\nfn main() {{\n    let c = Chain::ChainLink(true, 40, 10, Box::new(Chain::ChainLink(false, 99, 0, Box::new(Chain::ChainEnd))));\n    assert_eq!(chain_available(c.clone(), 50), 30);\n    assert!(chain_is_two_deep(c.clone()));\n    assert!(!chain_is_two_deep(Chain::ChainEnd));\n    assert!(!chain_is_two_deep(Chain::ChainLink(true, 1, 0, Box::new(Chain::ChainEnd))));\n    assert_eq!(unwrap_available(Wrap::Wrap(c.clone()), 100), 30);\n    assert_eq!(chain_head_sum_plus_rest(c), 40 + 30);\n    let tr = Tree::Branch(Box::new(Forest::FCons(Box::new(Tree::Leaf(4)), Box::new(Forest::FCons(Box::new(Tree::Leaf(6)), Box::new(Forest::FEmpty))))));\n    assert_eq!(sum_tree(tr), 10);\n}}\n",
            summary.rust_source
        );
        std::fs::write(&rs_path, harness).unwrap();
        let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = std::process::Command::new(&rustc)
            .args(["--edition", "2021", "-D", "warnings", "-o"])
            .arg(&bin_path)
            .arg(&rs_path)
            .output()
            .expect("rustc must run");
        assert!(
            compile.status.success(),
            "rustc failed:\n{}\nsource:\n{}",
            String::from_utf8_lossy(&compile.stderr),
            summary.rust_source
        );
        let run = std::process::Command::new(&bin_path)
            .output()
            .expect("run compiled binary");
        assert!(run.status.success(), "runtime assertions failed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn emits_base_list_and_list_literals_and_compiles_with_rustc() {
        let src = r#"import Base

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

def sample_list() -> List<&2, Nat>:
  [1n, 2n, 3n]
"#;
        let summary = emit_verified_rust(src, 0).expect("Base List should emit");
        assert!(summary.rust_source.contains("pub enum List<T>"));
        assert!(summary.rust_source.contains("Con(T, Box<List<T>>)"));
        assert!(summary
            .rust_source
            .contains("pub fn sum_list(xs: List<u64>) -> u64"));
        assert!(summary
            .rust_source
            .contains("List::Con(1_u64, Box::new(List::Con(2_u64, Box::new(List::Con(3_u64, Box::new(List::Nil))))))"));

        let dir = std::env::temp_dir().join(format!("rb_base_list_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rs_path = dir.join("list.rs");
        let bin_path = dir.join("list_bin");
        let harness = format!(
            "{}\nfn main() {{\n    let s = sample_list();\n    assert_eq!(sum_list(s.clone()), 6);\n    assert_eq!(sum_list(list_cat(s.clone(), s)), 12);\n    assert_eq!(sum_list(List::Nil), 0);\n}}\n",
            summary.rust_source
        );
        std::fs::write(&rs_path, harness).unwrap();
        let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = std::process::Command::new(&rustc)
            .args(["--edition", "2021", "-D", "warnings", "-o"])
            .arg(&bin_path)
            .arg(&rs_path)
            .output()
            .expect("rustc must run");
        assert!(
            compile.status.success(),
            "rustc failed:\n{}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run = std::process::Command::new(&bin_path)
            .output()
            .expect("run compiled binary");
        assert!(run.status.success(), "runtime assertions failed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolves_sibling_import_aliases_in_functions_types_and_comments() {
        let base_src = r#"import Base

type Status is Data:
  Open{}
  Closed{}

def within_limit(pos: Nat, limit: Nat) -> Bool:
  Nat.is_le(pos, limit)
"#;
        let uses_src = r#"import Base
import base_rules.bend as B  # trailing comment

def within_both(+pos: Nat, a: Nat, b: Nat) -> Bool:
  Bool.and(B.within_limit(pos, a), Nat.is_le(pos, b))

def open_or(s: B.Status, flag: Bool) -> Bool:
  match s:
    case B.Open{}: True{}
    case B.Closed{}: flag

# promise: B.within_limit comment text stays untouched
law within_both_diag:
  for +pos: Nat
  for +a: Nat
  {within_both(pos, a, a) == B.within_limit(pos, a) : Bool}
"#;
        let resolved_uses = resolve_import_aliases(uses_src);
        // Idempotent
        assert_eq!(resolve_import_aliases(&resolved_uses), resolved_uses);
        assert!(!resolved_uses.contains("import base_rules.bend"));
        assert!(resolved_uses.contains("import Base"));
        assert!(resolved_uses.contains("within_limit(pos, a)"));
        assert!(resolved_uses.contains("s: Status, flag: Bool"));
        assert!(resolved_uses.contains("case Open{}:"));
        assert!(resolved_uses.contains("# promise: B.within_limit comment text stays untouched"));
        assert!(!resolved_uses.contains("B.within_limit(pos, a)"));

        // Per-file isolation: a sibling file without `as B` can define its own `type B`
        let other_src = r#"import Base

type B is Data:
  Tag{}

def use_b(x: B) -> Nat:
  match x:
    case Tag{}: 1n
"#;
        let combined = format!(
            "{}\n{}\n{}\n",
            resolve_import_aliases(base_src),
            resolved_uses,
            resolve_import_aliases(other_src)
        );
        let summary = emit_verified_rust(&combined, 1).expect("emit with resolved aliases");
        assert!(!summary.rust_source.contains("B::within_limit"));
        assert!(!summary.rust_source.contains("B::Status"));
        assert!(!summary.rust_source.contains("B::Open"));
        assert!(summary.rust_source.contains("B::Tag"));
        assert!(summary.rust_source.contains("within_limit(pos, a)"));
        assert!(summary.rust_source.contains("pub enum Status"));
        assert!(summary.rust_source.contains("pub enum B"));
    }

    #[test]
    fn erases_type_level_and_proof_only_helper_defs() {
        let bundled = emit_verified_rust(include_str!("../lemmas/nat_lemmas.bend"), 0)
            .expect("bundled nat_lemmas.bend should parse and erase cleanly");
        assert_eq!(bundled.types_emitted, 0);
        assert_eq!(bundled.defs_emitted, 0);

        let mixed = r#"import Base

def bool_pick_type(b: Bool, t: Type, f: Type) -> Type:
  match b:
    case True{}:
      t
    case False{}:
      f

def bool_false_ne_true(h: {False{} == True{} : Bool}) -> Empty:
  %h : bool_pick_type(_, Empty, Unit)
  Unit{}

def bool_absurd(-A: Type, h: {False{} == True{} : Bool}) -> A:
  Empty.absurd(A, bool_false_ne_true(h))

def checked_id(x: Nat, -proof: {x == x : Nat}) -> Nat:
  x
"#;
        let summary = emit_verified_rust(mixed, 0).expect("mixed source should emit");
        assert_eq!(summary.defs_emitted, 1);
        assert!(!summary.rust_source.contains("bool_pick_type"));
        assert!(!summary.rust_source.contains("bool_false_ne_true"));
        assert!(!summary.rust_source.contains("bool_absurd"));
        assert!(summary
            .rust_source
            .contains("pub fn checked_id(x: u64) -> u64"));
    }

    const AREA_SRC: &str = r#"import Base

def area(+w: Nat, +h: Nat) -> Nat:
  Nat.mul(w, h)

def fits_area_limit(+w: Nat, +h: Nat, max_area: Nat) -> Bool:
  Bool.and(Bool.and(Nat.is_gt(w, 0n), Nat.is_gt(h, 0n)), Nat.is_le(area(w, h), max_area))

def fits_default_limit(+w: Nat, +h: Nat) -> Bool:
  fits_area_limit(w, h, 1000n)

# promise: a zero-width rectangle is always refused
law zero_width_refused:
  for +h: Nat
  for +m: Nat
  {fits_area_limit(0n, h, m) == False{} : Bool}
"#;

    fn total_area_src() -> String {
        AREA_SRC.replace(
            "def fits_area_limit(",
            "# Untrusted input reaches this check: refuse instead of panicking.\n# rusty-bends: total\ndef fits_area_limit(",
        )
    }

    fn compile_and_run(tag: &str, source: &str, extra_args: &[&str]) -> String {
        let dir = std::env::temp_dir().join(format!("rb_total_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rs_path = dir.join("main.rs");
        let bin_path = dir.join("main_bin");
        std::fs::write(&rs_path, source).unwrap();
        let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let compile = std::process::Command::new(&rustc)
            .args(["--edition", "2021", "-D", "warnings"])
            .args(extra_args)
            .arg("-o")
            .arg(&bin_path)
            .arg(&rs_path)
            .output()
            .expect("rustc must run");
        assert!(
            compile.status.success(),
            "rustc failed:\n{}\nsource:\n{source}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let run = std::process::Command::new(&bin_path)
            .output()
            .expect("run compiled binary");
        let stdout = String::from_utf8_lossy(&run.stdout).to_string();
        assert!(
            run.status.success(),
            "binary failed:\n{stdout}{}",
            String::from_utf8_lossy(&run.stderr)
        );
        let _ = std::fs::remove_dir_all(&dir);
        stdout
    }

    #[test]
    fn records_checked_growth_panic_sites_and_lists_them_with_file_and_line() {
        let summary = emit_verified_rust(AREA_SRC, 1).unwrap();
        let sites: Vec<(&str, &str)> = summary
            .panic_sites
            .iter()
            .map(|p| (p.function.as_str(), p.op.as_str()))
            .collect();
        // Callers that reach `area` through non-total calls can panic too.
        assert_eq!(
            sites,
            vec![
                ("area", "Nat.mul"),
                ("fits_area_limit", "call area"),
                ("fits_default_limit", "call fits_area_limit"),
            ]
        );

        let path = std::path::Path::new("verified/shapes.bend");
        let listing = crate::format_panic_sites(&summary.panic_sites, &[(path, AREA_SRC)]);
        assert_eq!(
            &listing[..3],
            &[
                "RustyBends panic [area]: Nat.mul at verified/shapes.bend:4",
                "RustyBends panic [fits_area_limit]: call area at verified/shapes.bend:7",
                "RustyBends panic [fits_default_limit]: call fits_area_limit at verified/shapes.bend:10",
            ]
        );
        assert!(listing[3].contains("3 checked-growth panic site(s) in 3 function(s)"));
        assert!(listing[3].contains("# rusty-bends: total"));

        let none = emit_verified_rust("def id(+n: Nat) -> Nat:\n  n\n", 0).unwrap();
        assert!(none.panic_sites.is_empty());
        assert_eq!(
            crate::format_panic_sites(&none.panic_sites, &[]),
            vec!["RustyBends panics: no checked-growth panic sites in emitted Rust"]
        );
    }

    #[test]
    fn total_marker_emits_option_returning_function_that_refuses_overflow() {
        let src = total_area_src();
        let (_, defs) = parse_book_items(&src).unwrap();
        assert!(defs.iter().any(|d| d.name == "fits_area_limit" && d.total));
        assert!(defs.iter().any(|d| d.name == "area" && !d.total));

        let summary = emit_verified_rust(&src, 1).unwrap();
        let rs = &summary.rust_source;
        assert!(
            rs.contains("pub fn fits_area_limit(w: u64, h: u64, max_area: u64) -> Option<bool>"),
            "{rs}"
        );
        // Callee gets a private Option shadow; its public form keeps panicking semantics.
        assert!(rs.contains("fn __rb_total_area(w: u64, h: u64) -> Option<u64>"));
        assert!(rs.contains("(w).checked_mul(h)?"));
        assert!(rs.contains("__rb_total_area(w, h)?"));
        assert!(rs.contains("pub fn area(w: u64, h: u64) -> u64"));

        // Panic listing: area's own Nat.mul, plus the panicking caller of the total fn.
        let mut sites: Vec<(String, String)> = summary
            .panic_sites
            .iter()
            .map(|p| (p.function.clone(), p.op.clone()))
            .collect();
        sites.sort();
        assert_eq!(
            sites,
            vec![
                ("area".to_string(), "Nat.mul".to_string()),
                (
                    "fits_default_limit".to_string(),
                    "call fits_area_limit".to_string()
                ),
            ]
        );
        let path = std::path::Path::new("verified/shapes.bend");
        let listing = crate::format_panic_sites(&summary.panic_sites, &[(path, &src)]);
        assert!(listing.iter().any(|l| l
            == "RustyBends panic [fits_default_limit]: call fits_area_limit at verified/shapes.bend:12"));

        let runtime_only = rs.split("#[cfg(test)]").next().unwrap();
        let harness = format!(
            "{runtime_only}\nfn main() {{\n    assert_eq!(fits_area_limit(u64::MAX, u64::MAX, u64::MAX - 1), None);\n    assert_eq!(fits_area_limit(10, 10, 100), Some(true));\n    assert_eq!(fits_area_limit(10, 11, 100), Some(false));\n    assert_eq!(fits_area_limit(0, 5, 100), Some(false));\n    assert!(std::panic::catch_unwind(|| area(u64::MAX, 2)).is_err());\n    assert!(fits_default_limit(10, 10));\n    assert!(!fits_default_limit(100, 100));\n}}\n"
        );
        compile_and_run("runtime", &harness, &[]);
    }

    const PANIC_LINES_SRC: &str = r#"import Base

def pick_sum(ok: Bool, a: Nat, b: Nat) -> Nat:
  match ok:
    case True{}: Nat.add(a, b)
    case False{}: a

def tight(a: Nat, b: Nat) -> Nat:
  (a + b : Nat)

def wraps(a: U32, b: U32) -> U32:
  (a + b : U32)

def grow(n: Nat) -> Nat:
  match n:
    case 0n: 1n
    case 1n+p: (p * 3n : Nat)
"#;

    #[test]
    fn panic_listing_attributes_single_line_case_arms_and_annotated_infix() {
        if let Some((ok, text)) = reference_check_only("panic_lines", PANIC_LINES_SRC) {
            assert!(
                ok,
                "reference bend must accept the panic-line fixture:\n{text}"
            );
        }
        let summary = emit_verified_rust(PANIC_LINES_SRC, 0).unwrap();
        let path = std::path::Path::new("verified/lines.bend");
        let listing = crate::format_panic_sites(&summary.panic_sites, &[(path, PANIC_LINES_SRC)]);
        assert_eq!(
            &listing[..listing.len() - 1],
            &[
                "RustyBends panic [pick_sum]: Nat.add at verified/lines.bend:5",
                "RustyBends panic [tight]: Nat.add at verified/lines.bend:9",
                "RustyBends panic [grow]: Nat.mul at verified/lines.bend:17",
            ],
            "{listing:#?}"
        );
    }

    #[test]
    fn panic_listing_matches_alias_qualified_calls() {
        let lib = "import Base\n\ndef double(n: Nat) -> Nat:\n  Nat.mul(n, 2n)\n";
        let user = "import Base\nimport lib.bend as L\n\ndef quad(n: Nat) -> Nat:\n  L.double(L.double(n))\n";
        let combined = format!(
            "{}\n{}\n",
            resolve_import_aliases(lib),
            resolve_import_aliases(user)
        );
        let summary = emit_verified_rust(&combined, 0).unwrap();
        let files = [
            (std::path::Path::new("verified/lib.bend"), lib),
            (std::path::Path::new("verified/user.bend"), user),
        ];
        let listing = crate::format_panic_sites(&summary.panic_sites, &files);
        assert!(
            listing.contains(
                &"RustyBends panic [quad]: call double at verified/user.bend:5".to_string()
            ),
            "{listing:#?}"
        );
    }

    #[test]
    fn total_function_generated_law_test_still_runs() {
        let summary = emit_verified_rust(&total_area_src(), 1).unwrap();
        assert!(summary.rust_source.contains("fn law_zero_width_refused()"));
        let out = compile_and_run(
            "lawtest",
            &summary.rust_source,
            &["--test", "-A", "dead_code"],
        );
        assert!(out.contains("law_zero_width_refused ... ok"), "{out}");
        assert!(out.contains("test result: ok"), "{out}");
    }

    /// Runs the reference `bend --check-only` on `source` when the binary is
    /// installed; returns `None` when it is not.
    fn reference_check_only(tag: &str, source: &str) -> Option<(bool, String)> {
        let bend_bin = crate::resolve_bend_bin(
            std::env::var("BEND_BIN").ok(),
            std::env::var_os("PATH"),
            std::env::var_os("HOME").map(std::path::PathBuf::from),
        );
        let dir = std::env::temp_dir().join(format!("rb_ref_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("main.bend");
        std::fs::write(&file, source).unwrap();
        let out = std::process::Command::new(&bend_bin)
            .arg(&file)
            .arg("--check-only")
            .output()
            .ok()?;
        let _ = std::fs::remove_dir_all(&dir);
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        Some((out.status.success(), text))
    }

    const U32_DIV_ZERO_SRC: &str = r#"import Base

def rem_u32(a: U32, b: U32) -> U32:
  (a % b : U32)

def quot_u32(a: U32, b: U32) -> U32:
  (a / b : U32)

# promise: the remainder by zero is the dividend
law rem_by_zero_is_dividend:
  {rem_u32(5, 0) == 5 : U32}

def rem_by_zero_is_dividend():
  {==}

# promise: the quotient by zero is zero
law quot_by_zero_is_zero:
  {quot_u32(5, 0) == 0 : U32}

def quot_by_zero_is_zero():
  {==}
"#;

    const SUCC_IN_U32_SRC: &str = r#"import Base

def take_nat(x: Nat) -> U32:
  match x:
    case 0n: 0
    case 1n+_: 1

def check_succ(n: Nat) -> U32:
  take_nat(1n+n)

def wrap_sum(a: U32, b: U32) -> U32:
  (a + b : U32)

def nat_sum_small(a: Nat, b: Nat) -> Bool:
  Nat.is_le((a + b : Nat), 10n)

# promise: the successor of any Nat is not zero
law succ_not_zero:
  for n: Nat
  {check_succ(n) == 1 : U32}

def succ_not_zero(n):
  {==}
"#;

    #[test]
    fn nat_successor_stays_checked_inside_fixed_width_functions() {
        if let Some((ok, text)) = reference_check_only("succ_u32", SUCC_IN_U32_SRC) {
            assert!(ok, "reference bend must accept the fixture:\n{text}");
        }
        let summary = emit_verified_rust(SUCC_IN_U32_SRC, 1).unwrap();
        let src = &summary.rust_source;
        assert!(
            src.contains("take_nat((1_u64).checked_add(n).expect(\"rusty-bends: Nat overflow\"))"),
            "{src}"
        );
        assert!(!src.contains("(1_u64).wrapping_add"), "{src}");
        assert!(src.contains("(a).wrapping_add(b)"), "{src}");
        assert!(src.contains("(a).checked_add(b).expect("), "{src}");
        assert!(summary
            .panic_sites
            .iter()
            .any(|p| p.function == "check_succ" && p.op == "Nat.add"));
        let runtime_only = src.split("#[cfg(test)]").next().unwrap();
        let harness = format!(
            "{runtime_only}\nfn main() {{\n    assert_eq!(check_succ(5), 1);\n    assert!(std::panic::catch_unwind(|| check_succ(u64::MAX)).is_err());\n    assert_eq!(wrap_sum(u32::MAX, 1), 0);\n    assert!(nat_sum_small(4, 6));\n}}\n"
        );
        compile_and_run("succ_u32", &harness, &["-A", "dead_code"]);
        let out = compile_and_run("succ_u32_laws", src, &["--test", "-A", "dead_code"]);
        assert!(out.contains("law_succ_not_zero ... ok"), "{out}");
    }

    const EMITTER_EDGES_SRC: &str = r#"import Base

type Chain is Data:
  End{}
  Link{val: Nat, rest: Chain}

type move is Data:
  ref{}
  loop{n: Nat}

type Mode is Data:
  idle{}
  busy{n: Nat}

type Sample is Data:
  Reading{at: Nat, value: F32}

def second_is_zero(c: Chain) -> Bool:
  match c:
    case Link{_, Link{0n, _}}: True{}
    case _: False{}

def sh(+a: U32, +b: Nat) -> U32:
  ((a << b : U32) + (a >> b : U32) : U32)

def bits(+a: U32, +b: U32) -> U32:
  ((a .&. b : U32) .|. (a .^. b : U32) : U32)

def area(w: F32, h: F32) -> F32:
  ((w * h : F32) + 1.5 : F32)

def hello(name: String) -> String:
  ("hi.there " ++ name)

def get(m: move) -> Nat:
  match m:
    case ref{}: 0n
    case loop{n}: n

def keep(idle: Nat) -> Nat:
  idle

def dup(+a: Chain, +b: Chain) -> Chain & Chain:
  match a b:
    case End{} x: (x, x)
    case _ y: (y, y)

# promise: a chain whose second value is zero is detected
law second_zero_found:
  {second_is_zero(Link{1n, Link{0n, End{}}}) == True{} : Bool}

def second_zero_found():
  {==}

# promise: shifting sums both directions
law shift_sum:
  {sh(12, 2n) == 51 : U32}

def shift_sum():
  {==}

# promise: shifting by 32 or more gives zero
law shift_far:
  {sh(1, 40n) == 0 : U32}

def shift_far():
  {==}

# promise: and-or-xor equals or
law bits_or:
  {bits(12, 10) == 14 : U32}

def bits_or():
  {==}

# promise: greeting prefixes the name
law greets:
  {hello("bo") == "hi.there bo" : String}

def greets():
  {==}

# promise: a keyword-named variant keeps its field
law loop_get:
  {get(loop{4n}) == 4n : Nat}

def loop_get():
  {==}

# promise: a parameter named like a constructor is the parameter
law keep_param:
  {keep(7n) == 7n : Nat}

def keep_param():
  {==}

# promise: dup copies the second chain when the first is empty
law dup_end:
  {dup(End{}, Link{1n, End{}}) == (Link{1n, End{}}, Link{1n, End{}}) : Chain & Chain}

def dup_end():
  {==}
"#;

    #[test]
    fn emitter_handles_nested_literals_bit_ops_floats_strings_keyword_types_and_shadowing() {
        if let Some((ok, text)) = reference_check_only("emitter_edges", EMITTER_EDGES_SRC) {
            assert!(ok, "reference bend must prove every fixture law:\n{text}");
        }
        let summary = emit_verified_rust(EMITTER_EDGES_SRC, 8).unwrap();
        let src = &summary.rust_source;
        for expected in [
            "pub enum r#move",
            "    r#ref,",
            "    r#loop(u64),",
            "pub fn keep(idle: u64) -> u64",
            "pub fn area(w: f32, h: f32) -> f32",
            "1.5_f32",
            "#[derive(Debug, Clone, Copy, PartialEq)]\npub enum Sample",
            "String::from(\"hi.there \")",
        ] {
            assert!(src.contains(expected), "missing {expected:?} in:\n{src}");
        }
        let out = compile_and_run("emitter_edges", src, &["--test", "-A", "dead_code"]);
        for law in [
            "second_zero_found",
            "shift_sum",
            "shift_far",
            "bits_or",
            "greets",
            "loop_get",
            "keep_param",
            "dup_end",
        ] {
            assert!(out.contains(&format!("law_{law} ... ok")), "{law}:\n{out}");
        }
        let runtime_only = src.split("#[cfg(test)]").next().unwrap();
        let harness = format!(
            "{runtime_only}\nfn main() {{\n    assert_eq!(area(2.5, 3.0), 9.0);\n    assert_eq!(sh(u32::MAX, 31), 0x8000_0001);\n    assert!(!second_is_zero(Chain::Link(0, Box::new(Chain::End))));\n}}\n"
        );
        compile_and_run("emitter_edges_rt", &harness, &["-A", "dead_code"]);
    }

    #[test]
    fn constructor_names_shared_by_two_types_are_rejected() {
        // Bend rejects this within one file; across files it reaches the flat emitter.
        let a = "import Base\n\ntype Light is Data:\n  Off{}\n  On{level: Nat}\n";
        let b = "import Base\n\ntype Switch is Data:\n  Off{}\n  Up{}\n";
        let err = emit_verified_rust(&format!("{a}\n{b}"), 0).unwrap_err();
        assert!(err.contains("E_NAME_COLLISION"), "{err}");
        assert!(err.contains("'Off'"), "{err}");
    }

    #[test]
    fn u32_remainder_by_zero_matches_reference_semantics() {
        if let Some((ok, text)) = reference_check_only("u32_div_zero", U32_DIV_ZERO_SRC) {
            assert!(ok, "reference bend must accept U32 % 0 == a:\n{text}");
        }
        let summary = emit_verified_rust(U32_DIV_ZERO_SRC, 2).unwrap();
        let runtime_only = summary.rust_source.split("#[cfg(test)]").next().unwrap();
        let harness = format!(
            "{runtime_only}\nfn main() {{\n    assert_eq!(rem_u32(5, 0), 5);\n    assert_eq!(rem_u32(7, 3), 1);\n    assert_eq!(quot_u32(5, 0), 0);\n    assert_eq!(quot_u32(7, 3), 2);\n}}\n"
        );
        compile_and_run("u32_div_zero", &harness, &[]);
        let out = compile_and_run(
            "u32_div_zero_laws",
            &summary.rust_source,
            &["--test", "-A", "dead_code"],
        );
        assert!(out.contains("law_rem_by_zero_is_dividend ... ok"), "{out}");
        assert!(out.contains("law_quot_by_zero_is_zero ... ok"), "{out}");
    }
}
