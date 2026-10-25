import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: fetchMock } }))

import { listProviderModels, testAiProviderConfig } from './ai-provider'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe('testAiProviderConfig', () => {
  it('sends a minimal chat request against the draft config and reports latency', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '连接成功' } }] }))
    const result = await testAiProviderConfig({ type: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' })
    expect(result.message).toBe('连接成功')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
  })

  it('routes ollama drafts to the local chat endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: { content: '连接成功' } }))
    const result = await testAiProviderConfig({ type: 'ollama', baseUrl: 'http://127.0.0.1:11434/', model: 'qwen3:8b' })
    expect(result.message).toBe('连接成功')
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('http://127.0.0.1:11434/api/chat')
  })

  it('uses the same protocol default address as saving when the draft URL is empty', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: '连接成功' }], stop_reason: 'end_turn' }))
    const result = await testAiProviderConfig({ type: 'anthropic', baseUrl: '', model: 'fixture-model', apiKey: 'fixture-key' })
    expect(result.message).toBe('连接成功')
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages')
  })

  it('surfaces authentication failures from the provider', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Invalid API key' } }, 401))
    await expect(testAiProviderConfig({ type: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'bad' }))
      .rejects.toThrow('Invalid API key')
  })

  it('rejects insecure remote drafts before any request is made', async () => {
    await expect(testAiProviderConfig({ type: 'openai-compatible', baseUrl: 'http://api.example.com/v1', model: 'test-model', apiKey: 'sk-test' }))
      .rejects.toThrow('必须使用 HTTPS')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires a model name', async () => {
    await expect(testAiProviderConfig({ type: 'openai-compatible', baseUrl: 'https://api.example.com/v1' }))
      .rejects.toThrow('请先填写模型名称')
  })
})

describe('listProviderModels', () => {
  it('reads openai-compatible model ids and dedupes them', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] }))
    const models = await listProviderModels({ type: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test' })
    expect(models).toEqual(['model-a', 'model-b'])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/v1/models')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
  })

  it('reads ollama tags', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [{ name: 'qwen3:8b' }, { name: 'nomic-embed-text' }] }))
    const models = await listProviderModels({ type: 'ollama', baseUrl: 'http://127.0.0.1:11434' })
    expect(models).toEqual(['nomic-embed-text', 'qwen3:8b'])
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('http://127.0.0.1:11434/api/tags')
  })

  it('rejects insecure remote drafts before any request is made', async () => {
    await expect(listProviderModels({ type: 'openai-compatible', baseUrl: 'http://api.example.com/v1', apiKey: 'sk-test' }))
      .rejects.toThrow('必须使用 HTTPS')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
