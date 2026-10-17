const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase()
// Retrieval noise only: these words describe a lookup, not a remembered entity.
const wrappers = /用户|关于|相关|记忆|记录|偏好|喜好|喜欢|习惯|我的|你的|什么|是否|哪(?:个|类|些)|通常|平时|时候|之前|以前|一周中|请问|一下|[我你他的了是在和与吗呢啊哦呀叫这那里中]/gu
const fallbackNoise = new Set([...'有上下以不每更先再用希望'])
const hasTerm = (text: string, term: string) => /^[a-z0-9]+$/.test(term)
  ? new RegExp(`(?:^|[^a-z0-9])${term}(?=$|[^a-z0-9])`).test(text) : text.includes(term)
/** Lexical retrieval, never a semantic confidence or a fabricated memory.
 * Natural multi-term queries use real overlapping terms. Actual document frequencies
 * distinguish a specific entity from generic words such as “项目”. Character
 * backoff needs two distinct matches, so 南京 cannot match 北京 on 京 alone. */
export function rankMemoryCandidates<T extends { content: string }>(rows: T[], query: string,
  options: { limit: number; assertBudget(): void } = { limit: 5, assertBudget() {} }): T[] {
  options.assertBudget()
  const normalized = normalize(query).trim()
  const fragments = normalize(query).replace(wrappers, ' ').match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? []
  if (!fragments.length) return []
  const documents = rows.map((row, index) => { if (index % 64 === 0) options.assertBudget(); return normalize(row.content) })
  const preferred = new Set<string>(), fallback = new Set<string>()
  const frequencies = new Map<string, number>()
  const frequency = (term: string) => {
    if (!frequencies.has(term)) frequencies.set(term, documents.filter((text, index) => { if (index % 64 === 0) options.assertBudget(); return hasTerm(text, term) }).length)
    return frequencies.get(term)!
  }
  for (const fragment of fragments) {
    const characters = [...fragment]
    const terms = /^\p{Script=Han}+$/u.test(fragment) && characters.length > 1
      ? characters.slice(0, -1).map((value, index) => value + characters[index + 1]) : [fragment]
    const present = [...new Set(terms)].filter(term => frequency(term) > 0)
    if (present.length) {
      const leastFrequent = Math.min(...present.map(frequency))
      for (const term of present) if (frequency(term) === leastFrequent) preferred.add(term)
    } else if (/^\p{Script=Han}+$/u.test(fragment)) {
      for (const character of characters) if (!fallbackNoise.has(character) && frequency(character)) fallback.add(character)
    }
  }
  const leastFrequent = preferred.size ? Math.min(...[...preferred].map(frequency)) : 0
  const specific = [...preferred].filter(term => frequency(term) === leastFrequent)
  const ranked = rows.map((row, index) => {
    if (index % 64 === 0) options.assertBudget()
    const text = documents[index]
    const terms = [...preferred].filter(term => hasTerm(text, term))
    const backoff = [...fallback].filter(term => text.includes(term))
    const exact = text.includes(normalized)
    return { row, index, exact, qualified: specific.some(term => hasTerm(text, term)), matched: terms.length, backoff: backoff.length,
      length: terms.reduce((total, term) => total + [...term].length, 0) }
  }).filter(value => value.qualified || !specific.length && value.backoff >= 2)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.matched - a.matched || b.length - a.length ||
      b.backoff - a.backoff || a.index - b.index).slice(0, options.limit).map(value => value.row)
  options.assertBudget()
  return ranked
}
