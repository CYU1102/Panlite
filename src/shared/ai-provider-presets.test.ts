import { describe, expect, it } from 'vitest'
import { AI_PROVIDER_PRESETS, findAiProviderPresetByBaseUrl } from './ai-provider-presets'

function assertHttpUrl(value: string): URL {
  const url = new URL(value)
  expect(['http:', 'https:']).toContain(url.protocol)
  return url
}

describe('AI provider presets', () => {
  it('has unique ids with valid base urls and links', () => {
    const ids = new Set<string>()
    for (const preset of AI_PROVIDER_PRESETS) {
      expect(ids.has(preset.id)).toBe(false)
      ids.add(preset.id)
      expect(preset.name.trim()).toBeTruthy()
      assertHttpUrl(preset.baseUrl)
      assertHttpUrl(preset.homepage)
      if (preset.apiKeyUrl) assertHttpUrl(preset.apiKeyUrl)
    }
    expect(ids.has('ollama')).toBe(true)
  })

  it('uses HTTPS for every remote provider and loopback HTTP for local ones', () => {
    for (const preset of AI_PROVIDER_PRESETS) {
      const url = new URL(preset.baseUrl)
      if (preset.type === 'ollama') {
        expect(['localhost', '127.0.0.1', '::1']).toContain(url.hostname)
      } else {
        expect(url.protocol).toBe('https:')
      }
    }
  })

  it('finds presets by base url regardless of trailing slash and case', () => {
    expect(findAiProviderPresetByBaseUrl('https://api.deepseek.com/v1/', 'openai-compatible')?.id).toBe('deepseek')
    expect(findAiProviderPresetByBaseUrl('HTTPS://API.DEEPSEEK.COM/V1', 'openai-compatible')?.id).toBe('deepseek')
    expect(findAiProviderPresetByBaseUrl('https://api.deepseek.com/v1', 'ollama')).toBeNull()
    expect(findAiProviderPresetByBaseUrl('https://my-relay.example.com/v1', 'openai-compatible')).toBeNull()
  })

  it('keeps protocol choices distinct even when OpenAI protocols share an endpoint', () => {
    expect(findAiProviderPresetByBaseUrl('https://api.openai.com/v1/', 'openai-compatible')?.id).toBe('openai')
    expect(findAiProviderPresetByBaseUrl('https://api.openai.com/v1/', 'openai-responses')?.id).toBe('openai-responses')
    expect(findAiProviderPresetByBaseUrl('https://api.anthropic.com/v1', 'anthropic')?.id).toBe('anthropic')
    expect(findAiProviderPresetByBaseUrl('https://generativelanguage.googleapis.com/v1beta', 'gemini')?.id).toBe('gemini')
  })

  it('lets users select available models without carrying guessed models into a preset', () => {
    for (const preset of AI_PROVIDER_PRESETS) {
      expect(preset.defaultModel).toBe('')
      expect(preset.defaultTranscriptionModel).toBeUndefined()
      expect(preset.defaultEmbeddingModel).toBeUndefined()
    }
  })
})
