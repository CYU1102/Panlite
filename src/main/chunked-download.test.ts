import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chunkedDownloadTo, splitRanges, MIN_CHUNK_SIZE } from './chunked-download'

vi.mock('electron', () => ({ net: { fetch: (url: string, options: RequestInit) => {
  if (!url.startsWith('http://127.0.0.1:')) throw new Error('Only local HTTP fixtures are allowed')
  return fetch(url, options)
} } }))

let dir: string
let server: http.Server
let url: string
let handle: (request: http.IncomingMessage, response: http.ServerResponse) => void
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-chunks-'))
  server = http.createServer((request, response) => handle(request, response))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/file`
})
afterEach(async () => {
  vi.restoreAllMocks()
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  fs.rmSync(dir, { force: true, recursive: true })
})

describe('chunked downloads against local HTTP', () => {
  it('does not add a total-duration deadline when the caller owns cancellation', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(new Error('unexpected total-duration timeout')))
    handle = (_request, response) => { response.end('large download fixture') }
    const controller = new AbortController()
    const targetPath = path.join(dir, 'file')
    await expect(chunkedDownloadTo({ url, targetPath, totalSize: 0, signal: controller.signal }))
      .resolves.toMatchObject({ fileSize: 22 })
    expect(timeout).not.toHaveBeenCalled()
    expect(controller.signal.aborted).toBe(false)
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('large download fixture')
  })

  it('joins verified ranges in order despite concurrent responses', async () => {
    const size = MIN_CHUNK_SIZE * 2
    handle = (request, response) => {
      const [, start, end] = request.headers.range!.match(/bytes=(\d+)-(\d+)/)!
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}` })
      response.end(Buffer.alloc(Number(end) - Number(start) + 1, Number(start) === 0 ? 65 : 66))
    }
    const targetPath = path.join(dir, 'report.bin')
    await expect(chunkedDownloadTo({ url, targetPath, totalSize: size, connections: 2 })).resolves.toMatchObject({ fileSize: size })
    const downloaded = fs.readFileSync(targetPath)
    expect(downloaded.subarray(0, MIN_CHUNK_SIZE).equals(Buffer.alloc(MIN_CHUNK_SIZE, 65))).toBe(true)
    expect(downloaded.subarray(MIN_CHUNK_SIZE).equals(Buffer.alloc(MIN_CHUNK_SIZE, 66))).toBe(true)
    expect(fs.readdirSync(dir)).toEqual(['report.bin'])
  })

  it('rejects an incorrect Content-Range and preserves the previous target', async () => {
    handle = (_request, response) => {
      response.writeHead(206, { 'Content-Range': 'bytes 3-6/4' })
      response.end('oops')
    }
    const targetPath = path.join(dir, 'report.bin')
    fs.writeFileSync(targetPath, 'previous')
    await expect(chunkedDownloadTo({ url, targetPath, totalSize: 4 })).rejects.toThrow('Content-Range')
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('previous')
    expect(fs.readdirSync(dir)).toEqual(['report.bin'])
  })

  it('rejects a truncated part before publishing output', async () => {
    handle = (_request, response) => {
      response.writeHead(206, { 'Content-Range': 'bytes 0-9/10' }); response.end('short')
    }
    await expect(chunkedDownloadTo({ url, targetPath: path.join(dir, 'file'), totalSize: 10 })).rejects.toThrow('数据长度异常')
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('aborts sibling writers before cleaning up after a failed part', async () => {
    const size = MIN_CHUNK_SIZE * 2
    let secondStarted!: () => void
    const started = new Promise<void>(resolve => { secondStarted = resolve })
    handle = (request, response) => {
      if (request.headers.range!.startsWith('bytes=0-')) {
        void started.then(() => { response.writeHead(500); response.end('failed') })
      } else {
        response.writeHead(206, { 'Content-Range': `bytes ${MIN_CHUNK_SIZE}-${size - 1}/${size}` })
        response.write(Buffer.alloc(8192)); secondStarted()
        // Remains open until the downloader aborts it.
      }
    }
    await expect(chunkedDownloadTo({ url, targetPath: path.join(dir, 'file'), totalSize: size, connections: 2 })).rejects.toThrow('HTTP 500')
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('cancels active streams and leaves no partial file', async () => {
    handle = (_request, response) => {
      response.writeHead(206, { 'Content-Range': 'bytes 0-1023/1024' }); response.write('begin')
    }
    const controller = new AbortController()
    await expect(chunkedDownloadTo({ url, targetPath: path.join(dir, 'file'), totalSize: 1024, signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow()
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('reports actual bytes when the content length is unknown', async () => {
    handle = (_request, response) => { response.end('hello') }
    const progress = vi.fn()
    await expect(chunkedDownloadTo({ url, targetPath: path.join(dir, 'file'), totalSize: 0, onProgress: progress })).resolves.toMatchObject({ fileSize: 5 })
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ loaded: 5, total: 0 }))
    expect(splitRanges(MIN_CHUNK_SIZE, Number.NaN)).toEqual([{ start: 0, end: MIN_CHUNK_SIZE - 1 }])
  })
})
