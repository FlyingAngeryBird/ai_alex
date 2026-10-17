import { expect, it, vi } from 'vitest'
import { createDoubaoSearchProvider } from '../electron/main/providers/doubaoSearchProvider'

const now = () => new Date('2026-10-17T04:00:00Z')
const reply = (WebResults: unknown = [], ResultCount = Array.isArray(WebResults) ? WebResults.length : 0) =>
  new Response(JSON.stringify({ ResponseMetadata: { RequestId: 'synthetic' }, Result: { WebResults, ResultCount } }))

it('uses independent Custom web endpoint/key and a single constrained query without a model request', async () => {
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    expect(url).toBe('https://open.feedcoopapi.com/search_api/web_search')
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('error')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer search-only' })
    expect(JSON.parse(String(init?.body))).toEqual({ Query: '北京 周末 展览', SearchType: 'web', Count: 10,
      Filter: { NeedContent: false, NeedUrl: true }, QueryControl: { QueryRewrite: false } })
    return reply()
  })
  const p = createDoubaoSearchProvider({ key: () => 'search-only', fetcher: fetcher as typeof fetch, now })
  expect(await p.search(' 北京  周末 展览 ')).toEqual({ query: '北京 周末 展览', queriedAtUtc: now().toISOString(), candidates: [], moreResultsAvailable: false })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('preserves stable URL candidates, prefers query extracts and does not claim a page has been read', async () => {
  const fetcher = vi.fn(async () => reply([
    { Title: 'Official', Url: 'https://example.org/article#p', Summary: 'Relevant extract', Snippet: 'Short', PublishTime: '2026-10-16T18:30:00+08:00', Content: 'Not a reader receipt' },
    { Title: 'Duplicate', Url: 'https://example.org/article' },
    { Title: 'Local', Url: 'https://127.0.0.1/private' },
    { Title: 'Credentials', Url: 'https://name:secret@example.org' },
    { Title: 'No URL', Summary: 'A card without verifiable source' },
    { Title: 'Fallback', Url: 'https://example.org/second', Snippet: 'Only snippet', PublishTime: '1970-01-01T08:00:00+08:00' }
  ]))
  const p = createDoubaoSearchProvider({ key: () => 'test', fetcher: fetcher as typeof fetch, now })
  const a = await p.search('query'), b = await p.search('query')
  expect(a.candidates).toHaveLength(2)
  expect(a.candidates[0]).toMatchObject({ title: 'Official', snippet: 'Relevant extract',
    url: 'https://example.org/article', pageDate: '2026-10-16T10:30:00.000Z', readDepth: 'search_summary' })
  expect(a.candidates[0].candidateId).toBe(b.candidates[0].candidateId)
  expect(a.candidates[1]).toMatchObject({ snippet: 'Only snippet', pageDate: null })
  expect(a.moreResultsAvailable).toBe(false)
})

it('rejects absent search keys and queries over 100 codepoints before a billable call', async () => {
  const fetcher = vi.fn() as unknown as typeof fetch
  await expect(createDoubaoSearchProvider({ key: () => undefined, fetcher }).search('query')).rejects.toMatchObject({ code: 'SEARCH_NOT_CONFIGURED' })
  const p = createDoubaoSearchProvider({ key: () => 'test', fetcher })
  await expect(p.search('字'.repeat(101))).rejects.toMatchObject({ code: 'SEARCH_QUERY_TOO_LONG_MAX_100' })
  expect(fetcher).not.toHaveBeenCalled()
})

it('handles HTTP success with business errors without exposing raw sensitive error text', async () => {
  for (const [code, expected] of Object.entries({
    '10401': 'SEARCH_AUTH_FAILED', '10403': 'SEARCH_SERVICE_NOT_ENABLED', '10406': 'SEARCH_QUOTA_EXHAUSTED',
    '10409': 'SEARCH_PLAN_UNSUPPORTED', '10410': 'SEARCH_PLAN_UNAVAILABLE', '10412': 'SEARCH_QUOTA_EXHAUSTED',
    '700429': 'SEARCH_RATE_LIMITED', 'unexpected': 'SEARCH_REMOTE_FAILED'
  })) {
    const p = createDoubaoSearchProvider({ key: () => 'test', fetcher: (async () => new Response(JSON.stringify({
      ResponseMetadata: { Error: { Code: code, Message: 'sensitive upstream text' } }, Result: null
    }))) as typeof fetch })
    await expect(p.search('query')).rejects.toMatchObject({ code: expected, message: expected })
  }
})

it('distinguishes HTTP failures and malformed data from an actual empty search result', async () => {
  for (const [response, code] of [
    [new Response('', { status: 401 }), 'SEARCH_AUTH_FAILED'], [new Response('', { status: 429 }), 'SEARCH_RATE_LIMITED'],
    [new Response('', { status: 503 }), 'SEARCH_REMOTE_FAILED'], [new Response('not json'), 'SEARCH_RESPONSE_INVALID'],
    [new Response(JSON.stringify({ Result: { ResultCount: 2, WebResults: null } })), 'SEARCH_RESPONSE_INVALID']
  ] as const) {
    await expect(createDoubaoSearchProvider({ key: () => 'test', fetcher: (async () => response) as typeof fetch }).search('q')).rejects.toMatchObject({ code })
  }
  expect((await createDoubaoSearchProvider({ key: () => 'test', fetcher: (async () => reply(null, 0)) as typeof fetch }).search('q')).candidates).toEqual([])
})

it('forwards caller cancellation in the bounded request signal', async () => {
  const controller = new AbortController()
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(init?.signal?.aborted).toBe(true)
    throw new DOMException('cancelled', 'AbortError')
  })
  controller.abort()
  await expect(createDoubaoSearchProvider({ key: () => 'test', fetcher: fetcher as typeof fetch }).search('q', controller.signal)).rejects.toMatchObject({ code: 'SEARCH_NETWORK_FAILED' })
})
