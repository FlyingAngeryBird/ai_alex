import { createHash } from 'node:crypto'
import { publicHttpsUrl, validateSearchQuery, SearchProviderError, type SearchProvider, type SearchCandidate } from './searchProvider.js'

// Independent Custom web search, not Ark's hosted Responses web_search tool.
// Protocol: https://docs.volcengine.com/docs/Networkedsearch/Networkedsearch-2?lang=zh
const endpoint = 'https://open.feedcoopapi.com/search_api/web_search'
const errorCodes: Record<string, string> = {
  '10400': 'SEARCH_QUERY_INVALID', '10401': 'SEARCH_AUTH_FAILED',
  '10402': 'SEARCH_SERVICE_NOT_ENABLED', '10403': 'SEARCH_SERVICE_NOT_ENABLED',
  '10406': 'SEARCH_QUOTA_EXHAUSTED', '10408': 'SEARCH_SERVICE_NOT_ENABLED',
  '10409': 'SEARCH_PLAN_UNSUPPORTED', '10410': 'SEARCH_PLAN_UNAVAILABLE',
  '10412': 'SEARCH_QUOTA_EXHAUSTED', '700429': 'SEARCH_RATE_LIMITED'
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function pageDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null
  const timestamp = Date.parse(value)
  // The provider uses 1970 as an unknown-date placeholder in some results.
  return Number.isFinite(timestamp) && timestamp > Date.UTC(1971, 0, 1) ? new Date(timestamp).toISOString() : null
}

export function createDoubaoSearchProvider(options: {
  fetcher?: typeof fetch; key?: () => string | undefined; now?: () => Date
} = {}): SearchProvider {
  const fetcher = options.fetcher ?? fetch
  const key = options.key ?? (() => process.env.DOUBAO_SEARCH_API_KEY)
  const now = options.now ?? (() => new Date())
  return {
    async search(input, signal) {
      const query = validateSearchQuery(input)
      // Do not allow the upstream API to silently truncate user constraints.
      if ([...query].length > 100) throw new SearchProviderError('SEARCH_QUERY_TOO_LONG_MAX_100')
      const apiKey = key()?.trim()
      if (!apiKey) throw new SearchProviderError('SEARCH_NOT_CONFIGURED')
      const queriedAtUtc = now().toISOString()
      let response: Response
      try {
        response = await fetcher(endpoint, {
          method: 'POST', redirect: 'error',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ Query: query, SearchType: 'web', Count: 10,
            Filter: { NeedContent: false, NeedUrl: true }, QueryControl: { QueryRewrite: false } }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000)
        })
      } catch { throw new SearchProviderError('SEARCH_NETWORK_FAILED') }
      if (response.status === 401 || response.status === 403) throw new SearchProviderError('SEARCH_AUTH_FAILED')
      if (response.status === 429) throw new SearchProviderError('SEARCH_RATE_LIMITED')
      if (!response.ok) throw new SearchProviderError('SEARCH_REMOTE_FAILED')
      let body: Record<string, unknown> | null
      try { body = record(await response.json()) } catch { throw new SearchProviderError('SEARCH_RESPONSE_INVALID') }
      const metadata = record(body?.ResponseMetadata)
      const error = record(metadata?.Error)
      if (error) {
        const code = String(error.CodeN ?? error.Code)
        // Never forward raw messages, request bodies or headers to the renderer/model.
        throw new SearchProviderError(errorCodes[code] ?? 'SEARCH_REMOTE_FAILED')
      }
      const result = record(body?.Result)
      if (!result || !Number.isInteger(result.ResultCount) || (result.ResultCount as number) < 0 ||
        (!Array.isArray(result.WebResults) && !(result.ResultCount === 0 && result.WebResults == null))) {
        throw new SearchProviderError('SEARCH_RESPONSE_INVALID')
      }
      const candidates: SearchCandidate[] = [], seen = new Set<string>()
      for (const raw of (result.WebResults ?? []) as unknown[]) {
        const item = record(raw), url = publicHttpsUrl(item?.Url)
        if (!item || !url || seen.has(url) || typeof item.Title !== 'string' || !item.Title.trim()) continue
        seen.add(url)
        // Summary is the provider's query-relevant extract. It is still NOT a
        // page-read receipt or proof of full-text verification by our reader.
        const summary = typeof item.Summary === 'string' && item.Summary.trim() ? item.Summary : item.Snippet
        candidates.push({ candidateId: `web:${createHash('sha256').update(url).digest('hex').slice(0, 20)}`,
          title: [...item.Title.trim()].slice(0, 300).join(''), url,
          snippet: typeof summary === 'string' ? [...summary.trim()].slice(0, 1200).join('') : '',
          query, queriedAtUtc, pageDate: pageDate(item.PublishTime), readDepth: 'search_summary' })
        if (candidates.length >= 10) break
      }
      // ResultCount describes this response, not an authoritative total. No
      // pagination/"more available" promise without an upstream indicator.
      return { query, queriedAtUtc, candidates, moreResultsAvailable: false }
    }
  }
}
