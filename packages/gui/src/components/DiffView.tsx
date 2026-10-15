import { annotateDiff } from '../lib/derive.ts'

const KIND_CLASS: Record<string, string> = {
  add: 'bg-teal/10 text-teal',
  del: 'bg-destructive/10 text-destructive',
  hunk: 'bg-gold/5 text-gold/90',
  file: 'text-muted-foreground',
  meta: 'text-muted-foreground/70',
  ctx: 'text-muted-foreground',
}

const SIGN: Record<string, string> = { add: '+', del: '-', ctx: ' ' }

/** A colored unified diff: line-number gutter, +green, -red, @@ hunks. */
export function DiffView({ text, className = '' }: { text: string; className?: string }) {
  const lines = annotateDiff(text.split('\n').slice(0, 2000).join('\n'))
  return (
    <div className={`${className} overflow-auto bg-muted/20 py-1 font-mono text-[10px] leading-5`}>
      {lines.map((l, i) => (
        <div key={i} className={`flex items-start ${KIND_CLASS[l.kind]}`}>
          <span className="w-8 shrink-0 select-none pr-1.5 text-right text-muted-foreground/40">{l.old ?? ''}</span>
          <span className="w-8 shrink-0 select-none pr-1.5 text-right text-muted-foreground/40">{l.new ?? ''}</span>
          <span className="w-3 shrink-0 select-none text-center opacity-60">{SIGN[l.kind] ?? ' '}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-2.5">{l.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}
