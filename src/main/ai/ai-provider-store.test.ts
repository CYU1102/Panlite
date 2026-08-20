import { describe, expect, it } from 'vitest'
import { validateAiProviderTransport } from './ai-provider-store'

describe('AI provider transport security', () => {
  it('allows local HTTP providers without exposing remote credentials', () => {
    expect(() => validateAiProviderTransport('http://127.0.0.1:11434', '')).not.toThrow()
    expect(() => validateAiProviderTransport('http://localhost:11434', 'local-key')).not.toThrow()
  })

  it('requires HTTPS when a remote API key is present', () => {
    expect(() => validateAiProviderTransport('http://models.example.com/v1', 'secret')).toThrow('必须使用 HTTPS')
    expect(() => validateAiProviderTransport('https://models.example.com/v1', 'secret')).not.toThrow()
  })
})
