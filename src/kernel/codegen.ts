import { Book, Def, Pattern, Quantity, Term, TypeDef, binOpSymbol } from './ast';
import { CheckReport } from './checker';

function bendTypeToRust(ty: Term, typeParams: Set<string>): string {
  switch (ty.kind) {
    case 'Var':
      if (ty.name === 'Nat') return 'u64';
      if (ty.name === 'Bool') return 'bool';
      if (typeParams.has(ty.name)) return ty.name;
      return ty.name;
    case 'Tup':
      return `(${bendTypeToRust(ty.fst, typeParams)}, ${bendTypeToRust(ty.snd, typeParams)})`;
    case 'Univ':
      return '()';
    default:
      return 'u64';
  }
}

function collectCallChain(term: Term): { fnName: string; args: Term[] } | null {
  const args: Term[] = [];
  let cur: Term = term;
  while (cur.kind === 'App') {
    args.unshift(cur.arg);
    cur = cur.func;
  }
  if (cur.kind === 'Var') {
    return { fnName: cur.name, args };
  }
  return null;
}

interface CtorLookupEntry {
  typeName: string;
  variantName: string;
  arity: number;
}

function buildCtorLookup(types: TypeDef[]): Map<string, CtorLookupEntry> {
  const map = new Map<string, CtorLookupEntry>();
  for (const td of types) {
    for (const v of td.variants) {
      const entry: CtorLookupEntry = {
        typeName: td.name,
        variantName: v.name,
        arity: v.fields.length,
      };
      map.set(`${td.name}.${v.name}`, entry);
      if (!map.has(v.name)) {
        map.set(v.name, entry);
      }
    }
  }
  return map;
}

function emitRustPattern(pat: Pattern, ctorLookup: Map<string, CtorLookupEntry>): string {
  switch (pat.kind) {
    case 'PatWild':
      return '_';
    case 'PatBool':
      return pat.value ? 'true' : 'false';
    case 'PatNat':
      return `${pat.value}_u64`;
    case 'PatCtor': {
      const qualified = pat.typeName
        ? `${pat.typeName}::${pat.ctor}`
        : ctorLookup.has(pat.ctor)
          ? `${ctorLookup.get(pat.ctor)!.typeName}::${pat.ctor}`
          : pat.ctor;
      return pat.args.length > 0 ? `${qualified}(${pat.args.join(', ')})` : qualified;
    }
  }
}

function emitRustExpr(
  term: Term,
  defLookup: Map<string, Def>,
  ctorLookup: Map<string, CtorLookupEntry>,
  indentLevel = 1
): string {
  const pad = '    '.repeat(indentLevel);
  const innerPad = '    '.repeat(indentLevel + 1);

  switch (term.kind) {
    case 'Var': {
      const ctor = ctorLookup.get(term.name);
      if (ctor && ctor.arity === 0) {
        return `${ctor.typeName}::${ctor.variantName}`;
      }
      return term.name.replace('.', '::');
    }
    case 'Nat':
      return `${term.value}_u64`;
    case 'Bool':
      return term.value ? 'true' : 'false';
    case 'Not':
      return `!(${emitRustExpr(term.operand, defLookup, ctorLookup, indentLevel)})`;
    case 'BinOp':
      return `(${emitRustExpr(term.lhs, defLookup, ctorLookup, indentLevel)} ${binOpSymbol(term.op)} ${emitRustExpr(term.rhs, defLookup, ctorLookup, indentLevel)})`;
    case 'Add':
      return `(${emitRustExpr(term.lhs, defLookup, ctorLookup, indentLevel)}).saturating_add(${emitRustExpr(term.rhs, defLookup, ctorLookup, indentLevel)})`;
    case 'Sub':
      return `(${emitRustExpr(term.lhs, defLookup, ctorLookup, indentLevel)}).saturating_sub(${emitRustExpr(term.rhs, defLookup, ctorLookup, indentLevel)})`;
    case 'If':
      return [
        `if ${emitRustExpr(term.cond, defLookup, ctorLookup, indentLevel)} {`,
        `${innerPad}${emitRustExpr(term.thenBranch, defLookup, ctorLookup, indentLevel + 1)}`,
        `${pad}} else {`,
        `${innerPad}${emitRustExpr(term.elseBranch, defLookup, ctorLookup, indentLevel + 1)}`,
        `${pad}}`,
      ].join('\n');
    case 'Match': {
      const scrut = emitRustExpr(term.scrutinee, defLookup, ctorLookup, indentLevel);
      const arms = term.arms
        .map(
          (arm) =>
            `${innerPad}${emitRustPattern(arm.pattern, ctorLookup)} => ${emitRustExpr(arm.body, defLookup, ctorLookup, indentLevel + 1)},`
        )
        .join('\n');
      return `match ${scrut} {\n${arms}\n${pad}}`;
    }
    case 'Tup':
      return `(${emitRustExpr(term.fst, defLookup, ctorLookup, indentLevel)}, ${emitRustExpr(term.snd, defLookup, ctorLookup, indentLevel)})`;
    case 'Let':
      return `{\n${innerPad}let ${term.name} = ${emitRustExpr(term.value, defLookup, ctorLookup, indentLevel + 1)};\n${innerPad}${emitRustExpr(term.body, defLookup, ctorLookup, indentLevel + 1)}\n${pad}}`;
    case 'Lam':
      return `|${term.param}| ${emitRustExpr(term.body, defLookup, ctorLookup, indentLevel)}`;
    case 'App': {
      const chain = collectCallChain(term);
      if (chain) {
        const ctor = ctorLookup.get(chain.fnName);
        if (ctor) {
          const emittedArgs = chain.args
            .map((a) => emitRustExpr(a, defLookup, ctorLookup, indentLevel))
            .join(', ');
          return `${ctor.typeName}::${ctor.variantName}(${emittedArgs})`;
        }
        const targetDef = defLookup.get(chain.fnName);
        if (targetDef) {
          // Drop arguments corresponding to Dead (q=0) erased parameters
          const liveArgs: Term[] = [];
          for (let i = 0; i < chain.args.length; i++) {
            const param = targetDef.params[i];
            if (param && param.q === Quantity.Dead) continue;
            liveArgs.push(chain.args[i]);
          }
          return `${chain.fnName}(${liveArgs.map((a) => emitRustExpr(a, defLookup, ctorLookup, indentLevel)).join(', ')})`;
        }
        return `${chain.fnName.replace('.', '::')}(${chain.args.map((a) => emitRustExpr(a, defLookup, ctorLookup, indentLevel)).join(', ')})`;
      }
      return `(${emitRustExpr(term.func, defLookup, ctorLookup, indentLevel)})(${emitRustExpr(term.arg, defLookup, ctorLookup, indentLevel)})`;
    }
    case 'Ann':
      return emitRustExpr(term.term, defLookup, ctorLookup, indentLevel);
    case 'Rewrite':
    case 'Refl':
    case 'Eq':
    case 'Univ':
      return '()';
  }
}

function inferTupleReturn(body: Term, declaredRet: Term, typeParams: Set<string>): string {
  if (body.kind === 'Tup' && declaredRet.kind !== 'Tup') {
    const elemTy = bendTypeToRust(declaredRet, typeParams);
    return `(${elemTy}, ${elemTy})`;
  }
  return bendTypeToRust(declaredRet, typeParams);
}

function emitRustTypeDef(td: TypeDef): string {
  const emptySet = new Set<string>();
  const variants = td.variants
    .map((v) => {
      if (v.fields.length === 0) {
        return `    ${v.name},`;
      }
      const fieldTypes = v.fields
        .map((f) => bendTypeToRust(f.ty, emptySet))
        .join(', ');
      return `    ${v.name}(${fieldTypes}),`;
    })
    .join('\n');

  return [
    '#[derive(Debug, Clone, Copy, PartialEq, Eq)]',
    `pub enum ${td.name} {`,
    variants,
    '}',
  ].join('\n');
}

/**
 * Emits pure, zero-dependency Rust source code from a verified & erased BendTT Book.
 * Enforces the RustyBends invariant: if any law or quantity check fails, refuses to emit
 * callable Rust functions and emits a compile_error! guard instead.
 */
export function emitVerifiedRust(sourceBook: Book, report: CheckReport): string {
  if (!report.buildPassed) {
    const reasons = report.diagnostics
      .map((d) => `//   [${d.code}] ${d.scope}: ${d.message}`)
      .join('\n');
    return [
      '// RustyBends build gate blocked codegen: one or more checks or laws failed.',
      reasons || '//   Parse or kernel error prevented codegen.',
      '',
      'compile_error!("RustyBends verification failed — fix all Bend 2 errors and laws before compiling.");',
    ].join('\n');
  }

  const types = sourceBook.types ?? [];
  const ctorLookup = buildCtorLookup(types);
  const defLookup = new Map<string, Def>();
  for (const def of sourceBook.defs) {
    defLookup.set(def.name, def);
  }

  const header = [
    '// @generated by RustyBends v1 (Verified Core -> Pure Rust)',
    '// Zero Bend runtime. Zero proof code in final binary.',
    '// All q=0 types and laws were checked and erased.',
    `// Types: ${types.length} · Laws proven: ${report.lawVerdicts.length} · Dead params erased: ${report.erasure.deadParamsErased}`,
    '',
  ];

  const blocks: string[] = [];
  for (const td of types) {
    blocks.push(emitRustTypeDef(td));
  }

  for (const erasedDef of report.erasure.erasedBook.defs) {
    const originalDef = defLookup.get(erasedDef.name) ?? erasedDef;
    const typeParams = new Set<string>(
      originalDef.params
        .filter((p) => p.q === Quantity.Dead && p.ty.kind === 'Univ')
        .map((p) => p.name)
    );

    const generics =
      typeParams.size > 0 ? `<${Array.from(typeParams).join(', ')}>` : '';
    const params = erasedDef.params
      .map((p) => `${p.name}: ${bendTypeToRust(p.ty, typeParams)}`)
      .join(', ');
    const retTy = inferTupleReturn(erasedDef.body, originalDef.ret, typeParams);
    const bodyExpr = emitRustExpr(erasedDef.body, defLookup, ctorLookup, 1);

    blocks.push(
      [
        '#[inline]',
        `pub fn ${erasedDef.name}${generics}(${params}) -> ${retTy} {`,
        `    ${bodyExpr}`,
        '}',
      ].join('\n')
    );
  }

  if (blocks.length === 0) {
    return `${header.join('\n')}\n// No live definitions in book.\n`;
  }

  return `${header.join('\n')}\n${blocks.join('\n\n')}\n`;
}
