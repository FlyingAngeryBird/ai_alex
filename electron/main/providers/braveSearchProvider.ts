import { createHash } from 'node:crypto'
import { publicHttpsUrl, validateSearchQuery, SearchProviderError, type SearchCandidate, type SearchResult } from './searchProvider.js'
export { SearchProviderError, validateSearchQuery } from './searchProvider.js'
export type { SearchCandidate, SearchResult } from './searchProvider.js'
type SearchResponse = { web?: { results?: unknown; more_results_available?: unknown } }

export function createBraveSearchProvider(options: {
  fetcher?: typeof fetch
  key?: () => string | undefined
  now?: () => Date
} = {}) {
  const fetcher = options.fetcher ?? fetch
  const key = options.key ?? (() => process.env.BRAVE_SEARCH_API_KEY)
  const now = options.now ?? (() => new Date())

  return {
    async search(input: unknown, signal?: AbortSignal): Promise<SearchResult> {
      const query = validateSearchQuery(input)
      const apiKey = key()?.trim()
      if (!apiKey) throw new SearchProviderError('SEARCH_NOT_CONFIGURED')
      const url = new URL('https://api.search.brave.com/res/v1/web/search')
      url.searchParams.set('q', query)
      url.searchParams.set('count', '10')
      url.searchParams.set('result_filter', 'web')
      let response: Response
      try {
        response = await fetcher(url, {
          headers: { 'Accept': 'application/json', 'x-subscription-token': apiKey },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000)
        })
      } catch { throw new SearchProviderError('SEARCH_NETWORK_FAILED') }
      if (response.status === 401 || response.status === 403) throw new SearchProviderError('SEARCH_AUTH_FAILED')
      if (response.status === 429) throw new SearchProviderError('SEARCH_RATE_LIMITED')
      if (!response.ok) throw new SearchProviderError('SEARCH_REMOTE_FAILED')
      let data: SearchResponse
      try { data = await response.json() as SearchResponse } catch {
        throw new SearchProviderError('SEARCH_RESPONSE_INVALID')
      }
      if (!data || typeof data !== 'object' || !data.web ||
        !Array.isArray(data.web.results)) throw new SearchProviderError('SEARCH_RESPONSE_INVALID')
      const queriedAtUtc = now().toISOString()
      const seen = new Set<string>()
      const candidates: SearchCandidate[] = []
      for (const raw of data.web.results) {
        if (!raw || typeof raw !== 'object') continue
        const item = raw as Record<string, unknown>
        const resultUrl = publicHttpsUrl(item.url)
        if (!resultUrl || seen.has(resultUrl) || typeof item.title !== 'string') continue
        seen.add(resultUrl)
        candidates.push({
          candidateId: `web:${createHash('sha256').update(resultUrl).digest('hex').slice(0, 20)}`,
          title: item.title.trim().slice(0, 300), url: resultUrl,
          snippet: typeof item.description === 'string' ? item.description.trim().slice(0, 1200) : '',
          query, queriedAtUtc, pageDate: null, readDepth: 'search_summary'
        })
      }
      return { query, queriedAtUtc, candidates,
        moreResultsAvailable: data.web.more_results_available === true }
    }
  }
}
