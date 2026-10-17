import { afterEach, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { RealtimeSearchTurn, type RealtimeSearchState } from '../electron/main/r1/realtimeSearch'
import type { SearchProvider, SearchResult } from '../electron/main/providers/searchProvider'
import type { createPageReader } from '../electron/main/providers/pageReader'
const assets = loadR1PromptAssets(resolve('r1-assets'))
const result = (query = 'q'): SearchResult => ({ query, queriedAtUtc: '2026-10-17T05:00:00Z', moreResultsAvailable: false,
  candidates: Array.from({ length: 5 }, (_, i) => ({ candidateId: `candidate-${i}`, title: 'public source', url: `https://example.org/${i}`,
    snippet: 'x'.repeat(1200), query, queriedAtUtc: '2026-10-17T05:00:00Z', pageDate: null, readDepth: 'search_summary' as const })) })
function setup(search: SearchProvider['search'] = vi.fn(async q => result(String(q)))) {
  const events: RealtimeSearchState[] = [], receipts: Record<string, unknown>[] = []
  let current = true
  const read = vi.fn(async (args: { url: string; fields: string[]; sourceRef?: string | null }) => ({
    source: { sourceRef: args.sourceRef!, url: args.url, title: 'page', publishedAt: null, accessedAt: '2026-10-17T05:00:00Z', readStatus: 'read' as const, snippet: 'excerpt' },
    content: 'content'.repeat(1000), truncated: false, contentHash: 'hash', fields: []
  }))
  const turn = new RealtimeSearchTurn('turn', { assets, search: { search }, reader: { read } as ReturnType<typeof createPageReader>,
    assertCurrent() { if (!current) throw new Error('REALTIME_TOOL_SOURCE_REPLACED') }, emit: e => events.push(e), save: receipt => receipts.push(receipt) })
  return { turn, events, receipts, read, revoke() { current = false; turn.finish('cancelled') } }
}
afterEach(() => vi.useRealTimers())

it('does no speculative IO, deduplicates calls and bounds the summary projection', async () => {
  const search = vi.fn(async q => result(String(q))), s = setup(search)
  expect(search).not.toHaveBeenCalled(); expect(s.events).toEqual([])
  s.turn.answerStarted() // A pre-search acknowledgement must not close the turn.
  const a = await s.turn.execute('web_search', { query: 'Weather Shanghai' }, '1')
  const b = await s.turn.execute('web_search', { query: ' Weather  Shanghai ' }, '2')
  expect(a).toEqual(b); expect(search).toHaveBeenCalledTimes(1)
  const data = a.data as { sources: Array<{ snippet: string; readStatus: string }> }
  expect(data.sources).toHaveLength(3); expect(data.sources[0].snippet).toHaveLength(600)
  expect(data.sources[0].readStatus).toBe('not_read')
  await expect(s.turn.execute('web_search', { query: 'other' }, '1')).rejects.toThrow('CONVERSATION_CALL_ID_REUSED')
  s.turn.answerStarted(); expect(s.events.at(-1)?.phase).toBe('ready')
})

it('enforces at most three searches, including failures, and two page fetches with binding and reuse', async () => {
  const search = vi.fn(async q => result(String(q))), s = setup(search)
  for (let i = 0; i < 3; i++) expect(await s.turn.execute('web_search', { query: `query ${i}` }, `q${i}`)).toMatchObject({ status: 'succeeded' })
  expect(await s.turn.execute('web_search', { query: 'fourth' }, 'q4')).toMatchObject({ status: 'failed', errorCode: 'REALTIME_SEARCH_QUERY_BUDGET_EXHAUSTED' })
  expect(search).toHaveBeenCalledTimes(3)
  expect(await s.turn.execute('web_read_page', { url: 'https://unrelated.org/', fields: [], sourceRef: 'source:candidate-0' }, 'bad')).toMatchObject({ errorCode: 'REALTIME_SEARCH_PAGE_SOURCE_INVALID' })
  expect(s.read).not.toHaveBeenCalled()
  const page = { url: 'https://example.org/0', fields: [], sourceRef: 'source:candidate-0' }
  const receipt = await s.turn.execute('web_read_page', page, 'p1')
  expect(receipt).toMatchObject({ status: 'succeeded', data: { truncated: true, source: { readStatus: 'partial' } } })
  expect((receipt.data as { content: string }).content).toHaveLength(4000)
  expect(await s.turn.execute('web_read_page', page, 'duplicate')).toEqual(receipt)
  await s.turn.execute('web_read_page', { ...page, url: 'https://example.org/1', sourceRef: 'source:candidate-1' }, 'p2')
  expect(await s.turn.execute('web_read_page', { ...page, url: 'https://example.org/2', sourceRef: 'source:candidate-2' }, 'p3')).toMatchObject({ errorCode: 'REALTIME_SEARCH_PAGE_BUDGET_EXHAUSTED' })
  expect(s.read).toHaveBeenCalledTimes(2); s.turn.finish()
})

it('shares an eight-second deadline across calls and model gaps, ignores late non-cooperative providers', async () => {
  vi.useFakeTimers()
  let finish!: (value: SearchResult) => void
  const search = vi.fn(() => new Promise<SearchResult>(resolve => { finish = resolve })), s = setup(search)
  const pending = s.turn.execute('web_search', { query: 'q' }, '1')
  await vi.advanceTimersByTimeAsync(1500); expect(s.events.at(-1)?.hint).toBe(true)
  await vi.advanceTimersByTimeAsync(3500); expect(s.events.at(-1)?.elapsedMs).toBe(5000)
  await vi.advanceTimersByTimeAsync(3000)
  expect(await pending).toMatchObject({ status: 'failed', errorCode: 'REALTIME_SEARCH_TIMEOUT_OR_CANCELLED' })
  expect(s.events.at(-1)?.phase).toBe('timeout')
  finish(result()); await Promise.resolve(); await Promise.resolve()
  expect(s.events.at(-1)?.sources).toEqual([])
  expect(await s.turn.execute('web_search', { query: 'new' }, '2')).toMatchObject({ status: 'failed' })
  expect(search).toHaveBeenCalledTimes(1)
  const quick = setup()
  await quick.turn.execute('web_search', { query: 'first' }, 'first')
  await vi.advanceTimersByTimeAsync(8000)
  expect(await quick.turn.execute('web_search', { query: 'later' }, 'later')).toMatchObject({ errorCode: 'REALTIME_SEARCH_ENDED' })
})

it('caps concurrency at two; cancellation prevents queued fetches and stale receipts', async () => {
  vi.useFakeTimers()
  const signals: AbortSignal[] = []
  const search = vi.fn(async (_q, signal) => { signals.push(signal!); return new Promise<SearchResult>(() => undefined) })
  const s = setup(search)
  const calls = Array.from({ length: 3 }, (_, i) => s.turn.execute('web_search', { query: `q${i}` }, `${i}`).catch(error => error.message))
  expect(search).toHaveBeenCalledTimes(2)
  s.revoke(); await Promise.all(calls)
  expect(search).toHaveBeenCalledTimes(2); expect(signals.every(s => s.aborted)).toBe(true)
  expect(s.receipts).toEqual([]); expect(s.events.at(-1)?.phase).toBe('cancelled')
  await vi.advanceTimersByTimeAsync(8000); expect(s.events.at(-1)?.phase).toBe('cancelled')
})

it('counts unsuccessful remote attempts and does not retry autonomously', async () => {
  const search = vi.fn(async () => { throw new Error('SEARCH_RATE_LIMITED') }), s = setup(search)
  for (let i = 0; i < 4; i++) await s.turn.execute('web_search', { query: `q${i}` }, `${i}`)
  expect(search).toHaveBeenCalledTimes(3); s.turn.finish('failed')
})
