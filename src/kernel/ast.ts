/**
 * RustyBends core syntax: a TypeScript mirror of BendTT (v1).
 *
 * BendTT is a dependent affine calculus. Every binder, application, and parameter carries a Quantity:
 * - Dead (q=0): types, annotations, motives, proofs. Checked, then erased before codegen.
 * - Live (q=1): the affine live part. Runs at most once.
 * - Data (q=2): duplicable data. No lambdas or live calls inside.
 */

export enum Quantity {
  Dead = 'Dead',
  Live = 'Live',
  Data = 'Data',
}

/** True for q=0: checked-only parts that must never reach codegen. */
export function isErased(q: Quantity): boolean {
  return q === Quantity.Dead;
}

export function quantityCode(q: Quantity): string {
  switch (q) {
    case Quantity.Dead:
      return 'q=0';
    case Quantity.Live:
      return 'q=1';
    case Quantity.Data:
      return 'q=2';
  }
}

export function quantityPrefix(q: Quantity): string {
  switch (q) {
    case Quantity.Dead:
      return '0';
    case Quantity.Live:
      return '1';
    case Quantity.Data:
      return '2';
  }
}

export interface SourceSpan {
  line: number;
  column: number;
}

export type BinOpKind = 'And' | 'Or' | 'Lt' | 'Le' | 'Gt' | 'Ge' | 'Neq';

export type Pattern =
  | { kind: 'PatWild'; span?: SourceSpan }
  | { kind: 'PatBool'; value: boolean; span?: SourceSpan }
  | { kind: 'PatNat'; value: number; span?: SourceSpan }
  | {
      kind: 'PatCtor';
      typeName?: string;
      ctor: string;
      args: string[];
      span?: SourceSpan;
    };

export interface MatchArm {
  pattern: Pattern;
  body: Term;
  span?: SourceSpan;
}

export interface VariantField {
  name?: string;
  ty: Term;
}

export interface TypeVariant {
  name: string;
  fields: VariantField[];
  span?: SourceSpan;
}

/** An algebraic data type declaration: `type OrderState: Draft | Paid(amount: Nat) ...`. */
export interface TypeDef {
  name: string;
  variants: TypeVariant[];
  span?: SourceSpan;
}

export type Term =
  | { kind: 'Var'; name: string; span?: SourceSpan }
  | { kind: 'Nat'; value: number; span?: SourceSpan }
  | { kind: 'Bool'; value: boolean; span?: SourceSpan }
  | { kind: 'Not'; operand: Term; span?: SourceSpan }
  | { kind: 'BinOp'; op: BinOpKind; lhs: Term; rhs: Term; span?: SourceSpan }
  | { kind: 'Add'; lhs: Term; rhs: Term; span?: SourceSpan }
  | { kind: 'Sub'; lhs: Term; rhs: Term; span?: SourceSpan }
  | { kind: 'Eq'; lhs: Term; rhs: Term; span?: SourceSpan }
  | { kind: 'Refl'; span?: SourceSpan }
  | { kind: 'If'; cond: Term; thenBranch: Term; elseBranch: Term; span?: SourceSpan }
  | { kind: 'Match'; scrutinee: Term; arms: MatchArm[]; span?: SourceSpan }
  | { kind: 'Rewrite'; lemma: string; reverse: boolean; rest: Term; span?: SourceSpan }
  | { kind: 'Lam'; q: Quantity; param: string; body: Term; span?: SourceSpan }
  | { kind: 'App'; q: Quantity; func: Term; arg: Term; span?: SourceSpan }
  | { kind: 'Tup'; fst: Term; snd: Term; span?: SourceSpan }
  | { kind: 'Let'; name: string; value: Term; body: Term; span?: SourceSpan }
  | { kind: 'Ann'; term: Term; ty: Term; span?: SourceSpan }
  | { kind: 'Univ'; q: Quantity; span?: SourceSpan };

export interface Param {
  q: Quantity;
  name: string;
  ty: Term;
  span?: SourceSpan;
}

/** A top-level definition: `def name(params) -> ret: body`. */
export interface Def {
  name: string;
  params: Param[];
  ret: Term;
  body: Term;
  span?: SourceSpan;
}

/**
 * A law from `LAWS.bend`: universally quantified variables plus the statement
 * that must be proven. A law with no accepted proof fails the build.
 */
export interface Law {
  name: string;
  vars: Param[];
  statement: Term;
  proof?: Term;
  span?: SourceSpan;
}

/** A whole program: ADTs, definitions, and compile-time laws. */
export interface Book {
  types?: TypeDef[];
  defs: Def[];
  laws: Law[];
}

export function binOpSymbol(op: BinOpKind): string {
  switch (op) {
    case 'And':
      return '&&';
    case 'Or':
      return '||';
    case 'Lt':
      return '<';
    case 'Le':
      return '<=';
    case 'Gt':
      return '>';
    case 'Ge':
      return '>=';
    case 'Neq':
      return '!=';
  }
}

export function formatPattern(pat: Pattern): string {
  switch (pat.kind) {
    case 'PatWild':
      return '_';
    case 'PatBool':
      return pat.value ? 'true' : 'false';
    case 'PatNat':
      return `${pat.value}n`;
    case 'PatCtor': {
      const head = pat.typeName ? `${pat.typeName}.${pat.ctor}` : pat.ctor;
      return pat.args.length > 0 ? `${head}(${pat.args.join(', ')})` : head;
    }
  }
}

export function formatTerm(term: Term): string {
  switch (term.kind) {
    case 'Var':
      return term.name;
    case 'Nat':
      return `${term.value}n`;
    case 'Bool':
      return term.value ? 'true' : 'false';
    case 'Not':
      return `!${formatTerm(term.operand)}`;
    case 'BinOp':
      return `(${formatTerm(term.lhs)} ${binOpSymbol(term.op)} ${formatTerm(term.rhs)})`;
    case 'Add':
      return `(${formatTerm(term.lhs)} + ${formatTerm(term.rhs)})`;
    case 'Sub':
      return `(${formatTerm(term.lhs)} - ${formatTerm(term.rhs)})`;
    case 'Eq':
      return `${formatTerm(term.lhs)} == ${formatTerm(term.rhs)}`;
    case 'Refl':
      return 'refl';
    case 'If':
      return `if ${formatTerm(term.cond)}: ${formatTerm(term.thenBranch)} else: ${formatTerm(term.elseBranch)}`;
    case 'Match': {
      const arms = term.arms
        .map((a) => `case ${formatPattern(a.pattern)} => ${formatTerm(a.body)}`)
        .join('; ');
      return `match ${formatTerm(term.scrutinee)}: ${arms}`;
    }
    case 'Rewrite':
      return `rewrite ${term.reverse ? '<- ' : ''}${term.lemma}; ${formatTerm(term.rest)}`;
    case 'Lam':
      return `@${quantityPrefix(term.q)} ${term.param} => ${formatTerm(term.body)}`;
    case 'App': {
      const fn =
        term.func.kind === 'Lam' || term.func.kind === 'Let'
          ? `(${formatTerm(term.func)})`
          : formatTerm(term.func);
      const qTag = term.q === Quantity.Live ? '' : `[${quantityPrefix(term.q)}]`;
      return `${fn}${qTag}(${formatTerm(term.arg)})`;
    }
    case 'Tup':
      return `(${formatTerm(term.fst)}, ${formatTerm(term.snd)})`;
    case 'Let':
      return `let ${term.name} = ${formatTerm(term.value)}; ${formatTerm(term.body)}`;
    case 'Ann':
      return `(${formatTerm(term.term)} : ${formatTerm(term.ty)})`;
    case 'Univ':
      return term.q === Quantity.Dead
        ? '*0'
        : term.q === Quantity.Live
          ? 'Type'
          : 'Data';
  }
}

export function formatParam(p: Param): string {
  const sigil =
    p.q === Quantity.Dead ? '-' : p.q === Quantity.Data ? '+' : '';
  return `${sigil}${p.name}: ${formatTerm(p.ty)}`;
}

export function canonicalLawSignature(law: Law): string {
  const vars = law.vars.map((v) => `${v.q}:${v.name}:${formatTerm(v.ty)}`).join(',');
  return `law ${law.name}(${vars}): ${formatTerm(law.statement)}`;
}

export function formatBook(book: Book, options?: { erased?: boolean }): string {
  const lines: string[] = [];

  for (const td of book.types ?? []) {
    const variants = td.variants
      .map((v) => {
        if (v.fields.length === 0) return `  ${v.name}`;
        const f = v.fields
          .map((fld) => (fld.name ? `${fld.name}: ${formatTerm(fld.ty)}` : formatTerm(fld.ty)))
          .join(', ');
        return `  ${v.name}(${f})`;
      })
      .join('\n');
    lines.push(`type ${td.name}:\n${variants}`);
  }

  for (const def of book.defs) {
    const params = def.params.map(formatParam).join(', ');
    if (options?.erased) {
      const runtimeParams = def.params.map((p) => p.name).join(', ');
      lines.push(`def ${def.name}(${runtimeParams}):\n  ${formatTerm(def.body)}`);
    } else {
      lines.push(
        `def ${def.name}(${params}) -> ${formatTerm(def.ret)}:\n  ${formatTerm(def.body)}`
      );
    }
  }
  if (!options?.erased) {
    for (const law of book.laws) {
      const vars = law.vars.map((v) => `for ${formatParam(v)}`).join(', ');
      const header = vars ? `law ${law.name}(${vars}):` : `law ${law.name}:`;
      lines.push(`${header}\n  ${formatTerm(law.statement)}`);
      if (law.proof) {
        lines.push(`proof ${law.name}:\n  ${formatTerm(law.proof)}`);
      }
    }
  }
  return lines.join('\n\n');
}

function indent(str: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return str
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

/** Emits the exact Rust AST construction corresponding to rusty_bends::Book. */
export function termToRustAst(term: Term): string {
  switch (term.kind) {
    case 'Var':
      return `Term::Var("${term.name}".to_string())`;
    case 'Nat':
      return `Term::Nat(${term.value})`;
    case 'Bool':
      return `Term::Bool(${term.value})`;
    case 'Not':
      return `Term::Not(Box::new(${indent(termToRustAst(term.operand), 2).trimStart()}))`;
    case 'BinOp':
      return `Term::BinOp {\n  op: BinOp::${term.op},\n  lhs: Box::new(${indent(termToRustAst(term.lhs), 2).trimStart()}),\n  rhs: Box::new(${indent(termToRustAst(term.rhs), 2).trimStart()}),\n}`;
    case 'Add':
      return `Term::App {\n  q: Quantity::Data,\n  func: Box::new(Term::App {\n    q: Quantity::Data,\n    func: Box::new(Term::Var("Nat.add".to_string())),\n    arg: Box::new(${indent(termToRustAst(term.lhs), 4).trimStart()}),\n  }),\n  arg: Box::new(${indent(termToRustAst(term.rhs), 2).trimStart()}),\n}`;
    case 'Sub':
      return `Term::App {\n  q: Quantity::Data,\n  func: Box::new(Term::App {\n    q: Quantity::Data,\n    func: Box::new(Term::Var("Nat.sub".to_string())),\n    arg: Box::new(${indent(termToRustAst(term.lhs), 4).trimStart()}),\n  }),\n  arg: Box::new(${indent(termToRustAst(term.rhs), 2).trimStart()}),\n}`;
    case 'Eq':
      return `Term::App {\n  q: Quantity::Dead,\n  func: Box::new(Term::App {\n    q: Quantity::Dead,\n    func: Box::new(Term::Var("Equal".to_string())),\n    arg: Box::new(${indent(termToRustAst(term.lhs), 4).trimStart()}),\n  }),\n  arg: Box::new(${indent(termToRustAst(term.rhs), 2).trimStart()}),\n}`;
    case 'Refl':
      return `Term::Var("refl".to_string())`;
    case 'If':
      return `Term::If {\n  cond: Box::new(${indent(termToRustAst(term.cond), 2).trimStart()}),\n  then_branch: Box::new(${indent(termToRustAst(term.thenBranch), 2).trimStart()}),\n  else_branch: Box::new(${indent(termToRustAst(term.elseBranch), 2).trimStart()}),\n}`;
    case 'Match': {
      const arms = term.arms
        .map(
          (a) =>
            `("${formatPattern(a.pattern)}".to_string(), ${indent(termToRustAst(a.body), 4).trimStart()})`
        )
        .join(',\n    ');
      return `Term::Match {\n  scrutinee: Box::new(${indent(termToRustAst(term.scrutinee), 2).trimStart()}),\n  arms: vec![\n    ${arms}\n  ],\n}`;
    }
    case 'Rewrite':
      return `Term::Rewrite {\n  lemma: "${term.lemma}".to_string(),\n  reverse: ${term.reverse},\n  rest: Box::new(${indent(termToRustAst(term.rest), 2).trimStart()}),\n}`;
    case 'Lam':
      return `Term::Lam {\n  q: Quantity::${term.q},\n  param: "${term.param}".to_string(),\n  body: Box::new(${indent(termToRustAst(term.body), 2).trimStart()}),\n}`;
    case 'App':
      return `Term::App {\n  q: Quantity::${term.q},\n  func: Box::new(${indent(termToRustAst(term.func), 2).trimStart()}),\n  arg: Box::new(${indent(termToRustAst(term.arg), 2).trimStart()}),\n}`;
    case 'Tup':
      return `Term::Tup(\n  Box::new(${indent(termToRustAst(term.fst), 2).trimStart()}),\n  Box::new(${indent(termToRustAst(term.snd), 2).trimStart()}),\n)`;
    case 'Let':
      return `Term::Let {\n  name: "${term.name}".to_string(),\n  value: Box::new(${indent(termToRustAst(term.value), 2).trimStart()}),\n  body: Box::new(${indent(termToRustAst(term.body), 2).trimStart()}),\n}`;
    case 'Ann':
      return `Term::Ann {\n  term: Box::new(${indent(termToRustAst(term.term), 2).trimStart()}),\n  ty: Box::new(${indent(termToRustAst(term.ty), 2).trimStart()}),\n}`;
    case 'Univ':
      return `Term::Univ(Quantity::${term.q})`;
  }
}

export function bookToRustAst(book: Book): string {
  const types = (book.types ?? [])
    .map((td) => {
      const variants = td.variants
        .map((v) => {
          const fields = v.fields
            .map((f) => `(${f.name ? `Some("${f.name}")` : 'None'}, ${termToRustAst(f.ty)})`)
            .join(', ');
          return `Variant { name: "${v.name}".to_string(), fields: vec![${fields}] }`;
        })
        .join(',\n      ');
      return `TypeDef {\n    name: "${td.name}".to_string(),\n    variants: vec![\n      ${variants}\n    ],\n  }`;
    })
    .join(',\n  ');

  const defs = book.defs
    .map((d) => {
      const params = d.params
        .map(
          (p) =>
            `(Quantity::${p.q}, "${p.name}".to_string(), ${termToRustAst(p.ty)})`
        )
        .join(',\n      ');
      return `Def {\n    name: "${d.name}".to_string(),\n    params: vec![\n      ${params}\n    ],\n    ret: ${indent(termToRustAst(d.ret), 4).trimStart()},\n    body: ${indent(termToRustAst(d.body), 4).trimStart()},\n  }`;
    })
    .join(',\n  ');

  const laws = book.laws
    .map((l) => {
      const vars = l.vars
        .map(
          (v) =>
            `(Quantity::${v.q}, "${v.name}".to_string(), ${termToRustAst(v.ty)})`
        )
        .join(',\n      ');
      return `Law {\n    name: "${l.name}".to_string(),\n    vars: vec![\n      ${vars}\n    ],\n    statement: ${indent(termToRustAst(l.statement), 4).trimStart()},\n  }`;
    })
    .join(',\n  ');

  return `use rusty_bends::{Book, Def, Law, Quantity, Term, TypeDef, Variant};\n\nlet book = Book {\n  types: vec![\n  ${types}\n  ],\n  defs: vec![\n  ${defs}\n  ],\n  laws: vec![\n  ${laws}\n  ],\n};`;
}
