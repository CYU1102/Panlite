import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuarkAdapter } from './quark'
import { UcAdapter } from './uc'
import { XunleiAdapter } from './xunlei'
import { BaiduAdapter } from './baidu'
import type { DriveAccount } from '../shared/types'
const network = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: network.fetch }, session: { fromPartition: () => ({ fetch: network.fetch }) }, BrowserWindow: vi.fn() }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
let directory: string
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'panlite-adapter-download-')); network.fetch.mockReset(); vi.stubGlobal('fetch', network.fetch) })
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await fs.rm(directory, { recursive: true, force: true }) })

// These invoke the concrete adapters' existing download methods. URL discovery
// is isolated here and covered separately by provider response contract tests;
// this suite exercises real response streams and filesystem writes only.
describe.each([
  ['quark', () => new QuarkAdapter()], ['uc', () => new UcAdapter()],
  ['xunlei', () => new XunleiAdapter()], ['baidu', () => new BaiduAdapter()],
] as const)('%s adapter disk and response stream handling', (platform, create) => {
  const account: DriveAccount = { id: `${platform}-download-fixture`, platform, nickname: 'fixture', loginType: 'token', credential: { accessToken: 'access-fixture', cookies: 'cookie=fixture' }, status: 'active', createdAt: 0, updatedAt: 0 }
  function adapter() {
    const instance = create()
    if (platform === 'baidu') {
      vi.spyOn(instance as unknown as { resolveFileFsId: () => Promise<string> }, 'resolveFileFsId').mockResolvedValue('42')
      vi.spyOn(instance as unknown as { fetchFileMeta: () => Promise<unknown> }, 'fetchFileMeta').mockResolvedValue({ filename: 'data.txt', size: 0, dlink: 'https://download.example.test/data' })
    } else vi.spyOn(instance, 'getDownloadUrl').mockResolvedValue('https://download.example.test/data')
    return instance
  }
  it('writes real response bytes and reports completion after the destination exists', async () => {
    network.fetch.mockResolvedValue(new Response('download payload', { headers: { 'Content-Length': '16' } }))
    const progress: number[] = []
    const result = await adapter().download(account, '42', directory, { fileName: 'data.txt', onProgress: value => progress.push(value.percent) })
    expect(result).toMatchObject({ success: true, fileSize: 16 })
    expect(await fs.readFile(path.join(directory, 'data.txt'), 'utf8')).toBe('download payload')
    expect(progress[progress.length - 1]).toBe(100)
    expect(await fs.readdir(directory)).toEqual(['data.txt'])
  })
  it('does not truncate existing files when the response has no body', async () => {
    await fs.writeFile(path.join(directory, 'data.txt'), 'original')
    network.fetch.mockResolvedValue(new Response(null))
    await expect(adapter().download(account, '42', directory, { fileName: 'data.txt' })).rejects.toThrow(/响应流/)
    expect(await fs.readFile(path.join(directory, 'data.txt'), 'utf8')).toBe('original')
  })
  it('rejects a truncated stream without replacing the existing destination', async () => {
    await fs.writeFile(path.join(directory, 'data.txt'), 'original')
    network.fetch.mockResolvedValue(new Response('short', { headers: { 'Content-Length': '100' } }))
    await expect(adapter().download(account, '42', directory, { fileName: 'data.txt' })).rejects.toThrow('长度不匹配')
    expect(await fs.readFile(path.join(directory, 'data.txt'), 'utf8')).toBe('original')
    expect(await fs.readdir(directory)).toEqual(['data.txt'])
  })
  it('handles disk errors as a rejected download and removes its temporary file', async () => {
    await fs.mkdir(path.join(directory, 'data.txt'))
    network.fetch.mockResolvedValue(new Response('data'))
    await expect(adapter().download(account, '42', directory, { fileName: 'data.txt' })).rejects.toThrow()
    expect(await fs.readdir(directory)).toEqual(['data.txt'])
  })
  it('cancels during streaming without replacing the existing destination', async () => {
    await fs.writeFile(path.join(directory, 'data.txt'), 'original')
    const controller = new AbortController()
    network.fetch.mockResolvedValue(new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('partial')) } })))
    await expect(adapter().download(account, '42', directory, { fileName: 'data.txt', signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow()
    expect(await fs.readFile(path.join(directory, 'data.txt'), 'utf8')).toBe('original')
    expect(await fs.readdir(directory)).toEqual(['data.txt'])
  })
  it('turns an immediate destination write error into a rejected promise', async () => {
    network.fetch.mockResolvedValue(new Response('data'))
    await expect(adapter().download(account, '42', path.join(directory, 'missing'), { fileName: 'data.txt' })).rejects.toThrow()
    expect(await fs.readdir(directory)).toEqual([])
  })
  it('turns progress callback errors into rejection without an uncaught stream error', async () => {
    await fs.writeFile(path.join(directory, 'data.txt'), 'original')
    network.fetch.mockResolvedValue(new Response('data'))
    await expect(adapter().download(account, '42', directory, { fileName: 'data.txt', onProgress: () => { throw new Error('progress fixture failure') } })).rejects.toThrow('progress fixture failure')
    expect(await fs.readFile(path.join(directory, 'data.txt'), 'utf8')).toBe('original')
    expect(await fs.readdir(directory)).toEqual(['data.txt'])
  })
})
