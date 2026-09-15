import { describe, expect, it } from 'vitest'
import type { AiProviderType } from '../../shared/ai-types'
import { LimitedLineDecoder, type ParsedStreamEvent } from './stream-parser'
import { buildChatRequest, buildModelsRequest, createChatStreamParser, extractChatText, extractModelPage, serializeChatRequestBody, type ModelMessage } from './provider-protocols'

const history: ModelMessage[] = [
  { role: 'system', content: '系统提示' },
  { role: 'user', content: '之前的问题' },
  { role: 'assistant', content: '之前的回答' },
  { role: 'user', content: '继续' },
]
const attachments: ModelMessage[] = [{
  role: 'user',
  content: [
    { type: 'text', text: '识别这些附件' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=', detail: 'high' } },
    { type: 'file', file: { filename: '扫描.pdf', file_data: 'data:application/pdf;base64,cGRm' } },
  ],
}]

function request(type: AiProviderType, messages = history, stream = false) {
  return buildChatRequest({ type, baseUrl: 'https://gateway.example/prefix/v1/', model: 'model-test' }, 'key-test', messages, stream)
}

function sse(...events: Array<Record<string, unknown> | string>): string {
  return events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join('')
}

/** Split inside UTF-8 code points, JSON tokens and SSE separators as a real network can. */
function fragmentedStream(type: AiProviderType, body: string): ParsedStreamEvent[] {
  const decoder = new LimitedLineDecoder(100_000)
  const parser = createChatStreamParser(type)
  const events: ParsedStreamEvent[] = []
  const bytes = new TextEncoder().encode(body)
  for (let offset = 0; offset < bytes.length; offset += 2) {
    for (const line of decoder.push(bytes.slice(offset, offset + 2))) events.push(...parser.pushLine(line))
  }
  for (const line of decoder.finish()) events.push(...parser.pushLine(line))
  events.push(...parser.finish())
  return events
}

function responseOutput(text = '回答') {
  return { status: 'completed', output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'private' }] }, { type: 'message', content: [{ type: 'output_text', text }] }] }
}

describe('provider protocol requests', () => {
  it.each([
    ['openai-compatible', '/chat/completions', 'Authorization', 'Bearer key-test'],
    ['openai-responses', '/responses', 'Authorization', 'Bearer key-test'],
    ['anthropic', '/messages', 'x-api-key', 'key-test'],
    ['gemini', '/models/model-test:generateContent', 'x-goog-api-key', 'key-test'],
    ['ollama', '/api/chat', 'Authorization', 'Bearer key-test'],
  ] as const)('uses the %s endpoint and native authentication', (type, suffix, keyHeader, headerValue) => {
    const result = request(type)
    expect(result.url).toBe(`https://gateway.example/prefix/v1${suffix}`)
    expect(result.headers[keyHeader]).toBe(headerValue)
    expect(result.url).not.toContain('key-test')
    expect(result.headers['Content-Type']).toBe('application/json')
  })

  it('keeps OpenAI Chat Completions messages intact', () => {
    expect(request('openai-compatible').body).toEqual({ model: 'model-test', messages: history, stream: false })
  })

  it('converts Responses history and multimodal blocks without storing responses remotely', () => {
    const result = request('openai-responses', [...history.slice(0, 3), ...attachments], true)
    expect(result.body).toMatchObject({ model: 'model-test', stream: true, store: false })
    expect(result.body.input).toEqual([
      { role: 'system', content: '系统提示' },
      { role: 'user', content: [{ type: 'input_text', text: '之前的问题' }] },
      { role: 'assistant', content: '之前的回答' },
      { role: 'user', content: [
        { type: 'input_text', text: '识别这些附件' },
        { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=', detail: 'high' },
        { type: 'input_file', filename: '扫描.pdf', file_data: 'data:application/pdf;base64,cGRm' },
      ] },
    ])
  })

  it('puts Anthropic system instructions outside messages and converts image/PDF sources', () => {
    const result = request('anthropic', [...history.slice(0, 3), ...attachments], true)
    expect(result.headers['anthropic-version']).toBe('2023-06-01')
    expect(result.headers.Authorization).toBeUndefined()
    expect(result.body).toEqual({
      model: 'model-test', max_tokens: 4096, system: '系统提示', stream: true,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '之前的问题' }] },
        { role: 'assistant', content: [{ type: 'text', text: '之前的回答' }] },
        { role: 'user', content: [
          { type: 'text', text: '识别这些附件' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' } },
        ] },
      ],
    })
  })

  it('supports Anthropic URL image sources but rejects unsupported image MIME types', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://files.example/image.png' } }] }]
    expect(request('anthropic', messages).body.messages).toEqual([{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://files.example/image.png' } }] }])
    expect(() => request('anthropic', [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,eA==' } }] }])).toThrow('仅支持')
  })

  it('maps Gemini assistant history to model and uses inlineData for images and PDFs', () => {
    const result = request('gemini', [...history.slice(0, 3), ...attachments], true)
    expect(result.url).toBe('https://gateway.example/prefix/v1/models/model-test:streamGenerateContent?alt=sse')
    expect(result.headers.Accept).toBe('text/event-stream')
    expect(result.body).toEqual({
      systemInstruction: { parts: [{ text: '系统提示' }] },
      contents: [
        { role: 'user', parts: [{ text: '之前的问题' }] },
        { role: 'model', parts: [{ text: '之前的回答' }] },
        { role: 'user', parts: [
          { text: '识别这些附件' },
          { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
          { inlineData: { mimeType: 'application/pdf', data: 'cGRm' } },
        ] },
      ],
    })
  })

  it('encodes Gemini model path segments and preserves a proxy prefix', () => {
    const result = buildChatRequest({ type: 'gemini', baseUrl: 'https://gateway.example/google/v1beta', model: 'models/custom/name?x=y' }, 'secret', history, true)
    expect(result.url).toBe('https://gateway.example/google/v1beta/models/custom%2Fname%3Fx%3Dy:streamGenerateContent?alt=sse')
  })

  it('constructs Ollama images separately from message text', () => {
    const result = request('ollama', [{ role: 'user', content: (attachments[0].content as unknown[]).slice(0, 2) }], true)
    expect(result.body.messages).toEqual([{ role: 'user', content: '识别这些附件', images: ['aGVsbG8='] }])
    expect(result.headers.Accept).toBe('application/x-ndjson')
    expect(() => request('ollama', attachments)).toThrow('PDF')
  })

  it.each(['anthropic', 'gemini', 'ollama'] as const)('rejects malformed inline attachments for %s without silently dropping them', type => {
    expect(() => request(type, [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///private/image.png' } }] }])).toThrow('Base64')
    expect(() => request(type, [{ role: 'user', content: [{ type: 'unknown', text: 'lost input' }] }])).toThrow('不支持')
  })

  it.each(['openai-compatible', 'openai-responses', 'anthropic', 'gemini', 'ollama'] as const)('permits keyless %s gateways without an empty authentication header', type => {
    const result = buildChatRequest({ type, baseUrl: 'http://localhost:8000', model: 'model' }, '', history, false)
    expect(result.headers.Authorization).toBeUndefined()
    expect(result.headers['x-api-key']).toBeUndefined()
    expect(result.headers['x-goog-api-key']).toBeUndefined()
  })
})

describe('native provider request size limits', () => {
  it.each([
    ['anthropic', 32_000_000],
    ['gemini', 20_000_000],
  ] as const)('enforces the %s JSON request byte limit including encoding overhead', (type, limit) => {
    const overhead = JSON.stringify({ text: '' }).length
    const body = { text: 'a'.repeat(limit - overhead) }
    expect(serializeChatRequestBody(type, body).length).toBe(limit)
    body.text += 'a'
    expect(() => serializeChatRequestBody(type, body)).toThrow(`超过 ${limit / 1_000_000} MB`)
    // A Chinese character occupies one JS code unit but three UTF-8 bytes.
    body.text = 'a'.repeat(limit - overhead - 2) + '中'
    expect(JSON.stringify(body).length).toBeLessThan(limit)
    expect(() => serializeChatRequestBody(type, body)).toThrow('超过')
  })

  it('checks the Anthropic limit against Base64 image size rather than decoded file size', () => {
    const imageMessage = (data: string): ModelMessage[] => [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }] }]
    const base64 = 'A'.repeat(10_000_000)
    expect(() => request('anthropic', imageMessage(base64))).not.toThrow()
    expect(() => request('anthropic', imageMessage(`${base64}AAAA`))).toThrow('Base64 编码超过 10 MB')
  })

  it.each(['openai-compatible', 'openai-responses', 'anthropic', 'gemini', 'ollama'] as const)('returns the exact serialized %s body for ordinary inputs', type => {
    const body = request(type).body
    expect(serializeChatRequestBody(type, body)).toBe(JSON.stringify(body))
  })
})

describe('provider JSON response extraction', () => {
  it('extracts Responses text while excluding reasoning output', () => {
    expect(extractChatText('openai-responses', responseOutput())).toBe('回答')
  })

  it('extracts only Anthropic text blocks', () => {
    expect(extractChatText('anthropic', { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private', text: 'private' }, { type: 'text', text: ' 回答 ' }] })).toBe('回答')
  })

  it('extracts only Gemini answer parts from the first candidate', () => {
    expect(extractChatText('gemini', { candidates: [{ index: 0, finishReason: 'STOP', content: { parts: [{ thought: true, text: 'private' }, { text: ' 回答 ' }] } }, { index: 1, finishReason: 'STOP', content: { parts: [{ text: 'second' }] } }] })).toBe('回答')
  })

  it.each([
    ['openai-compatible', { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }],
    ['openai-responses', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }],
    ['anthropic', { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial' }] }],
    ['gemini', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }] }],
    ['ollama', { done: true, done_reason: 'length', message: { content: 'partial' } }],
  ] as const)('rejects truncated %s output', (type, data) => {
    expect(() => extractChatText(type, data)).toThrow(/截断|未正常完成/)
  })

  it.each([
    ['openai-compatible', { choices: [{ finish_reason: 'stop', message: { refusal: 'refused', content: 'partial' } }] }],
    ['openai-responses', { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'refused' }] }] }],
    ['anthropic', { stop_reason: 'refusal', content: [{ type: 'text', text: 'partial' }] }],
    ['gemini', { promptFeedback: { blockReason: 'SAFETY' } }],
  ] as const)('rejects %s refusals and filters', (type, data) => {
    expect(() => extractChatText(type, data)).toThrow('拒绝')
  })

  it.each(['openai-compatible', 'openai-responses', 'anthropic', 'gemini', 'ollama'] as const)('surfaces %s JSON error envelopes', type => {
    expect(() => extractChatText(type, { error: { message: 'unavailable' } })).toThrow('unavailable')
  })

  it('does not treat an empty successful response as a completed answer', () => {
    expect(() => extractChatText('openai-responses', { status: 'completed', output: [] })).toThrow('没有返回文本')
    expect(() => extractChatText('gemini', { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'private' }] } }] })).toThrow('没有返回文本')
    expect(() => extractChatText('anthropic', { content: [{ type: 'text', text: 'partial' }] })).toThrow('未正常完成')
  })

  it('preserves native error codes and types needed for key rotation', () => {
    expect(() => extractChatText('anthropic', { type: 'error', error: { type: 'authentication_error', message: 'invalid credentials' } })).toThrow('authentication_error')
    expect(() => extractChatText('gemini', { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'exhausted' } })).toThrow('429 RESOURCE_EXHAUSTED')
  })
})

describe('provider fragmented streaming protocols', () => {
  it('streams Responses Unicode text and waits for response.completed without duplicating the final output', () => {
    const result = fragmentedStream('openai-responses', sse(
      { type: 'response.created', response: { status: 'in_progress' } },
      { type: 'response.reasoning_summary_text.delta', delta: 'private' },
      { type: 'response.output_text.delta', delta: '你' },
      { type: 'response.output_text.delta', delta: '好！' },
      { type: 'response.output_text.done', text: '你好！' },
      { type: 'response.completed', response: responseOutput('你好！') },
    ))
    expect(result).toEqual([{ delta: '你', done: false }, { delta: '好！', done: false }, { delta: '', done: true }])
  })

  it('can use a complete Responses final object if a gateway omits text delta events', () => {
    expect(fragmentedStream('openai-responses', sse({ type: 'response.completed', response: responseOutput() }))).toEqual([{ delta: '回答', done: true }])
  })

  it('streams Anthropic text while ignoring thinking, pings and unknown events', () => {
    const result = fragmentedStream('anthropic', ': ping\r\n\r\n' + sse(
      { type: 'message_start', message: { content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'private' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private' } },
      { type: 'ping' },
      { type: 'future_event', text: 'private' },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ))
    expect(result).toEqual([{ delta: '你好', done: false }, { delta: '', done: true }])
  })

  it('streams Gemini visible text and accepts the final STOP reason', () => {
    const result = fragmentedStream('gemini', sse(
      { candidates: [{ content: { parts: [{ thought: true, text: 'private' }] } }] },
      { candidates: [{ content: { parts: [{ text: '你好' }] } }] },
      { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '！' }] } }] },
    ))
    expect(result).toEqual([{ delta: '你好', done: false }, { delta: '！', done: true }])
  })

  it('continues to parse Chat Completions and Ollama with explicit completion', () => {
    expect(fragmentedStream('openai-compatible', sse({ choices: [{ delta: { reasoning_content: 'private', content: '你好' } }] }, '[DONE]'))).toEqual([{ delta: '你好', done: false }, { delta: '', done: true }])
    expect(fragmentedStream('ollama', '{"message":{"thinking":"private","content":"你好"},"done":false}\n{"message":{"content":""},"done":true,"done_reason":"stop"}\n')).toEqual([{ delta: '你好', done: false }, { delta: '', done: true }])
  })

  it('supports named SSE events, multi-line data, CRLF and final frames without a separator', () => {
    const body = 'event: response.output_text.delta\r\ndata: {"delta":\r\ndata: "你好"}\r\n\r\nevent: response.completed\r\ndata: {"response":{"status":"completed","output":[]}}'
    expect(fragmentedStream('openai-responses', body)).toEqual([{ delta: '你好', done: false }, { delta: '', done: true }])
  })

  it.each([
    ['openai-compatible', { choices: [{ delta: { content: 'partial' } }] }],
    ['openai-responses', { type: 'response.output_text.delta', delta: 'partial' }],
    ['anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }],
    ['gemini', { candidates: [{ content: { parts: [{ text: 'partial' }] } }] }],
  ] as const)('rejects abrupt EOF in %s even after visible output', (type, data) => {
    expect(() => fragmentedStream(type, sse(data))).toThrow('意外中断')
  })

  it('rejects abrupt Ollama EOF and missing Anthropic stop reasons', () => {
    expect(() => fragmentedStream('ollama', '{"message":{"content":"partial"},"done":false}')).toThrow('意外中断')
    expect(() => fragmentedStream('anthropic', sse({ type: 'message_stop' }))).toThrow('未正常完成')
  })

  it.each([
    ['openai-responses', { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }],
    ['openai-responses', { type: 'response.failed', response: { error: { message: 'failed fixture' } } }],
    ['openai-responses', { type: 'response.refusal.delta', delta: 'refused' }],
    ['anthropic', { type: 'error', error: { type: 'overloaded_error', message: 'overloaded fixture' } }],
    ['anthropic', { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }],
    ['anthropic', { type: 'message_delta', delta: { stop_reason: 'refusal' } }],
    ['gemini', { error: { code: 429, message: 'quota fixture' } }],
    ['gemini', { candidates: [{ finishReason: 'SAFETY' }] }],
    ['gemini', { candidates: [{ finishReason: 'MAX_TOKENS' }] }],
    ['gemini', { promptFeedback: { blockReason: 'BLOCKLIST' } }],
    ['openai-compatible', { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }],
  ] as const)('rejects %s stream error/abnormal termination: %j', (type, data) => {
    expect(() => fragmentedStream(type, sse(data))).toThrow()
  })

  it.each(['openai-responses', 'anthropic', 'gemini'] as const)('does not accept an OpenAI DONE marker as %s protocol completion', type => {
    expect(() => fragmentedStream(type, sse('[DONE]'))).toThrow('缺少协议完成事件')
  })

  it.each(['openai-compatible', 'openai-responses', 'anthropic', 'gemini'] as const)('rejects malformed %s stream JSON', type => {
    expect(() => fragmentedStream(type, 'data: [broken\n\n')).toThrow('无法解析')
  })
})

describe('provider model discovery protocols', () => {
  it.each(['openai-compatible', 'openai-responses'] as const)('uses /models and id fields for %s', type => {
    const result = buildModelsRequest(type, 'https://gateway.example/v1', 'secret')
    expect(result).toEqual({ url: 'https://gateway.example/v1/models', headers: { Accept: 'application/json', Authorization: 'Bearer secret' } })
    expect(extractModelPage(type, { data: [{ id: 'model-a' }, { id: 'model-a' }, { id: 'model-b' }] })).toEqual({ ids: ['model-a', 'model-b'] })
    expect(extractModelPage(type, { data: ['model-a', 'model-a', ' model-b ', { id: 'model-c' }] })).toEqual({ ids: ['model-a', 'model-b', 'model-c'] })
  })

  it('maps Anthropic last_id to the next after_id query parameter', () => {
    const page = extractModelPage('anthropic', { data: [{ id: 'claude-a' }], has_more: true, last_id: 'cursor+/=?' })
    expect(page).toEqual({ ids: ['claude-a'], nextPageToken: 'cursor+/=?' })
    const result = buildModelsRequest('anthropic', 'https://gateway.example/anthropic/v1/', 'secret', page.nextPageToken)
    const url = new URL(result.url)
    expect(url.pathname).toBe('/anthropic/v1/models')
    expect(url.searchParams.get('after_id')).toBe('cursor+/=?')
    expect(url.searchParams.get('limit')).toBe('1000')
    expect(result.headers['x-api-key']).toBe('secret')
    expect(result.headers['anthropic-version']).toBe('2023-06-01')
    expect(extractModelPage('anthropic', { data: [], has_more: false, last_id: 'final' })).toEqual({ ids: [] })
    expect(() => extractModelPage('anthropic', { data: [], has_more: true })).toThrow('游标')
  })

  it('maps Gemini pagination and filters models that do not support generateContent', () => {
    const page = extractModelPage('gemini', { models: [
      { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/embedding-a', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/custom-relay-model' },
    ], nextPageToken: 'page/+=' })
    expect(page).toEqual({ ids: ['gemini-a', 'custom-relay-model'], nextPageToken: 'page/+=' })
    const result = buildModelsRequest('gemini', 'https://gateway.example/google/v1beta', 'secret', page.nextPageToken)
    const url = new URL(result.url)
    expect(url.pathname).toBe('/google/v1beta/models')
    expect(url.searchParams.get('pageToken')).toBe('page/+=')
    expect(url.searchParams.get('pageSize')).toBe('1000')
    expect(url.searchParams.has('key')).toBe(false)
    expect(result.url).not.toContain('secret')
    expect(result.headers['x-goog-api-key']).toBe('secret')
  })

  it('uses Ollama /api/tags and name/model fields', () => {
    expect(buildModelsRequest('ollama', 'http://localhost:11434', '').url).toBe('http://localhost:11434/api/tags')
    expect(extractModelPage('ollama', { models: [{ name: 'qwen:8b' }, { model: 'llama:latest' }] })).toEqual({ ids: ['qwen:8b', 'llama:latest'] })
  })

  it('rejects invalid model list and error envelopes', () => {
    expect(() => extractModelPage('anthropic', { error: { message: 'auth failed' } })).toThrow('auth failed')
    expect(() => extractModelPage('gemini', { models: 'invalid' })).toThrow('无效数据')
  })
})
