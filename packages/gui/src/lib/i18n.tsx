/**
 * Tiny i18n for the GUI (English / 简体中文), ported in spirit from PiStudio.
 * A React context gives every component `t()` and the current language; the
 * choice is persisted in localStorage and reflected on <html lang>.
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export type Lang = 'en' | 'zh'

type Dict = Record<string, string>

const en: Dict = {
  'tabs.chat': 'chat',
  'tabs.trace': 'trace',
  'tabs.changes': 'changes',
  'theme.toggle': 'Toggle theme',
  'sessions.title': 'sessions · {n}',
  'sessions.new': '+ new',
  'sessions.empty': 'no sessions yet',
  'chat.empty': 'Send a task to start.',
  'composer.placeholder': 'Ask the agent…  Enter sends · Shift+Enter newline',
  'composer.running': 'running…',
  'composer.send': 'send',
  'agents.title': 'agents · {tok} tok · {cost}',
  'agents.empty': 'no agents yet',
  'agents.tool': '{n} tool',
  'agents.tools': '{n} tools',
  'agents.errors': '{n} err',
  'trace.title': 'trace · {at}/{total}',
  'trace.replay': 'replay',
  'trace.live': 'live',
  'changes.title': 'changes · {n} isolated',
  'changes.integrateAll': 'integrate all',
  'changes.diff': 'diff',
  'changes.promote': 'promote',
  'changes.empty': 'No isolated agents. Start the server with MICRO_ISOLATE=1 and ask the agent to use the task tool.',
  'changes.queue': 'merge queue · {n} file(s)',
  'changes.applyClean': 'apply clean',
  'changes.close': 'close',
  'changes.clean': 'clean',
  'changes.conflict': 'conflict',
  'changes.pending': '{n} pending',
  'changes.promoted': 'promoted {n} file(s)',
  'changes.promotedConflicts': ' · {n} conflict(s)',
  'changes.integrated': 'integrated {n} file(s)',
  'changes.failed': 'promote failed: {error}',
}

const zh: Dict = {
  'tabs.chat': '对话',
  'tabs.trace': '轨迹',
  'tabs.changes': '改动',
  'theme.toggle': '切换主题',
  'sessions.title': '会话 · {n}',
  'sessions.new': '＋ 新建',
  'sessions.empty': '还没有会话',
  'chat.empty': '发一个任务开始。',
  'composer.placeholder': '问点什么…  Enter 发送 · Shift+Enter 换行',
  'composer.running': '运行中…',
  'composer.send': '发送',
  'agents.title': 'agents · {tok} tok · {cost}',
  'agents.empty': '还没有 agent',
  'agents.tool': '{n} 个工具',
  'agents.tools': '{n} 个工具',
  'agents.errors': '{n} 个错误',
  'trace.title': '轨迹 · {at}/{total}',
  'trace.replay': '回放',
  'trace.live': '实时',
  'changes.title': '改动 · {n} 个隔离 agent',
  'changes.integrateAll': '整合全部',
  'changes.diff': '差异',
  'changes.promote': '合并回主干',
  'changes.empty': '没有隔离的 agent。用 MICRO_ISOLATE=1 启动服务，并让 agent 使用 task 工具。',
  'changes.queue': '合并队列 · {n} 个文件',
  'changes.applyClean': '应用无冲突',
  'changes.close': '关闭',
  'changes.clean': '干净',
  'changes.conflict': '冲突',
  'changes.pending': '{n} 待处理',
  'changes.promoted': '已合并 {n} 个文件',
  'changes.promotedConflicts': ' · {n} 个冲突',
  'changes.integrated': '已整合 {n} 个文件',
  'changes.failed': '合并失败：{error}',
}

const DICTS: Record<Lang, Dict> = { en, zh }

export interface I18n {
  lang: Lang
  setLang: (l: Lang) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

const Ctx = createContext<I18n | null>(null)

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const stored = localStorage.getItem('micro-lang')
    if (stored === 'en' || stored === 'zh') return stored
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  })

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const setLang = useCallback((l: Lang) => {
    localStorage.setItem('micro-lang', l)
    setLangState(l)
  }, [])

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      let s = DICTS[lang][key] ?? DICTS.en[key] ?? key
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
      return s
    },
    [lang],
  )

  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>
}

export function useT(): I18n {
  const value = useContext(Ctx)
  if (!value) throw new Error('useT must be used inside <LangProvider>')
  return value
}
