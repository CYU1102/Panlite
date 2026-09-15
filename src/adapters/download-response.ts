import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DownloadOptions } from '../shared/types'

/** Store a confirmed response atomically; pipeline propagates network, abort,
 * and disk errors and applies backpressure before buffering another chunk. */
export async function writeDownloadResponse(response: Response, localPath: string, options?: DownloadOptions, expectedSize = 0): Promise<number> {
  options?.signal?.throwIfAborted()
  if (!response.ok) throw new Error(`下载失败 (HTTP ${response.status})`)
  if (!response.body) throw new Error('无法读取响应流')
  const length = Number(response.headers.get('Content-Length')) || expectedSize
  const total = response.headers.has('Content-Encoding') ? 0 : length
  const temporaryPath = path.join(path.dirname(localPath), `.${path.basename(localPath)}.${crypto.randomUUID()}.part`)
  let loaded = 0
  const startedAt = Date.now()
  const progress = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    try {
      loaded += chunk.length
      const elapsed = Date.now() - startedAt
      options?.onProgress?.({ loaded, total: total || loaded, percent: total > 0 ? Math.min(99, Math.round(loaded / total * 100)) : 0, speed: elapsed > 0 ? loaded * 1000 / elapsed : 0 })
      callback(null, chunk)
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  } })
  try {
    await pipeline(Readable.fromWeb(response.body as never), progress, fs.createWriteStream(temporaryPath, { flags: 'wx' }), { signal: options?.signal })
    options?.signal?.throwIfAborted()
    if (total > 0 && loaded !== total) throw new Error(`下载长度不匹配：预计 ${total} 字节，收到 ${loaded} 字节`)
    await fs.promises.rename(temporaryPath, localPath)
    options?.onProgress?.({ loaded, total: loaded, percent: 100, speed: 0 })
    return loaded
  } finally {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {})
  }
}
