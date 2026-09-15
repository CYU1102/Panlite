import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaiduAdapter } from './baidu'
import type { DriveAccount } from '../shared/types'
const network = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('electron', () => ({ net: { request: network.request }, session: {}, BrowserWindow: vi.fn() }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
const account: DriveAccount = { id: 'baidu-upload-fixture', platform: 'baidu', nickname: 'fixture', loginType: 'oauth', credential: { accessToken: 'access-fixture' }, status: 'active', createdAt: 0, updatedAt: 0 }
let directory: string
let localPath: string
let sliceResponse: unknown
let sliceStatus: number
let createResponse: unknown
let preResponse: unknown
let controller: AbortController | undefined
const payload = Buffer.from('upload fixture bytes')
const methods: string[] = []
const progress: number[] = []
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'panlite-baidu-upload-'))
  localPath = path.join(directory, 'payload.txt')
  await fs.writeFile(localPath, payload)
  sliceResponse = { md5: crypto.createHash('md5').update(payload).digest('hex') }; sliceStatus = 200
  createResponse = { errno: 0, fs_id: 42, path: '/payload.txt', size: payload.length }
  preResponse = { errno: 0, return_type: 1, uploadid: 'upload-fixture', block_list: [0] }
  controller = undefined; methods.length = 0; progress.length = 0
  network.request.mockReset().mockImplementation((options: { method: string; url: string }) => {
    const method = new URL(options.url).searchParams.get('method')!
    methods.push(method)
    let body = Buffer.alloc(0)
    const request = Object.assign(new EventEmitter(), {
      setHeader() {}, abort() {}, write(data: string | Buffer) { body = Buffer.concat([body, Buffer.from(data)]) },
      end() {
        let value: unknown
        if (method === 'rapidupload') value = { errno: 404 }
        else if (method === 'precreate') { controller?.abort(); value = preResponse }
        else if (method === 'locateupload') value = { host: 'upload.example.test' }
        else if (method === 'upload') { expect(body.includes(payload)).toBe(true); value = sliceResponse }
        else if (method === 'create') { expect(progress).not.toContain(100); value = createResponse }
        else throw new Error('Unexpected upload fixture request')
        const response = Object.assign(new EventEmitter(), { statusCode: method === 'upload' ? sliceStatus : 200, headers: {} })
        request.emit('response', response)
        response.emit('data', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)))
        response.emit('end')
      },
    })
    return request
  })
})
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }) })

describe('Baidu actual multipart upload confirmation', () => {
  it('sends actual bytes and returns the platform path only after creating the file', async () => {
    expect(await new BaiduAdapter().upload(account, localPath, '0', { onProgress: value => progress.push(value.percent) })).toMatchObject({ success: true, fileId: '/payload.txt', fileName: 'payload.txt' })
    expect(methods).toEqual(['rapidupload', 'precreate', 'locateupload', 'upload', 'create'])
    expect(progress[progress.length - 1]).toBe(100)
  })
  it.each(['<html>upstream unavailable</html>', {}, { md5: 'wrong-digest' }])('does not continue after an unconfirmed slice response', async value => {
    sliceResponse = value
    await expect(new BaiduAdapter().upload(account, localPath, '0')).rejects.toThrow(/分片|slice/)
    expect(methods).not.toContain('create')
  })
  it('rejects HTTP failures even when the slice body has a digest', async () => {
    sliceStatus = 503
    await expect(new BaiduAdapter().upload(account, localPath, '0')).rejects.toThrow('503')
    expect(methods).not.toContain('create')
  })
  it('does not report 100 percent after create fails', async () => {
    createResponse = { errno: -10 }
    await expect(new BaiduAdapter().upload(account, localPath, '0', { onProgress: value => progress.push(value.percent) })).rejects.toThrow('创建文件失败')
    expect(progress).not.toContain(100)
  })
  it('does not start slices after cancelled precreate', async () => {
    controller = new AbortController(); preResponse = { errno: 0, return_type: 2 }
    await expect(new BaiduAdapter().upload(account, localPath, '0', { signal: controller.signal })).rejects.toThrow()
    expect(methods).toEqual(['rapidupload', 'precreate'])
  })
  it('maps confirmed native precreate rapid success to a path without inventing an fs_id', async () => {
    preResponse = { errno: 0, return_type: 2 }
    expect(await new BaiduAdapter().upload(account, localPath, '0')).toMatchObject({ success: true, fileId: '/payload.txt' })
    expect(methods).toEqual(['rapidupload', 'precreate'])
  })
})
