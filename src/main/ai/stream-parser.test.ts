import { describe, expect, it } from 'vitest'
import { LimitedLineDecoder, OpenAiSseParser, parseOllamaLine } from './stream-parser'

describe('AI stream protocol parsers', () => {
  it('preserves UTF-8 characters split across network chunks', () => {
    const bytes = new TextEncoder().encode('你好\n世界')
    const decoder = new LimitedLineDecoder(100)
    expect(decoder.push(bytes.slice(0, 2))).toEqual([])
    expect(decoder.push(bytes.slice(2, 7))).toEqual(['你好'])
    expect(decoder.push(bytes.slice(7))).toEqual([])
    expect(decoder.finish()).toEqual(['世界'])
  })

  it('parses OpenAI SSE deltas and DONE marker', () => {
    const parser = new OpenAiSseParser()
    expect(parser.pushLine('data: {"choices":[{"delta":{"content":"你好"}}]}')).toEqual([])
    expect(parser.pushLine('')).toEqual([{ delta: '你好', done: false }])
    parser.pushLine('data: [DONE]')
    expect(parser.finish()).toEqual([{ delta: '', done: true }])
  })

  it('parses Ollama NDJSON messages', () => {
    expect(parseOllamaLine('{"message":{"content":"ok"},"done":false}'))
      .toEqual({ delta: 'ok', done: false })
    expect(parseOllamaLine('{"message":{"content":""},"done":true}'))
      .toEqual({ delta: '', done: true })
  })

  it('limits streamed response size', () => {
    const decoder = new LimitedLineDecoder(3)
    expect(() => decoder.push(new Uint8Array(4))).toThrow('超出允许大小')
  })
})
