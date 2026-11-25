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

def nat_lt_subst_l(-a: Nat, -b: Nat, -c: Nat, eq_ab: {a == b : Nat}, h: {Nat.is_lt(a, c) == True{} : Bool}) -> {Nat.is_lt(b, c) == True{} : Bool}:
  %eq_ab : {Nat.is_lt(_, c) == True{} : Bool}
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

def nat_le_add_add(b: Nat, x: Nat, y: Nat) -> {Nat.is_le(b, Nat.add(Nat.add(b, x), y)) == True{} : Bool}:
  +b2 = {b : Nat}
  +x2 = {x : Nat}
  +y2 = {y : Nat}
  nat_le_trans(b2, Nat.add(b2, x2), Nat.add(Nat.add(b2, x2), y2), nat_add_le_r(b2, x2), nat_add_le_r(Nat.add(b2, x2), y2))

def nat_add_not_lt_l(b: Nat, x: Nat, h: {Nat.is_lt(Nat.add(b, x), b) == True{} : Bool}) -> Empty:
  +b2 = {b : Nat}
  +x2 = {x : Nat}
  nat_lt_not_le(Nat.add(b2, x2), b2, h, nat_add_le_r(b2, x2))

def nat_add_lt_l.go(
  k: Nat,
  +a: Nat,
  +b: Nat,
  h: {Nat.is_lt(a, b) == True{} : Bool}
) -> {Nat.is_lt(Nat.add(k, a), Nat.add(k, b)) == True{} : Bool}:
  match k:
    case 0n:
      h
    case 1n+kp:
      nat_add_lt_l.go(kp, a, b, h)

def nat_add_lt_l(
  k: Nat,
  a: Nat,
  b: Nat,
  h: {Nat.is_lt(a, b) == True{} : Bool}
) -> {Nat.is_lt(Nat.add(k, a), Nat.add(k, b)) == True{} : Bool}:
  +a2 = {a : Nat}
  +b2 = {b : Nat}
  nat_add_lt_l.go(k, a2, b2, h)

def nat_add_cancel_l(k: Nat, x: Nat, y: Nat, e: {Nat.add(k, x) == Nat.add(k, y) : Nat}) -> {x == y : Nat}:
  +k2 = {k : Nat}
  +x2 = {x : Nat}
  +y2 = {y : Nat}
  %nat_add_sub_cancel_l(k2, x2) : {_ == y2 : Nat}
  %Equal.sym(Nat, Nat.add(k2, x2), Nat.add(k2, y2), e) : {Nat.sub(_, k2) == y2 : Nat}
  nat_add_sub_cancel_l(k2, y2)

def nat_sub_lt.go(
  +j: Nat,
  +k: Nat,
  +n: Nat,
  hn: {Nat.is_lt(0n, n) == True{} : Bool},
  h: {Nat.is_lt(j, Nat.add(k, n)) == True{} : Bool}
) -> {Nat.is_lt(Nat.sub(j, k), n) == True{} : Bool}:
  match j k:
    case 0n _:
      hn
    case 1n+jp 0n:
      h
    case 1n+jp 1n+kp:
      nat_sub_lt.go(jp, kp, n, hn, h)

def nat_sub_lt(
  j: Nat,
  k: Nat,
  n: Nat,
  hn: {Nat.is_lt(0n, n) == True{} : Bool},
  h: {Nat.is_lt(j, Nat.add(k, n)) == True{} : Bool}
) -> {Nat.is_lt(Nat.sub(j, k), n) == True{} : Bool}:
  +j2 = {j : Nat}
  +k2 = {k : Nat}
  +n2 = {n : Nat}
  nat_sub_lt.go(j2, k2, n2, hn, h)

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

# ==============================================================================
# Euclidean division & alignment (b = 1n+bp > 0, r < b)
# ==============================================================================

def nat_split_low_refuted(
  +bp: Nat,
  +m: Nat,
  +r1: Nat,
  +r2: Nat,
  h1: {Nat.is_lt(r1, 1n+bp) == True{} : Bool},
  e: {r1 == Nat.add(Nat.add(1n+bp, m), r2) : Nat}
) -> Empty:
  nat_lt_not_le(
    Nat.add(Nat.add(1n+bp, m), r2),
    1n+bp,
    nat_lt_subst_l(r1, Nat.add(Nat.add(1n+bp, m), r2), 1n+bp, e, h1),
    nat_le_add_add(1n+bp, m, r2)
  )

def nat_split_unique_q.go(
  +q1: Nat,
  +r1: Nat,
  +q2: Nat,
  +r2: Nat,
  +bp: Nat,
  h1: {Nat.is_lt(r1, 1n+bp) == True{} : Bool},
  h2: {Nat.is_lt(r2, 1n+bp) == True{} : Bool},
  e: {Nat.add(Nat.mul(q1, 1n+bp), r1) == Nat.add(Nat.mul(q2, 1n+bp), r2) : Nat}
) -> {q1 == q2 : Nat}:
  match q1 q2:
    case 0n 0n:
      {==}
    case 0n 1n+p2:
      Empty.absurd({0n == 1n+p2 : Nat}, nat_split_low_refuted(bp, Nat.mul(p2, 1n+bp), r1, r2, h1, e))
    case 1n+p1 0n:
      Empty.absurd(
        {1n+p1 == 0n : Nat},
        nat_split_low_refuted(
          bp,
          Nat.mul(p1, 1n+bp),
          r2,
          r1,
          h2,
          Equal.sym(Nat, Nat.add(Nat.add(1n+bp, Nat.mul(p1, 1n+bp)), r1), r2, e)
        )
      )
    case 1n+p1 1n+p2:
      e1 = Equal.trans(
        Nat,
        Nat.add(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1)),
        Nat.add(Nat.add(1n+bp, Nat.mul(p1, 1n+bp)), r1),
        Nat.add(Nat.add(1n+bp, Nat.mul(p2, 1n+bp)), r2),
        Equal.sym(
          Nat,
          Nat.add(Nat.add(1n+bp, Nat.mul(p1, 1n+bp)), r1),
          Nat.add(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1)),
          nat_add_assoc(1n+bp, Nat.mul(p1, 1n+bp), r1)
        ),
        e
      )
      e2 = Equal.trans(
        Nat,
        Nat.add(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1)),
        Nat.add(Nat.add(1n+bp, Nat.mul(p2, 1n+bp)), r2),
        Nat.add(1n+bp, Nat.add(Nat.mul(p2, 1n+bp), r2)),
        e1,
        nat_add_assoc(1n+bp, Nat.mul(p2, 1n+bp), r2)
      )
      %nat_split_unique_q.go(
        p1,
        r1,
        p2,
        r2,
        bp,
        h1,
        h2,
        nat_add_cancel_l(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1), Nat.add(Nat.mul(p2, 1n+bp), r2), e2)
      ) : {1n+p1 == 1n+_ : Nat}
      {==}

def nat_split_unique_q(
  q1: Nat,
  r1: Nat,
  q2: Nat,
  r2: Nat,
  bp: Nat,
  h1: {Nat.is_lt(r1, 1n+bp) == True{} : Bool},
  h2: {Nat.is_lt(r2, 1n+bp) == True{} : Bool},
  e: {Nat.add(Nat.mul(q1, 1n+bp), r1) == Nat.add(Nat.mul(q2, 1n+bp), r2) : Nat}
) -> {q1 == q2 : Nat}:
  +q1_2 = {q1 : Nat}
  +r1_2 = {r1 : Nat}
  +q2_2 = {q2 : Nat}
  +r2_2 = {r2 : Nat}
  +bp2 = {bp : Nat}
  nat_split_unique_q.go(q1_2, r1_2, q2_2, r2_2, bp2, h1, h2, e)

def nat_split_unique_r.go(
  +q1: Nat,
  +r1: Nat,
  +q2: Nat,
  +r2: Nat,
  +bp: Nat,
  h1: {Nat.is_lt(r1, 1n+bp) == True{} : Bool},
  h2: {Nat.is_lt(r2, 1n+bp) == True{} : Bool},
  e: {Nat.add(Nat.mul(q1, 1n+bp), r1) == Nat.add(Nat.mul(q2, 1n+bp), r2) : Nat}
) -> {r1 == r2 : Nat}:
  match q1 q2:
    case 0n 0n:
      e
    case 0n 1n+p2:
      Empty.absurd({r1 == r2 : Nat}, nat_split_low_refuted(bp, Nat.mul(p2, 1n+bp), r1, r2, h1, e))
    case 1n+p1 0n:
      Empty.absurd(
        {r1 == r2 : Nat},
        nat_split_low_refuted(
          bp,
          Nat.mul(p1, 1n+bp),
          r2,
          r1,
          h2,
          Equal.sym(Nat, Nat.add(Nat.add(1n+bp, Nat.mul(p1, 1n+bp)), r1), r2, e)
        )
      )
    case 1n+p1 1n+p2:
      e1 = Equal.trans(
        Nat,
        Nat.add(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1)),
        Nat.add(Nat.add(1n+bp, Nat.mul(p1, 1n+bp)), r1),
        Nat.add(Nat.add(1n+bp, Nat.mul(p2, 1n+bp)), r2),
        Equal.sym(
          Nat,
          Nat.add(Nat.add(1n+bp, Nat.mul(p1, 1n+bp)), r1),
          Nat.add(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1)),
          nat_add_assoc(1n+bp, Nat.mul(p1, 1n+bp), r1)
        ),
        e
      )
      e2 = Equal.trans(
        Nat,
        Nat.add(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1)),
        Nat.add(Nat.add(1n+bp, Nat.mul(p2, 1n+bp)), r2),
        Nat.add(1n+bp, Nat.add(Nat.mul(p2, 1n+bp), r2)),
        e1,
        nat_add_assoc(1n+bp, Nat.mul(p2, 1n+bp), r2)
      )
      nat_split_unique_r.go(
        p1,
        r1,
        p2,
        r2,
        bp,
        h1,
        h2,
        nat_add_cancel_l(1n+bp, Nat.add(Nat.mul(p1, 1n+bp), r1), Nat.add(Nat.mul(p2, 1n+bp), r2), e2)
      )

def nat_split_unique_r(
  q1: Nat,
  r1: Nat,
  q2: Nat,
  r2: Nat,
  bp: Nat,
  h1: {Nat.is_lt(r1, 1n+bp) == True{} : Bool},
  h2: {Nat.is_lt(r2, 1n+bp) == True{} : Bool},
  e: {Nat.add(Nat.mul(q1, 1n+bp), r1) == Nat.add(Nat.mul(q2, 1n+bp), r2) : Nat}
) -> {r1 == r2 : Nat}:
  +q1_2 = {q1 : Nat}
  +r1_2 = {r1 : Nat}
  +q2_2 = {q2 : Nat}
  +r2_2 = {r2 : Nat}
  +bp2 = {bp : Nat}
  nat_split_unique_r.go(q1_2, r1_2, q2_2, r2_2, bp2, h1, h2, e)

# For b > 0, written as 1n+bp, and r < 1n+bp: (q * (1n+bp) + r) / (1n+bp) == q
def nat_div_split(
  q: Nat,
  r: Nat,
  bp: Nat,
  h: {Nat.is_lt(r, 1n+bp) == True{} : Bool}
) -> {Nat.div(Nat.add(Nat.mul(q, 1n+bp), r), 1n+bp) == q : Nat}:
  +q2 = {q : Nat}
  +r2 = {r : Nat}
  +bp2 = {bp : Nat}
  nat_split_unique_q(
    Nat.div(Nat.add(Nat.mul(q2, 1n+bp2), r2), 1n+bp2),
    Nat.mod(Nat.add(Nat.mul(q2, 1n+bp2), r2), 1n+bp2),
    q2,
    r2,
    bp2,
    nat_mod_lt(Nat.add(Nat.mul(q2, 1n+bp2), r2), bp2),
    h,
    nat_div_mod_r(Nat.add(Nat.mul(q2, 1n+bp2), r2), bp2)
  )

# For b > 0, written as 1n+bp, and r < 1n+bp: (q * (1n+bp) + r) % (1n+bp) == r
def nat_mod_split(
  q: Nat,
  r: Nat,
  bp: Nat,
  h: {Nat.is_lt(r, 1n+bp) == True{} : Bool}
) -> {Nat.mod(Nat.add(Nat.mul(q, 1n+bp), r), 1n+bp) == r : Nat}:
  +q2 = {q : Nat}
  +r2 = {r : Nat}
  +bp2 = {bp : Nat}
  nat_split_unique_r(
    Nat.div(Nat.add(Nat.mul(q2, 1n+bp2), r2), 1n+bp2),
    Nat.mod(Nat.add(Nat.mul(q2, 1n+bp2), r2), 1n+bp2),
    q2,
    r2,
    bp2,
    nat_mod_lt(Nat.add(Nat.mul(q2, 1n+bp2), r2), bp2),
    h,
    nat_div_mod_r(Nat.add(Nat.mul(q2, 1n+bp2), r2), bp2)
  )

# For b > 0, written as 1n+bp, and a < 1n+bp: a % (1n+bp) == a
def nat_mod_small(
  a: Nat,
  bp: Nat,
  h: {Nat.is_lt(a, 1n+bp) == True{} : Bool}
) -> {Nat.mod(a, 1n+bp) == a : Nat}:
  nat_mod_split(0n, a, bp, h)

# For b > 0, written as 1n+bp, and a < 1n+bp: a / (1n+bp) == 0n
def nat_div_small(
  a: Nat,
  bp: Nat,
  h: {Nat.is_lt(a, 1n+bp) == True{} : Bool}
) -> {Nat.div(a, 1n+bp) == 0n : Nat}:
  nat_div_split(0n, a, bp, h)

# Two numbers with the same quotient and remainder modulo 1n+bp are equal.
def nat_eq_of_div_mod(
  a: Nat,
  c: Nat,
  bp: Nat,
  hq: {Nat.div(a, 1n+bp) == Nat.div(c, 1n+bp) : Nat},
  hr: {Nat.mod(a, 1n+bp) == Nat.mod(c, 1n+bp) : Nat}
) -> {a == c : Nat}:
  +a2 = {a : Nat}
  +c2 = {c : Nat}
  +bp2 = {bp : Nat}
  %nat_div_mod_r(a2, bp2) : {_ == c2 : Nat}
  %nat_div_mod_r(c2, bp2) : {Nat.add(Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2), Nat.mod(a2, 1n+bp2)) == _ : Nat}
  %hq : {Nat.add(Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2), Nat.mod(a2, 1n+bp2)) == Nat.add(Nat.mul(_, 1n+bp2), Nat.mod(c2, 1n+bp2)) : Nat}
  %hr : {Nat.add(Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2), Nat.mod(a2, 1n+bp2)) == Nat.add(Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2), _) : Nat}
  {==}

def nat_split_lt.go(
  +q: Nat,
  +r: Nat,
  +n: Nat,
  +bp: Nat,
  hq: {Nat.is_lt(q, n) == True{} : Bool},
  hr: {Nat.is_lt(r, 1n+bp) == True{} : Bool}
) -> {Nat.is_lt(Nat.add(Nat.mul(q, 1n+bp), r), Nat.mul(n, 1n+bp)) == True{} : Bool}:
  match q n:
    case 0n 0n:
      bool_absurd({Nat.is_lt(r, 0n) == True{} : Bool}, hq)
    case 0n 1n+np:
      nat_lt_le_trans(r, 1n+bp, Nat.add(1n+bp, Nat.mul(np, 1n+bp)), hr, nat_add_le_r(1n+bp, Nat.mul(np, 1n+bp)))
    case 1n+qp 0n:
      bool_absurd({Nat.is_lt(Nat.add(Nat.add(1n+bp, Nat.mul(qp, 1n+bp)), r), 0n) == True{} : Bool}, hq)
    case 1n+qp 1n+np:
      %Equal.sym(
        Nat,
        Nat.add(Nat.add(1n+bp, Nat.mul(qp, 1n+bp)), r),
        Nat.add(1n+bp, Nat.add(Nat.mul(qp, 1n+bp), r)),
        nat_add_assoc(1n+bp, Nat.mul(qp, 1n+bp), r)
      ) : {Nat.is_lt(_, Nat.add(1n+bp, Nat.mul(np, 1n+bp))) == True{} : Bool}
      nat_add_lt_l(
        1n+bp,
        Nat.add(Nat.mul(qp, 1n+bp), r),
        Nat.mul(np, 1n+bp),
        nat_split_lt.go(qp, r, np, bp, hq, hr)
      )

# q < n, r < 1n+bp -> q * (1n+bp) + r < n * (1n+bp)
def nat_split_lt(
  q: Nat,
  r: Nat,
  n: Nat,
  bp: Nat,
  hq: {Nat.is_lt(q, n) == True{} : Bool},
  hr: {Nat.is_lt(r, 1n+bp) == True{} : Bool}
) -> {Nat.is_lt(Nat.add(Nat.mul(q, 1n+bp), r), Nat.mul(n, 1n+bp)) == True{} : Bool}:
  +q2 = {q : Nat}
  +r2 = {r : Nat}
  +n2 = {n : Nat}
  +bp2 = {bp : Nat}
  nat_split_lt.go(q2, r2, n2, bp2, hq, hr)

# (q * (1n+bp)) % (1n+bp) == 0n
def nat_mod_mul(q: Nat, bp: Nat) -> {Nat.mod(Nat.mul(q, 1n+bp), 1n+bp) == 0n : Nat}:
  +q2 = {q : Nat}
  +bp2 = {bp : Nat}
  %nat_add_zero_r(Nat.mul(q2, 1n+bp2)) : {Nat.mod(_, 1n+bp2) == 0n : Nat}
  nat_mod_split(q2, 0n, bp2, {==})

# (q * (1n+bp)) / (1n+bp) == q
def nat_div_mul(q: Nat, bp: Nat) -> {Nat.div(Nat.mul(q, 1n+bp), 1n+bp) == q : Nat}:
  +q2 = {q : Nat}
  +bp2 = {bp : Nat}
  %nat_add_zero_r(Nat.mul(q2, 1n+bp2)) : {Nat.div(_, 1n+bp2) == q2 : Nat}
  nat_div_split(q2, 0n, bp2, {==})

# (a / (1n+bp)) * (1n+bp) <= a
def nat_align_down_le(a: Nat, bp: Nat) -> {Nat.is_le(Nat.mul(Nat.div(a, 1n+bp), 1n+bp), a) == True{} : Bool}:
  +a2 = {a : Nat}
  +bp2 = {bp : Nat}
  %nat_div_mod_r(a2, bp2) : {Nat.is_le(Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2), _) == True{} : Bool}
  nat_add_le_r(Nat.mul(Nat.div(a2, 1n+bp2), 1n+bp2), Nat.mod(a2, 1n+bp2))
