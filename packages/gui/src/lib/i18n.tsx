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
  'palette.placeholder': 'Type a command or search sessions…',
  'palette.commands': 'command',
  'palette.sessions': 'session',
  'palette.noResults': 'no matches',
  'palette.newSession': 'New session',
  'palette.theme': 'Toggle theme',
  'palette.lang': 'Switch language',
  'agents.status': 'status',
  'agents.inOut': '↑{in} ↓{out}',
  'agents.cache': 'cache {tok} ({pct}%)',
  'shortcuts.title': 'Keyboard shortcuts',
  'shortcuts.palette': 'Command palette',
  'shortcuts.help': 'This cheat sheet',
  'shortcuts.nav': 'Move through lists',
  'shortcuts.send': 'Send the prompt',
  'shortcuts.newline': 'Newline in the prompt',
  'shortcuts.close': 'Close any dialog',
  'palette.exportMd': 'Export session as Markdown',  'palette.copyTrace': 'Copy trace as JSON',
  'palette.shortcuts': 'Keyboard shortcuts',
  'notify.done': 'the run finished',
  'tabs.inspector': 'inspector',
  'inspector.empty': 'No model call yet — send a prompt.',
  'inspector.title': 'inspector · {n} request',
  'inspector.request': 'request #{n}',
  'inspector.latest': 'latest',
  'inspector.system': 'system prompt',
  'inspector.tools': 'tools · {n}',
  'inspector.messages': 'messages · {n}',
  'inspector.tokens': '~{n} tokens',
  'inspector.copyJson': 'copy request as JSON',

  'changes.hunks': 'hunks',
  'changes.applySelected': 'apply selected ({n})',
  'changes.selectAll': 'all',
  'changes.selectNone': 'none',
  'changes.applied': 'applied to {n} file(s)',
  'changes.conflicted': '{n} hunk(s) no longer apply',

  'sessions.rename': 'rename',
  'sessions.renameTitle': 'Rename session',
  'composer.model': 'model',
  'composer.dropImage': 'drop an image…',
  'composer.removeImage': 'Remove image',
  'chat.edit': 'edit & resend',
  'chat.editTitle': 'Edit this message and branch the conversation',
  'chat.save': 'resend',
  'trace.all': 'all',
  'trace.text': 'text',
  'trace.tool': 'tool',
  'trace.usage': 'usage',
  'trace.error': 'error',
  'trace.search': 'filter events…',
  'sessions.today': 'Today',
  'sessions.yesterday': 'Yesterday',
  'sessions.earlier': 'Earlier',
  'common.delete': 'delete',
  'common.cancel': 'cancel',
  'chat.toBottom': 'back to bottom',
  'replay.badge': 'REPLAY',
  'changes.files': '{n} file(s)',
  'header.noSession': 'no session',
  'header.usage': '{tok} tok · {cost}',
  'header.idle': 'idle',
  'a11y.toggleSessions': 'Toggle session list',
  'a11y.togglePanel': 'Toggle side panel',
  'a11y.lang': 'Switch language',
  'a11y.composer': 'Message the agent',
  'a11y.transcript': 'Conversation transcript',
  'a11y.agentTree': 'Agent tree',
  'a11y.tabs': 'Side panel views',
  'composer.hintSend': 'Enter to send',
  'composer.hintNewline': 'Shift+Enter newline',
  'chat.streaming': 'streaming',
  'tool.running': 'running',
  'tool.showOutput': 'show output',
  'tool.hideOutput': 'hide output',
  'trace.scrubber': 'Replay position',
  'trace.empty': 'no events yet',
  'approval.title': 'approval needed',
  'approval.allow': 'Allow',
  'approval.deny': 'Deny',
  'approval.waiting': 'waiting for answer…',
  'approval.allowed': 'allowed',
  'approval.denied': 'denied',
  'approval.arguments': 'arguments',
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
  'palette.placeholder': '输入命令或搜索会话…',
  'palette.commands': '命令',
  'palette.sessions': '会话',
  'palette.noResults': '没有匹配',
  'palette.newSession': '新建会话',
  'palette.theme': '切换主题',
  'palette.lang': '切换语言',
  'agents.status': '状态',
  'agents.inOut': '↑{in} ↓{out}',
  'agents.cache': '缓存 {tok}（{pct}%）',
  'shortcuts.title': '键盘快捷键',
  'shortcuts.palette': '命令面板',
  'shortcuts.help': '这份速查表',
  'shortcuts.nav': '在列表/面板中移动',
  'shortcuts.send': '发送',
  'shortcuts.newline': '提示框内换行',
  'shortcuts.close': '关闭任意弹窗',
  'palette.exportMd': '导出会话为 Markdown',
  'palette.copyTrace': '复制 trace 为 JSON',
  'palette.shortcuts': '键盘快捷键',
  'notify.done': '任务已跑完',
  'tabs.inspector': '检视',
  'inspector.empty': '还没有模型调用——先发一条提示词。',
  'inspector.title': '检视 · {n} 次请求',
  'inspector.request': '第 {n} 次请求',
  'inspector.latest': '最新',
  'inspector.system': '系统提示词',
  'inspector.tools': '工具 · {n}',
  'inspector.messages': '消息 · {n}',
  'inspector.tokens': '约 {n} tokens',
  'inspector.copyJson': '复制请求为 JSON',

  'changes.hunks': '个 hunk',
  'changes.applySelected': '应用选中（{n}）',
  'changes.selectAll': '全选',
  'changes.selectNone': '全不选',
  'changes.applied': '已应用到 {n} 个文件',
  'changes.conflicted': '{n} 个 hunk 已无法应用',

  'sessions.rename': '重命名',
  'sessions.renameTitle': '重命名会话',
  'composer.model': '模型',
  'composer.dropImage': '松开以添加图片…',
  'composer.removeImage': '移除图片',
  'chat.edit': '编辑并重发',
  'chat.editTitle': '修改这条消息，并从这一点分叉出新会话',
  'chat.save': '重发',
  'trace.all': '全部',
  'trace.text': '文本',
  'trace.tool': '工具',
  'trace.usage': '用量',
  'trace.error': '错误',
  'trace.search': '过滤事件…',
  'sessions.today': '今天',
  'sessions.yesterday': '昨天',
  'sessions.earlier': '更早',
  'common.delete': '删除',
  'common.cancel': '取消',
  'chat.toBottom': '回到底部',
  'replay.badge': '回放',
  'changes.files': '{n} 个文件',
  'header.noSession': '无会话',
  'header.usage': '{tok} tok · {cost}',
  'header.idle': '空闲',
  'a11y.toggleSessions': '切换会话列表',
  'a11y.togglePanel': '切换右侧面板',
  'a11y.lang': '切换语言',
  'a11y.composer': '给 agent 发消息',
  'a11y.transcript': '对话记录',
  'a11y.agentTree': 'Agent 树',
  'a11y.tabs': '右侧面板视图',
  'composer.hintSend': 'Enter 发送',
  'composer.hintNewline': 'Shift+Enter 换行',
  'chat.streaming': '正在输出',
  'tool.running': '运行中',
  'tool.showOutput': '查看输出',
  'tool.hideOutput': '收起输出',
  'trace.scrubber': '回放位置',
  'trace.empty': '还没有事件',
  'approval.title': '需要批准',
  'approval.allow': '允许',
  'approval.deny': '拒绝',
  'approval.waiting': '等待应答…',
  'approval.allowed': '已允许',
  'approval.denied': '已拒绝',
  'approval.arguments': '参数',
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
