import type { IncomingMessage } from 'node:http'

export type NativeFailureDetails = {
  phase: 'http_upgrade' | 'session_event'; httpStatus?: number; providerCode?: string; logId?: string;
  reason?: 'resource_not_granted' | 'key_invalid' | 'unknown';
}
export function safeNativeFailureDetails(value: unknown): NativeFailureDetails | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  if (!['http_upgrade', 'session_event'].includes(String(input.phase))) return undefined
  const result: NativeFailureDetails = { phase: input.phase as NativeFailureDetails['phase'] }
  if (Number.isInteger(input.httpStatus) && Number(input.httpStatus) >= 100 && Number(input.httpStatus) <= 599) result.httpStatus = Number(input.httpStatus)
  if (typeof input.providerCode === 'string' && /^\d{3,10}$/.test(input.providerCode)) result.providerCode = input.providerCode
  if (typeof input.logId === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(input.logId)) result.logId = input.logId
  if (['resource_not_granted', 'key_invalid', 'unknown'].includes(String(input.reason))) result.reason = input.reason as NativeFailureDetails['reason']
  return result
}

/** Never return the response body, headers or arbitrary vendor messages. */
export async function readNativeUpgradeFailure(response: IncomingMessage): Promise<NativeFailureDetails> {
  const details: NativeFailureDetails = safeNativeFailureDetails({ phase: 'http_upgrade', httpStatus: response.statusCode,
    logId: response.headers?.['x-tt-logid'] })!
  return new Promise(resolve => {
    let size = 0, chunks: Buffer[] = [], settled = false
    const finish = () => {
      if (settled) return
      settled = true; clearTimeout(timer)
      response.removeListener('data', data); response.removeListener('end', finish); response.removeListener('error', finish); response.removeListener('close', finish)
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const raw = body && typeof body === 'object' ? body : {}
        const code = raw.error?.code ?? raw.code ?? raw.status_code
        if (/^\d{3,10}$/.test(String(code))) details.providerCode = String(code)
        const message = raw.error?.message ?? raw.message
        // Only exact known error phrases produce a category; other content is discarded.
        if (typeof message === 'string') details.reason = /requested resource.*not granted|resource.*not authorized/i.test(message)
          ? 'resource_not_granted' : /invalid api[ _-]?key|api[ _-]?key.*invalid/i.test(message) ? 'key_invalid' : 'unknown'
      } catch { /* Unknown or non-JSON response is represented only by HTTP status. */ }
      chunks = []; response.resume(); resolve(safeNativeFailureDetails(details)!)
    }
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > 16_384) { chunks = []; finish(); return }
      chunks.push(bytes)
    }
    const timer = setTimeout(finish, 1000)
    response.on('data', data); response.once('end', finish); response.once('error', finish); response.once('close', finish)
    response.resume()
  })
}
