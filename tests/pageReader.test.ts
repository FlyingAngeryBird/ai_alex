import { expect, it } from 'vitest'
import { createPageReader, publicPageUrl, isPublicPageAddress } from '../electron/main/providers/pageReader'
it('extracts actual static page text and dates without treating requested absent fields as verified', async () => {
  const reader = createPageReader({ now: () => new Date('2026-10-14T08:00:00Z'), read: async url => ({ url: url.href,
    contentType: 'text/html; charset=utf-8', truncated: false, bytes: Buffer.from('<html><head><title>公园介绍</title><meta property="article:published_time" content="2026-10-01" /></head><body><nav>导航</nav><main><h1>公园介绍</h1><p>开放时间以现场通知为准。</p><script>不要显示</script><p hidden>隐藏</p></main></body></html>') }) })
  const result = await reader.read({ url: 'https://example.org/park', fields: ['title', 'price'] })
  expect(result.source).toMatchObject({ title: '公园介绍', publishedAt: '2026-10-01', readStatus: 'read', accessedAt: '2026-10-14T08:00:00.000Z' })
  expect(result.content).toContain('开放时间以现场通知为准。')
  expect(result.content).not.toMatch(/导航|不要显示|隐藏/)
  expect(result.fields[1]).toMatchObject({ key: 'price', value: null, verification: 'unconfirmed' })
})
it('marks size-limited or text-limited reading as partial rather than silently claiming a full page', async () => {
  const reader = createPageReader({ read: async url => ({ url: url.href, contentType: 'text/plain', truncated: true,
    bytes: Buffer.from('正文🙂'.repeat(8000)) }) })
  const result = await reader.read({ url: 'https://example.org/page', fields: [] })
  expect([...result.content]).toHaveLength(20000)
  expect(result).toMatchObject({ truncated: true, source: { readStatus: 'partial' } })
  expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/)
})
it('permits public destinations and rejects private, local, credential-bearing or non-web destinations', () => {
  for (const url of ['file:///private/a', 'http://127.0.0.1/', 'http://localhost/', 'http://[::1]/', 'https://user:password@example.org/', 'https://example.org:3000/']) expect(() => publicPageUrl(url)).toThrow()
  for (const address of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1']) expect(isPublicPageAddress(address)).toBe(false)
  expect(isPublicPageAddress('93.184.216.34')).toBe(true)
  expect(isPublicPageAddress('2606:4700:4700::1111')).toBe(true)
})
it('reads a real anchor after the text window and keeps a distinct source URL without inventing absent sections', async () => {
  const reader = createPageReader({ read: async url => {
    expect(url.hash).toBe('')
    return { url: url.href, contentType: 'text/html', truncated: false,
      bytes: Buffer.from(`<body><main><p>${'intro '.repeat(5000)}</p><section id="section-9.3.1"><h2>9.3.1 GET</h2><p>Target chapter body</p></section><section id="other">Unrelated chapter</section></main></body>`) }
  } })
  const base = await reader.read({ url: 'https://example.org/long', fields: [] })
  expect(base.content).not.toContain('Target chapter body')
  const target = await reader.read({ url: 'https://example.org/long#section-9.3.1', fields: [] })
  expect(target.content).toContain('9.3.1 GET')
  expect(target.content).toContain('Target chapter body')
  expect(target.content).not.toContain('Unrelated chapter')
  expect(target.source.url).toBe('https://example.org/long#section-9.3.1')
  expect(target.source.sourceRef).not.toBe(base.source.sourceRef)
  await expect(reader.read({ url: 'https://example.org/long#absent', fields: [] })).rejects.toThrow('PAGE_FRAGMENT_NOT_FOUND')
})
