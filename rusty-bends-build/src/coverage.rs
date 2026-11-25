//! Coverage listing linking emitted Bend 2 functions, laws, and host Rust call sites (Issue #21).
//!
//! Reports:
//! - for each emitted live `def`: which laws name it directly and which laws reach it
//!   through their dependency cone;
//! - which emitted functions no law reaches at all;
//! - optionally (when scanning `src/`, `tests/`, `benches/` under a crate root): which
//!   emitted functions are mentioned by name in Rust sources and which laws name only
//!   functions that the host crate never calls.

use crate::emit::{parse_book_items, resolve_import_aliases, rust_ident, Def};
use crate::lock::{extract_laws_from_source, tokenize_bend, CanonicalLaw};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

/// Where host Rust code refers to an emitted function.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RustUse {
    /// Called (or imported / named by path) from non-test code.
    Production,
    /// Referred to only from `tests/`, `benches/`, `#[cfg(test)]` items, or `#[test]` fns.
    TestOnly,
    /// Never referred to.
    Unused,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionCoverage {
    pub name: String,
    pub direct_laws: Vec<String>,
    pub cone_laws: Vec<String>,
    /// `Some(true)` when production Rust code calls the function (`None` when no Rust
    /// sources were scanned). Test-only references count as `Some(false)`.
    pub mentioned_in_rust: Option<bool>,
    /// Finer-grained view of `mentioned_in_rust`.
    pub rust_use: Option<RustUse>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LawCoverage {
    pub name: String,
    pub direct_functions: Vec<String>,
    pub cone_functions: Vec<String>,
    pub unmentioned_direct_functions: Vec<String>,
    pub only_unmentioned_functions: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoverageReport {
    pub functions: Vec<FunctionCoverage>,
    pub laws: Vec<LawCoverage>,
    pub uncovered_functions: Vec<String>,
    pub laws_only_unmentioned: Vec<String>,
    pub rust_scanned: bool,
}

/// Computes law-to-function and optional Rust-source coverage from Bend source text.
pub fn analyze_coverage(
    combined_source: &str,
    crate_root: Option<&Path>,
) -> Result<CoverageReport, String> {
    let resolved = resolve_import_aliases(combined_source);
    let (_types, defs) = parse_book_items(&resolved)?;
    let laws = extract_laws_from_source(&resolved);

    let def_map: HashMap<&str, &Def> = defs.iter().map(|d| (d.name.as_str(), d)).collect();
    let def_names: BTreeSet<String> = defs.iter().map(|d| d.name.clone()).collect();

    let mut def_callees: HashMap<&str, Vec<String>> = HashMap::with_capacity(defs.len());
    for def in &defs {
        let mut callees = Vec::new();
        let mut seen = HashSet::new();
        let locals = crate::law_test::def_local_names(def);
        for tok in crate::law_test::referenced_defs(&def.body, |t| def_names.contains(t), &locals) {
            if seen.insert(tok.clone()) {
                callees.push(tok);
            }
        }
        def_callees.insert(def.name.as_str(), callees);
    }

    let mut direct_laws_by_fn: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut cone_laws_by_fn: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for name in &def_names {
        direct_laws_by_fn.insert(name.clone(), BTreeSet::new());
        cone_laws_by_fn.insert(name.clone(), BTreeSet::new());
    }

    let mut rust_mentions: Option<RustMentions> = None;
    if let Some(root) = crate_root {
        if has_rust_source_dirs(root) {
            rust_mentions = Some(scan_crate_rust_mentions(root)?);
        }
    }
    let rust_scanned = rust_mentions.is_some();

    let use_map: BTreeMap<String, Option<RustUse>> = def_names
        .iter()
        .map(|name| {
            let used = rust_mentions.as_ref().map(|m| m.use_of(&rust_ident(name)));
            (name.clone(), used)
        })
        .collect();
    let mentioned_map: BTreeMap<String, Option<bool>> = use_map
        .iter()
        .map(|(name, used)| (name.clone(), used.map(|u| u == RustUse::Production)))
        .collect();

    let mut law_coverages = Vec::with_capacity(laws.len());
    let mut laws_only_unmentioned = Vec::new();

    for law in &laws {
        let direct_set = direct_functions_for_law(law, &def_names);
        let cone_set = transitive_cone(&direct_set, &def_callees, &def_map);

        for fn_name in &direct_set {
            if let Some(set) = direct_laws_by_fn.get_mut(fn_name) {
                set.insert(law.name.clone());
            }
        }
        for fn_name in &cone_set {
            if let Some(set) = cone_laws_by_fn.get_mut(fn_name) {
                set.insert(law.name.clone());
            }
        }

        let direct_functions: Vec<String> = direct_set.into_iter().collect();
        let cone_functions: Vec<String> = cone_set.into_iter().collect();
        let unmentioned_direct_functions: Vec<String> = if rust_scanned {
            direct_functions
                .iter()
                .filter(|name| mentioned_map.get(*name).copied().flatten() == Some(false))
                .cloned()
                .collect()
        } else {
            Vec::new()
        };
        let only_unmentioned_functions = rust_scanned
            && !direct_functions.is_empty()
            && unmentioned_direct_functions.len() == direct_functions.len();
        if only_unmentioned_functions {
            laws_only_unmentioned.push(law.name.clone());
        }

        law_coverages.push(LawCoverage {
            name: law.name.clone(),
            direct_functions,
            cone_functions,
            unmentioned_direct_functions,
            only_unmentioned_functions,
        });
    }
    laws_only_unmentioned.sort();
    law_coverages.sort_by(|a, b| a.name.cmp(&b.name));

    let mut functions = Vec::with_capacity(def_names.len());
    let mut uncovered_functions = Vec::new();
    for name in &def_names {
        let direct_laws: Vec<String> = direct_laws_by_fn
            .get(name)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        let cone_laws: Vec<String> = cone_laws_by_fn
            .get(name)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        if cone_laws.is_empty() {
            uncovered_functions.push(name.clone());
        }
        functions.push(FunctionCoverage {
            name: name.clone(),
            direct_laws,
            cone_laws,
            mentioned_in_rust: mentioned_map.get(name).copied().flatten(),
            rust_use: use_map.get(name).copied().flatten(),
        });
    }

    Ok(CoverageReport {
        functions,
        laws: law_coverages,
        uncovered_functions,
        laws_only_unmentioned,
        rust_scanned,
    })
}

/// Scans all `.bend` files under `verified_dir` and analyzes coverage against optional `crate_root`.
pub fn analyze_coverage_dir(
    verified_dir: &Path,
    crate_root: Option<&Path>,
) -> Result<CoverageReport, String> {
    let mut files = Vec::new();
    crate::collect_bend_files(verified_dir, &mut files)?;
    files.sort();
    let mut combined = String::new();
    for file in &files {
        let text = fs::read_to_string(file).map_err(|e| e.to_string())?;
        combined.push_str(&resolve_import_aliases(&text));
        combined.push('\n');
    }
    analyze_coverage(&combined, crate_root)
}

/// Formats `report` as human-readable lines for `cargo:warning=` or `rusty-bends-laws --coverage`.
pub fn format_coverage_report(report: &CoverageReport) -> Vec<String> {
    let mut lines = Vec::new();
    for func in &report.functions {
        let direct = if func.direct_laws.is_empty() {
            "none".to_string()
        } else {
            func.direct_laws.join(", ")
        };
        let cone = if func.cone_laws.is_empty() {
            "none".to_string()
        } else {
            func.cone_laws.join(", ")
        };
        let rust_tag = match func.rust_use {
            Some(RustUse::Production) => "; rust=mentioned",
            Some(RustUse::TestOnly) => "; rust=tests-only",
            Some(RustUse::Unused) => "; rust=unmentioned",
            None => "",
        };
        lines.push(format!(
            "RustyBends coverage [fn {}]: direct={direct}; cone={cone}{rust_tag}",
            func.name
        ));
    }

    if report.uncovered_functions.is_empty() {
        lines.push(format!(
            "RustyBends coverage [uncovered functions]: none (0 of {} emitted function(s) reached by no law)",
            report.functions.len()
        ));
    } else {
        lines.push(format!(
            "RustyBends coverage [uncovered functions]: {} ({} of {} emitted function(s) reached by no law)",
            report.uncovered_functions.join(", "),
            report.uncovered_functions.len(),
            report.functions.len()
        ));
    }

    if report.rust_scanned {
        if report.laws_only_unmentioned.is_empty() {
            lines.push(
                "RustyBends coverage [laws naming only unmentioned functions]: none".to_string(),
            );
        } else {
            for law in &report.laws {
                if law.only_unmentioned_functions {
                    let tests_only: Vec<&str> = law
                        .unmentioned_direct_functions
                        .iter()
                        .filter(|f| {
                            report
                                .functions
                                .iter()
                                .any(|c| &c.name == *f && c.rust_use == Some(RustUse::TestOnly))
                        })
                        .map(String::as_str)
                        .collect();
                    let suffix = if tests_only.is_empty() {
                        String::new()
                    } else {
                        format!(" (called only from tests: {})", tests_only.join(", "))
                    };
                    lines.push(format!(
                        "RustyBends coverage [law {}]: names only functions not mentioned in Rust sources: {}{suffix}",
                        law.name,
                        law.unmentioned_direct_functions.join(", ")
                    ));
                }
            }
        }
        lines.push(format!(
            "RustyBends coverage summary: {} emitted function(s) ({} uncovered), {} law(s) ({} naming only unmentioned Rust functions)",
            report.functions.len(),
            report.uncovered_functions.len(),
            report.laws.len(),
            report.laws_only_unmentioned.len()
        ));
    } else {
        lines.push(format!(
            "RustyBends coverage summary: {} emitted function(s) ({} uncovered), {} law(s)",
            report.functions.len(),
            report.uncovered_functions.len(),
            report.laws.len()
        ));
    }

    lines
}

fn direct_functions_for_law(law: &CanonicalLaw, def_names: &BTreeSet<String>) -> BTreeSet<String> {
    let tokens = tokenize_bend(&law.canonical_sig);
    let mut bound_vars: HashSet<&str> = HashSet::new();
    let mut i = 2usize;
    while i < tokens.len() {
        if matches!(tokens[i].as_str(), "for" | "exs") {
            let mut j = i + 1;
            if j < tokens.len() && matches!(tokens[j].as_str(), "+" | "-" | "~") {
                j += 1;
            }
            if j + 1 < tokens.len() && tokens[j + 1] == ":" {
                bound_vars.insert(tokens[j].as_str());
                i = j + 2;
                continue;
            }
        }
        i += 1;
    }

    let mut direct = BTreeSet::new();
    for idx in 2..tokens.len() {
        let tok = tokens[idx].as_str();
        if !def_names.contains(tok) {
            continue;
        }
        let is_call = tokens.get(idx + 1).is_some_and(|next| next == "(");
        if !bound_vars.contains(tok) || is_call {
            direct.insert(tok.to_string());
        }
    }
    direct
}

fn transitive_cone(
    roots: &BTreeSet<String>,
    def_callees: &HashMap<&str, Vec<String>>,
    def_map: &HashMap<&str, &Def>,
) -> BTreeSet<String> {
    let mut visited = BTreeSet::new();
    let mut queue = VecDeque::new();
    for root in roots {
        if def_map.contains_key(root.as_str()) && visited.insert(root.clone()) {
            queue.push_back(root.clone());
        }
    }
    while let Some(name) = queue.pop_front() {
        if let Some(callees) = def_callees.get(name.as_str()) {
            for callee in callees {
                if visited.insert(callee.clone()) {
                    queue.push_back(callee.clone());
                }
            }
        }
    }
    visited
}

pub fn has_rust_source_dirs(root: &Path) -> bool {
    ["src", "tests", "benches"]
        .iter()
        .any(|sub| root.join(sub).is_dir())
}

/// Function references found in host Rust sources, split into production and test code.
#[derive(Debug, Default)]
pub(crate) struct RustMentions {
    production: HashSet<String>,
    tests: HashSet<String>,
}

impl RustMentions {
    fn use_of(&self, ident: &str) -> RustUse {
        if self.production.contains(ident) {
            RustUse::Production
        } else if self.tests.contains(ident) {
            RustUse::TestOnly
        } else {
            RustUse::Unused
        }
    }
}

fn scan_crate_rust_mentions(root: &Path) -> Result<RustMentions, String> {
    let mut mentions = RustMentions::default();
    for sub in ["src", "tests", "benches"] {
        let dir = root.join(sub);
        if !dir.is_dir() {
            continue;
        }
        let mut rs_files = Vec::new();
        collect_rust_files(&dir, &mut rs_files)?;
        rs_files.sort();
        for file in rs_files {
            let text = fs::read_to_string(&file).map_err(|e| e.to_string())?;
            collect_rust_mentions(&text, sub != "src", &mut mentions);
        }
    }
    Ok(mentions)
}

/// Keywords after which an identifier is being declared or bound, not referred to.
const RUST_BINDING_KEYWORDS: &[&str] = &[
    "fn",
    "let",
    "mut",
    "struct",
    "enum",
    "union",
    "mod",
    "const",
    "static",
    "type",
    "trait",
    "macro_rules",
];

/// Records identifiers that host Rust code uses as a function: a call `name(..)` or
/// `name::<T>(..)`, a path `module::name`, or a name in a `use` statement. Method calls
/// and field accesses (`x.name`), declarations (`fn name`, `let name`), struct fields, and
/// plain local variables do not count. References inside `#[cfg(test)]` / `#[test]` items,
/// or anywhere when `all_test` is set (files under `tests/` and `benches/`), are test-only.
pub(crate) fn collect_rust_mentions(source: &str, all_test: bool, out: &mut RustMentions) {
    let toks = rust_tokens(source);
    let mut depth = 0usize;
    let mut test_until: Option<usize> = None;
    let mut pending_test = false;
    let mut in_use = false;
    let text = |i: usize| toks.get(i).map(|t| t.text.as_str()).unwrap_or("");
    for (i, tok) in toks.iter().enumerate() {
        let t = tok.text.as_str();
        // Attributes: #[cfg(test)], #[test], #[bench] mark the next item as test code.
        if t == "#" && text(i + 1) == "[" {
            let is_test_attr = matches!(
                (text(i + 2), text(i + 3), text(i + 4), text(i + 5)),
                ("test" | "bench", "]", _, _) | ("cfg", "(", "test", ")")
            );
            if is_test_attr {
                pending_test = true;
            }
            continue;
        }
        match t {
            "{" => {
                if pending_test && test_until.is_none() {
                    test_until = Some(depth);
                }
                pending_test = false;
                depth += 1;
                continue;
            }
            "}" => {
                depth = depth.saturating_sub(1);
                if test_until == Some(depth) {
                    test_until = None;
                }
                continue;
            }
            ";" => {
                if test_until.is_none() {
                    pending_test = false;
                }
                in_use = false;
                continue;
            }
            "use" if tok.is_ident => {
                in_use = true;
                continue;
            }
            _ => {}
        }
        if !tok.is_ident {
            continue;
        }
        let prev = if i > 0 { text(i - 1) } else { "" };
        if prev == "." || RUST_BINDING_KEYWORDS.contains(&prev) {
            continue;
        }
        let next = text(i + 1);
        let is_call = next == "(" || (next == ":" && text(i + 2) == ":" && text(i + 3) == "<");
        let after_path = prev == ":" && i >= 2 && text(i - 2) == ":";
        if !(in_use || is_call || after_path) {
            continue;
        }
        // `name::rest`: only the last path segment names the function.
        if next == ":" && text(i + 2) == ":" && text(i + 3) != "<" {
            continue;
        }
        if all_test || test_until.is_some() || pending_test {
            out.tests.insert(t.to_string());
        } else {
            out.production.insert(t.to_string());
        }
    }
}

struct RustTok {
    text: String,
    is_ident: bool,
}

fn collect_rust_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            let skip = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n == "target" || n == ".git");
            if !skip {
                collect_rust_files(&path, out)?;
            }
        } else if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            out.push(path);
        }
    }
    Ok(())
}

fn is_rust_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}

fn is_rust_ident_continue(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Identifiers and single-character punctuation of Rust source (including raw
/// `r#ident` tokens), skipping line/block comments, normal/byte/c/raw string literals,
/// numbers, char literals, and lifetimes.
fn rust_tokens(source: &str) -> Vec<RustTok> {
    let mut out: Vec<RustTok> = Vec::new();
    let bytes = source.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        let b = bytes[i];

        // Line comment: // ...
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        // Nested block comment: /* ... */
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            let mut depth = 1usize;
            i += 2;
            while i < bytes.len() && depth > 0 {
                if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'*' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }

        // Raw string literals: r"...", r#"..."#, br#"..."#, cr#"..."#
        let prev_ident = i > 0 && is_rust_ident_continue(bytes[i - 1]);
        if !prev_ident {
            let raw_prefix = if b == b'r' {
                Some(1usize)
            } else if (b == b'b' || b == b'c') && i + 1 < bytes.len() && bytes[i + 1] == b'r' {
                Some(2usize)
            } else {
                None
            };
            if let Some(plen) = raw_prefix {
                let mut p = i + plen;
                let mut hashes = 0usize;
                while p < bytes.len() && bytes[p] == b'#' {
                    hashes += 1;
                    p += 1;
                }
                if p < bytes.len() && bytes[p] == b'"' {
                    p += 1;
                    while p < bytes.len() {
                        if bytes[p] == b'"' {
                            let mut h = 0usize;
                            while h < hashes && p + 1 + h < bytes.len() && bytes[p + 1 + h] == b'#'
                            {
                                h += 1;
                            }
                            if h == hashes {
                                p += 1 + hashes;
                                break;
                            }
                        }
                        p += 1;
                    }
                    i = p;
                    continue;
                }
            }

            // Byte / C strings: b"...", c"..."
            if (b == b'b' || b == b'c') && i + 1 < bytes.len() && bytes[i + 1] == b'"' {
                i = skip_quoted_string(bytes, i + 2);
                continue;
            }
            // Byte char literal: b'...'
            if b == b'b' && i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                i += 1;
                continue;
            }
            // Raw identifier: r#ident
            if b == b'r'
                && i + 2 < bytes.len()
                && bytes[i + 1] == b'#'
                && is_rust_ident_start(bytes[i + 2])
            {
                let start = i;
                i += 3;
                while i < bytes.len() && is_rust_ident_continue(bytes[i]) {
                    i += 1;
                }
                out.push(RustTok {
                    text: source[start..i].to_string(),
                    is_ident: true,
                });
                continue;
            }
        }

        // Normal string literal: "..."
        if b == b'"' {
            i = skip_quoted_string(bytes, i + 1);
            continue;
        }

        // Char literal ('x', '\'', '\u{...}') vs lifetime ('a, 'static)
        if b == b'\'' {
            if i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                i += 2;
                while i < bytes.len() && bytes[i] != b'\'' && bytes[i] != b'\n' {
                    if bytes[i] == b'\\' && i + 1 < bytes.len() {
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                if i < bytes.len() && bytes[i] == b'\'' {
                    i += 1;
                }
                continue;
            }
            if let Some(ch) = source[i + 1..].chars().next() {
                let after = i + 1 + ch.len_utf8();
                if ch != '\'' && ch != '\n' && ch != '\r' && bytes.get(after) == Some(&b'\'') {
                    i = after + 1;
                    continue;
                }
            }
            // Lifetime: skip `'` and its identifier so `'foo` never counts as calling `foo`.
            i += 1;
            if i < bytes.len() && is_rust_ident_start(bytes[i]) {
                while i < bytes.len() && is_rust_ident_continue(bytes[i]) {
                    i += 1;
                }
            }
            continue;
        }

        if is_rust_ident_start(b) {
            let start = i;
            i += 1;
            while i < bytes.len() && is_rust_ident_continue(bytes[i]) {
                i += 1;
            }
            out.push(RustTok {
                text: source[start..i].to_string(),
                is_ident: true,
            });
            continue;
        }

        if b.is_ascii_digit() {
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            continue;
        }

        let ch = source[i..].chars().next().unwrap();
        if !ch.is_whitespace() {
            out.push(RustTok {
                text: ch.to_string(),
                is_ident: false,
            });
        }
        i += ch.len_utf8();
    }
    out
}

fn skip_quoted_string(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            i += 2;
            continue;
        }
        if bytes[i] == b'"' {
            return i + 1;
        }
        i += 1;
    }
    bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static CSEQ: AtomicUsize = AtomicUsize::new(0);

    fn tmp_crate(tag: &str) -> PathBuf {
        let n = CSEQ.fetch_add(1, Ordering::SeqCst);
        let dir = env::temp_dir().join(format!("rb_cov_{tag}_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("verified")).unwrap();
        fs::create_dir_all(dir.join("src")).unwrap();
        dir
    }

    #[test]
    fn coverage_flags_uncovered_functions_and_laws_naming_only_unmentioned_functions() {
        let root = tmp_crate("issue21_repro");
        let ledger = root.join("verified/ledger.bend");
        fs::write(
            &ledger,
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
            r#"mod verified {
    include!(concat!(env!("OUT_DIR"), "/verified.rs"));
}
fn main() {
    let ok = verified::order_fits(3, 4, 10);
    let n = verified::round_up(5, 4);
    println!("{ok} {n}");
}
"#,
        )
        .unwrap();

        let report = analyze_coverage_dir(&root.join("verified"), Some(&root)).unwrap();
        assert!(report.rust_scanned);
        assert_eq!(report.uncovered_functions, vec!["order_fits", "round_up"]);
        assert_eq!(report.laws_only_unmentioned, vec!["order_fits_empty"]);

        let spec_cov = report
            .functions
            .iter()
            .find(|f| f.name == "order_fits_spec")
            .unwrap();
        assert_eq!(spec_cov.direct_laws, vec!["order_fits_empty"]);
        assert_eq!(spec_cov.mentioned_in_rust, Some(false));

        let fits_cov = report
            .functions
            .iter()
            .find(|f| f.name == "order_fits")
            .unwrap();
        assert!(fits_cov.direct_laws.is_empty());
        assert!(fits_cov.cone_laws.is_empty());
        assert_eq!(fits_cov.mentioned_in_rust, Some(true));

        let lines = format_coverage_report(&report);
        assert!(lines
            .iter()
            .any(|l| l.contains("uncovered functions]: order_fits, round_up")));
        assert!(lines
            .iter()
            .any(|l| l.contains("[law order_fits_empty]: names only functions not mentioned in Rust sources: order_fits_spec")));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn coverage_tracks_transitive_cones_bridging_laws_and_exs_laws() {
        let root = tmp_crate("cones_and_bridge");
        fs::write(
            root.join("verified/core.bend"),
            r#"import Base

def helper_inner(+x: Nat) -> Nat:
  Nat.add(x, 1n)

def outer(+x: Nat) -> Nat:
  helper_inner(x)

def outer_spec(+x: Nat) -> Nat:
  Nat.add(1n, x)

def orphan(+x: Nat) -> Nat:
  x

# promise: outer equals outer_spec
law outer_matches_spec:
  for +x: Nat
  {outer(x) == outer_spec(x) : Nat}

# promise: some input maps to two via helper_inner
law some_two:
  exs x: Nat
  {helper_inner(x) == 2n : Nat}
"#,
        )
        .unwrap();
        fs::write(
            root.join("src/main.rs"),
            "fn main() { let _ = verified::outer(1); }\n",
        )
        .unwrap();

        let report = analyze_coverage_dir(&root.join("verified"), Some(&root)).unwrap();
        assert_eq!(report.uncovered_functions, vec!["orphan"]);
        // outer_matches_spec names both outer (mentioned) and outer_spec (unmentioned) -> NOT in laws_only_unmentioned.
        // some_two names only helper_inner, which main.rs does not call directly.
        assert_eq!(report.laws_only_unmentioned, vec!["some_two"]);

        let inner = report
            .functions
            .iter()
            .find(|f| f.name == "helper_inner")
            .unwrap();
        assert_eq!(inner.direct_laws, vec!["some_two"]);
        assert_eq!(inner.cone_laws, vec!["outer_matches_spec", "some_two"]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rust_lexer_ignores_comments_strings_lifetimes_and_distinguishes_keyword_idents() {
        let root = tmp_crate("lexer_edges");
        fs::write(
            root.join("verified/core.bend"),
            r#"import Base

def loop(+n: Nat) -> Nat:
  Nat.add(n, 1n)

def self(+n: Nat) -> Nat:
  Nat.add(n, 2n)

def a(+n: Nat) -> Nat:
  n

def hidden_in_comment(+n: Nat) -> Nat:
  n

# promise: loop adds one
law loop_ok:
  for +n: Nat
  {loop(n) == Nat.add(n, 1n) : Nat}

# promise: self adds two
law self_ok:
  for +n: Nat
  {self(n) == Nat.add(n, 2n) : Nat}

# promise: a is identity
law a_ok:
  for +n: Nat
  {a(n) == n : Nat}

# promise: hidden_in_comment is identity
law hidden_ok:
  for +n: Nat
  {hidden_in_comment(n) == n : Nat}
"#,
        )
        .unwrap();

        // Notice:
        // - `loop { break; }` and `&self` must NOT count as `r#loop` or `__rb_self`.
        // - `&'a str` must NOT count as `a`.
        // - comments, strings, raw strings, and char literals mentioning `hidden_in_comment` must be ignored.
        // - `verified::r#loop(1)` DOES mention `def loop`.
        fs::write(
            root.join("src/lib.rs"),
            r#####"
struct Holder;
impl Holder {
    fn demo<'a>(&self, _s: &'a str) {
        // hidden_in_comment
        /* nested /* hidden_in_comment */ comment */
        let _s1 = "hidden_in_comment \"escaped\"";
        let _s2 = r#"hidden_in_comment"#;
        let _c1 = '\'';
        let _c2 = '\\';
        loop {
            let _ = verified::r#loop(1);
            break;
        }
    }
}
"#####,
        )
        .unwrap();

        let report = analyze_coverage_dir(&root.join("verified"), Some(&root)).unwrap();
        let by_fn: HashMap<&str, &FunctionCoverage> = report
            .functions
            .iter()
            .map(|f| (f.name.as_str(), f))
            .collect();
        assert_eq!(by_fn["loop"].mentioned_in_rust, Some(true));
        assert_eq!(by_fn["self"].mentioned_in_rust, Some(false));
        assert_eq!(by_fn["a"].mentioned_in_rust, Some(false));
        assert_eq!(by_fn["hidden_in_comment"].mentioned_in_rust, Some(false));
        assert_eq!(
            report.laws_only_unmentioned,
            vec!["a_ok", "hidden_ok", "self_ok"]
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn coverage_separates_production_calls_from_tests_fields_and_methods() {
        let root = tmp_crate("prod_vs_test");
        fs::create_dir_all(root.join("tests")).unwrap();
        fs::write(
            root.join("verified/core.bend"),
            r#"import Base

def step(+n: Nat) -> Nat:
  Nat.add(n, 1n)

def size(+n: Nat) -> Nat:
  n

def check(+n: Nat) -> Nat:
  n

def total(+n: Nat) -> Nat:
  Nat.add(n, n)

def scaled(+n: Nat) -> Nat:
  Nat.mul(n, 2n)

def imported(+n: Nat) -> Nat:
  n

# promise: step adds one
law step_adds_one:
  for +n: Nat
  {step(n) == Nat.add(n, 1n) : Nat}

# promise: size is the identity
law size_is_id:
  for +n: Nat
  {size(n) == n : Nat}

# promise: check is the identity
law check_is_id:
  for +n: Nat
  {check(n) == n : Nat}

# promise: total doubles
law total_doubles:
  for +n: Nat
  {total(n) == Nat.add(n, n) : Nat}

# promise: scaled doubles
law scaled_doubles:
  for +n: Nat
  {scaled(n) == Nat.mul(n, 2n) : Nat}

# promise: imported is the identity
law imported_is_id:
  for +n: Nat
  {imported(n) == n : Nat}
"#,
        )
        .unwrap();
        fs::write(
            root.join("src/main.rs"),
            r#"mod verified {
    include!(concat!(env!("OUT_DIR"), "/verified.rs"));
}
use verified::imported;
struct Counter { step: u64, size: u64 }
impl Counter {
    fn check(&self) -> bool { self.step < self.size }
}
fn main() {
    let c = Counter { step: 1, size: 2 };
    let step = c.step;
    let _ = c.check();
    let _ = (step, imported);
    let f = verified::scaled;
    println!("{}", f(2));
}
#[cfg(test)]
mod tests {
    #[test]
    fn uses_total() {
        assert_eq!(super::verified::total(2), 4);
    }
}
"#,
        )
        .unwrap();
        fs::write(
            root.join("tests/it.rs"),
            "#[test]\nfn calls_size() { let _ = my_app::verified::size(3); }\n",
        )
        .unwrap();

        let report = analyze_coverage_dir(&root.join("verified"), Some(&root)).unwrap();
        let by_fn: HashMap<&str, &FunctionCoverage> = report
            .functions
            .iter()
            .map(|f| (f.name.as_str(), f))
            .collect();
        // Fields, locals, and methods with the same name do not count.
        assert_eq!(by_fn["step"].rust_use, Some(RustUse::Unused));
        assert_eq!(by_fn["check"].rust_use, Some(RustUse::Unused));
        // Calls from #[cfg(test)] and tests/ are test-only.
        assert_eq!(by_fn["total"].rust_use, Some(RustUse::TestOnly));
        assert_eq!(by_fn["size"].rust_use, Some(RustUse::TestOnly));
        assert_eq!(by_fn["total"].mentioned_in_rust, Some(false));
        // Paths and `use` imports are production references.
        assert_eq!(by_fn["scaled"].rust_use, Some(RustUse::Production));
        assert_eq!(by_fn["imported"].rust_use, Some(RustUse::Production));
        assert_eq!(
            report.laws_only_unmentioned,
            vec![
                "check_is_id",
                "size_is_id",
                "step_adds_one",
                "total_doubles"
            ]
        );
        let lines = format_coverage_report(&report);
        assert!(
            lines
                .iter()
                .any(|l| l.contains("[fn total]") && l.contains("rust=tests-only")),
            "{lines:#?}"
        );
        assert!(
            lines.iter().any(|l| l.contains("[law total_doubles]")
                && l.ends_with("(called only from tests: total)")),
            "{lines:#?}"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
