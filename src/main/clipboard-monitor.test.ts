import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ClipboardSharePayload } from './clipboard-monitor'
const mocks = vi.hoisted(() => ({ readText: vi.fn() }))
vi.mock('electron', () => ({ clipboard: { readText: mocks.readText } }))
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))

let service: ReturnType<typeof import('./clipboard-monitor').initClipboardMonitor>
let detected: Mock<(payload: ClipboardSharePayload) => void>
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  mocks.readText.mockReset().mockResolvedValue('')
  detected = vi.fn()
  service = (await import('./clipboard-monitor')).initClipboardMonitor({ getWindow: () => null, onDetect: detected })
})
afterEach(() => { service.stop(); vi.clearAllTimers(); vi.useRealTimers() })

describe('clipboard monitoring lifecycle', () => {
  it('waits for asynchronous reads, avoids overlap, and drops late results after stop', async () => {
    let resolveRead!: (value: string) => void
    mocks.readText.mockReturnValue(new Promise<string>(resolve => { resolveRead = resolve }))
    service.start()
    await vi.advanceTimersByTimeAsync(3600)
    expect(mocks.readText).toHaveBeenCalledTimes(1)
    service.stop()
    resolveRead('https://pan.quark.cn/s/clipboard-fixture')
    await Promise.resolve()
    expect(detected).not.toHaveBeenCalled()
  })

  it('treats an updated extraction password as a new usable share', async () => {
    mocks.readText.mockResolvedValueOnce('https://pan.baidu.com/s/1ClipboardFixture 提取码: aaaa')
      .mockResolvedValueOnce('https://pan.baidu.com/s/1ClipboardFixture 提取码: bbbb')
      .mockResolvedValueOnce('https://pan.baidu.com/s/1ClipboardFixture 提取码: bbbb')
    service.start()
    await vi.advanceTimersByTimeAsync(3600)
    expect(detected).toHaveBeenCalledTimes(2)
    expect(detected.mock.calls[1][0].links[0].password).toBe('bbbb')
  })

  it('does not let notification delivery failures become unhandled polling failures', async () => {
    mocks.readText.mockResolvedValueOnce('https://pan.quark.cn/s/first-fixture')
      .mockResolvedValueOnce('https://pan.quark.cn/s/second-fixture')
    detected.mockImplementationOnce(() => { throw new Error('window closed') })
    service.start()
    await vi.advanceTimersByTimeAsync(2400)
    expect(detected).toHaveBeenCalledTimes(2)
    expect(service.isRunning()).toBe(true)
  })
})
