import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuarkAdapter } from './quark'
import { UcAdapter } from './uc'
import { isPermanentError, PanError } from './errors'
import type { DriveAccount } from '../shared/types'
const network = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('electron', () => ({ session: { fromPartition: () => ({ fetch: network.fetch, cookies: { set: vi.fn() } }) } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
let directory: string
let filePath: string
let finishCode: number
let preFinish: unknown
let hashFinish: unknown
let etag: string
let controller: AbortController | undefined
const payload = Buffer.from('abcdefghi')
const chunks: Buffer[] = []
const progress: number[] = []
beforeEach(async () => {
  vi.spyOn(Date.prototype, 'toUTCString').mockReturnValue('Wed, 09 Sep 2026 00:00:00 GMT')
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'panlite-cookie-upload-'))
  filePath = path.join(directory, 'payload.txt')
  await fs.writeFile(filePath, payload)
  finishCode = 0; preFinish = false; hashFinish = false; etag = 'etag-fixture'; controller = undefined
  chunks.length = 0; progress.length = 0
  network.fetch.mockReset().mockImplementation(async (url: string, init: RequestInit) => {
    const endpoint = new URL(url)
    const json = (value: unknown) => new Response(JSON.stringify(value))
    if (endpoint.pathname.endsWith('/upload/pre')) {
      expect(JSON.parse(String(init.body)).pdir_fid).toBe('0')
      controller?.abort()
      return json({ code: 0, metadata: { part_size: 4 }, data: { task_id: 'task-fixture', fid: 'file-fixture', finish: preFinish, upload_id: 'upload-fixture', bucket: 'bucket', obj_key: 'object', upload_url: 'https://oss.example.test', auth_info: 'auth-fixture', callback: {} } })
    }
    if (endpoint.pathname.endsWith('/update/hash')) return json({ code: 0, data: { finish: hashFinish } })
    if (endpoint.pathname.endsWith('/upload/auth')) {
      const meta = JSON.parse(String(init.body)).auth_meta as string
      // Transcribed from RAW util.go at Alist commit
      // 22f10b4135503f785d11f4c9b90eb896c3aa78e5, never rendered web text.
      // The second newline is the OSS v1 empty Content-MD5 field.
      if (meta.startsWith('PUT')) {
        const part = chunks.length + 1
        const rawReference = 'PUT\n\napplication/octet-stream\nWed, 09 Sep 2026 00:00:00 GMT\nx-oss-date:Wed, 09 Sep 2026 00:00:00 GMT\nx-oss-user-agent:aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit\n/bucket/object?partNumber=PART&uploadId=upload-fixture'
        expect(Buffer.from(meta).equals(Buffer.from(rawReference.replace('PART', String(part))))).toBe(true)
      }
      return json({ code: 0, data: { auth_key: 'authorization-fixture' } })
    }
    if (endpoint.hostname === 'bucket.oss.example.test' && init.method === 'PUT') {
      chunks.push(Buffer.from(init.body as unknown as Uint8Array))
      return new Response(null, { status: 200, headers: etag ? { etag } : {} })
    }
    if (endpoint.hostname === 'bucket.oss.example.test' && init.method === 'POST') return new Response(null, { status: 200 })
    if (endpoint.pathname.endsWith('/upload/finish')) {
      expect(progress).not.toContain(100)
      return json({ code: finishCode, message: 'finish rejected' })
    }
    throw new Error('Unexpected upload fixture request')
  })
  vi.stubGlobal('fetch', network.fetch)
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await fs.rm(directory, { recursive: true, force: true }) })

describe.each([['quark', () => new QuarkAdapter()], ['uc', () => new UcAdapter()]] as const)('%s actual multipart uploads', (platform, create) => {
  const account: DriveAccount = { id: `${platform}-upload-fixture`, platform, nickname: 'fixture', loginType: 'cookie', credential: { cookies: 'cookie=fixture' }, status: 'active', createdAt: 0, updatedAt: 0 }
  it('uploads exact slices, uses the provider auth contract, and returns the preupload file ID', async () => {
    const result = await create().upload(account, filePath, '0', { onProgress: value => progress.push(value.percent) })
    expect(Buffer.concat(chunks).equals(payload)).toBe(true)
    expect(chunks.map(chunk => chunk.length)).toEqual([4, 4, 1])
    expect(result).toMatchObject({ success: true, fileId: 'file-fixture' })
    expect(progress[progress.length - 1]).toBe(100)
  })
  it('does not report 100 before a failed finish operation', async () => {
    finishCode = 500
    await expect(create().upload(account, filePath, '0', { onProgress: value => progress.push(value.percent) })).rejects.toThrow(/file\/upload\/finish.*code=500/)
    expect(progress).not.toContain(100)
  })
  it('rejects a PUT without its required ETag before completing multipart upload', async () => {
    etag = ''
    await expect(create().upload(account, filePath, '0')).rejects.toThrow(/ETag/)
    expect(network.fetch.mock.calls.some(call => new URL(call[0]).pathname.endsWith('/upload/finish'))).toBe(false)
  })
  it('does not treat the string false as confirmed rapid upload', async () => {
    preFinish = 'false'; hashFinish = 'false'
    expect(await create().upload(account, filePath, '0', { onProgress: value => progress.push(value.percent) })).toMatchObject({ success: true, fileId: 'file-fixture' })
    expect(chunks).toHaveLength(3)
  })
  it('preserves a real preupload ID when the hash endpoint confirms rapid upload', async () => {
    hashFinish = true
    expect(await create().upload(account, filePath, '0')).toMatchObject({ success: true, fileId: 'file-fixture' })
    expect(chunks).toHaveLength(0)
  })
  it('stops when cancelled after the preupload response', async () => {
    controller = new AbortController()
    preFinish = true
    await expect(create().upload(account, filePath, '0', { signal: controller.signal })).rejects.toThrow()
    expect(network.fetch).toHaveBeenCalledTimes(1)
  })
  it('identifies the failed upload endpoint and safe business error on HTTP 403', async () => {
    network.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 23018, message: 'User-Agent 校验失败' }), { status: 403 }))
    const failure = await create().upload(account, filePath, '0').catch(error => error)
    expect(failure).toBeInstanceOf(PanError)
    expect(isPermanentError(failure)).toBe(true)
    expect(failure.message).toContain('POST /1/clouddrive/file/upload/pre (HTTP 403, code=23018)')
    expect(failure.message).toContain('User-Agent 校验失败')
  })
  it('never includes echoed credentials or arbitrary error bodies in diagnostics', async () => {
    network.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 403, message: 'auth_info=secret-fixture cookie=session-fixture', data: { access_token: 'hidden-fixture' } }), { status: 403 }))
    const failure = await create().upload(account, filePath, '0').catch(error => error)
    expect(failure.message).toContain('敏感响应消息已隐藏')
    expect(failure.message).not.toMatch(/secret-fixture|session-fixture|hidden-fixture/)
  })
  it('identifies a business failure even when HTTP itself succeeds', async () => {
    network.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 43004, message: 'date should be GMT format' }), { status: 200 }))
    const failure = await create().upload(account, filePath, '0').catch(error => error)
    expect(failure.message).toContain('POST /1/clouddrive/file/upload/pre (HTTP 200, code=43004)')
    expect(failure.message).toContain('date should be GMT format')
    expect(network.fetch).toHaveBeenCalledTimes(1)
  })
})
