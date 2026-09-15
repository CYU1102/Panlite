import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { XunleiAdapter } from './xunlei'
import type { DriveAccount } from '../shared/types'
const network = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('electron', () => ({ net: {}, session: { fromPartition: () => ({ fetch: network.fetch }) }, BrowserWindow: vi.fn() }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
const aws4 = require('aws4')
let directory: string
let filePath: string
let sequence = 0
const params = { bucket: 'bucket', key: 'folder/a b!.txt', endpoint: 'bucket.s3.example.test', access_key_id: 'access-key-fixture', access_key_secret: 'secret-key-fixture', security_token: 'session-token-fixture' }
const reply = (value: unknown, status = 200) => network.fetch.mockResolvedValueOnce(new Response(JSON.stringify(value), { status }))
const preupload = () => ({ upload_type: 'UPLOAD_TYPE_RESUMABLE', file: { id: 'uploaded-file', phase: 'PHASE_TYPE_PENDING' }, resumable: { params } })
function account(): DriveAccount {
  return { id: `xunlei-upload-${++sequence}`, platform: 'xunlei', nickname: 'fixture', loginType: 'token', credential: { accessToken: 'access-fixture', userId: 'user-fixture' }, status: 'active', createdAt: 0, updatedAt: 0 }
}
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'panlite-xunlei-upload-'))
  filePath = path.join(directory, 'payload.txt')
  await fs.writeFile(filePath, 'actual payload')
  network.fetch.mockReset()
  reply({ captcha_token: 'captcha-fixture', expires_in: 3600 })
})
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { force: true, recursive: true }) })

describe('Xunlei actual S3 upload', () => {
  it('does not mistake a resumable file ID for rapid success, streams bytes, and signs with AWS SigV4', async () => {
    reply(preupload())
    const progress: number[] = []
    network.fetch.mockImplementationOnce(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://bucket.s3.example.test/folder/a%20b%21.txt')
      const body = await new Response(init.body).text()
      expect(body).toBe('actual payload')
      expect(progress.every(percent => percent < 100)).toBe(true)
      const headers = new Headers(init.headers)
      const signed = aws4.sign({
        service: 's3', region: 'xunlei', host: new URL(url).host, path: new URL(url).pathname, method: 'PUT', body,
        headers: { 'Content-Type': headers.get('content-type'), 'X-Amz-Date': headers.get('x-amz-date'), 'X-Amz-Content-Sha256': headers.get('x-amz-content-sha256') },
        extraHeadersToIgnore: { 'content-length': true },
      }, { accessKeyId: params.access_key_id, secretAccessKey: params.access_key_secret, sessionToken: params.security_token })
      expect(headers.get('authorization')).toBe(signed.headers.Authorization)
      expect(headers.get('x-amz-security-token')).toBe(params.security_token)
      return new Response(null, { status: 200 })
    })
    expect(await new XunleiAdapter().upload(account(), filePath, '0', { onProgress: value => progress.push(value.percent) })).toMatchObject({ success: true, fileId: 'uploaded-file' })
    expect(progress[progress.length - 1]).toBe(100)
    expect(network.fetch).toHaveBeenCalledTimes(3)
  })
  it('does not report success or 100 percent after S3 rejects upload', async () => {
    reply(preupload())
    const progress: number[] = []
    network.fetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      await new Response(init.body).arrayBuffer()
      return new Response('', { status: 403 })
    })
    await expect(new XunleiAdapter().upload(account(), filePath, '0', { onProgress: value => progress.push(value.percent) })).rejects.toThrow('403')
    expect(progress).not.toContain(100)
  })
  it.each([
    { file: { id: 'id', phase: 'PHASE_TYPE_PENDING' } },
    { upload_type: 'UPLOAD_TYPE_RESUMABLE', file: { id: 'id' }, resumable: { params: {} } },
    { upload_type: 'UPLOAD_TYPE_RESUMABLE', resumable: { params } },
  ])('rejects unconfirmed or invalid preupload responses', async response => {
    reply(response)
    await expect(new XunleiAdapter().upload(account(), filePath, '0')).rejects.toThrow(/未确认|缺少/)
    expect(network.fetch).toHaveBeenCalledTimes(2)
  })
  it('accepts explicitly completed rapid uploads', async () => {
    reply({ file: { id: 'rapid-id', phase: 'PHASE_TYPE_COMPLETE' } })
    expect(await new XunleiAdapter().upload(account(), filePath, '0')).toMatchObject({ success: true, fileId: 'rapid-id' })
    expect(network.fetch).toHaveBeenCalledTimes(2)
  })
  it('cancels after preupload and before sending file bytes', async () => {
    const controller = new AbortController()
    network.fetch.mockImplementationOnce(async () => { controller.abort(); return new Response(JSON.stringify(preupload())) })
    await expect(new XunleiAdapter().upload(account(), filePath, '0', { signal: controller.signal })).rejects.toThrow()
    expect(network.fetch).toHaveBeenCalledTimes(2)
  })
})
