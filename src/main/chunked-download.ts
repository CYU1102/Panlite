import { net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const CHUNK_THRESHOLD_BYTES = 32 * 1024 * 1024
export const MIN_CHUNK_SIZE = 8 * 1024 * 1024
export const MAX_CONNECTIONS = 8

/** 把文件切成 ranges；小于阈值或大小未知时返回单段 */
export function splitRanges(totalSize: number, connections: number): Array<{ start: number; end: number }> {
  if (!Number.isFinite(totalSize) || totalSize <= 0) return [{ start: 0, end: 0 }]
  const requested = Number.isFinite(connections) ? Math.floor(connections) : 1
  const count = Math.max(1, Math.min(MAX_CONNECTIONS, requested, Math.floor(totalSize / MIN_CHUNK_SIZE) || 1))
  const base = Math.floor(totalSize / count)
  const extra = totalSize % count
  const ranges: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (let index = 0; index < count; index++) {
    const length = base + (index < extra ? 1 : 0)
    ranges.push({ start: cursor, end: cursor + length - 1 })
    cursor += length
  }
  return ranges
}

/** 令牌桶限速器：take(n) 会等到配额允许为止；limit<=0 表示不限速 */
export class RateLimiter {
  private readonly capacity: number
  private tokens: number
  private lastRefill: number

  constructor(bytesPerSecond: number) {
    this.capacity = bytesPerSecond > 0 ? Math.max(bytesPerSecond, 1024) : 0
    this.tokens = this.capacity
    this.lastRefill = Date.now()
  }

  get limited(): boolean {
    return this.capacity > 0
  }

  async take(bytes: number, signal?: AbortSignal): Promise<void> {
    if (this.capacity <= 0) return
    let remaining = bytes
    while (remaining > 0) {
      if (signal?.aborted) throw new Error('aborted')
      const now = Date.now()
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.lastRefill) / 1000) * this.capacity)
      this.lastRefill = now
      // 单块大于桶容量时按速率增量放行
      const grant = Math.min(this.tokens, remaining)
      if (grant > 0) {
        this.tokens -= grant
        remaining -= grant
        continue
      }
      const waitMs = Math.min(500, Math.max(20, Math.ceil((remaining / this.capacity) * 1000)))
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }
}

export interface ChunkedDownloadOptions {
  url: string
  targetPath: string
  totalSize: number
  connections?: number
  speedLimitBps?: number
  /** 多文件并发时传入共享的限速器，使总速率受控 */
  limiter?: RateLimiter
  headers?: Record<string, string>
  signal?: AbortSignal
  onProgress?: (progress: { loaded: number; total: number; percent: number; speed: number }) => void
}

/**
 * HTTP Range 分块并行下载：并发拉取各分段到临时文件，完成后顺序拼接。
 * 任一分段失败即整体失败并清理现场，由上层按任务重试策略处理。
 */
export async function chunkedDownloadTo(options: ChunkedDownloadOptions): Promise<{ localPath: string; fileSize: number }> {
  const { url, targetPath, totalSize, signal } = options
  signal?.throwIfAborted()
  const controller = new AbortController()
  const workerSignal = AbortSignal.any([controller.signal, signal ?? AbortSignal.timeout(120_000)])
  const limiter = options.limiter ?? new RateLimiter(options.speedLimitBps || 0)
  const ranges = splitRanges(totalSize, options.connections || 4)
  // Isolate temporary files from other attempts and existing user files.
  const tempDir = fs.mkdtempSync(path.join(path.dirname(targetPath), '.panlite-download-'))
  const partPaths = ranges.map((_, index) => path.join(tempDir, `part${index}`))
  const assembledPath = path.join(tempDir, 'complete')
  let loaded = 0
  let lastTickAt = Date.now()
  let lastTickLoaded = 0
  let speed = 0

  const report = (): void => {
    const now = Date.now()
    if (now - lastTickAt >= 300) {
      speed = Math.round(((loaded - lastTickLoaded) * 1000) / (now - lastTickAt))
      lastTickAt = now
      lastTickLoaded = loaded
    }
    options.onProgress?.({ loaded: totalSize > 0 ? Math.min(loaded, totalSize) : loaded, total: totalSize, percent: totalSize > 0 ? Math.round((Math.min(loaded, totalSize) / totalSize) * 100) : 0, speed })
  }

  const cleanup = (): void => {
    fs.rmSync(tempDir, { force: true, recursive: true })
  }

  const worker = async (index: number): Promise<void> => {
    const range = ranges[index]
    const headers: Record<string, string> = { ...options.headers }
    const ranged = totalSize > 0
    if (ranged) headers.Range = `bytes=${range.start}-${range.end}`
    const response = await net.fetch(url, { headers, signal: workerSignal })
    // A multi-range download must receive partial content.  Accepting a 200
    // response for every part would concatenate the complete file repeatedly;
    // a single-range request may legitimately fall back to 200.
    if ((ranged && ranges.length > 1 && response.status !== 206) || (!response.ok && response.status !== 206)) {
      throw new Error(`下载分段 ${index + 1} 失败：HTTP ${response.status}`)
    }
    if (!response.body) throw new Error(`下载分段 ${index + 1} 失败：无内容`)
    if (response.status === 206) {
      const contentRange = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i)
      if (!ranged || !contentRange || Number(contentRange[1]) !== range.start || Number(contentRange[2]) !== range.end || Number(contentRange[3]) !== totalSize) {
        throw new Error(`下载分段 ${index + 1} Content-Range 与请求不一致`)
      }
    }
    const write = fs.createWriteStream(partPaths[index])
    let partLoaded = 0
    const counter = new Transform({
      async transform(chunk, _encoding, callback) {
        try {
          await limiter.take(chunk.length, workerSignal)
          partLoaded += chunk.length
          loaded += chunk.length
          report()
          callback(null, chunk)
        } catch (error) {
          callback(error as Error)
        }
      },
    })
    await pipeline(Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream), counter, write, { signal: workerSignal })
    if (ranged) {
      const expected = range.end - range.start + 1
      if (partLoaded !== expected) throw new Error(`下载分段 ${index + 1} 数据长度异常：${partLoaded}/${expected}`)
    }
  }

  try {
    let firstError: unknown
    const results = await Promise.allSettled(ranges.map((_, index) => worker(index).catch(error => {
      firstError ??= error
      controller.abort(error)
      throw error
    })))
    if (results.some(result => result.status === 'rejected')) throw firstError
    workerSignal.throwIfAborted()

    // 拼接分段；顺序流式写入避免整文件载入内存
    async function* parts(): AsyncGenerator<Buffer> {
      for (const partPath of partPaths) {
        workerSignal.throwIfAborted()
        yield* fs.createReadStream(partPath)
      }
    }
    await pipeline(Readable.from(parts()), fs.createWriteStream(assembledPath), { signal: workerSignal })
    workerSignal.throwIfAborted()
    fs.renameSync(assembledPath, targetPath)
    return { localPath: targetPath, fileSize: fs.statSync(targetPath).size }
  } finally {
    cleanup()
  }
}
