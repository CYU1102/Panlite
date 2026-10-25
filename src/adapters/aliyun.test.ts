import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveAccount } from '../shared/types'

const { fetchMock, settingsMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), settingsMock: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: fetchMock } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../main/db', () => ({ getSetting: settingsMock }))
vi.mock('../main/crypto', () => ({ decryptCredential: (value: string) => value }))

import { aliyunAdapter, exchangeAliyunCode, refreshAliyunToken, setAliyunCredentialRefreshHandler } from './aliyun'

// Exercise the real adapter against native OpenAPI JSON, not a provider-independent
// in-memory adapter or a fabricated { data: ... } response wrapper. No live requests.
const API = 'https://openapi.alipan.com'
const DRIVE = '/adrive/v1.0/user/getDriveInfo'
const OPEN = '/adrive/v1.0/openFile/'
const temporaryDirs: string[] = []

function account(credential: DriveAccount['credential'] = { accessToken: 'test-access', refreshToken: 'test-refresh', userId: 'user-is-not-a-drive' }): DriveAccount {
  return { id: 'test-account', platform: 'aliyun', nickname: 'test', loginType: 'token', credential, status: 'active', createdAt: 0, updatedAt: 0 }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function bodyAt(index: number): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[index][1].body as string) as Record<string, unknown>
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'panlite-aliyun-contract-'))
  temporaryDirs.push(dir)
  return dir
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(() => { throw new Error('Unexpected network request in Aliyun test') })
  settingsMock.mockReset()
  settingsMock.mockReturnValue(undefined)
  setAliyunCredentialRefreshHandler(vi.fn())
})

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('Aliyun OpenAPI response and authentication contracts', () => {
  it('uses the drive ID and root-level paginated file response, never userId as driveId', async () => {
    fetchMock.mockResolvedValueOnce(json({ default_drive_id: 'drive-1', user_id: 'user-1' }))
      .mockResolvedValueOnce(json({ items: [{ file_id: 'f1', name: 'first.txt', type: 'file' }], next_marker: 'page-2' }))
      .mockResolvedValueOnce(json({ items: [{ file_id: 'd1', name: 'folder', type: 'folder' }], next_marker: '' }))

    const result = await aliyunAdapter.listFiles(account(), '0')
    expect(result.files.map((file) => file.id)).toEqual(['f1', 'd1'])
    expect(result.hasMore).toBe(false)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([API + DRIVE, API + OPEN + 'list', API + OPEN + 'list'])
    expect(bodyAt(1)).toMatchObject({ drive_id: 'drive-1', parent_file_id: 'root', marker: '' })
    expect(bodyAt(2).marker).toBe('page-2')
  })

  it('reads user and quota from their separate native endpoints', async () => {
    fetchMock.mockResolvedValueOnce(json({ default_drive_id: 'drive', nick_name: '云盘用户', avatar: 'https://example.test/avatar' }))
      .mockResolvedValueOnce(json({ personal_space_info: { used_size: 123, total_size: 456 } }))
    expect(await aliyunAdapter.getUserInfo(account())).toEqual({ nickname: '云盘用户', avatar: 'https://example.test/avatar' })
    expect(await aliyunAdapter.getQuota!(account())).toEqual({ used: 123, total: 456 })
    expect(fetchMock.mock.calls[1][0]).toBe(API + '/adrive/v1.0/user/getSpaceInfo')
  })

  it('rejects malformed successful lists and quota instead of reporting empty files or zero capacity', async () => {
    fetchMock.mockResolvedValueOnce(json({ default_drive_id: 'drive' }))
      .mockResolvedValueOnce(json({ data: { items: [] } }))
      .mockResolvedValueOnce(json({ personal: { total_size: 999 } }))
    await expect(aliyunAdapter.listFiles(account(), '0')).rejects.toThrow('items')
    await expect(aliyunAdapter.getQuota!(account())).rejects.toThrow('personal_space_info')
  })

  it('rejects a repeated pagination marker instead of looping forever', async () => {
    fetchMock.mockResolvedValueOnce(json({ default_drive_id: 'drive' }))
      .mockResolvedValueOnce(json({ items: [], next_marker: 'repeat' }))
      .mockResolvedValueOnce(json({ items: [], next_marker: 'repeat' }))
    await expect(aliyunAdapter.listFiles(account(), '0')).rejects.toThrow('重复分页')
  })

  it('checks a working access token without requiring application secrets', async () => {
    fetchMock.mockResolvedValueOnce(json({ default_drive_id: 'drive' }))
    expect(await aliyunAdapter.checkLogin(account({ accessToken: 'still-valid' }))).toBe(true)
    expect(settingsMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes a string-coded expired token once with the matching app settings and saves rotation', async () => {
    settingsMock.mockImplementation((key: string) => ({ value: key === 'aliyunClientId' ? 'test-client' : 'test-secret', encrypted: true }))
    const saved = vi.fn()
    setAliyunCredentialRefreshHandler(saved)
    const user = account()
    fetchMock.mockResolvedValueOnce(json({ code: 'AccessTokenExpired', message: 'expired' }, 400))
      .mockResolvedValueOnce(json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 7200 }))
      .mockResolvedValueOnce(json({ default_drive_id: 'drive', name: 'Alice' }))
    expect((await aliyunAdapter.getUserInfo(user)).nickname).toBe('Alice')
    expect(fetchMock.mock.calls[1][0]).toBe(API + '/oauth/access_token')
    expect(bodyAt(1)).toEqual({ grant_type: 'refresh_token', refresh_token: 'test-refresh', client_id: 'test-client', client_secret: 'test-secret' })
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer new-access')
    expect(saved).toHaveBeenCalledWith(user.id, expect.objectContaining({ accessToken: 'new-access', refreshToken: 'new-refresh' }))
  })

  it('does not invent secret-free refresh or contact a third-party renewal service', async () => {
    await expect(refreshAliyunToken(account({ refreshToken: 'public-tool-token' }))).rejects.toThrow('签发该令牌')
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValueOnce(json({ code: 'AccessTokenInvalid' }, 401))
    await expect(aliyunAdapter.getUserInfo(account())).rejects.toThrow('签发该令牌')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('can initialize a refresh-only account when the correct application credentials are configured', async () => {
    settingsMock.mockImplementation((key: string) => ({ value: key, encrypted: false }))
    fetchMock.mockResolvedValueOnce(json({ access_token: 'initialized', refresh_token: 'rotated' }))
      .mockResolvedValueOnce(json({ default_drive_id: 'drive' }))
    expect(await aliyunAdapter.checkLogin(account({ refreshToken: 'refresh-only' }))).toBe(true)
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer initialized')
  })

  it('stops after one refresh and reports a repeated authentication failure', async () => {
    settingsMock.mockReturnValue({ value: 'configured', encrypted: false })
    fetchMock.mockResolvedValueOnce(json({ code: 'AccessTokenExpired' }, 401))
      .mockResolvedValueOnce(json({ access_token: 'still-invalid' }))
      .mockResolvedValueOnce(json({ code: 'AccessTokenInvalid' }, 401))
    await expect(aliyunAdapter.getUserInfo(account())).rejects.toThrow('AccessTokenInvalid')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('exchanges an authorization code against the official host with the application credentials', async () => {
    settingsMock.mockReturnValue({ value: 'configured', encrypted: false })
    fetchMock.mockResolvedValueOnce(json({ access_token: 'authorized', refresh_token: 'refresh' }))
    expect((await exchangeAliyunCode(' code ')).access_token).toBe('authorized')
    expect(fetchMock.mock.calls[0][0]).toBe(API + '/oauth/access_token')
    expect(bodyAt(0)).toMatchObject({ grant_type: 'authorization_code', code: 'code', client_id: 'configured', client_secret: 'configured' })
  })

  describe.each(['exchange', 'refresh'] as const)('%s token response validation', (operation) => {
    it.each([
      ['null', 'null', '无效的 JSON 对象'],
      ['non-JSON', '<html>gateway response</html>', '无效的 JSON 对象'],
      ['array', '[]', '无效的 JSON 对象'],
      ['missing access token', '{}', '有效的 Access Token'],
      ['wrong token type', '{"access_token":123}', '有效的 Access Token'],
    ])('rejects %s with a useful error and preserves the existing credential', async (_case, payload, message) => {
      settingsMock.mockReturnValue({ value: 'configured', encrypted: false })
      fetchMock.mockResolvedValueOnce(new Response(payload, { status: 200 }))
      const user = account()
      const initialCredential = { ...user.credential }
      const saved = vi.fn()
      setAliyunCredentialRefreshHandler(saved)
      const result = operation === 'exchange' ? exchangeAliyunCode('code') : refreshAliyunToken(user)
      await expect(result).rejects.toThrow(message)
      expect(user.credential).toEqual(initialCredential)
      expect(saved).not.toHaveBeenCalled()
    })
  })

  it('directs an account without a refresh token back to authorization through the same application', async () => {
    await expect(refreshAliyunToken(account({ accessToken: 'expired' }))).rejects.toThrow('重新通过同一应用授权')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('Aliyun OpenAPI file operations', () => {
  it('uses verified create/update/move/copy/delete paths and native request fields', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === API + DRIVE) return json({ default_drive_id: 'drive' })
      if (url === API + OPEN + 'create') return json({ file_id: 'folder-id' })
      if ([API + OPEN + 'update', API + OPEN + 'move', API + OPEN + 'copy'].includes(url)) return json({ file_id: 'file-id' })
      if (url === API + OPEN + 'delete') return new Response(null, { status: 204 })
      throw new Error(`Unexpected URL: ${url}`)
    })
    const user = account()
    expect((await aliyunAdapter.mkdir(user, '0', 'folder')).id).toBe('folder-id')
    await aliyunAdapter.rename(user, 'file-id', 'new-name')
    await aliyunAdapter.move(user, ['file-id'], '0')
    await aliyunAdapter.copy!(user, ['file-id'], 'destination')
    await aliyunAdapter.delete(user, ['file-id'])
    expect(bodyAt(5)).toEqual({ drive_id: 'drive', file_id: 'file-id', to_parent_file_id: 'root' })
    expect(bodyAt(7)).toEqual({ drive_id: 'drive', file_id: 'file-id', to_parent_file_id: 'destination', auto_rename: true })
  })

  it('searches through paginated folders using the validated list API', async () => {
    fetchMock.mockResolvedValueOnce(json({ default_drive_id: 'drive' }))
      .mockResolvedValueOnce(json({ items: [{ file_id: 'folder', name: 'Documents', type: 'folder' }] }))
      .mockResolvedValueOnce(json({ items: [{ file_id: 'file', name: 'Report.txt', type: 'file' }] }))
    expect((await aliyunAdapter.searchFiles(account(), 'report')).map((file) => file.id)).toEqual(['file'])
    expect(bodyAt(2).parent_file_id).toBe('folder')
    expect(fetchMock.mock.calls.slice(1).every(([url]) => url === API + OPEN + 'list')).toBe(true)
  })

  it('fails a search exceeding its page budget instead of silently returning partial matches', async () => {
    let page = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (url === API + DRIVE) return json({ default_drive_id: 'drive' })
      return json({ items: [], next_marker: String(++page) })
    })
    await expect(aliyunAdapter.searchFiles(account(), 'report')).rejects.toThrow('无法返回完整结果')
    expect(fetchMock).toHaveBeenCalledTimes(1001)
  })

  it('downloads real streamed bytes via getDownloadUrl without leaking the bearer token to the signed URL', async () => {
    const dir = await tempDir()
    fetchMock.mockResolvedValueOnce(json({ default_drive_id: 'drive' }))
      .mockResolvedValueOnce(json({ url: 'https://storage.example.test/signed-download' }))
      .mockResolvedValueOnce(new Response('real file bytes', { headers: { 'content-length': '15' } }))
    const result = await aliyunAdapter.download!(account(), 'file', dir, { fileName: 'report.txt' })
    expect(await readFile(result.localPath!, 'utf8')).toBe('real file bytes')
    expect(fetchMock.mock.calls[1][0]).toBe(API + OPEN + 'getDownloadUrl')
    expect(fetchMock.mock.calls[2][1].headers).toBeUndefined()
  })

  it('uploads exact multipart bytes and requires complete confirmation, without the broken hash/file-handle handshake', async () => {
    const dir = await tempDir()
    const input = path.join(dir, 'multipart.bin')
    const bytes = Buffer.alloc(16 * 1024 * 1024 + 7, 0x5a)
    await writeFile(input, bytes)
    fetchMock.mockResolvedValueOnce(json({ default_drive_id: 'drive' }))
      .mockResolvedValueOnce(json({ file_id: 'uploaded', upload_id: 'upload', file_name: 'multipart (1).bin', part_info_list: [
        { part_number: 2, upload_url: 'https://storage.example.test/part-2' },
        { part_number: 1, upload_url: 'https://storage.example.test/part-1' },
      ] }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(json({ file_id: 'uploaded' }))
    const result = await aliyunAdapter.upload!(account(), input, '0')
    expect(result).toMatchObject({ success: true, fileId: 'uploaded', fileName: 'multipart (1).bin', fileSize: bytes.length })
    expect(bodyAt(1)).toMatchObject({ size: bytes.length, parent_file_id: 'root', part_info_list: [{ part_number: 1 }, { part_number: 2 }] })
    expect(bodyAt(1)).not.toHaveProperty('pre_hash')
    expect(bodyAt(1)).not.toHaveProperty('content_hash')
    expect(Buffer.concat([fetchMock.mock.calls[2][1].body, fetchMock.mock.calls[3][1].body]).equals(bytes)).toBe(true)
    expect(fetchMock.mock.calls[2][1].headers).toEqual({ 'Content-Length': String(16 * 1024 * 1024) })
    expect(fetchMock.mock.calls[4][0]).toBe(API + OPEN + 'complete')
    expect(bodyAt(4)).toEqual({ drive_id: 'drive', file_id: 'uploaded', upload_id: 'upload' })
  })

  it.each([
    [{ rapid_upload: true }, 'file_id'],
    [{ file_id: 'f', exist: true }, '同名文件'],
    [{ file_id: 'f', upload_id: 'u', part_info_list: [] }, '完整分片'],
    [{ file_id: 'f', upload_id: 'u', part_info_list: [{ part_number: 2, upload_url: 'https://storage.example.test/part' }] }, '分片编号'],
  ])('rejects an unconfirmed or incomplete create result: %j', async (created, error) => {
    const dir = await tempDir()
    const input = path.join(dir, 'file.txt')
    await writeFile(input, 'content')
    fetchMock.mockResolvedValueOnce(json({ default_drive_id: 'drive' })).mockResolvedValueOnce(json(created))
    await expect(aliyunAdapter.upload!(account(), input, '0')).rejects.toThrow(error)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('accepts an explicit rapid_upload confirmation with a file ID', async () => {
    const dir = await tempDir()
    const input = path.join(dir, 'file.txt')
    await writeFile(input, 'content')
    fetchMock.mockResolvedValueOnce(json({ default_drive_id: 'drive' }))
      .mockResolvedValueOnce(json({ file_id: 'rapid-file', rapid_upload: true }))
    await expect(aliyunAdapter.upload!(account(), input, '0')).resolves.toMatchObject({ success: true, fileId: 'rapid-file' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('completes a zero-byte file without inventing a non-empty upload part', async () => {
    const dir = await tempDir()
    const input = path.join(dir, 'empty.txt')
    await writeFile(input, '')
    fetchMock.mockResolvedValueOnce(json({ default_drive_id: 'drive' }))
      .mockResolvedValueOnce(json({ file_id: 'empty', upload_id: 'u', part_info_list: [] }))
      .mockResolvedValueOnce(json({ file_id: 'empty' }))
    await expect(aliyunAdapter.upload!(account(), input, '0')).resolves.toMatchObject({ success: true, fileSize: 0 })
    expect(bodyAt(1).part_info_list).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('allows ten minutes per data part but never reports 100% if completion fails', async () => {
    const dir = await tempDir()
    const input = path.join(dir, 'file.txt')
    await writeFile(input, 'content')
    const progress = vi.fn()
    fetchMock.mockResolvedValueOnce(json({ default_drive_id: 'drive' }))
      .mockResolvedValueOnce(json({ file_id: 'file', upload_id: 'u', part_info_list: [{ part_number: 1, upload_url: 'https://storage.example.test/part' }] }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(json({}))
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      await expect(aliyunAdapter.upload!(account(), input, '0', { onProgress: progress })).rejects.toThrow('未确认对应 file_id')
      expect(progress.mock.calls.map(([value]) => value.percent)).toEqual([99])
      expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([30_000, 30_000, 600_000, 30_000])
    } finally {
      timeout.mockRestore()
    }
  })

  it.each(['drive', 'create', 'complete'] as const)('honors cancellation during %s and does not continue or report success', async (stage) => {
    const dir = await tempDir()
    const input = path.join(dir, 'empty.txt')
    await writeFile(input, '')
    const controller = new AbortController()
    const cancelled = new Error(`cancelled during ${stage}`)
    const progress = vi.fn()
    fetchMock.mockImplementation(async (url: string, init: { signal: AbortSignal }) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect(init.signal.aborted).toBe(false)
      if (url === API + DRIVE) {
        if (stage === 'drive') controller.abort(cancelled)
        return json({ default_drive_id: 'drive' })
      }
      if (url === API + OPEN + 'create') {
        if (stage === 'create') {
          controller.abort(cancelled)
          return json({ file_id: 'rapid', rapid_upload: true })
        }
        return json({ file_id: 'empty', upload_id: 'u', part_info_list: [] })
      }
      if (url === API + OPEN + 'complete') {
        controller.abort(cancelled)
        return json({ file_id: 'empty' })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    await expect(aliyunAdapter.upload!(account(), input, '0', { signal: controller.signal, onProgress: progress })).rejects.toThrow(cancelled)
    expect(fetchMock).toHaveBeenCalledTimes({ drive: 1, create: 2, complete: 3 }[stage])
    expect(progress).not.toHaveBeenCalled()
  })

  it('propagates upload cancellation through token refresh without persisting a cancelled response', async () => {
    const dir = await tempDir()
    const input = path.join(dir, 'empty.txt')
    await writeFile(input, '')
    settingsMock.mockReturnValue({ value: 'configured', encrypted: false })
    const controller = new AbortController()
    const saved = vi.fn()
    setAliyunCredentialRefreshHandler(saved)
    fetchMock.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
      controller.abort(new Error('cancelled refresh'))
      expect(init.signal.aborted).toBe(true)
      return json({ access_token: 'new-access', refresh_token: 'new-refresh' })
    })
    const user = account({ refreshToken: 'original-refresh' })
    await expect(aliyunAdapter.upload!(user, input, '0', { signal: controller.signal })).rejects.toThrow('cancelled refresh')
    expect(user.credential).toEqual({ refreshToken: 'original-refresh' })
    expect(saved).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
