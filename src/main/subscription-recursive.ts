import { createHash } from 'node:crypto'
import type { DriveAdapter } from '../adapters/base'
import type { DriveAccount } from '../shared/types'
import type { ShareSubscription, SharedDirectoryEntry, SharedDirectoryResult, SubscriptionEntry, SubscriptionWork } from '../shared/subscription-types'
import { supportsRecursiveSubscriptions } from '../shared/subscription-types'
import { sanitizeFileName } from './file-transfer'

export type SubscriptionRequest = <T>(accountId: string, execute: () => Promise<T>, signal?: AbortSignal) => Promise<T>
export interface SubscriptionScanOptions {
  signal: AbortSignal
  request: SubscriptionRequest
  assertCurrent(): void
  maxDepth?: number
  maxEntries?: number
  maxDirectories?: number
}

/** Collect a complete tree before planning any mutation. All bounds fail closed. */
export async function scanSubscription(config: ShareSubscription, account: DriveAccount, adapter: DriveAdapter, options: SubscriptionScanOptions): Promise<SubscriptionEntry[]> {
  const recursive = config.scope === 'recursive'
  if (recursive && (!supportsRecursiveSubscriptions(account.platform) || !adapter.listSharedDirectory)) throw new Error('此平台暂不支持递归订阅')
  if (!adapter.getShareDetail && !adapter.listSharedDirectory) throw new Error('此平台暂不支持分享详情')
  const queue = [{ parentId: '0', relativePath: '', depth: 0 }]
  const directoryIds = new Set<string>(['0'])
  const entryIds = new Set<string>()
  const paths = new Set<string>()
  const entries: SubscriptionEntry[] = []
  for (let index = 0; index < queue.length; index++) {
    options.signal.throwIfAborted()
    options.assertCurrent()
    const directory = queue[index]
    if (directory.depth > (options.maxDepth ?? 32) || queue.length > (options.maxDirectories ?? 5000)) throw new Error('分享目录层级或目录数量超过上限，请缩小订阅范围')
    const result: SharedDirectoryResult = await options.request(account.id, async () => {
      if (adapter.listSharedDirectory) return adapter.listSharedDirectory(account, config, { parentId: directory.parentId, signal: options.signal })
      const detail = await adapter.getShareDetail!(account, config)
      return { entries: detail.files, complete: true as const }
    }, options.signal)
    options.signal.throwIfAborted()
    options.assertCurrent()
    if (result.complete !== true || !Array.isArray(result.entries)) throw new Error('分享目录扫描未完成，保留上次基线')
    for (const file of result.entries) {
      if (!file.fileId || !file.name || /[\/\\\0]/.test(file.name) || ['.', '..'].includes(file.name) || entryIds.has(file.fileId)) throw new Error('分享目录存在循环、重复标识或无效名称，保留上次基线')
      entryIds.add(file.fileId)
      const relativePath = directory.relativePath ? `${directory.relativePath}/${file.name}` : file.name
      const safePath = relativePath.split('/').map(sanitizeFileName).join('/').toLocaleLowerCase()
      if (paths.has(safePath)) throw new Error('分享目录存在无法区分的同名路径，请调整分享目录后重试')
      paths.add(safePath)
      // Provider tokens and opaque raw values never enter the persisted snapshot.
      const entry: SubscriptionEntry = { fileId: file.fileId, name: file.name, isDir: file.isDir, parentId: directory.parentId, relativePath,
        size: typeof file.size === 'number' && Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : undefined,
        contentHash: verifiedHash(file.contentHash) }
      entries.push(entry)
      if (entries.length > (options.maxEntries ?? 50000)) throw new Error('分享文件数量超过上限，请缩小订阅范围')
      if (recursive && file.isDir) {
        if (directoryIds.has(file.fileId)) throw new Error('分享目录存在循环，保留上次基线')
        directoryIds.add(file.fileId)
        queue.push({ parentId: file.fileId, relativePath, depth: directory.depth + 1 })
      }
    }
  }
  return entries
}

function verifiedHash(value: SharedDirectoryEntry['contentHash']): SharedDirectoryEntry['contentHash'] {
  if (!value || !['sha1', 'md5'].includes(value.algorithm) || !new RegExp(`^[a-f\\d]{${value.algorithm === 'sha1' ? 40 : 32}}$`, 'i').test(value.value)) return undefined
  return { algorithm: value.algorithm, value: value.value.toLowerCase() }
}

export function subscriptionContentChanged(previous: SubscriptionEntry, current: SubscriptionEntry): boolean {
  if (previous.isDir || current.isDir) return false
  if (previous.size !== undefined && current.size !== undefined && previous.size !== current.size) return true
  const before = verifiedHash(previous.contentHash); const after = verifiedHash(current.contentHash)
  return Boolean(before && after && before.algorithm === after.algorithm && before.value !== after.value)
}

export function matchesSubscription(config: ShareSubscription, entry: SubscriptionEntry): boolean {
  const text = entry.relativePath.toLocaleLowerCase()
  if (config.excludeKeywords.some(keyword => text.includes(keyword.toLocaleLowerCase()))) return false
  if (config.includeKeywords.length && !config.includeKeywords.some(keyword => text.includes(keyword.toLocaleLowerCase()))) return false
  if (config.extensions.length) {
    if (entry.isDir) return false
    const extension = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.') + 1).toLocaleLowerCase() : ''
    if (!config.extensions.includes(extension)) return false
  }
  return true
}

export function planSubscription(config: ShareSubscription, snapshot: SubscriptionEntry[], observed: SubscriptionEntry[]): SubscriptionWork[] {
  if (!config.baselineComplete && config.initialMode === 'baseline') return []
  const previous = new Map(observed.map(entry => [entry.fileId, entry]))
  const nonemptyDirectories = new Set(snapshot.map(entry => entry.parentId))
  const groups = new Map<string, SubscriptionWork>()
  for (const entry of snapshot) {
    const before = previous.get(entry.fileId)
    if (before && !(config.detectChanges && subscriptionContentChanged(before, entry))) continue
    if (!matchesSubscription(config, entry)) continue
    if (config.scope === 'recursive' && entry.isDir) {
      // Leaf saves create their ancestor folders. Only explicitly create empty directories.
      if (!config.preserveStructure || nonemptyDirectories.has(entry.fileId)) continue
    }
    const kind = config.scope === 'recursive' && entry.isDir ? 'directory' : 'save'
    const parentPath = entry.relativePath.slice(0, Math.max(0, entry.relativePath.lastIndexOf('/')))
    const targetRelativePath = config.preserveStructure && config.scope === 'recursive' ? (kind === 'directory' ? entry.relativePath : parentPath) : ''
    // One file per durable operation makes partial saves independently recoverable.
    const key = JSON.stringify([kind, entry.parentId, targetRelativePath, entry.fileId])
    groups.set(key, { id: createHash('sha256').update(key).digest('hex'), parentId: entry.parentId, targetRelativePath, entries: [entry], kind })
  }
  return [...groups.values()]
}
