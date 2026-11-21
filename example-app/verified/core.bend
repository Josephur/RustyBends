# Real Bend 2 Verified Core (bendlang/bend 2.0.17+ syntax)
# Verified at Cargo build time with 'bend <file> --check-only' and '--verdict'.
# Every law and its matching proof def are erased before Rust emission.

import Base

type OrderState is Data:
  Draft{}
  Paid{amount: Nat}
  Shipped{amount: Nat}
  Cancelled{}

def deposit(bal: Nat, amt: Nat) -> Nat:
  Nat.add(bal, amt)

# Multi-line parameter lists are valid Bend 2 and emit like single-line headers.
def can_reuse_prefix(
  +snap_pos: Nat,
  +lcp: Nat,
  prompt_len: Nat
) -> Bool:
  (snap_pos <= lcp : Nat) && (lcp <= prompt_len : Nat)

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

# LAW 1: depositing into an empty balance equals amt (definitional)
law deposit_from_zero:
  for amt: Nat
  {deposit(0n, amt) == amt : Nat}

def deposit_from_zero(amt):
  {==}

# LAW 2: depositing 0n leaves any balance unchanged (inductive proof)
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

# LAW 3: cancelling an order is idempotent across every ADT state
law cancel_idempotent:
  for s: OrderState
  {cancel_order(cancel_order(s)) == cancel_order(s) : OrderState}

def cancel_idempotent(s):
  match s:
    case Draft{}:
      {==}
    case Paid{amt}:
      {==}
    case Shipped{amt}:
      {==}
    case Cancelled{}:
      {==}
