import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveAccount, FileItem, TaskStatus } from '../shared/types'
import { clearTaskResumeCache, downloadTaskResumable, type TaskResumableDownloadOptions } from './task-resumable-download'
import { ResumableDownloadBusyError, ResumableSourceChangedError } from './resumable-download'

const chunkSize = 32 * 1024
const content = Buffer.from(Array.from({ length: 4 * chunkSize }, (_, index) => index % 251))
const hash = (bytes: Buffer, algorithm = 'sha256'): string => createHash(algorithm).update(bytes).digest('hex')
let directory: string, server: http.Server, url: string, bytes: Buffer, etag: string | undefined
let rangeSupported: boolean, headStatus: number, ranges: string[], methods: string[], headers: http.IncomingHttpHeaders[]
let override: ((request: http.IncomingMessage, response: http.ServerResponse) => boolean) | undefined
let options: TaskResumableDownloadOptions
let status: TaskStatus

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-task-resume-test-'))
  bytes = content; etag = '"original"'; rangeSupported = true; headStatus = 200; ranges = []; methods = []; headers = []; override = undefined; status = 'running'
  server = http.createServer((request, response) => {
    methods.push(request.method ?? 'GET'); headers.push(request.headers)
    if (request.headers.range) ranges.push(request.headers.range)
    if (override?.(request, response)) return
    if (request.method === 'HEAD') {
      response.writeHead(headStatus, { 'Content-Length': bytes.length, ...(etag ? { ETag: etag } : {}) }); response.end(); return
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '')
    if (!rangeSupported || !range) {
      response.writeHead(200, { 'Content-Length': bytes.length, ...(etag ? { ETag: etag } : {}) }); response.end(bytes); return
    }
    const start = Number(range[1]), end = Number(range[2])
    response.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, ...(etag ? { ETag: etag } : {}) })
    response.end(bytes.subarray(start, end + 1))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/private?token=URL_SECRET`
  const account: DriveAccount = { id: 'original-account-secret-id', platform: 'webdav', nickname: 'test', loginType: 'password', credential: { password: 'PASSWORD_SECRET' }, status: 'active', createdAt: 0, updatedAt: 0 }
  options = {
    taskId: 'original-task-secret-id', account, fileId: 'original-file-secret-id', targetPath: path.join(directory, 'output.bin'), cacheRoot: path.join(directory, 'cache'),
    adapter: { getDownloadSource: vi.fn(async () => ({ url, headers: { Authorization: 'Bearer HEADER_SECRET' } })) },
    fetch: (address, init) => { if (!address.startsWith('http://127.0.0.1:')) throw new Error('Loopback only'); return fetch(address, init) },
    chunkSize, connections: 1, retriesPerChunk: 0, getStatus: () => status,
  }
})
afterEach(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  fs.rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks()
})
function filesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(item => item.isDirectory() ? filesUnder(path.join(root, item.name)) : [path.join(root, item.name)])
}
function manifests(): string[] { return filesUnder(options.cacheRoot!).filter(file => path.basename(file) === 'manifest.json') }
async function pauseAfter(parts = 1, settings: Partial<TaskResumableDownloadOptions> = {}): Promise<void> {
  await expect(downloadTaskResumable({ ...options, ...settings, onCheckpoint: checkpoint => { if (checkpoint.completedParts >= parts) status = 'paused' } })).rejects.toThrow()
  const taskDigest = hash(Buffer.from(settings.taskId ?? options.taskId))
  const manifest = manifests().find(file => file.includes(`task-${taskDigest}`))
  expect(manifest).toBeDefined()
  expect(JSON.parse(fs.readFileSync(manifest!, 'utf8')).parts).toHaveLength(parts)
}
function freshFile(raw: Record<string, unknown>): FileItem {
  return { id: options.fileId, accountId: options.account.id, platform: options.account.platform, parentId: 'root', name: 'file.bin', isDir: false, size: bytes.length, createdAt: 0, updatedAt: 0, raw }
}

describe('task download integration with real loopback HTTP and owned disk cache', () => {
  it('prefers authenticated custom getDownloadSource transport for HEAD, Range and verify; publishes complete bytes', async () => {
    const custom = vi.fn(async (address: string, init?: RequestInit) => {
      const requestHeaders = new Headers(init?.headers); requestHeaders.set('X-Custom-Transport', 'yes')
      return fetch(address, { ...init, headers: requestHeaders })
    })
    const ordinary = vi.fn(async () => { throw new Error('must not use default transport') })
    options.fetch = ordinary
    options.adapter = { getDownloadSource: vi.fn(async () => ({ url, headers: { Authorization: 'Bearer HEADER_SECRET' }, fetch: custom })), getDownloadUrl: vi.fn(async () => { throw new Error('must not call direct URL getter') }) }
    const result = await downloadTaskResumable(options)
    expect(result).toMatchObject({ kind: 'downloaded', localPath: options.targetPath, fileSize: content.length, reusedBytes: 0, sha256: hash(content) })
    expect(fs.readFileSync(options.targetPath).equals(content)).toBe(true)
    expect(headers.every(item => item.authorization === 'Bearer HEADER_SECRET' && item['x-custom-transport'] === 'yes')).toBe(true)
    expect(custom).toHaveBeenCalled(); expect(ordinary).not.toHaveBeenCalled(); expect(options.adapter.getDownloadUrl).not.toHaveBeenCalled()
    expect(manifests()).toEqual([])
  })

  it('uses the direct URL getter only when no getDownloadSource capability is present', async () => {
    options.adapter = { getDownloadUrl: vi.fn(async () => url) }
    expect(await downloadTaskResumable(options)).toMatchObject({ kind: 'downloaded' })
    expect(options.adapter.getDownloadUrl).toHaveBeenCalledTimes(2)
  })

  it('does not silently degrade when getDownloadSource fails', async () => {
    options.adapter = { getDownloadSource: vi.fn(async () => { throw new Error('source unavailable') }), getDownloadUrl: vi.fn(async () => url) }
    await expect(downloadTaskResumable(options)).rejects.toThrow('source unavailable')
    expect(options.adapter.getDownloadUrl).not.toHaveBeenCalled(); expect(fs.existsSync(options.targetPath)).toBe(false)
  })

  it('preserves the caller lifecycle exception and never returns fallback when cancellation races a capability probe', async () => {
    class PausedByTask extends Error {}
    options.assertActive = () => { if (status !== 'running') throw new PausedByTask('caller owns lifecycle') }
    const transport = options.fetch!
    options.fetch = async (address, init) => {
      const response = await transport(address, init)
      if (init?.method !== 'HEAD') status = 'cancelled'
      return response
    }
    etag = 'W/"weak"'; rangeSupported = false
    await expect(downloadTaskResumable(options)).rejects.toBeInstanceOf(PausedByTask)
    expect(manifests()).toEqual([])
  })

  it('uses a fresh official content hash and checks it again before atomic publication', async () => {
    options.account.platform = 'pan123'; etag = undefined
    const metadata = vi.fn(async () => freshFile({ etag: hash(bytes, 'md5') }))
    options.getFreshFile = metadata
    const result = await downloadTaskResumable(options)
    expect(result).toMatchObject({ kind: 'downloaded', sha256: hash(content) })
    expect(metadata).toHaveBeenCalledTimes(2)
    expect(methods).not.toContain('HEAD')
  })

  it('does not trust plausible raw hashes from a provider without known official hash semantics', async () => {
    etag = 'W/"weak"'
    options.getFreshFile = async () => freshFile({ etag: hash(bytes, 'md5'), sha256: hash(bytes), hash: hash(bytes) })
    expect(await downloadTaskResumable(options)).toEqual({ kind: 'fallback', reason: 'identity-unavailable' })
    expect(fs.existsSync(options.targetPath)).toBe(false)
  })

  it('supports a server which rejects HEAD but provides a complete Range probe and strong ETag', async () => {
    headStatus = 405
    expect(await downloadTaskResumable(options)).toMatchObject({ kind: 'downloaded' })
    expect(ranges.filter(range => range === 'bytes=0-0')).toHaveLength(2)
  })

  it.each(['identity-unavailable', 'range-unsupported'] as const)('returns explicit fallback only for %s', async reason => {
    if (reason === 'identity-unavailable') etag = 'W/"weak"'
    else rangeSupported = false
    expect(await downloadTaskResumable(options)).toEqual({ kind: 'fallback', reason })
    expect(fs.existsSync(options.targetPath)).toBe(false); expect(manifests()).toEqual([])
  })

  it('retains verified checkpoints during pause, resumes across wrapper invocations and never serializes IDs or secrets', async () => {
    await pauseAfter(2)
    const persisted = filesUnder(options.cacheRoot!).filter(file => file.endsWith('.json')).map(file => fs.readFileSync(file, 'utf8')).join('\n')
    expect(persisted).not.toMatch(/PASSWORD_SECRET|HEADER_SECRET|URL_SECRET|original-task|original-account|original-file|http:\/\//)
    expect(fs.existsSync(options.targetPath)).toBe(false)
    status = 'running'; ranges = []
    expect(await downloadTaskResumable(options)).toMatchObject({ kind: 'downloaded', reusedBytes: 2 * chunkSize, downloadedBytes: 2 * chunkSize })
    expect(ranges).not.toContain(`bytes=0-${chunkSize - 1}`)
  })

  it('clears a paused task cache on later cancellation while preserving other tasks and unknown user files', async () => {
    await pauseAfter()
    const originalManifest = manifests()[0]
    const taskDirectory = path.dirname(path.dirname(path.dirname(originalManifest)))
    const foreign = path.join(taskDirectory, 'keep-user-data.txt'); fs.writeFileSync(foreign, 'keep')
    status = 'running'
    await pauseAfter(1, { taskId: 'second-task' })
    expect(manifests()).toHaveLength(2)
    await clearTaskResumeCache(options.taskId, { cacheRoot: options.cacheRoot })
    expect(manifests()).toHaveLength(1); expect(fs.existsSync(originalManifest)).toBe(false)
    expect(fs.readFileSync(foreign, 'utf8')).toBe('keep')
  })

  it('removes owned parts when cancellation interrupts an active transfer', async () => {
    await expect(downloadTaskResumable({ ...options, onCheckpoint: () => { status = 'cancelled' } })).rejects.toThrow()
    expect(manifests()).toEqual([])
    expect(filesUnder(options.cacheRoot!).some(file => file.endsWith('.part'))).toBe(false)
    expect(fs.existsSync(options.targetPath)).toBe(false)
  })

  it('isolates the same task and file ID across accounts and refuses reuse after source changes', async () => {
    await pauseAfter()
    status = 'running'
    const otherAccount = { ...options.account, id: 'second-account' }
    const result = await downloadTaskResumable({ ...options, account: otherAccount, targetPath: path.join(directory, 'other-account.bin') })
    expect(result).toMatchObject({ kind: 'downloaded', reusedBytes: 0 })
    expect(manifests()).toHaveLength(1)
    etag = '"changed"'
    await expect(downloadTaskResumable(options)).rejects.toBeInstanceOf(ResumableSourceChangedError)
    expect(fs.existsSync(options.targetPath)).toBe(false)
  })

  it('retains durable parts after a recoverable transport failure instead of falling back to a full download', async () => {
    override = (request, response) => {
      if (request.headers.range?.startsWith(`bytes=${chunkSize}-`)) { response.writeHead(500); response.end(); return true }
      return false
    }
    await expect(downloadTaskResumable(options)).rejects.toThrow('HTTP 500')
    expect(manifests()).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(manifests()[0], 'utf8')).parts).toHaveLength(1)
    override = undefined
    expect(await downloadTaskResumable(options)).toMatchObject({ kind: 'downloaded', reusedBytes: chunkSize })
  })

  it('rejects corrupt range metadata and full-file hash mismatches without ordinary fallback', async () => {
    options.account.platform = 'pan123'
    options.getFreshFile = async () => freshFile({ etag: 'a'.repeat(32) })
    await expect(downloadTaskResumable(options)).rejects.toThrow('官方哈希不一致')
    expect(fs.existsSync(options.targetPath)).toBe(false)
    expect(manifests()).toEqual([])
  })

  it('rejects remote metadata identity mismatches before bytes are accepted', async () => {
    options.getFreshFile = async () => ({ ...freshFile({}), accountId: 'wrong-account' })
    await expect(downloadTaskResumable(options)).rejects.toBeInstanceOf(ResumableSourceChangedError)
    expect(ranges).toEqual([])
  })

  it('keeps existing files intact by default and replaces them only under explicit overwrite', async () => {
    fs.writeFileSync(options.targetPath, 'original')
    await expect(downloadTaskResumable(options)).rejects.toThrow('未允许覆盖')
    expect(fs.readFileSync(options.targetPath, 'utf8')).toBe('original'); expect(methods).toEqual([])
    expect(await downloadTaskResumable({ ...options, overwrite: true })).toMatchObject({ kind: 'downloaded' })
    expect(fs.readFileSync(options.targetPath).equals(content)).toBe(true)
  })

  it('checks the saved plan hash before replacing an existing file, even with a valid strong ETag', async () => {
    fs.writeFileSync(options.targetPath, 'original')
    await expect(downloadTaskResumable({ ...options, overwrite: true, expectedHash: { algorithm: 'sha256', value: '0'.repeat(64) } }))
      .rejects.toBeInstanceOf(ResumableSourceChangedError)
    expect(fs.readFileSync(options.targetPath, 'utf8')).toBe('original')
    expect(await downloadTaskResumable({ ...options, overwrite: true, expectedHash: { algorithm: 'sha256', value: hash(content) } }))
      .toMatchObject({ kind: 'downloaded', reusedBytes: content.length })
    expect(fs.readFileSync(options.targetPath).equals(content)).toBe(true)
  })

  it('preserves the original file and verified cache when publication fails after downloading the complete temporary file', async () => {
    fs.writeFileSync(options.targetPath, 'original')
    const originalRename = fsp.rename.bind(fsp)
    vi.spyOn(fsp, 'rename').mockImplementation(async (source, target) => {
      if (String(source).includes('.panlite-task-download-') && String(target) === options.targetPath) throw new Error('simulated atomic publish failure')
      return originalRename(source, target)
    })
    await expect(downloadTaskResumable({ ...options, overwrite: true })).rejects.toThrow('simulated atomic publish failure')
    expect(fs.readFileSync(options.targetPath, 'utf8')).toBe('original')
    expect(JSON.parse(fs.readFileSync(manifests()[0], 'utf8')).parts).toHaveLength(4)
    vi.restoreAllMocks()
    expect(await downloadTaskResumable({ ...options, overwrite: true })).toMatchObject({ kind: 'downloaded', reusedBytes: content.length, downloadedBytes: 0 })
  })

  it('does not overwrite a file created after the initial check and retains complete parts for retry', async () => {
    options.getFreshFile = async context => {
      if (context.reason === 'verify') fs.writeFileSync(options.targetPath, 'racing-writer')
      return freshFile({})
    }
    await expect(downloadTaskResumable(options)).rejects.toThrow('未允许覆盖')
    expect(fs.readFileSync(options.targetPath, 'utf8')).toBe('racing-writer')
    expect(JSON.parse(fs.readFileSync(manifests()[0], 'utf8')).parts).toHaveLength(4)
  })

  it('keeps complete parts if execution ownership is lost immediately before final publication', async () => {
    const originalLink = fsp.link.bind(fsp)
    vi.spyOn(fsp, 'link').mockImplementation(async (source, target) => {
      await originalLink(source, target)
      if (String(target).includes('.panlite-task-download-')) status = 'paused'
    })
    await expect(downloadTaskResumable(options)).rejects.toThrow('任务已暂停')
    expect(fs.existsSync(options.targetPath)).toBe(false)
    expect(JSON.parse(fs.readFileSync(manifests()[0], 'utf8')).parts).toHaveLength(4)
  })

  it('does not treat a busy same-object attempt as a fallback, and a cache clear cannot delete active parts', async () => {
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(done => { release = done }), ready = new Promise<void>(done => { entered = done })
    options.getFreshFile = async () => { entered(); await waiting; return freshFile({}) }
    const first = downloadTaskResumable(options)
    await ready
    await expect(downloadTaskResumable(options)).rejects.toBeInstanceOf(ResumableDownloadBusyError)
    await expect(clearTaskResumeCache(options.taskId, { cacheRoot: options.cacheRoot })).rejects.toBeInstanceOf(ResumableDownloadBusyError)
    release(); expect(await first).toMatchObject({ kind: 'downloaded' })
  })

  it('rejects tampered cache ownership instead of deleting arbitrary files, and missing tasks require no new directories', async () => {
    const missingRoot = path.join(directory, 'not-created')
    await clearTaskResumeCache('never-run', { cacheRoot: missingRoot }); expect(fs.existsSync(missingRoot)).toBe(false)
    await pauseAfter()
    const record = filesUnder(options.cacheRoot!).find(file => /job-[a-f\d]+\.json$/.test(file))!
    const payload = JSON.parse(fs.readFileSync(record, 'utf8')); payload.fileDigest = '../outside'; fs.writeFileSync(record, JSON.stringify(payload))
    await expect(clearTaskResumeCache(options.taskId, { cacheRoot: options.cacheRoot })).rejects.toThrow('归属无效')
    expect(manifests()).toHaveLength(1)
  })

  it('refuses junction/symlink cache roots and leaves the linked directory untouched', async () => {
    const outside = path.join(directory, 'outside'), linked = path.join(directory, 'linked-cache')
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'untouched')
    await fsp.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(downloadTaskResumable({ ...options, cacheRoot: linked })).rejects.toThrow('根目录不安全')
    await expect(clearTaskResumeCache(options.taskId, { cacheRoot: linked })).rejects.toThrow('根目录不安全')
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('untouched')
  })
})
