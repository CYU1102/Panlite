import type Database from 'better-sqlite3'
import type { CatalogRef } from '../shared/catalog'
import type { StorageDirectory, StorageDuplicateGroup, StorageEvidence, StorageFilter, StorageGroupKey, StorageGroupQuery, StorageMember, StorageMembersQuery, StoragePage, StoragePageQuery, StorageSummary, StorageTotals } from '../shared/storage-analysis'
import { CatalogStore } from './catalog-store'

/** Additive migration; existing catalog data and annotations remain untouched. */
export function initializeStorageAnalysisSchema(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS storage_analysis_evidence (
        account_id TEXT NOT NULL, file_id TEXT NOT NULL, algorithm TEXT NOT NULL CHECK(algorithm IN ('md5','sha1')),
        value TEXT NOT NULL, size INTEGER NOT NULL, updated_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL,
        checked_at INTEGER NOT NULL, PRIMARY KEY(account_id,file_id),
        FOREIGN KEY(account_id,file_id) REFERENCES catalog_entries(account_id,file_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS storage_analysis_quotas (
        account_id TEXT PRIMARY KEY REFERENCES catalog_accounts(id) ON DELETE CASCADE,
        used INTEGER NOT NULL, total INTEGER NOT NULL, checked_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS storage_analysis_duplicate_name_size ON catalog_entries(search_name,size) WHERE is_dir=0;
    `)
  })()
}

type Values = (string | number)[]
function selection(filter: StorageFilter): { clause: string; values: Values } {
  const clauses = ['EXISTS (SELECT 1 FROM catalog_members m WHERE m.account_id=e.account_id AND m.file_id=e.file_id)'], values: Values = []
  const many = (column: string, items?: string[]) => {
    if (items?.length) { clauses.push(`${column} IN (${items.map(() => '?').join(',')})`); values.push(...items) }
  }
  many('e.account_id', filter.accountIds); many('e.file_type', filter.fileTypes)
  if (filter.scopeIds?.length) {
    clauses.push(`EXISTS (SELECT 1 FROM catalog_members m WHERE m.account_id=e.account_id AND m.file_id=e.file_id AND m.scope_id IN (${filter.scopeIds.map(() => '?').join(',')}))`)
    values.push(...filter.scopeIds)
  }
  return { clause: clauses.join(' AND '), values }
}
const TOTALS = `COALESCE(SUM(CASE WHEN e.is_dir=0 THEN e.size ELSE 0 END),0) bytes,
  COALESCE(SUM(e.is_dir=0),0) fileCount,COALESCE(SUM(e.is_dir=1),0) directoryCount,MAX(e.indexed_at) lastIndexedAt`
const EVIDENCE_JOIN = `LEFT JOIN storage_analysis_evidence h ON h.account_id=e.account_id AND h.file_id=e.file_id
  AND h.size=e.size AND h.updated_at=e.updated_at AND h.indexed_at=e.indexed_at`

export class StorageAnalysisStore {
  readonly catalog: CatalogStore
  constructor(readonly db: Database.Database, private readonly now: () => number = Date.now) { this.catalog = new CatalogStore(db, now) }

  summary(filter: StorageFilter): StorageSummary {
    const { clause, values } = selection(filter)
    const totals = this.db.prepare(`SELECT ${TOTALS} FROM catalog_entries e WHERE ${clause}`).get(...values) as StorageTotals
    const scopes = this.catalog.listScopes().filter(scope => (!filter.accountIds?.length || filter.accountIds.includes(scope.accountId)) && (!filter.scopeIds?.length || filter.scopeIds.includes(scope.id)))
    const scopeDetails = scopes.map(scope => {
      const counts = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN e.is_dir=0 THEN e.size ELSE 0 END),0) indexedBytes,
        COALESCE(SUM(e.is_dir=0),0) indexedFiles FROM catalog_entries e WHERE ${clause}
        AND EXISTS(SELECT 1 FROM catalog_members m WHERE m.account_id=e.account_id AND m.file_id=e.file_id AND m.scope_id=?)`).get(...values, scope.id) as { indexedBytes: number; indexedFiles: number }
      return { ...scope, ...counts }
    })
    const ids = [...new Set(scopes.map(scope => scope.accountId))].sort()
    const accounts: StorageSummary['accounts'] = ids.map(accountId => {
      const account = this.db.prepare('SELECT nickname,platform,status FROM catalog_accounts WHERE id=?').get(accountId) as Pick<StorageSummary['accounts'][number], 'nickname' | 'platform' | 'status'>
      const counts = this.db.prepare(`SELECT ${TOTALS} FROM catalog_entries e WHERE ${clause} AND e.account_id=?`).get(...values, accountId) as StorageTotals
      const quota = this.db.prepare('SELECT used,total,checked_at checkedAt FROM storage_analysis_quotas WHERE account_id=?').get(accountId) as StorageSummary['accounts'][number]['quota'] | undefined
      return { accountId, ...account, ...counts, quota: quota ?? null, quotaDifference: quota ? quota.used - counts.bytes : null }
    })
    const types = this.db.prepare(`SELECT e.file_type fileType,SUM(e.size) bytes,COUNT(*) fileCount FROM catalog_entries e WHERE ${clause} AND e.is_dir=0 GROUP BY e.file_type ORDER BY bytes DESC,e.file_type`).all(...values) as StorageSummary['types']
    return { ...totals, accounts, scopes: scopeDetails, types, generatedAt: this.now(), coverage: {
      totalScopes: scopes.length, completeScopes: scopes.filter(scope => scope.status === 'completed').length,
      failedDirectories: scopes.reduce((sum, scope) => sum + scope.failedDirectories, 0), pendingDirectories: scopes.reduce((sum, scope) => sum + scope.pendingDirectories, 0),
    } }
  }

  private members(sql: string, values: Values, query: StoragePageQuery): StoragePage<StorageMember> {
    const page = query.page ?? 1, pageSize = query.pageSize ?? 50
    const total = (this.db.prepare(`SELECT COUNT(*) total ${sql}`).get(...values) as { total: number }).total
    const refs = this.db.prepare(`SELECT e.account_id accountId,e.file_id fileId ${sql} ORDER BY e.size DESC,e.search_name,e.account_id,e.file_id LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (page - 1) * pageSize) as CatalogRef[]
    return { items: refs.map(ref => this.member(ref)!), total, page, pageSize }
  }
  member(ref: CatalogRef): StorageMember | undefined {
    const entry = this.catalog.getEntry(ref)
    if (!entry) return undefined
    const evidence = this.db.prepare(`SELECT algorithm,value,checked_at checkedAt FROM storage_analysis_evidence
      WHERE account_id=? AND file_id=? AND size=? AND updated_at=? AND indexed_at=?`)
      .get(ref.accountId, ref.fileId, entry.size, entry.updatedAt, entry.indexedAt) as Omit<StorageEvidence, 'source'> | undefined
    return { ...entry, evidence: evidence ? { ...evidence, source: 'provider-metadata' } : null }
  }
  memberInFilter(ref: CatalogRef, filter: StorageFilter): StorageMember | undefined {
    const { clause, values } = selection(filter)
    const exists = this.db.prepare(`SELECT 1 FROM catalog_entries e WHERE ${clause} AND e.account_id=? AND e.file_id=?`).get(...values, ref.accountId, ref.fileId)
    return exists ? this.member(ref) : undefined
  }
  listLargeFiles(query: StoragePageQuery): StoragePage<StorageMember> {
    const { clause, values } = selection(query)
    return this.members(`FROM catalog_entries e WHERE ${clause} AND e.is_dir=0`, values, query)
  }
  listGroupMembers(query: StorageMembersQuery): StoragePage<StorageMember> {
    const { clause, values } = selection(query)
    return this.members(`FROM catalog_entries e WHERE ${clause} AND e.is_dir=0 AND e.search_name=? AND e.size=?`, [...values, query.group.name, query.group.size], query)
  }
  listDuplicateGroups(query: StorageGroupQuery): StoragePage<StorageDuplicateGroup> {
    const { clause, values } = selection(query)
    const cte = `WITH grouped AS (
      SELECT e.search_name name,MIN(e.name) displayName,e.size,COUNT(*) count,SUM(e.size) bytes,(COUNT(*)-1)*e.size potentialBytes,
      COUNT(h.file_id) evidenceCount,COUNT(DISTINCT h.algorithm || ':' || h.value) distinctEvidenceCount,
      CASE WHEN COUNT(h.file_id)=COUNT(*) AND COUNT(DISTINCT h.algorithm || ':' || h.value)=1 THEN 'confirmed'
      WHEN COUNT(h.file_id)=COUNT(*) AND COUNT(DISTINCT h.algorithm)=1 AND COUNT(DISTINCT h.value)=COUNT(*) THEN 'different'
      ELSE 'candidate' END status
      FROM catalog_entries e ${EVIDENCE_JOIN} WHERE ${clause} AND e.is_dir=0 GROUP BY e.search_name,e.size HAVING COUNT(*)>1
    )`
    const status = query.status && query.status !== 'all' ? 'WHERE status=?' : ''
    if (status) values.push(query.status!)
    const total = (this.db.prepare(`${cte} SELECT COUNT(*) total FROM grouped ${status}`).get(...values) as { total: number }).total
    const page = query.page ?? 1, pageSize = query.pageSize ?? 25
    const items = this.db.prepare(`${cte} SELECT name,displayName,size,count,bytes,evidenceCount,distinctEvidenceCount,status,
      CASE WHEN status='different' THEN 0 ELSE potentialBytes END possibleReleaseBytes
      FROM grouped ${status} ORDER BY possibleReleaseBytes DESC,name,size LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (page - 1) * pageSize) as StorageDuplicateGroup[]
    return { items, total, page, pageSize }
  }
  listDirectories(query: StoragePageQuery): StoragePage<StorageDirectory> {
    const { clause, values } = selection(query)
    // Each file propagates once to each ancestor by compound identity; UNION also terminates malformed cycles.
    // Roots can lack a catalog entry because the catalog indexes children rather than the selected root itself.
    const scopes = this.catalog.listScopes().filter(scope => (!query.accountIds?.length || query.accountIds.includes(scope.accountId)) && (!query.scopeIds?.length || query.scopeIds.includes(scope.id)))
    const directorySelection = selection({ ...query, fileTypes: undefined })
    const rootIds = scopes.map(scope => scope.id)
    const cte = `WITH RECURSIVE selected AS (SELECT e.* FROM catalog_entries e WHERE ${clause}),
      ancestors(account_id,file_id,directory_id,size) AS (
        SELECT account_id,file_id,parent_id,size FROM selected WHERE is_dir=0
        UNION SELECT a.account_id,a.file_id,e.parent_id,a.size FROM ancestors a CROSS JOIN catalog_entries e
          WHERE e.account_id=a.account_id AND e.file_id=a.directory_id AND e.is_dir=1 AND e.parent_id<>e.file_id
      ), directories AS (
        SELECT e.account_id,e.file_id directory_id,e.name,e.path,0 isScopeRoot FROM catalog_entries e WHERE ${directorySelection.clause} AND e.is_dir=1
        UNION ALL SELECT s.account_id,s.root_id,s.root_path,s.root_path,1 FROM catalog_scopes s
          WHERE s.id IN (${rootIds.length ? rootIds.map(() => '?').join(',') : 'NULL'})
      ), unique_dirs AS (
        SELECT account_id,directory_id,MIN(name) name,MIN(path) path,MAX(isScopeRoot) isScopeRoot FROM directories GROUP BY account_id,directory_id
      ), sizes AS (SELECT account_id,directory_id,SUM(size) bytes,COUNT(*) fileCount FROM ancestors GROUP BY account_id,directory_id)
    `
    const params = [...values, ...directorySelection.values, ...rootIds], page = query.page ?? 1, pageSize = query.pageSize ?? 50
    const total = (this.db.prepare(`${cte} SELECT COUNT(*) total FROM unique_dirs`).get(...params) as { total: number }).total
    const items = this.db.prepare(`${cte} SELECT d.account_id accountId,d.directory_id fileId,d.name,d.path,d.isScopeRoot,
      a.nickname accountNickname,COALESCE(s.bytes,0) bytes,COALESCE(s.fileCount,0) fileCount
      FROM unique_dirs d JOIN catalog_accounts a ON a.id=d.account_id LEFT JOIN sizes s ON s.account_id=d.account_id AND s.directory_id=d.directory_id
      ORDER BY bytes DESC,d.account_id,d.directory_id LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as StorageDirectory[]
    return { items: items.map(item => ({ ...item, isScopeRoot: !!item.isScopeRoot })), total, page, pageSize }
  }
  saveEvidence(entry: StorageMember, hash: Pick<StorageEvidence, 'algorithm' | 'value'>): void {
    this.db.prepare(`INSERT INTO storage_analysis_evidence(account_id,file_id,algorithm,value,size,updated_at,indexed_at,checked_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id,file_id) DO UPDATE SET algorithm=excluded.algorithm,value=excluded.value,size=excluded.size,
      updated_at=excluded.updated_at,indexed_at=excluded.indexed_at,checked_at=excluded.checked_at`)
      .run(entry.accountId, entry.fileId, hash.algorithm, hash.value.toLowerCase(), entry.size, entry.updatedAt, entry.indexedAt, this.now())
  }
  clearEvidence(ref: CatalogRef): void { this.db.prepare('DELETE FROM storage_analysis_evidence WHERE account_id=? AND file_id=?').run(ref.accountId, ref.fileId) }
  saveQuota(accountId: string, quota: { used: number; total: number }): void {
    this.db.prepare(`INSERT INTO storage_analysis_quotas(account_id,used,total,checked_at) VALUES(?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET used=excluded.used,total=excluded.total,checked_at=excluded.checked_at`).run(accountId, quota.used, quota.total, this.now())
  }
  hasGroupMember(entry: StorageMember, group: StorageGroupKey): boolean { return !entry.isDir && entry.name.toLowerCase() === group.name && entry.size === group.size }
}
