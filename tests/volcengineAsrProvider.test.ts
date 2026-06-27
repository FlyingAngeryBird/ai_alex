import { describe, expect, it, vi } from 'vitest'
import { createVolcengineAsrProvider, VolcengineAsrError } from '../electron/main/providers/asrProvider'

describe('Volcengine ASR provider', () => {
  it('returns a clear configuration error when credentials are missing', async () => {
    const provider = createVolcengineAsrProvider({
      env: {},
      fetch: vi.fn()
    })

    await expect(
      provider.transcribe({
        audio: new ArrayBuffer(4),
        mimeType: 'audio/webm'
      })
    ).rejects.toMatchObject({
      code: 'ASR_NOT_CONFIGURED'
    })
  })

  it('submits recorded audio and polls for transcription text', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'submitted' }), {
          status: 200,
          headers: {
            'X-Api-Status-Code': '20000000'
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: {
              text: '今天想聊聊天'
            }
          }),
          {
            status: 200,
            headers: {
              'X-Api-Status-Code': '20000000'
            }
          }
        )
      )
    const provider = createVolcengineAsrProvider({
      env: {
        VOLCENGINE_ASR_ACCESS_TOKEN: 'access-token',
        VOLCENGINE_ASR_APP_ID: 'app-id',
        VOLCENGINE_ASR_CLUSTER: 'volcengine_input_common',
        VOLCENGINE_ASR_RESOURCE_ID: 'volc.seedasr.auc'
      },
      fetch,
      requestId: () => 'request-1',
      sleep: async () => undefined
    })

    const result = await provider.transcribe({
      audio: new TextEncoder().encode('hello audio').buffer,
      mimeType: 'audio/webm;codecs=opus'
    })

    expect(result).toEqual({
      text: '今天想聊聊天'
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0][0]).toContain('/submit')
    expect(fetch.mock.calls[1][0]).toContain('/query')
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'X-Api-Access-Key': 'access-token',
        'X-Api-App-Key': 'app-id',
        'X-Api-Request-Id': 'request-1',
        'X-Api-Resource-Id': 'volc.seedasr.auc'
      })
    })

    const submitBody = JSON.parse(String(fetch.mock.calls[0][1]?.body))
    expect(submitBody.audio).toMatchObject({
      data: expect.any(String),
      format: 'webm'
    })
    expect(submitBody.request).toMatchObject({
      enable_itn: true,
      enable_punc: true
    })
  })

  it('normalizes provider failures into a typed ASR error', async () => {
    const provider = createVolcengineAsrProvider({
      env: {
        VOLCENGINE_ASR_ACCESS_TOKEN: 'access-token',
        VOLCENGINE_ASR_APP_ID: 'app-id'
      },
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'bad request' }), {
          status: 400,
          headers: {
            'X-Api-Status-Code': '45000001',
            'X-Api-Message': 'bad request'
          }
        })
      )
    })

    await expect(
      provider.transcribe({
        audio: new ArrayBuffer(4),
        mimeType: 'audio/wav'
      })
    ).rejects.toBeInstanceOf(VolcengineAsrError)
  })
})
