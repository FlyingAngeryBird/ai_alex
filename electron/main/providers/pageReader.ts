import { createHash } from 'node:crypto'
import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { load } from 'cheerio'
export type WebSource = { sourceRef: string; url: string; title: string; publishedAt: string | null;
  accessedAt: string; readStatus: 'not_read' | 'read' | 'partial' | 'failed'; snippet: string }
export class PageReadError extends Error { constructor(readonly code: string) { super(code) } }
export function publicPageUrl(input: unknown): URL {
  let url: URL
  try { url = new URL(String(input)) } catch { throw new PageReadError('PAGE_URL_INVALID') }
  if (url.href.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.port && !['80', '443'].includes(url.port) || !url.hostname.includes('.') || isIP(url.hostname) ||
    url.hostname.startsWith('[') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(url.hostname)) throw new PageReadError('PAGE_URL_FORBIDDEN')
  url.hash = ''; return url
}
export function isPublicPageAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) ||
      a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0)
  }
  // Only global unicast IPv6, excluding documentation/transition prefixes.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:0:|db8:|2:)/i.test(address) && !/^2002:/i.test(address)
}
export type PageBytes = { bytes: Buffer; url: string; contentType: string; truncated: boolean }
async function fetchPublicPage(url: URL, signal: AbortSignal, redirects = 0): Promise<PageBytes> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (code: string) => { if (!settled) { settled = true; reject(new PageReadError(code)) } }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', signal, headers: { 'Accept': 'text/html,text/plain', 'Accept-Encoding': 'identity', 'User-Agent': 'Seamo-AI-R1/1.0' },
      // The resolved public address is the address used for the actual connection, including redirects.
      lookup(hostname, _options, callback) {
        lookup(hostname, { all: true }, (error, addresses) => {
          if (error || !addresses.length || addresses.some(item => !isPublicPageAddress(item.address))) {
            callback(new PageReadError('PAGE_ADDRESS_FORBIDDEN'), '', 4); return
          }
          const address = addresses.find(item => item.family === 4) ?? addresses[0]
          if (typeof _options === 'object' && _options.all) (callback as unknown as (error: null, values: Array<{ address: string; family: number }>) => void)(null, [address])
          else callback(null, address.address, address.family)
        })
      }
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        response.resume()
        if (redirects >= 3 || !response.headers.location) { fail('PAGE_REDIRECT_LIMIT'); return }
        let next: URL
        try { next = publicPageUrl(new URL(response.headers.location, url).href) } catch { fail('PAGE_REDIRECT_FORBIDDEN'); return }
        settled = true; resolve(fetchPublicPage(next, signal, redirects + 1)); return
      }
      if (response.statusCode !== 200) { response.resume(); fail('PAGE_REMOTE_FAILED'); return }
      const contentType = response.headers['content-type'] ?? ''
      if (!/^(text\/html|text\/plain|application\/xhtml\+xml)\b/i.test(contentType) ||
        response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        response.resume(); fail('PAGE_CONTENT_UNSUPPORTED'); return
      }
      const chunks: Buffer[] = []; let size = 0
      const finish = (truncated: boolean) => {
        if (settled) return
        settled = true; resolve({ bytes: Buffer.concat(chunks), url: url.href, contentType, truncated })
      }
      response.on('data', (chunk: Buffer) => {
        const remaining = 1_048_576 - size
        chunks.push(chunk.subarray(0, remaining)); size += Math.min(remaining, chunk.length)
        if (chunk.length > remaining || size === 1_048_576) { finish(true); response.destroy(); request.destroy() }
      })
      response.on('end', () => finish(false)); response.on('error', () => fail('PAGE_NETWORK_FAILED'))
    })
    request.on('error', error => fail(error instanceof PageReadError ? error.code : signal.aborted ? 'PAGE_CANCELLED_OR_TIMEOUT' : 'PAGE_NETWORK_FAILED'))
    request.end()
  })
}
export function createPageReader(options: { read?: (url: URL, signal: AbortSignal) => Promise<PageBytes>; now?: () => Date } = {}) {
  return { async read(input: { url: string; fields: string[]; sourceRef?: string | null }, signal?: AbortSignal) {
    const url = publicPageUrl(input.url)
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000)
    const result = await (options.read ?? fetchPublicPage)(url, combined)
    const charset = result.contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? 'utf-8'
    let decoded: string
    try { decoded = new TextDecoder(charset).decode(result.bytes) } catch { throw new PageReadError('PAGE_ENCODING_UNSUPPORTED') }
    let title = url.hostname, publishedAt: string | null = null, text = decoded
    if (!result.contentType.startsWith('text/plain')) {
      const $ = load(decoded)
      title = [...$('title').first().text().trim() || $('h1').first().text().trim() || title].slice(0, 500).join('')
      const date = $('meta[property="article:published_time"],meta[name="date"],meta[itemprop="datePublished"]').first().attr('content')
      if (date && date.length <= 80 && Number.isFinite(Date.parse(date))) publishedAt = date
      $('script,style,noscript,iframe,nav,footer,form,[hidden],[aria-hidden="true"]').remove()
      const main = $('main').first(), article = $('article').first()
      const root = main.length ? main : article.length ? article : $('body')
      root.find('p,div,section,article,li,h1,h2,h3,h4,br,tr').append('\n')
      text = root.text()
    }
    text = text.replace(/[\t \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!text) throw new PageReadError('PAGE_NO_READABLE_CONTENT')
    const truncated = result.truncated || [...text].length > 20000
    const content = [...text].slice(0, 20000).join(''), accessedAt = (options.now ?? (() => new Date()))().toISOString()
    const sourceRef = input.sourceRef || `page:${createHash('sha256').update(result.url).digest('hex').slice(0, 24)}`
    const source: WebSource = { sourceRef, url: result.url, title, publishedAt, accessedAt,
      readStatus: truncated ? 'partial' : 'read', snippet: [...content].slice(0, 2000).join('') }
    const metadata: Record<string, string | null> = { title, url: result.url, publishedAt }
    return { source, content, truncated, contentHash: createHash('sha256').update(content).digest('hex'),
      fields: input.fields.map(key => ({ key, value: metadata[key] ?? null,
        verification: metadata[key] ? 'verified' : 'unconfirmed', sourceRefs: [sourceRef] })) }
  } }
}
