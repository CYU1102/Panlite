import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { discardResumableDownload, resumableDownloadTo, ResumableDownloadBusyError, ResumableFallbackError, ResumableSourceChangedError, type ResumableDownloadOptions, type ResumableSourceIdentity } from './resumable-download'

vi.mock('electron', () => ({ net: { fetch: globalThis.fetch } }))
const chunkSize = 64 * 1024
const input = Buffer.from(Array.from({ length: 8 * chunkSize }, (_, index) => (index * 31 + Math.floor(index / chunkSize)) % 251))
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
let directory: string
let server: http.Server
let url: string
let sourceBytes: Buffer
let etag: string
let requests: string[]
let override: ((request: http.IncomingMessage, response: http.ServerResponse) => boolean) | undefined
let options: ResumableDownloadOptions
let compiledDirectory: string
let compiled: string
const children: ChildProcess[] = []

beforeAll(async () => {
  compiledDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-resume-module-'))
  compiled = path.join(compiledDirectory, 'resumable.mjs')
  await build({ entryPoints: [path.resolve('src/main/resumable-download.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'loopback-electron', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const net = { fetch: globalThis.fetch }' }))
    } }],
  })
})
afterAll(() => fs.rmSync(compiledDirectory, { recursive: true, force: true }))
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-resume-test-'))
  sourceBytes = input
  etag = '"original"'
  requests = []
  override = undefined
  server = http.createServer((request, response) => {
    if (request.headers.range) requests.push(request.headers.range)
    if (override?.(request, response)) return
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '')
    if (!range) { response.writeHead(400); response.end(); return }
    const start = Number(range[1]); const end = Number(range[2])
    response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${sourceBytes.length}`, 'Content-Length': end - start + 1, ETag: etag })
    response.end(sourceBytes.subarray(start, end + 1))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/file?signature=not-for-disk`
  options = { resumeRoot: path.join(directory, 'cache'), resumeKey: 'task/account/object', targetPath: path.join(directory, 'output.bin'), chunkSize, connections: 1, retriesPerChunk: 0,
    fetch: (address, init) => { if (!address.startsWith('http://127.0.0.1:')) throw new Error('Loopback only'); return fetch(address, init) },
    getSource: async () => ({ url, totalSize: sourceBytes.length, identity: { kind: 'etag', value: etag }, headers: { Authorization: 'Bearer never-persist-this' } }),
  }
})
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  fs.rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const keyDirectory = (): string => path.join(options.resumeRoot, `download-${createHash('sha256').update(options.resumeKey).digest('hex')}`)
const manifestPath = (): string => path.join(keyDirectory(), 'manifest.json')
async function pauseAfter(parts: number): Promise<void> {
  const controller = new AbortController()
  await expect(resumableDownloadTo({ ...options, signal: controller.signal,
    onCheckpoint: checkpoint => { if (checkpoint.completedParts >= parts) controller.abort(new Error('pause')) },
  })).rejects.toThrow()
  expect(JSON.parse(fs.readFileSync(manifestPath(), 'utf8')).state).toBe('paused')
}
function startChild(identity: ResumableSourceIdentity = { kind: 'etag', value: etag }): ChildProcess {
  const child = fork(path.resolve('scripts/fixtures/resumable-download-child.mjs'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.push(child)
  child.send({ modulePath: compiled, resumeRoot: options.resumeRoot, resumeKey: options.resumeKey, targetPath: options.targetPath, url, totalSize: input.length, chunkSize, identity })
  return child
}
function childMessage(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child ${type} timeout`)), 15_000)
    const listener = (message: Record<string, unknown>): void => {
      if (message.type === 'error' || message.type === type) {
        clearTimeout(timer); child.off('message', listener)
        if (message.type === 'error') reject(new Error(String(message.message))); else resolve(message)
      }
    }
    child.on('message', listener)
    child.once('error', reject)
  })
}

describe('persistent downloads with real loopback HTTP and disk', () => {
  it('streams parallel verified ranges and checks the official full-file SHA-256', async () => {
    const result = await resumableDownloadTo({ ...options, connections: 3,
      getSource: async () => ({ url, totalSize: input.length, identity: { kind: 'hash', algorithm: 'sha256', value: sha256(input) } }),
    })
    expect(result).toMatchObject({ fileSize: input.length, reusedBytes: 0, downloadedBytes: input.length, sha256: sha256(input) })
    expect(sha256(fs.readFileSync(options.targetPath))).toBe(sha256(input))
    expect(fs.existsSync(manifestPath())).toBe(false)
  })
  it('reuses only durable verified blocks after pause, and never persists credentials or direct URLs', async () => {
    await pauseAfter(3)
    const saved = fs.readFileSync(manifestPath(), 'utf8')
    expect(saved).not.toMatch(/http|signature|not-for-disk|Authorization|never-persist-this|task\/account/)
    const completed = JSON.parse(saved).parts as Array<{ start: number; end: number }>
    requests = []
    const result = await resumableDownloadTo(options)
    expect(result.reusedBytes).toBe(3 * chunkSize)
    expect(result.downloadedBytes).toBe(input.length - result.reusedBytes)
    for (const part of completed) expect(requests).not.toContain(`bytes=${part.start}-${part.end}`)
    expect(result.sha256).toBe(sha256(input))
  })
  it('detects a damaged saved block and redownloads only that block and unfinished blocks', async () => {
    await pauseAfter(3)
    const manifest = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'))
    fs.writeFileSync(path.join(keyDirectory(), `data-${manifest.generation}`, '1.part'), Buffer.alloc(chunkSize, 9))
    requests = []
    const result = await resumableDownloadTo(options)
    expect(result.reusedBytes).toBe(2 * chunkSize)
    expect(requests).toContain(`bytes=${chunkSize}-${2 * chunkSize - 1}`)
    expect(requests).not.toContain(`bytes=0-${chunkSize - 1}`)
    expect(result.sha256).toBe(sha256(input))
  })
  it('refuses changed source identity on resume and removes old blocks before a fresh retry', async () => {
    await pauseAfter(2)
    etag = '"changed"'
    sourceBytes = Buffer.alloc(input.length, 123)
    requests = []
    await expect(resumableDownloadTo(options)).rejects.toBeInstanceOf(ResumableSourceChangedError)
    expect(requests).toHaveLength(0)
    expect(fs.existsSync(manifestPath())).toBe(false)
    expect((await resumableDownloadTo(options)).reusedBytes).toBe(0)
    expect(fs.readFileSync(options.targetPath).equals(sourceBytes)).toBe(true)
  })
  it('rejects an ETag change on an individual response before committing that part', async () => {
    override = (request, response) => {
      if (request.headers.range === `bytes=${chunkSize}-${2 * chunkSize - 1}`) {
        response.writeHead(206, { 'Content-Range': `bytes ${chunkSize}-${2 * chunkSize - 1}/${input.length}`, ETag: '"changed"' }); response.end(input.subarray(chunkSize, 2 * chunkSize)); return true
      }
      return false
    }
    await expect(resumableDownloadTo(options)).rejects.toBeInstanceOf(ResumableSourceChangedError)
    expect(fs.existsSync(options.targetPath)).toBe(false)
    expect(fs.existsSync(manifestPath())).toBe(false)
  })
  it('refreshes expired URLs once, rechecks identity, and accepts a source-specific fetch', async () => {
    const reasons: string[] = []
    let sourceFetches = 0
    override = (request, response) => { if (request.url?.includes('expired')) { response.writeHead(403); response.end(); return true }; return false }
    const result = await resumableDownloadTo({ ...options, retriesPerChunk: 2,
      fetch: async () => { throw new Error('Source-specific fetch was ignored') },
      getSource: async ({ reason }) => {
        reasons.push(reason)
        return { url: reason === 'start' ? `${url}&expired=1` : url, totalSize: input.length, identity: { kind: 'etag', value: etag }, fetch: (address, init) => { sourceFetches++; return fetch(address, init) } }
      },
    })
    expect(reasons).toEqual(['start', 'refresh', 'verify'])
    expect(sourceFetches).toBe(9)
    expect(result.sha256).toBe(sha256(input))
  })
  it('refuses a source change during final re-confirmation', async () => {
    await expect(resumableDownloadTo({ ...options, getSource: async ({ reason }) => ({ url, totalSize: input.length, identity: { kind: 'etag', value: reason === 'verify' ? '"new"' : etag } }) }))
      .rejects.toBeInstanceOf(ResumableSourceChangedError)
    expect(fs.existsSync(options.targetPath)).toBe(false)
    expect(fs.existsSync(manifestPath())).toBe(false)
  })
  it('does not confuse a changed representation with a Range fallback', async () => {
    override = (_request, response) => { response.writeHead(200, { ETag: '"new"' }); response.end(input); return true }
    await expect(resumableDownloadTo(options)).rejects.toBeInstanceOf(ResumableSourceChangedError)
    expect(fs.existsSync(manifestPath())).toBe(false)
  })
  it('rejects a different identity returned by an expired-link refresh', async () => {
    override = (request, response) => { if (request.headers.range?.startsWith(`bytes=${chunkSize}-`)) { response.writeHead(403); response.end(); return true }; return false }
    await expect(resumableDownloadTo({ ...options, retriesPerChunk: 1, getSource: async ({ reason }) => ({ url, totalSize: input.length, identity: { kind: 'etag', value: reason === 'refresh' ? '"changed"' : etag } }) })).rejects.toBeInstanceOf(ResumableSourceChangedError)
    expect(fs.existsSync(manifestPath())).toBe(false)
  })
  it('provides an explicit whole-download fallback when Range is unsupported', async () => {
    override = (_request, response) => { response.writeHead(200, { ETag: etag }); response.end(input); return true }
    await expect(resumableDownloadTo(options)).rejects.toMatchObject({ name: 'ResumableFallbackError', reason: 'range-unsupported' })
    expect(fs.existsSync(options.targetPath)).toBe(false)
    expect(fs.existsSync(manifestPath())).toBe(false)
  })
  it('never uses a weak ETag or metadata similarity to authorize block reuse', async () => {
    await expect(resumableDownloadTo({ ...options, getSource: async () => ({ url, totalSize: input.length, identity: { kind: 'etag', value: 'W/"weak"' } }) })).rejects.toBeInstanceOf(ResumableFallbackError)
    expect(requests).toHaveLength(0)
  })
  it('validates Content-Range and truncated bodies and keeps previously completed parts after failure', async () => {
    override = (request, response) => {
      if (request.headers.range?.startsWith(`bytes=${chunkSize}-`)) {
        response.writeHead(206, { ETag: etag, 'Content-Range': `bytes ${chunkSize}-${2 * chunkSize - 1}/${input.length}` }); response.end('short'); return true
      }
      return false
    }
    await expect(resumableDownloadTo(options)).rejects.toThrow('数据长度异常')
    expect(JSON.parse(fs.readFileSync(manifestPath(), 'utf8')).parts).toHaveLength(1)
    override = (_request, response) => { response.writeHead(206, { ETag: etag, 'Content-Range': 'bytes 2-4/5' }); response.end('bad'); return true }
    await expect(resumableDownloadTo(options)).rejects.toThrow('Content-Range')
    expect(JSON.parse(fs.readFileSync(manifestPath(), 'utf8')).parts).toHaveLength(1)
    override = undefined
    expect((await resumableDownloadTo(options)).reusedBytes).toBe(chunkSize)
  })
  it('retries a connection lost mid-response without recording an incomplete block', async () => {
    let fail = true
    override = (_request, response) => {
      if (!fail) return false
      fail = false
      response.writeHead(206, { ETag: etag, 'Content-Range': `bytes 0-${chunkSize - 1}/${input.length}` })
      response.write(input.subarray(0, 1024))
      setImmediate(() => response.destroy())
      return true
    }
    const result = await resumableDownloadTo({ ...options, retriesPerChunk: 1 })
    expect(requests.filter(range => range === `bytes=0-${chunkSize - 1}`)).toHaveLength(2)
    expect(result.sha256).toBe(sha256(input))
  })
  it('propagates cancellation through the shared limiter and cleans only owned cache files', async () => {
    await pauseAfter(2)
    const manifest = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'))
    const userFile = path.join(keyDirectory(), `data-${manifest.generation}`, 'user-notes.txt')
    fs.writeFileSync(userFile, 'keep')
    const controller = new AbortController()
    const take = vi.fn(async (_bytes: number, signal?: AbortSignal) => { controller.abort(); signal?.throwIfAborted() })
    await expect(resumableDownloadTo({ ...options, signal: controller.signal, getAbortDisposition: () => 'cancel', limiter: { take } })).rejects.toThrow()
    expect(take).toHaveBeenCalled()
    expect(fs.existsSync(manifestPath())).toBe(false)
    expect(fs.readFileSync(userFile, 'utf8')).toBe('keep')
    expect(fs.existsSync(options.targetPath)).toBe(false)
  })
  it('can explicitly discard a paused download while preserving an existing target', async () => {
    await pauseAfter(2)
    fs.writeFileSync(options.targetPath, 'user content')
    await expect(resumableDownloadTo(options)).rejects.toThrow('已经存在')
    await discardResumableDownload(options)
    expect(fs.existsSync(manifestPath())).toBe(false)
    expect(fs.readFileSync(options.targetPath, 'utf8')).toBe('user content')
  })
  it('preserves a file created at the target immediately before publication', async () => {
    await expect(resumableDownloadTo({ ...options, getSource: async ({ reason }) => {
      if (reason === 'verify') fs.writeFileSync(options.targetPath, 'won the race')
      return { url, totalSize: input.length, identity: { kind: 'etag', value: etag } }
    } })).rejects.toThrow()
    expect(fs.readFileSync(options.targetPath, 'utf8')).toBe('won the race')
    expect(fs.readdirSync(directory).some(name => name.startsWith('.panlite-complete-'))).toBe(false)
  })
  it('refuses an unowned cache directory without removing its files', async () => {
    fs.mkdirSync(keyDirectory(), { recursive: true })
    const userFile = path.join(keyDirectory(), 'notes.txt')
    fs.writeFileSync(userFile, 'keep')
    await expect(resumableDownloadTo(options)).rejects.toThrow()
    expect(fs.readFileSync(userFile, 'utf8')).toBe('keep')
    expect(requests).toHaveLength(0)
  })
  it('does not follow a tampered manifest generation out of the owned cache', async () => {
    await pauseAfter(1)
    const saved = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'))
    saved.generation = '../../outside'
    fs.writeFileSync(manifestPath(), JSON.stringify(saved))
    const userFile = path.join(directory, 'outside.txt')
    fs.writeFileSync(userFile, 'keep')
    await expect(discardResumableDownload(options)).rejects.toThrow('损坏')
    expect(fs.readFileSync(userFile, 'utf8')).toBe('keep')
  })
  it('refuses overlapping same-process attempts and waits for abort cleanup before reuse', async () => {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    override = (_request, response) => { response.writeHead(206, { ETag: etag, 'Content-Range': `bytes 0-${chunkSize - 1}/${input.length}` }); response.write(input.subarray(0, 1024)); started(); return true }
    const controller = new AbortController()
    const first = resumableDownloadTo({ ...options, signal: controller.signal }).catch(error => error)
    await ready
    await expect(resumableDownloadTo(options)).rejects.toBeInstanceOf(ResumableDownloadBusyError)
    controller.abort(); await first
    override = undefined
    expect((await resumableDownloadTo(options)).sha256).toBe(sha256(input))
  })
  it('rejects an incorrect official hash and never publishes mixed or unverified content', async () => {
    await expect(resumableDownloadTo({ ...options, getSource: async () => ({ url, totalSize: input.length, identity: { kind: 'hash', algorithm: 'sha256', value: '0'.repeat(64) } }) })).rejects.toThrow('官方哈希')
    expect(fs.existsSync(options.targetPath)).toBe(false)
    expect(fs.existsSync(manifestPath())).toBe(false)
  })
  it('recovers a forcibly killed child process without requesting its completed blocks again', async () => {
    // Delay each response so the parent can kill immediately after a durable checkpoint.
    override = (request, response) => {
      const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range!)!
      setTimeout(() => {
        if (response.destroyed) return
        response.writeHead(206, { ETag: etag, 'Content-Range': `bytes ${from}-${to}/${input.length}`, 'Content-Length': Number(to) - Number(from) + 1 })
        response.end(input.subarray(Number(from), Number(to) + 1))
      }, 20)
      return true
    }
    const child = startChild()
    await childMessage(child, 'checkpoint')
    const exit = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGKILL'); await exit
    const saved = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'))
    expect(saved.parts.length).toBeGreaterThan(0)
    requests = []
    const restarted = startChild()
    const message = await childMessage(restarted, 'result')
    const result = message.result as { reusedBytes: number; sha256: string }
    expect(result.reusedBytes).toBe(saved.parts.length * chunkSize)
    for (const part of saved.parts) expect(requests).not.toContain(`bytes=${part.start}-${part.end}`)
    expect(result.sha256).toBe(sha256(input))
    expect(sha256(fs.readFileSync(options.targetPath))).toBe(sha256(input))
  }, 30_000)
  it('does not steal a live child lock, even when lock timestamps are old', async () => {
    override = (_request, response) => { response.writeHead(206, { ETag: etag, 'Content-Range': `bytes 0-${chunkSize - 1}/${input.length}` }); response.write(input.subarray(0, 1024)); return true }
    const child = startChild()
    while (!fs.existsSync(path.join(keyDirectory(), 'lock', 'owner.json'))) await new Promise(resolve => setTimeout(resolve, 10))
    fs.utimesSync(path.join(keyDirectory(), 'lock'), new Date(0), new Date(0))
    await expect(resumableDownloadTo(options)).rejects.toBeInstanceOf(ResumableDownloadBusyError)
    const exit = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGKILL'); await exit
  }, 30_000)
})
