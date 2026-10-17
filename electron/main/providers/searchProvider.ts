export type SearchCandidate = {
  candidateId: string
  title: string
  url: string
  snippet: string
  query: string
  queriedAtUtc: string
  pageDate: string | null
  readDepth: 'search_summary'
}

export type SearchResult = {
  query: string
  queriedAtUtc: string
  candidates: SearchCandidate[]
  moreResultsAvailable: boolean
}

export class SearchProviderError extends Error {
  constructor(public readonly code: string) { super(code) }
}

export function publicHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.') ||
      host === 'localhost' || host.endsWith('.localhost') ||
      /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) return null
    url.hash = ''
    return url.toString()
  } catch { return null }
}

export function validateSearchQuery(value: unknown): string {
  if (typeof value !== 'string') throw new SearchProviderError('SEARCH_QUERY_INVALID')
  const query = value.trim().replace(/\s+/g, ' ')
  if (!query || query.length > 600 || query.split(' ').length > 75) {
    throw new SearchProviderError('SEARCH_QUERY_INVALID')
  }
  return query
}

export interface SearchProvider { search(input: unknown, signal?: AbortSignal): Promise<SearchResult> }
