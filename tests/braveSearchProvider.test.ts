import { describe, expect, it, vi } from 'vitest'
import { createBraveSearchProvider } from '../electron/main/providers/braveSearchProvider'

const fixedNow = () => new Date('2026-10-13T10:00:00.000Z')

describe('Brave web search', () => {
  it('refuses to claim a search without a configured key', async () => {
    const provider = createBraveSearchProvider({ key: () => undefined,
      fetcher: vi.fn() as unknown as typeof fetch })
    await expect(provider.search('今天新闻')).rejects.toMatchObject({ code: 'SEARCH_NOT_CONFIGURED' })
  })

  it('returns stable candidates and labels every result as summary-only', async () => {
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.headers).toEqual({ Accept: 'application/json', 'x-subscription-token': 'test-key' })
      return new Response(JSON.stringify({ web: { results: [
        { title: 'Official', url: 'https://example.org/article#section', description: 'A public summary' },
        { title: 'Duplicate', url: 'https://example.org/article', description: 'Duplicate' },
        { title: 'Local', url: 'http://localhost/secret', description: 'Unsafe' },
        { title: 'IP', url: 'https://127.0.0.1/secret', description: 'Unsafe' }
      ], more_results_available: true } }), { status: 200 })
    })
    const provider = createBraveSearchProvider({ fetcher: fetcher as typeof fetch,
      key: () => 'test-key', now: fixedNow })
    const first = await provider.search('  上海   展览 ')
    const second = await provider.search('上海 展览')
    expect(String(fetcher.mock.calls[0][0])).toContain('q=%E4%B8%8A%E6%B5%B7+%E5%B1%95%E8%A7%88')
    expect(first.candidates).toHaveLength(1)
    expect(first.candidates[0]).toMatchObject({
      title: 'Official', url: 'https://example.org/article', pageDate: null,
      readDepth: 'search_summary', queriedAtUtc: '2026-10-13T10:00:00.000Z'
    })
    expect(first.candidates[0].candidateId).toBe(second.candidates[0].candidateId)
    expect(first.moreResultsAvailable).toBe(true)
  })

  it('keeps authentication, rate limit and malformed responses distinct', async () => {
    for (const [status, code] of [[401, 'SEARCH_AUTH_FAILED'], [429, 'SEARCH_RATE_LIMITED']] as const) {
      const provider = createBraveSearchProvider({ key: () => 'test',
        fetcher: vi.fn(async () => new Response('', { status })) as unknown as typeof fetch })
      await expect(provider.search('query')).rejects.toMatchObject({ code })
    }
    const provider = createBraveSearchProvider({ key: () => 'test',
      fetcher: vi.fn(async () => new Response('{}')) as unknown as typeof fetch })
    await expect(provider.search('query')).rejects.toMatchObject({ code: 'SEARCH_RESPONSE_INVALID' })
  })
})
