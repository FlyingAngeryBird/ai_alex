import { expect, it } from 'vitest'
import { relativeDay, relativeDateTime } from '../src/utils/dateLabels'
const now = new Date('2026-10-18T12:00:00+08:00')
it('formats prototype-style relative days without inventing dates', () => {
  expect(relativeDay(new Date('2026-10-18T08:00:00+08:00'), now)).toBe('今天')
  expect(relativeDay(new Date('2026-10-17T08:00:00+08:00'), now)).toBe('昨天')
  expect(relativeDay(new Date('2026-10-16T08:00:00+08:00'), now)).toBe('前天')
  expect(relativeDay(new Date('2026-09-01T08:00:00+08:00'), now)).toBe('09/01')
  expect(relativeDay(new Date('2025-09-01T08:00:00+08:00'), now)).toBe('2025/09/01')
  expect(relativeDay('not-a-date', now)).toBe('')
  expect(relativeDateTime(new Date('2026-10-17T08:05:00+08:00'), now)).toMatch(/^昨天 08:05$/)
})
