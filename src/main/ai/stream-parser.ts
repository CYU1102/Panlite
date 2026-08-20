const decoder = new TextDecoder()

export class LimitedLineDecoder {
  private readonly textDecoder = new TextDecoder()
  private pending = ''
  private totalBytes = 0

  constructor(private readonly maxBytes: number) {}

  push(chunk: Uint8Array): string[] {
    this.totalBytes += chunk.byteLength
    if (this.totalBytes > this.maxBytes) throw new Error('模型返回内容超出允许大小')
    this.pending += this.textDecoder.decode(chunk, { stream: true })
    return this.takeCompleteLines()
  }

  finish(): string[] {
    this.pending += this.textDecoder.decode()
    const lines = this.takeCompleteLines()
    if (this.pending) lines.push(this.pending.replace(/\r$/, ''))
    this.pending = ''
    return lines
  }

  private takeCompleteLines(): string[] {
    const parts = this.pending.split('\n')
    this.pending = parts.pop() || ''
    return parts.map(line => line.replace(/\r$/, ''))
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(item => {
    if (typeof item === 'string') return item
    if (!item || typeof item !== 'object') return ''
    const record = item as Record<string, unknown>
    return typeof record.text === 'string' ? record.text : ''
  }).join('')
}

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new Error(`${label}返回了无法解析的流式数据`)
  }
}

export interface ParsedStreamEvent {
  delta: string
  done: boolean
}

export class OpenAiSseParser {
  private dataLines: string[] = []

  pushLine(line: string): ParsedStreamEvent[] {
    if (!line) return this.dispatch()
    if (line.startsWith(':')) return []
    if (line.startsWith('data:')) this.dataLines.push(line.slice(5).replace(/^ /, ''))
    return []
  }

  finish(): ParsedStreamEvent[] {
    return this.dispatch()
  }

  private dispatch(): ParsedStreamEvent[] {
    if (!this.dataLines.length) return []
    const data = this.dataLines.join('\n').trim()
    this.dataLines = []
    if (!data) return []
    if (data === '[DONE]') return [{ delta: '', done: true }]
    const record = parseJsonRecord(data, 'OpenAI 兼容接口')
    const error = record.error
    if (error) {
      const message = typeof error === 'string'
        ? error
        : String((error as Record<string, unknown>).message || '未知错误')
      throw new Error(`模型接口请求失败：${message.slice(0, 300)}`)
    }
    const choices = record.choices as Array<Record<string, unknown>> | undefined
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
    return [{ delta: contentText(delta?.content), done: false }]
  }
}

export function parseOllamaLine(line: string): ParsedStreamEvent | null {
  const value = line.trim()
  if (!value) return null
  const record = parseJsonRecord(value, 'Ollama')
  if (record.error) throw new Error(`Ollama 请求失败：${String(record.error).slice(0, 300)}`)
  const message = record.message as Record<string, unknown> | undefined
  return {
    delta: contentText(message?.content),
    done: record.done === true,
  }
}

// Keep a direct decoder export for small protocol fixtures and diagnostics.
export function decodeUtf8(value: Uint8Array): string {
  return decoder.decode(value)
}
