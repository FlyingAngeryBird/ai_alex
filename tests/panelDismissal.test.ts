import { expect, it } from 'vitest'
import { hasDismissiblePanel } from '../src/services/panelDismissal'
const base = { settingsOpen: false, itemsOpen: false, memoryOpen: false, historyOpen: false, searchOpen: false }
it('reports whether Escape should dismiss a panel', () => {
  expect(hasDismissiblePanel(base)).toBe(false)
  for (const key of Object.keys(base) as Array<keyof typeof base>) {
    expect(hasDismissiblePanel({ ...base, [key]: true })).toBe(true)
  }
})
