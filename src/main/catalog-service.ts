import type { FileItem, FileListResult, Platform } from '../shared/types'
import type { CatalogApi, CatalogEntry, CatalogFileType, CatalogQuery, CatalogRef, CatalogResult, CatalogScopeInput } from '../shared/catalog'
import { CatalogStore, type CatalogAccount, type CatalogCursor, type CatalogMetadata } from './catalog-store'

export interface CatalogDependencies {
  /** Must read current account metadata; credentials stay in the adapter integration. */
  getAccount(accountId: string): CatalogAccount | undefined
  listFiles(accountId: string, parentId: string): Promise<FileListResult>
  yieldControl?: () => Promise<void>
}
class CatalogInputError extends Error {}
const FILE_TYPES: CatalogFileType[] = ['folder', 'video', 'audio', 'image', 'document', 'archive', 'other']
const EXTENSIONS: Record<string, CatalogFileType> = Object.fromEntries(Object.entries({
  video: 'mp4 mkv avi mov wmv flv webm m4v ts mpeg mpg', audio: 'mp3 wav flac aac ogg wma m4a opus',
  image: 'jpg jpeg png gif bmp webp svg heic avif tif tiff', document: 'pdf doc docx xls xlsx ppt pptx txt md csv rtf odt epub',
  archive: 'zip rar 7z tar gz bz2 xz',
}).flatMap(([type, extensions]) => extensions.split(' ').map(extension => [extension, type as CatalogFileType])))

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CatalogInputError('参数格式不正确')
  return value as Record<string, unknown>
}
function string(value: unknown, label: string, max = 1024, empty = false): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (!empty && !value.trim())) throw new CatalogInputError(`${label}不正确`)
  return value
}
function number(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new CatalogInputError(`${label}不正确`)
  return value
}
function strings(value: unknown, label: string, maxItems = 100, maxLength = 256): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new CatalogInputError(`${label}不正确`)
  return [...new Set(value.map(item => string(item, label, maxLength).trim()))]
}
function ref(value: unknown): CatalogRef {
  const input = object(value)
  return { accountId: string(input.accountId, '账号', 256), fileId: string(input.fileId, '文件标识', 4096) }
}
function path(value: unknown): string {
  const result = string(value, '目录路径', 4096).replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/'
  if (!result.startsWith('/') || result.split('/').some(part => part === '.' || part === '..')) throw new CatalogInputError('目录路径不正确')
  return result
}
function query(value: unknown): CatalogQuery {
  const input = object(value), output: CatalogQuery = {}
  if (input.keyword !== undefined) output.keyword = string(input.keyword, '关键词', 256, true).trim()
  if (input.path !== undefined) output.path = string(input.path, '路径', 4096, true).trim()
  if (input.accountIds !== undefined) output.accountIds = strings(input.accountIds, '账号')
  if (input.scopeIds !== undefined) output.scopeIds = strings(input.scopeIds, '范围')
  if (input.tags !== undefined) output.tags = strings(input.tags, '标签', 30, 64)
  if (input.fileTypes !== undefined) {
    const types = strings(input.fileTypes, '文件类型', 7)
    if (types.some(type => !FILE_TYPES.includes(type as CatalogFileType))) throw new CatalogInputError('文件类型不正确')
    output.fileTypes = types as CatalogFileType[]
  }
  for (const key of ['minSize', 'maxSize', 'dateFrom', 'dateTo'] as const) if (input[key] !== undefined) output[key] = number(input[key], '大小或时间')
  if (output.minSize !== undefined && output.maxSize !== undefined && output.minSize > output.maxSize) throw new CatalogInputError('最小大小不能超过最大大小')
  if (output.dateFrom !== undefined && output.dateTo !== undefined && output.dateFrom > output.dateTo) throw new CatalogInputError('开始日期不能晚于结束日期')
  if (input.favorite !== undefined) {
    if (typeof input.favorite !== 'boolean') throw new CatalogInputError('收藏筛选不正确')
    output.favorite = input.favorite
  }
  if (input.collectionId !== undefined) output.collectionId = string(input.collectionId, '集合')
  if (input.page !== undefined) { output.page = number(input.page, '页码', 10_000_000); if (!output.page) throw new CatalogInputError('页码从 1 开始') }
  if (input.pageSize !== undefined) { output.pageSize = number(input.pageSize, '每页数量', 200); if (!output.pageSize) throw new CatalogInputError('每页数量至少为 1') }
  if (input.sortBy !== undefined) {
    if (!['name', 'path', 'size', 'updatedAt', 'indexedAt'].includes(input.sortBy as string)) throw new CatalogInputError('排序字段不正确')
    output.sortBy = input.sortBy as CatalogQuery['sortBy']
  }
  if (input.sortOrder !== undefined) {
    if (!['asc', 'desc'].includes(input.sortOrder as string)) throw new CatalogInputError('排序方向不正确')
    output.sortOrder = input.sortOrder as CatalogQuery['sortOrder']
  }
  return output
}

export class CatalogService implements CatalogApi {
  private disposed = false
  private worker: Promise<void> | undefined
  private readonly epochs = new Map<string, number>()
  private readonly interruptions = new Map<string, Set<() => void>>()
  private readonly yieldControl: () => Promise<void>

  constructor(readonly store: CatalogStore, private readonly dependencies: CatalogDependencies) {
    this.yieldControl = dependencies.yieldControl ?? (() => new Promise(resolve => setImmediate(resolve)))
  }
  private async result<T extends object>(operation: () => T | Promise<T>): Promise<CatalogResult<T>> {
    try {
      if (this.disposed) throw new CatalogInputError('文件目录服务已停止')
      return { success: true, ...await operation() }
    } catch (error) {
      // Adapter/SQLite exceptions may include credentials, URLs or SQL. Only our fixed validation text crosses IPC.
      return { success: false, error: error instanceof CatalogInputError ? error.message : '文件目录操作失败，请重试' }
    }
  }
  private account(accountId: string, active = false): CatalogAccount {
    const account = this.dependencies.getAccount(accountId)
    if (!account) throw new CatalogInputError('账号已删除或不存在')
    if (active && account.status !== 'active') throw new CatalogInputError('账号不可用，请重新登录后重试')
    this.store.upsertAccount(account)
    return account
  }
  private scopeId(value: unknown): string {
    const id = string(value, '扫描范围')
    if (!this.store.getScopeRow(id)) throw new CatalogInputError('扫描范围不存在')
    return id
  }
  private entry(value: unknown): CatalogEntry {
    const identity = ref(value), entry = this.store.getEntry(identity)
    if (!entry) throw new CatalogInputError('文件不在已索引范围内，请重新扫描')
    return entry
  }
  private invalidate(scopeId: string): void {
    this.epochs.set(scopeId, (this.epochs.get(scopeId) ?? 0) + 1)
    for (const interrupt of this.interruptions.get(scopeId) ?? []) interrupt()
  }
  private refreshEntry(entry: CatalogEntry): CatalogEntry {
    const account = this.dependencies.getAccount(entry.accountId)
    return { ...entry, accountNickname: account?.nickname ?? entry.accountNickname, accountStatus: account?.status ?? 'missing' }
  }
  listScopes: CatalogApi['listScopes'] = () => this.result(() => ({ scopes: this.store.listScopes().map(scope => {
    const account = this.dependencies.getAccount(scope.accountId)
    return { ...scope, accountNickname: account?.nickname ?? scope.accountNickname, accountStatus: account?.status ?? 'missing' }
  }) }))
  addScope: CatalogApi['addScope'] = input => this.result(() => {
    const value = object(input), scope: CatalogScopeInput = {
      accountId: string(value.accountId, '账号', 256), rootId: string(value.rootId, '目录标识', 4096), rootPath: path(value.rootPath),
    }
    this.account(scope.accountId)
    if (this.store.listScopes().length >= 100 && !this.store.listScopes().some(item => item.accountId === scope.accountId && item.rootId === scope.rootId)) throw new CatalogInputError('最多保存 100 个索引范围')
    return { scope: this.store.addScope(scope) }
  })
  removeScope: CatalogApi['removeScope'] = value => this.result(() => {
    const id = this.scopeId(value)
    this.invalidate(id); this.store.removeScope(id)
    return {}
  })
  startScan: CatalogApi['startScan'] = value => this.result(() => {
    const id = this.scopeId(value), scope = this.store.getScope(id)!
    this.account(scope.accountId, true)
    this.invalidate(id); this.store.startScan(id); this.kick()
    return { scope: this.store.getScope(id)! }
  })
  pauseScan: CatalogApi['pauseScan'] = value => this.result(() => {
    const id = this.scopeId(value)
    if (!['running', 'paused'].includes(this.store.getScopeRow(id)!.status)) throw new CatalogInputError('该范围没有正在进行的扫描')
    this.invalidate(id); this.store.pauseScan(id)
    return { scope: this.store.getScope(id)! }
  })
  resumeScan: CatalogApi['resumeScan'] = value => this.result(() => {
    const id = this.scopeId(value), scope = this.store.getScope(id)!
    if (!['paused', 'partial', 'error', 'running'].includes(scope.status)) throw new CatalogInputError('请开始新的扫描')
    this.account(scope.accountId, true)
    if (scope.status !== 'running') { this.invalidate(id); this.store.resumeScan(id) }
    this.kick()
    return { scope: this.store.getScope(id)! }
  })
  search: CatalogApi['search'] = value => this.result(() => {
    const page = this.store.search(query(value))
    return { ...page, entries: page.entries.map(entry => this.refreshEntry(entry)) }
  })
  listTags: CatalogApi['listTags'] = () => this.result(() => ({ tags: this.store.listTags() }))
  setTags: CatalogApi['setTags'] = value => this.result(() => {
    const entry = this.entry(value), labels = strings(object(value).tags, '标签', 30, 64)
    this.store.setTags(entry, labels)
    return {}
  })
  setFavorite: CatalogApi['setFavorite'] = value => this.result(() => {
    const entry = this.entry(value), favorite = object(value).favorite
    if (typeof favorite !== 'boolean') throw new CatalogInputError('收藏状态不正确')
    this.store.setFavorite(entry, favorite)
    return {}
  })
  listCollections: CatalogApi['listCollections'] = () => this.result(() => ({ collections: this.store.listCollections() }))
  saveCollection: CatalogApi['saveCollection'] = value => this.result(() => {
    const input = object(value), name = string(input.name, '集合名称', 80).trim()
    const id = input.id === undefined ? undefined : string(input.id, '集合')
    const collections = this.store.listCollections()
    if (id && !collections.some(item => item.id === id)) throw new CatalogInputError('集合不存在')
    if (collections.some(item => item.name === name && item.id !== id)) throw new CatalogInputError('集合名称已存在')
    if (!id && collections.length >= 200) throw new CatalogInputError('最多保存 200 个集合')
    return { collection: this.store.saveCollection({ id, name }) }
  })
  removeCollection: CatalogApi['removeCollection'] = value => this.result(() => {
    const id = string(value, '集合')
    if (!this.store.listCollections().some(item => item.id === id)) throw new CatalogInputError('集合不存在')
    this.store.removeCollection(id)
    return {}
  })
  setEntryCollections: CatalogApi['setEntryCollections'] = value => this.result(() => {
    const entry = this.entry(value), ids = strings(object(value).collectionIds, '集合', 200)
    const existing = new Set(this.store.listCollections().map(item => item.id))
    if (ids.some(id => !existing.has(id))) throw new CatalogInputError('集合不存在')
    this.store.setEntryCollections(entry, ids)
    return {}
  })
  resolveEntry: CatalogApi['resolveEntry'] = value => this.result(async () => {
    const entry = this.entry(value)
    const account = this.account(entry.accountId, true)
    const listing = await this.dependencies.listFiles(entry.accountId, entry.parentId)
    if (this.disposed) throw new CatalogInputError('文件目录服务已停止')
    this.account(entry.accountId, true)
    if (!listing || listing.parentId !== entry.parentId || !Array.isArray(listing.files)) throw new CatalogInputError('远端目录返回异常，请重试')
    const matches = listing.files.filter(file => file.id === entry.fileId)
    if (matches.length !== 1) throw new CatalogInputError('远端文件已变化或无法确认，请重新扫描')
    const current = this.metadata(matches[0], entry.accountId, entry.parentId, entry.path.slice(0, entry.path.lastIndexOf('/')) || '/', account.platform)
    if (current.isDir !== entry.isDir || current.name !== entry.name || current.size !== entry.size || current.updatedAt !== entry.updatedAt) throw new CatalogInputError('远端文件已变化，请重新扫描后操作')
    return { entry: this.refreshEntry(entry) }
  })

  /** Restarts only explicitly authorized running scans, never idle/paused/finished scopes. */
  async recoverInterruptedScans(): Promise<void> {
    if (this.disposed) return
    for (const id of this.store.accountIds()) {
      const account = this.dependencies.getAccount(id)
      if (account) this.store.upsertAccount(account)
      else this.removeAccount(id)
    }
    this.kick()
  }
  dispose(): void {
    this.disposed = true
    for (const callbacks of this.interruptions.values()) for (const interrupt of callbacks) interrupt()
  }
  removeAccount(accountId: string): void {
    for (const scope of this.store.listScopes()) if (scope.accountId === accountId) this.invalidate(scope.id)
    this.store.removeAccount(accountId)
  }
  /** Test/lifecycle utility: resolves after pending worker callbacks have settled. dispose itself does not block shutdown. */
  async waitForIdle(): Promise<void> { while (this.worker) await this.worker }
  private kick(): void {
    if (this.worker || this.disposed) return
    // Scheduling after the IPC reply prevents a synchronous batch from delaying the start/pause response.
    this.worker = Promise.resolve().then(() => this.run()).catch(() => {
      // Preserve the cursor on an unexpected storage failure. Explicit resume/restart can retry it.
    }).finally(() => { this.worker = undefined })
  }
  private async readDirectory(cursor: CatalogCursor): Promise<FileListResult | undefined> {
    let interrupt!: () => void
    const interrupted = new Promise<undefined>(resolve => { interrupt = () => resolve(undefined) })
    let callbacks = this.interruptions.get(cursor.scopeId)
    if (!callbacks) { callbacks = new Set(); this.interruptions.set(cursor.scopeId, callbacks) }
    callbacks.add(interrupt)
    try {
      // Adapters cannot cancel listFiles yet. Abandon its result on pause/restart so it cannot hold up other scopes.
      // Promise.race also observes a later adapter rejection, avoiding an unhandled rejection after shutdown.
      return await Promise.race([this.dependencies.listFiles(cursor.accountId, cursor.directoryId), interrupted])
    } finally {
      callbacks.delete(interrupt)
      if (!callbacks.size) this.interruptions.delete(cursor.scopeId)
    }
  }
  private async run(): Promise<void> {
    while (!this.disposed) {
      if (this.store.finishReadyScans()) { await this.yieldControl(); continue }
      const cursor = this.store.nextCursor()
      if (!cursor) return
      const epoch = this.epochs.get(cursor.scopeId) ?? 0
      const current = (): boolean => !this.disposed && epoch === (this.epochs.get(cursor.scopeId) ?? 0) && this.store.isCurrent(cursor)
      try {
        this.account(cursor.accountId, true)
        const listing = await this.readDirectory(cursor)
        if (!current()) continue
        const account = this.account(cursor.accountId, true)
        // The existing adapter API auto-pages. Without an explicit complete result, deletion is unsafe.
        if (!listing || listing.hasMore !== false) throw new CatalogInputError('平台未返回完整目录，本次未替换该目录；请重试或使用支持完整列表的平台')
        if (listing.parentId !== cursor.directoryId || !Array.isArray(listing.files)) throw new CatalogInputError('远端目录返回异常，本次保留已有索引')
        const files: CatalogMetadata[] = [], seen = new Set<string>(), parentPath = this.currentPath(cursor)
        const ancestors = this.ancestors(cursor)
        for (let index = 0; index < listing.files.length; index++) {
          const metadata = this.metadata(listing.files[index], cursor.accountId, cursor.directoryId, parentPath, account.platform)
          if (seen.has(metadata.fileId) || ancestors.has(metadata.fileId)) throw new CatalogInputError('远端目录包含重复或循环标识，本次保留已有索引')
          seen.add(metadata.fileId); files.push(metadata)
          if (index % 1000 === 999) { await this.yieldControl(); if (!current()) break }
        }
        if (!current()) continue
        this.store.beginDirectory(cursor)
        for (let offset = 0; offset < files.length; offset += 200) {
          if (!current()) break
          this.account(cursor.accountId, true)
          this.store.writeBatch(cursor, files.slice(offset, offset + 200))
          await this.yieldControl()
        }
        if (!current()) continue
        this.account(cursor.accountId, true)
        this.store.finishDirectory(cursor)
      } catch (error) {
        if (!current()) continue
        if (!this.dependencies.getAccount(cursor.accountId)) { this.removeAccount(cursor.accountId); continue }
        this.store.failDirectory(cursor, error instanceof CatalogInputError ? error.message : '目录读取失败，请检查网络或账号后重试')
      }
      await this.yieldControl()
    }
  }
  private currentPath(cursor: CatalogCursor): string {
    const row = this.store.db.prepare('SELECT path FROM catalog_queue WHERE scope_id=? AND directory_id=?').get(cursor.scopeId, cursor.directoryId) as { path: string } | undefined
    return row?.path ?? cursor.path
  }
  private ancestors(cursor: CatalogCursor): Set<string> {
    const result = this.store.db.prepare(`WITH RECURSIVE ancestors(id) AS (
      SELECT ? UNION SELECT e.parent_id FROM ancestors a CROSS JOIN catalog_entries e WHERE e.file_id=a.id AND e.account_id=?
    ) SELECT id FROM ancestors`).all(cursor.directoryId, cursor.accountId) as { id: string }[]
    return new Set([...result.map(row => row.id), this.store.getScopeRow(cursor.scopeId)!.root_id])
  }
  private metadata(value: FileItem, accountId: string, parentId: string, parentPath: string, platform: Platform): CatalogMetadata {
    const file = object(value), name = string(file.name, '远端文件名', 1024)
    if (/[\/\\]/.test(name) || name === '.' || name === '..') throw new CatalogInputError('远端文件名不正确，本次保留已有索引')
    // These three adapters accept the UI's root ID "0" but expose their canonical root on children.
    // Keep every non-root comparison strict, and do not accept another provider's root alias.
    const rootAlias = parentId === '0' && ((platform === 'baidu' && file.parentId === '/')
      || (platform === 'aliyun_web' && file.parentId === 'root') || (platform === 'xunlei' && file.parentId === ''))
    if (typeof file.isDir !== 'boolean' || file.accountId !== accountId || (file.parentId !== parentId && !rootAlias)) throw new CatalogInputError('远端文件所属目录或账号不一致，本次保留已有索引')
    const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
    const fullPath = (parentPath === '/' ? '' : parentPath) + '/' + name
    if (fullPath.length > 16_384) throw new CatalogInputError('远端目录层级过深，本次保留已有索引')
    return {
      accountId, fileId: string(file.id, '远端文件标识', 4096), parentId, name, path: fullPath,
      isDir: file.isDir, size: number(file.size, '远端文件大小'), createdAt: number(file.createdAt, '远端创建时间'), updatedAt: number(file.updatedAt, '远端更新时间'),
      fileType: file.isDir ? 'folder' : EXTENSIONS[extension] ?? 'other',
    }
  }
}
