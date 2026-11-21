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

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalLaw {
    pub name: String,
    pub canonical_sig: String,
    pub hash: String,
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

/// Tokenizes Bend source (stripping comments and whitespace) and extracts every full multi-line `law`.
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

/// Enforces `rusty-bends.lock` against the canonicalized laws in `files`.
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
        .join("\n");

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
                    "[E_LAW_LOCK_TAMPERED] Locked law altered or deleted: '{line}'.\nHint: Restore the original law or run RUSTY_BENDS_UPDATE_LAWS=1 cargo check."
                ));
            }
            continue;
        }
        let expected_hash = parts[0].trim();
        let law_name = parts[1].trim();
        match current.get(law_name) {
            None => {
                return Err(format!(
                    "[E_LAW_LOCK_TAMPERED] Locked law '{law_name}' was deleted.\nHint: Restore 'law {law_name}' in verified/, or approve intentionally with RUSTY_BENDS_UPDATE_LAWS=1 cargo check."
                ));
            }
            Some(actual) if actual.hash != expected_hash => {
                return Err(format!(
                    "[E_LAW_LOCK_TAMPERED] Locked law '{law_name}' was modified (expected {expected_hash}, got {}).\nHint: Restore the original law statement, or approve intentionally with RUSTY_BENDS_UPDATE_LAWS=1 cargo check.",
                    actual.hash
                ));
            }
            Some(_) => {}
        }
    }

    Ok(current.len())
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
            "law conserved(for +a: Nat, for +b: Nat):\n  deposit(a, b) == deposit(b, a)\nproof conserved:\n  refl\n",
        )
        .unwrap();
        assert_eq!(
            enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap(),
            1
        );

        // Multi-line reformat + comments inside the law must remain locked-valid!
        fs::write(
            &file,
            "# header comment\nlaw conserved(\n  for +a: Nat,\n  -- inline note\n  for +b: Nat\n):\n  deposit(a, b)\n    ==\n  deposit(b, a)\n\nproof conserved:\n  refl\n",
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
            "law cancel_idempotent(\n  for +s: OrderState\n):\n  cancel_order(\n    cancel_order(s)\n  ) == cancel_order(s)\n\nproof cancel_idempotent:\n  refl\n",
        )
        .unwrap();
        enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap();

        // Subtle change on line 6 of the multi-line law must be caught
        fs::write(
            &file,
            "law cancel_idempotent(\n  for +s: OrderState\n):\n  cancel_order(\n    s\n  ) == cancel_order(s)\n\nproof cancel_idempotent:\n  refl\n",
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

        fs::write(&file, "law keep_me:\n  1n == 1n\nproof keep_me:\n  refl\n").unwrap();
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

        fs::write(&file, "law first:\n  1n == 1n\nproof first:\n  refl\n").unwrap();
        enforce_law_lock(&lock, std::slice::from_ref(&file), false).unwrap();

        fs::write(
            &file,
            "law first:\n  1n == 1n\nproof first:\n  refl\n\nlaw second:\n  2n == 2n\nproof second:\n  refl\n",
        )
        .unwrap();
        assert_eq!(enforce_law_lock(&lock, &[file], false).unwrap(), 2);
        let _ = fs::remove_dir_all(&dir);
    }
}
