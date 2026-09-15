import { describe, expect, it } from 'vitest'
import { normalizeBaseUrl, validateAiProviderTransport } from './ai-provider-store'

describe('AI provider transport security', () => {
  it('allows local HTTP providers without exposing remote credentials', () => {
    expect(() => validateAiProviderTransport('http://127.0.0.1:11434', '')).not.toThrow()
    expect(() => validateAiProviderTransport('http://localhost:11434', 'local-key')).not.toThrow()
    expect(() => validateAiProviderTransport('http://[::1]:11434', 'local-key')).not.toThrow()
  })

  it('requires HTTPS when a remote API key is present', () => {
    expect(() => validateAiProviderTransport('http://models.example.com/v1', 'secret')).toThrow('必须使用 HTTPS')
    expect(() => validateAiProviderTransport('https://models.example.com/v1', 'secret')).not.toThrow()
  })
})

describe('AI provider root addresses', () => {
  it.each(['?api-version=2026-01-01', '#models', '?', '#'])('rejects query/fragment suffix %s', (suffix) => {
    expect(() => normalizeBaseUrl(`https://models.example.test/v1${suffix}`)).toThrow('不能包含查询参数或片段')
  })

  it('keeps encoded path characters while normalizing a root URL', () => {
    expect(normalizeBaseUrl(' https://MODELS.example.test:443/v1%3Fworkspace%23name/ '))
      .toBe('https://models.example.test/v1%3Fworkspace%23name')
  })
})
