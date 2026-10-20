import { useT } from '../lib/i18n.tsx'
import type { WebProvider } from '../lib/api.ts'
import { fmtCost, fmtTokens } from '../lib/format.ts'
import { RollingNumber, Sparkline } from './Fx.tsx'

// 由 Vite 解析共享品牌资源，生产构建自动生成可部署的资源地址。
const logoUrl = new URL('../../../../docs/logo.svg', import.meta.url).href

interface HeaderProps {
  current: string | null
  tokens: number
  cost: number
  budget?: number | null
  sandbox?: { mode: string; kind: string } | null
  series: number[]
  busy: boolean
  dark: boolean
  webEnabled: boolean
  webProvider: string
  webProviders: WebProvider[]
  onChangeProvider: (id: string) => void
  onToggleTheme: () => void
  onToggleWeb: () => void
  onToggleSessions: () => void
  onTogglePanel: () => void
  onShowUsage: () => void
}

/** Slim command bar: brand, current session, live usage, global actions. */
export function Header({ current, tokens, cost, budget, sandbox, series, busy, dark, webEnabled, webProvider, webProviders, onChangeProvider, onToggleTheme, onToggleWeb, onToggleSessions, onTogglePanel, onShowUsage }: HeaderProps) {
  const { t, lang, setLang } = useT()
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card/60 px-3 backdrop-blur">
      <button
        onClick={onToggleSessions}
        aria-label={t('a11y.toggleSessions')}
        className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M2 3.5h10M2 7h10M2 10.5h10" strokeLinecap="round" />
        </svg>
      </button>

      <span className="flex items-center gap-2">
        {/* 品牌图标与相邻名称共同展示，避免重复朗读。 */}
        <img src={logoUrl} alt="" aria-hidden="true" className="h-6 w-5 shrink-0" />
        <span className="text-[13px] font-semibold tracking-tight">micro-harness</span>
      </span>

      <span className="hidden min-w-0 items-center gap-1.5 rounded-full border border-border bg-background/60 px-2.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:flex">
        <span className={busy ? 'h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-gold' : 'h-1.5 w-1.5 shrink-0 rounded-full bg-teal'} />
        <span className="max-w-[220px] truncate">{current ?? t('header.noSession')}</span>
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={onShowUsage}
          title={t('usage.open')}
          className="hidden items-center gap-2 rounded-full border border-border bg-background/60 px-2.5 py-0.5 font-mono text-[10px] text-muted-foreground transition hover:bg-muted hover:text-foreground md:flex"
          aria-label={t('usage.open')}
        >
          <Sparkline values={series} className="text-teal/70" />
          <RollingNumber value={tokens} format={fmtTokens} /> tok
          <span className="opacity-40">·</span>
          <RollingNumber value={cost} format={fmtCost} />
          {budget != null && (
            <>
              <span className="opacity-40">·</span>
              <span className={budget - cost <= 0 ? 'text-destructive' : ''}>
                {t('header.budgetLeft')} {fmtCost(Math.max(0, budget - cost))}
              </span>
            </>
          )}
        </button>
        {webProviders.length > 1 && (
          <select
            value={webProvider}
            onChange={(e) => onChangeProvider(e.target.value)}
            aria-label={t('web.provider')}
            title={t('web.provider')}
            className="h-7 max-w-[112px] rounded-md border border-border bg-background/60 px-1 text-[10px] text-muted-foreground outline-none transition hover:text-foreground"
          >
            {webProviders.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.configured}>
                {p.configured ? p.label : `${p.label} · ${t('web.unconfigured')}`}
              </option>
            ))}
          </select>
        )}
        {sandbox && sandbox.kind !== 'none' && (
          <span
            title={t('sandbox.activeTitle', { kind: sandbox.kind })}
            className="hidden items-center gap-1 rounded-full border border-teal/40 bg-teal/10 px-2 py-0.5 font-mono text-[10px] text-teal sm:flex"
          >
            <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M7 1.5 2.5 3v4c0 3 2 5 4.5 5.5C9.5 12 11.5 10 11.5 7V3L7 1.5Z" strokeLinejoin="round" />
            </svg>
            {sandbox.kind}
          </span>
        )}
        {sandbox && sandbox.mode !== 'off' && sandbox.kind === 'none' && (
          <span
            title={t('sandbox.unavailableTitle')}
            className="hidden items-center gap-1 rounded-full border border-gold/40 bg-gold/10 px-2 py-0.5 font-mono text-[10px] text-gold sm:flex"
          >
            {t('sandbox.unavailable')}
          </span>
        )}
        <button
          onClick={onToggleWeb}
          aria-label={webEnabled ? t('web.on') : t('web.off')}
          title={webEnabled ? t('web.on') : t('web.off')}
          className={`grid h-7 w-7 place-items-center rounded-md text-[12px] transition hover:bg-muted ${
            webEnabled ? 'text-teal' : 'text-muted-foreground'
          }`}
        >
          {webEnabled ? '🌐' : '⛔'}
        </button>
        <button
          onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
          aria-label={t('a11y.lang')}
          className="grid h-7 w-7 place-items-center rounded-md text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          {lang === 'zh' ? 'EN' : '中'}
        </button>
        <button
          onClick={onToggleTheme}
          aria-label={t('theme.toggle')}
          className="grid h-7 w-7 place-items-center rounded-md text-[12px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          {dark ? '☀' : '☾'}
        </button>
        <button
          onClick={onTogglePanel}
          aria-label={t('a11y.togglePanel')}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" />
            <path d="M8.5 2.5v9" />
          </svg>
        </button>
      </div>
    </header>
  )
}
