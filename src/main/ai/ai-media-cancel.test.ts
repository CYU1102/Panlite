import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), active: vi.fn(), usage: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: mocks.fetch } }))
vi.mock('./ai-provider-store', async importOriginal => ({
  ...await importOriginal<typeof import('./ai-provider-store')>(),
  getActiveAiProvider: mocks.active, recordAiProviderUsage: mocks.usage,
}))
import { extractTextFromVisualFile, transcribeMediaFile } from './ai-provider'

let directory: string
let sequence = 0
beforeEach(() => {
  vi.resetAllMocks()
  directory = mkdtempSync(join(tmpdir(), 'panlite-media-cancel-'))
  mocks.active.mockReturnValue({ config: { id: `cancel-${++sequence}`, type: 'openai-compatible', model: 'fixture-vision', transcriptionModel: 'fixture-speech', baseUrl: 'https://fixture.example.test/v1' }, keys: ['fixture-one', 'fixture-two'] })
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe.each([
  { name: 'visual extraction', call: extractTextFromVisualFile, mime: 'image/png', file: 'image.png' },
  { name: 'speech transcription', call: transcribeMediaFile, mime: 'audio/wav', file: 'audio.wav' },
])('$name cancellation', operation => {
  it('does not read source files or reach the provider if cancelled before starting', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(operation.call(join(directory, 'does-not-exist'), operation.mime, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.active).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('aborts the in-flight model request without rotating credentials or retaining timers', async () => {
    const file = join(directory, operation.file)
    writeFileSync(file, 'synthetic input; no real model is contacted')
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      controller.abort()
      init.signal!.throwIfAborted()
    })
    await expect(operation.call(file, operation.mime, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.fetch).toHaveBeenCalledOnce()
    const abortListener = add.mock.calls.find(call => call[0] === 'abort')![1]
    expect(remove).toHaveBeenCalledWith('abort', abortListener)
  })
})
