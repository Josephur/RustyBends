use std::env;
use std::path::PathBuf;
use std::process;

fn main() {
    let arg = env::args().nth(1);
    if matches!(arg.as_deref(), Some("-h" | "--help")) {
        println!("Usage: rusty-bends-laws [VERIFIED_DIR]");
        println!("Lists every Bend 2 law as '<name>: <promise>' (default dir: verified).");
        return;
    }

    let dir = PathBuf::from(arg.unwrap_or_else(|| "verified".to_string()));
    if !dir.exists() {
        eprintln!(
            "[E_NO_VERIFIED_DIR] Directory '{}' does not exist.",
            dir.display()
        );
        process::exit(1);
    }

    let mut files = Vec::new();
    if let Err(err) = rusty_bends_build::collect_bend_files(&dir, &mut files) {
        eprintln!("Failed to scan '{}': {err}", dir.display());
        process::exit(1);
    }
    files.sort();
    if files.is_empty() {
        eprintln!(
            "[E_NO_BEND_FILES] No .bend files found under '{}'.",
            dir.display()
        );
        process::exit(1);
    }

    match rusty_bends_build::lock::extract_canonical_laws(&files) {
        Ok(laws) => {
            let listing = rusty_bends_build::lock::format_law_list(&laws);
            if !listing.is_empty() {
                println!("{listing}");
            }
        }
        Err(err) => {
            eprintln!("Failed to extract laws: {err}");
            process::exit(1);
        }
    }
}
