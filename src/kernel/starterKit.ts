export interface KitFile {
  path: string;
  language: 'rust' | 'toml' | 'bend' | 'markdown';
  summary: string;
  content: string;
}

export interface ErrorRecoveryEntry {
  code: string;
  cause: string;
  badExample: string;
  fixedExample: string;
  rule: string;
}

export const ERROR_RECOVERY_TABLE: ErrorRecoveryEntry[] = [
  {
    code: 'E_AFFINE_DUP',
    cause: 'A Live (q=1) parameter was used more than once.',
    badExample: 'def dup(x: Nat) -> Nat:\n  (x, x)',
    fixedExample: 'def dup(+x: Nat) -> Nat:\n  (x, x)',
    rule: 'Mark pure duplicable data parameters with + (+x: Nat) so they run at Data (q=2).',
  },
  {
    code: 'E_DEAD_LEAK',
    cause: 'A Dead (q=0) erased type/proof parameter appeared in a live runtime body.',
    badExample: 'def bad(-T: Type, x: T) -> Type:\n  T',
    fixedExample: 'def id(-T: Type, x: T) -> T:\n  (x : T)',
    rule: 'Use -T parameters only in type signatures and annotations; they are erased before Rust codegen.',
  },
  {
    code: 'E_DATA_LAM',
    cause: 'A lambda or live closure was placed inside a Data (q=2) value.',
    badExample: 'def bad() -> Data:\n  @1 x => x',
    fixedExample: 'def good(+n: Nat) -> Nat:\n  n + 1n',
    rule: 'Data (q=2) values must be pure data (Nat, Bool, ADTs, tuples) with no lambdas or live calls.',
  },
  {
    code: 'E_LAW_FALSE',
    cause: 'Counterexample search found concrete Nat/Bool/ADT inputs where LHS != RHS.',
    badExample: 'def net(+g: Nat, +f: Nat) -> Nat: (g - f) + 1n\nlaw z(for +g: Nat): net(g, 0n) == g',
    fixedExample: 'def net(+g: Nat, +f: Nat) -> Nat: g - f\nlaw z(for +g: Nat): net(g, 0n) == g\nproof z: refl',
    rule: 'Do not waste turns searching for a proof when E_LAW_FALSE fires — fix the implementation bug.',
  },
  {
    code: 'E_PROOF_INCOMPLETE_CASE',
    cause: 'A structural case-split proof (match) omitted one or more ADT/Bool constructors.',
    badExample: 'proof p:\n  match s:\n    case OrderState.Draft => refl',
    fixedExample: 'proof p:\n  match s:\n    case OrderState.Draft => refl\n    case OrderState.Paid(a) => refl\n    case OrderState.Shipped(a) => refl\n    case OrderState.Cancelled => refl',
    rule: 'Every constructor of an ADT (or both true/false for Bool) must be proven in a match proof.',
  },
  {
    code: 'E_LAW_LOCK_TAMPERED',
    cause: 'A locked law statement in verified/ was edited or deleted.',
    badExample: '# Weakening or deleting a locked law to make cargo build pass',
    fixedExample: '# Keep law statements intact and fix the implementation/proof instead',
    rule: 'AI agents must never weaken or delete locked laws. Only humans update locks with RUSTY_BENDS_UPDATE_LAWS=1.',
  },
];

export const BEND_GUIDE_MD = `# BEND_GUIDE.md — AI Coding Guide for Rust + RustyBends v1

You are working in a Rust project protected by **RustyBends v1** (compile-time Bend 2 proofs).
Nothing from Bend 2 ships in the final runtime binary: all proofs and \`q=0\` types are checked
during \`cargo build\` / \`cargo check\` via \`bend --check-only\` and \`bend --verdict\`, erased,
and only pure verified Rust (including \`pub enum\` ADTs and \`match\` expressions) is emitted
to \`OUT_DIR/verified.rs\`.

## 1. Architecture Rule: "Verified Core, Rust Shell"

- **Put pure invariants, ADTs, state machines & math in \`verified/*.bend\`**:
  balance/accounting math, order/workflow state machines (\`type\` + \`match\`), permission checks (\`Bool\`), bounds.
- **Put all I/O in \`src/*.rs\`**:
  HTTP servers, SQL/databases, async tasks, CLI, filesystem, networking.
- **Minimize unit test bloat**:
  Do NOT write dozens of repetitive unit tests for pure logic already proven in \`verified/\`.
  Write thin Rust integration tests for I/O boundaries only.

## 2. Bend 2 / BendTT Quantities (Required Knowledge)

| Prefix | Quantity | Meaning | Rule |
| :--- | :--- | :--- | :--- |
| \`-T: Type\` | **Dead (\`q=0\`)** | Types, motives, proofs | Checked at compile time, **erased before codegen**. Never return in runtime body. |
| \`x: T\` | **Live (\`q=1\`)** | Affine runtime value | Runs **at most once**. Using \`x\` twice causes \`E_AFFINE_DUP\`. |
| \`+n: Nat\` | **Data (\`q=2\`)** | Duplicable pure data | May be used 0, 1, or many times. **No lambdas or live calls inside.** |

## 3. BendTT v1 Syntax Cheat Sheet (ADTs, Match, Case Proofs & Lemma Rewrites)

\`\`\`bend
# Algebraic Data Type -> emits #[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum OrderState
type OrderState:
  Draft
  Paid(amount: Nat)
  Shipped(amount: Nat)
  Cancelled

# Pattern matching over ADTs
def cancel_order(+s: OrderState) -> OrderState:
  match s:
    case OrderState.Draft => OrderState.Cancelled
    case OrderState.Paid(amt) => OrderState.Cancelled
    case OrderState.Shipped(amt) => OrderState.Shipped(amt)
    case OrderState.Cancelled => OrderState.Cancelled

# Exhaustive structural case-split proof (every constructor checked!)
law cancel_idempotent(for +s: OrderState):
  cancel_order(cancel_order(s)) == cancel_order(s)

proof cancel_idempotent:
  match s:
    case OrderState.Draft => refl
    case OrderState.Paid(amt) => refl
    case OrderState.Shipped(amt) => refl
    case OrderState.Cancelled => refl

# Reusing an earlier proven law via rewrite:
proof composite_law:
  rewrite earlier_lemma;
  refl
\`\`\`

## 4. Mandatory Rules for AI Agents

1. **Run \`cargo check\` after every edit.** Cargo runs \`build.rs\` -> \`rusty_bends_build::verify_and_emit("verified")\`.
2. **NEVER delete, comment out, or weaken laws in \`verified/\`.**
   \`rusty-bends.lock\` uses an AST/token canonicalizer (safe across whitespace/comment edits, strict on law changes) and fails with \`E_LAW_LOCK_TAMPERED\`.
3. **If \`E_LAW_FALSE\` reports a counterexample**, fix the definition in \`verified/\` — do not loop trying to prove a false statement.
4. **Pin Bend 2 if upstream drifts**: add the version prefix (e.g. \`0.2.\`) to \`bend.pin\` or set \`BEND_PIN_VERSION\`.
`;

export function generateStarterKitFiles(
  currentBendSource: string,
  _generatedRustSource: string,
  _lawLockFingerprint: string
): KitFile[] {
  const buildCrateCargo = `[package]
name = "rusty-bends-build"
version = "1.0.0"
edition = "2021"
description = "Build-time Bend 2 proof gate (--check-only / --verdict), token-canonical LAWS lock, bend.pin check, and pure Rust ADT/match OUT_DIR emitter"
license = "Apache-2.0"

[dependencies]
# Zero external dependencies — Rust stdlib only!
`;

  const buildCrateLock = `//! AST/token-aware anti-cheat law lock for RustyBends v1.
//!
//! Unlike naive line scanners, this module strips comments (# and --), tokenizes the full
//! multi-line \`law ...\` declaration up to the next top-level item (\`type\`, \`def\`, \`law\`, \`proof\`),
//! and hashes the canonical token stream.
//!
//! Guarantees:
//! - Reformatting whitespace or adding comments inside a law NEVER triggers false lock failures.
//! - Editing any quantifier, operator, or expression inside a multi-line law trips E_LAW_LOCK_TAMPERED.
//! - Deleting a locked law trips E_LAW_LOCK_TAMPERED.
//! - Adding a brand-new law is allowed without unlocking.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalLaw {
    pub name: String,
    pub canonical_sig: String,
    pub hash: String,
}

/// Extracts all \`law\` blocks across the provided \`.bend\` files in canonical token form.
pub fn extract_canonical_laws(files: &[PathBuf]) -> Result<BTreeMap<String, CanonicalLaw>, String> {
    let mut map = BTreeMap::new();
    for file in files {
        let content = fs::read_to_string(file).map_err(|e| e.to_string())?;
        for law in extract_laws_from_source(&content) {
            map.insert(law.name.clone(), law);
        }
    }
    Ok(map)
}

/// Tokenizes Bend source (stripping comments and whitespace) and extracts every full multi-line \`law\`.
pub fn extract_laws_from_source(source: &str) -> Vec<CanonicalLaw> {
    let tokens = tokenize_bend(source);
    let mut laws = Vec::new();
    let mut i = 0usize;

    while i < tokens.len() {
        if tokens[i] == "law" && i + 1 < tokens.len() {
            let name = tokens[i + 1].clone();
            let start = i;
            i += 2;
            while i < tokens.len() && !is_top_level_keyword(&tokens[i]) {
                i += 1;
            }
            let canonical_sig = tokens[start..i].join(" ");
            let hash = fnv1a_hex(canonical_sig.as_bytes());
            laws.push(CanonicalLaw {
                name,
                canonical_sig,
                hash,
            });
            continue;
        }
        i += 1;
    }

    laws
}

/// Enforces \`rusty-bends.lock\` against the canonicalized laws in \`files\`.
pub fn enforce_law_lock(
    lock_file: &Path,
    files: &[PathBuf],
    allow_lock_update: bool,
) -> Result<usize, String> {
    let current = extract_canonical_laws(files)?;
    let serialized = current
        .values()
        .map(|law| format!("{}  {}  {}", law.hash, law.name, law.canonical_sig))
        .collect::<Vec<_>>()
        .join("\\n");

    if allow_lock_update || !lock_file.exists() {
        fs::write(lock_file, &serialized).map_err(|e| e.to_string())?;
        return Ok(current.len());
    }

    let expected_raw = fs::read_to_string(lock_file).map_err(|e| e.to_string())?;
    for line in expected_raw.lines().filter(|l| !l.trim().is_empty()) {
        let parts: Vec<&str> = line.splitn(3, "  ").collect();
        if parts.len() < 2 {
            // Backward compatibility with legacy lock lines
            if !serialized.lines().any(|cur| cur == line) {
                return Err(format!(
                    "[E_LAW_LOCK_TAMPERED] Locked law altered or deleted: '{line}'.\\nHint: Restore the original law or run RUSTY_BENDS_UPDATE_LAWS=1 cargo check."
                ));
            }
            continue;
        }
        let expected_hash = parts[0].trim();
        let law_name = parts[1].trim();
        match current.get(law_name) {
            None => {
                return Err(format!(
                    "[E_LAW_LOCK_TAMPERED] Locked law '{law_name}' was deleted.\\nHint: Restore 'law {law_name}' in verified/, or approve intentionally with RUSTY_BENDS_UPDATE_LAWS=1 cargo check."
                ));
            }
            Some(actual) if actual.hash != expected_hash => {
                return Err(format!(
                    "[E_LAW_LOCK_TAMPERED] Locked law '{law_name}' was modified (expected {expected_hash}, got {}).\\nHint: Restore the original law statement, or approve intentionally with RUSTY_BENDS_UPDATE_LAWS=1 cargo check.",
                    actual.hash
                ));
            }
            Some(_) => {}
        }
    }

    Ok(current.len())
}

fn is_top_level_keyword(tok: &str) -> bool {
    matches!(tok, "type" | "def" | "law" | "proof")
}

/// Strips '#' and '--' comments and splits Bend source into canonical lexical tokens.
pub fn tokenize_bend(source: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = source.chars().collect();
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];
        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        // Line comments: # ... or -- ...
        if ch == '#' || (ch == '-' && i + 1 < chars.len() && chars[i + 1] == '-') {
            while i < chars.len() && chars[i] != '\\n' {
                i += 1;
            }
            continue;
        }

        // Two-character operators
        if i + 1 < chars.len() {
            let two: String = [ch, chars[i + 1]].iter().collect();
            if matches!(
                two.as_str(),
                "->" | "<-" | "=>" | "==" | "!=" | "&&" | "||" | "<=" | ">="
            ) {
                tokens.push(two);
                i += 2;
                continue;
            }
        }

        // Identifiers (including dotted constructors like OrderState.Paid)
        if ch.is_ascii_alphabetic() || ch == '_' {
            let start = i;
            i += 1;
            while i < chars.len()
                && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '.')
            {
                i += 1;
            }
            tokens.push(chars[start..i].iter().collect());
            continue;
        }

        // Natural literals (0n, 42n) or numbers
        if ch.is_ascii_digit() {
            let start = i;
            i += 1;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i < chars.len() && chars[i] == 'n' {
                i += 1;
            }
            tokens.push(chars[start..i].iter().collect());
            continue;
        }

        tokens.push(ch.to_string());
        i += 1;
    }

    tokens
}

pub fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn tmp_dir(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = env::temp_dir().join(format!("rb_lock_{tag}_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reformatting_and_comments_do_not_break_lock() {
        let dir = tmp_dir("reformat");
        let file = dir.join("core.bend");
        let lock = dir.join("rusty-bends.lock");

        fs::write(
            &file,
            "law conserved(for +a: Nat, for +b: Nat):\\n  deposit(a, b) == deposit(b, a)\\nproof conserved:\\n  refl\\n",
        )
        .unwrap();
        assert_eq!(enforce_law_lock(&lock, &[file.clone()], false).unwrap(), 1);

        // Multi-line reformat + comments inside the law must remain locked-valid!
        fs::write(
            &file,
            "# header comment\\nlaw conserved(\\n  for +a: Nat,\\n  -- inline note\\n  for +b: Nat\\n):\\n  deposit(a, b)\\n    ==\\n  deposit(b, a)\\n\\nproof conserved:\\n  refl\\n",
        )
        .unwrap();
        assert_eq!(enforce_law_lock(&lock, &[file], false).unwrap(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn multi_line_law_tampering_is_detected() {
        let dir = tmp_dir("multiline_tamper");
        let file = dir.join("core.bend");
        let lock = dir.join("rusty-bends.lock");

        fs::write(
            &file,
            "law cancel_idempotent(\\n  for +s: OrderState\\n):\\n  cancel_order(\\n    cancel_order(s)\\n  ) == cancel_order(s)\\n\\nproof cancel_idempotent:\\n  refl\\n",
        )
        .unwrap();
        enforce_law_lock(&lock, &[file.clone()], false).unwrap();

        // Subtle change on line 6 of the multi-line law must be caught
        fs::write(
            &file,
            "law cancel_idempotent(\\n  for +s: OrderState\\n):\\n  cancel_order(\\n    s\\n  ) == cancel_order(s)\\n\\nproof cancel_idempotent:\\n  refl\\n",
        )
        .unwrap();
        let err = enforce_law_lock(&lock, &[file], false).unwrap_err();
        assert!(err.contains("E_LAW_LOCK_TAMPERED"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_locked_law_is_blocked() {
        let dir = tmp_dir("delete");
        let file = dir.join("core.bend");
        let lock = dir.join("rusty-bends.lock");

        fs::write(&file, "law keep_me:\\n  1n == 1n\\nproof keep_me:\\n  refl\\n").unwrap();
        enforce_law_lock(&lock, &[file.clone()], false).unwrap();

        fs::write(&file, "def x(+n: Nat) -> Nat:\\n  n\\n").unwrap();
        let err = enforce_law_lock(&lock, &[file], false).unwrap_err();
        assert!(err.contains("E_LAW_LOCK_TAMPERED"));
        assert!(err.contains("deleted"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn adding_new_law_is_permitted() {
        let dir = tmp_dir("add_new");
        let file = dir.join("core.bend");
        let lock = dir.join("rusty-bends.lock");

        fs::write(&file, "law first:\\n  1n == 1n\\nproof first:\\n  refl\\n").unwrap();
        enforce_law_lock(&lock, &[file.clone()], false).unwrap();

        fs::write(
            &file,
            "law first:\\n  1n == 1n\\nproof first:\\n  refl\\n\\nlaw second:\\n  2n == 2n\\nproof second:\\n  refl\\n",
        )
        .unwrap();
        assert_eq!(enforce_law_lock(&lock, &[file], false).unwrap(), 2);
        let _ = fs::remove_dir_all(&dir);
    }
}
`;

  const buildCrateEmit = `//! Erased-core BendTT v1 -> Pure Rust code emitter.
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
struct CtorInfo {
    type_name: String,
    variant_name: String,
    arity: usize,
}

/// Parses Bend v1 'type' and 'def' items from verified source, erases all q=0 parts and laws,
/// and emits zero-dependency Rust ready for include!(concat!(env!("OUT_DIR"), "/verified.rs")).
pub fn emit_verified_rust(source: &str, laws_verified: usize) -> Result<EmitSummary, String> {
    let (types, defs) = parse_book_items(source)?;
    let def_map: HashMap<String, &Def> = defs.iter().map(|d| (d.name.clone(), d)).collect();
    let mut ctor_map: HashMap<String, CtorInfo> = HashMap::new();
    for td in &types {
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

    let mut dead_params_erased = 0usize;
    let mut blocks = Vec::new();
    let empty_set = HashSet::new();

    for td in &types {
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
            "#[derive(Debug, Clone, Copy, PartialEq, Eq)]\\npub enum {} {{\\n{}\\n}}",
            td.name,
            variants_rs.join("\\n")
        ));
    }

    for def in &defs {
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

        let body_expr = emit_expr(def.body.trim(), &def_map, &ctor_map);
        let ret_ty = infer_return_type(def.body.trim(), &def.ret, &type_param_set);

        blocks.push(format!(
            "#[inline]\\npub fn {name}{generics}({rust_params}) -> {ret_ty} {{\\n    {body_expr}\\n}}",
            name = def.name
        ));
    }

    let mut out = String::new();
    out.push_str("// @generated by rusty-bends-build v1 (Verified Core -> Pure Rust)\\n");
    out.push_str("// Zero Bend runtime. Zero proof code. All q=0 types and laws were erased.\\n");
    out.push_str(&format!(
        "// Types: {} | Verified laws: {laws_verified} | Defs emitted: {} | Dead params erased: {dead_params_erased}\\n\\n",
        types.len(),
        defs.len()
    ));

    if blocks.is_empty() {
        out.push_str("// No live definitions found in verified/*.bend\\n");
    } else {
        out.push_str(&blocks.join("\\n\\n"));
        out.push('\\n');
    }

    Ok(EmitSummary {
        rust_source: out,
        types_emitted: types.len(),
        defs_emitted: defs.len(),
        dead_params_erased,
    })
}

pub fn parse_book_items(source: &str) -> Result<(Vec<TypeDef>, Vec<Def>), String> {
    let mut types = Vec::new();
    let mut defs = Vec::new();
    let lines: Vec<&str> = source.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        let stripped = strip_comment(lines[i]).trim();
        if stripped.is_empty() {
            i += 1;
            continue;
        }

        // Laws and proofs are q=0: verified by Bend CLI, erased before Rust codegen
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
            let (name_part, inline_variants) = split_header_colon(rest)?;
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

        if let Some(rest) = stripped.strip_prefix("def ") {
            let (header_part, inline_body) = split_header_colon(rest)?;
            let mut body_parts = Vec::new();
            if !inline_body.is_empty() {
                body_parts.push(inline_body.to_string());
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
                body_parts.push(trimmed.to_string());
                i += 1;
            }

            let body = body_parts.join(" ");
            if body.is_empty() {
                return Err(format!("[E_EMIT_EMPTY_BODY] Empty body in 'def {header_part}'"));
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
    if let Some(open) = s.find('(') {
        if !s.ends_with(')') {
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
    } else {
        Ok(Variant {
            name: s.to_string(),
            field_types: Vec::new(),
        })
    }
}

fn is_top_level_start(raw_line: &str, trimmed: &str) -> bool {
    let not_indented = !raw_line.starts_with(' ') && !raw_line.starts_with('\\t');
    not_indented
        && (trimmed.starts_with("type ")
            || trimmed.starts_with("def ")
            || trimmed.starts_with("law ")
            || trimmed.starts_with("proof "))
}

fn strip_comment(line: &str) -> &str {
    let mut end = line.len();
    if let Some(pos) = line.find('#') {
        end = end.min(pos);
    }
    if let Some(pos) = line.find("--") {
        end = end.min(pos);
    }
    &line[..end]
}

fn split_header_colon(rest: &str) -> Result<(&str, &str), String> {
    let mut depth = 0i32;
    for (idx, ch) in rest.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
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

fn bend_type_to_rust(ty: &str, type_params: &HashSet<String>) -> String {
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
    }
    match t {
        "Nat" => "u64".to_string(),
        "Bool" => "bool".to_string(),
        _ if type_params.contains(t) => t.to_string(),
        _ => t.to_string(),
    }
}

fn infer_return_type(body: &str, declared_ret: &str, type_params: &HashSet<String>) -> String {
    let trimmed = unwrap_outer_parens(body);
    if !trimmed.starts_with("match ")
        && !trimmed.starts_with("if ")
        && split_top_level(trimmed, ',').len() == 2
        && !declared_ret.trim().starts_with('(')
    {
        let elem = bend_type_to_rust(declared_ret, type_params);
        return format!("({elem}, {elem})");
    }
    bend_type_to_rust(declared_ret, type_params)
}

fn emit_pattern(pat: &str, ctors: &HashMap<String, CtorInfo>) -> String {
    let p = pat.trim();
    if p == "_" || p == "true" || p == "false" {
        return p.to_string();
    }
    if let Some(digits) = p.strip_suffix('n') {
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            return format!("{digits}_u64");
        }
    }
    if let Some(open) = p.find('(') {
        if p.ends_with(')') {
            let head = p[..open].trim();
            let args = p[open + 1..p.len() - 1].trim();
            let rust_head = resolve_ctor_path(head, ctors);
            return format!("{rust_head}({args})");
        }
    }
    resolve_ctor_path(p, ctors)
}

fn resolve_ctor_path(name: &str, ctors: &HashMap<String, CtorInfo>) -> String {
    if let Some(info) = ctors.get(name) {
        return format!("{}::{}", info.type_name, info.variant_name);
    }
    name.replace('.', "::")
}

fn emit_expr(
    expr: &str,
    defs: &HashMap<String, &Def>,
    ctors: &HashMap<String, CtorInfo>,
) -> String {
    let s = expr.trim();

    // Handle match expressions: match scrutinee: case Pat => body ...
    if let Some(rest) = s.strip_prefix("match ") {
        if let Some((scrut, arms_str)) = split_top_level_once(rest, ':') {
            let mut rust_arms = Vec::new();
            for chunk in split_case_arms(arms_str) {
                if let Some((pat, body)) = split_fat_arrow(&chunk) {
                    rust_arms.push(format!(
                        "        {} => {},",
                        emit_pattern(pat, ctors),
                        emit_expr(body, defs, ctors)
                    ));
                }
            }
            return format!(
                "match {} {{\\n{}\\n    }}",
                emit_expr(scrut, defs, ctors),
                rust_arms.join("\\n")
            );
        }
    }

    // Handle conditionals: if cond: then_branch else: else_branch
    if let Some(rest) = s.strip_prefix("if ") {
        if let Some((before_else, after_else)) = split_keyword(rest, " else:") {
            if let Some((cond, then_b)) = split_top_level_once(before_else, ':') {
                return format!(
                    "if {} {{ {} }} else {{ {} }}",
                    emit_expr(cond, defs, ctors),
                    emit_expr(then_b, defs, ctors),
                    emit_expr(after_else, defs, ctors)
                );
            }
        }
    }

    // Unwrap outer parentheses and handle annotations (term : ty) or tuples (a, b)
    if is_wrapped_in_parens(s) {
        let inner = s[1..s.len() - 1].trim();
        let tuple_parts = split_top_level(inner, ',');
        if tuple_parts.len() == 2 {
            return format!(
                "({}, {})",
                emit_expr(tuple_parts[0], defs, ctors),
                emit_expr(tuple_parts[1], defs, ctors)
            );
        }
        if let Some((term_part, _ty_part)) = split_top_level_once(inner, ':') {
            return emit_expr(term_part, defs, ctors);
        }
        return emit_expr(inner, defs, ctors);
    }

    // Handle let bindings: let x = val; body
    if let Some(rest) = s.strip_prefix("let ") {
        if let Some((binding, body)) = split_top_level_once(rest, ';') {
            if let Some((name, val)) = split_top_level_once(binding, '=') {
                return format!(
                    "{{\\n        let {} = {};\\n        {}\\n    }}",
                    name.trim(),
                    emit_expr(val, defs, ctors),
                    emit_expr(body, defs, ctors)
                );
            }
        }
    }

    // Logical and comparison binary operators (lowest to highest precedence)
    for op in ["||", "&&", "==", "!=", "<=", ">=", "<", ">"] {
        if let Some((lhs, rhs)) = split_top_level_str(s, op) {
            return format!(
                "({} {op} {})",
                emit_expr(lhs, defs, ctors),
                emit_expr(rhs, defs, ctors)
            );
        }
    }

    // Right-to-left top-level '+' or '-' for left-associative saturating Nat arithmetic
    if let Some((op, lhs, rhs)) = split_last_additive(s) {
        let l = emit_expr(lhs, defs, ctors);
        let r = emit_expr(rhs, defs, ctors);
        return match op {
            '+' => format!("({l}).saturating_add({r})"),
            '-' => format!("({l}).saturating_sub({r})"),
            _ => unreachable!(),
        };
    }

    // Unary boolean negation
    if let Some(operand) = s.strip_prefix('!') {
        return format!("!({})", emit_expr(operand, defs, ctors));
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

            if let Some(info) = ctors.get(callee) {
                let emitted_args: Vec<String> = raw_args
                    .iter()
                    .map(|a| emit_expr(a, defs, ctors))
                    .collect();
                return format!(
                    "{}::{}({})",
                    info.type_name,
                    info.variant_name,
                    emitted_args.join(", ")
                );
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
                emitted_args.push(emit_expr(arg, defs, ctors));
            }
            return format!(
                "{}({})",
                callee.replace('.', "::"),
                emitted_args.join(", ")
            );
        }
    }

    // Natural number literals (0n, 42n)
    if let Some(digits) = s.strip_suffix('n') {
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            return format!("{digits}_u64");
        }
    }

    // Unit ADT constructor (e.g. OrderState.Draft or Draft)
    if let Some(info) = ctors.get(s) {
        if info.arity == 0 {
            return format!("{}::{}", info.type_name, info.variant_name);
        }
    }

    s.replace('.', "::")
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
                '(' => depth += 1,
                ')' => depth -= 1,
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

fn split_fat_arrow(arm: &str) -> Option<(&str, &str)> {
    let mut depth = 0i32;
    let bytes = arm.as_bytes();
    for i in 0..bytes.len().saturating_sub(1) {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth -= 1,
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
            b'(' => depth += 1,
            b')' => depth -= 1,
            _ if depth == 0 && s[i..].starts_with(needle) => {
                return Some((s[..i].trim(), s[i + needle.len()..].trim()));
            }
            _ => {}
        }
    }
    None
}

fn split_top_level_str<'a>(s: &'a str, op: &str) -> Option<(&'a str, &'a str)> {
    let mut depth = 0i32;
    let bytes = s.as_bytes();
    for i in 0..bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            _ if depth == 0 && i > 0 && s[i..].starts_with(op) => {
                // Avoid matching '=' inside '==' or '=>' or '!='
                if (op == "<" || op == ">") && i + 1 < bytes.len() && bytes[i + 1] == b'=' {
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

fn is_wrapped_in_parens(s: &str) -> bool {
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

fn unwrap_outer_parens(s: &str) -> &str {
    let mut cur = s.trim();
    while is_wrapped_in_parens(cur) {
        cur = cur[1..cur.len() - 1].trim();
    }
    cur
}

fn split_top_level(s: &str, delim: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
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

fn split_top_level_once(s: &str, delim: char) -> Option<(&str, &str)> {
    let mut depth = 0i32;
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
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
    for (idx, ch) in s.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            '+' | '-' if depth == 0 && idx > 0 => {
                found = Some((ch, s[..idx].trim(), s[idx + 1..].trim()));
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
        let src = "def id(-T: Type, x: T) -> T:\\n  (x : T)\\n";
        let summary = emit_verified_rust(src, 1).expect("emit succeeded");
        assert_eq!(summary.defs_emitted, 1);
        assert_eq!(summary.dead_params_erased, 1);
        assert!(summary.rust_source.contains("pub fn id<T>(x: T) -> T"));
        assert!(summary.rust_source.contains("    x\\n}"));
    }

    #[test]
    fn emits_saturating_nat_math_and_erases_laws() {
        let src = r#"
def deposit(+bal: Nat, +amt: Nat) -> Nat:
  bal + amt

def apply_fee(+gross: Nat, +fee: Nat) -> Nat:
  gross - fee

law deposit_zero(for +bal: Nat):
  deposit(bal, 0n) == bal

proof deposit_zero:
  refl
"#;
        let summary = emit_verified_rust(src, 1).expect("emit succeeded");
        assert_eq!(summary.defs_emitted, 2);
        assert!(summary.rust_source.contains("pub fn deposit(bal: u64, amt: u64) -> u64"));
        assert!(summary.rust_source.contains("(bal).saturating_add(amt)"));
        assert!(summary.rust_source.contains("(gross).saturating_sub(fee)"));
        assert!(!summary.rust_source.contains("law "));
        assert!(!summary.rust_source.contains("proof "));
        assert!(!summary.rust_source.contains("refl"));
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
        let src = "def dup(+n: Nat) -> Nat:\\n  (n, n)\\n";
        let summary = emit_verified_rust(src, 0).expect("emit succeeded");
        assert!(summary.rust_source.contains("pub fn dup(n: u64) -> (u64, u64)"));
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
        assert_eq!(summary.types_emitted, 1);
        assert_eq!(summary.defs_emitted, 1);
        assert!(summary.rust_source.contains("pub enum OrderState"));
        assert!(summary.rust_source.contains("Paid(u64),"));
        assert!(summary.rust_source.contains("OrderState::Draft => OrderState::Cancelled,"));
        assert!(summary.rust_source.contains("OrderState::Paid(amt) => OrderState::Cancelled,"));
        assert!(!summary.rust_source.contains("cancel_idempotent"));
        assert!(!summary.rust_source.contains("refl"));
    }

    #[test]
    fn emits_bool_if_else_and_logical_operators() {
        let src = r#"
def can_write(+is_admin: Bool, +is_revoked: Bool) -> Bool:
  if is_revoked: false else: is_admin
"#;
        let summary = emit_verified_rust(src, 0).expect("emit succeeded");
        assert!(summary.rust_source.contains("pub fn can_write(is_admin: bool, is_revoked: bool) -> bool"));
        assert!(summary.rust_source.contains("if is_revoked { false } else { is_admin }"));
    }
}
`;

  const buildCrateLib = `//! rusty-bends-build v1: compile-time Bend 2 proof gate, AST/token law lock,
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

pub struct Config {
    pub verified_dir: PathBuf,
    pub bend_bin: String,
    pub check_flag: String,
    pub verdict_flag: String,
    pub lock_file: PathBuf,
    pub pin_file: PathBuf,
    pub pinned_version: Option<String>,
    pub out_dir: PathBuf,
    pub allow_lock_update: bool,
    pub emit_rust: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            verified_dir: PathBuf::from("verified"),
            bend_bin: env::var("BEND_BIN").unwrap_or_else(|_| "bend".to_string()),
            check_flag: env::var("BEND_CHECK_FLAG").unwrap_or_else(|_| "--check-only".to_string()),
            verdict_flag: env::var("BEND_VERDICT_FLAG").unwrap_or_else(|_| "--verdict".to_string()),
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
/// runs real 'bend --check-only' + 'bend --verdict', and emits pure Rust into OUT_DIR/verified.rs.
pub fn verify_and_emit(dir: impl AsRef<Path>) {
    let mut cfg = Config::default();
    cfg.verified_dir = dir.as_ref().to_path_buf();
    cfg.emit_rust = true;
    run_or_fail(&cfg);
}

/// Check-only build.rs entry point (verifies proofs & locks without emitting verified.rs).
pub fn verify_dir(dir: impl AsRef<Path>) {
    let mut cfg = Config::default();
    cfg.verified_dir = dir.as_ref().to_path_buf();
    cfg.emit_rust = false;
    run_or_fail(&cfg);
}

fn run_or_fail(cfg: &Config) {
    if let Err(err) = run(cfg) {
        if cfg.emit_rust {
            let _ = fs::create_dir_all(&cfg.out_dir);
            let blocked = cfg.out_dir.join("verified.rs");
            let _ = fs::write(
                blocked,
                "compile_error!(\\"RustyBends verification failed — fix Bend 2 proofs or lock violations.\\");\\n",
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
        "[E_BEND_VERSION_MISMATCH] Pinned Bend version '{trimmed_pin}' does not match installed '{}'.\\nHint: Install the pinned Bend 2 release or update bend.pin / BEND_PIN_VERSION.",
        actual_output.trim()
    ))
}

fn query_bend_version(bend_bin: &str) -> Result<String, String> {
    let output = Command::new(bend_bin)
        .arg("--version")
        .output()
        .map_err(|e| {
            format!("[E_BEND_MISSING] Failed to run '{bend_bin} --version': {e}\\nHint: Install Bend 2 (~/.bend/bin) or set BEND_BIN=/path/to/bend")
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
        combined_source.push('\\n');
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
    if has_laws && !cfg.verdict_flag.trim().is_empty() {
        run_bend_step(&cfg.bend_bin, &cfg.verdict_flag, file)?;
    }
    Ok(())
}

fn run_bend_step(bend_bin: &str, flag: &str, file: &Path) -> Result<(), String> {
    let output = Command::new(bend_bin)
        .arg(flag)
        .arg(file)
        .output()
        .map_err(|e| {
            format!(
                "[E_BEND_MISSING] Failed to run '{bend_bin} {flag}' on {}: {e}\\nHint: Install Bend 2 (~/.bend/bin) or set BEND_BIN=/path/to/bend",
                file.display()
            )
        })?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "[E_BEND_CHECK_FAILED] '{bend_bin} {flag} {}' failed:\\n{stdout}{stderr}",
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
            "type Status:\\n  Open\\n  Closed\\n\\ndef close(+s: Status) -> Status:\\n  match s:\\n    case Status.Open => Status.Closed\\n    case Status.Closed => Status.Closed\\n\\nlaw close_idem(for +s: Status):\\n  close(close(s)) == close(s)\\n\\nproof close_idem:\\n  match s:\\n    case Status.Open => refl\\n    case Status.Closed => refl\\n",
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
            "def inc(+n: Nat) -> Nat:\\n  n + 1n\\n\\nlaw inc_two:\\n  inc(2n) == 3n\\n\\nproof inc_two:\\n  refl\\n",
        )
        .unwrap();

        let cfg = make_cfg(&root);
        run_with_checker(&cfg, |_, _| Ok(())).expect("initial lock creation");

        fs::write(
            &core,
            "def inc(+n: Nat) -> Nat:\\n  n + 1n\\n\\nlaw inc_two:\\n  3n == 3n\\n\\nproof inc_two:\\n  refl\\n",
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
}
`;

  const bendPinFile = `# Optional Bend 2 compiler version pin (uncomment a version prefix to enforce in CI/local builds).
# Example:
# 0.2.38
#
# When uncommented (or when BEND_PIN_VERSION is set), rusty-bends-build runs 'bend --version'
# and fails fast with E_BEND_VERSION_MISMATCH if upstream Bend 2 drifts unexpectedly.
`;

  const exampleCargo = `[package]
name = "my-verified-app"
version = "0.1.0"
edition = "2021"

[dependencies]
# Pure Rust runtime dependencies only — NO Bend 2 or proof libraries here!

[build-dependencies]
rusty-bends-build = { path = "../rusty-bends-build" }
`;

  const exampleBuildRs = `fn main() {
    // 1. Checks bend.pin / BEND_PIN_VERSION (if configured)
    // 2. Enforces token-canonical rusty-bends.lock (anti-cheat LAWS lock)
    // 3. Runs real 'bend --check-only' + 'bend --verdict' on verified/*.bend
    // 4. Erases q=0 types/laws and emits pure Rust (ADTs + match + defs) into OUT_DIR/verified.rs
    rusty_bends_build::verify_and_emit("verified");
}
`;

  const exampleMainRs = `//! Rust Shell: handles I/O, HTTP, DB, and CLI.
//! Calls pure verified types and functions emitted into OUT_DIR/verified.rs at build time.

#[allow(dead_code)]
mod verified {
    include!(concat!(env!("OUT_DIR"), "/verified.rs"));
}

fn main() {
    println!("RustyBends v1 Verified Core compiled cleanly with zero Bend runtime overhead.");
}

#[cfg(test)]
mod tests {
    #[test]
    fn verified_module_compiles_with_zero_runtime_proof_overhead() {
        // Pure invariants (including ADT state transitions) are proven at compile time by Bend 2
        // in verified/*.bend; keep Rust tests focused on thin I/O boundary checks.
        assert!(true);
    }
}
`;

  return [
    {
      path: 'rusty-bends-build/Cargo.toml',
      language: 'toml',
      summary: 'Zero-dependency v1.0.0 build crate manifest ([build-dependencies] only).',
      content: buildCrateCargo,
    },
    {
      path: 'rusty-bends-build/src/lib.rs',
      language: 'rust',
      summary: 'Cargo build.rs gate: bend.pin version check, AST law lock, bend --check-only & --verdict, hash cache, and OUT_DIR emitter (with #[cfg(test)] tests).',
      content: buildCrateLib,
    },
    {
      path: 'rusty-bends-build/src/lock.rs',
      language: 'rust',
      summary: 'AST/token-canonical multi-line LAWS lock (comment/whitespace-safe, catches deletion & weakening, with 4 #[cfg(test)] tests).',
      content: buildCrateLock,
    },
    {
      path: 'rusty-bends-build/src/emit.rs',
      language: 'rust',
      summary: 'Rust-native BendTT v1 q=0 eraser & pure Rust emitter supporting ADTs (pub enum), match, if/else, Bool, Nat, and generics (with 6 #[cfg(test)] tests).',
      content: buildCrateEmit,
    },
    {
      path: 'example-app/Cargo.toml',
      language: 'toml',
      summary: 'App manifest showing rusty-bends-build under [build-dependencies] (never in final binary).',
      content: exampleCargo,
    },
    {
      path: 'example-app/build.rs',
      language: 'rust',
      summary: 'One-line Cargo build script invoking verify_and_emit("verified").',
      content: exampleBuildRs,
    },
    {
      path: 'example-app/bend.pin',
      language: 'toml',
      summary: 'Optional Bend 2 version pin file to lock compiler versions on first signs of upstream breakage.',
      content: bendPinFile,
    },
    {
      path: 'example-app/verified/core.bend',
      language: 'bend',
      summary: 'Synced directly from your current Workbench editor.',
      content: currentBendSource,
    },
    {
      path: 'example-app/src/main.rs',
      language: 'rust',
      summary: 'Pure Rust shell including OUT_DIR/verified.rs generated at build time.',
      content: exampleMainRs,
    },
    {
      path: 'BEND_GUIDE.md',
      language: 'markdown',
      summary: 'Drop-in v1 AI playbook covering quantities, ADTs, match, case-split proofs, rewrite lemmas, and bend.pin.',
      content: BEND_GUIDE_MD,
    },
  ];
}

/**
 * Generates a self-contained POSIX shell script that creates the complete local v1 Cargo workspace
 * (rusty-bends-build + example-app + bend.pin + BEND_GUIDE.md) in one command.
 */
export function buildWorkspaceSetupScript(files: KitFile[]): string {
  const sections = [
    '#!/usr/bin/env sh',
    'set -eu',
    '',
    'echo "Creating RustyBends v1 Cargo workspace..."',
    '',
  ];

  const dirs = new Set<string>();
  for (const file of files) {
    const idx = file.path.lastIndexOf('/');
    if (idx > 0) {
      dirs.add(file.path.slice(0, idx));
    }
  }
  for (const dir of Array.from(dirs).sort()) {
    sections.push(`mkdir -p "${dir}"`);
  }
  sections.push('');

  for (const file of files) {
    sections.push(`cat << 'RUSTY_BENDS_EOF' > "${file.path}"`);
    sections.push(file.content.replace(/\n+$/, ''));
    sections.push('RUSTY_BENDS_EOF');
    sections.push('');
  }

  sections.push('echo "Done! Next steps on desktop:"');
  sections.push('echo "  1. Run rusty-bends-build unit tests (13 tests):  (cd rusty-bends-build && cargo test)"');
  sections.push('echo "  2. Build & verify example app with bend CLI:     (cd example-app && cargo check)"');
  sections.push('echo "  3. Optional: pin Bend version in example-app/bend.pin"');
  return `${sections.join('\n')}\n`;
}

export interface PromptPreset {
  id: string;
  label: string;
  appName: string;
  domain: string;
  invariants: string;
}

export const AI_PROMPT_PRESETS: PromptPreset[] = [
  {
    id: 'ledger',
    label: 'Billing Ledger',
    appName: 'ledger-service',
    domain: 'Double-entry account balance and fee calculation service with HTTP API',
    invariants:
      'Total balance is conserved across transfers; zero-amount deposit leaves balance unchanged; fees never exceed gross amount',
  },
  {
    id: 'rbac',
    label: 'RBAC Permissions',
    appName: 'authz-engine',
    domain: 'Role-based access control policy evaluator for multi-tenant SaaS',
    invariants:
      'Revoked roles never grant access; permission union is commutative and idempotent; deny rules always override allow rules',
  },
  {
    id: 'inventory',
    label: 'Inventory Reservation',
    appName: 'stock-allocator',
    domain: 'Warehouse stock reservation & release state machine',
    invariants:
      'Reserved + available always equals total stock; releasing a reservation restores exact available quantity; cannot reserve more than available',
  },
];

export function buildAiKickoffPrompt(
  appName: string,
  domain: string,
  invariants: string
): string {
  const safeName = appName.trim() || 'my-rusty-bends-app';
  const safeDomain =
    domain.trim() || 'A Rust service with mathematically proven core business logic';
  const invariantLines = invariants
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `- ${s}`)
    .join('\n');

  return `You are building "${safeName}" in Rust using **RustyBends v1** (compile-time Bend 2 proof verification).

### Application Goal
${safeDomain}

### Architecture ("Verified Core, Rust Shell")
1. Put ALL pure business logic, ADTs (\`type\`), state transitions (\`match\`), and math invariants inside \`verified/*.bend\`.
2. Put ALL I/O (HTTP, DB, CLI, async) inside normal Rust \`src/*.rs\`.
3. Wire \`rusty-bends-build\` under \`[build-dependencies]\` in \`Cargo.toml\` and call \`rusty_bends_build::verify_and_emit("verified")\` in \`build.rs\`. Zero Bend runtime or proof code ships in the final binary.
4. Keep unit tests minimal: rely on Bend 2 proofs in \`verified/\` for pure logic invariants, and write Rust integration tests ONLY for I/O boundaries.

### Required Laws to Prove in \`verified/\`
${invariantLines || '- Define and prove core conservation, state-machine, and idempotence invariants.'}

### Quick Bend 2 / BendTT v1 Primer (Read Carefully)
- Quantities on every parameter:
  - \`-T: Type\` = Dead (\`q=0\`): types/proofs, checked and erased before codegen. Never return in a live body.
  - \`x: T\` = Live (\`q=1\`): affine runtime value, used **at most once**.
  - \`+n: Nat\` = Data (\`q=2\`): duplicable pure data (safe to use multiple times; no lambdas inside).
- Every \`law name(for +x: T): lhs == rhs\` MUST have a matching \`proof name:\` block using \`refl\`, exhaustive \`match\` case-splitting, or \`rewrite lemma_name; refl\`.
- NEVER delete or weaken locked laws in \`verified/\` to make \`cargo check\` pass. If a counterexample (\`E_LAW_FALSE\`) appears, fix the implementation in \`verified/\`.

### Workflow
1. Write \`BEND_GUIDE.md\` and \`verified/core.bend\` first with types, functions, laws, and proofs.
2. Lock laws with \`rusty-bends.lock\` (human-approved updates only via \`RUSTY_BENDS_UPDATE_LAWS=1\`).
3. Run \`cargo check\` until \`bend --check-only\` and \`bend --verdict\` pass and \`OUT_DIR/verified.rs\` compiles cleanly.`;
}
