//! Rust Shell: handles I/O, HTTP, DB, and CLI.
//! Calls pure verified types and functions emitted into OUT_DIR/verified.rs at build time.

#[allow(dead_code)]
mod verified {
    include!(concat!(env!("OUT_DIR"), "/verified.rs"));
}

fn main() {
    let total = verified::deposit(100, 25);
    let cancelled = verified::cancel_order(verified::OrderState::Paid(total));
    let shipped = verified::cancel_order(verified::OrderState::Shipped(total));
    let reuse = verified::can_reuse_prefix(4, 8, 16);
    println!(
        "RustyBends v1 Verified Core OK -> deposit(100, 25) = {total}, cancel(Paid) = {cancelled:?}, cancel(Shipped) = {shipped:?}, can_reuse_prefix(4, 8, 16) = {reuse}"
    );
}

#[cfg(test)]
mod tests {
    use super::verified::{can_reuse_prefix, cancel_order, deposit, OrderState};

    #[test]
    fn verified_module_runs_with_zero_runtime_proof_overhead() {
        assert_eq!(deposit(100, 25), 125);
        assert_eq!(cancel_order(OrderState::Paid(50)), OrderState::Cancelled);
        assert!(can_reuse_prefix(4, 8, 16));
        assert!(!can_reuse_prefix(9, 8, 16));
        assert!(!can_reuse_prefix(4, 8, 7));
        assert_eq!(
            cancel_order(OrderState::Shipped(50)),
            OrderState::Shipped(50)
        );
    }
}
