fn main() {
    // 1. Checks bend.pin / BEND_PIN_VERSION (if configured)
    // 2. Enforces token-canonical rusty-bends.lock (anti-cheat LAWS lock)
    // 3. Runs real 'bend --check-only' + 'bend --verdict' on verified/*.bend
    // 4. Erases q=0 types/laws and emits pure Rust (ADTs + match + defs) into OUT_DIR/verified.rs
    rusty_bends_build::verify_and_emit("verified");
}
