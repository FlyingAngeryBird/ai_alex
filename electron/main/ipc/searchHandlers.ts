import { ipcMain, shell } from 'electron'
import { createDoubaoSearchProvider } from '../providers/doubaoSearchProvider.js'
import { SearchProviderError, type SearchCandidate, type SearchProvider } from '../providers/searchProvider.js'

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void
}

const messages: Record<string, string> = {
  SEARCH_QUERY_INVALID: '请输入不超过 600 字的查询词。',
  SEARCH_QUERY_TOO_LONG_MAX_100: '豆包搜索的单次查询最多 100 字，请缩短查询条件后重试。',
  SEARCH_NOT_CONFIGURED: '尚未配置联网搜索密钥。请在设置中填写 豆包搜索 Custom API Key。',
  SEARCH_NETWORK_FAILED: '网络连接失败，请稍后重试。',
  SEARCH_AUTH_FAILED: '搜索密钥无效或没有访问权限。',
  SEARCH_RATE_LIMITED: '搜索服务暂时达到限额，请稍后重试。',
  SEARCH_SERVICE_NOT_ENABLED: '豆包搜索服务未开通或当前密钥没有权限，请检查联网搜索控制台。',
  SEARCH_QUOTA_EXHAUSTED: '豆包搜索额度已用尽，请检查联网搜索控制台的额度与计费。',
  SEARCH_PLAN_UNAVAILABLE: '豆包搜索套餐未开通或已到期，请检查搜索 Key 所属套餐。',
  SEARCH_PLAN_UNSUPPORTED: '当前搜索 Key 的套餐不支持此搜索类型，请检查联网搜索控制台。',
  SEARCH_REMOTE_FAILED: '搜索服务暂时不可用，请稍后重试。',
  SEARCH_RESPONSE_INVALID: '搜索结果格式异常，请稍后重试。'
}

type Provider = SearchProvider

export function registerSearchHandlers(
  ipc: IpcMainLike = ipcMain,
  provider: Provider = createDoubaoSearchProvider(),
  openExternal: (url: string) => Promise<void> = (url) => shell.openExternal(url)
): void {
  const recent = new Map<string, SearchCandidate>()
  let searchVersion = 0
  ipc.handle('r1.search.web', async (_event, payload) => {
    const version = ++searchVersion
    try {
      const query = (payload as { query?: unknown } | null)?.query
      const result = await provider.search(query)
      if (version === searchVersion) {
        recent.clear()
        for (const candidate of result.candidates) recent.set(candidate.candidateId, candidate)
      }
      return { ok: true, data: result }
    } catch (error) {
      const code = error instanceof SearchProviderError ? error.code : 'SEARCH_REMOTE_FAILED'
      return { ok: false, error: { code, message: messages[code] ?? messages.SEARCH_REMOTE_FAILED } }
    }
  })
  ipc.handle('r1.search.open', async (_event, payload) => {
    const id = (payload as { candidateId?: unknown } | null)?.candidateId
    const candidate = typeof id === 'string' ? recent.get(id) : undefined
    if (!candidate) return { ok: false, error: { code: 'SEARCH_CANDIDATE_EXPIRED', message: '查询结果已变化，请重新搜索。' } }
    try {
      await openExternal(candidate.url)
      return { ok: true, data: { candidateId: candidate.candidateId } }
    } catch {
      return { ok: false, error: { code: 'SEARCH_OPEN_FAILED', message: '无法打开来源页面。' } }
    }
  })
}
