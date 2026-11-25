use std::env;
use std::path::{Path, PathBuf};
use std::process;

fn infer_crate_root(verified_dir: &Path) -> Option<PathBuf> {
    let parent = match verified_dir.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    if rusty_bends_build::coverage::has_rust_source_dirs(&parent) {
        Some(parent)
    } else {
        None
    }
}

fn run_cli(args: &[String]) -> Result<Vec<String>, (i32, String)> {
    let mut coverage_mode = false;
    let mut no_rust_scan = false;
    let mut crate_root: Option<PathBuf> = None;
    let mut dir_arg: Option<PathBuf> = None;

    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "-h" | "--help" => {
                return Ok(vec![
                    "Usage: rusty-bends-laws [--coverage [--crate-root DIR | --no-rust-scan]] [VERIFIED_DIR]".to_string(),
                    "Lists every Bend 2 law as '<name>: <promise>', or with --coverage lists".to_string(),
                    "which emitted functions each law reaches and which laws name only uncalled functions.".to_string(),
                ]);
            }
            "--coverage" => coverage_mode = true,
            "--no-rust-scan" => no_rust_scan = true,
            "--crate-root" => {
                i += 1;
                let Some(val) = args.get(i) else {
                    return Err((2, "Missing argument for --crate-root".to_string()));
                };
                crate_root = Some(PathBuf::from(val));
            }
            _ if arg.starts_with("--crate-root=") => {
                let val = &arg["--crate-root=".len()..];
                crate_root = Some(PathBuf::from(val));
            }
            _ if arg.starts_with('-') => {
                return Err((2, format!("Unknown option '{arg}' (see --help)")));
            }
            _ => {
                if dir_arg.is_some() {
                    return Err((2, format!("Unexpected extra argument '{arg}'")));
                }
                dir_arg = Some(PathBuf::from(arg));
            }
        }
        i += 1;
    }

    let dir = dir_arg.unwrap_or_else(|| PathBuf::from("verified"));
    if !dir.exists() {
        return Err((
            1,
            format!(
                "[E_NO_VERIFIED_DIR] Directory '{}' does not exist.",
                dir.display()
            ),
        ));
    }

    let mut files = Vec::new();
    if let Err(err) = rusty_bends_build::collect_bend_files(&dir, &mut files) {
        return Err((1, format!("Failed to scan '{}': {err}", dir.display())));
    }
    files.sort();
    if files.is_empty() {
        return Err((
            1,
            format!(
                "[E_NO_BEND_FILES] No .bend files found under '{}'.",
                dir.display()
            ),
        ));
    }

    if coverage_mode {
        let root_opt = if no_rust_scan {
            None
        } else if crate_root.is_some() {
            crate_root
        } else {
            infer_crate_root(&dir)
        };
        let report = rusty_bends_build::coverage::analyze_coverage_dir(&dir, root_opt.as_deref())
            .map_err(|err| (1, format!("Failed to analyze coverage: {err}")))?;
        return Ok(rusty_bends_build::coverage::format_coverage_report(&report));
    }

    let laws = rusty_bends_build::lock::extract_canonical_laws(&files)
        .map_err(|err| (1, format!("Failed to extract laws: {err}")))?;
    let listing = rusty_bends_build::lock::format_law_list(&laws);
    if listing.is_empty() {
        Ok(Vec::new())
    } else {
        Ok(listing.lines().map(ToOwned::to_owned).collect())
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match run_cli(&args) {
        Ok(lines) => {
            for line in lines {
                println!("{line}");
            }
        }
        Err((code, msg)) => {
            eprintln!("{msg}");
            process::exit(code);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static BSEQ: AtomicUsize = AtomicUsize::new(0);

    fn tmp_dir(tag: &str) -> PathBuf {
        let n = BSEQ.fetch_add(1, Ordering::SeqCst);
        let dir = env::temp_dir().join(format!("rb_laws_bin_{tag}_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("verified")).unwrap();
        fs::create_dir_all(dir.join("src")).unwrap();
        dir
    }

    #[test]
    fn cli_coverage_flag_infers_crate_root_and_supports_no_rust_scan() {
        let root = tmp_dir("cov_cli");
        fs::write(
            root.join("verified/ledger.bend"),
            r#"import Base

def order_fits(+used: Nat, +want: Nat, +cap: Nat) -> Bool:
  Nat.is_le(want, Nat.sub(cap, used))

def order_fits_spec(+used: Nat, +want: Nat, +cap: Nat) -> Bool:
  Nat.is_le(Nat.add(used, want), cap)

# promise: an empty order always fits
law order_fits_empty:
  for +cap: Nat
  {order_fits_spec(0n, 0n, cap) == True{} : Bool}
"#,
        )
        .unwrap();
        fs::write(
            root.join("src/main.rs"),
            "fn main() { let _ = verified::order_fits(3, 4, 10); }\n",
        )
        .unwrap();

        let verified_str = root.join("verified").to_string_lossy().into_owned();

        // Default listing mode unchanged.
        let list_out = run_cli(std::slice::from_ref(&verified_str)).unwrap();
        assert_eq!(
            list_out,
            vec!["order_fits_empty: an empty order always fits"]
        );

        // --coverage infers `root` from `root/verified` because `root/src` exists.
        let cov_out = run_cli(&["--coverage".to_string(), verified_str.clone()]).unwrap();
        assert!(
            cov_out
                .iter()
                .any(|l| l.contains("uncovered functions]: order_fits")),
            "{cov_out:?}"
        );
        assert!(
            cov_out
                .iter()
                .any(|l| l.contains("[law order_fits_empty]: names only functions not mentioned in Rust sources: order_fits_spec")),
            "{cov_out:?}"
        );

        // --no-rust-scan omits Rust call-site scanning.
        let no_rust = run_cli(&[
            "--coverage".to_string(),
            "--no-rust-scan".to_string(),
            verified_str,
        ])
        .unwrap();
        assert!(!no_rust.iter().any(|l| l.contains("rust=")), "{no_rust:?}");

        let _ = fs::remove_dir_all(&root);
    }
}
