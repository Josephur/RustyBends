//! AST/token-aware anti-cheat law lock for RustyBends v1.
//!
//! Unlike naive line scanners, this module strips comments (# and --), tokenizes the full
//! multi-line `law ...` declaration up to the next top-level item (`type`, `def`, `law`, `proof`),
//! and hashes the canonical token stream.
//!
//! Guarantees:
//! - Reformatting whitespace or adding comments inside a law NEVER triggers false lock failures.
//! - Editing any quantifier, operator, or expression inside a multi-line law trips E_LAW_LOCK_TAMPERED.
//! - Deleting a locked law trips E_LAW_LOCK_TAMPERED.
//! - Adding a brand-new law is allowed without unlocking.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalLaw {
    pub name: String,
    pub canonical_sig: String,
    pub hash: String,
    pub promise: Option<String>,
    pub harm: Option<String>,
    /// `# unchecked: <reason>` marker: the author accepts that the mutation checker cannot
    /// evaluate this law (Issue #14). Stored in the lock next to the promise for reviewers.
    pub unchecked: Option<String>,
}

/// Plain-English doc fields read from the comment block directly above a `law`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LawDocs {
    pub promise: Option<String>,
    pub harm: Option<String>,
    pub unchecked: Option<String>,
}

/// Extracts all `law` blocks across the provided `.bend` files in canonical token form.
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

fn normalize_alias_token<'a>(tok: &'a str, aliases: &BTreeSet<String>) -> &'a str {
    if !aliases.is_empty() {
        if let Some((prefix, rest)) = tok.split_once('.') {
            if aliases.contains(prefix) && !rest.is_empty() {
                return rest;
            }
        }
    }
    tok
}

/// Tokenizes Bend source (stripping comments and whitespace) and extracts every full multi-line `law`.
pub fn extract_laws_from_source(source: &str) -> Vec<CanonicalLaw> {
    let docs = extract_law_doc_comments(source);
    let aliases: BTreeSet<String> = crate::emit::parse_import_aliases(source)
        .into_iter()
        .collect();
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
            let canonical_sig = tokens[start..i]
                .iter()
                .map(|tok| normalize_alias_token(tok, &aliases))
                .collect::<Vec<_>>()
                .join(" ");
            let hash = fnv1a_hex(canonical_sig.as_bytes());
            let LawDocs {
                promise,
                harm,
                unchecked,
            } = docs.get(&name).cloned().unwrap_or_default();
            laws.push(CanonicalLaw {
                name,
                canonical_sig,
                hash,
                promise,
                harm,
                unchecked,
            });
            continue;
        }
        i += 1;
    }

    laws
}

fn normalize_doc_ws(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn append_doc_field(slot: &mut Option<String>, raw: &str) {
    let normalized = normalize_doc_ws(raw);
    if normalized.is_empty() {
        return;
    }
    match slot {
        Some(existing) => {
            existing.push(' ');
            existing.push_str(&normalized);
        }
        None => *slot = Some(normalized),
    }
}

/// Extracts `# promise:`, `# harm:`, and `# unchecked:` lines from the contiguous comment block
/// immediately above each top-level `law <name>` declaration. Blank or non-comment lines break
/// the block.
pub fn extract_law_doc_comments(source: &str) -> BTreeMap<String, LawDocs> {
    let mut docs = BTreeMap::new();
    let lines: Vec<&str> = source.lines().collect();

    for (idx, line) in lines.iter().enumerate() {
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let Some(after_kw) = line.strip_prefix("law") else {
            continue;
        };
        if !after_kw
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_whitespace())
        {
            continue;
        }
        let name = after_kw
            .trim_start()
            .split(|c: char| c.is_ascii_whitespace() || c == ':' || c == '(')
            .next()
            .unwrap_or("")
            .trim();
        if name.is_empty() {
            continue;
        }

        let mut start = idx;
        while start > 0 {
            let prev = lines[start - 1].trim();
            if prev.is_empty() || !(prev.starts_with('#') || prev.starts_with("--")) {
                break;
            }
            start -= 1;
        }

        let mut promise: Option<String> = None;
        let mut harm: Option<String> = None;
        let mut unchecked: Option<String> = None;
        for &comment_line in &lines[start..idx] {
            let trimmed = comment_line.trim();
            let body = if let Some(rest) = trimmed.strip_prefix('#') {
                rest.trim()
            } else if let Some(rest) = trimmed.strip_prefix("--") {
                rest.trim()
            } else {
                continue;
            };
            if body
                .get(..8)
                .is_some_and(|p| p.eq_ignore_ascii_case("promise:"))
            {
                append_doc_field(&mut promise, &body[8..]);
            } else if body
                .get(..5)
                .is_some_and(|p| p.eq_ignore_ascii_case("harm:"))
            {
                append_doc_field(&mut harm, &body[5..]);
            } else if body
                .get(..10)
                .is_some_and(|p| p.eq_ignore_ascii_case("unchecked:"))
            {
                append_doc_field(&mut unchecked, &body[10..]);
            }
        }

        docs.insert(
            name.to_string(),
            LawDocs {
                promise,
                harm,
                unchecked,
            },
        );
    }

    docs
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum LockUpdateMode {
    #[default]
    None,
    /// `RUSTY_BENDS_UPDATE_LAWS=1`: rewrite the entire lock from current sources.
    All,
    /// `RUSTY_BENDS_UPDATE_LAWS=comments`: refresh `# promise` / `# harm` / `# unchecked`
    /// comment lines of already-locked laws whose statement hash is unchanged.
    CommentsOnly,
    /// `RUSTY_BENDS_UPDATE_LAWS=<name>[,<name>...]`: seal, re-accept, or remove only
    /// the named laws, leaving every other locked or new law untouched.
    Named(BTreeSet<String>),
}

impl LockUpdateMode {
    pub fn parse(raw: &str) -> Self {
        let trimmed = raw.trim();
        let lower = trimmed.to_ascii_lowercase();
        if trimmed.is_empty() || matches!(lower.as_str(), "0" | "false" | "no" | "off") {
            return Self::None;
        }
        if trimmed == "1" {
            return Self::All;
        }
        if lower == "comments" {
            return Self::CommentsOnly;
        }
        let names: BTreeSet<String> = trimmed
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .collect();
        if names.is_empty() {
            Self::None
        } else {
            Self::Named(names)
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LockUpdateSummary {
    pub sealed: Vec<String>,
    pub reaccepted: Vec<(String, String, String)>,
    pub removed: Vec<String>,
    pub comments_updated: Vec<(String, Vec<String>)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockCheckReport {
    pub current: BTreeMap<String, CanonicalLaw>,
    pub locked_names: BTreeSet<String>,
    pub new_names: BTreeSet<String>,
    pub serialized: String,
    pub needs_write: bool,
    pub warnings: Vec<String>,
    pub update_summary: LockUpdateSummary,
}

pub fn format_lock_update_notes(summary: &LockUpdateSummary) -> Vec<String> {
    let mut notes = Vec::new();
    for name in &summary.sealed {
        notes.push(format!("RustyBends lock: sealed law '{name}'"));
    }
    for (name, old_hash, new_hash) in &summary.reaccepted {
        notes.push(format!(
            "RustyBends lock: RE-ACCEPTED changed law '{name}' ({old_hash} -> {new_hash})"
        ));
    }
    for name in &summary.removed {
        notes.push(format!("RustyBends lock: removed deleted law '{name}'"));
    }
    for (name, fields) in &summary.comments_updated {
        notes.push(format!(
            "RustyBends lock: updated {} comment(s) for '{name}'",
            fields.join(", ")
        ));
    }
    notes
}

fn serialize_lock_entries(current: &BTreeMap<String, CanonicalLaw>) -> String {
    let mut lines = Vec::new();
    for law in current.values() {
        if law.canonical_sig.is_empty() {
            lines.push(format!("{}  {}", law.hash, law.name));
        } else {
            lines.push(format!("{}  {}  {}", law.hash, law.name, law.canonical_sig));
        }
        if let Some(ref p) = law.promise {
            lines.push(format!("# promise {}: {p}", law.name));
        }
        if let Some(ref h) = law.harm {
            lines.push(format!("# harm {}: {h}", law.name));
        }
        if let Some(ref u) = law.unchecked {
            lines.push(format!("# unchecked {}: {u}", law.name));
        }
    }
    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

fn parse_lock_comment_line(trimmed: &str) -> Option<(&'static str, &str, String)> {
    for (field, prefix) in [
        ("promise", "# promise "),
        ("harm", "# harm "),
        ("unchecked", "# unchecked "),
    ] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            if let Some((law_name, text)) = rest.split_once(':') {
                let name = law_name.trim();
                let normalized = normalize_doc_ws(text);
                if !name.is_empty() && !normalized.is_empty() {
                    return Some((field, name, normalized));
                }
            }
            return None;
        }
    }
    None
}

fn parse_existing_lock(expected_raw: &str) -> (BTreeMap<String, CanonicalLaw>, Vec<String>) {
    let mut entries: BTreeMap<String, CanonicalLaw> = BTreeMap::new();
    let mut promises: BTreeMap<String, String> = BTreeMap::new();
    let mut harms: BTreeMap<String, String> = BTreeMap::new();
    let mut unchecked_map: BTreeMap<String, String> = BTreeMap::new();
    let mut malformed = Vec::new();

    for line in expected_raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('#') {
            if let Some((field, name, normalized)) = parse_lock_comment_line(trimmed) {
                match field {
                    "promise" => {
                        promises.insert(name.to_string(), normalized);
                    }
                    "harm" => {
                        harms.insert(name.to_string(), normalized);
                    }
                    "unchecked" => {
                        unchecked_map.insert(name.to_string(), normalized);
                    }
                    _ => {}
                }
            }
            continue;
        }
        let parts: Vec<&str> = trimmed.splitn(3, "  ").collect();
        if parts.len() < 2 {
            malformed.push(trimmed.to_string());
            continue;
        }
        let hash = parts[0].trim().to_string();
        let name = parts[1].trim().to_string();
        let sig = parts.get(2).copied().unwrap_or("").trim().to_string();
        entries.insert(
            name.clone(),
            CanonicalLaw {
                name,
                canonical_sig: sig,
                hash,
                promise: None,
                harm: None,
                unchecked: None,
            },
        );
    }

    for (name, entry) in &mut entries {
        entry.promise = promises.remove(name);
        entry.harm = harms.remove(name);
        entry.unchecked = unchecked_map.remove(name);
    }

    (entries, malformed)
}

fn diff_comment_fields(old: &CanonicalLaw, new: &CanonicalLaw) -> Vec<String> {
    let mut changed = Vec::new();
    if old.promise != new.promise {
        changed.push("promise".to_string());
    }
    if old.harm != new.harm {
        changed.push("harm".to_string());
    }
    if old.unchecked != new.unchecked {
        changed.push("unchecked".to_string());
    }
    changed
}

/// Formats a sorted `name: promise` listing suitable for PR descriptions and build output.
/// Laws carrying an `# unchecked:` marker get a trailing `[unchecked: <reason>]` tag.
pub fn format_law_list(laws: &BTreeMap<String, CanonicalLaw>) -> String {
    laws.values()
        .map(|law| {
            let base = match &law.promise {
                Some(p) => format!("{}: {p}", law.name),
                None => format!("{}: (no promise)", law.name),
            };
            match &law.unchecked {
                Some(u) => format!("{base} [unchecked: {u}]"),
                None => base,
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Checks `rusty-bends.lock` against the canonicalized laws in `files` without modifying the lock file.
pub fn check_law_lock(
    lock_file: &Path,
    files: &[PathBuf],
    allow_lock_update: bool,
) -> Result<LockCheckReport, String> {
    let mode = if allow_lock_update {
        LockUpdateMode::All
    } else {
        LockUpdateMode::None
    };
    check_law_lock_with_mode(lock_file, files, &mode)
}

/// Checks `rusty-bends.lock` under `mode` (`None`, `All`, `CommentsOnly`, or `Named`).
pub fn check_law_lock_with_mode(
    lock_file: &Path,
    files: &[PathBuf],
    mode: &LockUpdateMode,
) -> Result<LockCheckReport, String> {
    let current = extract_canonical_laws(files)?;
    let all_serialized = serialize_lock_entries(&current);

    let mut locked_names = BTreeSet::new();
    let mut new_names = BTreeSet::new();
    let mut locked_promises: BTreeMap<String, String> = BTreeMap::new();
    let mut update_summary = LockUpdateSummary::default();
    let serialized;
    let needs_write;

    if lock_file.exists() {
        let expected_raw = fs::read_to_string(lock_file).map_err(|e| e.to_string())?;
        let (existing, malformed) = parse_existing_lock(&expected_raw);

        for trimmed in &malformed {
            if *mode != LockUpdateMode::All && !all_serialized.lines().any(|cur| cur == trimmed) {
                return Err(format!(
                    "[E_LAW_LOCK_TAMPERED] Locked law altered or deleted: '{trimmed}'.\nHint: Restore the original law or run RUSTY_BENDS_UPDATE_LAWS=1 cargo check."
                ));
            }
        }

        if let LockUpdateMode::Named(targets) = mode {
            for target in targets {
                if !current.contains_key(target) && !existing.contains_key(target) {
                    return Err(format!(
                        "[E_LAW_NOT_FOUND] RUSTY_BENDS_UPDATE_LAWS named unknown law '{target}', which is not in verified/ or {}.",
                        lock_file.display()
                    ));
                }
            }
        }

        for (law_name, old_entry) in &existing {
            if let Some(ref p) = old_entry.promise {
                locked_promises.insert(law_name.clone(), p.clone());
            }
            let allowed_to_change = match mode {
                LockUpdateMode::All => true,
                LockUpdateMode::Named(targets) => targets.contains(law_name),
                LockUpdateMode::None | LockUpdateMode::CommentsOnly => false,
            };
            if !allowed_to_change {
                match current.get(law_name) {
                    None => {
                        return Err(format!(
                            "[E_LAW_LOCK_TAMPERED] Locked law '{law_name}' was deleted.\nHint: Restore 'law {law_name}' in verified/, or approve intentionally with RUSTY_BENDS_UPDATE_LAWS={law_name} cargo check (or RUSTY_BENDS_UPDATE_LAWS=1)."
                        ));
                    }
                    Some(actual) if actual.hash != old_entry.hash => {
                        return Err(format!(
                            "[E_LAW_LOCK_TAMPERED] Locked law '{law_name}' was modified (expected {}, got {}).\nHint: Restore the original law statement, or approve intentionally with RUSTY_BENDS_UPDATE_LAWS={law_name} cargo check (or RUSTY_BENDS_UPDATE_LAWS=1).",
                            old_entry.hash, actual.hash
                        ));
                    }
                    Some(_) => {}
                }
            }
        }

        for (name, law) in &current {
            if existing.get(name).is_some_and(|e| e.hash == law.hash) {
                locked_names.insert(name.clone());
            } else {
                new_names.insert(name.clone());
            }
        }

        match mode {
            LockUpdateMode::None => {
                serialized = all_serialized;
                needs_write = false;
            }
            LockUpdateMode::All => {
                for name in existing.keys() {
                    if !current.contains_key(name) {
                        update_summary.removed.push(name.clone());
                    }
                }
                for (name, cur) in &current {
                    match existing.get(name) {
                        None => update_summary.sealed.push(name.clone()),
                        Some(old) if old.hash != cur.hash => {
                            update_summary.reaccepted.push((
                                name.clone(),
                                old.hash.clone(),
                                cur.hash.clone(),
                            ));
                        }
                        Some(old) => {
                            let fields = diff_comment_fields(old, cur);
                            if !fields.is_empty() {
                                update_summary.comments_updated.push((name.clone(), fields));
                            }
                        }
                    }
                }
                serialized = all_serialized;
                needs_write = serialized != expected_raw;
            }
            LockUpdateMode::CommentsOnly => {
                let mut next_lock = existing;
                for (name, entry) in &mut next_lock {
                    if let Some(cur) = current.get(name) {
                        let fields = diff_comment_fields(entry, cur);
                        if !fields.is_empty() {
                            entry.promise = cur.promise.clone();
                            entry.harm = cur.harm.clone();
                            entry.unchecked = cur.unchecked.clone();
                            update_summary.comments_updated.push((name.clone(), fields));
                        }
                    }
                }
                serialized = serialize_lock_entries(&next_lock);
                needs_write = serialized != expected_raw;
            }
            LockUpdateMode::Named(targets) => {
                let mut next_lock = existing.clone();
                for target in targets {
                    match (existing.get(target), current.get(target)) {
                        (None, Some(cur)) => {
                            next_lock.insert(target.clone(), cur.clone());
                            update_summary.sealed.push(target.clone());
                        }
                        (Some(old), Some(cur)) => {
                            if old.hash != cur.hash {
                                update_summary.reaccepted.push((
                                    target.clone(),
                                    old.hash.clone(),
                                    cur.hash.clone(),
                                ));
                            } else {
                                let fields = diff_comment_fields(old, cur);
                                if !fields.is_empty() {
                                    update_summary
                                        .comments_updated
                                        .push((target.clone(), fields));
                                }
                            }
                            next_lock.insert(target.clone(), cur.clone());
                        }
                        (Some(_), None) => {
                            next_lock.remove(target);
                            update_summary.removed.push(target.clone());
                        }
                        (None, None) => {}
                    }
                }
                serialized = serialize_lock_entries(&next_lock);
                needs_write = serialized != expected_raw;
            }
        }
    } else {
        for name in current.keys() {
            new_names.insert(name.clone());
        }
        match mode {
            LockUpdateMode::None | LockUpdateMode::All => {
                update_summary.sealed = current.keys().cloned().collect();
                serialized = all_serialized;
                needs_write = true;
            }
            LockUpdateMode::CommentsOnly => {
                serialized = String::new();
                needs_write = false;
            }
            LockUpdateMode::Named(targets) => {
                let mut next_lock = BTreeMap::new();
                for target in targets {
                    let Some(cur) = current.get(target) else {
                        return Err(format!(
                            "[E_LAW_NOT_FOUND] RUSTY_BENDS_UPDATE_LAWS named unknown law '{target}', which is not in verified/ or {}.",
                            lock_file.display()
                        ));
                    };
                    next_lock.insert(target.clone(), cur.clone());
                    update_summary.sealed.push(target.clone());
                }
                serialized = serialize_lock_entries(&next_lock);
                needs_write = !next_lock.is_empty();
            }
        }
    }

    for name in &new_names {
        if let Some(law) = current.get(name) {
            if law.promise.is_none() {
                return Err(format!(
                    "[E_LAW_NO_PROMISE] New law '{name}' is missing a plain-English '# promise:' comment.\nHint: Add '# promise: <one-sentence statement of what this law guarantees>' (and optionally '# harm: ...') directly above 'law {name}:'."
                ));
            }
        }
    }

    let mut warnings = Vec::new();
    for name in &locked_names {
        if let Some(law) = current.get(name) {
            match (&law.promise, locked_promises.get(name)) {
                (None, Some(old)) => warnings.push(format!(
                    "RustyBends [law {name}]: promise removed (was: \"{old}\"); add '# promise: ...' directly above 'law {name}:'."
                )),
                (None, None) => warnings.push(format!(
                    "RustyBends [law {name}]: locked law is missing a '# promise:' comment. Add '# promise: <one-sentence rule>' directly above 'law {name}:'."
                )),
                (Some(cur), Some(old)) if cur != old => warnings.push(format!(
                    "RustyBends [law {name}]: promise wording changed (lock hash unchanged): \"{old}\" -> \"{cur}\""
                )),
                (Some(cur), None) => warnings.push(format!(
                    "RustyBends [law {name}]: promise added (lock hash unchanged): \"{cur}\""
                )),
                (Some(_), Some(_)) => {}
            }
        }
    }

    Ok(LockCheckReport {
        current,
        locked_names,
        new_names,
        serialized,
        needs_write,
        warnings,
        update_summary,
    })
}

/// Persists `report.serialized` to `lock_file`.
pub fn write_law_lock(lock_file: &Path, report: &LockCheckReport) -> Result<(), String> {
    fs::write(lock_file, &report.serialized).map_err(|e| e.to_string())
}

/// Enforces `rusty-bends.lock` against the canonicalized laws in `files`.
pub fn enforce_law_lock(
    lock_file: &Path,
    files: &[PathBuf],
    allow_lock_update: bool,
) -> Result<usize, String> {
    let report = check_law_lock(lock_file, files, allow_lock_update)?;
    if report.needs_write {
        write_law_lock(lock_file, &report)?;
    }
    Ok(report.current.len())
}

/// Enforces `rusty-bends.lock` under `mode`.
pub fn enforce_law_lock_with_mode(
    lock_file: &Path,
    files: &[PathBuf],
    mode: &LockUpdateMode,
) -> Result<LockCheckReport, String> {
    let report = check_law_lock_with_mode(lock_file, files, mode)?;
    if report.needs_write {
        write_law_lock(lock_file, &report)?;
    }
    Ok(report)
}

/// Reads the set of locked law names currently present in `lock_file` (returns empty if missing).
pub fn read_locked_law_names(lock_file: &Path) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let Ok(raw) = fs::read_to_string(lock_file) else {
        return names;
    };
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = trimmed.splitn(3, "  ").collect();
        if parts.len() >= 2 {
            names.insert(parts[1].trim().to_string());
        }
    }
    names
}

fn is_top_level_keyword(tok: &str) -> bool {
    matches!(tok, "import" | "type" | "def" | "law" | "proof")
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
            while i < chars.len() && chars[i] != '\n' {
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
            "# promise: depositing in either order yields the same balance\nlaw conserved(for +a: Nat, for +b: Nat):\n  deposit(a, b) == deposit(b, a)\nproof conserved:\n  refl\n",
        )
        .unwrap();
        assert_eq!(
            enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap(),
            1
        );

        // Multi-line reformat + comments inside the law must remain locked-valid!
        fs::write(
            &file,
            "# promise: depositing in either order yields the same balance\n# header comment\nlaw conserved(\n  for +a: Nat,\n  -- inline note\n  for +b: Nat\n):\n  deposit(a, b)\n    ==\n  deposit(b, a)\n\nproof conserved:\n  refl\n",
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
            "# promise: cancelling an order twice matches cancelling it once\nlaw cancel_idempotent(\n  for +s: OrderState\n):\n  cancel_order(\n    cancel_order(s)\n  ) == cancel_order(s)\n\nproof cancel_idempotent:\n  refl\n",
        )
        .unwrap();
        enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap();

        // Subtle change on line 6 of the multi-line law must be caught
        fs::write(
            &file,
            "# promise: cancelling an order twice matches cancelling it once\nlaw cancel_idempotent(\n  for +s: OrderState\n):\n  cancel_order(\n    s\n  ) == cancel_order(s)\n\nproof cancel_idempotent:\n  refl\n",
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

        fs::write(
            &file,
            "# promise: identity holds\nlaw keep_me:\n  1n == 1n\nproof keep_me:\n  refl\n",
        )
        .unwrap();
        enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap();

        fs::write(&file, "def x(+n: Nat) -> Nat:\n  n\n").unwrap();
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

        fs::write(
            &file,
            "# promise: one equals one\nlaw first:\n  1n == 1n\nproof first:\n  refl\n",
        )
        .unwrap();
        enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap();

        fs::write(
            &file,
            "# promise: one equals one\nlaw first:\n  1n == 1n\nproof first:\n  refl\n\n# promise: two equals two\nlaw second:\n  2n == 2n\nproof second:\n  refl\n",
        )
        .unwrap();
        assert_eq!(enforce_law_lock(&lock, &[file], false).unwrap(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_law_without_promise_fails_with_e_law_no_promise() {
        let dir = tmp_dir("no_promise");
        let file = dir.join("core.bend");
        let lock = dir.join("rusty-bends.lock");

        // Completely missing promise
        fs::write(&file, "law missing_p:\n  1n == 1n\n").unwrap();
        let err = check_law_lock(&lock, std::slice::from_ref(&file), false).unwrap_err();
        assert!(err.contains("E_LAW_NO_PROMISE"), "got: {err}");
        assert!(err.contains("missing_p"), "got: {err}");

        // Blank promise text
        fs::write(&file, "# promise:   \nlaw missing_p:\n  1n == 1n\n").unwrap();
        let err_blank = check_law_lock(&lock, std::slice::from_ref(&file), false).unwrap_err();
        assert!(err_blank.contains("E_LAW_NO_PROMISE"), "got: {err_blank}");

        // Separated from `law` by a blank line -> does not attach to `law`
        fs::write(
            &file,
            "# promise: separated comment\n\nlaw missing_p:\n  1n == 1n\n",
        )
        .unwrap();
        let err_sep = check_law_lock(&lock, &[file], false).unwrap_err();
        assert!(err_sep.contains("E_LAW_NO_PROMISE"), "got: {err_sep}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn locked_law_without_promise_warns_without_failing() {
        let dir = tmp_dir("locked_no_promise");
        let file = dir.join("core.bend");
        let lock = dir.join("rusty-bends.lock");

        let src = "law legacy_law:\n  for +x: Nat\n  {x == x : Nat}\n";
        fs::write(&file, src).unwrap();
        let law = extract_laws_from_source(src).into_iter().next().unwrap();
        // Legacy lock file without `# promise` lines
        fs::write(
            &lock,
            format!("{}  {}  {}\n", law.hash, law.name, law.canonical_sig),
        )
        .unwrap();

        let report = check_law_lock(&lock, &[file], false)
            .expect("locked law missing promise should warn, not fail");
        assert!(report.locked_names.contains("legacy_law"));
        assert!(
            report
                .warnings
                .iter()
                .any(|w| w.contains("legacy_law") && w.contains("missing a '# promise:' comment")),
            "warnings: {:?}",
            report.warnings
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn editing_promise_wording_does_not_trip_lock_and_is_reported() {
        let dir = tmp_dir("promise_edit");
        let file = dir.join("core.bend");
        let lock = dir.join("rusty-bends.lock");

        fs::write(
            &file,
            "# promise: initial balance rule\n# harm: wrong balance\nlaw bal_rule:\n  for +x: Nat\n  {x == x : Nat}\n",
        )
        .unwrap();
        enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap();
        let initial_hash = extract_canonical_laws(std::slice::from_ref(&file))
            .unwrap()
            .get("bal_rule")
            .unwrap()
            .hash
            .clone();

        // Edit only the promise wording
        fs::write(
            &file,
            "# promise: clearer wording for the balance invariant\n# harm: wrong balance\nlaw bal_rule:\n  for +x: Nat\n  {x == x : Nat}\n",
        )
        .unwrap();
        let updated_hash = extract_canonical_laws(std::slice::from_ref(&file))
            .unwrap()
            .get("bal_rule")
            .unwrap()
            .hash
            .clone();
        assert_eq!(initial_hash, updated_hash);

        let report = check_law_lock(&lock, &[file], false)
            .expect("editing promise wording must not trigger E_LAW_LOCK_TAMPERED");
        assert!(
            report.warnings.iter().any(|w| w.contains("bal_rule")
                && w.contains("promise wording changed")
                && w.contains("initial balance rule")
                && w.contains("clearer wording for the balance invariant")),
            "warnings: {:?}",
            report.warnings
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn format_law_list_prints_name_and_promise() {
        let src = r#"# promise: first guarantee
law alpha:
  1n == 1n

law beta:
  2n == 2n
"#;
        let map: BTreeMap<String, CanonicalLaw> = extract_laws_from_source(src)
            .into_iter()
            .map(|l| (l.name.clone(), l))
            .collect();
        let listing = format_law_list(&map);
        assert_eq!(listing, "alpha: first guarantee\nbeta: (no promise)");
    }

    #[test]
    fn renaming_import_alias_preserves_canonical_law_hash_and_lock() {
        let dir = tmp_dir("alias_lock");
        let uses = dir.join("uses.bend");
        let lock = dir.join("rusty-bends.lock");

        let src_b = r#"import Base
import base_rules.bend as B

# promise: within_both with identical bounds agrees with within_limit
law within_both_diag:
  for +pos: Nat
  for +a: Nat
  {within_both(pos, a, a) == B.within_limit(pos, a) : Bool}
"#;
        fs::write(&uses, src_b).unwrap();
        enforce_law_lock(&lock, std::slice::from_ref(&uses), false).unwrap();
        let hash_b = extract_canonical_laws(std::slice::from_ref(&uses))
            .unwrap()
            .get("within_both_diag")
            .unwrap()
            .hash
            .clone();

        let src_rules = r#"import Base
import base_rules.bend as Rules

# promise: within_both with identical bounds agrees with within_limit
law within_both_diag:
  for +pos: Nat
  for +a: Nat
  {within_both(pos, a, a) == Rules.within_limit(pos, a) : Bool}
"#;
        fs::write(&uses, src_rules).unwrap();
        let hash_rules = extract_canonical_laws(std::slice::from_ref(&uses))
            .unwrap()
            .get("within_both_diag")
            .unwrap()
            .hash
            .clone();
        assert_eq!(hash_b, hash_rules);
        check_law_lock(&lock, &[uses], false)
            .expect("renaming import alias must not trip E_LAW_LOCK_TAMPERED");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn selective_seal_comments_only_and_reaccept_reporting_work_as_specified() {
        let dir = tmp_dir("issue17_selective");
        let ledger = dir.join("ledger.bend");
        let lock = dir.join("rusty-bends.lock");

        let start_src = r#"import Base

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
        fs::write(&ledger, start_src).unwrap();
        let init =
            enforce_law_lock_with_mode(&lock, std::slice::from_ref(&ledger), &LockUpdateMode::None)
                .unwrap();
        assert_eq!(
            init.update_summary.sealed,
            vec!["bump_changes", "total_covers_first"]
        );

        // 1. Reword bump_changes promise, add reviewed total_covers_second and doubted bump_not_lower.
        let step1_src = r#"import Base

def total_items(+a: Nat, +b: Nat) -> Nat:
  Nat.add(a, b)

def bump(+n: Nat) -> Nat:
  1n+n

# promise: the total never drops below the first delivery
law total_covers_first:
  for +a: Nat
  for +b: Nat
  {Nat.is_le(a, total_items(a, b)) == True{} : Bool}

# promise: every write gives the record a stamp it never had before
law bump_changes:
  for +m: Nat
  {Nat.is_eq(m, bump(m)) == False{} : Bool}

# promise: a write never lowers the stamp
law bump_not_lower:
  for +m: Nat
  {Nat.is_le(m, bump(m)) == True{} : Bool}

# promise: the total never drops below the second delivery
law total_covers_second:
  for +a: Nat
  for +b: Nat
  {Nat.is_le(b, total_items(a, b)) == True{} : Bool}
"#;
        fs::write(&ledger, step1_src).unwrap();

        // Seal ONLY total_covers_second.
        let r_named = enforce_law_lock_with_mode(
            &lock,
            std::slice::from_ref(&ledger),
            &LockUpdateMode::parse("total_covers_second"),
        )
        .unwrap();
        assert_eq!(
            r_named.update_summary.sealed,
            vec!["total_covers_second".to_string()]
        );
        assert!(r_named.update_summary.comments_updated.is_empty());
        let lock_after_named = fs::read_to_string(&lock).unwrap();
        assert!(lock_after_named.contains("total_covers_second"));
        assert!(!lock_after_named.contains("bump_not_lower"));
        assert!(
            lock_after_named.contains("# promise bump_changes: a write always changes the stamp"),
            "named seal must leave bump_changes promise line untouched:\n{lock_after_named}"
        );

        // Comments-only mode updates ONLY bump_changes's promise line and seals nothing.
        let r_comments = enforce_law_lock_with_mode(
            &lock,
            std::slice::from_ref(&ledger),
            &LockUpdateMode::parse("comments"),
        )
        .unwrap();
        assert!(r_comments.update_summary.sealed.is_empty());
        assert_eq!(
            r_comments.update_summary.comments_updated,
            vec![("bump_changes".to_string(), vec!["promise".to_string()])]
        );
        let lock_after_comments = fs::read_to_string(&lock).unwrap();
        assert!(!lock_after_comments.contains("bump_not_lower"));
        assert!(lock_after_comments.contains(
            "# promise bump_changes: every write gives the record a stamp it never had before"
        ));

        // 2. Weaken locked total_covers_first; both named (other law) and comments-only must fail.
        let weakened = step1_src.replace(
            "{Nat.is_le(a, total_items(a, b)) == True{} : Bool}",
            "{Nat.is_le(a, total_items(a, 0n)) == True{} : Bool}",
        );
        fs::write(&ledger, &weakened).unwrap();
        let err_named = check_law_lock_with_mode(
            &lock,
            std::slice::from_ref(&ledger),
            &LockUpdateMode::parse("bump_not_lower"),
        )
        .unwrap_err();
        assert!(err_named.contains("E_LAW_LOCK_TAMPERED"));
        assert!(err_named.contains("total_covers_first"));

        let err_comments = check_law_lock_with_mode(
            &lock,
            std::slice::from_ref(&ledger),
            &LockUpdateMode::CommentsOnly,
        )
        .unwrap_err();
        assert!(err_comments.contains("E_LAW_LOCK_TAMPERED"));
        assert!(err_comments.contains("total_covers_first"));

        // Re-accepting with =1 explicitly reports total_covers_first with old and new hash.
        let r_all = check_law_lock_with_mode(
            &lock,
            std::slice::from_ref(&ledger),
            &LockUpdateMode::parse("1"),
        )
        .unwrap();
        assert_eq!(r_all.update_summary.reaccepted.len(), 1);
        assert_eq!(r_all.update_summary.reaccepted[0].0, "total_covers_first");
        let notes = format_lock_update_notes(&r_all.update_summary);
        assert!(
            notes
                .iter()
                .any(|n| n.contains("RE-ACCEPTED changed law 'total_covers_first'")),
            "notes: {notes:?}"
        );

        // Unknown law name fails with E_LAW_NOT_FOUND.
        let err_missing = check_law_lock_with_mode(
            &lock,
            std::slice::from_ref(&ledger),
            &LockUpdateMode::parse("no_such_law"),
        )
        .unwrap_err();
        assert!(err_missing.contains("E_LAW_NOT_FOUND"), "{err_missing}");

        // Deleting a locked law and naming it removes it from the lock.
        let without_bump = weakened.replace(
            "# promise: every write gives the record a stamp it never had before\nlaw bump_changes:\n  for +m: Nat\n  {Nat.is_eq(m, bump(m)) == False{} : Bool}\n",
            "",
        );
        fs::write(&ledger, &without_bump).unwrap();
        let r_del = check_law_lock_with_mode(
            &lock,
            std::slice::from_ref(&ledger),
            &LockUpdateMode::parse("total_covers_first,bump_changes"),
        )
        .unwrap();
        assert_eq!(r_del.update_summary.removed, vec!["bump_changes"]);
        assert!(!r_del.serialized.contains("bump_changes"));
        assert!(!r_del.serialized.contains("bump_not_lower"));

        let _ = fs::remove_dir_all(&dir);
    }
}
