import { Buffer } from 'node:buffer'
import type { AiProviderConfig, AiProviderType } from '../../shared/ai-types'
import type { ParsedStreamEvent } from './stream-parser'

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant'
  /** Chat Completions text, image_url and file content blocks are the internal input format. */
  content: unknown
}

export interface ProviderRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

export interface ChatStreamParser {
  pushLine(line: string): ParsedStreamEvent[]
  finish(): ParsedStreamEvent[]
}

type JsonRecord = Record<string, unknown>
type InputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; detail?: string }
  | { type: 'file'; data: string; filename: string }

// Conservative decimal MB budgets for the direct native APIs, measured after encoding.
// https://platform.claude.com/docs/en/build-with-claude/vision (10 MB base64 image)
// https://platform.claude.com/docs/en/api/errors (32 MB Messages request)
// https://ai.google.dev/gemini-api/docs/generate-content/image-understanding (20 MB inline request)
const ANTHROPIC_IMAGE_BASE64_BYTES = 10_000_000
const ANTHROPIC_REQUEST_BYTES = 32_000_000
const GEMINI_REQUEST_BYTES = 20_000_000

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record) : []
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function inputParts(content: unknown): InputPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) throw new Error('模型输入内容格式无效')
  return content.map(value => {
    if (typeof value === 'string') return { type: 'text', text: value }
    const part = record(value)
    if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text }
    if (part.type === 'image_url') {
      const image = record(part.image_url)
      const url = string(image.url) || string(part.image_url)
      if (url) return { type: 'image', url, ...(string(image.detail) ? { detail: string(image.detail) } : {}) }
    }
    if (part.type === 'file') {
      const file = record(part.file)
      if (string(file.file_data)) return { type: 'file', data: string(file.file_data), filename: string(file.filename) || 'document.pdf' }
    }
    throw new Error('模型输入包含不支持的内容类型')
  })
}

function textInput(content: unknown): string {
  return inputParts(content).map(part => {
    if (part.type !== 'text') throw new Error('系统提示和助手历史仅支持文本内容')
    return part.text
  }).join('')
}

function inlineData(value: string): { mimeType: string; data: string } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value)
  if (!match) throw new Error('当前协议的附件需要 Base64 数据，不能直接使用外部文件地址')
  return { mimeType: match[1], data: match[2].replace(/[\r\n]/g, '') }
}

function authHeaders(type: AiProviderType, apiKey: string): Record<string, string> {
  if (type === 'anthropic') return { 'anthropic-version': '2023-06-01', ...(apiKey ? { 'x-api-key': apiKey } : {}) }
  if (type === 'gemini') return apiKey ? { 'x-goog-api-key': apiKey } : {}
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

function responsesMessage(message: ModelMessage): JsonRecord {
  // Easy input messages accept assistant history as text, without inventing output IDs/statuses.
  if (message.role === 'assistant' || message.role === 'system') return { role: message.role, content: textInput(message.content) }
  return {
    role: message.role,
    content: inputParts(message.content).map(part => {
      if (part.type === 'text') return { type: 'input_text', text: part.text }
      if (part.type === 'image') return { type: 'input_image', image_url: part.url, ...(part.detail ? { detail: part.detail } : {}) }
      return { type: 'input_file', filename: part.filename, file_data: part.data }
    }),
  }
}

function anthropicMessage(message: ModelMessage): JsonRecord {
  return {
    role: message.role,
    content: inputParts(message.content).map(part => {
      if (part.type === 'text') return { type: 'text', text: part.text }
      if (part.type === 'image' && /^https?:\/\//i.test(part.url)) return { type: 'image', source: { type: 'url', url: part.url } }
      const media = inlineData(part.type === 'image' ? part.url : part.data)
      if (part.type === 'image' && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(media.mimeType)) {
        throw new Error('Anthropic 图片仅支持 JPEG、PNG、GIF 和 WebP')
      }
      if (part.type === 'image' && media.data.length > ANTHROPIC_IMAGE_BASE64_BYTES) {
        throw new Error('Anthropic 单张图片的 Base64 编码超过 10 MB，请压缩图片后重试')
      }
      if (part.type === 'file' && media.mimeType !== 'application/pdf') throw new Error('Anthropic 文件输入当前仅支持 PDF')
      return { type: part.type === 'image' ? 'image' : 'document', source: { type: 'base64', media_type: media.mimeType, data: media.data } }
    }),
  }
}

function geminiMessage(message: ModelMessage): JsonRecord {
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: inputParts(message.content).map(part => part.type === 'text'
      ? { text: part.text }
      : { inlineData: inlineData(part.type === 'image' ? part.url : part.data) }),
  }
}

function ollamaMessage(message: ModelMessage): JsonRecord {
  const parts = inputParts(message.content)
  const images = parts.flatMap(part => {
    if (part.type === 'file') throw new Error('Ollama 当前仅支持图片 OCR，不支持直接输入 PDF')
    return part.type === 'image' ? [inlineData(part.url).data] : []
  })
  return { role: message.role, content: parts.map(part => part.type === 'text' ? part.text : '').join(''), ...(images.length ? { images } : {}) }
}

/** baseUrl is the API root normalized by the provider store (including /v1 or /v1beta). */
export function buildChatRequest(
  config: Pick<AiProviderConfig, 'type' | 'baseUrl' | 'model'>,
  apiKey: string,
  messages: ModelMessage[],
  stream: boolean,
): ProviderRequest {
  const { type, model } = config
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const headers = {
    'Content-Type': 'application/json',
    Accept: stream ? type === 'ollama' ? 'application/x-ndjson' : 'text/event-stream' : 'application/json',
    ...authHeaders(type, apiKey),
  }
  if (type === 'openai-compatible') return { url: `${baseUrl}/chat/completions`, headers, body: { model, messages, stream } }
  if (type === 'openai-responses') return { url: `${baseUrl}/responses`, headers, body: { model, input: messages.map(responsesMessage), stream, store: false } }
  if (type === 'ollama') return { url: `${baseUrl}/api/chat`, headers, body: { model, messages: messages.map(ollamaMessage), stream } }
  const system = messages.filter(message => message.role === 'system').map(message => textInput(message.content)).filter(Boolean).join('\n\n')
  const conversation = messages.filter(message => message.role !== 'system')
  if (type === 'anthropic') {
    return {
      url: `${baseUrl}/messages`, headers,
      body: { model, max_tokens: 4096, messages: conversation.map(anthropicMessage), ...(system ? { system } : {}), stream },
    }
  }
  if (type === 'gemini') {
    const modelId = encodeURIComponent(model.replace(/^models\//, ''))
    return {
      url: `${baseUrl}/models/${modelId}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, headers,
      body: { contents: conversation.map(geminiMessage), ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) },
    }
  }
  throw new Error('不支持的模型协议')
}

/** Serialize exactly the body that will be sent, so UTF-8 text and Base64 overhead both count. */
export function serializeChatRequestBody(type: AiProviderType, body: JsonRecord): string {
  const serialized = JSON.stringify(body)
  const limit = type === 'anthropic' ? ANTHROPIC_REQUEST_BYTES : type === 'gemini' ? GEMINI_REQUEST_BYTES : undefined
  if (limit && Buffer.byteLength(serialized, 'utf8') > limit) {
    const provider = type === 'anthropic' ? 'Anthropic' : 'Gemini'
    throw new Error(`${provider} 请求（含 Base64 附件和文本）超过 ${limit / 1_000_000} MB，请压缩图片或拆分 PDF 后重试`)
  }
  return serialized
}

function checkError(data: JsonRecord): void {
  if (data.error || data.type === 'error') {
    const error = record(data.error)
    const message = string(data.error) || string(error.message) || string(data.message) || '未知错误'
    // Preserve machine-readable auth/rate-limit hints for the network layer's key rotation.
    const hints = [error.type, error.code, error.status, data.code]
      .filter(value => typeof value === 'string' || typeof value === 'number').map(value => String(value).slice(0, 80)).join(' ')
    throw new Error(`模型接口请求失败${hints ? ` [${hints}]` : ''}：${message.slice(0, 300)}`)
  }
}

function checkStop(reason: unknown, success: string[], required = false): void {
  if (!reason && !required) return
  if (typeof reason === 'string' && success.includes(reason)) return
  if (['length', 'max_tokens', 'max_output_tokens', 'model_context_window_exceeded', 'MAX_TOKENS'].includes(string(reason))) throw new Error('模型输出被截断，请缩短输入或调整模型输出限制')
  if (['refusal', 'content_filter', 'SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT'].includes(string(reason))) {
    throw new Error('模型拒绝了本次请求或内容被过滤')
  }
  throw new Error('模型响应未正常完成，无法将部分输出作为完整结果')
}

function visibleText(content: unknown, types = ['text', 'output_text']): string {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map(value => {
    if (typeof value === 'string') return value
    const part = record(value)
    if (part.type === 'refusal' || part.refusal) throw new Error('模型拒绝了本次请求')
    return part.thought !== true && (!part.type || types.includes(string(part.type))) ? string(part.text) : ''
  }).join('') : ''
}

function compatibleChoice(data: JsonRecord): JsonRecord {
  const choices = records(data.choices)
  return choices.find(choice => choice.index === 0) || choices[0] || {}
}

function responseText(data: JsonRecord): string {
  checkError(data)
  if (data.status !== 'completed') {
    if (data.status === 'incomplete') checkStop(record(data.incomplete_details).reason, [])
    throw new Error('模型响应未正常完成，无法将部分输出作为完整结果')
  }
  return records(data.output).filter(item => item.type === 'message').map(item => visibleText(item.content, ['output_text'])).join('')
}

function geminiCandidate(data: JsonRecord): JsonRecord {
  const feedback = record(data.promptFeedback)
  if (feedback.blockReason && feedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED') throw new Error('模型拒绝了本次请求或内容被过滤')
  const candidates = records(data.candidates)
  return candidates.find(candidate => candidate.index === 0) || candidates[0] || {}
}

export function extractChatText(type: AiProviderType, data: JsonRecord): string {
  checkError(data)
  let text = ''
  if (type === 'openai-compatible') {
    const choice = compatibleChoice(data)
    const message = record(choice.message)
    checkStop(choice.finish_reason, ['stop'])
    if (message.refusal) throw new Error('模型拒绝了本次请求')
    text = visibleText(message.content)
  } else if (type === 'openai-responses') text = responseText(data)
  else if (type === 'anthropic') {
    checkStop(data.stop_reason, ['end_turn', 'stop_sequence'], true)
    text = visibleText(data.content, ['text'])
  } else if (type === 'gemini') {
    const candidate = geminiCandidate(data)
    checkStop(candidate.finishReason, ['STOP'], true)
    text = visibleText(record(candidate.content).parts)
  } else if (type === 'ollama') {
    checkStop(data.done_reason, ['stop'])
    if (data.done === false) throw new Error('模型响应未正常完成，无法将部分输出作为完整结果')
    text = string(record(data.message).content)
  } else throw new Error('不支持的模型协议')
  if (!text.trim()) throw new Error('模型没有返回文本内容')
  return text.trim()
}

function parseStreamJson(value: string): JsonRecord {
  let parsed: unknown
  try { parsed = JSON.parse(value) as unknown } catch { throw new Error('模型接口返回了无法解析的流式数据') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型接口返回了无法解析的流式数据')
  return parsed as JsonRecord
}

class ProviderStreamParser implements ChatStreamParser {
  private dataLines: string[] = []
  private eventType = ''
  private done = false
  private emittedText = false
  private anthropicStopReason: unknown

  constructor(private readonly type: AiProviderType) {}

  pushLine(line: string): ParsedStreamEvent[] {
    if (this.done) return []
    if (this.type === 'ollama') return line.trim() ? this.parseRecord(parseStreamJson(line)) : []
    if (!line) return this.dispatch()
    if (line.startsWith('data:')) this.dataLines.push(line.slice(5).replace(/^ /, ''))
    else if (line.startsWith('event:')) this.eventType = line.slice(6).trim()
    return []
  }

  finish(): ParsedStreamEvent[] {
    const events = this.done ? [] : this.dispatch()
    if (!this.done) throw new Error('模型流式响应意外中断，请重试')
    return events
  }

  private emit(delta = '', done = false): ParsedStreamEvent[] {
    if (delta) this.emittedText = true
    if (done) this.done = true
    return delta || done ? [{ delta, done }] : []
  }

  private dispatch(): ParsedStreamEvent[] {
    const value = this.dataLines.join('\n').trim()
    const eventType = this.eventType
    this.dataLines = []
    this.eventType = ''
    if (!value) return []
    if (value === '[DONE]') {
      if (this.type !== 'openai-compatible') throw new Error('模型流式响应缺少协议完成事件')
      return this.emit('', true)
    }
    const data = parseStreamJson(value)
    if (!data.type && eventType) data.type = eventType
    return this.parseRecord(data)
  }

  private parseRecord(data: JsonRecord): ParsedStreamEvent[] {
    checkError(data)
    if (this.type === 'openai-compatible') {
      const choice = compatibleChoice(data)
      const delta = record(choice.delta)
      checkStop(choice.finish_reason, ['stop'])
      if (delta.refusal) throw new Error('模型拒绝了本次请求')
      // A stop finish_reason is a valid final event even on compatible servers without [DONE].
      return this.emit(visibleText(delta.content), choice.finish_reason === 'stop')
    }
    if (this.type === 'openai-responses') return this.parseResponses(data)
    if (this.type === 'anthropic') return this.parseAnthropic(data)
    if (this.type === 'gemini') {
      const candidate = geminiCandidate(data)
      checkStop(candidate.finishReason, ['STOP', 'FINISH_REASON_UNSPECIFIED'])
      return this.emit(visibleText(record(candidate.content).parts), candidate.finishReason === 'STOP')
    }
    if (this.type === 'ollama') {
      checkStop(data.done_reason, ['stop'])
      return this.emit(string(record(data.message).content), data.done === true)
    }
    throw new Error('不支持的模型协议')
  }

  private parseResponses(data: JsonRecord): ParsedStreamEvent[] {
    const type = string(data.type)
    if (type.startsWith('response.refusal.') || record(data.part).type === 'refusal') throw new Error('模型拒绝了本次请求')
    if (type === 'response.failed' || type === 'response.incomplete' || type === 'response.cancelled') {
      const response = record(data.response)
      checkError(response)
      checkStop(record(response.incomplete_details).reason, [], true)
    }
    if (type === 'response.output_text.delta') return this.emit(string(data.delta))
    if (type === 'response.completed') {
      const text = responseText(record(data.response))
      return this.emit(this.emittedText ? '' : text, true)
    }
    return []
  }

  private parseAnthropic(data: JsonRecord): ParsedStreamEvent[] {
    if (data.type === 'content_block_start') {
      const block = record(data.content_block)
      if (block.type === 'refusal') throw new Error('模型拒绝了本次请求')
      return this.emit(block.type === 'text' ? string(block.text) : '')
    }
    if (data.type === 'content_block_delta') {
      const delta = record(data.delta)
      if (delta.type === 'refusal_delta') throw new Error('模型拒绝了本次请求')
      return this.emit(delta.type === 'text_delta' ? string(delta.text) : '')
    }
    if (data.type === 'message_delta') {
      const delta = record(data.delta)
      if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
        checkStop(delta.stop_reason, ['end_turn', 'stop_sequence'], true)
        this.anthropicStopReason = delta.stop_reason
      }
    }
    if (data.type === 'message_stop') {
      checkStop(this.anthropicStopReason, ['end_turn', 'stop_sequence'], true)
      return this.emit('', true)
    }
    return []
  }
}

export function createChatStreamParser(type: AiProviderType): ChatStreamParser {
  return new ProviderStreamParser(type)
}

export function buildModelsRequest(type: AiProviderType, baseUrl: string, apiKey: string, pageToken?: string): Omit<ProviderRequest, 'body'> {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${type === 'ollama' ? '/api/tags' : '/models'}`)
  if (type === 'anthropic') {
    url.searchParams.set('limit', '1000')
    if (pageToken) url.searchParams.set('after_id', pageToken)
  } else if (type === 'gemini') {
    url.searchParams.set('pageSize', '1000')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
  }
  return { url: url.toString(), headers: { Accept: 'application/json', ...authHeaders(type, apiKey) } }
}

export function extractModelPage(type: AiProviderType, data: JsonRecord): { ids: string[]; nextPageToken?: string } {
  checkError(data)
  const list = type === 'gemini' || type === 'ollama' ? data.models : data.data
  if (!Array.isArray(list)) throw new Error('模型列表接口返回了无效数据')
  const ids = list.filter(value => {
    const item = record(value)
    return type !== 'gemini' || !Array.isArray(item.supportedGenerationMethods) || item.supportedGenerationMethods.includes('generateContent')
  }).map(value => {
    const item = record(value)
    const id = typeof value === 'string' ? value : type === 'gemini' ? string(item.name) : type === 'ollama' ? string(item.name) || string(item.model) : string(item.id)
    return type === 'gemini' ? id.replace(/^models\//, '') : id
  })
    .map(id => id.trim()).filter(Boolean)
  let nextPageToken: string | undefined
  if (type === 'gemini') nextPageToken = string(data.nextPageToken) || undefined
  if (type === 'anthropic' && data.has_more === true) {
    nextPageToken = string(data.last_id) || undefined
    if (!nextPageToken) throw new Error('模型列表接口缺少下一页游标')
  }
  return { ids: [...new Set(ids)], ...(nextPageToken ? { nextPageToken } : {}) }
}
