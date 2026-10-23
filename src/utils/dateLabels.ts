const dayMs = 24 * 60 * 60 * 1000
function startOfDay(value: Date): number { return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime() }
/** Prototype-style relative day: 今天/昨天/前天 or month-day (with year when different). */
export function relativeDay(value: string | number | Date, now = new Date()): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const diff = Math.round((startOfDay(now) - startOfDay(date)) / dayMs)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff === 2) return '前天'
  const sameYear = date.getFullYear() === now.getFullYear()
  return new Intl.DateTimeFormat('zh-CN', sameYear ? { month: '2-digit', day: '2-digit' } : { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}
/** Relative day plus local hour/minute for list rows. */
export function relativeDateTime(value: string | number | Date, now = new Date()): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return `${relativeDay(date, now)} ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)}`
}
