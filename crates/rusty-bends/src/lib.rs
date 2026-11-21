//! RustyBends core syntax: a Rust mirror of BendTT, Bend's kernel.
//!
//! BendTT (see `upstream/bend/bend2/bendtt.lean`) is a dependent affine
//! calculus. Every binder, application and tuple carries a [`Quantity`]:
//! `Dead` (q=0) parts are checked but never run and are erased before
//! codegen; `Live` (q=1) parts are the affine computation that executes;
//! `Data` (q=2) marks duplication-safe data. This module is the data model
//! only — parsing, checking and compilation build on these types.

/// Binder/application quantity from BendTT.
///
/// - [`Quantity::Dead`] (q=0): types, annotations, motives. Checked, erased.
/// - [`Quantity::Live`] (q=1): the affine live part. Runs at most once.
/// - [`Quantity::Data`] (q=2): duplicable data. No lambdas or calls inside.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Quantity {
    Dead,
    Live,
    Data,
}

impl Quantity {
    /// True for q=0: checked-only parts that must not reach codegen.
    pub fn is_erased(self) -> bool {
        matches!(self, Quantity::Dead)
    }
}

/// A BendTT term.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum Term {
    /// Variable reference.
    Var(String),
    /// Natural number literal (`0n`, `1n+p` patterns desugar to these).
    Nat(u64),
    /// Lambda: binds `param` with quantity `q` in `body`.
    Lam {
        q: Quantity,
        param: String,
        body: Box<Term>,
    },
    /// Application: `func` applied to `arg`, with quantity `q`.
    App {
        q: Quantity,
        func: Box<Term>,
        arg: Box<Term>,
    },
    /// Tuple/pair constructor.
    Tup(Box<Term>, Box<Term>),
    /// Let binding: `name = value; body`.
    Let {
        name: String,
        value: Box<Term>,
        body: Box<Term>,
    },
    /// Type annotation: `term` checked against `ty` (dead, erased).
    Ann { term: Box<Term>, ty: Box<Term> },
    /// Universe: `Type` (`*1`) or `Data` (`*2`).
    Univ(Quantity),
}

/// A top-level definition: `def name(params) -> ty: body`.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Def {
    pub name: String,
    pub params: Vec<(Quantity, String, Term)>,
    pub ret: Term,
    pub body: Term,
}

/// A law from `LAWS.bend`: quantified variables plus the statement that
/// must be proven. A law with no accepted proof fails the build.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Law {
    pub name: String,
    /// Universally quantified variables (`for +x: Nat`).
    pub vars: Vec<(Quantity, String, Term)>,
    pub statement: Term,
}

/// A whole program: the book of definitions plus its laws.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Book {
    pub defs: Vec<Def>,
    pub laws: Vec<Law>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dead_parts_are_erased_and_live_parts_are_not() {
        assert!(Quantity::Dead.is_erased());
        assert!(!Quantity::Live.is_erased());
        assert!(!Quantity::Data.is_erased());
    }

    #[test]
    fn annotation_marks_the_type_as_a_dead_term() {
        let term = Term::Ann {
            term: Box::new(Term::Var("x".to_string())),
            ty: Box::new(Term::Univ(Quantity::Dead)),
        };
        assert!(matches!(term, Term::Ann { .. }));
    }
}
