import {
  BinOpKind,
  Book,
  Def,
  Law,
  MatchArm,
  Param,
  Pattern,
  Quantity,
  SourceSpan,
  Term,
  TypeDef,
  TypeVariant,
  VariantField,
} from './ast';

export interface ParseError {
  message: string;
  line: number;
  column: number;
}

export interface ParseResult {
  book: Book | null;
  errors: ParseError[];
}

type TokenKind =
  | 'ident'
  | 'nat'
  | 'kw_type'
  | 'kw_def'
  | 'kw_law'
  | 'kw_proof'
  | 'kw_for'
  | 'kw_let'
  | 'kw_match'
  | 'kw_case'
  | 'kw_if'
  | 'kw_else'
  | 'kw_true'
  | 'kw_false'
  | 'kw_rewrite'
  | 'kw_refl'
  | 'kw_Type'
  | 'kw_Data'
  | 'kw_Dead'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'colon'
  | 'semi'
  | 'comma'
  | 'pipe'
  | 'arrow'
  | 'larrow'
  | 'fatarrow'
  | 'eq'
  | 'eqeq'
  | 'neq'
  | 'andand'
  | 'oror'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'bang'
  | 'plus'
  | 'minus'
  | 'at'
  | 'star'
  | 'eof';

interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  column: number;
}

const KEYWORDS: Record<string, TokenKind> = {
  type: 'kw_type',
  def: 'kw_def',
  law: 'kw_law',
  proof: 'kw_proof',
  for: 'kw_for',
  let: 'kw_let',
  match: 'kw_match',
  case: 'kw_case',
  if: 'kw_if',
  else: 'kw_else',
  true: 'kw_true',
  false: 'kw_false',
  rewrite: 'kw_rewrite',
  refl: 'kw_refl',
  Type: 'kw_Type',
  Data: 'kw_Data',
  Dead: 'kw_Dead',
};

function tokenize(source: string): { tokens: Token[]; errors: ParseError[] } {
  const tokens: Token[] = [];
  const errors: ParseError[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = () => {
    const ch = source[i++];
    if (ch === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
    return ch;
  };

  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance();
      continue;
    }

    // Line comments (# or --)
    if (ch === '#' || (ch === '-' && source[i + 1] === '-')) {
      while (i < source.length && source[i] !== '\n') {
        advance();
      }
      continue;
    }

    const startLine = line;
    const startCol = col;

    // Two-char punctuation
    const two = source.slice(i, i + 2);
    const twoMap: Record<string, TokenKind> = {
      '->': 'arrow',
      '<-': 'larrow',
      '=>': 'fatarrow',
      '==': 'eqeq',
      '!=': 'neq',
      '&&': 'andand',
      '||': 'oror',
      '<=': 'le',
      '>=': 'ge',
    };
    if (twoMap[two]) {
      advance();
      advance();
      tokens.push({ kind: twoMap[two], text: two, line: startLine, column: startCol });
      continue;
    }

    // Single-char punctuation
    const singleMap: Record<string, TokenKind> = {
      '(': 'lparen',
      ')': 'rparen',
      '[': 'lbracket',
      ']': 'rbracket',
      ':': 'colon',
      ';': 'semi',
      ',': 'comma',
      '|': 'pipe',
      '=': 'eq',
      '<': 'lt',
      '>': 'gt',
      '!': 'bang',
      '+': 'plus',
      '-': 'minus',
      '@': 'at',
      '*': 'star',
    };

    if (singleMap[ch]) {
      advance();
      tokens.push({ kind: singleMap[ch], text: ch, line: startLine, column: startCol });
      continue;
    }

    // Natural number literals (`0n`, `42n`, or plain digits `0`, `1`, `2` used in quantities/universes)
    if (ch >= '0' && ch <= '9') {
      let buf = '';
      while (i < source.length && source[i] >= '0' && source[i] <= '9') {
        buf += advance();
      }
      if (i < source.length && source[i] === 'n') {
        buf += advance();
      }
      tokens.push({ kind: 'nat', text: buf, line: startLine, column: startCol });
      continue;
    }

    // Identifiers & keywords
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let buf = '';
      while (
        i < source.length &&
        ((source[i] >= 'a' && source[i] <= 'z') ||
          (source[i] >= 'A' && source[i] <= 'Z') ||
          (source[i] >= '0' && source[i] <= '9') ||
          source[i] === '_' ||
          source[i] === '.')
      ) {
        buf += advance();
      }
      const kw = KEYWORDS[buf];
      tokens.push({
        kind: kw ?? 'ident',
        text: buf,
        line: startLine,
        column: startCol,
      });
      continue;
    }

    errors.push({
      message: `Unexpected character '${ch}'`,
      line: startLine,
      column: startCol,
    });
    advance();
  }

  tokens.push({ kind: 'eof', text: '', line, column: col });
  return { tokens, errors };
}

class Parser {
  private pos = 0;
  readonly errors: ParseError[] = [];

  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    const tok = this.peek();
    if (this.pos < this.tokens.length - 1) {
      this.pos++;
    }
    return tok;
  }

  private match(kind: TokenKind): Token | null {
    if (this.peek().kind === kind) {
      return this.next();
    }
    return null;
  }

  private expect(kind: TokenKind, label: string): Token {
    const tok = this.peek();
    if (tok.kind === kind) {
      return this.next();
    }
    this.errors.push({
      message: `Expected ${label}, found '${tok.text || 'end of file'}'`,
      line: tok.line,
      column: tok.column,
    });
    return tok;
  }

  private spanOf(tok: Token): SourceSpan {
    return { line: tok.line, column: tok.column };
  }

  private isTopLevelStart(kind: TokenKind): boolean {
    return (
      kind === 'kw_type' ||
      kind === 'kw_def' ||
      kind === 'kw_law' ||
      kind === 'kw_proof' ||
      kind === 'eof'
    );
  }

  private parseQuantityNumber(): Quantity {
    const tok = this.expect('nat', 'quantity 0, 1, or 2');
    const clean = tok.text.replace(/n$/, '');
    if (clean === '0') return Quantity.Dead;
    if (clean === '1') return Quantity.Live;
    if (clean === '2') return Quantity.Data;
    this.errors.push({
      message: `Invalid BendTT quantity '${tok.text}' (expected 0 for Dead, 1 for Live, or 2 for Data)`,
      line: tok.line,
      column: tok.column,
    });
    return Quantity.Live;
  }

  private parseTypeDef(): TypeDef {
    const kw = this.expect('kw_type', "'type'");
    const nameTok = this.expect('ident', 'type name');
    this.expect('colon', "':'");

    const variants: TypeVariant[] = [];
    while (!this.isTopLevelStart(this.peek().kind)) {
      this.match('pipe');
      if (this.isTopLevelStart(this.peek().kind)) break;
      const vTok = this.expect('ident', 'variant constructor name');
      const fields: VariantField[] = [];
      if (this.match('lparen')) {
        if (this.peek().kind !== 'rparen') {
          fields.push(this.parseVariantField());
          while (this.match('comma')) {
            if (this.peek().kind === 'rparen') break;
            fields.push(this.parseVariantField());
          }
        }
        this.expect('rparen', "')'");
      }
      variants.push({
        name: vTok.text || 'Variant',
        fields,
        span: this.spanOf(vTok),
      });
      // Optional trailing separator between variants
      this.match('pipe');
      this.match('comma');
    }

    if (variants.length === 0) {
      this.errors.push({
        message: `Type '${nameTok.text || 'unnamed'}' must declare at least one constructor variant`,
        line: kw.line,
        column: kw.column,
      });
    }

    return {
      name: nameTok.text || 'UnnamedType',
      variants,
      span: this.spanOf(kw),
    };
  }

  private parseVariantField(): VariantField {
    // Supports both `amount: Nat` and positional `Nat`
    if (this.peek().kind === 'ident' && this.peek(1).kind === 'colon') {
      const fName = this.next();
      this.next(); // ':'
      const ty = this.parseTerm();
      return { name: fName.text, ty };
    }
    return { ty: this.parseTerm() };
  }

  private parseParam(allowForKeyword: boolean): Param {
    const start = this.peek();
    if (allowForKeyword) {
      this.match('kw_for');
    }
    let q = Quantity.Live;
    if (this.match('minus')) {
      q = Quantity.Dead;
    } else if (this.match('plus')) {
      q = Quantity.Data;
    } else if (this.match('at')) {
      q = this.parseQuantityNumber();
    }

    const nameTok = this.expect('ident', 'parameter name');
    this.expect('colon', "':'");
    const ty = this.parseTerm();
    return {
      q,
      name: nameTok.text || '_',
      ty,
      span: this.spanOf(start),
    };
  }

  private parseDef(): Def {
    const kw = this.expect('kw_def', "'def'");
    const nameTok = this.expect('ident', 'definition name');
    const params: Param[] = [];
    if (this.match('lparen')) {
      if (this.peek().kind !== 'rparen') {
        params.push(this.parseParam(false));
        while (this.match('comma')) {
          if (this.peek().kind === 'rparen') break;
          params.push(this.parseParam(false));
        }
      }
      this.expect('rparen', "')'");
    }

    let ret: Term = { kind: 'Univ', q: Quantity.Live, span: this.spanOf(kw) };
    if (this.match('arrow')) {
      ret = this.parseTerm();
    }
    this.expect('colon', "':'");
    const body = this.parseTerm();

    return {
      name: nameTok.text || 'unnamed',
      params,
      ret,
      body,
      span: this.spanOf(kw),
    };
  }

  private parseLaw(): Law {
    const kw = this.expect('kw_law', "'law'");
    const nameTok = this.expect('ident', 'law name');
    const vars: Param[] = [];
    if (this.match('lparen')) {
      if (this.peek().kind !== 'rparen') {
        vars.push(this.parseParam(true));
        while (this.match('comma')) {
          if (this.peek().kind === 'rparen') break;
          vars.push(this.parseParam(true));
        }
      }
      this.expect('rparen', "')'");
    }
    this.expect('colon', "':'");
    const statement = this.parseTerm();
    return {
      name: nameTok.text || 'unnamed_law',
      vars,
      statement,
      span: this.spanOf(kw),
    };
  }

  private parseProof(): { name: string; proof: Term; span: SourceSpan } {
    const kw = this.expect('kw_proof', "'proof'");
    const nameTok = this.expect('ident', 'law name');
    this.expect('colon', "':'");
    const proof = this.parseTerm();
    return {
      name: nameTok.text || 'unnamed_law',
      proof,
      span: this.spanOf(kw),
    };
  }

  parseBook(): Book {
    const types: TypeDef[] = [];
    const defs: Def[] = [];
    const laws: Law[] = [];
    const proofs = new Map<string, { proof: Term; span: SourceSpan }>();

    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'kw_type') {
        types.push(this.parseTypeDef());
      } else if (tok.kind === 'kw_def') {
        defs.push(this.parseDef());
      } else if (tok.kind === 'kw_law') {
        laws.push(this.parseLaw());
      } else if (tok.kind === 'kw_proof') {
        const parsed = this.parseProof();
        proofs.set(parsed.name, { proof: parsed.proof, span: parsed.span });
      } else {
        this.errors.push({
          message: `Unexpected top-level token '${tok.text}'. Expected 'type', 'def', 'law', or 'proof'.`,
          line: tok.line,
          column: tok.column,
        });
        this.next();
      }
    }

    for (const law of laws) {
      const entry = proofs.get(law.name);
      if (entry) {
        law.proof = entry.proof;
        proofs.delete(law.name);
      }
    }

    for (const [orphanName, entry] of proofs.entries()) {
      this.errors.push({
        message: `Proof '${orphanName}' does not match any declared law.`,
        line: entry.span.line,
        column: entry.span.column,
      });
    }

    return { types, defs, laws };
  }

  private parsePattern(): Pattern {
    const tok = this.peek();
    if (tok.kind === 'kw_true') {
      this.next();
      return { kind: 'PatBool', value: true, span: this.spanOf(tok) };
    }
    if (tok.kind === 'kw_false') {
      this.next();
      return { kind: 'PatBool', value: false, span: this.spanOf(tok) };
    }
    if (tok.kind === 'nat') {
      this.next();
      const val = Number.parseInt(tok.text.replace(/n$/, ''), 10);
      return { kind: 'PatNat', value: Number.isNaN(val) ? 0 : val, span: this.spanOf(tok) };
    }
    if (tok.kind === 'ident') {
      this.next();
      if (tok.text === '_') {
        return { kind: 'PatWild', span: this.spanOf(tok) };
      }
      const dotIdx = tok.text.lastIndexOf('.');
      const typeName = dotIdx > 0 ? tok.text.slice(0, dotIdx) : undefined;
      const ctor = dotIdx > 0 ? tok.text.slice(dotIdx + 1) : tok.text;
      const args: string[] = [];
      if (this.match('lparen')) {
        if (this.peek().kind !== 'rparen') {
          args.push(this.expect('ident', 'pattern binding').text || '_');
          while (this.match('comma')) {
            if (this.peek().kind === 'rparen') break;
            args.push(this.expect('ident', 'pattern binding').text || '_');
          }
        }
        this.expect('rparen', "')'");
      }
      return { kind: 'PatCtor', typeName, ctor, args, span: this.spanOf(tok) };
    }

    this.errors.push({
      message: `Expected pattern in 'case', found '${tok.text || 'end of file'}'`,
      line: tok.line,
      column: tok.column,
    });
    this.next();
    return { kind: 'PatWild', span: this.spanOf(tok) };
  }

  parseTerm(): Term {
    // Let binding: `let x = v; body`
    if (this.peek().kind === 'kw_let') {
      const kw = this.next();
      const nameTok = this.expect('ident', 'variable name');
      this.expect('eq', "'='");
      const value = this.parseEquality();
      this.expect('semi', "';'");
      const body = this.parseTerm();
      return {
        kind: 'Let',
        name: nameTok.text || '_',
        value,
        body,
        span: this.spanOf(kw),
      };
    }

    // Rewrite proof step: `rewrite lemma_name; rest` or `rewrite <- lemma_name; rest`
    if (this.peek().kind === 'kw_rewrite') {
      const kw = this.next();
      const reverse = this.match('larrow') !== null;
      const lemmaTok = this.expect('ident', 'lemma law name');
      this.match('semi');
      const rest = this.parseTerm();
      return {
        kind: 'Rewrite',
        lemma: lemmaTok.text || 'unknown_lemma',
        reverse,
        rest,
        span: this.spanOf(kw),
      };
    }

    // Conditional: `if cond: thenBranch else: elseBranch`
    if (this.peek().kind === 'kw_if') {
      const kw = this.next();
      const cond = this.parseEquality();
      this.match('colon');
      const thenBranch = this.parseTerm();
      this.expect('kw_else', "'else'");
      this.match('colon');
      const elseBranch = this.parseTerm();
      return {
        kind: 'If',
        cond,
        thenBranch,
        elseBranch,
        span: this.spanOf(kw),
      };
    }

    // Pattern match (used in both defs and structural case-split proofs):
    // `match scrutinee: case Pat => body ...`
    if (this.peek().kind === 'kw_match') {
      const kw = this.next();
      const scrutinee = this.parseEquality();
      this.expect('colon', "':'");
      const arms: MatchArm[] = [];
      while (this.peek().kind === 'kw_case') {
        const caseTok = this.next();
        const pattern = this.parsePattern();
        if (!this.match('fatarrow')) {
          this.expect('colon', "'=>' or ':'");
        }
        const body = this.parseTerm();
        this.match('semi');
        arms.push({ pattern, body, span: this.spanOf(caseTok) });
      }
      if (arms.length === 0) {
        this.errors.push({
          message: "'match' requires at least one 'case' arm",
          line: kw.line,
          column: kw.column,
        });
      }
      return {
        kind: 'Match',
        scrutinee,
        arms,
        span: this.spanOf(kw),
      };
    }

    // Lambda: `@0 x => body`, `@1 x => body`, `@2 x => body`
    if (this.peek().kind === 'at') {
      const atTok = this.next();
      const q = this.parseQuantityNumber();
      const paramTok = this.expect('ident', 'lambda parameter');
      this.expect('fatarrow', "'=>'");
      const body = this.parseTerm();
      return {
        kind: 'Lam',
        q,
        param: paramTok.text || '_',
        body,
        span: this.spanOf(atTok),
      };
    }

    return this.parseEquality();
  }

  private parseEquality(): Term {
    let left = this.parseLogicalOr();
    if (this.match('eqeq')) {
      const right = this.parseLogicalOr();
      left = { kind: 'Eq', lhs: left, rhs: right, span: left.span };
    } else if (this.match('neq')) {
      const right = this.parseLogicalOr();
      left = { kind: 'BinOp', op: 'Neq', lhs: left, rhs: right, span: left.span };
    }
    return left;
  }

  private parseLogicalOr(): Term {
    let left = this.parseLogicalAnd();
    while (this.match('oror')) {
      const right = this.parseLogicalAnd();
      left = { kind: 'BinOp', op: 'Or', lhs: left, rhs: right, span: left.span };
    }
    return left;
  }

  private parseLogicalAnd(): Term {
    let left = this.parseComparison();
    while (this.match('andand')) {
      const right = this.parseComparison();
      left = { kind: 'BinOp', op: 'And', lhs: left, rhs: right, span: left.span };
    }
    return left;
  }

  private parseComparison(): Term {
    let left = this.parseAdditive();
    const cmpMap: Partial<Record<TokenKind, BinOpKind>> = {
      lt: 'Lt',
      le: 'Le',
      gt: 'Gt',
      ge: 'Ge',
    };
    const op = cmpMap[this.peek().kind];
    if (op) {
      this.next();
      const right = this.parseAdditive();
      left = { kind: 'BinOp', op, lhs: left, rhs: right, span: left.span };
    }
    return left;
  }

  private parseAdditive(): Term {
    let left = this.parseUnary();
    while (true) {
      if (this.match('plus')) {
        const right = this.parseUnary();
        left = { kind: 'Add', lhs: left, rhs: right, span: left.span };
      } else if (this.match('minus')) {
        const right = this.parseUnary();
        left = { kind: 'Sub', lhs: left, rhs: right, span: left.span };
      } else {
        break;
      }
    }
    return left;
  }

  private parseUnary(): Term {
    if (this.peek().kind === 'bang') {
      const tok = this.next();
      const operand = this.parseUnary();
      return { kind: 'Not', operand, span: this.spanOf(tok) };
    }
    return this.parseApplication();
  }

  private parseApplication(): Term {
    let term = this.parseAtom();
    while (true) {
      if (this.peek().kind === 'lbracket') {
        const lb = this.next();
        const q = this.parseQuantityNumber();
        this.expect('rbracket', "']'");
        this.expect('lparen', "'('");
        const arg = this.parseTerm();
        this.expect('rparen', "')'");
        term = {
          kind: 'App',
          q,
          func: term,
          arg,
          span: this.spanOf(lb),
        };
      } else if (this.peek().kind === 'lparen') {
        const lp = this.next();
        const args: Term[] = [];
        if (this.peek().kind !== 'rparen') {
          args.push(this.parseTerm());
          while (this.match('comma')) {
            if (this.peek().kind === 'rparen') break;
            args.push(this.parseTerm());
          }
        }
        this.expect('rparen', "')'");
        if (args.length === 0) {
          this.errors.push({
            message: 'Application requires at least one argument',
            line: lp.line,
            column: lp.column,
          });
        } else {
          for (const arg of args) {
            term = {
              kind: 'App',
              q: Quantity.Live,
              func: term,
              arg,
              span: this.spanOf(lp),
            };
          }
        }
      } else {
        break;
      }
    }
    return term;
  }

  private parseAtom(): Term {
    const tok = this.peek();

    if (tok.kind === 'nat') {
      this.next();
      const value = Number.parseInt(tok.text.replace(/n$/, ''), 10);
      return { kind: 'Nat', value: Number.isNaN(value) ? 0 : value, span: this.spanOf(tok) };
    }

    if (tok.kind === 'kw_true') {
      this.next();
      return { kind: 'Bool', value: true, span: this.spanOf(tok) };
    }

    if (tok.kind === 'kw_false') {
      this.next();
      return { kind: 'Bool', value: false, span: this.spanOf(tok) };
    }

    if (tok.kind === 'kw_refl') {
      this.next();
      return { kind: 'Refl', span: this.spanOf(tok) };
    }

    if (tok.kind === 'kw_Type') {
      this.next();
      return { kind: 'Univ', q: Quantity.Live, span: this.spanOf(tok) };
    }

    if (tok.kind === 'kw_Data') {
      this.next();
      return { kind: 'Univ', q: Quantity.Data, span: this.spanOf(tok) };
    }

    if (tok.kind === 'kw_Dead') {
      this.next();
      return { kind: 'Univ', q: Quantity.Dead, span: this.spanOf(tok) };
    }

    if (tok.kind === 'star') {
      this.next();
      const q = this.parseQuantityNumber();
      return { kind: 'Univ', q, span: this.spanOf(tok) };
    }

    if (tok.kind === 'ident') {
      this.next();
      return { kind: 'Var', name: tok.text, span: this.spanOf(tok) };
    }

    if (tok.kind === 'lparen') {
      this.next();
      const first = this.parseTerm();
      if (this.match('comma')) {
        const second = this.parseTerm();
        this.expect('rparen', "')'");
        return { kind: 'Tup', fst: first, snd: second, span: this.spanOf(tok) };
      }
      if (this.match('colon')) {
        const ty = this.parseTerm();
        this.expect('rparen', "')'");
        return { kind: 'Ann', term: first, ty, span: this.spanOf(tok) };
      }
      this.expect('rparen', "')'");
      return first;
    }

    this.errors.push({
      message: `Unexpected token '${tok.text || 'end of file'}' while parsing term`,
      line: tok.line,
      column: tok.column,
    });
    this.next();
    return { kind: 'Var', name: '<error>', span: this.spanOf(tok) };
  }
}

export function parseBendBook(source: string): ParseResult {
  const { tokens, errors: lexErrors } = tokenize(source);
  const parser = new Parser(tokens);
  const book = parser.parseBook();
  const errors = [...lexErrors, ...parser.errors];
  return {
    book: errors.length === 0 ? book : book,
    errors,
  };
}
