# Shared Nat arithmetic & order lemmas for RustyBends verified cores.
# Import into any file under verified/ via:
#   import nat_lemmas.bend as L
# Every definition here is a q=0 proof/type helper and is completely erased before Rust codegen.

import Base

# ==============================================================================
# Ex falso / Bool refutation
# ==============================================================================

def bool_pick_type(b: Bool, t: Type, f: Type) -> Type:
  match b:
    case True{}:
      t
    case False{}:
      f

def bool_false_ne_true(h: {False{} == True{} : Bool}) -> Empty:
  %h : bool_pick_type(_, Empty, Unit)
  Unit{}

def bool_true_ne_false(h: {True{} == False{} : Bool}) -> Empty:
  %h : bool_pick_type(_, Unit, Empty)
  Unit{}

def bool_absurd(-A: Type, h: {False{} == True{} : Bool}) -> A:
  Empty.absurd(A, bool_false_ne_true(h))

def bool_absurd_tf(-A: Type, h: {True{} == False{} : Bool}) -> A:
  Empty.absurd(A, bool_true_ne_false(h))

# ==============================================================================
# Order (Nat.is_le, Nat.is_lt, Nat.min, Nat.max)
# ==============================================================================

def nat_le_refl(a: Nat) -> {Nat.is_le(a, a) == True{} : Bool}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      nat_le_refl(ap)

def nat_le_zero(b: Nat) -> {Nat.is_le(0n, b) == True{} : Bool}:
  match b:
    case 0n:
      {==}
    case 1n+bp:
      {==}

def nat_le_succ_r(a: Nat, b: Nat, h: {Nat.is_le(a, b) == True{} : Bool}) -> {Nat.is_le(a, 1n+b) == True{} : Bool}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      match b:
        case 0n:
          bool_absurd({Nat.is_le(1n+ap, 1n) == True{} : Bool}, h)
        case 1n+bp:
          nat_le_succ_r(ap, bp, h)

def nat_lt_succ_self(a: Nat) -> {Nat.is_lt(a, 1n+a) == True{} : Bool}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      nat_lt_succ_self(ap)

def nat_lt_succ_eq_le(a: Nat, b: Nat) -> {Nat.is_lt(a, 1n+b) == Nat.is_le(a, b) : Bool}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      {==}
    case 1n 0n:
      {==}
    case 1n+1n+app 0n:
      {==}
    case 1n+ap 1n+bp:
      nat_lt_succ_eq_le(ap, bp)

def nat_lt_imp_le(a: Nat, b: Nat, h: {Nat.is_lt(a, b) == True{} : Bool}) -> {Nat.is_le(a, b) == True{} : Bool}:
  match a b:
    case 0n 0n:
      bool_absurd({Nat.is_le(0n, 0n) == True{} : Bool}, h)
    case 0n 1n+bp:
      {==}
    case 1n+ap 0n:
      bool_absurd({Nat.is_le(1n+ap, 0n) == True{} : Bool}, h)
    case 1n+ap 1n+bp:
      nat_lt_imp_le(ap, bp, h)

def nat_not_lt_imp_le(a: Nat, b: Nat, h: {Nat.is_lt(a, b) == False{} : Bool}) -> {Nat.is_le(b, a) == True{} : Bool}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      bool_absurd_tf({Nat.is_le(1n+bp, 0n) == True{} : Bool}, h)
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+bp:
      nat_not_lt_imp_le(ap, bp, h)

def nat_le_subst_r(-x: Nat, -y: Nat, -z: Nat, eq_yz: {y == z : Nat}, h: {Nat.is_le(x, y) == True{} : Bool}) -> {Nat.is_le(x, z) == True{} : Bool}:
  %eq_yz : {Nat.is_le(x, _) == True{} : Bool}
  h

def nat_lt_subst_r(-x: Nat, -y: Nat, -z: Nat, eq_yz: {y == z : Nat}, h: {Nat.is_lt(x, y) == True{} : Bool}) -> {Nat.is_lt(x, z) == True{} : Bool}:
  %eq_yz : {Nat.is_lt(x, _) == True{} : Bool}
  h

def nat_le_trans(
  a: Nat,
  b: Nat,
  c: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool},
  bc: {Nat.is_le(b, c) == True{} : Bool}
) -> {Nat.is_le(a, c) == True{} : Bool}:
  match a:
    case 0n:
      nat_le_zero(c)
    case 1n+ap:
      match b:
        case 0n:
          bool_absurd({Nat.is_le(1n+ap, c) == True{} : Bool}, ab)
        case 1n+bp:
          match c:
            case 0n:
              bool_absurd({Nat.is_le(1n+ap, 0n) == True{} : Bool}, bc)
            case 1n+cp:
              nat_le_trans(ap, bp, cp, ab, bc)

def nat_lt_trans(
  a: Nat,
  b: Nat,
  c: Nat,
  ab: {Nat.is_lt(a, b) == True{} : Bool},
  bc: {Nat.is_lt(b, c) == True{} : Bool}
) -> {Nat.is_lt(a, c) == True{} : Bool}:
  match a:
    case 0n:
      match b:
        case 0n:
          bool_absurd({Nat.is_lt(0n, c) == True{} : Bool}, ab)
        case 1n+bp:
          match c:
            case 0n:
              bool_absurd({Nat.is_lt(0n, 0n) == True{} : Bool}, bc)
            case 1n+cp:
              {==}
    case 1n+ap:
      match b:
        case 0n:
          bool_absurd({Nat.is_lt(1n+ap, c) == True{} : Bool}, ab)
        case 1n+bp:
          match c:
            case 0n:
              bool_absurd({Nat.is_lt(1n+ap, 0n) == True{} : Bool}, bc)
            case 1n+cp:
              nat_lt_trans(ap, bp, cp, ab, bc)

def nat_lt_le_trans(
  a: Nat,
  b: Nat,
  c: Nat,
  ab: {Nat.is_lt(a, b) == True{} : Bool},
  bc: {Nat.is_le(b, c) == True{} : Bool}
) -> {Nat.is_lt(a, c) == True{} : Bool}:
  match a:
    case 0n:
      match b:
        case 0n:
          bool_absurd({Nat.is_lt(0n, c) == True{} : Bool}, ab)
        case 1n+bp:
          match c:
            case 0n:
              bool_absurd({Nat.is_lt(0n, 0n) == True{} : Bool}, bc)
            case 1n+cp:
              {==}
    case 1n+ap:
      match b:
        case 0n:
          bool_absurd({Nat.is_lt(1n+ap, c) == True{} : Bool}, ab)
        case 1n+bp:
          match c:
            case 0n:
              bool_absurd({Nat.is_lt(1n+ap, 0n) == True{} : Bool}, bc)
            case 1n+cp:
              nat_lt_le_trans(ap, bp, cp, ab, bc)

def nat_le_lt_trans(
  a: Nat,
  b: Nat,
  c: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool},
  bc: {Nat.is_lt(b, c) == True{} : Bool}
) -> {Nat.is_lt(a, c) == True{} : Bool}:
  match a:
    case 0n:
      match b:
        case 0n:
          bc
        case 1n+bp:
          match c:
            case 0n:
              bool_absurd({Nat.is_lt(0n, 0n) == True{} : Bool}, bc)
            case 1n+cp:
              {==}
    case 1n+ap:
      match b:
        case 0n:
          bool_absurd({Nat.is_lt(1n+ap, c) == True{} : Bool}, ab)
        case 1n+bp:
          match c:
            case 0n:
              bool_absurd({Nat.is_lt(1n+ap, 0n) == True{} : Bool}, bc)
            case 1n+cp:
              nat_le_lt_trans(ap, bp, cp, ab, bc)

def nat_lt_not_le(
  a: Nat,
  b: Nat,
  lt: {Nat.is_lt(a, b) == True{} : Bool},
  le: {Nat.is_le(b, a) == True{} : Bool}
) -> Empty:
  match a b:
    case 0n 0n:
      bool_false_ne_true(lt)
    case 0n 1n+bp:
      bool_false_ne_true(le)
    case 1n+ap 0n:
      bool_false_ne_true(lt)
    case 1n+ap 1n+bp:
      nat_lt_not_le(ap, bp, lt, le)

def nat_lt_le_false(
  a: Nat,
  b: Nat,
  lt: {Nat.is_lt(a, b) == True{} : Bool}
) -> {Nat.is_le(b, a) == False{} : Bool}:
  match a b:
    case 0n 0n:
      bool_absurd({Nat.is_le(0n, 0n) == False{} : Bool}, lt)
    case 0n 1n+bp:
      {==}
    case 1n+ap 0n:
      bool_absurd({Nat.is_le(0n, 1n+ap) == False{} : Bool}, lt)
    case 1n+ap 1n+bp:
      nat_lt_le_false(ap, bp, lt)

def nat_le_lt_false(
  a: Nat,
  b: Nat,
  le: {Nat.is_le(b, a) == True{} : Bool}
) -> {Nat.is_lt(a, b) == False{} : Bool}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      bool_absurd({Nat.is_lt(0n, 1n+bp) == False{} : Bool}, le)
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+bp:
      nat_le_lt_false(ap, bp, le)

def nat_le_antisym(
  a: Nat,
  b: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool},
  ba: {Nat.is_le(b, a) == True{} : Bool}
) -> {a == b : Nat}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      bool_absurd({0n == 1n+bp : Nat}, ba)
    case 1n+ap 0n:
      bool_absurd({1n+ap == 0n : Nat}, ab)
    case 1n+ap 1n+bp:
      %nat_le_antisym(ap, bp, ab, ba) : {1n+ap == 1n+_ : Nat}
      {==}

def nat_min_le_l.go(+a: Nat, +b: Nat) -> {Nat.is_le(Nat.min(a, b), a) == True{} : Bool}:
  match a b:
    case 0n _:
      {==}
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+bp:
      nat_min_le_l.go(ap, bp)

def nat_min_le_l(a: Nat, b: Nat) -> {Nat.is_le(Nat.min(a, b), a) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_min_le_l.go(a2, b2)

def nat_min_le_r.go(+a: Nat, +b: Nat) -> {Nat.is_le(Nat.min(a, b), b) == True{} : Bool}:
  match a b:
    case 0n _:
      nat_le_zero(b)
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+bp:
      nat_min_le_r.go(ap, bp)

def nat_min_le_r(a: Nat, b: Nat) -> {Nat.is_le(Nat.min(a, b), b) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_min_le_r.go(a2, b2)

def nat_max_ge_l.go(+a: Nat, +b: Nat) -> {Nat.is_le(a, Nat.max(a, b)) == True{} : Bool}:
  match a b:
    case 0n _:
      nat_le_zero(Nat.max(0n, b))
    case 1n+ap 0n:
      nat_le_refl(1n+ap)
    case 1n+ap 1n+bp:
      nat_max_ge_l.go(ap, bp)

def nat_max_ge_l(a: Nat, b: Nat) -> {Nat.is_le(a, Nat.max(a, b)) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_max_ge_l.go(a2, b2)

def nat_max_ge_r.go(+a: Nat, +b: Nat) -> {Nat.is_le(b, Nat.max(a, b)) == True{} : Bool}:
  match a b:
    case 0n _:
      nat_le_refl(b)
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+bp:
      nat_max_ge_r.go(ap, bp)

def nat_max_ge_r(a: Nat, b: Nat) -> {Nat.is_le(b, Nat.max(a, b)) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_max_ge_r.go(a2, b2)

def nat_min_comm.go(+a: Nat, +b: Nat) -> {Nat.min(a, b) == Nat.min(b, a) : Nat}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      {==}
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+bp:
      %nat_min_comm.go(ap, bp) : {1n+Nat.min(ap, bp) == 1n+_ : Nat}
      {==}

def nat_min_comm(a: Nat, b: Nat) -> {Nat.min(a, b) == Nat.min(b, a) : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_min_comm.go(a2, b2)

def nat_max_comm.go(+a: Nat, +b: Nat) -> {Nat.max(a, b) == Nat.max(b, a) : Nat}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      {==}
    case 1n+ap 0n:
      {==}
    case 1n+ap 1n+bp:
      %nat_max_comm.go(ap, bp) : {1n+Nat.max(ap, bp) == 1n+_ : Nat}
      {==}

def nat_max_comm(a: Nat, b: Nat) -> {Nat.max(a, b) == Nat.max(b, a) : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_max_comm.go(a2, b2)

# ==============================================================================
# Addition & subtraction
# ==============================================================================

def nat_add_zero_r(a: Nat) -> {Nat.add(a, 0n) == a : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %nat_add_zero_r(ap) : {1n+Nat.add(ap, 0n) == 1n+_ : Nat}
      {==}

def nat_add_succ_r(a: Nat, -b: Nat) -> {Nat.add(a, 1n+b) == 1n+Nat.add(a, b) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %nat_add_succ_r(ap, b) : {1n+Nat.add(ap, 1n+b) == 1n+_ : Nat}
      {==}

def nat_add_comm.go(a: Nat, +b: Nat) -> {Nat.add(a, b) == Nat.add(b, a) : Nat}:
  match a:
    case 0n:
      Equal.sym(Nat, Nat.add(b, 0n), b, nat_add_zero_r(b))
    case 1n+ap:
      %Equal.sym(Nat, Nat.add(b, 1n+ap), 1n+Nat.add(b, ap), nat_add_succ_r(b, ap)) : {1n+Nat.add(ap, b) == _ : Nat}
      %nat_add_comm.go(ap, b) : {1n+Nat.add(ap, b) == 1n+_ : Nat}
      {==}

def nat_add_comm(a: Nat, b: Nat) -> {Nat.add(a, b) == Nat.add(b, a) : Nat}:
  +b2 = {b : Nat}
  nat_add_comm.go(a, b2)

def nat_add_assoc(a: Nat, -b: Nat, -c: Nat) -> {Nat.add(Nat.add(a, b), c) == Nat.add(a, Nat.add(b, c)) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %nat_add_assoc(ap, b, c) : {1n+Nat.add(Nat.add(ap, b), c) == 1n+_ : Nat}
      {==}

def nat_add_le_l.go(+bp: Nat, +d: Nat) -> {Nat.is_le(d, Nat.add(bp, d)) == True{} : Bool}:
  match bp:
    case 0n:
      nat_le_refl(d)
    case 1n+bpp:
      nat_le_succ_r(d, Nat.add(bpp, d), nat_add_le_l.go(bpp, d))

def nat_add_le_l(a: Nat, b: Nat) -> {Nat.is_le(b, Nat.add(a, b)) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_add_le_l.go(a2, b2)

def nat_add_le_r(a: Nat, b: Nat) -> {Nat.is_le(a, Nat.add(a, b)) == True{} : Bool}:
  match a:
    case 0n:
      nat_le_zero(b)
    case 1n+ap:
      nat_add_le_r(ap, b)

def nat_add_le_mono.go(
  a: Nat,
  +b: Nat,
  +c: Nat,
  +d: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool},
  cd: {Nat.is_le(c, d) == True{} : Bool}
) -> {Nat.is_le(Nat.add(a, c), Nat.add(b, d)) == True{} : Bool}:
  match a b:
    case 0n 0n:
      cd
    case 0n 1n+bp:
      nat_le_succ_r(c, Nat.add(bp, d), nat_add_le_mono.go(0n, bp, c, d, nat_le_zero(bp), cd))
    case 1n+ap 0n:
      bool_absurd({Nat.is_le(1n+Nat.add(ap, c), d) == True{} : Bool}, ab)
    case 1n+ap 1n+bp:
      nat_add_le_mono.go(ap, bp, c, d, ab, cd)

def nat_add_le_mono(
  a: Nat,
  b: Nat,
  c: Nat,
  d: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool},
  cd: {Nat.is_le(c, d) == True{} : Bool}
) -> {Nat.is_le(Nat.add(a, c), Nat.add(b, d)) == True{} : Bool}:
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  +d2 = {d : Nat}
  nat_add_le_mono.go(a, b2, c2, d2, ab, cd)

def nat_add_lt_le_mono.go(
  a: Nat,
  +b: Nat,
  +c: Nat,
  +d: Nat,
  ab: {Nat.is_lt(a, b) == True{} : Bool},
  cd: {Nat.is_le(c, d) == True{} : Bool}
) -> {Nat.is_lt(Nat.add(a, c), Nat.add(b, d)) == True{} : Bool}:
  match a b:
    case 0n 0n:
      bool_absurd({Nat.is_lt(c, d) == True{} : Bool}, ab)
    case 0n 1n+bp:
      %Equal.sym(Bool, Nat.is_lt(c, 1n+Nat.add(bp, d)), Nat.is_le(c, Nat.add(bp, d)), nat_lt_succ_eq_le(c, Nat.add(bp, d))) : {_ == True{} : Bool}
      nat_le_trans(c, d, Nat.add(bp, d), cd, nat_add_le_l(bp, d))
    case 1n+ap 0n:
      bool_absurd({Nat.is_lt(1n+Nat.add(ap, c), d) == True{} : Bool}, ab)
    case 1n+ap 1n+bp:
      nat_add_lt_le_mono.go(ap, bp, c, d, ab, cd)

def nat_add_lt_le_mono(
  a: Nat,
  b: Nat,
  c: Nat,
  d: Nat,
  ab: {Nat.is_lt(a, b) == True{} : Bool},
  cd: {Nat.is_le(c, d) == True{} : Bool}
) -> {Nat.is_lt(Nat.add(a, c), Nat.add(b, d)) == True{} : Bool}:
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  +d2 = {d : Nat}
  nat_add_lt_le_mono.go(a, b2, c2, d2, ab, cd)

def nat_sub_zero_r(a: Nat) -> {Nat.sub(a, 0n) == a : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      {==}

def nat_sub_self(a: Nat) -> {Nat.sub(a, a) == 0n : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      nat_sub_self(ap)

def nat_add_sub_cancel_l(a: Nat, b: Nat) -> {Nat.sub(Nat.add(a, b), a) == b : Nat}:
  match a:
    case 0n:
      nat_sub_zero_r(b)
    case 1n+ap:
      nat_add_sub_cancel_l(ap, b)

def nat_add_sub_cancel_r(a: Nat, b: Nat) -> {Nat.sub(Nat.add(a, b), b) == a : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  %nat_add_comm(b2, a2) : {Nat.sub(_, b2) == a2 : Nat}
  nat_add_sub_cancel_l(b2, a2)

def nat_sub_add_cancel.go(
  +a: Nat,
  +b: Nat,
  h: {Nat.is_le(b, a) == True{} : Bool}
) -> {Nat.add(Nat.sub(a, b), b) == a : Nat}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      bool_absurd({1n+bp == 0n : Nat}, h)
    case 1n+ap 0n:
      nat_add_zero_r(1n+ap)
    case 1n+ap 1n+bp:
      %Equal.sym(Nat, Nat.add(Nat.sub(ap, bp), 1n+bp), 1n+Nat.add(Nat.sub(ap, bp), bp), nat_add_succ_r(Nat.sub(ap, bp), bp)) : {_ == 1n+ap : Nat}
      %nat_sub_add_cancel.go(ap, bp, h) : {1n+Nat.add(Nat.sub(ap, bp), bp) == 1n+_ : Nat}
      {==}

def nat_sub_add_cancel(
  a: Nat,
  b: Nat,
  h: {Nat.is_le(b, a) == True{} : Bool}
) -> {Nat.add(Nat.sub(a, b), b) == a : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_sub_add_cancel.go(a2, b2, h)

# ==============================================================================
# Multiplication
# ==============================================================================

def nat_mul_zero_r(a: Nat) -> {Nat.mul(a, 0n) == 0n : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      nat_mul_zero_r(ap)

def nat_mul_one_r(a: Nat) -> {Nat.mul(a, 1n) == a : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %nat_mul_one_r(ap) : {1n+Nat.mul(ap, 1n) == 1n+_ : Nat}
      {==}

def nat_mul_succ_r.go(+a: Nat, +b: Nat) -> {Nat.mul(a, 1n+b) == Nat.add(a, Nat.mul(a, b)) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %Equal.sym(Nat, Nat.mul(ap, 1n+b), Nat.add(ap, Nat.mul(ap, b)), nat_mul_succ_r.go(ap, b)) : {1n+Nat.add(b, _) == 1n+Nat.add(ap, Nat.add(b, Nat.mul(ap, b))) : Nat}
      %nat_add_assoc(b, ap, Nat.mul(ap, b)) : {1n+_ == 1n+Nat.add(ap, Nat.add(b, Nat.mul(ap, b))) : Nat}
      %nat_add_comm(ap, b) : {1n+Nat.add(_, Nat.mul(ap, b)) == 1n+Nat.add(ap, Nat.add(b, Nat.mul(ap, b))) : Nat}
      %nat_add_assoc(ap, b, Nat.mul(ap, b)) : {1n+Nat.add(Nat.add(ap, b), Nat.mul(ap, b)) == 1n+_ : Nat}
      {==}

def nat_mul_succ_r(a: Nat, b: Nat) -> {Nat.mul(a, 1n+b) == Nat.add(a, Nat.mul(a, b)) : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_mul_succ_r.go(a2, b2)

def nat_mul_comm.go(+a: Nat, +b: Nat) -> {Nat.mul(a, b) == Nat.mul(b, a) : Nat}:
  match a:
    case 0n:
      Equal.sym(Nat, Nat.mul(b, 0n), 0n, nat_mul_zero_r(b))
    case 1n+ap:
      %Equal.sym(Nat, Nat.mul(b, 1n+ap), Nat.add(b, Nat.mul(b, ap)), nat_mul_succ_r(b, ap)) : {Nat.add(b, Nat.mul(ap, b)) == _ : Nat}
      %nat_mul_comm.go(ap, b) : {Nat.add(b, Nat.mul(ap, b)) == Nat.add(b, _) : Nat}
      {==}

def nat_mul_comm(a: Nat, b: Nat) -> {Nat.mul(a, b) == Nat.mul(b, a) : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_mul_comm.go(a2, b2)

def nat_mul_add_dist_r.go(a: Nat, +b: Nat, +c: Nat) -> {Nat.mul(Nat.add(a, b), c) == Nat.add(Nat.mul(a, c), Nat.mul(b, c)) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %Equal.sym(Nat, Nat.mul(Nat.add(ap, b), c), Nat.add(Nat.mul(ap, c), Nat.mul(b, c)), nat_mul_add_dist_r.go(ap, b, c)) : {Nat.add(c, _) == Nat.add(Nat.add(c, Nat.mul(ap, c)), Nat.mul(b, c)) : Nat}
      Equal.sym(Nat, Nat.add(Nat.add(c, Nat.mul(ap, c)), Nat.mul(b, c)), Nat.add(c, Nat.add(Nat.mul(ap, c), Nat.mul(b, c))), nat_add_assoc(c, Nat.mul(ap, c), Nat.mul(b, c)))

def nat_mul_add_dist_r(a: Nat, b: Nat, c: Nat) -> {Nat.mul(Nat.add(a, b), c) == Nat.add(Nat.mul(a, c), Nat.mul(b, c)) : Nat}:
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  nat_mul_add_dist_r.go(a, b2, c2)

def nat_mul_add_dist_l(a: Nat, b: Nat, c: Nat) -> {Nat.mul(a, Nat.add(b, c)) == Nat.add(Nat.mul(a, b), Nat.mul(a, c)) : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  %nat_mul_comm(Nat.add(b2, c2), a2) : {_ == Nat.add(Nat.mul(a2, b2), Nat.mul(a2, c2)) : Nat}
  %nat_mul_comm(b2, a2) : {Nat.mul(Nat.add(b2, c2), a2) == Nat.add(_, Nat.mul(a2, c2)) : Nat}
  %nat_mul_comm(c2, a2) : {Nat.mul(Nat.add(b2, c2), a2) == Nat.add(Nat.mul(b2, a2), _) : Nat}
  nat_mul_add_dist_r(b2, c2, a2)

def nat_mul_assoc.go(+a: Nat, +b: Nat, +c: Nat) -> {Nat.mul(Nat.mul(a, b), c) == Nat.mul(a, Nat.mul(b, c)) : Nat}:
  match a:
    case 0n:
      {==}
    case 1n+ap:
      %Equal.sym(Nat, Nat.mul(Nat.add(b, Nat.mul(ap, b)), c), Nat.add(Nat.mul(b, c), Nat.mul(Nat.mul(ap, b), c)), nat_mul_add_dist_r(b, Nat.mul(ap, b), c)) : {_ == Nat.add(Nat.mul(b, c), Nat.mul(ap, Nat.mul(b, c))) : Nat}
      %nat_mul_assoc.go(ap, b, c) : {Nat.add(Nat.mul(b, c), Nat.mul(Nat.mul(ap, b), c)) == Nat.add(Nat.mul(b, c), _) : Nat}
      {==}

def nat_mul_assoc(a: Nat, b: Nat, c: Nat) -> {Nat.mul(Nat.mul(a, b), c) == Nat.mul(a, Nat.mul(b, c)) : Nat}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  nat_mul_assoc.go(a2, b2, c2)

def nat_mul_le_mono_r.go(
  +a: Nat,
  +b: Nat,
  +c: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool}
) -> {Nat.is_le(Nat.mul(a, c), Nat.mul(b, c)) == True{} : Bool}:
  match a b:
    case 0n 0n:
      {==}
    case 0n 1n+bp:
      nat_le_zero(Nat.add(c, Nat.mul(bp, c)))
    case 1n+ap 0n:
      bool_absurd({Nat.is_le(Nat.add(c, Nat.mul(ap, c)), 0n) == True{} : Bool}, ab)
    case 1n+ap 1n+bp:
      nat_add_le_mono(c, c, Nat.mul(ap, c), Nat.mul(bp, c), nat_le_refl(c), nat_mul_le_mono_r.go(ap, bp, c, ab))

def nat_mul_le_mono_r(
  a: Nat,
  b: Nat,
  c: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool}
) -> {Nat.is_le(Nat.mul(a, c), Nat.mul(b, c)) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  nat_mul_le_mono_r.go(a2, b2, c2, ab)

def nat_mul_le_mono_l(
  a: Nat,
  b: Nat,
  c: Nat,
  bc: {Nat.is_le(b, c) == True{} : Bool}
) -> {Nat.is_le(Nat.mul(a, b), Nat.mul(a, c)) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  %nat_mul_comm(b2, a2) : {Nat.is_le(_, Nat.mul(a2, c2)) == True{} : Bool}
  %nat_mul_comm(c2, a2) : {Nat.is_le(Nat.mul(b2, a2), _) == True{} : Bool}
  nat_mul_le_mono_r(b2, c2, a2, bc)

def nat_mul_le_mono(
  a: Nat,
  b: Nat,
  c: Nat,
  d: Nat,
  ab: {Nat.is_le(a, b) == True{} : Bool},
  cd: {Nat.is_le(c, d) == True{} : Bool}
) -> {Nat.is_le(Nat.mul(a, c), Nat.mul(b, d)) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  +c2 = {c : Nat}
  +d2 = {d : Nat}
  nat_le_trans(
    Nat.mul(a2, c2),
    Nat.mul(b2, c2),
    Nat.mul(b2, d2),
    nat_mul_le_mono_r(a2, b2, c2, ab),
    nat_mul_le_mono_l(b2, c2, d2, cd)
  )

# ==============================================================================
# Division & modulo (Nat.div, Nat.mod, Nat.divmod)
# ==============================================================================

def nat_divmod_go_mod_lt(
  n: Nat,
  +m: Nat,
  d: Nat,
  +r: Nat,
  +bp: Nat,
  eq_mr: {Nat.add(m, r) == bp : Nat}
) -> {Nat.is_lt(Pair.snd(Nat, Nat, Nat.divmod.go(n, m, d, r)), 1n+bp) == True{} : Bool}:
  match n:
    case 0n:
      %Equal.sym(Bool, Nat.is_lt(r, 1n+bp), Nat.is_le(r, bp), nat_lt_succ_eq_le(r, bp)) : {_ == True{} : Bool}
      %eq_mr : {Nat.is_le(r, _) == True{} : Bool}
      nat_add_le_l(m, r)
    case 1n+np:
      match m:
        case 0n:
          nat_divmod_go_mod_lt(np, r, 1n+d, 0n, bp, Equal.trans(Nat, Nat.add(r, 0n), r, bp, nat_add_zero_r(r), eq_mr))
        case 1n+mp:
          nat_divmod_go_mod_lt(
            np,
            mp,
            d,
            1n+r,
            bp,
            Equal.trans(Nat, Nat.add(mp, 1n+r), 1n+Nat.add(mp, r), bp, nat_add_succ_r(mp, r), eq_mr)
          )

# For b > 0, written as 1n+bp: a % (1n+bp) < 1n+bp
def nat_mod_lt(a: Nat, bp: Nat) -> {Nat.is_lt(Nat.mod(a, 1n+bp), 1n+bp) == True{} : Bool}:
  +bp2 = {bp : Nat}
  nat_divmod_go_mod_lt(a, bp2, 0n, 0n, bp2, nat_add_zero_r(bp2))

def nat_divmod_go_eq(
  +n: Nat,
  +m: Nat,
  +d: Nat,
  +r: Nat,
  +bp: Nat,
  +eq_mr: {Nat.add(m, r) == bp : Nat}
) -> {Nat.add(Pair.snd(Nat, Nat, Nat.divmod.go(n, m, d, r)), Nat.mul(Pair.fst(Nat, Nat, Nat.divmod.go(n, m, d, r)), 1n+bp)) == Nat.add(n, Nat.add(r, Nat.mul(d, 1n+bp))) : Nat}:
  match n:
    case 0n:
      {==}
    case 1n+np:
      match m:
        case 0n:
          ih = nat_divmod_go_eq(np, r, 1n+d, 0n, bp, Equal.trans(Nat, Nat.add(r, 0n), r, bp, nat_add_zero_r(r), eq_mr))
          %Equal.sym(Nat, r, bp, eq_mr) : {Nat.add(Pair.snd(Nat, Nat, Nat.divmod.go(np, r, 1n+d, 0n)), Nat.mul(Pair.fst(Nat, Nat, Nat.divmod.go(np, r, 1n+d, 0n)), 1n+bp)) == 1n+Nat.add(np, Nat.add(_, Nat.mul(d, 1n+bp))) : Nat}
          %nat_add_succ_r(np, Nat.add(bp, Nat.mul(d, 1n+bp))) : {Nat.add(Pair.snd(Nat, Nat, Nat.divmod.go(np, r, 1n+d, 0n)), Nat.mul(Pair.fst(Nat, Nat, Nat.divmod.go(np, r, 1n+d, 0n)), 1n+bp)) == _ : Nat}
          ih
        case 1n+mp:
          ih = nat_divmod_go_eq(
            np,
            mp,
            d,
            1n+r,
            bp,
            Equal.trans(Nat, Nat.add(mp, 1n+r), 1n+Nat.add(mp, r), bp, nat_add_succ_r(mp, r), eq_mr)
          )
          %nat_add_succ_r(np, Nat.add(r, Nat.mul(d, 1n+bp))) : {Nat.add(Pair.snd(Nat, Nat, Nat.divmod.go(np, mp, d, 1n+r)), Nat.mul(Pair.fst(Nat, Nat, Nat.divmod.go(np, mp, d, 1n+r)), 1n+bp)) == _ : Nat}
          ih

# For b > 0, written as 1n+bp: (a % (1n+bp)) + (a / (1n+bp)) * (1n+bp) == a
def nat_div_mod(a: Nat, bp: Nat) -> {Nat.add(Nat.mod(a, 1n+bp), Nat.mul(Nat.div(a, 1n+bp), 1n+bp)) == a : Nat}:
  +a2 = {a : Nat}
  +bp2 = {bp : Nat}
  %nat_add_zero_r(a2) : {Nat.add(Nat.mod(a2, 1n+bp2), Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2)) == _ : Nat}
  nat_divmod_go_eq(a2, bp2, 0n, 0n, bp2, nat_add_zero_r(bp2))

# Commuted orientation: (a / (1n+bp)) * (1n+bp) + (a % (1n+bp)) == a
def nat_div_mod_r(a: Nat, bp: Nat) -> {Nat.add(Nat.mul(Nat.div(a, 1n+bp), 1n+bp), Nat.mod(a, 1n+bp)) == a : Nat}:
  +a2 = {a : Nat}
  +bp2 = {bp : Nat}
  %nat_add_comm(Nat.mod(a2, 1n+bp2), Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2)) : {_ == a2 : Nat}
  nat_div_mod(a2, bp2)

def nat_div_lt_of_lt_mul_dec(
  +a: Nat,
  +n: Nat,
  +bp: Nat,
  h: {Nat.is_lt(a, Nat.mul(n, 1n+bp)) == True{} : Bool},
  b: Bool,
  eb: {b == Nat.is_lt(Nat.div(a, 1n+bp), n) : Bool}
) -> {Nat.is_lt(Nat.div(a, 1n+bp), n) == True{} : Bool}:
  match b:
    case True{}:
      Equal.sym(Bool, True{}, Nat.is_lt(Nat.div(a, 1n+bp), n), eb)
    case False{}:
      nq = nat_not_lt_imp_le(Nat.div(a, 1n+bp), n, Equal.sym(Bool, False{}, Nat.is_lt(Nat.div(a, 1n+bp), n), eb))
      nb_le_qb = nat_mul_le_mono_r(n, Nat.div(a, 1n+bp), 1n+bp, nq)
      qb_le_rqb = nat_add_le_l(Nat.mod(a, 1n+bp), Nat.mul(Nat.div(a, 1n+bp), 1n+bp))
      nb_le_rqb = nat_le_trans(
        Nat.mul(n, 1n+bp),
        Nat.mul(Nat.div(a, 1n+bp), 1n+bp),
        Nat.add(Nat.mod(a, 1n+bp), Nat.mul(Nat.div(a, 1n+bp), 1n+bp)),
        nb_le_qb,
        qb_le_rqb
      )
      nb_le_a = nat_le_subst_r(
        Nat.mul(n, 1n+bp),
        Nat.add(Nat.mod(a, 1n+bp), Nat.mul(Nat.div(a, 1n+bp), 1n+bp)),
        a,
        nat_div_mod(a, bp),
        nb_le_rqb
      )
      Empty.absurd({Nat.is_lt(Nat.div(a, 1n+bp), n) == True{} : Bool}, nat_lt_not_le(a, Nat.mul(n, 1n+bp), h, nb_le_a))

# For b > 0, written as 1n+bp: a < n * (1n+bp) -> a / (1n+bp) < n
def nat_div_lt_of_lt_mul(
  a: Nat,
  n: Nat,
  bp: Nat,
  h: {Nat.is_lt(a, Nat.mul(n, 1n+bp)) == True{} : Bool}
) -> {Nat.is_lt(Nat.div(a, 1n+bp), n) == True{} : Bool}:
  +a2 = {a : Nat}
  +n2 = {n : Nat}
  +bp2 = {bp : Nat}
  nat_div_lt_of_lt_mul_dec(a2, n2, bp2, h, Nat.is_lt(Nat.div(a2, 1n+bp2), n2), {==})

# For b > 0, written as 1n+bp: a < (1n+bp) * n -> a / (1n+bp) < n
def nat_div_lt_of_lt_mul_l(
  a: Nat,
  n: Nat,
  bp: Nat,
  h: {Nat.is_lt(a, Nat.mul(1n+bp, n)) == True{} : Bool}
) -> {Nat.is_lt(Nat.div(a, 1n+bp), n) == True{} : Bool}:
  +a2 = {a : Nat}
  +n2 = {n : Nat}
  +bp2 = {bp : Nat}
  nat_div_lt_of_lt_mul(
    a2,
    n2,
    bp2,
    nat_lt_subst_r(a2, Nat.mul(1n+bp2, n2), Nat.mul(n2, 1n+bp2), nat_mul_comm(1n+bp2, n2), h)
  )
