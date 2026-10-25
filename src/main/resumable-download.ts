import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { RateLimiter } from './chunked-download'

export type ResumableSourceIdentity =
  | { kind: 'hash'; algorithm: 'md5' | 'sha1' | 'sha256'; value: string }
  | { kind: 'etag'; value: string }
export type ResumableFetch = (url: string, init?: RequestInit) => Promise<Response>
export interface ResumableDownloadSource {
  /** Ephemeral: neither URLs nor headers are written to the manifest. */
  url: string
  totalSize: number
  identity?: ResumableSourceIdentity
  /** An additional strong HTTP validator when the primary identity is a hash. */
  etag?: string
  headers?: Record<string, string>
  fetch?: ResumableFetch
}
export interface ResumableDownloadOptions {
  /** An application-owned directory, stable across process restarts. */
  resumeRoot: string
  /** Stable account/object/task identity; only its SHA-256 digest is persisted. */
  resumeKey: string
  /** Must not already exist. Publishing never overwrites an existing file. */
  targetPath: string
  /** Re-read authoritative metadata at start, after link expiration, and before publication. */
  getSource: (context: { reason: 'start' | 'refresh' | 'verify'; signal: AbortSignal }) => Promise<ResumableDownloadSource>
  fetch?: ResumableFetch
  signal?: AbortSignal
  getAbortDisposition?: () => 'pause' | 'cancel'
  connections?: number
  chunkSize?: number
  retriesPerChunk?: number
  limiter?: Pick<RateLimiter, 'take'>
  speedLimitBps?: number
  onProgress?: (progress: { loaded: number; total: number; percent: number; speed: number; reusedBytes: number; downloadedBytes: number }) => void
  /** Fires only after both the part and its manifest entry have been fsynced. */
  onCheckpoint?: (checkpoint: { completedParts: number; completedBytes: number }) => void
  /** A caller publishing through a second atomic step keeps parts until its own commit succeeds. */
  retainCacheOnSuccess?: boolean
}
export interface ResumableDownloadResult {
  localPath: string
  fileSize: number
  reusedBytes: number
  downloadedBytes: number
  sha256: string
}
export class ResumableFallbackError extends Error {
  constructor(public readonly reason: 'identity-unavailable' | 'range-unsupported') {
    super(reason === 'identity-unavailable' ? '源缺少可信内容证据，请使用普通完整下载' : '服务端不支持 Range，请使用普通完整下载')
    this.name = 'ResumableFallbackError'
  }
}
export class ResumableSourceChangedError extends Error {
  constructor() { super('源文件内容已经变化，已丢弃旧分块；请重新核对迁移计划'); this.name = 'ResumableSourceChangedError' }
}
export class ResumableDownloadBusyError extends Error {
  constructor() { super('同一文件已有活动续传任务'); this.name = 'ResumableDownloadBusyError' }
}

interface Part { index: number; start: number; end: number; size: number; sha256: string }
interface Manifest {
  format: 1
  keyDigest: string
  generation: string
  totalSize: number
  chunkSize: number
  identity: ResumableSourceIdentity
  state: 'running' | 'paused' | 'failed'
  parts: Part[]
}
interface LockOwner { pid: number; token: string }
const FORMAT = 'panlite-resumable-download-v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_PARTS = 100_000
const active = new Set<string>()
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const collision = (error: unknown): boolean => ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')

function identity(value: unknown): ResumableSourceIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as ResumableSourceIdentity
  if (candidate.kind === 'etag' && typeof candidate.value === 'string'
    && /^"[\x21\x23-\x7e]{1,1024}"$/.test(candidate.value)) return { kind: 'etag', value: candidate.value }
  if (candidate.kind === 'hash' && ['md5', 'sha1', 'sha256'].includes(candidate.algorithm)
    && typeof candidate.value === 'string' && /^[a-f\d]+$/i.test(candidate.value)
    && candidate.value.length === { md5: 32, sha1: 40, sha256: 64 }[candidate.algorithm]) {
    return { kind: 'hash', algorithm: candidate.algorithm, value: candidate.value.toLowerCase() }
  }
  return undefined
}
function sameIdentity(a: ResumableSourceIdentity, b: ResumableSourceIdentity): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
async function regular(file: string): Promise<boolean> {
  try { const stat = await fsp.lstat(file); return stat.isFile() && !stat.isSymbolicLink() } catch (error) { if (missing(error)) return false; throw error }
}
async function syncDirectory(directory: string): Promise<void> {
  // Windows does not allow opening directories with Node's read-only flag.
  if (process.platform === 'win32') return
  const handle = await fsp.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function writeDurable(file: string, value: unknown): Promise<void> {
  const handle = await fsp.open(file, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
}
async function atomicManifest(directory: string, manifest: Manifest): Promise<void> {
  const temporary = path.join(directory, `.manifest-${randomUUID()}.tmp`)
  try {
    await writeDurable(temporary, manifest)
    await fsp.rename(temporary, path.join(directory, 'manifest.json'))
    await syncDirectory(directory)
  } finally { await fsp.unlink(temporary).catch(error => { if (!missing(error)) throw error }) }
}
async function readJson(file: string, maxBytes: number): Promise<unknown> {
  const stat = await fsp.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('续传缓存格式不安全')
  return JSON.parse(await fsp.readFile(file, 'utf8')) as unknown
}
async function prepareDirectory(rootInput: string, keyDigest: string): Promise<string> {
  const root = path.resolve(rootInput)
  await fsp.mkdir(root, { recursive: true })
  if ((await fsp.lstat(root)).isSymbolicLink()) throw new Error('续传缓存目录不能是符号链接')
  const canonicalRoot = await fsp.realpath(root)
  const directory = path.join(canonicalRoot, `download-${keyDigest}`)
  const staging = await fsp.mkdtemp(path.join(canonicalRoot, '.new-download-'))
  try {
    await writeDurable(path.join(staging, 'owner.json'), { format: FORMAT, keyDigest })
    await fsp.rename(staging, directory).catch(error => { if (!collision(error)) throw error })
  } finally {
    // Only exact files created above; never recursively delete caller content.
    await fsp.unlink(path.join(staging, 'owner.json')).catch(error => { if (!missing(error)) throw error })
    await fsp.rmdir(staging).catch(error => { if (!missing(error)) throw error })
  }
  if ((await fsp.lstat(directory)).isSymbolicLink()) throw new Error('续传缓存目录不能是符号链接')
  const marker = await readJson(path.join(directory, 'owner.json'), 1024) as { format?: string; keyDigest?: string }
  if (marker.format !== FORMAT || marker.keyDigest !== keyDigest) throw new Error('拒绝使用不属于该任务的缓存目录')
  return directory
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
async function readOwner(lock: string): Promise<LockOwner> {
  if ((await fsp.lstat(lock)).isSymbolicLink()) throw new Error('续传锁不安全')
  const owner = await readJson(path.join(lock, 'owner.json'), 1024) as LockOwner
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !UUID.test(owner.token)) throw new Error('续传锁格式错误')
  return owner
}
async function acquire(directory: string): Promise<() => Promise<void>> {
  if (active.has(directory)) throw new ResumableDownloadBusyError()
  active.add(directory)
  const owner: LockOwner = { pid: process.pid, token: randomUUID() }
  const staging = path.join(directory, `.lock-${owner.token}`)
  const lock = path.join(directory, 'lock')
  let acquired = false
  try {
    await fsp.mkdir(staging)
    await writeDurable(path.join(staging, 'owner.json'), owner)
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await fsp.rename(staging, lock); acquired = true; break } catch (error) { if (!collision(error)) throw error }
      let previous: LockOwner
      try { previous = await readOwner(lock) } catch (error) { if (missing(error)) continue; throw error }
      if (alive(previous.pid)) throw new ResumableDownloadBusyError()
      // A non-empty tombstone is intentionally retained. Two stale readers
      // cannot both rename the lock (and accidentally steal its successor).
      const retired = path.join(directory, `.retired-${previous.token}`)
      try { await fsp.rename(lock, retired) } catch (error) { if (!collision(error) && !missing(error)) throw error }
    }
    if (!acquired) throw new ResumableDownloadBusyError()
  } catch (error) {
    active.delete(directory)
    await fsp.unlink(path.join(staging, 'owner.json')).catch(() => undefined)
    await fsp.rmdir(staging).catch(() => undefined)
    throw error
  }
  return async () => {
    try {
      const current = await readOwner(lock)
      if (current.token !== owner.token) throw new Error('续传执行权已丢失')
      await fsp.rename(lock, staging)
      await fsp.unlink(path.join(staging, 'owner.json'))
      await fsp.rmdir(staging)
    } finally { active.delete(directory) }
  }
}
function validManifest(value: unknown, keyDigest: string): Manifest {
  const m = value as Manifest
  const evidence = identity(m?.identity)
  if (m?.format !== 1 || m.keyDigest !== keyDigest || !UUID.test(m.generation) || !evidence
    || !Number.isSafeInteger(m.totalSize) || m.totalSize < 0 || !Number.isSafeInteger(m.chunkSize) || m.chunkSize < 1
    || Math.ceil(m.totalSize / m.chunkSize) > MAX_PARTS || !Array.isArray(m.parts) || m.parts.length > MAX_PARTS) throw new Error('续传清单已损坏')
  const indexes = new Set<number>()
  for (const part of m.parts) {
    if (!Number.isSafeInteger(part.index) || part.index < 0 || part.index >= Math.ceil(m.totalSize / m.chunkSize)
      || part.start !== part.index * m.chunkSize || part.end !== Math.min(m.totalSize, part.start + m.chunkSize) - 1
      || part.size !== part.end - part.start + 1 || !/^[a-f\d]{64}$/.test(part.sha256) || indexes.has(part.index)) throw new Error('续传分块清单已损坏')
    indexes.add(part.index)
  }
  return { format: 1, keyDigest, generation: m.generation, totalSize: m.totalSize, chunkSize: m.chunkSize, identity: evidence, state: 'running', parts: m.parts }
}
async function readManifest(directory: string, keyDigest: string): Promise<Manifest | undefined> {
  try { return validManifest(await readJson(path.join(directory, 'manifest.json'), 32 * 1024 * 1024), keyDigest) }
  catch (error) { if (missing(error)) return undefined; throw error }
}
async function generationDirectory(directory: string, manifest: Manifest, create = false): Promise<string> {
  const generation = path.join(directory, `data-${manifest.generation}`)
  if (create) {
    await fsp.mkdir(generation)
    await writeDurable(path.join(generation, 'owner.json'), { format: FORMAT, keyDigest: manifest.keyDigest, generation: manifest.generation })
  }
  if ((await fsp.lstat(generation)).isSymbolicLink()) throw new Error('续传分块目录不安全')
  const marker = await readJson(path.join(generation, 'owner.json'), 1024) as { format?: string; keyDigest?: string; generation?: string }
  if (marker.format !== FORMAT || marker.keyDigest !== manifest.keyDigest || marker.generation !== manifest.generation) throw new Error('续传分块目录归属不匹配')
  return generation
}
async function discard(directory: string, manifest?: Manifest): Promise<void> {
  if (!manifest) return
  const generation = await generationDirectory(directory, manifest).catch(error => { if (missing(error)) return undefined; throw error })
  if (generation) {
    for (const entry of await fsp.readdir(generation, { withFileTypes: true })) {
      if ((entry.isFile() || entry.isSymbolicLink()) && (/^\d+\.part$/.test(entry.name)
        || /^\d+\.[a-f\d-]+\.partial$/.test(entry.name))) await fsp.unlink(path.join(generation, entry.name))
    }
    // Unknown user-created entries prevent directory removal and are preserved.
    if ((await fsp.readdir(generation)).every(name => name === 'owner.json')) {
      await fsp.unlink(path.join(generation, 'owner.json'))
      await fsp.rmdir(generation)
    }
  }
  await fsp.unlink(path.join(directory, 'manifest.json')).catch(error => { if (!missing(error)) throw error })
}
async function fileHash(file: string, algorithm: string, signal: AbortSignal): Promise<string> {
  const hash = createHash(algorithm)
  for await (const bytes of fs.createReadStream(file, { signal })) hash.update(bytes)
  return hash.digest('hex')
}
async function cancelBody(response: Response): Promise<void> { await response.body?.cancel().catch(() => undefined) }

/** Streamed, crash-resumable download. Pause/failure keep verified parts; cancel discards only owned parts. */
export async function resumableDownloadTo(options: ResumableDownloadOptions): Promise<ResumableDownloadResult> {
  if (!options.resumeKey || options.resumeKey.length > 8192) throw new Error('续传任务标识无效')
  const keyDigest = digest(options.resumeKey)
  const directory = await prepareDirectory(options.resumeRoot, keyDigest)
  const release = await acquire(directory)
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const targetPath = path.resolve(options.targetPath)
  let manifest: Manifest | undefined
  let queue: Promise<void> = Promise.resolve()
  let assembly: string | undefined
  let invalidate = false
  let reusedBytes = 0
  let downloadedBytes = 0
  const inFlight = new Map<number, number>()
  try {
    manifest = await readManifest(directory, keyDigest)
    signal.throwIfAborted()
    const targetParent = await fsp.realpath(path.dirname(targetPath))
    if ((await fsp.lstat(path.dirname(targetPath))).isSymbolicLink() || inside(await fsp.realpath(options.resumeRoot), path.join(targetParent, path.basename(targetPath)))) throw new Error('下载目标不能位于续传缓存目录内或符号链接目录中')
    try { await fsp.lstat(targetPath); throw new Error('下载目标已经存在，拒绝覆盖') } catch (error) { if (!missing(error)) throw error }
    let source = await options.getSource({ reason: 'start', signal })
    signal.throwIfAborted()
    const sourceIdentity = identity(source.identity)
    if (!sourceIdentity) { invalidate = true; throw new ResumableFallbackError('identity-unavailable') }
    if (!Number.isSafeInteger(source.totalSize) || source.totalSize < 0) throw new Error('源文件大小无效')
    const matches = (fresh: ResumableDownloadSource): void => {
      const proof = identity(fresh.identity)
      if (fresh.totalSize !== source.totalSize || !proof || !sameIdentity(sourceIdentity, proof)) { invalidate = true; throw new ResumableSourceChangedError() }
    }
    if (manifest && (manifest.totalSize !== source.totalSize || !sameIdentity(manifest.identity, sourceIdentity))) { invalidate = true; throw new ResumableSourceChangedError() }
    const requestedChunk = options.chunkSize ?? 8 * 1024 * 1024
    if (!Number.isSafeInteger(requestedChunk) || requestedChunk < 1 || Math.ceil(source.totalSize / requestedChunk) > MAX_PARTS) throw new Error('续传分块大小无效或分块数量过多')
    const connections = Math.min(8, Math.max(1, Math.floor(options.connections ?? 4)))
    const retries = options.retriesPerChunk ?? 2
    if (!Number.isFinite(connections) || !Number.isInteger(retries) || retries < 0 || retries > 10) throw new Error('续传并发或重试参数无效')
    let generation: string
    if (!manifest) {
      manifest = { format: 1, keyDigest, generation: randomUUID(), totalSize: source.totalSize, chunkSize: requestedChunk, identity: sourceIdentity, state: 'running', parts: [] }
      generation = await generationDirectory(directory, manifest, true)
      await atomicManifest(directory, manifest)
    } else generation = await generationDirectory(directory, manifest)
    const currentManifest = manifest
    // The previous owner is dead/released; unfinished chunks cannot be reused.
    for (const entry of await fsp.readdir(generation, { withFileTypes: true })) {
      if ((entry.isFile() || entry.isSymbolicLink()) && /^\d+\.[a-f\d-]+\.partial$/.test(entry.name)) await fsp.unlink(path.join(generation, entry.name))
    }
    const persist = (mutate: () => void): Promise<void> => {
      queue = queue.then(async () => { mutate(); await atomicManifest(directory, currentManifest) })
      return queue
    }
    // Never trust a cached part just because the old process marked it complete.
    const verified: Part[] = []
    for (const part of manifest.parts) {
      signal.throwIfAborted()
      const file = path.join(generation, `${part.index}.part`)
      if (await regular(file) && (await fsp.stat(file)).size === part.size && await fileHash(file, 'sha256', signal) === part.sha256) {
        verified.push(part); reusedBytes += part.size
      } else await fsp.unlink(file).catch(error => { if (!missing(error)) throw error })
    }
    await persist(() => { currentManifest.parts = verified; currentManifest.state = 'running' })
    let lastTick = Date.now()
    let lastDownloaded = 0
    let speed = 0
    const report = (): void => {
      const now = Date.now()
      if (now - lastTick >= 300) { speed = Math.round((downloadedBytes - lastDownloaded) * 1000 / (now - lastTick)); lastTick = now; lastDownloaded = downloadedBytes }
      const loaded = Math.min(source.totalSize, currentManifest.parts.reduce((sum, part) => sum + part.size, 0) + [...inFlight.values()].reduce((sum, value) => sum + value, 0))
      options.onProgress?.({ loaded, total: source.totalSize, percent: source.totalSize ? Math.round(loaded * 100 / source.totalSize) : 100, speed, reusedBytes, downloadedBytes })
    }
    report()
    const limiter = options.limiter ?? (options.speedLimitBps && options.speedLimitBps > 0
      ? new (await import('./chunked-download')).RateLimiter(options.speedLimitBps) : { take: async (): Promise<void> => undefined })
    let refreshing: Promise<void> | undefined
    const refresh = async (expired: ResumableDownloadSource): Promise<void> => {
      if (source !== expired) return
      refreshing ??= (async () => { const fresh = await options.getSource({ reason: 'refresh', signal }); signal.throwIfAborted(); matches(fresh); source = fresh })().finally(() => { refreshing = undefined })
      await refreshing
    }
    const downloadPart = async (index: number): Promise<void> => {
      const start = index * currentManifest.chunkSize
      const end = Math.min(source.totalSize, start + currentManifest.chunkSize) - 1
      const partial = path.join(generation, `${index}.${randomUUID()}.partial`)
      const completed = path.join(generation, `${index}.part`)
      let committed = false
      try {
        for (let attempt = 0; ; attempt++) {
          signal.throwIfAborted()
          const requestedSource = source
          let response: Response | undefined
          try {
            const headers = new Headers(requestedSource.headers)
            headers.set('Range', `bytes=${start}-${end}`)
            headers.set('Accept-Encoding', 'identity')
            const expectedEtag = sourceIdentity.kind === 'etag' ? sourceIdentity.value : requestedSource.etag
            if (expectedEtag) {
              if (!identity({ kind: 'etag', value: expectedEtag })) throw new Error('源 HTTP 校验标识必须是强 ETag')
              headers.set('If-Match', expectedEtag)
            }
            response = await (requestedSource.fetch ?? options.fetch ?? globalThis.fetch)(requestedSource.url, { headers, signal })
            signal.throwIfAborted()
            if ([401, 403, 410].includes(response.status)) {
              await cancelBody(response)
              if (attempt >= retries) throw new Error(`下载直链刷新后仍不可用：HTTP ${response.status}`)
              await refresh(requestedSource)
              continue
            }
            if (response.status === 412) { invalidate = true; throw new ResumableSourceChangedError() }
            if (response.status === 200 && expectedEtag && response.headers.get('etag') && response.headers.get('etag') !== expectedEtag) { invalidate = true; throw new ResumableSourceChangedError() }
            if (response.status === 416) {
              const changedSize = /^bytes \*\/(\d+)$/.exec(response.headers.get('content-range') || '')
              if (changedSize && Number(changedSize[1]) !== source.totalSize) { invalidate = true; throw new ResumableSourceChangedError() }
            }
            if (response.status === 200 || response.status === 416) { invalidate = true; throw new ResumableFallbackError('range-unsupported') }
            if (response.status !== 206) throw new Error(`下载分块失败：HTTP ${response.status}`)
            if (expectedEtag && response.headers.get('etag') !== expectedEtag) { invalidate = true; throw new ResumableSourceChangedError() }
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') || '')
            if (!range || Number(range[1]) !== start || Number(range[2]) !== end || Number(range[3]) !== source.totalSize) throw new Error('Content-Range 与请求不一致')
            const length = response.headers.get('content-length')
            if (length !== null && (!/^\d+$/.test(length) || Number(length) !== end - start + 1)) throw new Error('下载分块 Content-Length 不一致')
            if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') throw new Error('Range 响应不能使用内容压缩')
            if (!response.body) throw new Error('下载分块无内容')
            const hash = createHash('sha256')
            let size = 0
            const counter = new Transform({ transform(bytes: Buffer, _encoding, callback) {
              void (async () => {
                signal.throwIfAborted()
                downloadedBytes += bytes.length
                size += bytes.length
                if (size > end - start + 1) throw new Error('下载分块数据超过请求范围')
                await limiter.take(bytes.length, signal)
                signal.throwIfAborted()
                hash.update(bytes); inFlight.set(index, size); report()
              })().then(() => callback(null, bytes), error => callback(error as Error))
            } })
            await pipeline(Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream), counter, fs.createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal })
            if (size !== end - start + 1) throw new Error('下载分块数据长度异常')
            signal.throwIfAborted()
            const partHandle = await fsp.open(partial, 'r+')
            try { await partHandle.sync() } finally { await partHandle.close() }
            await fsp.rename(partial, completed)
            await syncDirectory(generation)
            const part: Part = { index, start, end, size, sha256: hash.digest('hex') }
            await persist(() => { inFlight.delete(index); currentManifest.parts.push(part) })
            committed = true
            options.onCheckpoint?.({ completedParts: currentManifest.parts.length, completedBytes: currentManifest.parts.reduce((sum, item) => sum + item.size, 0) })
            report()
            return
          } catch (error) {
            if (response) await cancelBody(response)
            inFlight.delete(index)
            await fsp.unlink(partial).catch(unlinkError => { if (!missing(unlinkError)) throw unlinkError })
            if (signal.aborted || invalidate || committed || attempt >= retries) throw error
          }
        }
      } finally { inFlight.delete(index); await fsp.unlink(partial).catch(error => { if (!missing(error)) throw error }) }
    }
    const finished = new Set(manifest.parts.map(part => part.index))
    const pending = Array.from({ length: Math.ceil(source.totalSize / manifest.chunkSize) }, (_, index) => index).filter(index => !finished.has(index))
    let cursor = 0
    let firstError: unknown
    const workers = Array.from({ length: Math.min(connections, pending.length) }, async () => {
      try { while (cursor < pending.length) { signal.throwIfAborted(); await downloadPart(pending[cursor++]) } }
      catch (error) { firstError ??= error; controller.abort(error); throw error }
    })
    const settled = await Promise.allSettled(workers)
    await queue
    if (settled.some(result => result.status === 'rejected')) throw firstError
    signal.throwIfAborted()
    const confirmed = await options.getSource({ reason: 'verify', signal })
    signal.throwIfAborted()
    matches(confirmed)
    assembly = path.join(targetParent, `.panlite-complete-${randomUUID()}`)
    const fullHash = createHash(sourceIdentity.kind === 'hash' ? sourceIdentity.algorithm : 'sha256')
    const sha256 = createHash('sha256')
    async function* parts(): AsyncGenerator<Buffer> {
      for (const part of [...currentManifest.parts].sort((a, b) => a.index - b.index)) {
        const chunkHash = createHash('sha256')
        let length = 0
        const file = path.join(generation, `${part.index}.part`)
        if (!await regular(file)) throw new Error('待合并分块不是普通文件')
        for await (const bytes of fs.createReadStream(file, { signal })) {
          length += bytes.length; chunkHash.update(bytes); fullHash.update(bytes); sha256.update(bytes); yield bytes as Buffer
        }
        if (length !== part.size || chunkHash.digest('hex') !== part.sha256) { invalidate = true; throw new Error('合并时分块校验失败') }
      }
    }
    await pipeline(Readable.from(parts()), fs.createWriteStream(assembly, { flags: 'wx', mode: 0o600 }), { signal })
    const actualHash = fullHash.digest('hex')
    if (sourceIdentity.kind === 'hash' && actualHash !== sourceIdentity.value) { invalidate = true; throw new Error('完整文件与官方哈希不一致，已丢弃分块') }
    if ((await fsp.stat(assembly)).size !== source.totalSize) { invalidate = true; throw new Error('完整文件长度不一致') }
    const completeHandle = await fsp.open(assembly, 'r+')
    try { await completeHandle.sync() } finally { await completeHandle.close() }
    signal.throwIfAborted()
    // Hard linking within the target filesystem is atomic and cannot overwrite
    // an existing path, including a file created after the initial check.
    await fsp.link(assembly, path.join(targetParent, path.basename(targetPath)))
    await syncDirectory(targetParent)
    await fsp.unlink(assembly); assembly = undefined
    if (!options.retainCacheOnSuccess) { await discard(directory, manifest); manifest = undefined }
    return { localPath: targetPath, fileSize: source.totalSize, reusedBytes, downloadedBytes, sha256: sha256.digest('hex') }
  } catch (error) {
    controller.abort(error)
    await queue.catch(() => undefined)
    if (invalidate || (options.signal?.aborted && options.getAbortDisposition?.() === 'cancel')) await discard(directory, manifest)
    else if (manifest) {
      manifest.state = options.signal?.aborted ? 'paused' : 'failed'
      await atomicManifest(directory, manifest)
    }
    throw error
  } finally {
    if (assembly) await fsp.unlink(assembly).catch(error => { if (!missing(error)) throw error })
    await release()
  }
}

/** For cancelling a paused task. Never steals a live attempt's lock. */
export async function discardResumableDownload(options: { resumeRoot: string; resumeKey: string }): Promise<void> {
  const keyDigest = digest(options.resumeKey)
  const directory = await prepareDirectory(options.resumeRoot, keyDigest)
  const release = await acquire(directory)
  try { await discard(directory, await readManifest(directory, keyDigest)) } finally { await release() }
}
