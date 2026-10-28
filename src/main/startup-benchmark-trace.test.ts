import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { runInNewContext } from 'node:vm'
import type { BrowserWindow } from 'electron'

vi.mock('electron', () => ({ app: {
  getPath: vi.fn(), setPath: vi.fn(), on: vi.fn(), once: vi.fn(),
  getVersion: vi.fn(() => '0.2.3'), quit: vi.fn(), exit: vi.fn(),
} }))
import { app } from 'electron'
import { StartupBenchmarkTrace } from './startup-benchmark-trace'
import { createStartupBenchmark } from './startup-benchmark'

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs() })

function syntheticWindow(captureError?: Error) {
  const writes = new Map<string, string>()
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data) => { writes.set(String(file), String(data)) })
  let loaded: (() => void) | undefined, beforeQuit: (() => void) | undefined
  vi.spyOn(app, 'once').mockImplementation((event: string, listener: () => void) => {
    if (event === 'before-quit') beforeQuit = listener
    return app
  })
  vi.spyOn(app, 'quit').mockImplementation(() => { beforeQuit?.() })
  const capturePage = captureError ? vi.fn().mockRejectedValue(captureError) : vi.fn().mockResolvedValue({ toPNG: () => Buffer.from('synthetic-png') })
  const window = {
    setSize: vi.fn(), isVisible: () => false, isMenuBarVisible: () => false,
    webContents: {
      once: vi.fn((_event, listener) => { loaded = listener }),
      executeJavaScript: vi.fn()
        .mockResolvedValueOnce({ firstScreenMs: 100, textLength: 42, route: '#/' })
        .mockResolvedValueOnce({ theme: 'light', topbarOverflow: false, providerFooterVisible: null, providerHorizontalOverflow: false }),
      capturePage,
    },
  } as unknown as BrowserWindow
  return { window, writes, loaded: () => loaded?.(), capturePage }
}

async function runSyntheticBenchmark(captureError?: Error) {
  vi.useFakeTimers()
  vi.stubEnv('PANLITE_BENCHMARK_USER_DATA', 'synthetic-isolated-profile')
  vi.stubEnv('PANLITE_BENCHMARK_OUTPUT', 'synthetic-startup.json')
  for (const name of ['PANLITE_BENCHMARK_SUITE', 'PANLITE_BENCHMARK_ROUTE', 'PANLITE_BENCHMARK_ACTION', 'PANLITE_BENCHMARK_THEME', 'PANLITE_BENCHMARK_WIDTH']) vi.stubEnv(name, undefined)
  const originalArguments = process.argv
  process.argv = [process.execPath, 'synthetic-app', '--benchmark-startup']
  try {
    const fixture = syntheticWindow(captureError)
    createStartupBenchmark()!.recordWindow(fixture.window)
    fixture.loaded()
    await vi.runAllTimersAsync()
    return fixture
  } finally { process.argv = originalArguments }
}

describe('startup benchmark monotonic trace', () => {
  it('uses one child-clock origin and calculates completed stage durations', () => {
    let clock = 1000
    const trace = new StartupBenchmarkTrace(() => clock)
    clock = 1004; trace.mark('prepare.complete')
    clock = 1010; trace.mark('window.received')
    clock = 1020; trace.mark('capture.start')
    clock = 1037; trace.mark('capture.end')
    const snapshot = trace.snapshot()
    expect(snapshot.originPerformanceMs).toBe(1000)
    expect(snapshot.stages.prepare).toMatchObject({ durationMs: 4, complete: true })
    expect(snapshot.stages.mainInitialization).toMatchObject({ durationMs: 6, complete: true })
    expect(snapshot.stages.capture).toEqual({ startMs: 20, endMs: 37, durationMs: 17, complete: true })
    expect(Object.values(snapshot.validation).every(Boolean)).toBe(true)
  })

  it('preserves an interrupted operation without inventing its end or duration', () => {
    let clock = 0
    const trace = new StartupBenchmarkTrace(() => clock)
    clock = 10; trace.mark('capture.start')
    clock = 15; trace.mark('error')
    const snapshot = trace.snapshot()
    expect(snapshot.stages.capture).toEqual({ startMs: 10, endMs: null, durationMs: null, complete: false })
    expect(Object.values(snapshot.validation).every(Boolean)).toBe(true)
  })

  it('does not mutate a main-report snapshot when post-report events arrive', () => {
    let clock = 100
    const trace = new StartupBenchmarkTrace(() => clock)
    clock = 110; trace.mark('report.write.start')
    const main = trace.snapshot()
    clock = 112; trace.mark('report.write.end')
    clock = 114; trace.mark('quit.request')
    const sidecar = trace.snapshot()
    expect(main.stages.reportWrite.complete).toBe(false)
    expect(main.events.some(event => event.name === 'quit.request')).toBe(false)
    expect(sidecar.stages.reportWrite.durationMs).toBe(2)
    expect(sidecar.stages.postReport.durationMs).toBe(2)
    main.events[0].atMs = -1
    main.stages.reportWrite.startMs = -1
    expect(trace.snapshot().events[0].atMs).toBe(0)
    expect(trace.snapshot().stages.reportWrite.startMs).toBe(10)
  })

  it('rejects backwards and nonfinite clock values without appending corrupt events', () => {
    let clock = 100
    const trace = new StartupBenchmarkTrace(() => clock)
    clock = 110; trace.mark('capture.start')
    clock = 109; expect(() => trace.mark('capture.end')).toThrow(/monotonic/)
    clock = Infinity; expect(() => trace.mark('capture.end')).toThrow(/finite/)
    expect(trace.snapshot().events).toHaveLength(2)
    clock = 110; trace.mark('capture.end')
    expect(trace.snapshot().stages.capture.durationMs).toBe(0)
    expect(() => trace.mark('capture.end')).toThrow(/unique/)
  })

  it('flags a semantic end-before-start event even when timestamps are monotonic', () => {
    let clock = 0
    const trace = new StartupBenchmarkTrace(() => clock)
    clock = 5; trace.mark('capture.end')
    expect(trace.snapshot().validation.stageOrder).toBe(false)
    expect(trace.snapshot().stages.capture.durationMs).toBeNull()
  })

  it('does not configure application data, listeners or timers in normal startup', () => {
    const originalArguments = process.argv
    const interval = vi.spyOn(globalThis, 'setInterval'), timeout = vi.spyOn(globalThis, 'setTimeout')
    process.argv = [process.execPath, 'normal-app']
    try {
      expect(createStartupBenchmark()).toBeNull()
      expect(app.getPath).not.toHaveBeenCalled()
      expect(app.setPath).not.toHaveBeenCalled()
      expect(app.on).not.toHaveBeenCalled()
      expect(app.once).not.toHaveBeenCalled()
      expect(interval).not.toHaveBeenCalled()
      expect(timeout).not.toHaveBeenCalled()
    } finally { process.argv = originalArguments }
  })

  it('preserves a before-write main snapshot and a completed before-quit sidecar without changing capture options', async () => {
    const fixture = await runSyntheticBenchmark()
    const main = JSON.parse(fixture.writes.get('synthetic-startup.json')!)
    const sidecar = JSON.parse(fixture.writes.get('synthetic-startup.trace.json')!)
    expect(main.trace.snapshotPoint).toBe('before-main-report-write')
    expect(main.trace.stages.reportWrite.complete).toBe(false)
    expect(main.trace.events.some((event: { name: string }) => event.name === 'quit.request')).toBe(false)
    expect(sidecar.snapshotPoint).toBe('before-quit')
    expect(sidecar.stages.reportWrite.complete).toBe(true)
    expect(sidecar.events.at(-1).name).toBe('quit.request')
    expect(sidecar.stages.settleDelay.durationMs).toBe(350)
    expect(Object.values(sidecar.validation).every(Boolean)).toBe(true)
    expect(fixture.capturePage).toHaveBeenCalledWith()
    expect(app.quit).toHaveBeenCalledOnce()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('measures each animation-frame wait and style read on the renderer clock', async () => {
    const fixture = await runSyntheticBenchmark()
    const script = vi.mocked(fixture.window.webContents.executeJavaScript).mock.calls[1][0]
    const times = [10, 15, 55, 60]
    let frames = 0
    const visual = await runInNewContext(script, {
      performance: { now: () => times.shift() },
      requestAnimationFrame: (callback: () => void) => { frames++; callback() },
      document: { querySelector: () => null, documentElement: { classList: { contains: () => false } } },
      innerHeight: 720,
    })
    expect(frames).toBe(2)
    expect(visual.rendererVisualTiming).toEqual({ clock: 'renderer performance.now', started: 10, firstFrame: 15, secondFrame: 55, stylesComplete: 60 })
    expect(visual.theme).toBe('light')
  })

  it('retains a failed capture as an incomplete stage and exits unsuccessfully', async () => {
    const fixture = await runSyntheticBenchmark(new Error('synthetic capture failure'))
    const report = JSON.parse(fixture.writes.get('synthetic-startup.json')!)
    expect(report.error).toContain('synthetic capture failure')
    expect(report.trace.snapshotPoint).toBe('error')
    expect(report.trace.stages.capture.complete).toBe(false)
    expect(report.trace.stages.capture.endMs).toBeNull()
    expect(report.trace.stages.capture.durationMs).toBeNull()
    expect(report.trace.events.at(-1).name).toBe('error')
    expect(fixture.writes.has('synthetic-startup.trace.json')).toBe(false)
    expect(app.exit).toHaveBeenCalledWith(1)
    expect(app.quit).not.toHaveBeenCalled()
  })
})
