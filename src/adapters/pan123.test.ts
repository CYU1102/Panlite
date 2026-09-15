import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveAccount, UploadProgress } from '../shared/types'
import { pan123Adapter, setPan123CredentialRefreshHandler } from './pan123'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), delay: vi.fn(), persist: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: mocks.fetch } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.delay }))

function account(): DriveAccount {
  return {
    id: 'pan123-fixture', platform: 'pan123', nickname: 'fixture', loginType: 'api_key',
    credential: { accessToken: 'fixture-access', clientId: 'fixture-client', clientSecret: 'fixture-secret' },
    status: 'active', createdAt: 0, updatedAt: 0,
  }
}

function response(data: unknown, code = 0, status = 200): Response {
  return new Response(JSON.stringify({ code, message: code ? 'fixture error' : 'ok', data }), { status })
}

function file(fileId: number, extra: Record<string, unknown> = {}) {
  return { fileId, parentFileId: 0, filename: `file-${fileId}.txt`, type: 0, size: 5, trashed: 0, ...extra }
}

const temporaryFiles: string[] = []
async function uploadFile(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panlite-pan123-'))
  const filename = path.join(directory, 'fixture.txt')
  temporaryFiles.push(filename)
  await writeFile(filename, 'hello')
  return filename
}

beforeEach(() => {
  mocks.fetch.mockReset()
  mocks.delay.mockReset().mockResolvedValue(undefined)
  mocks.persist.mockReset()
  setPan123CredentialRefreshHandler(mocks.persist)
})
afterEach(async () => {
  for (const filename of temporaryFiles.splice(0)) {
    await rm(filename, { force: true })
    await rmdir(path.dirname(filename))
  }
})

// Provider-shaped fixtures, not an in-memory implementation of DriveAdapter.
// Source contracts: OpenList drivers/123_open/{types,util}.go and go-123pan/{file,upload}.go.
describe('123 open file response contracts', () => {
  it('reads top-level fileList and cursor, retains hashes, and removes trashed entries', async () => {
    const etag = '5d41402abc4b2a76b9719d911017c592'
    mocks.fetch.mockResolvedValueOnce(response({
      fileList: [file(1, { etag, createAt: '2026-09-09 08:00:00' }), file(2, { trashed: 1 })], lastFileId: 42,
    })).mockResolvedValueOnce(response({ fileList: [file(3)], lastFileId: -1 }))
    const result = await pan123Adapter.listFiles(account(), '0')
    expect(result.files.map(item => item.id)).toEqual(['1', '3'])
    expect(result.files[0].raw?.etag).toBe(etag)
    expect(result.files[0].createdAt).toBe(Date.parse('2026-09-09T00:00:00Z'))
    expect(new URL(mocks.fetch.mock.calls[1][0]).searchParams.get('lastFileId')).toBe('42')
    expect(result.hasMore).toBe(false)
  })

  it('does not truncate a page consisting entirely of recycled files', async () => {
    mocks.fetch.mockResolvedValueOnce(response({ fileList: [file(1, { trashed: 1 })], lastFileId: 1 }))
      .mockResolvedValueOnce(response({ fileList: [file(2)], lastFileId: -1 }))
    expect((await pan123Adapter.listFiles(account(), '0')).files.map(item => item.id)).toEqual(['2'])
  })

  it('continues an empty page if its cursor is not terminal', async () => {
    mocks.fetch.mockResolvedValueOnce(response({ fileList: [], lastFileId: 1 }))
      .mockResolvedValueOnce(response({ fileList: [file(2)], lastFileId: -1 }))
    expect((await pan123Adapter.listFiles(account(), '0')).files.map(item => item.id)).toEqual(['2'])
  })

  it('rejects a repeated cursor on an empty page', async () => {
    mocks.fetch.mockResolvedValueOnce(response({ fileList: [], lastFileId: 0 }))
    await expect(pan123Adapter.listFiles(account(), '0')).rejects.toThrow('游标重复')
  })

  it('rejects malformed lists instead of reporting an empty directory', async () => {
    mocks.fetch.mockResolvedValue(response({ fileList: { list: [file(1)] }, lastFileId: -1 }))
    await expect(pan123Adapter.listFiles(account(), '0')).rejects.toThrow('格式异常')
  })

  it('stops repeated cursors without returning a misleading complete result', async () => {
    mocks.fetch.mockImplementation(async () => response({ fileList: [file(1)], lastFileId: 1 }))
    await expect(pan123Adapter.listFiles(account(), '0')).rejects.toThrow('游标重复')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('uses provider global search including files below the old traversal depth limit', async () => {
    mocks.fetch.mockResolvedValue(response({ fileList: [file(7, { parentFileId: 999 })], lastFileId: -1 }))
    const result = await pan123Adapter.searchFiles(account(), '  report  ')
    const url = new URL(mocks.fetch.mock.calls[0][0])
    expect(url.pathname).toBe('/api/v2/file/list')
    expect(url.searchParams.get('searchData')).toBe('report')
    expect(url.searchParams.get('searchMode')).toBe('0')
    expect(result[0].parentId).toBe('999')
  })

  it('rejects an HTTP error even if its JSON has code zero', async () => {
    mocks.fetch.mockResolvedValue(response({ fileList: [], lastFileId: -1 }, 0, 503))
    await expect(pan123Adapter.listFiles(account(), '0')).rejects.toThrow('123云盘接口错误')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects a null API response with a provider error', async () => {
    mocks.fetch.mockResolvedValue(new Response('null'))
    await expect(pan123Adapter.listFiles(account(), '0')).rejects.toThrow('123云盘接口错误')
  })

  it('maps the provider avatar and sums permanent and temporary capacity', async () => {
    mocks.fetch.mockImplementation(async () => response({ nickname: 'fixture-user', headImage: 'https://example.test/avatar', spaceUsed: '30', spacePermanent: '100', spaceTemp: '50' }))
    expect(await pan123Adapter.getUserInfo!(account())).toEqual({ nickname: 'fixture-user', avatar: 'https://example.test/avatar' })
    expect(await pan123Adapter.getQuota!(account())).toEqual({ used: 30, total: 150 })
  })

  it('refreshes authorization once and retries the actual request', async () => {
    mocks.fetch.mockResolvedValueOnce(response({}, 401, 401))
      .mockResolvedValueOnce(response({ accessToken: 'renewed', expiredAt: '2099-01-01T00:00:00Z' }))
      .mockResolvedValueOnce(response({ fileList: [file(1)], lastFileId: -1 }))
    const current = account()
    expect((await pan123Adapter.listFiles(current, '0')).files).toHaveLength(1)
    expect(mocks.fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer renewed')
    expect(current.credential.expiresAt).toBeGreaterThan(Date.now())
    expect(mocks.persist).toHaveBeenCalledWith(current.id, expect.objectContaining({ accessToken: 'renewed', expiresAt: current.credential.expiresAt }))
  })

  it('does not keep retrying rejected authorization', async () => {
    mocks.fetch.mockResolvedValueOnce(response({}, 401, 401))
      .mockResolvedValueOnce(response({ accessToken: 'renewed' }))
      .mockResolvedValueOnce(response({}, 401, 401))
    await expect(pan123Adapter.listFiles(account(), '0')).rejects.toThrow('123云盘接口错误')
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
  })

  it('reads mkdir dirID and refuses missing IDs', async () => {
    mocks.fetch.mockResolvedValueOnce(response({ dirID: 89 })).mockResolvedValueOnce(response({}))
    expect((await pan123Adapter.mkdir(account(), '0', 'directory')).id).toBe('89')
    await expect(pan123Adapter.mkdir(account(), '0', 'directory')).rejects.toThrow('ID 无效')
  })

  it('does not refresh twice when an initially missing token is rejected', async () => {
    const current = account()
    delete current.credential.accessToken
    mocks.fetch.mockResolvedValueOnce(response({ accessToken: 'renewed' }))
      .mockResolvedValueOnce(response({}, 401, 401))
    await expect(pan123Adapter.listFiles(current, '0')).rejects.toThrow('123云盘接口错误')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('uses the single-file rename PUT contract and validates IDs before sending', async () => {
    mocks.fetch.mockResolvedValue(response({}))
    await pan123Adapter.rename(account(), '42', 'renamed.txt')
    expect(new URL(mocks.fetch.mock.calls[0][0]).pathname).toBe('/api/v1/file/name')
    expect(mocks.fetch.mock.calls[0][1].method).toBe('PUT')
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ fileId: 42, fileName: 'renamed.txt' })
    await expect(pan123Adapter.delete(account(), ['invalid'])).rejects.toThrow('ID 无效')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('requests a single-file download URL via GET', async () => {
    mocks.fetch.mockResolvedValue(response({ downloadUrl: 'https://download.example.test/file' }))
    await expect(pan123Adapter.getDownloadUrl!(account(), '42')).resolves.toBe('https://download.example.test/file')
    const [address, options] = mocks.fetch.mock.calls[0]
    expect(new URL(address).pathname).toBe('/api/v1/file/download_info')
    expect(new URL(address).searchParams.get('fileId')).toBe('42')
    expect(options.method).toBe('GET')
    expect(options.body).toBeUndefined()
  })

  it('does not request a download URL for an already cancelled download', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(pan123Adapter.download!(account(), '42', '.', { signal: controller.signal })).rejects.toThrow()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})

type Completion = { completed?: boolean; async?: boolean; fileID?: number }
function mockUpload(completion: Completion, polls: Completion[] = [], sliceSize = 3) {
  const uploaded: Buffer[] = []
  mocks.fetch.mockImplementation(async (address: string, options: RequestInit) => {
    const url = new URL(address)
    switch (url.pathname) {
      case '/upload/v1/file/create': return response({ reuse: false, preuploadID: 'upload-fixture', sliceSize })
      case '/upload/v1/file/get_upload_url': {
        const request = JSON.parse(String(options.body))
        return response({ presignedURL: `https://upload.example.test/part-${request.sliceNo}` })
      }
      case '/part-1': case '/part-2':
        expect(options.headers).not.toHaveProperty('Authorization')
        expect(options.headers).not.toHaveProperty('Platform')
        uploaded.push(Buffer.from(options.body as unknown as Uint8Array))
        return new Response(null, { status: 200 })
      case '/upload/v1/file/upload_complete': return response(completion)
      case '/upload/v1/file/upload_async_result': return response(polls.length > 1 ? polls.shift()! : polls[0] || { completed: false })
      default: throw new Error(`Unexpected mocked endpoint: ${url.pathname}`)
    }
  })
  return uploaded
}

describe('123 upload completion', () => {
  it('accepts the provider reuse flag only when the returned file ID is valid', async () => {
    mocks.fetch.mockResolvedValueOnce(response({ reuse: true, fileID: 101 }))
      .mockResolvedValueOnce(response({ reuse: true }))
    const filename = await uploadFile()
    expect(await pan123Adapter.upload!(account(), filename, '0')).toMatchObject({ success: true, fileId: '101' })
    await expect(pan123Adapter.upload!(account(), filename, '0')).rejects.toThrow('ID 无效')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('uploads exact slices and reports 100% only after the server confirms completion', async () => {
    const uploaded = mockUpload({ completed: true, fileID: 101 })
    const progress: UploadProgress[] = []
    const filename = await uploadFile()
    const result = await pan123Adapter.upload!(account(), filename, '0', { onProgress: value => progress.push(value) })
    expect(Buffer.concat(uploaded).toString()).toBe('hello')
    expect(uploaded.map(part => part.length)).toEqual([3, 2])
    expect(result).toMatchObject({ success: true, fileId: '101', fileSize: 5 })
    expect(progress.slice(0, -1).every(value => value.percent < 100)).toBe(true)
    expect(progress[progress.length - 1]?.percent).toBe(100)
  })

  it('polls asynchronous completion without re-uploading or resubmitting complete', async () => {
    mockUpload({ async: true, completed: false }, [{ completed: false }, { completed: true, fileID: 102 }])
    const result = await pan123Adapter.upload!(account(), await uploadFile(), '0')
    expect(result.fileId).toBe('102')
    const paths = mocks.fetch.mock.calls.map(([url]) => new URL(url).pathname)
    expect(paths.filter(url => url === '/upload/v1/file/upload_complete')).toHaveLength(1)
    expect(paths.filter(url => url === '/upload/v1/file/upload_async_result')).toHaveLength(2)
  })

  it('uses actual file length when the server slice size exceeds 64 MiB', async () => {
    const uploaded = mockUpload({ completed: true, fileID: 103 }, [], 100 * 1024 * 1024)
    expect((await pan123Adapter.upload!(account(), await uploadFile(), '0')).fileId).toBe('103')
    expect(uploaded.map(part => part.length)).toEqual([5])
    expect(Buffer.concat(uploaded).toString()).toBe('hello')
  })

  it.each([{ completed: false, async: false }, { completed: true }])('rejects an unconfirmed or unidentified upload: %j', async completion => {
    mockUpload(completion)
    const progress = vi.fn()
    await expect(pan123Adapter.upload!(account(), await uploadFile(), '0', { onProgress: progress })).rejects.toThrow()
    expect(progress.mock.calls.some(([value]) => value.percent === 100)).toBe(false)
  })

  it('bounds polling and never turns an unfinished upload into success', async () => {
    mockUpload({ async: true, completed: false })
    await expect(pan123Adapter.upload!(account(), await uploadFile(), '0')).rejects.toThrow('确认超时')
    expect(mocks.delay.mock.calls.length).toBeGreaterThan(1)
    expect(mocks.delay.mock.calls.length).toBeLessThanOrEqual(60)
  })

  it('cancels while awaiting remote confirmation without further requests', async () => {
    mockUpload({ async: true, completed: false })
    const controller = new AbortController()
    mocks.delay.mockImplementation(async () => { controller.abort() })
    await expect(pan123Adapter.upload!(account(), await uploadFile(), '0', { signal: controller.signal })).rejects.toThrow()
    expect(mocks.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/upload/v1/file/upload_async_result')).toBe(false)
  })

  it('does not start a cancelled upload', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(pan123Adapter.upload!(account(), 'not-read.txt', '0', { signal: controller.signal })).rejects.toThrow()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('does not report reuse success if cancellation arrives with the response', async () => {
    const controller = new AbortController()
    mocks.fetch.mockImplementation(async () => {
      controller.abort()
      return response({ reuse: true, fileID: 101 })
    })
    const progress = vi.fn()
    await expect(pan123Adapter.upload!(account(), await uploadFile(), '0', { signal: controller.signal, onProgress: progress })).rejects.toThrow()
    expect(progress).not.toHaveBeenCalled()
  })
})
