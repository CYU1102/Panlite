import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-process-test-'))
const bundle = path.join(root, 'task-process.cjs')
const workers: Worker[] = []
const require = createRequire(path.resolve('package.json'))
let serial = 0

class Worker {
  readonly child: ChildProcess
  private sequence = 0
  private pending = new Map<number, (value: any) => void>()
  private events = new Map<string, () => void>()
  private received = new Set<string>()
  private stderr = ''

  constructor(directory: string) {
    this.child = fork(bundle, [], { env: { ...process.env, PANLITE_TEST_USER_DATA: directory, PANLITE_MOCK_REMOTE: path.join(directory, 'remote.log') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    this.child.stderr?.on('data', chunk => { this.stderr += chunk })
    this.child.on('message', (message: any) => {
      if (message.ready || message.held) {
        const key = message.ready ? 'ready' : message.held
        this.received.add(key)
        this.events.get(key)?.()
      } else {
        this.pending.get(message.requestId)?.(message)
        this.pending.delete(message.requestId)
      }
    })
    this.child.on('exit', () => {
      for (const resolve of this.pending.values()) resolve({ exited: true, stderr: this.stderr })
      this.pending.clear()
      for (const resolve of this.events.values()) resolve()
    })
    workers.push(this)
  }

  async event(name: string): Promise<void> {
    if (this.received.has(name)) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${name}: ${this.stderr}`)), 10_000)
      this.events.set(name, () => { clearTimeout(timer); resolve() })
    })
    if (!this.received.has(name)) throw new Error(`Worker exited before ${name}: ${this.stderr}`)
  }

  request(action: string, id = '', extra: Record<string, unknown> = {}): Promise<any> {
    return new Promise(resolve => {
      const requestId = ++this.sequence
      this.pending.set(requestId, resolve)
      this.child.send({ requestId, action, id, ...extra })
    })
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()))
    this.child.kill('SIGKILL')
    await exited
  }
}

function directory(): string {
  const value = path.join(root, String(++serial))
  fs.mkdirSync(value)
  return value
}

async function start(dir: string): Promise<Worker> {
  const worker = new Worker(dir)
  await worker.event('ready')
  return worker
}

function remoteCalls(dir: string): string[] {
  const file = path.join(dir, 'remote.log')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : []
}

beforeAll(async () => {
  await build({
    entryPoints: [path.resolve('src/main/test-fixtures/task-process.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'test-runtime', setup(builder) {
      builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: require.resolve('better-sqlite3'), external: true }))
      builder.onResolve({ filter: /^(electron|electron-log)$/ }, args => ({ path: args.path, namespace: 'mock' }))
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: args.path === 'electron'
        ? 'export const app = { getPath: () => process.env.PANLITE_TEST_USER_DATA }'
        : 'export default { info() {}, warn() {}, error() {} }' }))
    } }],
  })
})

afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.stop()))
})

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('durable task recovery across real Node processes', () => {
  it('upgrades a pre-operation-journal database without changing existing task payloads or settings', async () => {
    const dir = directory()
    const a = await start(dir)
    await a.request('insert', 'legacy', { status: 'paused' })
    const before = (await a.request('read', 'legacy')).result
    await a.request('legacySchema')
    await a.stop()
    const b = await start(dir)
    expect((await b.request('read', 'legacy')).result).toEqual(before)
    expect((await b.request('setting')).result.value).toBe('preserve-me')
    expect((await b.request('operationCount', 'legacy')).result.count).toBe(0)
    await b.stop()
    const c = await start(dir)
    expect((await c.request('read', 'legacy')).result).toEqual(before)
  })
  it('claims only once and fences a stale process after a pause/resume ABA race', async () => {
    const dir = directory()
    const a = await start(dir)
    const b = await start(dir)
    await a.request('insert', 'race')
    const claims = await Promise.all([a.request('claim', 'race', { token: 'A' }), b.request('claim', 'race', { token: 'B' })])
    expect(claims.map(value => value.result).sort()).toEqual([false, true])
    const firstToken = claims[0].result ? 'A' : 'B'
    expect((await b.request('pause', 'race', { token: firstToken })).result).toBe(true)
    expect((await b.request('resume', 'race')).result).toBe(true)
    expect((await b.request('claim', 'race', { token: 'C' })).result).toBe(true)
    for (const action of ['progress', 'payload', 'complete']) {
      expect((await a.request(action, 'race', { token: firstToken })).result).toBe(false)
    }
    expect((await b.request('payload', 'race', { token: 'C' })).result).toBe(true)
    expect((await b.request('complete', 'race', { token: 'C' })).result).toBe(true)
    expect((await a.request('read', 'race')).result).toMatchObject({ status: 'success', execution_token: 'C', payload: '{"owner":"C"}' })
  })

  it('replays a durable result after abrupt exit without repeating the remote action', async () => {
    const dir = directory()
    const a = await start(dir)
    await a.request('insert', 'done', { status: 'running' })
    await a.request('insert', 'paused', { status: 'paused' })
    await a.request('insert', 'terminal', { status: 'success' })
    expect((await a.request('effect', 'done')).result).toEqual({ fileId: 'remote:done', size: 42 })
    await a.stop()
    const b = await start(dir)
    expect((await b.request('recover')).result).toBe(1)
    expect((await b.request('recover')).result).toBe(0)
    expect((await b.request('read', 'paused')).result.status).toBe('paused')
    expect((await b.request('read', 'terminal')).result.status).toBe('success')
    expect((await b.request('read', 'done')).result).toMatchObject({ status: 'pending', execution_token: null, progress: 37 })
    await b.request('claim', 'done', { token: 'B' })
    expect((await b.request('effect', 'done', { token: 'B' })).result).toEqual({ fileId: 'remote:done', size: 42 })
    expect(remoteCalls(dir)).toEqual(['done'])
    await b.request('delete', 'done')
    expect((await b.request('operationCount', 'done')).result.count).toBe(0)
  })

  it('does not resend after a process dies between remote commit and result checkpoint', async () => {
    const dir = directory()
    const a = await start(dir)
    await a.request('insert', 'lost-response', { status: 'running' })
    const effect = a.request('effect', 'lost-response', { hold: true })
    await a.event('lost-response')
    await a.stop()
    await effect
    const b = await start(dir)
    await b.request('recover')
    await b.request('claim', 'lost-response', { token: 'B' })
    expect(await b.request('effect', 'lost-response', { token: 'B' })).toMatchObject({ code: 'REMOTE_RESULT_UNCERTAIN' })
    expect(remoteCalls(dir)).toEqual(['lost-response'])
  })

  it('allows a new owner to recover preparation but prevents the stale owner dispatching', async () => {
    const dir = directory()
    const a = await start(dir)
    const b = await start(dir)
    await a.request('insert', 'prepared', { status: 'running' })
    const old = a.request('effect', 'prepared', { hold: true, readOnly: true })
    await a.event('prepared')
    await b.request('pause', 'prepared')
    await b.request('resume', 'prepared')
    await b.request('claim', 'prepared', { token: 'B' })
    expect((await b.request('effect', 'prepared', { token: 'B' })).result.fileId).toBe('remote:prepared')
    await a.request('release', 'prepared')
    expect(await old).toMatchObject({ code: 'TASK_SUPERSEDED' })
    expect(remoteCalls(dir)).toEqual(['prepared'])
  })

  it('accepts late operation evidence while rejecting stale task completion', async () => {
    const dir = directory()
    const a = await start(dir)
    const b = await start(dir)
    await a.request('insert', 'late', { status: 'running' })
    const effect = a.request('effect', 'late', { hold: true })
    await a.event('late')
    await b.request('pause', 'late')
    await b.request('resume', 'late')
    await b.request('claim', 'late', { token: 'B' })
    expect(await b.request('effect', 'late', { token: 'B' })).toMatchObject({ code: 'REMOTE_RESULT_UNCERTAIN' })
    await a.request('release', 'late')
    expect((await effect).result.fileId).toBe('remote:late')
    expect((await a.request('complete', 'late')).result).toBe(false)
    expect((await b.request('effect', 'late', { token: 'B' })).result.fileId).toBe('remote:late')
    expect(remoteCalls(dir)).toEqual(['late'])
  })

  it('keeps the retry ceiling atomic between processes', async () => {
    const dir = directory()
    const a = await start(dir)
    const b = await start(dir)
    await a.request('insert', 'retry', { status: 'running' })
    for (let count = 1; count <= 3; count++) {
      const retries = await Promise.all([a.request('retry', 'retry'), b.request('retry', 'retry')])
      expect(retries.map(value => value.result).sort()).toEqual([false, true])
      expect((await b.request('read', 'retry')).result.retry_count).toBe(count)
      await b.request('claim', 'retry')
    }
    expect((await a.request('retry', 'retry')).result).toBe(false)
    expect((await b.request('read', 'retry')).result).toMatchObject({ retry_count: 3, status: 'running' })
  })
})
