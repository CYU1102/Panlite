export interface StartupTraceEvent { name: string; atMs: number }
export interface StartupTraceStage { startMs: number | null; endMs: number | null; durationMs: number | null; complete: boolean }
export interface StartupTraceSnapshot {
  schema: 1
  clock: 'child performance.now relative to trace origin'
  originPerformanceMs: number
  events: StartupTraceEvent[]
  stages: Record<string, StartupTraceStage>
  validation: { monotonic: boolean; nonNegative: boolean; uniqueNames: boolean; stageOrder: boolean }
}

const stageEvents = {
  prepare: ['prepare.start', 'prepare.complete'],
  mainInitialization: ['prepare.complete', 'window.received'],
  windowConfiguration: ['window.received', 'window.configured'],
  load: ['window.configured', 'load.finished'],
  readyQuery: ['ready.query.start', 'ready.query.end'],
  ready: ['prepare.start', 'ready'],
  visual: ['visual.start', 'visual.end'],
  settleDelay: ['delay.start', 'delay.end'],
  capture: ['capture.start', 'capture.end'],
  pngEncode: ['png.encode.start', 'png.encode.end'],
  pngWrite: ['png.write.start', 'png.write.end'],
  reportWrite: ['report.write.start', 'report.write.end'],
  postReport: ['report.write.end', 'quit.request'],
} as const

/** Created only for --benchmark-startup. No timers, I/O or Electron dependency.
 * Each snapshot owns its data: later events cannot mutate an earlier report. */
export class StartupBenchmarkTrace {
  readonly originPerformanceMs: number
  private readonly events: StartupTraceEvent[] = [{ name: 'prepare.start', atMs: 0 }]
  private readonly names = new Set(['prepare.start'])

  constructor(private readonly clock = () => performance.now()) {
    this.originPerformanceMs = clock()
    if (!Number.isFinite(this.originPerformanceMs) || this.originPerformanceMs < 0) throw new RangeError('Invalid startup trace clock origin')
  }

  mark(name: string): void {
    if (!name || name.trim() !== name || this.names.has(name)) throw new Error('Startup trace event must have a unique nonempty name')
    const atMs = this.clock() - this.originPerformanceMs
    if (!Number.isFinite(atMs) || atMs < this.events[this.events.length - 1].atMs) throw new RangeError('Startup trace clock must be finite and monotonic')
    this.events.push({ name, atMs })
    this.names.add(name)
  }

  snapshot(): StartupTraceSnapshot {
    const events = this.events.map(event => ({ ...event }))
    const byName = new Map(events.map(event => [event.name, event.atMs]))
    const stages = Object.fromEntries(Object.entries(stageEvents).map(([name, [from, to]]) => {
      const startMs = byName.get(from) ?? null, endMs = byName.get(to) ?? null
      const complete = startMs !== null && endMs !== null && endMs >= startMs
      return [name, { startMs, endMs, durationMs: complete ? endMs! - startMs! : null, complete }]
    }))
    return {
      schema: 1, clock: 'child performance.now relative to trace origin', originPerformanceMs: this.originPerformanceMs, events, stages,
      validation: {
        monotonic: events.every((event, index) => !index || event.atMs >= events[index - 1].atMs),
        nonNegative: events.every(event => Number.isFinite(event.atMs) && event.atMs >= 0),
        uniqueNames: new Set(events.map(event => event.name)).size === events.length,
        stageOrder: Object.values(stages).every(stage => stage.endMs === null || (stage.startMs !== null && stage.endMs >= stage.startMs)),
      },
    }
  }
}
