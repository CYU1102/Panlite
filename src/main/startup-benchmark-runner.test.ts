import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const { reserveOutputs, runProcess } = require('../../scripts/startup-benchmark-runner.cjs')
const directories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})
async function directory() {
  const result = await fs.mkdtemp(path.join(os.tmpdir(), 'panlite-startup-harness-test-'))
  directories.push(result)
  return result
}
function child() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), unref: vi.fn() })
}

describe('isolated startup harness evidence and lifecycle', () => {
  it.each(['startup-benchmark.json', 'startup-2.json', 'startup-2.png', 'startup-2.log', 'startup-2.trace.json'])('refuses to replace existing %s before launching', async filename => {
    const reports = await directory()
    await fs.writeFile(path.join(reports, filename), 'existing evidence')
    await expect(reserveOutputs(reports, 2)).rejects.toThrow('already exists')
    expect(await fs.readFile(path.join(reports, filename), 'utf8')).toBe('existing evidence')
    expect(await fs.readdir(reports)).toEqual([filename])
  })

  it('allows unrelated reports and refuses a concurrent invocation until release', async () => {
    const reports = await directory()
    await fs.writeFile(path.join(reports, 'lint.log'), 'unrelated')
    const release = await reserveOutputs(reports, 2)
    await expect(reserveOutputs(reports, 2)).rejects.toMatchObject({ code: 'EEXIST' })
    await release(); await release()
    const nextRelease = await reserveOutputs(reports, 2)
    await nextRelease()
    expect(await fs.readdir(reports)).toEqual(['lint.log'])
  })

  it('records exit separately from later stdio close and parent processing', async () => {
    const process = child()
    let time = 100
    const running = runProcess('synthetic', [], { spawnProcess: () => process, clock: () => time })
    time = 130; process.emit('exit', 0)
    time = 160; process.emit('close', 0)
    time = 900 // A subsequent report read must not change either event time.
    expect(await running).toEqual({ startedAt: 100, processWallMs: 30, processCloseMs: 60 })
  })

  it('observes a real isolated Node child through stdio close', async () => {
    const diagnostics: string[] = []
    const result = await runProcess(process.execPath, ['-e', "process.stdout.write('child complete')"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, onDiagnostics: (data: Buffer) => diagnostics.push(String(data)), timeoutMs: 5000,
    })
    expect(diagnostics.join('')).toBe('child complete')
    expect(result.processWallMs).toBeGreaterThan(0)
    expect(result.processCloseMs).toBeGreaterThanOrEqual(result.processWallMs)
  })

  it('fails within the timeout when a live child never exits', async () => {
    vi.useFakeTimers()
    const process = child()
    const running = runProcess('synthetic', [], { spawnProcess: () => process, timeoutMs: 50 })
    const rejected = expect(running).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(process.kill).toHaveBeenCalledOnce()
    expect(process.unref).toHaveBeenCalledOnce()
  })

  it('bounds inherited-stdio waits without signalling a child that already exited', async () => {
    vi.useFakeTimers()
    const process = child()
    const running = runProcess('synthetic', [], { spawnProcess: () => process, timeoutMs: 50 })
    const rejected = expect(running).rejects.toThrow('timed out')
    process.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(process.kill).not.toHaveBeenCalled()
    expect(process.stdout.destroyed).toBe(true)
  })

  it('rejects timeout even when signalling the child throws synchronously', async () => {
    vi.useFakeTimers()
    const process = child(), terminationError = new Error('synthetic kill failure')
    process.kill.mockImplementation(() => { throw terminationError })
    const running = runProcess('synthetic', [], { spawnProcess: () => process, timeoutMs: 50 })
    const rejected = expect(running).rejects.toMatchObject({ message: expect.stringContaining('timed out'), cause: terminationError })
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    expect(process.unref).toHaveBeenCalledOnce()
    expect(process.stdout.destroyed).toBe(true)
    expect(process.stderr.destroyed).toBe(true)
  })

  it('rejects a failed child and preserves collected diagnostics', async () => {
    const process = child(), diagnostics: string[] = []
    const running = runProcess('synthetic', [], { spawnProcess: () => process, onDiagnostics: (data: Buffer) => diagnostics.push(String(data)) })
    process.stderr.write('specific failure')
    process.emit('exit', 2); process.emit('close', 2)
    await expect(running).rejects.toThrow('code 2')
    expect(diagnostics).toEqual(['specific failure'])
  })
})
