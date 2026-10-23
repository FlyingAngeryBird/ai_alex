import { Converter } from 'opencc-js/t2cn'
const simplify = Converter({ from: 't', to: 'cn' })
export function musicText(value: string): string {
  return simplify(value.normalize('NFKC')).toLowerCase().replace(/[\s·・•]+/g, ' ').trim()
}
export function musicRelevance(track: { title: string; artist: string }, query: string): number {
  const title = musicText(track.title), artist = musicText(track.artist), input = musicText(query)
  const compact = (text: string) => text.replace(/[\s\p{P}]/gu, '')
  const q = compact(input), t = compact(title), a = compact(artist)
  let score = input.split(' ').filter(Boolean).reduce((sum, token) => sum + (title === token ? 20 : title.includes(token) ? 8 : 0) + (artist === token ? 18 : artist.includes(token) ? 6 : 0), 0)
  if (t && q.includes(t)) score += 25
  if (a && q.includes(a)) score += 50
  if (t && a && (q === t + a || q === a + t)) score += 100
  for (const version of ['live', '现场', '翻唱', 'cover', '伴奏', 'remix', '纯音乐']) {
    if (title.includes(version) && !input.includes(version)) score -= 15
  }
  return score
}
