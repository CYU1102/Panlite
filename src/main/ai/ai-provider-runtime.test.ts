import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderConfig, AiProviderType } from '../../shared/ai-types'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), active: vi.fn(), usage: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: mocks.fetch } }))
vi.mock('./ai-provider-store', async importOriginal => ({
  ...await importOriginal<typeof import('./ai-provider-store')>(),
  getActiveAiProvider: mocks.active,
  recordAiProviderUsage: mocks.usage,
}))

import { callAiModel, callAiModelStream, listProviderModels, testAiProviderConfig } from './ai-provider'

let sequence = 0
function useProvider(type: AiProviderType, keys = ['fixture-key']): AiProviderConfig {
  const config: AiProviderConfig = { id: `runtime-${++sequence}`, name: 'Fixture', type,
    baseUrl: 'https://models.example.test/v1', model: 'fixture-model',
    transcriptionModel: '', embeddingModel: '', hasApiKey: keys.length > 0 }
  mocks.active.mockReturnValue({ config, keys, apiKey: keys[0] || '' })
  return config
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function stream(text: string): Response {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}

const cases: Array<{ type: AiProviderType; endpoint: string; auth: string; payload: unknown; events: string }> = [
  { type: 'openai-compatible', endpoint: '/chat/completions', auth: 'Authorization',
    payload: { choices: [{ message: { content: '你好' }, finish_reason: 'stop' }] },
    events: 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n' },
  { type: 'openai-responses', endpoint: '/responses', auth: 'Authorization',
    payload: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '你好' }] }] },
    events: 'data: {"type":"response.output_text.delta","delta":"你好"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n' },
  { type: 'anthropic', endpoint: '/messages', auth: 'x-api-key',
    payload: { content: [{ type: 'text', text: '你好' }], stop_reason: 'end_turn' },
    events: 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n' },
  { type: 'gemini', endpoint: '/models/fixture-model:generateContent', auth: 'x-goog-api-key',
    payload: { candidates: [{ content: { parts: [{ text: '你好' }] }, finishReason: 'STOP' }] },
    events: 'data: {"candidates":[{"content":{"parts":[{"text":"你好"}]},"finishReason":"STOP"}]}\n\n' },
  { type: 'ollama', endpoint: '/api/chat', auth: 'Authorization',
    payload: { message: { content: '你好' }, done: true, done_reason: 'stop' },
    events: '{"message":{"content":"你好"},"done":true,"done_reason":"stop"}\n' },
]

beforeEach(() => { vi.clearAllMocks(); mocks.fetch.mockReset() })

describe('provider runtime routing', () => {
  it.each(cases)('$type uses its native request and authentication for real chat calls', async row => {
    const config = useProvider(row.type)
    mocks.fetch.mockResolvedValueOnce(json(row.payload))
    expect(await callAiModel('system', 'question', [{ role: 'assistant', content: 'history' }])).toBe('你好')
    const [url, options] = mocks.fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${config.baseUrl}${row.endpoint}`)
    expect((options.headers as Record<string, string>)[row.auth]).toBe(row.auth === 'Authorization' ? 'Bearer fixture-key' : 'fixture-key')
    expect(url).not.toContain('fixture-key')
    expect(options.redirect).toBe('error')
    expect(mocks.usage).toHaveBeenCalledWith(config.id, expect.any(Number), 2, expect.any(Number), false)
  })

  it.each(cases)('$type streams text through split UTF-8 chunks', async row => {
    const config = useProvider(row.type)
    const onDelta = vi.fn()
    mocks.fetch.mockResolvedValueOnce(stream(row.events))
    expect(await callAiModelStream('system', 'question', [], { onDelta })).toBe('你好')
    expect(onDelta.mock.calls.map(call => call[0]).join('')).toBe('你好')
    const endpoint = row.type === 'gemini' ? '/models/fixture-model:streamGenerateContent?alt=sse' : row.endpoint
    expect(mocks.fetch.mock.calls[0][0]).toBe(`${config.baseUrl}${endpoint}`)
    expect(mocks.fetch.mock.calls[0][1].redirect).toBe('error')
  })

  it('uses the newly active profile for the next request', async () => {
    const first = useProvider('openai-compatible')
    mocks.fetch.mockResolvedValueOnce(json(cases[0].payload))
    await callAiModel('system', 'first')
    const second = useProvider('anthropic', ['second-key'])
    mocks.fetch.mockResolvedValueOnce(json(cases[2].payload))
    await callAiModel('system', 'second')
    expect(mocks.fetch.mock.calls[1][0]).toBe(`${second.baseUrl}/messages`)
    expect(mocks.fetch.mock.calls[1][1].headers['x-api-key']).toBe('second-key')
    expect(mocks.usage.mock.calls.map(call => call[0])).toEqual([first.id, second.id])
  })

  it('rotates credentials on HTTP 401 even when the error message has no status code', async () => {
    useProvider('anthropic', ['expired-key', 'working-key'])
    mocks.fetch.mockResolvedValueOnce(json({ error: { message: 'Access denied' } }, 401))
      .mockResolvedValueOnce(json(cases[2].payload))
    expect(await callAiModel('system', 'question')).toBe('你好')
    expect(mocks.fetch.mock.calls.map(call => call[1].headers['x-api-key'])).toEqual(['expired-key', 'working-key'])
  })

  it('never restarts a stream after text has been delivered', async () => {
    useProvider('openai-compatible', ['first-key', 'second-key'])
    const onDelta = vi.fn()
    mocks.fetch.mockResolvedValueOnce(stream('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"message":"quota exceeded"}}\n\n'))
    await expect(callAiModelStream('system', 'question', [], { onDelta })).rejects.toThrow('quota')
    expect(onDelta).toHaveBeenCalledWith('partial')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('rotates credentials for native SSE authentication errors before any text', async () => {
    useProvider('anthropic', ['expired-key', 'working-key'])
    mocks.fetch.mockResolvedValueOnce(stream('event: error\ndata: {"type":"error","error":{"type":"authentication_error","message":"Access denied"}}\n\n'))
      .mockResolvedValueOnce(stream(cases[2].events))
    expect(await callAiModelStream('system', 'question', [], { onDelta: vi.fn() })).toBe('你好')
    expect(mocks.fetch.mock.calls.map(call => call[1].headers['x-api-key'])).toEqual(['expired-key', 'working-key'])
  })

  it.each([null, []])('rejects malformed JSON response objects (%j)', async payload => {
    useProvider('openai-compatible')
    mocks.fetch.mockResolvedValueOnce(json(payload))
    await expect(callAiModel('system', 'question')).rejects.toThrow('无法解析的数据')
  })

  it('reports an interrupted stream as failure instead of accepting partial text', async () => {
    useProvider('openai-responses')
    mocks.fetch.mockResolvedValueOnce(stream('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'))
    await expect(callAiModelStream('system', 'question', [], { onDelta: vi.fn() })).rejects.toThrow('中断')
  })

  it('honors the caller cancellation signal', async () => {
    useProvider('gemini')
    const controller = new AbortController()
    mocks.fetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      controller.abort()
      init.signal!.throwIfAborted()
    })
    await expect(callAiModelStream('system', 'question', [], { onDelta: vi.fn(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('tests unsaved appended credentials with the same rotation behavior', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ error: { message: 'Access denied' } }, 403))
      .mockResolvedValueOnce(json(cases[2].payload))
    await testAiProviderConfig({ type: 'anthropic', baseUrl: 'https://draft.example.test/v1', model: 'fixture', clearApiKey: true,
      appendKeys: ['old-draft-key', 'new-draft-key'] })
    expect(mocks.fetch.mock.calls.map(call => call[1].headers['x-api-key'])).toEqual(['old-draft-key', 'new-draft-key'])
  })

  it('collects native model pages and avoids showing embedding-only Gemini models', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ models: [{ name: 'models/chat-a', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'page 2' }))
      .mockResolvedValueOnce(json({ models: [{ name: 'models/embed-only', supportedGenerationMethods: ['embedContent'] }, { name: 'models/chat-b' }] }))
    expect(await listProviderModels({ type: 'gemini', baseUrl: 'https://models.example.test/v1beta', apiKey: 'fixture-key' })).toEqual(['chat-a', 'chat-b'])
    expect(new URL(mocks.fetch.mock.calls[1][0]).searchParams.get('pageToken')).toBe('page 2')
    expect(mocks.fetch.mock.calls.every(call => call[1].redirect === 'error')).toBe(true)
  })
})
