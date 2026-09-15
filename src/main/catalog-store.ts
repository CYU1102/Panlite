import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AccountStatus, Platform } from '../shared/types'
import type { CatalogCollection, CatalogEntry, CatalogFileType, CatalogQuery, CatalogRef, CatalogScope, CatalogScopeInput, CatalogSearchPage } from '../shared/catalog'

export interface CatalogAccount { id: string; nickname: string; platform: Platform; status: AccountStatus }
export interface CatalogMetadata extends CatalogRef {
  parentId: string; name: string; path: string; isDir: boolean; size: number
  createdAt: number; updatedAt: number; fileType: CatalogFileType
}
export interface CatalogCursor { scopeId: string; generation: number; accountId: string; directoryId: string; path: string }

/** Independent, additive schema: caller includes this in its normal database migration. */
export function initializeCatalogSchema(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_schema (version INTEGER NOT NULL);
      INSERT INTO catalog_schema (version) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM catalog_schema);
    `)
    const { version } = db.prepare('SELECT version FROM catalog_schema').get() as { version: number }
    if (version > 1) throw new Error('Unsupported catalog schema version')
    if (version === 1) return
    db.exec(`
      CREATE TABLE catalog_accounts (id TEXT PRIMARY KEY, nickname TEXT NOT NULL, platform TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE catalog_scopes (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES catalog_accounts(id) ON DELETE CASCADE,
        root_id TEXT NOT NULL, root_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
        generation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_scan_at INTEGER, last_completed_at INTEGER, UNIQUE(account_id, root_id)
      );
      CREATE TABLE catalog_entries (
        account_id TEXT NOT NULL REFERENCES catalog_accounts(id) ON DELETE CASCADE, file_id TEXT NOT NULL,
        parent_id TEXT NOT NULL, name TEXT NOT NULL, search_name TEXT NOT NULL, path TEXT NOT NULL, search_path TEXT NOT NULL,
        is_dir INTEGER NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL, file_type TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(account_id, file_id)
      );
      CREATE INDEX catalog_entries_parent ON catalog_entries(account_id, parent_id);
      CREATE INDEX catalog_entries_size ON catalog_entries(size);
      CREATE INDEX catalog_entries_date ON catalog_entries(updated_at);
      CREATE INDEX catalog_entries_name ON catalog_entries(search_name, account_id, file_id);
      CREATE INDEX catalog_entries_type ON catalog_entries(file_type);
      CREATE TABLE catalog_members (
        scope_id TEXT NOT NULL REFERENCES catalog_scopes(id) ON DELETE CASCADE, account_id TEXT NOT NULL, file_id TEXT NOT NULL,
        PRIMARY KEY(scope_id, file_id), FOREIGN KEY(account_id, file_id) REFERENCES catalog_entries(account_id, file_id) ON DELETE CASCADE
      );
      CREATE INDEX catalog_members_identity ON catalog_members(account_id, file_id);
      CREATE TABLE catalog_edges (
        scope_id TEXT NOT NULL REFERENCES catalog_scopes(id) ON DELETE CASCADE, parent_id TEXT NOT NULL, file_id TEXT NOT NULL,
        PRIMARY KEY(scope_id, parent_id, file_id)
      );
      CREATE TABLE catalog_candidates (
        scope_id TEXT NOT NULL REFERENCES catalog_scopes(id) ON DELETE CASCADE, parent_id TEXT NOT NULL, file_id TEXT NOT NULL,
        PRIMARY KEY(scope_id, parent_id, file_id)
      );
      CREATE TABLE catalog_queue (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, scope_id TEXT NOT NULL REFERENCES catalog_scopes(id) ON DELETE CASCADE,
        directory_id TEXT NOT NULL, path TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', error TEXT,
        UNIQUE(scope_id, directory_id)
      );
      CREATE INDEX catalog_queue_pending ON catalog_queue(scope_id, state, seq);
      CREATE TABLE catalog_tags (
        account_id TEXT NOT NULL, file_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(account_id, file_id, tag),
        FOREIGN KEY(account_id, file_id) REFERENCES catalog_entries(account_id, file_id) ON DELETE CASCADE
      );
      CREATE INDEX catalog_tags_label ON catalog_tags(tag, account_id, file_id);
      CREATE TABLE catalog_collections (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE catalog_collection_members (
        collection_id TEXT NOT NULL REFERENCES catalog_collections(id) ON DELETE CASCADE, account_id TEXT NOT NULL, file_id TEXT NOT NULL,
        PRIMARY KEY(collection_id, account_id, file_id), FOREIGN KEY(account_id, file_id) REFERENCES catalog_entries(account_id, file_id) ON DELETE CASCADE
      );
      CREATE INDEX catalog_collection_identity ON catalog_collection_members(account_id, file_id);
      UPDATE catalog_schema SET version = 1;
    `)
  })()
}

interface ScopeRow {
  id: string; account_id: string; root_id: string; root_path: string; status: CatalogScope['status']; generation: number
  created_at: number; updated_at: number; last_scan_at: number | null; last_completed_at: number | null
}
interface EntryRow {
  account_id: string; file_id: string; parent_id: string; name: string; path: string; is_dir: number; size: number
  created_at: number; updated_at: number; indexed_at: number; file_type: CatalogFileType; favorite: number
  nickname: string; platform: Platform; status: AccountStatus
}
const ENTRY_SELECT = 'SELECT e.*, a.nickname, a.platform, a.status FROM catalog_entries e JOIN catalog_accounts a ON a.id=e.account_id'
const IS_VISIBLE = 'EXISTS (SELECT 1 FROM catalog_members m WHERE m.account_id=e.account_id AND m.file_id=e.file_id)'

export class CatalogStore {
  constructor(readonly db: Database.Database, private readonly now: () => number = Date.now) {}

  upsertAccount(account: CatalogAccount): void {
    this.db.prepare(`INSERT INTO catalog_accounts(id,nickname,platform,status) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET nickname=excluded.nickname,platform=excluded.platform,status=excluded.status`)
      .run(account.id, account.nickname, account.platform, account.status)
  }
  accountIds(): string[] { return (this.db.prepare('SELECT id FROM catalog_accounts').all() as { id: string }[]).map(row => row.id) }
  removeAccount(accountId: string): void { this.db.prepare('DELETE FROM catalog_accounts WHERE id=?').run(accountId) }
  getScopeRow(id: string): ScopeRow | undefined { return this.db.prepare('SELECT * FROM catalog_scopes WHERE id=?').get(id) as ScopeRow | undefined }
  listScopes(): CatalogScope[] {
    return (this.db.prepare('SELECT id FROM catalog_scopes ORDER BY created_at,id').all() as { id: string }[])
      .map(row => this.getScope(row.id)!)
  }
  getScope(id: string): CatalogScope | undefined {
    const row = this.getScopeRow(id)
    if (!row) return undefined
    const account = this.db.prepare('SELECT * FROM catalog_accounts WHERE id=?').get(row.account_id) as CatalogAccount
    const counts = this.db.prepare('SELECT state,COUNT(*) count FROM catalog_queue WHERE scope_id=? GROUP BY state').all(id) as { state: string; count: number }[]
    const count = (state: string): number => counts.find(item => item.state === state)?.count ?? 0
    const entryCount = (this.db.prepare('SELECT COUNT(*) count FROM catalog_members WHERE scope_id=?').get(id) as { count: number }).count
    const failures = this.db.prepare("SELECT directory_id directoryId,path,error FROM catalog_queue WHERE scope_id=? AND state='failed' ORDER BY seq LIMIT 100").all(id) as CatalogScope['failures']
    return {
      id, accountId: row.account_id, accountNickname: account.nickname, platform: account.platform, accountStatus: account.status,
      rootId: row.root_id, rootPath: row.root_path, status: row.status, scannedDirectories: count('done'), pendingDirectories: count('pending'),
      failedDirectories: count('failed'), failures, entryCount, createdAt: row.created_at, updatedAt: row.updated_at,
      lastScanAt: row.last_scan_at, lastCompletedAt: row.last_completed_at,
    }
  }
  addScope(input: CatalogScopeInput): CatalogScope {
    const existing = this.db.prepare('SELECT id FROM catalog_scopes WHERE account_id=? AND root_id=?').get(input.accountId, input.rootId) as { id: string } | undefined
    if (existing) return this.getScope(existing.id)!
    const id = randomUUID(), now = this.now()
    this.db.prepare('INSERT INTO catalog_scopes(id,account_id,root_id,root_path,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id, input.accountId, input.rootId, input.rootPath, now, now)
    return this.getScope(id)!
  }
  removeScope(id: string): void {
    this.db.transaction(() => { this.db.prepare('DELETE FROM catalog_scopes WHERE id=?').run(id); this.pruneOrphans() })()
  }
  startScan(id: string): void {
    this.db.transaction(() => {
      const row = this.getScopeRow(id)!
      this.db.prepare('DELETE FROM catalog_queue WHERE scope_id=?').run(id)
      this.db.prepare('DELETE FROM catalog_candidates WHERE scope_id=?').run(id)
      this.db.prepare("UPDATE catalog_scopes SET status='running',generation=generation+1,last_scan_at=?,updated_at=? WHERE id=?").run(this.now(), this.now(), id)
      this.db.prepare('INSERT INTO catalog_queue(scope_id,directory_id,path) VALUES(?,?,?)').run(id, row.root_id, row.root_path)
    })()
  }
  pauseScan(id: string): void { this.db.prepare("UPDATE catalog_scopes SET status='paused',updated_at=? WHERE id=? AND status='running'").run(this.now(), id) }
  resumeScan(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE catalog_queue SET state='pending',error=NULL WHERE scope_id=? AND state='failed'").run(id)
      this.db.prepare("UPDATE catalog_scopes SET status='running',updated_at=? WHERE id=?").run(this.now(), id)
    })()
  }
  nextCursor(): CatalogCursor | undefined {
    return this.db.prepare(`SELECT s.id scopeId,s.account_id accountId,s.generation,q.directory_id directoryId,q.path
      FROM catalog_scopes s JOIN catalog_queue q ON q.scope_id=s.id
      WHERE s.status='running' AND q.state='pending' ORDER BY q.seq LIMIT 1`).get() as CatalogCursor | undefined
  }
  isCurrent(cursor: CatalogCursor): boolean {
    return !!this.db.prepare("SELECT 1 FROM catalog_scopes WHERE id=? AND generation=? AND status='running'").get(cursor.scopeId, cursor.generation)
  }
  beginDirectory(cursor: CatalogCursor): void {
    this.db.prepare('DELETE FROM catalog_candidates WHERE scope_id=? AND parent_id=?').run(cursor.scopeId, cursor.directoryId)
  }
  /** Small transactions allow the service to yield between batches. Until finishDirectory, old edges remain authoritative. */
  writeBatch(cursor: CatalogCursor, files: CatalogMetadata[]): void {
    const upsert = this.db.prepare(`INSERT INTO catalog_entries(account_id,file_id,parent_id,name,search_name,path,search_path,is_dir,size,created_at,updated_at,indexed_at,file_type)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,file_id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,
      search_name=excluded.search_name,path=excluded.path,search_path=excluded.search_path,is_dir=excluded.is_dir,size=excluded.size,
      created_at=excluded.created_at,updated_at=excluded.updated_at,indexed_at=excluded.indexed_at,file_type=excluded.file_type`)
    const candidate = this.db.prepare('INSERT OR IGNORE INTO catalog_candidates(scope_id,parent_id,file_id) VALUES(?,?,?)')
    this.db.transaction(() => {
      for (const file of files) {
        if (file.isDir) {
          const old = (this.db.prepare('SELECT path FROM catalog_entries WHERE account_id=? AND file_id=?').get(file.accountId, file.fileId)
            ?? this.db.prepare('SELECT root_path path FROM catalog_scopes WHERE account_id=? AND root_id=?').get(file.accountId, file.fileId)) as { path: string } | undefined
          if (old && old.path !== file.path) this.relocateSubtree(file.accountId, file.fileId, old.path, file.path)
        }
        upsert.run(file.accountId, file.fileId, file.parentId, file.name, file.name.toLowerCase(), file.path, file.path.toLowerCase(),
          Number(file.isDir), file.size, file.createdAt, file.updatedAt, this.now(), file.fileType)
        candidate.run(cursor.scopeId, cursor.directoryId, file.fileId)
      }
    })()
  }
  private relocateSubtree(accountId: string, fileId: string, oldPath: string, newPath: string): void {
    // Rewrite descendants by identity, never by a path prefix shared by another account/folder.
    const children = this.db.prepare(`WITH RECURSIVE tree(id) AS (
      SELECT file_id FROM catalog_entries WHERE account_id=? AND parent_id=? AND file_id<>?
      UNION SELECT e.file_id FROM tree t CROSS JOIN catalog_entries e WHERE e.parent_id=t.id AND e.account_id=? AND e.file_id<>?
    ) SELECT e.file_id,e.path FROM tree t CROSS JOIN catalog_entries e WHERE t.id=e.file_id AND e.account_id=?`)
      .all(accountId, fileId, fileId, accountId, fileId, accountId) as { file_id: string; path: string }[]
    const paths = [{ file_id: fileId, path: oldPath }, ...children]
    const updateEntry = this.db.prepare('UPDATE catalog_entries SET path=?,search_path=? WHERE account_id=? AND file_id=?')
    const updateRoot = this.db.prepare('UPDATE catalog_scopes SET root_path=? WHERE account_id=? AND root_id=?')
    const updateQueue = this.db.prepare('UPDATE catalog_queue SET path=? WHERE directory_id=? AND scope_id IN (SELECT id FROM catalog_scopes WHERE account_id=?)')
    for (const child of paths) {
      if (child.path !== oldPath && !child.path.startsWith(oldPath + '/')) continue
      const path = newPath + child.path.slice(oldPath.length)
      updateEntry.run(path, path.toLowerCase(), accountId, child.file_id)
      updateRoot.run(path, accountId, child.file_id)
      updateQueue.run(path, child.file_id, accountId)
    }
  }
  finishDirectory(cursor: CatalogCursor): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM catalog_edges WHERE scope_id=? AND parent_id=?').run(cursor.scopeId, cursor.directoryId)
      this.db.prepare('INSERT INTO catalog_edges SELECT scope_id,parent_id,file_id FROM catalog_candidates WHERE scope_id=? AND parent_id=?').run(cursor.scopeId, cursor.directoryId)
      this.db.prepare(`INSERT OR IGNORE INTO catalog_members(scope_id,account_id,file_id)
        SELECT scope_id,?,file_id FROM catalog_candidates WHERE scope_id=? AND parent_id=?`).run(cursor.accountId, cursor.scopeId, cursor.directoryId)
      this.db.prepare(`INSERT OR IGNORE INTO catalog_queue(scope_id,directory_id,path)
        SELECT ?,e.file_id,e.path FROM catalog_candidates c JOIN catalog_entries e ON e.account_id=? AND e.file_id=c.file_id
        WHERE c.scope_id=? AND c.parent_id=? AND e.is_dir=1`).run(cursor.scopeId, cursor.accountId, cursor.scopeId, cursor.directoryId)
      this.db.prepare('DELETE FROM catalog_candidates WHERE scope_id=? AND parent_id=?').run(cursor.scopeId, cursor.directoryId)
      this.db.prepare("UPDATE catalog_queue SET state='done',error=NULL WHERE scope_id=? AND directory_id=?").run(cursor.scopeId, cursor.directoryId)
      this.db.prepare('UPDATE catalog_scopes SET updated_at=? WHERE id=?').run(this.now(), cursor.scopeId)
    })()
  }
  failDirectory(cursor: CatalogCursor, error: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM catalog_candidates WHERE scope_id=? AND parent_id=?').run(cursor.scopeId, cursor.directoryId)
      this.db.prepare("UPDATE catalog_queue SET state='failed',error=? WHERE scope_id=? AND directory_id=?").run(error, cursor.scopeId, cursor.directoryId)
      this.db.prepare('UPDATE catalog_scopes SET updated_at=? WHERE id=?').run(this.now(), cursor.scopeId)
    })()
  }
  finishReadyScans(): number {
    const scopes = this.db.prepare(`SELECT * FROM catalog_scopes s WHERE status='running'
      AND NOT EXISTS(SELECT 1 FROM catalog_queue q WHERE q.scope_id=s.id AND q.state='pending') LIMIT 1`).all() as ScopeRow[]
    for (const scope of scopes) this.db.transaction(() => {
      // Only successful directory listings replace edges. Old edges below failed directories remain reachable.
      // CROSS JOIN fixes the recursive join order: each known ID probes the compound index once.
      // An unconstrained planner order can rescan all scope edges for every leaf (quadratic at 100k rows).
      // Successful listings already added every new member, so retain matching rows instead of rewriting the whole scope.
      this.db.prepare(`WITH RECURSIVE reachable(id) AS (
        SELECT file_id FROM catalog_edges WHERE scope_id=? AND parent_id=?
        UNION SELECT e.file_id FROM reachable r CROSS JOIN catalog_entries d CROSS JOIN catalog_edges e
          WHERE d.account_id=? AND d.file_id=r.id AND d.is_dir=1 AND e.parent_id=r.id AND e.scope_id=?
      ) DELETE FROM catalog_members WHERE scope_id=? AND (file_id=? OR file_id NOT IN(SELECT id FROM reachable))`)
        .run(scope.id, scope.root_id, scope.account_id, scope.id, scope.id, scope.root_id)
      this.db.prepare(`DELETE FROM catalog_edges WHERE scope_id=? AND parent_id<>?
        AND NOT EXISTS(SELECT 1 FROM catalog_members m WHERE m.scope_id=? AND m.file_id=catalog_edges.parent_id)`).run(scope.id, scope.root_id, scope.id)
      const failed = (this.db.prepare("SELECT COUNT(*) count FROM catalog_queue WHERE scope_id=? AND state='failed'").get(scope.id) as { count: number }).count
      const done = (this.db.prepare("SELECT COUNT(*) count FROM catalog_queue WHERE scope_id=? AND state='done'").get(scope.id) as { count: number }).count
      this.db.prepare('UPDATE catalog_scopes SET status=?,updated_at=?,last_completed_at=CASE WHEN ?=0 THEN ? ELSE last_completed_at END WHERE id=?')
        .run(failed ? (done ? 'partial' : 'error') : 'completed', this.now(), failed, this.now(), scope.id)
      this.pruneOrphans()
    })()
    return scopes.length
  }
  private pruneOrphans(): void {
    // Keep local annotations even when their remote reference is no longer in an indexed range.
    this.db.prepare(`DELETE FROM catalog_entries AS e WHERE NOT ${IS_VISIBLE}
      AND e.favorite=0 AND NOT EXISTS(SELECT 1 FROM catalog_tags t WHERE t.account_id=e.account_id AND t.file_id=e.file_id)
      AND NOT EXISTS(SELECT 1 FROM catalog_collection_members c WHERE c.account_id=e.account_id AND c.file_id=e.file_id)
      AND NOT EXISTS(SELECT 1 FROM catalog_scopes s WHERE s.account_id=e.account_id AND s.root_id=e.file_id)
      AND NOT EXISTS(SELECT 1 FROM catalog_candidates c JOIN catalog_scopes s ON s.id=c.scope_id WHERE s.account_id=e.account_id AND c.file_id=e.file_id)`).run()
  }
  private toEntry(row: EntryRow): CatalogEntry {
    return {
      accountId: row.account_id, fileId: row.file_id, parentId: row.parent_id, name: row.name, path: row.path, isDir: !!row.is_dir,
      size: row.size, createdAt: row.created_at, updatedAt: row.updated_at, indexedAt: row.indexed_at, fileType: row.file_type,
      favorite: !!row.favorite, platform: row.platform, accountNickname: row.nickname, accountStatus: row.status,
      tags: (this.db.prepare('SELECT tag FROM catalog_tags WHERE account_id=? AND file_id=? ORDER BY tag').all(row.account_id, row.file_id) as { tag: string }[]).map(item => item.tag),
      collectionIds: (this.db.prepare('SELECT collection_id FROM catalog_collection_members WHERE account_id=? AND file_id=? ORDER BY collection_id').all(row.account_id, row.file_id) as { collection_id: string }[]).map(item => item.collection_id),
    }
  }
  getEntry(ref: CatalogRef): CatalogEntry | undefined {
    const row = this.db.prepare(`${ENTRY_SELECT} WHERE e.account_id=? AND e.file_id=? AND ${IS_VISIBLE}`).get(ref.accountId, ref.fileId) as EntryRow | undefined
    return row ? this.toEntry(row) : undefined
  }
  search(query: CatalogQuery): CatalogSearchPage {
    const where: string[] = [IS_VISIBLE], values: (string | number)[] = []
    const add = (sql: string, value: string | number): void => { where.push(sql); values.push(value) }
    const many = (column: string, items?: string[]): void => { if (items?.length) { where.push(`${column} IN (${items.map(() => '?').join(',')})`); values.push(...items) } }
    const literal = (value: string): string => `%${value.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`
    if (query.keyword) add("e.search_name LIKE ? ESCAPE '\\'", literal(query.keyword))
    if (query.path) add("e.search_path LIKE ? ESCAPE '\\'", literal(query.path))
    many('e.account_id', query.accountIds)
    many('e.file_type', query.fileTypes)
    if (query.scopeIds?.length) {
      where.push(`EXISTS(SELECT 1 FROM catalog_members s WHERE s.account_id=e.account_id AND s.file_id=e.file_id AND s.scope_id IN (${query.scopeIds.map(() => '?').join(',')}))`)
      values.push(...query.scopeIds)
    }
    if (query.minSize !== undefined) add('e.size>=?', query.minSize)
    if (query.maxSize !== undefined) add('e.size<=?', query.maxSize)
    if (query.dateFrom !== undefined) add('e.updated_at>=?', query.dateFrom)
    if (query.dateTo !== undefined) add('e.updated_at<=?', query.dateTo)
    if (query.favorite !== undefined) add('e.favorite=?', Number(query.favorite))
    for (const tag of query.tags ?? []) add('EXISTS(SELECT 1 FROM catalog_tags t WHERE t.account_id=e.account_id AND t.file_id=e.file_id AND t.tag=?)', tag)
    if (query.collectionId) add('EXISTS(SELECT 1 FROM catalog_collection_members c WHERE c.account_id=e.account_id AND c.file_id=e.file_id AND c.collection_id=?)', query.collectionId)
    const clause = where.join(' AND ')
    const total = (this.db.prepare(`SELECT COUNT(*) count FROM catalog_entries e WHERE ${clause}`).get(...values) as { count: number }).count
    const column = { name: 'search_name', path: 'search_path', size: 'size', updatedAt: 'updated_at', indexedAt: 'indexed_at' }[query.sortBy ?? 'name']
    const page = query.page ?? 1, pageSize = query.pageSize ?? 50
    const rows = this.db.prepare(`${ENTRY_SELECT} WHERE ${clause} ORDER BY e.${column} ${query.sortOrder === 'desc' ? 'DESC' : 'ASC'},e.account_id,e.file_id LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (page - 1) * pageSize) as EntryRow[]
    return { entries: rows.map(row => this.toEntry(row)), total, page, pageSize }
  }
  listTags(): string[] { return (this.db.prepare('SELECT DISTINCT tag FROM catalog_tags ORDER BY tag').all() as { tag: string }[]).map(row => row.tag) }
  setTags(ref: CatalogRef, tags: string[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM catalog_tags WHERE account_id=? AND file_id=?').run(ref.accountId, ref.fileId)
      const insert = this.db.prepare('INSERT INTO catalog_tags(account_id,file_id,tag) VALUES(?,?,?)')
      for (const tag of tags) insert.run(ref.accountId, ref.fileId, tag)
    })()
  }
  setFavorite(ref: CatalogRef, favorite: boolean): void { this.db.prepare('UPDATE catalog_entries SET favorite=? WHERE account_id=? AND file_id=?').run(Number(favorite), ref.accountId, ref.fileId) }
  listCollections(): CatalogCollection[] {
    return this.db.prepare(`SELECT c.id,c.name,c.created_at createdAt,c.updated_at updatedAt,
      (SELECT COUNT(*) FROM catalog_collection_members m WHERE m.collection_id=c.id
        AND EXISTS(SELECT 1 FROM catalog_members v WHERE v.account_id=m.account_id AND v.file_id=m.file_id)) entryCount
      FROM catalog_collections c ORDER BY c.name,c.id`).all() as CatalogCollection[]
  }
  saveCollection(input: { id?: string; name: string }): CatalogCollection {
    const id = input.id ?? randomUUID()
    this.db.prepare(`INSERT INTO catalog_collections(id,name,created_at,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`).run(id, input.name, this.now(), this.now())
    return this.listCollections().find(item => item.id === id)!
  }
  removeCollection(id: string): void { this.db.prepare('DELETE FROM catalog_collections WHERE id=?').run(id) }
  setEntryCollections(ref: CatalogRef, ids: string[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM catalog_collection_members WHERE account_id=? AND file_id=?').run(ref.accountId, ref.fileId)
      const insert = this.db.prepare('INSERT INTO catalog_collection_members(collection_id,account_id,file_id) VALUES(?,?,?)')
      for (const id of ids) insert.run(id, ref.accountId, ref.fileId)
    })()
  }
}
