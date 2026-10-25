import type { CatalogApi, CatalogFileType, CatalogRef, CatalogResult } from '../shared/catalog'
import type { FileItem, QuotaInfo } from '../shared/types'
import type { StorageAnalysisApi, StorageFilter, StorageGroupKey, StorageGroupQuery, StorageMember, StorageMembersQuery, StoragePageQuery, StoragePlan, StoragePlanInput } from '../shared/storage-analysis'
import { extractSourceHash } from '../shared/cloud-transfer'
import type { CatalogAccount } from './catalog-store'
import { StorageAnalysisStore } from './storage-analysis-store'

export interface StorageAnalysisDependencies {
  getAccount(id: string): CatalogAccount | undefined
  resolveEntry: CatalogApi['resolveEntry']
  readMetadata(entry: StorageMember): Promise<FileItem>
  getQuota(accountId: string): Promise<QuotaInfo | null>
  exportFile(content: string, format: 'csv' | 'json'): Promise<{ cancelled: boolean; filePath?: string }>
  now?: () => number
}
class InputError extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('参数格式不正确')
  return value as Record<string, unknown>
}
function string(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new InputError(`${label}不正确`)
  return value
}
function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new InputError(`${label}不正确`)
  return value
}
function strings(value: unknown, label: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max) throw new InputError(`${label}不正确`)
  return [...new Set(value.map(item => string(item, label, 256)))]
}
function filter(value: unknown): StorageFilter {
  const input = object(value), output: StorageFilter = {}
  if (input.accountIds !== undefined) output.accountIds = strings(input.accountIds, '账号')
  if (input.scopeIds !== undefined) output.scopeIds = strings(input.scopeIds, '范围')
  if (input.fileTypes !== undefined) {
    const types = strings(input.fileTypes, '类型', 7)
    if (types.some(type => !['folder', 'video', 'audio', 'image', 'document', 'archive', 'other'].includes(type))) throw new InputError('文件类型不正确')
    output.fileTypes = types as CatalogFileType[]
  }
  return output
}
function page(value: unknown): StoragePageQuery {
  const input = object(value)
  return { ...filter(value), page: input.page === undefined ? 1 : integer(input.page, '页码', 1, 10_000_000), pageSize: input.pageSize === undefined ? 25 : integer(input.pageSize, '每页数量', 1, 100) }
}
function identity(value: unknown): CatalogRef {
  const input = object(value)
  return { accountId: string(input.accountId, '账号', 256), fileId: string(input.fileId, '文件标识') }
}
function refs(value: unknown, max: number): CatalogRef[] {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new InputError(`请选择 1 至 ${max} 个文件`)
  const unique = new Map(value.map(value => { const ref = identity(value); return [JSON.stringify([ref.accountId, ref.fileId]), ref] }))
  return [...unique.values()]
}
function group(value: unknown): StorageGroupKey {
  const input = object(value)
  return { name: string(input.name, '分组名称'), size: integer(input.size, '文件大小') }
}
const sameIdentity = (a: CatalogRef, b: CatalogRef) => a.accountId === b.accountId && a.fileId === b.fileId
const sameSnapshot = (a: StorageMember, b: StorageMember) => sameIdentity(a, b) && a.size === b.size && a.updatedAt === b.updatedAt && a.indexedAt === b.indexedAt && a.name === b.name && a.parentId === b.parentId

/** Serialize a review manifest, never executable delete commands. CSV cells resist spreadsheet formula injection. */
export function serializeStoragePlan(plan: StoragePlan, format: 'csv' | 'json'): string {
  if (format === 'json') return JSON.stringify({ version: 1, ...plan }, null, 2)
  const cell = (value: unknown): string => {
    let text = String(value ?? '')
    if (/^[\s]*[=+@-]|^[\t\r]/.test(text)) text = `'${text}`
    return `"${text.replace(/"/g, '""')}"`
  }
  const row = (entry: StorageMember, action: string, certainty: string) => [action, certainty, entry.accountNickname, entry.accountId, entry.platform, entry.fileId, entry.path, entry.size, action === 'keep' ? 0 : entry.size, entry.evidence?.algorithm ?? '', entry.evidence?.value ?? '', entry.indexedAt, plan.notice].map(cell).join(',')
  return '\uFEFF' + [
    ['action', 'certainty', 'account', 'accountId', 'platform', 'fileId', 'path', 'bytes', 'estimatedReleaseBytes', 'hashAlgorithm', 'hash', 'indexedAt', 'notice'].map(cell).join(','),
    row(plan.keep, 'keep', 'retained'), ...plan.review.map(entry => row(entry, 'review-before-cleanup', entry.certainty)),
  ].join('\r\n')
}

export class StorageAnalysisService implements StorageAnalysisApi {
  constructor(readonly store: StorageAnalysisStore, private readonly dependencies: StorageAnalysisDependencies) {}
  private async result<T extends object>(action: () => T | Promise<T>): Promise<CatalogResult<T>> {
    try { return { success: true, ...await action() } }
    catch (error) { return { success: false, error: error instanceof InputError ? error.message : '空间分析操作失败，请重试' } }
  }
  private activeAccount(id: string): CatalogAccount {
    const account = this.dependencies.getAccount(id)
    if (!account || account.status !== 'active') throw new InputError('账号不存在或需要重新登录')
    return account
  }
  private member(ref: CatalogRef): StorageMember {
    const member = this.store.member(ref)
    if (!member || member.isDir) throw new InputError('文件不在已索引范围中，请重新扫描')
    return this.decorate(member)
  }
  private decorate(member: StorageMember): StorageMember {
    const account = this.dependencies.getAccount(member.accountId)
    return { ...member, accountNickname: account?.nickname ?? member.accountNickname, accountStatus: account?.status ?? 'missing' }
  }
  summary: StorageAnalysisApi['summary'] = input => this.result(() => {
    const summary = this.store.summary(filter(input))
    summary.accounts = summary.accounts.map(account => { const current = this.dependencies.getAccount(account.accountId); return { ...account, nickname: current?.nickname ?? account.nickname, status: current?.status ?? 'missing' } })
    summary.scopes = summary.scopes.map(scope => { const current = this.dependencies.getAccount(scope.accountId); return { ...scope, accountNickname: current?.nickname ?? scope.accountNickname, accountStatus: current?.status ?? 'missing' } })
    return { summary }
  })
  listDirectories: StorageAnalysisApi['listDirectories'] = input => this.result(() => this.store.listDirectories(page(input)))
  listLargeFiles: StorageAnalysisApi['listLargeFiles'] = input => this.result(() => { const result = this.store.listLargeFiles(page(input)); return { ...result, items: result.items.map(member => this.decorate(member)) } })
  listDuplicateGroups: StorageAnalysisApi['listDuplicateGroups'] = input => this.result(() => {
    const value = object(input), query: StorageGroupQuery = page(input)
    if (value.status !== undefined) {
      if (!['all', 'candidate', 'confirmed', 'different'].includes(value.status as string)) throw new InputError('候选状态不正确')
      query.status = value.status as StorageGroupQuery['status']
    }
    return this.store.listDuplicateGroups(query)
  })
  listGroupMembers: StorageAnalysisApi['listGroupMembers'] = input => this.result(() => {
    const query: StorageMembersQuery = { ...page(input), group: group(object(input).group) }, result = this.store.listGroupMembers(query)
    return { ...result, items: result.items.map(member => this.decorate(member)) }
  })
  verifyEvidence: StorageAnalysisApi['verifyEvidence'] = input => this.result(async () => {
    const selected = refs(object(input).refs, 50), results: Array<CatalogRef & { status: 'verified' | 'unavailable' | 'error'; message: string }> = []
    for (const ref of selected) {
      try {
        const before = this.member(ref), account = this.activeAccount(ref.accountId)
        // Resolve through the catalog's existing identity and live-version checks before reading evidence.
        const resolved = await this.dependencies.resolveEntry(ref)
        if (!resolved.success) throw new InputError(resolved.error)
        if (!sameIdentity(ref, resolved.entry)) throw new InputError('文件身份发生变化，请重新扫描')
        const remote = await this.dependencies.readMetadata(before)
        this.activeAccount(ref.accountId)
        const after = this.member(ref)
        if (!sameSnapshot(before, after) || remote.id !== ref.fileId || remote.accountId !== ref.accountId || remote.platform !== account.platform
          || remote.name !== before.name || remote.isDir || remote.size !== before.size || remote.updatedAt !== before.updatedAt) throw new InputError('文件已变化，请重新扫描后核验')
        const hash = extractSourceHash(account.platform, remote.raw)
        if (hash) { this.store.saveEvidence(after, hash); results.push({ ...ref, status: 'verified', message: `已读取平台 ${hash.algorithm.toUpperCase()} 内容哈希` }) }
        else { this.store.clearEvidence(ref); results.push({ ...ref, status: 'unavailable', message: '平台未提供受支持的完整内容哈希，仍只作为候选' }) }
      } catch (error) {
        this.store.clearEvidence(ref)
        results.push({ ...ref, status: 'error', message: error instanceof InputError ? error.message : '核验失败，请检查账号或网络后重试' })
      }
    }
    return { results }
  })
  refreshQuotas: StorageAnalysisApi['refreshQuotas'] = input => this.result(async () => {
    const ids = strings(object(input).accountIds, '账号', 20)
    if (!ids.length) throw new InputError('请选择至少一个账号')
    const results: Array<{ accountId: string; success: boolean; message: string }> = []
    for (const accountId of ids) {
      try {
        this.activeAccount(accountId)
        if (!this.store.catalog.accountIds().includes(accountId)) throw new InputError('该账号尚未添加索引范围')
        const quota = await this.dependencies.getQuota(accountId)
        this.activeAccount(accountId)
        if (!quota) throw new InputError('平台暂不支持容量查询')
        this.store.saveQuota(accountId, { used: integer(quota.used, '已用空间'), total: integer(quota.total, '总容量') })
        results.push({ accountId, success: true, message: '容量已更新' })
      } catch (error) { results.push({ accountId, success: false, message: error instanceof InputError ? error.message : '容量读取失败，保留上次记录' }) }
    }
    return { results }
  })
  private plan(value: unknown): StoragePlan {
    const input = object(value), selection: StoragePlanInput = { ...filter(value), group: group(input.group), keep: identity(input.keep), remove: refs(input.remove, 500) }
    if (selection.remove.some(ref => sameIdentity(ref, selection.keep))) throw new InputError('保留副本不能同时列入整理清单')
    const get = (ref: CatalogRef): StorageMember => {
      const member = this.store.memberInFilter(ref, selection)
      if (!member || !this.store.hasGroupMember(member, selection.group)) throw new InputError('所选文件已变化或不属于当前分组，请刷新后重选')
      return this.decorate(member)
    }
    const keep = get(selection.keep), review: StoragePlan['review'] = []
    for (const ref of selection.remove) {
      const member = get(ref), a = keep.evidence, b = member.evidence
      if (a && b && a.algorithm === b.algorithm && a.value !== b.value) throw new InputError('哈希不同的文件内容不同，不能作为保留副本的重复项列入清单')
      review.push({ ...member, certainty: a && b && a.algorithm === b.algorithm && a.value === b.value ? 'confirmed' : 'candidate' })
    }
    return {
      generatedAt: (this.dependencies.now ?? Date.now)(), keep, review,
      confirmedReleaseBytes: review.filter(entry => entry.certainty === 'confirmed').reduce((sum, entry) => sum + entry.size, 0),
      candidateReleaseBytes: review.filter(entry => entry.certainty === 'candidate').reduce((sum, entry) => sum + entry.size, 0),
      notice: '此清单仅供人工核对，不会删除文件。候选仅同名同大小；已确认项具有同算法相同平台内容哈希。索引可能过期，整理前需重新核对；预计释放量不等于平台实际配额变化。',
    }
  }
  createPlan: StorageAnalysisApi['createPlan'] = input => this.result(() => ({ plan: this.plan(input) }))
  exportPlan: StorageAnalysisApi['exportPlan'] = input => this.result(async () => {
    const format = object(input).format
    if (format !== 'csv' && format !== 'json') throw new InputError('导出格式不正确')
    const plan = this.plan(input)
    return await this.dependencies.exportFile(serializeStoragePlan(plan, format), format)
  })
}
