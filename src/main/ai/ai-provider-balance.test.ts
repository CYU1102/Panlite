import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: fetchMock } }))

// 加密依赖系统 safeStorage，测试环境用透传 stub
vi.mock('../crypto', () => ({
  encryptCredential: (value: string) => `enc:${value}`,
  decryptCredential: (value: string) => value.startsWith('enc:') ? value.slice(4) : value,
}))

import { queryAiProviderBalance } from './ai-provider'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe('queryAiProviderBalance', () => {
  it('reads total from billing subscription and monthly usage', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/dashboard/billing/subscription')) {
        return jsonResponse({ hard_limit_usd: 20, system_hard_limit_usd: 0 })
      }
      if (String(url).includes('/dashboard/billing/usage')) return jsonResponse({ total_usage: 5432 })
      return jsonResponse({}, 404)
    })
    const balance = await queryAiProviderBalance({ type: 'openai-compatible', baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test' })
    expect(balance.total).toBe(20)
    // one-api 系 total_usage 单位为美分
    expect(balance.used).toBe(54.32)
    expect(balance.remaining).toBeCloseTo(20 - 54.32 < 0 ? 0 : 20 - 54.32, 5)
  })

  it('flags unlimited quotas from a huge hard limit', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('subscription')) return jsonResponse({ hard_limit_usd: 9999999 })
      return jsonResponse({ total_usage: 0 })
    })
    const balance = await queryAiProviderBalance({ type: 'openai-compatible', baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test' })
    expect(balance.unlimited).toBe(true)
  })

  it('converts small usage amounts from cents too', async () => {
    fetchMock.mockImplementation(async (url: string) => String(url).includes('subscription')
      ? jsonResponse({ hard_limit_usd: 20 })
      : jsonResponse({ total_usage: 75 }))
    const balance = await queryAiProviderBalance({ type: 'openai-responses', baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-test' })
    expect(balance.used).toBe(0.75)
    expect(balance.remaining).toBe(19.25)
  })

  it('throws a clear error when the provider exposes no billing endpoints', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'not found' } }, 404))
    await expect(queryAiProviderBalance({ type: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test' }))
      .rejects.toThrow('未提供余额查询接口')
  })

  it('requires an api key', async () => {
    await expect(queryAiProviderBalance({ type: 'openai-compatible', baseUrl: 'https://api.example.com/v1' }))
      .rejects.toThrow('请先填写 API Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
