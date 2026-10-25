import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), active: vi.fn(), usage: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: mocks.fetch } }))
vi.mock('./ai-provider-store', async importOriginal => ({
  ...await importOriginal<typeof import('./ai-provider-store')>(),
  getActiveAiProvider: mocks.active, recordAiProviderUsage: mocks.usage,
}))
import { embedAiTexts } from './ai-provider'

let sequence = 0
function response() {
  return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0, 0, 0, 0, 0] }] }), { headers: { 'Content-Type': 'application/json' } })
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.active.mockReturnValue({ config: { id: `embedding-cancel-${++sequence}`, type: 'openai-compatible', model: 'fixture-chat',
    embeddingModel: 'fixture-embed', baseUrl: 'https://fixture.example.test/v1' }, keys: ['fixture-one', 'fixture-two'] })
})

describe('embedding request cancellation', () => {
  it('does not contact a provider for an already cancelled embedding request', async () => {
    const controller = new AbortController()
    controller.abort()
    mocks.fetch.mockResolvedValue(response())
    await expect(embedAiTexts(['Synthetic source'], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.active).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('aborts the provider fetch without rotating keys and removes its external listener', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener'), remove = vi.spyOn(controller.signal, 'removeEventListener')
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      controller.abort()
      init.signal!.throwIfAborted()
      return response()
    })
    await expect(embedAiTexts(['Synthetic source'], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.fetch).toHaveBeenCalledOnce()
    const listener = add.mock.calls.find(call => call[0] === 'abort')![1]
    expect(remove).toHaveBeenCalledWith('abort', listener)
  })
})
