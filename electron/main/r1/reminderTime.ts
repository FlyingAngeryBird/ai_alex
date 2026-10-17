const integer = (text: string): number => {
  if (/^\d+$/.test(text)) return Number(text)
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (text === '十') return 10
  if (text.includes('十')) { const [left, right] = text.split('十'); return (left ? digits[left] : 1) * 10 + (right ? digits[right] : 0) }
  return digits[text] ?? NaN
}
function localParts(date: Date, timezone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))
}
/** Validation of a proposed tool time, never a router or a substitute for semantic clarification. */
export function validatedReminderTime(input: { dueAt: string; timezone: string }, source: { body: string; createdAt: string; timezone: string }): string {
  if (input.timezone !== source.timezone) throw new Error('REMINDER_TIMEZONE_MISMATCH')
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)$/.exec(input.dueAt)
  const date = new Date(input.dueAt)
  if (!match || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error('INVALID_DUE_TIME')
  const offsetZone = match[7] === 'Z' ? 'UTC' : input.timezone
  const proposed = localParts(date, offsetZone)
  if (['year', 'month', 'day', 'hour', 'minute', 'second'].some((key, index) => proposed[key] !== Number(match[index + 1]))) throw new Error('INVALID_DUE_TIME')
  const local = localParts(date, input.timezone), anchor = localParts(new Date(source.createdAt), source.timezone)
  const body = source.body
  const duration = /([\d零一二两三四五六七八九十]+|半)\s*(秒钟?|分钟?|小时|钟头)\s*(?:后|以后)/.exec(body)
  if (duration) {
    const amount = duration[1] === '半' ? .5 : integer(duration[1])
    const unit = duration[2].startsWith('秒') ? 1000 : duration[2].startsWith('分') ? 60000 : 3600000
    if (!Number.isFinite(amount) || amount <= 0 || Math.abs(date.getTime() - Date.parse(source.createdAt) - amount * unit) > 60000) throw new Error('REMINDER_TIME_SOURCE_MISMATCH')
    return date.toISOString()
  }
  const clock = /([\d零一二两三四五六七八九十]+)\s*(?:点|時|时)(?:\s*([\d零一二两三四五六七八九十]+)\s*分?|\s*(半|一刻|三刻))?/.exec(body)
  const colon = /(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)\b/.exec(body)
  if (!clock && !colon) throw new Error('REMINDER_TIME_CONFIRMATION_REQUIRED')
  let hour = colon ? Number(colon[1]) : integer(clock![1])
  const minute = colon ? Number(colon[2]) : clock![2] ? integer(clock![2]) : clock![3] === '半' ? 30 : clock![3] === '一刻' ? 15 : clock![3] === '三刻' ? 45 : 0
  if (!Number.isFinite(hour) || hour > 23 || !Number.isFinite(minute) || minute > 59) throw new Error('REMINDER_TIME_CONFIRMATION_REQUIRED')
  const pm = /下午|傍晚|晚上|今晚|明晚|后晚|夜里/.test(body), am = /早上|上午|凌晨|早晨/.test(body)
  if (pm && hour < 12) hour += 12
  if (am && hour === 12) hour = 0
  const sameHour = pm || am || colon || hour > 12 ? local.hour === hour : local.hour % 12 === hour % 12
  if (!sameHour || local.minute !== minute) throw new Error('REMINDER_TIME_SOURCE_MISMATCH')
  let days: number | null = /后天|后晚/.test(body) ? 2 : /明天|明晚/.test(body) ? 1 : /今天|今晚/.test(body) ? 0 : null
  if (days !== null) {
    const expected = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day + days))
    if (local.year !== expected.getUTCFullYear() || local.month !== expected.getUTCMonth() + 1 || local.day !== expected.getUTCDate()) throw new Error('REMINDER_TIME_SOURCE_MISMATCH')
  }
  // Other calendar expressions are resolved by the registered Skill and shown in the actual receipt.
  return date.toISOString()
}
