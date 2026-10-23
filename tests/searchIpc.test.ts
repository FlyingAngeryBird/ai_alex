import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: {}, shell: { openExternal: vi.fn() } }))

import { registerSearchHandlers } from '../electron/main/ipc/searchHandlers'
import type { SearchResult } from '../electron/main/providers/braveSearchProvider'

type Handler = (event: unknown, payload?: unknown) => Promise<unknown>

function fixture(query: string, id: string): SearchResult {
  return { query, queriedAtUtc: '2026-10-13T10:00:00.000Z', moreResultsAvailable: false,
    candidates: [{ candidateId: id, title: query, url: `https://example.org/${id}`,
      snippet: '', query, queriedAtUtc: '2026-10-13T10:00:00.000Z',
      pageDate: null, readDepth: 'search_summary' }] }
}

describe('search IPC', () => {
  it('opens only candidates from the latest completed search', async () => {
    const handlers = new Map<string, Handler>()
    const openExternal = vi.fn(async () => {})
    const provider = { search: vi.fn(async (query: string) => fixture(query, query)) }
    registerSearchHandlers({ handle: (channel, handler) => { handlers.set(channel, handler as Handler) } },
      provider, openExternal)
    const search = handlers.get('r1.search.web')!
    const open = handlers.get('r1.search.open')!
    expect(await search(null, { query: 'first' })).toMatchObject({ ok: true })
    expect(await open(null, { candidateId: 'first' })).toMatchObject({ ok: true })
    expect(openExternal).toHaveBeenCalledWith('https://example.org/first')
    expect(await search(null, { query: 'second' })).toMatchObject({ ok: true })
    expect(await open(null, { candidateId: 'first' })).toMatchObject({ ok: false,
      error: { code: 'SEARCH_CANDIDATE_EXPIRED' } })
    expect(await open(null, { candidateId: 'unknown' })).toMatchObject({ ok: false })
  })

  it('does not let an older request replace newer candidates', async () => {
    const handlers = new Map<string, Handler>()
    let resolveOld: (value: SearchResult) => void = () => {}
    const provider = { search: vi.fn((query: string) => query === 'old'
      ? new Promise<SearchResult>((resolve) => { resolveOld = resolve })
      : Promise.resolve(fixture(query, query))) }
    registerSearchHandlers({ handle: (channel, handler) => { handlers.set(channel, handler as Handler) } },
      provider, vi.fn(async () => {}))
    const old = handlers.get('r1.search.web')!(null, { query: 'old' })
    await handlers.get('r1.search.web')!(null, { query: 'new' })
    resolveOld(fixture('old', 'old'))
    await old
    expect(await handlers.get('r1.search.open')!(null, { candidateId: 'old' }))
      .toMatchObject({ ok: false })
    expect(await handlers.get('r1.search.open')!(null, { candidateId: 'new' }))
      .toMatchObject({ ok: true })
  })
})
