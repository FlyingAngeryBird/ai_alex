import { describe, expect, it, vi } from 'vitest'
import {
  createVolcengineLlmProvider,
  extractReplySoFar,
  parseAssistantOutput,
  VolcengineLlmError
} from '../electron/main/providers/llmProvider'

describe('assistant output parser', () => {
  it('parses structured chat output', () => {
    expect(parseAssistantOutput('{"reply":"我在呢","intent":"chat","music":null}')).toEqual({
      intent: 'chat',
      music: null,
      reply: '我在呢'
    })
  })

  it('falls back to chat when model output is plain text', () => {
    expect(parseAssistantOutput('我们慢慢聊。')).toEqual({
      intent: 'chat',
      music: null,
      reply: '我们慢慢聊。'
    })
  })
  it('does not turn a song mention or a legacy model intent label into a playback action', () => {
    expect(parseAssistantOutput('谈谈《晴天》的歌词。')).toEqual({ intent: 'chat', music: null,
      reply: '谈谈《晴天》的歌词。' })
    expect(parseAssistantOutput('{"reply":"已播放","intent":"play_music","music":{"keyword":"晴天"}}'))
      .toEqual({ intent: 'chat', music: null, reply: '已播放' })
  })
})

describe('Volcengine LLM provider', () => {
  it('calls Ark chat completions with configured model', async () => {
    const fetcher = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"reply":"你好呀","intent":"chat","music":null}'
              }
            }
          ]
        }),
        {
          status: 200
        }
      )
    })
    const provider = createVolcengineLlmProvider({
      env: {
        VOLCENGINE_ARK_API_KEY: 'ark-key',
        VOLCENGINE_ARK_BASE_URL: 'https://ark.cn-beijing.volces.com/api/v3',
        VOLCENGINE_ARK_MODEL: 'doubao-test'
      },
      fetch: fetcher
    })

    await expect(provider.sendMessage([{ role: 'user', content: '你好' }])).resolves.toEqual({
      intent: 'chat',
      music: null,
      reply: '你好呀'
    })
    const fetchCall = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    const request = JSON.parse(fetchCall[1]?.body as string) as {
      messages: Array<{ content: string; role: string }>
    }

    expect(request.messages).toContainEqual({ content: '你好', role: 'user' })
    expect(fetcher).toHaveBeenCalledWith(
      'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      expect.objectContaining({
        body: expect.stringContaining('"model":"doubao-test"'),
        headers: expect.objectContaining({
          Authorization: 'Bearer ark-key',
          'Content-Type': 'application/json'
        }),
        method: 'POST'
      })
    )
  })

  it('fails clearly when Ark credentials are missing', async () => {
    const provider = createVolcengineLlmProvider({
      env: {}
    })

    await expect(provider.sendMessage([{ role: 'user', content: '你好' }])).rejects.toThrow(
      VolcengineLlmError
    )
  })

  it('times out instead of hanging when Ark chat completions do not answer', async () => {
    const provider = createVolcengineLlmProvider({
      env: {
        VOLCENGINE_ARK_API_KEY: 'ark-key',
        VOLCENGINE_ARK_MODEL: 'doubao-test'
      },
      fetch: vi.fn(() => new Promise<Response>(() => undefined)),
      timeoutMs: 1
    })

    await expect(provider.sendMessage([{ role: 'user', content: '你好' }])).rejects.toMatchObject({
      code: 'LLM_TIMEOUT'
    })
  })
})

describe('extractReplySoFar', () => {
  it('extracts reply content as it streams', () => {
    expect(extractReplySoFar('{"reply":"你好')).toBe('你好')
    expect(extractReplySoFar('{"reply":"你好呀","intent":"chat","music":null}')).toBe('你好呀')
  })

  it('returns null before reply prefix completes', () => {
    expect(extractReplySoFar('{"rep')).toBeNull()
    expect(extractReplySoFar('{"reply":')).toBeNull()
  })

  it('unescapes json string escapes', () => {
    expect(extractReplySoFar('{"reply":"a\\nb')).toBe('a\nb')
  })
})

function createSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    }
  })

  return new Response(stream, { status: 200 })
}

describe('Volcengine LLM streaming', () => {
  it('streams reply tokens via onChunk and returns parsed output', async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"reply":"你好' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '呀","intent":"chat","music":null}' } }] })}\n\n`,
      'data: [DONE]\n\n'
    ]
    const fetcher = vi.fn(async () => createSseResponse(sse))
    const provider = createVolcengineLlmProvider({
      env: { VOLCENGINE_ARK_API_KEY: 'ark-key', VOLCENGINE_ARK_MODEL: 'doubao-test' },
      fetch: fetcher
    })
    const deltas: string[] = []
    const result = await provider.streamMessage([{ role: 'user', content: 'hi' }], {
      onChunk: (delta) => deltas.push(delta)
    })

    expect(deltas.join('')).toBe('你好呀')
    expect(result).toEqual({ intent: 'chat', music: null, reply: '你好呀' })
  })

  it('reports raw stream timing before reply text becomes extractable', async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"rep' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ly":"你好","intent":"chat","music":null}' } }] })}\n\n`,
      'data: [DONE]\n\n'
    ]
    const fetcher = vi.fn(async () => createSseResponse(sse))
    const provider = createVolcengineLlmProvider({
      env: { VOLCENGINE_ARK_API_KEY: 'ark-key', VOLCENGINE_ARK_MODEL: 'doubao-test' },
      fetch: fetcher
    })
    const events: string[] = []

    await provider.streamMessage([{ role: 'user', content: 'hi' }], {
      onChunk: () => events.push('reply'),
      onRawChunk: () => events.push('raw'),
      onResponseStart: () => events.push('response')
    })

    expect(events).toEqual(['response', 'raw', 'raw', 'reply'])
  })

  it('fails when stream response is not ok', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 500 }))
    const provider = createVolcengineLlmProvider({
      env: { VOLCENGINE_ARK_API_KEY: 'ark-key', VOLCENGINE_ARK_MODEL: 'doubao-test' },
      fetch: fetcher
    })

    await expect(
      provider.streamMessage([{ role: 'user', content: 'hi' }], { onChunk: () => undefined })
    ).rejects.toThrow(VolcengineLlmError)
  })
})
