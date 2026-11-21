import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Book, Def, Law, Quantity, Term, quantityCode } from '../kernel/ast';

interface AstTreeProps {
  book: Book;
}

function quantityTextClass(q: Quantity): string {
  switch (q) {
    case Quantity.Dead:
      return 'text-slate-500';
    case Quantity.Live:
      return 'text-blue-700';
    case Quantity.Data:
      return 'text-emerald-700';
  }
}

function quantityLabel(q: Quantity): string {
  return `${q} (${quantityCode(q)})`;
}

interface TreeNodeProps {
  label: string;
  meta?: string;
  metaClass?: string;
  children?: React.ReactNode;
  defaultOpen?: boolean;
}

const TreeNode: React.FC<TreeNodeProps> = ({
  label,
  meta,
  metaClass = 'text-slate-500',
  children,
  defaultOpen = true,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const hasChildren = React.Children.count(children) > 0;

  return (
    <div className="font-mono text-xs leading-6">
      <div className="flex items-center gap-1.5 py-0.5 hover:bg-slate-100/80 rounded px-1 -mx-1">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
            className="text-slate-400 hover:text-slate-700 p-0.5 rounded focus-visible:outline-2 focus-visible:outline-blue-600"
          >
            {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="w-4 inline-block shrink-0" />
        )}
        <span className="text-slate-900 font-medium">{label}</span>
        {meta && (
          <>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span className={metaClass}>{meta}</span>
          </>
        )}
      </div>
      {hasChildren && open && (
        <div className="ml-4 pl-3 border-l border-slate-200">{children}</div>
      )}
    </div>
  );
};

const TermNode: React.FC<{ role?: string; term: Term }> = ({ role, term }) => {
  const prefix = role ? `${role}: ` : '';

  switch (term.kind) {
    case 'Var':
      return <TreeNode label={`${prefix}Term::Var`} meta={`"${term.name}"`} />;
    case 'Nat':
      return (
        <TreeNode
          label={`${prefix}Term::Nat`}
          meta={`${term.value}n`}
          metaClass="text-emerald-700 tabular-nums"
        />
      );
    case 'Refl':
      return (
        <TreeNode
          label={`${prefix}Refl`}
          meta="reflexivity proof · q=0"
          metaClass="text-slate-500"
        />
      );
    case 'Univ':
      return (
        <TreeNode
          label={`${prefix}Term::Univ`}
          meta={quantityLabel(term.q)}
          metaClass={quantityTextClass(term.q)}
        />
      );
    case 'Add':
      return (
        <TreeNode label={`${prefix}Add`} meta="Nat + Nat" metaClass="text-emerald-700">
          <TermNode role="lhs" term={term.lhs} />
          <TermNode role="rhs" term={term.rhs} />
        </TreeNode>
      );
    case 'Sub':
      return (
        <TreeNode label={`${prefix}Sub`} meta="Nat - Nat (saturating)" metaClass="text-emerald-700">
          <TermNode role="lhs" term={term.lhs} />
          <TermNode role="rhs" term={term.rhs} />
        </TreeNode>
      );
    case 'Eq':
      return (
        <TreeNode label={`${prefix}Eq`} meta="Dead (q=0) proposition" metaClass="text-slate-500">
          <TermNode role="lhs" term={term.lhs} />
          <TermNode role="rhs" term={term.rhs} />
        </TreeNode>
      );
    case 'Lam':
      return (
        <TreeNode
          label={`${prefix}Term::Lam`}
          meta={`param "${term.param}" · ${quantityLabel(term.q)}`}
          metaClass={quantityTextClass(term.q)}
        >
          <TermNode role="body" term={term.body} />
        </TreeNode>
      );
    case 'App':
      return (
        <TreeNode
          label={`${prefix}Term::App`}
          meta={quantityLabel(term.q)}
          metaClass={quantityTextClass(term.q)}
        >
          <TermNode role="func" term={term.func} />
          <TermNode role="arg" term={term.arg} />
        </TreeNode>
      );
    case 'Tup':
      return (
        <TreeNode label={`${prefix}Term::Tup`}>
          <TermNode role="fst" term={term.fst} />
          <TermNode role="snd" term={term.snd} />
        </TreeNode>
      );
    case 'Let':
      return (
        <TreeNode label={`${prefix}Term::Let`} meta={`bind "${term.name}"`}>
          <TermNode role="value" term={term.value} />
          <TermNode role="body" term={term.body} />
        </TreeNode>
      );
    case 'Bool':
      return (
        <TreeNode
          label={`${prefix}Term::Bool`}
          meta={term.value ? 'true' : 'false'}
          metaClass="text-emerald-700"
        />
      );
    case 'Not':
      return (
        <TreeNode label={`${prefix}Not`} meta="boolean negation">
          <TermNode role="operand" term={term.operand} />
        </TreeNode>
      );
    case 'BinOp':
      return (
        <TreeNode label={`${prefix}BinOp`} meta={term.op} metaClass="text-emerald-700">
          <TermNode role="lhs" term={term.lhs} />
          <TermNode role="rhs" term={term.rhs} />
        </TreeNode>
      );
    case 'If':
      return (
        <TreeNode label={`${prefix}If`} meta="conditional">
          <TermNode role="cond" term={term.cond} />
          <TermNode role="then" term={term.thenBranch} />
          <TermNode role="else" term={term.elseBranch} />
        </TreeNode>
      );
    case 'Match':
      return (
        <TreeNode
          label={`${prefix}Match`}
          meta={`${term.arms.length} arm${term.arms.length === 1 ? '' : 's'}`}
        >
          <TermNode role="scrutinee" term={term.scrutinee} />
          {term.arms.map((arm, idx) => (
            <TermNode
              key={idx}
              role={`case ${arm.pattern.kind === 'PatCtor' ? arm.pattern.ctor : arm.pattern.kind}`}
              term={arm.body}
            />
          ))}
        </TreeNode>
      );
    case 'Rewrite':
      return (
        <TreeNode
          label={`${prefix}Rewrite`}
          meta={`${term.reverse ? '<- ' : ''}${term.lemma} · q=0`}
          metaClass="text-slate-500"
        >
          <TermNode role="rest" term={term.rest} />
        </TreeNode>
      );
    case 'Ann':
      return (
        <TreeNode
          label={`${prefix}Term::Ann`}
          meta="type is Dead (q=0), erased"
          metaClass="text-slate-500"
        >
          <TermNode role="term" term={term.term} />
          <TermNode role="ty (q=0)" term={term.ty} />
        </TreeNode>
      );
  }
};

const DefNode: React.FC<{ def: Def }> = ({ def }) => (
  <TreeNode
    label={`Def ${def.name}`}
    meta={`${def.params.length} param${def.params.length === 1 ? '' : 's'}`}
  >
    {def.params.map((p, idx) => (
      <TreeNode
        key={`${p.name}-${idx}`}
        label={`param ${p.name}`}
        meta={quantityLabel(p.q)}
        metaClass={quantityTextClass(p.q)}
      >
        <TermNode role="ty (q=0)" term={p.ty} />
      </TreeNode>
    ))}
    <TermNode role="ret (q=0)" term={def.ret} />
    <TermNode role="body" term={def.body} />
  </TreeNode>
);

const LawNode: React.FC<{ law: Law }> = ({ law }) => (
  <TreeNode
    label={`Law ${law.name}`}
    meta={`Dead (q=0) · ${law.proof ? 'proof attached' : 'missing proof'}`}
    metaClass={law.proof ? 'text-emerald-700' : 'text-red-600'}
  >
    {law.vars.map((v, idx) => (
      <TreeNode
        key={`${v.name}-${idx}`}
        label={`for ${v.name}`}
        meta={quantityLabel(v.q)}
        metaClass={quantityTextClass(v.q)}
      >
        <TermNode role="ty" term={v.ty} />
      </TreeNode>
    ))}
    <TermNode role="statement" term={law.statement} />
    {law.proof && <TermNode role="proof" term={law.proof} />}
  </TreeNode>
);

export const AstTree: React.FC<AstTreeProps> = ({ book }) => {
  const types = book.types ?? [];
  if (types.length === 0 && book.defs.length === 0 && book.laws.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-slate-500">
        No definitions or laws parsed yet. Write a <code className="text-slate-800">type</code>,{' '}
        <code className="text-slate-800">def</code>, or <code className="text-slate-800">law</code>{' '}
        in the editor to inspect its BendTT AST.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <TreeNode
        label="Book"
        meta={`${types.length} type${types.length === 1 ? '' : 's'} · ${book.defs.length} def${book.defs.length === 1 ? '' : 's'} · ${book.laws.length} law${book.laws.length === 1 ? '' : 's'}`}
      >
        {types.map((td, i) => (
          <TreeNode
            key={`${td.name}-${i}`}
            label={`Type ${td.name}`}
            meta={`${td.variants.length} variant${td.variants.length === 1 ? '' : 's'}`}
            metaClass="text-emerald-700"
          >
            {td.variants.map((v, vi) => (
              <TreeNode
                key={`${v.name}-${vi}`}
                label={v.name}
                meta={v.fields.length > 0 ? `${v.fields.length} field(s)` : 'unit'}
              />
            ))}
          </TreeNode>
        ))}
        {book.defs.map((def, i) => (
          <DefNode key={`${def.name}-${i}`} def={def} />
        ))}
        {book.laws.map((law, i) => (
          <LawNode key={`${law.name}-${i}`} law={law} />
        ))}
      </TreeNode>
    </div>
  );
};
