import type { AgentNode } from '../lib/derive.ts'
import { useT } from '../lib/i18n.tsx'
import { fmtCost, fmtTokens } from '../lib/format.ts'

interface AgentsPanelProps {
  roots: AgentNode[]
  total: { input: number; output: number; cost: number }
}

/** Agent tree with connectors, per-agent usage and a hover detail card. */
export function AgentsPanel({ roots, total }: AgentsPanelProps) {
  const { t } = useT()
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2 font-mono text-[11px] text-muted-foreground">
        {t('agents.title', { tok: fmtTokens(total.input + total.output), cost: fmtCost(total.cost) })}
      </div>
      <div role="tree" aria-label={t('a11y.agentTree')} className="min-h-0 flex-1 overflow-y-auto p-2">
        {roots.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <span className="grid h-8 w-8 grid-cols-2 gap-0.5" aria-hidden="true">
              <span className="rounded-[3px] border border-teal/40 bg-teal/10" />
              <span className="rounded-[3px] border border-border" />
              <span className="rounded-[3px] border border-border" />
              <span className="rounded-[3px] border border-border" />
            </span>
            <p className="text-[11px] text-muted-foreground">{t('agents.empty')}</p>
          </div>
        )}
        {roots.map((n) => (
          <AgentRow key={n.agentId} node={n} />
        ))}
      </div>
    </div>
  )
}

function AgentRow({ node }: { node: AgentNode }) {
  const { t } = useT()
  const label = node.agentId === 'main' ? 'main' : node.agentId.split('/').pop() || node.agentId
  const dot =
    node.status === 'error' ? 'bg-destructive' : node.status === 'active' ? 'animate-pulse-soft bg-gold' : 'bg-teal'

  return (
    <div role="treeitem" aria-expanded={node.children.length > 0 ? true : undefined}>
      <div
        className={`group relative rounded-lg border px-2.5 py-1.5 text-[12px] transition ${
          node.status === 'active' ? 'border-gold/40 bg-gold/5' : 'border-border bg-card/70 hover:border-teal/40'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
          <span className="min-w-0 truncate font-mono font-medium">{label}</span>
          {node.worktree && (
            <span
              className="shrink-0 rounded border border-teal/40 bg-teal/10 px-1 text-[9px] font-medium text-teal"
              title={node.worktree.branch}
            >
              wt
            </span>
          )}
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
            {fmtTokens(node.input + node.output)} tok{node.cost ? ' · ' + fmtCost(node.cost) : ''}
          </span>
        </div>
        {node.tools > 0 && (
          <div className="mt-0.5 pl-3.5 font-mono text-[10px] text-muted-foreground">
            {node.tools > 1 ? t('agents.tools', { n: node.tools }) : t('agents.tool', { n: node.tools })}
            {node.errors ? <span className="text-destructive"> · {t('agents.errors', { n: node.errors })}</span> : ''}
          </div>
        )}

        {/* hover detail card */}
        <div
          role="tooltip"
          className="pointer-events-none absolute left-full top-0 z-20 ml-2 hidden w-52 rounded-lg border border-border bg-popover p-2.5 font-mono text-[10px] leading-relaxed text-muted-foreground shadow-xl group-hover:block"
        >
          <div className="mb-1 flex items-center gap-1.5 text-foreground">
            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
            {label}
          </div>
          <div>
            {t('agents.status')}: {node.status}
          </div>
          <div>
            {t('agents.inOut', { in: fmtTokens(node.input), out: fmtTokens(node.output) })}
          </div>
          <div>
            {t('agents.tools', { n: node.tools })}
            {node.errors ? ' · ' + t('agents.errors', { n: node.errors }) : ''}
          </div>
          {node.cost ? <div>{fmtCost(node.cost)}</div> : null}
          {node.worktree && <div className="mt-1 truncate text-teal">{node.worktree.branch}</div>}
        </div>
      </div>

      {node.children.length > 0 && (
        <div role="group" className="relative ml-3.5 mt-1 space-y-1 pl-3.5">
          {/* vertical spine */}
          <span className="absolute bottom-3 left-0 top-0 w-px bg-border" aria-hidden="true" />
          {node.children.map((c) => (
            <div key={c.agentId} className="relative">
              {/* elbow into the child */}
              <span className="absolute -left-3.5 top-3.5 h-px w-3.5 bg-border" aria-hidden="true" />
              <AgentRow node={c} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
