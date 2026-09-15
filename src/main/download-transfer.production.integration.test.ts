import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveAdapter } from '../adapters/base'
import type { DriveAccount } from '../shared/types'

// Only Electron's platform boundary and unrelated task modules are substituted.
// Both production download entry points, the WebDAV business methods, SQLite,
// filesystem cache, and HTTP body streams run without replacement.
const fixture = vi.hoisted(() => ({ profile: '', adapter: {} as DriveAdapter }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.profile }, net: { fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init) }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../adapters/registry', () => ({ getAdapter: () => fixture.adapter }))
vi.mock('./crypto', () => ({ decryptCredential: (value: string) => value }))
vi.mock('./archive', () => ({ cleanupTempDir: vi.fn(), createArchive: vi.fn(), extractArchive: vi.fn() }))
vi.mock('./runtime-services', () => ({ notifyTaskTerminal: vi.fn() }))

import { webdavAdapter } from '../adapters/webdav'
import { getDb, getTaskById, initDatabase, insertAccount, insertTask, setSetting, type DbTask } from './db'
import { downloadTransferFile, pauseTask } from './task-runner'
import { ResumableSourceChangedError } from './resumable-download'

const MiB = 1024 ** 2, LARGE_SIZE = 32 * MiB, CHUNK_SIZE = 8 * MiB
let server: http.Server, origin: string, account: DriveAccount, originalFile: string, changedFile: string, source: string, originalHash: string
let root: string, caseDirectory: string, sequence = 0, etag: string, rangeSupported: boolean, headOmitsLength: boolean, truncated: false | 'wrong-length' | 'disconnect'
let requests: Array<{ method: string; range?: string; ifMatch?: string }>
let intercept: ((request: http.IncomingMessage, response: http.ServerResponse, serve: () => void) => boolean) | undefined
const pendingResponses = new Set<http.ServerResponse>()
const oldTarget = Buffer.from('EXISTING USER TARGET — must survive failed attempts')
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function sha256(file: string) { const hash = createHash('sha256'); for await (const bytes of fs.createReadStream(file)) hash.update(bytes); return hash.digest('hex') }
async function writePattern(file: string, salt: number) {
  const block = Buffer.from(Array.from({ length: MiB }, (_, index) => (index + salt) % 251)), handle = await fsp.open(file, 'wx')
  try { for (let index = 0; index < LARGE_SIZE / block.length; index++) await handle.write(block); await handle.sync() } finally { await handle.close() }
}
function createTask(): DbTask {
  const id = `production-download-${++sequence}`, timestamp = Date.now()
  insertTask({ id, account_id: account.id, platform: account.platform, task_type: 'download', title: id, payload: '{}', status: 'running', progress: 0, retry_count: 0,
    execution_token: `attempt-${id}-1`, error_message: null, created_at: timestamp, updated_at: timestamp, finished_at: null })
  return getTaskById(id)!
}
function claimNextAttempt(task: DbTask) {
  getDb().prepare("UPDATE tasks SET status='running',execution_token=?,updated_at=? WHERE id=?").run(`attempt-${task.id}-2`, Date.now(), task.id)
  return getTaskById(task.id)!
}
function options(task: DbTask, details: Partial<Parameters<typeof downloadTransferFile>[0]> = {}): Parameters<typeof downloadTransferFile>[0] {
  return { task, account, adapter: webdavAdapter, fileId: '/source.bin', fileSize: LARGE_SIZE, localPath: path.join(caseDirectory, 'output.bin'), overwrite: true,
    sourceParentId: '0', onProgress: () => {}, ...details }
}
function manifests(task: DbTask): Array<{ file: string; generation: string; parts: Array<{ index: number; size: number; sha256: string }> }> {
  const taskDigest = createHash('sha256').update(task.id).digest('hex'), directory = path.join(fixture.profile, 'task-resume-v1', `task-${taskDigest}`)
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name === 'manifest.json').map(entry => {
    const file = path.join(entry.parentPath, entry.name)
    return { file, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  })
}
function serve(request: http.IncomingMessage, response: http.ServerResponse) {
  if (response.destroyed) return
  const size = fs.statSync(source).size
  if (request.method === 'PROPFIND') {
    response.writeHead(207, { 'Content-Type': 'application/xml' })
    response.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/dav/source.bin</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength><d:getlastmodified>Wed, 09 Sep 2026 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`)
    return
  }
  if (request.method === 'HEAD') { response.writeHead(200, { ...(!headOmitsLength ? { 'Content-Length': size } : {}), ETag: etag }); response.end(); return }
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '')
  if (match && rangeSupported) {
    if (request.headers['if-match'] && request.headers['if-match'] !== etag) { response.writeHead(412); response.end(); return }
    const start = Number(match[1]), end = Number(match[2])
    response.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, ETag: etag })
    void pipeline(fs.createReadStream(source, { start, end }), response).catch(() => {})
    return
  }
  const length = !match && truncated === 'wrong-length' ? 512 * 1024 : size
  response.writeHead(200, { 'Content-Length': length, ETag: etag })
  if (!match && truncated === 'disconnect') { response.write(Buffer.alloc(512 * 1024, 7), () => response.destroy()); return }
  void pipeline(fs.createReadStream(source, { start: 0, end: length - 1 }), response).catch(() => {})
}
beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'panlite-production-download-')); fixture.profile = path.join(root, 'profile'); await fsp.mkdir(fixture.profile)
  originalFile = path.join(root, 'source-original.bin'); changedFile = path.join(root, 'source-changed.bin')
  await writePattern(originalFile, 0); await writePattern(changedFile, 17); originalHash = await sha256(originalFile)
  fixture.adapter = webdavAdapter
  vi.useFakeTimers(); initDatabase(); vi.clearAllTimers(); vi.useRealTimers()
  setSetting('transferParallelChunks', '1'); setSetting('transferSpeedLimitMbps', '0')
  server = http.createServer((request, response) => {
    pendingResponses.add(response); response.once('close', () => pendingResponses.delete(response))
    requests.push({ method: request.method || 'GET', range: request.headers.range, ifMatch: request.headers['if-match'] })
    if (intercept?.(request, response, () => serve(request, response))) return
    serve(request, response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  account = { id: 'production-webdav', platform: 'webdav', nickname: 'loopback only', loginType: 'password', credential: { serverUrl: `${origin}/dav`, username: 'fixture', password: 'fixture' }, status: 'active', createdAt: 1, updatedAt: 1 }
  insertAccount({ id: account.id, platform: account.platform, nickname: account.nickname, login_type: 'password', encrypted_credential: '{}', user_agent: null, status: 'active', bind_machine: 0, created_at: 1, updated_at: 1, last_check_at: null })
}, 20000)
beforeEach(async () => {
  source = originalFile; etag = '"version-a"'; requests = []; rangeSupported = true; headOmitsLength = false; truncated = false; intercept = undefined
  caseDirectory = await fsp.mkdtemp(path.join(root, 'case-'))
})
afterEach(() => { intercept = undefined; for (const response of pendingResponses) response.destroy() })
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); getDb().close()
  const checked = path.resolve(root)
  if (path.dirname(checked) !== path.resolve(os.tmpdir()) || !path.basename(checked).startsWith('panlite-production-download-')) throw new Error('Unsafe isolated test cleanup')
  await fsp.rm(checked, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('production transfer + resumable wrapper + actual WebDAV HTTP + SQLite lifecycle', () => {
  async function pauseAfterFirstPart(task: DbTask) {
    let paused = false
    intercept = (request, _response, next) => {
      if (!paused && request.headers.range?.startsWith(`bytes=${CHUNK_SIZE}-`)) { paused = true; expect(pauseTask(task.id)).toBe(true); next(); return true }
      return false
    }
    await expect(downloadTransferFile(options(task))).rejects.toMatchObject({ name: 'TaskSupersededError' })
    expect(getTaskById(task.id)).toMatchObject({ status: 'paused', execution_token: null })
    const manifest = manifests(task)[0]
    expect(manifest.parts).toHaveLength(1); expect(manifest.parts[0]).toMatchObject({ index: 0, size: CHUNK_SIZE })
    intercept = undefined
    return manifest
  }

  it('pauses a real 32 MiB download via SQLite and reuses the fsynced first part under the next execution token', async () => {
    const task = createTask(), cache = await pauseAfterFirstPart(task), before = requests.length
    const part = path.join(path.dirname(cache.file), `data-${cache.generation}`, '0.part')
    expect(await sha256(part)).toBe(cache.parts[0].sha256)
    const progress: number[] = []
    await downloadTransferFile(options(claimNextAttempt(task), { expectedHash: { algorithm: 'sha256', value: originalHash }, onProgress: value => progress.push(value.loaded) }))
    expect(await sha256(options(task).localPath)).toBe(originalHash)
    expect(requests.slice(before).filter(request => request.range).map(request => request.range)).not.toContain(`bytes=0-${CHUNK_SIZE - 1}`)
    expect(requests.slice(before).filter(request => request.method === 'GET' && !request.range)).toHaveLength(0)
    expect(progress[0]).toBe(CHUNK_SIZE); expect(manifests(task)).toEqual([])
  }, 20000)

  it('rejects changed remote identity after pause and preserves an existing target even when overwrite was authorized', async () => {
    const task = createTask(); await pauseAfterFirstPart(task)
    const output = options(task).localPath; await fsp.writeFile(output, oldTarget)
    source = changedFile; etag = '"version-b"'; const before = requests.length
    await expect(downloadTransferFile(options(claimNextAttempt(task)))).rejects.toBeInstanceOf(ResumableSourceChangedError)
    expect(await fsp.readFile(output)).toEqual(oldTarget)
    expect(requests.slice(before).filter(request => request.method === 'GET')).toHaveLength(0)
    expect(manifests(task)).toEqual([])
  }, 20000)

  it.each(['wrong-length', 'disconnect'] as const)('does not publish a real fallback adapter download that is truncated by %s', async mode => {
    const task = createTask(), output = options(task).localPath; await fsp.writeFile(output, oldTarget)
    rangeSupported = false; truncated = mode
    await expect(downloadTransferFile(options(task))).rejects.toThrow()
    expect(requests.some(request => request.range)).toBe(true)
    expect(requests.some(request => request.method === 'GET' && !request.range)).toBe(true)
    expect(await fsp.readFile(output)).toEqual(oldTarget)
    expect((await fsp.readdir(caseDirectory)).filter(name => name.startsWith('.panlite-'))).toEqual([])
  }, 20000)

  it.each(['HEAD', 'range', 'fallback'] as const)('rejects an old execution token whose real asynchronous %s response arrives after a new claim', async stage => {
    const task = createTask(), output = options(task).localPath; await fsp.writeFile(output, oldTarget)
    if (stage === 'fallback') rangeSupported = false
    const reached = deferred(), released = deferred()
    intercept = (request, _response, next) => {
      const matches = stage === 'HEAD' ? request.method === 'HEAD' : stage === 'range' ? !!request.headers.range : request.method === 'GET' && !request.headers.range
      if (!matches) return false
      intercept = undefined; reached.resolve(); void released.promise.then(next); return true
    }
    const outcome = downloadTransferFile(options(task)).then(() => ({ ok: true, error: undefined }), error => ({ ok: false, error }))
    await reached.promise; const newer = claimNextAttempt(task); released.resolve()
    expect(await outcome).toMatchObject({ ok: false, error: { name: 'TaskSupersededError' } })
    expect(getTaskById(task.id)?.execution_token).toBe(newer.execution_token)
    expect(await fsp.readFile(output)).toEqual(oldTarget)
    expect((await fsp.readdir(caseDirectory)).filter(name => name.startsWith('.panlite-'))).toEqual([])
  }, 20000)

  it.each(['HEAD', 'Range'] as const)('checks the task-known size from %s before publication even without a source directory hint', async evidence => {
    const task = createTask(), output = options(task).localPath; await fsp.writeFile(output, oldTarget)
    headOmitsLength = evidence === 'Range'
    await expect(downloadTransferFile(options(task, { sourceParentId: undefined, fileSize: LARGE_SIZE + MiB }))).rejects.toBeInstanceOf(ResumableSourceChangedError)
    expect(await fsp.readFile(output)).toEqual(oldTarget)
    expect(requests.filter(request => request.range && request.range !== 'bytes=0-0')).toHaveLength(0)
  }, 20000)

  it('treats task size zero as unknown and still publishes a verified ordinary download', async () => {
    const task = createTask(), output = options(task).localPath
    await downloadTransferFile(options(task, { fileSize: 0, expectedHash: { algorithm: 'sha256', value: originalHash } }))
    expect(await sha256(output)).toBe(originalHash)
    expect(requests.filter(request => request.method === 'GET' && !request.range)).toHaveLength(1)
    expect(requests.some(request => request.method === 'HEAD' || request.range)).toBe(false)
  }, 20000)
})
