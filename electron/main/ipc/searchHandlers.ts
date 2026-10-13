import { ipcMain, shell } from 'electron'
import { createBraveSearchProvider, SearchProviderError, type SearchCandidate } from '../providers/braveSearchProvider.js'

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void
}

const messages: Record<string, string> = {
  SEARCH_QUERY_INVALID: '请输入不超过 600 字的查询词。',
  SEARCH_NOT_CONFIGURED: '尚未配置联网搜索密钥。请在设置中填写 Brave Search API Key。',
  SEARCH_NETWORK_FAILED: '网络连接失败，请稍后重试。',
  SEARCH_AUTH_FAILED: '搜索密钥无效或没有访问权限。',
  SEARCH_RATE_LIMITED: '搜索服务暂时达到限额，请稍后重试。',
  SEARCH_REMOTE_FAILED: '搜索服务暂时不可用，请稍后重试。',
  SEARCH_RESPONSE_INVALID: '搜索结果格式异常，请稍后重试。'
}

type Provider = ReturnType<typeof createBraveSearchProvider>

export function registerSearchHandlers(
  ipc: IpcMainLike = ipcMain,
  provider: Provider = createBraveSearchProvider(),
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
