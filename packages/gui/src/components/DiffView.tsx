/** A colored unified-diff view: +green, -red, @@ hunk headers, file headers. */
export function DiffView({ text, className = '' }: { text: string; className?: string }) {
  const lines = text.split('\n').slice(0, 2000)
  return (
    <div className={`${className} overflow-auto bg-muted/20 py-1 font-mono text-[10px] leading-5`}>
      {lines.map((line, i) => {
        const kind =
          line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')
            ? 'file'
            : line.startsWith('@@')
              ? 'hunk'
              : line.startsWith('+++') || line.startsWith('---')
                ? 'meta'
                : line.startsWith('+')
                  ? 'add'
                  : line.startsWith('-')
                    ? 'del'
                    : 'ctx'
        const cls =
          kind === 'add'
            ? 'bg-teal/10 text-teal'
            : kind === 'del'
              ? 'bg-destructive/10 text-destructive'
              : kind === 'hunk'
                ? 'bg-gold/5 text-gold/90'
                : kind === 'file'
                  ? 'text-muted-foreground'
                  : kind === 'meta'
                    ? 'text-muted-foreground/70'
                    : 'text-muted-foreground'
        return (
          <div key={i} className={`whitespace-pre-wrap break-words px-2.5 ${cls}`}>
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}
