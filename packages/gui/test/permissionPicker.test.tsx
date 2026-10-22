import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PermissionPicker } from '../src/components/PermissionPicker.tsx'
import { LangProvider } from '../src/lib/i18n.tsx'

/** 服务端渲染使用可恢复的存储替身指定语言。 */
function render(status: 'loading' | 'saving' | 'unavailable', language: string): string {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => language } })
  try {
    return renderToStaticMarkup(<LangProvider><PermissionPicker status={status} onChange={() => {}} /></LangProvider>)
  } finally {
    // 避免测试环境状态泄漏到其他组件测试。
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

test('加载、保存及不可用权限禁用按钮且不显示猜测的完整权限', () => {
  // 同时覆盖中英文状态文案，未知权限不能落入 full 默认值。
  for (const language of ['en', 'zh']) {
    for (const status of ['loading', 'saving', 'unavailable'] as const) {
      const html = render(status, language)
      expect(html).toContain('disabled=""')
      expect(html).not.toContain('role="menu"')
      expect(html).not.toContain('full')
      expect(html).not.toContain('完整权限')
      const label = status === 'unavailable'
        ? language === 'en' ? 'unavailable' : '不可用'
        : language === 'en' ? 'loading…' : '加载中…'
      expect(html).toContain(label)
    }
  }
})
