import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BasePanAdapter, type PanApiConfig, type PanApiResponse } from './base-pan'
import type { DriveAdapter } from './base'
import { getAdapter, getSupportedPlatforms } from './registry'
import { fatal, isPermanentError, isRetryable, retryable, PanError } from './errors'
import type {
  DriveAccount,
  DownloadOptions,
  DownloadResult,
  FileItem,
  FileListResult,
  UploadOptions,
  UploadResult,
} from '../shared/types'

/**
 * The contract tests deliberately use a provider-independent in-memory
 * adapter.  Real adapters have different HTTP clients and response formats,
 * but the task runner only sees the DriveAdapter interface.  Keeping this
 * fixture deterministic lets us exercise that interface without credentials,
 * Electron sessions, or network access.
 */

const PLATFORM = 'quark' as const
const ACCOUNT_ID = 'contract-account'
const NOW = 1_700_000_000_000

type Operation =
  | 'checkLogin'
  | 'listFiles'
  | 'searchFiles'
  | 'mkdir'
  | 'rename'
  | 'move'
  | 'delete'
  | 'getDownloadUrl'
  | 'download'
  | 'upload'

interface MemoryAdapterState {
  files: Map<string, FileItem>
  contents: Map<string, Buffer>
  pageSize: number
  loggedIn: boolean
  transientFailures: Partial<Record<Operation, number>>
  attempts: Record<Operation, number>
  listPages: Array<{ parentId: string; page: number }>
  searchPages: Array<{ keyword: string; page: number }>
  downloadUrlCalls: string[]
  downloadedPaths: string[]
}

interface MemoryAdapterOptions {
  files?: FileItem[]
  contents?: Record<string, string | Uint8Array>
  pageSize?: number
  loggedIn?: boolean
  transientFailures?: Partial<Record<Operation, number>>
}

interface MemoryAdapterFixture {
  adapter: DriveAdapter
  state: MemoryAdapterState
}

function createAccount(overrides: Partial<DriveAccount> = {}): DriveAccount {
  return {
    id: ACCOUNT_ID,
    platform: PLATFORM,
    nickname: '契约测试账号',
    loginType: 'token',
    credential: { accessToken: 'memory-token' },
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function createFile(
  id: string,
  name: string,
  parentId = '0',
  isDir = false,
  accountId = ACCOUNT_ID,
): FileItem {
  return {
    id,
    parentId,
    name,
    isDir,
    size: isDir ? 0 : 12,
    createdAt: NOW,
    updatedAt: NOW,
    platform: PLATFORM,
    accountId,
  }
}

function abortError(): Error {
  const error = new Error('操作已取消')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function safeFileName(name: string): string {
  const candidate = path.basename(name.replace(/\\/g, '/'))
  return candidate && candidate !== '.' && candidate !== '..' ? candidate : 'download.bin'
}

function createMemoryAdapter(options: MemoryAdapterOptions = {}): MemoryAdapterFixture {
  const initialFiles = options.files?.length
    ? options.files
    : [
        createFile('folder-1', '资料', '0', true),
        createFile('file-1', '报告.txt'),
        createFile('file-2', '照片.jpg'),
        createFile('file-3', '报告-副本.txt'),
        createFile('file-4', '说明.md'),
        createFile('file-5', '演示.pptx'),
      ]

  const state: MemoryAdapterState = {
    files: new Map(initialFiles.map((file) => [file.id, structuredClone(file)])),
    contents: new Map(Object.entries(options.contents || {}).map(([id, value]) => [
      id,
      Buffer.from(value),
    ])),
    pageSize: Math.max(1, options.pageSize ?? 2),
    loggedIn: options.loggedIn ?? true,
    transientFailures: { ...(options.transientFailures || {}) },
    attempts: {
      checkLogin: 0,
      listFiles: 0,
      searchFiles: 0,
      mkdir: 0,
      rename: 0,
      move: 0,
      delete: 0,
      getDownloadUrl: 0,
      download: 0,
      upload: 0,
    },
    listPages: [],
    searchPages: [],
    downloadUrlCalls: [],
    downloadedPaths: [],
  }

  const contentFor = (fileId: string): Buffer => {
    const content = state.contents.get(fileId)
    if (content) return Buffer.from(content)
    return Buffer.from(`content:${fileId}`)
  }

  /** Retry only errors explicitly marked retryable; permanent errors fail fast. */
  async function withRetry<T>(operation: Operation, action: () => Promise<T> | T, maxRetries = 2): Promise<T> {
    let retries = 0
    for (;;) {
      state.attempts[operation] += 1
      try {
        const remaining = state.transientFailures[operation] || 0
        if (remaining > 0) {
          state.transientFailures[operation] = remaining - 1
          throw retryable('临时网络错误', { platform: PLATFORM, action: operation })
        }
        return await action()
      } catch (error) {
        if (!isRetryable(error) || retries >= maxRetries) throw error
        retries += 1
        // A microtask is enough to model an asynchronous retry without making
        // the test suite depend on wall-clock timers.
        await Promise.resolve()
      }
    }
  }

  const findFile = (fileId: string): FileItem => {
    const file = state.files.get(fileId)
    if (!file) {
      throw fatal('文件不存在', { code: 'NOT_FOUND', platform: PLATFORM, action: '文件操作' })
    }
    return file
  }

  const listChildren = (parentId: string): FileItem[] => [...state.files.values()]
    .filter((file) => file.parentId === parentId)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((file) => structuredClone(file))

  const adapter: DriveAdapter = {
    async checkLogin(): Promise<boolean> {
      return withRetry('checkLogin', () => state.loggedIn)
    },

    async getUserInfo(): Promise<{ nickname: string; avatar?: string }> {
      return withRetry('checkLogin', () => {
        if (!state.loggedIn) {
          throw fatal('登录已失效', { code: 'AUTH_EXPIRED', platform: PLATFORM, action: '获取用户信息' })
        }
        return { nickname: '内存用户', avatar: 'memory://avatar' }
      })
    },

    async listFiles(_account: DriveAccount, parentId: string): Promise<FileListResult> {
      const children = listChildren(parentId)
      const files: FileItem[] = []
      let page = 0
      for (;;) {
        const currentPage = page
        const rows = await withRetry('listFiles', () => {
          state.listPages.push({ parentId, page: currentPage })
          const start = currentPage * state.pageSize
          return children.slice(start, start + state.pageSize)
        })
        files.push(...rows)
        if (rows.length < state.pageSize || files.length >= children.length) break
        page += 1
      }
      // DriveAdapter promises an auto-paged result, so callers never need to
      // issue another request after this method resolves.
      return { files, parentId, hasMore: false }
    },

    async searchFiles(_account: DriveAccount, keyword: string): Promise<FileItem[]> {
      const normalized = keyword.trim().toLocaleLowerCase()
      const matches = [...state.files.values()]
        .filter((file) => file.name.toLocaleLowerCase().includes(normalized))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((file) => structuredClone(file))
      const files: FileItem[] = []
      let page = 0
      for (;;) {
        const currentPage = page
        const rows = await withRetry('searchFiles', () => {
          state.searchPages.push({ keyword, page: currentPage })
          const start = currentPage * state.pageSize
          return matches.slice(start, start + state.pageSize)
        })
        files.push(...rows)
        if (rows.length < state.pageSize || files.length >= matches.length) break
        page += 1
      }
      return files
    },

    async mkdir(_account: DriveAccount, parentId: string, name: string): Promise<FileItem> {
      return withRetry('mkdir', () => {
        if (parentId !== '0' && !state.files.get(parentId)?.isDir) {
          throw fatal('目标目录不存在', { code: 'NOT_FOUND', platform: PLATFORM, action: '创建目录' })
        }
        const id = `folder-${state.files.size + 1}`
        const folder = createFile(id, name.trim(), parentId, true)
        state.files.set(id, folder)
        return structuredClone(folder)
      })
    },

    async rename(_account: DriveAccount, fileId: string, newName: string): Promise<void> {
      await withRetry('rename', () => {
        const file = findFile(fileId)
        if (!newName.trim()) {
          throw fatal('文件名不能为空', { code: 'INVALID_NAME', platform: PLATFORM, action: '重命名' })
        }
        file.name = newName.trim()
        file.updatedAt = Date.now()
      })
    },

    async move(_account: DriveAccount, fileIds: string[], targetDirId: string): Promise<void> {
      await withRetry('move', () => {
        if (targetDirId !== '0' && !state.files.get(targetDirId)?.isDir) {
          throw fatal('目标目录不存在', { code: 'NOT_FOUND', platform: PLATFORM, action: '移动' })
        }
        fileIds.forEach((fileId) => {
          const file = findFile(fileId)
          file.parentId = targetDirId
          file.updatedAt = Date.now()
        })
      })
    },

    async delete(_account: DriveAccount, fileIds: string[]): Promise<void> {
      await withRetry('delete', () => {
        fileIds.forEach((fileId) => {
          findFile(fileId)
          state.files.delete(fileId)
          state.contents.delete(fileId)
        })
      })
    },

    async getDownloadUrl(_account: DriveAccount, fileId: string): Promise<string> {
      return withRetry('getDownloadUrl', () => {
        findFile(fileId)
        state.downloadUrlCalls.push(fileId)
        return `memory://${fileId}`
      })
    },

    async download(
      account: DriveAccount,
      fileId: string,
      localDirPath: string,
      options?: DownloadOptions,
    ): Promise<DownloadResult> {
      throwIfAborted(options?.signal)
      const file = findFile(fileId)
      if (file.isDir) throw fatal('目录不能下载', { code: 'IS_DIRECTORY', platform: PLATFORM, action: '下载' })
      await adapter.getDownloadUrl!(account, fileId)
      const data = contentFor(fileId)
      const fileName = safeFileName(options?.fileName || file.name)
      const targetPath = path.join(localDirPath, fileName)
      const chunkSize = Math.max(1, Math.ceil(data.length / 3))
      let loaded = 0
      const chunks: Buffer[] = []

      // Count download attempts separately so a cancellation is observable as
      // a terminal outcome rather than a retryable transport failure.
      state.attempts.download += 1
      while (loaded < data.length || (data.length === 0 && chunks.length === 0)) {
        throwIfAborted(options?.signal)
        const chunk = data.subarray(loaded, Math.min(data.length, loaded + chunkSize))
        chunks.push(chunk)
        loaded += chunk.length
        options?.onProgress?.({
          loaded,
          total: data.length,
          percent: data.length ? Math.round((loaded / data.length) * 100) : 100,
          speed: 0,
        })
        await Promise.resolve()
        throwIfAborted(options?.signal)
        if (data.length === 0) break
      }
      throwIfAborted(options?.signal)
      await (await import('node:fs/promises')).mkdir(localDirPath, { recursive: true })
      await writeFile(targetPath, Buffer.concat(chunks))
      state.downloadedPaths.push(targetPath)
      return { success: true, localPath: targetPath, fileName, fileSize: data.length }
    },

    async upload(
      _account: DriveAccount,
      localFilePath: string,
      targetDirId: string,
      options?: UploadOptions,
    ): Promise<UploadResult> {
      throwIfAborted(options?.signal)
      if (targetDirId !== '0' && !state.files.get(targetDirId)?.isDir) {
        throw fatal('目标目录不存在', { code: 'NOT_FOUND', platform: PLATFORM, action: '上传' })
      }
      state.attempts.upload += 1
      const data = await readFile(localFilePath)
      throwIfAborted(options?.signal)
      const fileName = safeFileName(options?.fileName || path.basename(localFilePath))
      const id = `upload-${state.files.size + 1}`
      const file = createFile(id, fileName, targetDirId, false)
      file.size = data.length
      state.files.set(id, file)
      state.contents.set(id, Buffer.from(data))
      options?.onProgress?.({ loaded: data.length, total: data.length, percent: 100, speed: 0 })
      return { success: true, fileId: id, fileName, fileSize: data.length }
    },
  }

  return { adapter, state }
}

function expectFileItemShape(item: FileItem): void {
  expect(item).toEqual(expect.objectContaining({
    id: expect.any(String),
    parentId: expect.any(String),
    name: expect.any(String),
    isDir: expect.any(Boolean),
    size: expect.any(Number),
    createdAt: expect.any(Number),
    updatedAt: expect.any(Number),
    platform: expect.any(String),
    accountId: expect.any(String),
  }))
}

/**
 * A no-network harness for the shared Quark/UC base implementation.  The
 * concrete adapters supply HTTP in production; replacing request/delay here
 * verifies that the common paging and task-polling machinery keeps its
 * documented semantics independently of either provider.
 */
class HarnessPanAdapter extends BasePanAdapter {
  readonly requests: string[] = []

  constructor(private readonly responses: Array<PanApiResponse<unknown>>) {
    const config: PanApiConfig = {
      platform: 'harness',
      apiBase: 'https://harness.invalid',
      sessionPartition: 'persist:harness',
      cookieDomain: 'harness.invalid',
      origin: 'https://harness.invalid',
      referer: 'https://harness.invalid/',
      userAgent: 'PanLite-contract-test',
      commonParams: {},
    }
    super(config)
  }

  async exposeFetchAllPages(pageSize = 2): Promise<unknown[]> {
    return this.fetchAllPages<{ items: unknown[] }>(
      'https://harness.invalid/items',
      'cookie=fixture',
      (data) => data.items,
      pageSize,
      10,
    )
  }

  async exposePollTask(maxRetries = 3): Promise<{ status: number; shareId?: string; savedFileIds?: string[] }> {
    return this.pollTask('task-1', 'cookie=fixture', maxRetries)
  }

  protected override async request<T>(url: string): Promise<PanApiResponse<T>> {
    this.requests.push(url)
    const response = this.responses.shift()
    if (!response) throw new Error('harness response queue exhausted')
    return response as PanApiResponse<T>
  }

  protected override delay(): Promise<void> {
    return Promise.resolve()
  }

  async checkLogin(): Promise<boolean> { return true }
  async getUserInfo(): Promise<{ nickname: string; avatar?: string }> { return { nickname: 'harness' } }
  async listFiles(): Promise<FileListResult> { return { files: [], parentId: '0', hasMore: false } }
  async searchFiles(): Promise<FileItem[]> { return [] }
  async mkdir(): Promise<FileItem> { return createFile('harness-folder', 'harness', '0', true) }
  async rename(): Promise<void> { return undefined }
  async move(): Promise<void> { return undefined }
  async delete(): Promise<void> { return undefined }
}

const requiredMethods = [
  'checkLogin',
  'getUserInfo',
  'listFiles',
  'searchFiles',
  'mkdir',
  'rename',
  'move',
  'delete',
] as const

const optionalMethods = [
  'getQuota',
  'getMembership',
  'copy',
  'createShare',
  'cancelShare',
  'parseShareLink',
  'getShareDetail',
  'saveSharedFiles',
  'upload',
  'getDownloadUrl',
  'download',
] as const

describe('DriveAdapter registry contract', () => {
  const expectedPlatforms = ['quark', 'baidu', 'uc', 'xunlei', 'webdav', 'aliyun', 'pan123', 'aliyun_web']

  it('registers every supported platform exactly once', () => {
    const platforms = getSupportedPlatforms()
    expect(new Set(platforms).size).toBe(platforms.length)
    expect(new Set(platforms)).toEqual(new Set(expectedPlatforms))
  })

  it.each(expectedPlatforms)('%s exposes every required DriveAdapter method', (platform) => {
    const adapter = getAdapter(platform)
    for (const method of requiredMethods) {
      expect(typeof adapter[method], `${platform}.${method}`).toBe('function')
    }
    for (const method of optionalMethods) {
      const value = adapter[method]
      if (value !== undefined) expect(typeof value, `${platform}.${method}`).toBe('function')
    }
    // A downloader needs a way to resolve a remote URL as well; this catches
    // partial implementations that would fail in the task runner's chunked
    // transfer path.
    if (adapter.download) expect(typeof adapter.getDownloadUrl).toBe('function')
  })

  it('returns the same adapter instance and gives an actionable unknown-platform error', () => {
    expect(getAdapter('quark')).toBe(getAdapter('quark'))
    expect(() => getAdapter('not-a-platform')).toThrow(/Unknown platform: "not-a-platform"/)
  })

  it.each(['quark', 'baidu', 'uc', 'xunlei', 'aliyun_web'])('%s can cancel shares created by PanLite', (platform) => {
    expect(typeof getAdapter(platform).cancelShare).toBe('function')
  })

  it('keeps the shared Pan adapter paging and task-polling helpers deterministic', async () => {
    const paging = new HarnessPanAdapter([
      { status: 200, code: 0, message: '', data: { items: ['a', 'b'] } },
      { status: 200, code: 0, message: '', data: { items: ['c'] } },
    ])
    await expect(paging.exposeFetchAllPages(2)).resolves.toEqual(['a', 'b', 'c'])
    expect(paging.requests).toEqual([
      'https://harness.invalid/items&_page=1&_size=2',
      'https://harness.invalid/items&_page=2&_size=2',
    ])

    const polling = new HarnessPanAdapter([
      { status: 200, code: 0, message: '', data: { status: 1 } },
      { status: 200, code: 0, message: '', data: { status: 2, share_id: 'share-1', save_as: { save_as_top_fids: ['f-1'] } } },
    ])
    await expect(polling.exposePollTask()).resolves.toEqual({
      status: 2,
      shareId: 'share-1',
      savedFileIds: ['f-1'],
    })
    expect(polling.requests).toHaveLength(2)
  })

  it('maps shared Pan adapter task errors and bounded polling timeout', async () => {
    const capacity = new HarnessPanAdapter([
      { status: 200, code: 32003, message: 'full', data: { status: 0 } },
    ])
    await expect(capacity.exposePollTask()).rejects.toMatchObject({
      name: 'PanError',
      message: '容量不足',
      retryable: false,
    })

    const timeout = new HarnessPanAdapter([
      { status: 200, code: 0, message: '', data: { status: 1 } },
      { status: 200, code: 0, message: '', data: { status: 1 } },
    ])
    await expect(timeout.exposePollTask(2)).rejects.toMatchObject({
      name: 'PanError',
      retryable: true,
    })
  })
})

describe('DriveAdapter in-memory behavioral contract', () => {
  const roots: string[] = []
  const account = createAccount()

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('returns stable login, user, list, search, and mutation result shapes', async () => {
    const { adapter } = createMemoryAdapter({ pageSize: 2 })

    await expect(adapter.checkLogin(account)).resolves.toBe(true)
    await expect(adapter.getUserInfo(account)).resolves.toEqual({ nickname: expect.any(String), avatar: expect.any(String) })

    const listed = await adapter.listFiles(account, '0')
    expect(listed).toMatchObject({ parentId: '0', hasMore: false })
    expect(Array.isArray(listed.files)).toBe(true)
    listed.files.forEach(expectFileItemShape)

    const searched = await adapter.searchFiles(account, '报告')
    expect(searched.map((file) => file.name)).toEqual(['报告.txt', '报告-副本.txt'])
    searched.forEach(expectFileItemShape)

    const folder = await adapter.mkdir(account, '0', '新目录')
    expectFileItemShape(folder)
    expect(folder.isDir).toBe(true)
    await expect(adapter.rename(account, folder.id, '新目录-重命名')).resolves.toBeUndefined()
    await expect(adapter.move(account, ['file-1'], folder.id)).resolves.toBeUndefined()
    const nested = await adapter.listFiles(account, folder.id)
    expect(nested.files.map((file) => file.id)).toContain('file-1')
    await expect(adapter.delete(account, ['file-1'])).resolves.toBeUndefined()
  })

  it('auto-pages list and search results and retries transient transport failures', async () => {
    const { adapter, state } = createMemoryAdapter({
      pageSize: 2,
      transientFailures: { listFiles: 1, searchFiles: 1 },
    })

    const listed = await adapter.listFiles(account, '0')
    expect(listed.files).toHaveLength(6)
    expect(listed.hasMore).toBe(false)
    expect(state.attempts.listFiles).toBe(4) // one retry + three pages
    expect(state.listPages.map((request) => request.page)).toEqual([0, 1, 2])

    const searched = await adapter.searchFiles(account, '报告')
    expect(searched).toHaveLength(2)
    expect(state.attempts.searchFiles).toBe(2) // one retry + one page
    expect(state.searchPages.map((request) => request.page)).toEqual([0])
  })

  it('maps permanent errors without retrying and preserves retryable error metadata', async () => {
    const { adapter, state } = createMemoryAdapter({
      transientFailures: { delete: 10 },
    })

    await expect(adapter.mkdir(account, 'missing-parent', '不会创建')).rejects.toMatchObject({
      name: 'PanError',
      code: 'NOT_FOUND',
      platform: PLATFORM,
      action: '创建目录',
      retryable: false,
    })
    expect(state.attempts.mkdir).toBe(1)

    await expect(adapter.delete(account, ['file-1'])).rejects.toMatchObject({
      name: 'PanError',
      retryable: true,
      level: 'warn',
    })
    expect(state.attempts.delete).toBe(3) // initial attempt + two bounded retries
    expect(isRetryable(retryable('network timeout'))).toBe(true)
    expect(isPermanentError(fatal('登录已失效'))).toBe(true)
    expect(isPermanentError(new PanError({ message: 'not permanent', retryable: true }))).toBe(false)
  })

  it('returns a download result, writes bytes, reports progress, and honors pre-abort', async () => {
    const { adapter, state } = createMemoryAdapter({ contents: { 'file-1': '契约下载内容' } })
    const root = await mkdtemp(path.join(os.tmpdir(), 'panlite-adapter-contract-'))
    roots.push(root)
    const progress: number[] = []
    const result = await adapter.download!(account, 'file-1', root, {
      fileName: 'nested\\safe.txt',
      onProgress: (event) => progress.push(event.percent),
    })

    expect(result).toMatchObject({ success: true, fileName: 'safe.txt', fileSize: Buffer.byteLength('契约下载内容') })
    expect(result.localPath).toBe(path.join(root, 'safe.txt'))
    expect(await readFile(result.localPath!, 'utf8')).toBe('契约下载内容')
    expect(progress[progress.length - 1]).toBe(100)
    expect(state.downloadUrlCalls).toEqual(['file-1'])
    expect(state.downloadedPaths).toEqual([result.localPath])

    const controller = new AbortController()
    controller.abort()
    await expect(adapter.download!(account, 'file-1', root, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(state.downloadUrlCalls).toEqual(['file-1'])
  })

  it('cancels an in-flight download before committing a partial file', async () => {
    const { adapter } = createMemoryAdapter({ contents: { 'file-1': 'a'.repeat(100) } })
    const root = await mkdtemp(path.join(os.tmpdir(), 'panlite-adapter-contract-cancel-'))
    roots.push(root)
    const controller = new AbortController()
    const progress = vi.fn(() => controller.abort())

    await expect(adapter.download!(account, 'file-1', root, {
      fileName: 'cancelled.bin',
      signal: controller.signal,
      onProgress: progress,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(progress).toHaveBeenCalled()
    expect(existsSync(path.join(root, 'cancelled.bin'))).toBe(false)
  })

  it('keeps upload result and cancellation semantics aligned with download', async () => {
    const { adapter } = createMemoryAdapter()
    const root = await mkdtemp(path.join(os.tmpdir(), 'panlite-adapter-contract-upload-'))
    roots.push(root)
    const source = path.join(root, 'source.txt')
    await writeFile(source, 'upload payload')

    const progress: number[] = []
    const result = await adapter.upload!(account, source, '0', {
      onProgress: (event) => progress.push(event.percent),
      fileName: 'remote.txt',
    })
    expect(result).toMatchObject({ success: true, fileId: expect.any(String), fileName: 'remote.txt', fileSize: 14 })
    expect(progress).toEqual([100])

    const controller = new AbortController()
    controller.abort()
    await expect(adapter.upload!(account, source, '0', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})
