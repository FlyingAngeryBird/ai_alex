import { createHash, randomUUID } from 'node:crypto'
import type { SearchProvider } from '../providers/searchProvider.js'
import { validateSearchQuery, SearchProviderError } from '../providers/searchProvider.js'
import { publicPageUrl, type createPageReader } from '../providers/pageReader.js'
import type { R1PromptAssets } from './promptAssets.js'

export type RealtimeSearchState = {
  type: 'search.state'; turnId: string; phase: 'searching' | 'reading' | 'waiting' | 'ready' | 'timeout' | 'cancelled' | 'failed';
  elapsedMs: number; searches: number; pages: number; sources: Record<string, unknown>[]; hint: boolean
}
/** One real user turn owns one deadline, cache and budget, including model gaps. */
export class RealtimeSearchTurn {
  private startedAt: number | null = null
  private controller = new AbortController()
  private timers: ReturnType<typeof setTimeout>[] = []
  private cache = new Map<string, Promise<Record<string, unknown>>>()
  private calls = new Map<string, { fingerprint: string; result: Promise<Record<string, unknown>> }>()
  private sources = new Map<string, Record<string, unknown>>()
  private searches = 0; private pages = 0; private running = 0
  private waiters: Array<() => void> = []
  private terminal = false
  private phase: RealtimeSearchState['phase'] = 'waiting'
  constructor(readonly turnId: string, private deps: {
    assets: R1PromptAssets; search: SearchProvider; reader: ReturnType<typeof createPageReader>;
    assertCurrent(): void; emit(state: RealtimeSearchState): void;
    save(receipt: Record<string, unknown>): void; now?: () => number
  }) {}
  private now() { return (this.deps.now ?? Date.now)() }
  private emit(phase: RealtimeSearchState['phase'], hint = false) {
    this.phase = phase
    this.deps.emit({ type: 'search.state', turnId: this.turnId, phase, elapsedMs: this.startedAt === null ? 0 : this.now() - this.startedAt,
      searches: this.searches, pages: this.pages, sources: [...this.sources.values()], hint })
  }
  private start() {
    if (this.startedAt !== null) return
    this.startedAt = this.now(); this.emit('searching')
    this.timers.push(setTimeout(() => { if (!this.terminal && this.running > 0) this.emit(this.phase, true) }, 1500))
    this.timers.push(setTimeout(() => { if (!this.terminal) this.emit(this.running ? this.phase : 'waiting') }, 5000))
    this.timers.push(setTimeout(() => this.finish('timeout'), this.deps.assets.realtimeSearchPolicy().timeoutMs))
  }
  private assertActive() {
    this.deps.assertCurrent()
    if (this.terminal || this.controller.signal.aborted) throw new Error('REALTIME_SEARCH_ENDED')
    if (this.startedAt !== null && this.now() - this.startedAt >= this.deps.assets.realtimeSearchPolicy().timeoutMs) {
      this.finish('timeout'); throw new Error('REALTIME_SEARCH_TIMEOUT')
    }
  }
  finish(phase: 'ready' | 'timeout' | 'cancelled' | 'failed' = 'ready') {
    if (this.terminal) return
    this.terminal = true; this.timers.forEach(clearTimeout); this.timers = []
    this.controller.abort(); this.waiters.splice(0).forEach(wake => wake())
    if (this.startedAt !== null) this.emit(phase)
  }
  answerStarted() { if (this.startedAt !== null && this.running === 0) this.finish('ready') }
  async execute(alias: string, input: unknown, callId: string): Promise<Record<string, unknown>> {
    this.deps.assertCurrent(); this.deps.assets.validateToolInput(alias, input)
    if (!['web_search', 'web_read_page'].includes(alias)) throw new Error('MODEL_TOOL_NOT_EXPOSED')
    const fingerprint = JSON.stringify({ alias, input }), prior = this.calls.get(callId)
    if (prior) { if (prior.fingerprint !== fingerprint) throw new Error('CONVERSATION_CALL_ID_REUSED'); return prior.result }
    const args = input as { query: string; location?: string; dateRange?: string; url: string; sourceRef?: string; fields: string[] }
    let key: string
    try {
      key = alias === 'web_search' ? `search:${validateSearchQuery([args.query, args.location, args.dateRange].filter(Boolean).join(' ')).normalize('NFKC').toLowerCase()}`
        : `page:${publicPageUrl(args.url).href}`
    } catch (error) { return this.receipt(alias, null, error instanceof Error ? error.message : 'SEARCH_QUERY_INVALID') }
    const cached = this.cache.get(key)
    // Dedupe also joins in-flight work with a different protocol call ID.
    const result = cached ?? this.run(alias, args)
    this.cache.set(key, result); this.calls.set(callId, { fingerprint, result })
    return result
  }
  private receipt(alias: string, data: Record<string, unknown> | null, errorCode: string | null) {
    const result = { kind: 'receipt', actionId: randomUUID(), tool: this.deps.assets.toolDefinition(alias).name,
      status: errorCode ? 'failed' : 'succeeded', entityId: null, entityVersion: null, data: data ?? {}, errorCode, retryable: false, runId: null }
    this.deps.assets.validateToolOutput(alias, result); this.deps.assertCurrent(); this.deps.save(result)
    return result
  }
  private async run(alias: string, args: { query: string; location?: string; dateRange?: string; url: string; sourceRef?: string; fields: string[] }) {
    let occupied = false
    try {
      this.assertActive()
      const policy = this.deps.assets.realtimeSearchPolicy()
      if (alias === 'web_search') {
        if (this.searches >= policy.queries) throw new Error('REALTIME_SEARCH_QUERY_BUDGET_EXHAUSTED')
        const query = validateSearchQuery([args.query, args.location, args.dateRange].filter(Boolean).join(' '))
        if ([...query].length > 100) throw new Error('SEARCH_QUERY_TOO_LONG_MAX_100')
        this.searches++
      } else {
        if (this.pages >= policy.pages) throw new Error('REALTIME_SEARCH_PAGE_BUDGET_EXHAUSTED')
        const url = publicPageUrl(args.url).href
        if (!args.sourceRef || ![...this.sources.values()].some(source => source.sourceRef === args.sourceRef && publicPageUrl(source.url).href === url)) throw new Error('REALTIME_SEARCH_PAGE_SOURCE_INVALID')
        this.pages++
      }
      this.start()
      while (this.running >= policy.concurrency) {
        await new Promise<void>(wake => this.waiters.push(wake)); this.assertActive()
      }
      this.assertActive(); this.running++; occupied = true
      this.emit(alias === 'web_search' ? 'searching' : 'reading')
      const work = async (): Promise<Record<string, unknown>> => {
        if (alias === 'web_search') {
          const result = await this.deps.search.search([args.query, args.location, args.dateRange].filter(Boolean).join(' '), this.controller.signal)
          this.assertActive()
          const candidates = result.candidates.slice(0, policy.candidates)
          const sources = candidates.map(c => ({ sourceRef: `source:${c.candidateId}`, url: c.url, title: c.title,
            publishedAt: c.pageDate, accessedAt: c.queriedAtUtc, readStatus: 'not_read', snippet: [...c.snippet].slice(0, policy.snippetCodePoints).join('') }))
          sources.forEach(source => this.sources.set(source.sourceRef, source))
          return { resultId: randomUUID(), query: result.query, queriedAt: result.queriedAtUtc, sources,
            candidates: candidates.map(c => ({ candidateId: c.candidateId, label: [...c.title].slice(0, 200).join(''), sourceRefs: [`source:${c.candidateId}`],
              fields: [{ key: 'search_summary', value: [...c.snippet].slice(0, policy.snippetCodePoints).join(''), verification: 'unconfirmed', sourceRefs: [`source:${c.candidateId}`] }] })) }
        }
        const result = await this.deps.reader.read(args, this.controller.signal)
        this.assertActive()
        const content = [...result.content].slice(0, policy.pageCodePoints).join('')
        // A bounded excerpt must not be represented as a complete page read.
        if (content !== result.content) { result.truncated = true; result.source.readStatus = 'partial' }
        this.sources.set(result.source.sourceRef, result.source)
        return { ...result, content, contentHash: createHash('sha256').update(content).digest('hex') }
      }
      const signal = this.controller.signal
      let abortListener: () => void = () => undefined
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new Error('REALTIME_SEARCH_TIMEOUT_OR_CANCELLED'))
        signal.addEventListener('abort', abortListener, { once: true })
        if (signal.aborted) abortListener()
      })
      try { return this.receipt(alias, await Promise.race([work(), aborted]), null) }
      finally { signal.removeEventListener('abort', abortListener) }
    } catch (error) {
      this.deps.assertCurrent()
      const code = error instanceof SearchProviderError ? error.code : error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'SEARCH_REMOTE_FAILED'
      return this.receipt(alias, null, code)
    } finally {
      if (occupied) { this.running--; this.waiters.shift()?.() }
      if (!this.terminal && this.startedAt !== null && !this.running) this.emit('waiting')
    }
  }
}
