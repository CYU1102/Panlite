import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  FileBackupEntry, FileBackupJob, FileBackupJobItem, FileBackupPlan, FileBackupPlanInput, FileBackupPreview,
  FileBackupPreviewItem, FileBackupRetentionObject, FileBackupRetentionPreview, FileBackupSnapshot, FileRestorePreview, FileRestorePreviewItem,
} from '../shared/file-backup'

export interface LocalBackupEvidence extends FileBackupEntry { dev: number; ino: number; mtimeMs: number; ctimeMs: number }
export interface StoredBackupPreview {
  preview: FileBackupPreview; items: FileBackupPreviewItem[]; source: LocalBackupEvidence[]
}
export interface RestoreExisting { size: number; sha256: string; dev: number; ino: number; mtimeMs: number; ctimeMs: number }
export interface StoredRestorePreview { preview: FileRestorePreview; items: FileRestorePreviewItem[]; existing: Record<string, RestoreExisting>; fingerprint: string }
export interface StoredRetentionPreview { preview: FileBackupRetentionPreview; objects: FileBackupRetentionObject[]; fingerprint: string }
export interface BackupObject extends FileBackupRetentionObject {
  planId: string; kind: 'data' | 'manifest'; remoteId?: string; verifiedAt?: number; error?: string
}
type JsonRow = { data: string }
type PreviewDocument = StoredBackupPreview | StoredRestorePreview | StoredRetentionPreview
export function initializeFileBackupSchema(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS file_backup_schema(version INTEGER NOT NULL);
      INSERT INTO file_backup_schema(version) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM file_backup_schema);`)
    const version = (db.prepare('SELECT version FROM file_backup_schema').get() as { version: number }).version
    if (version > 1) throw new Error('Unsupported file backup schema')
    if (version === 1) return
    db.exec(`
      CREATE TABLE file_backup_plans(id TEXT PRIMARY KEY,version INTEGER NOT NULL,data TEXT NOT NULL,container_id TEXT,container_state TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE file_backup_previews(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES file_backup_plans(id) ON DELETE CASCADE,kind TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX file_backup_previews_plan ON file_backup_previews(plan_id);
      CREATE TABLE file_backup_objects(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES file_backup_plans(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,remote_id TEXT,verified_at INTEGER,error TEXT,UNIQUE(plan_id,name));
      CREATE INDEX file_backup_objects_content ON file_backup_objects(plan_id,kind,sha256,size,state);
      CREATE TABLE file_backup_snapshots(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES file_backup_plans(id) ON DELETE CASCADE,
        status TEXT NOT NULL,data TEXT NOT NULL,manifest_object_id TEXT REFERENCES file_backup_objects(id));
      CREATE INDEX file_backup_snapshots_plan ON file_backup_snapshots(plan_id,status);
      CREATE TABLE file_backup_entries(snapshot_id TEXT NOT NULL REFERENCES file_backup_snapshots(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,
        relative_path TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(snapshot_id,relative_path));
      CREATE INDEX file_backup_entries_page ON file_backup_entries(snapshot_id,ordinal);
      CREATE TABLE file_backup_refs(snapshot_id TEXT NOT NULL REFERENCES file_backup_snapshots(id) ON DELETE CASCADE,
        object_id TEXT NOT NULL REFERENCES file_backup_objects(id),PRIMARY KEY(snapshot_id,object_id));
      CREATE INDEX file_backup_refs_object ON file_backup_refs(object_id,snapshot_id);
      CREATE TABLE file_backup_jobs(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES file_backup_plans(id) ON DELETE CASCADE,owner_token TEXT,data TEXT NOT NULL);
      CREATE INDEX file_backup_jobs_plan ON file_backup_jobs(plan_id);
      CREATE TABLE file_backup_job_items(job_id TEXT NOT NULL REFERENCES file_backup_jobs(id) ON DELETE CASCADE,item_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(job_id,item_id));
      UPDATE file_backup_schema SET version=1;
    `)
  })()
}

export class FileBackupStore {
  constructor(readonly db: Database.Database, readonly now: () => number = Date.now) {}
  plan(id: string): FileBackupPlan | undefined { const row = this.db.prepare('SELECT data FROM file_backup_plans WHERE id=?').get(id) as JsonRow | undefined; return row ? JSON.parse(row.data) : undefined }
  plans(): FileBackupPlan[] { return (this.db.prepare('SELECT data FROM file_backup_plans ORDER BY rowid DESC').all() as JsonRow[]).map(row => JSON.parse(row.data) as FileBackupPlan) }
  savePlan(input: FileBackupPlanInput): FileBackupPlan {
    const old = input.id ? this.plan(input.id) : undefined
    if (input.id && !old) throw new Error('PLAN_MISSING')
    if (old && old.version !== input.expectedVersion) throw new Error('PLAN_VERSION')
    const plan: FileBackupPlan = { id: old?.id ?? randomUUID(), version: (old?.version ?? 0) + 1, name: input.name, sourcePath: input.sourcePath,
      target: input.target, exclude: input.exclude, keepLast: input.keepLast, keepDays: input.keepDays, createdAt: old?.createdAt ?? this.now(), updatedAt: this.now(),
      latestSnapshotId: old?.latestSnapshotId, latestJobId: old?.latestJobId }
    this.db.prepare('INSERT INTO file_backup_plans(id,version,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data').run(plan.id, plan.version, JSON.stringify(plan))
    return plan
  }
  patchPlan(id: string, patch: Partial<Pick<FileBackupPlan, 'latestSnapshotId' | 'latestJobId'>>): void {
    const plan = this.plan(id)!
    this.db.prepare('UPDATE file_backup_plans SET data=? WHERE id=?').run(JSON.stringify({ ...plan, ...patch, updatedAt: this.now() }), id)
  }
  removePlan(id: string): void { this.db.prepare('DELETE FROM file_backup_plans WHERE id=?').run(id) }
  container(planId: string): { id?: string; state: 'pending' | 'dispatched' | 'verified' | 'uncertain' } {
    const row = this.db.prepare('SELECT container_id,container_state FROM file_backup_plans WHERE id=?').get(planId) as { container_id: string | null; container_state: 'pending' | 'dispatched' | 'verified' | 'uncertain' }
    return { id: row.container_id ?? undefined, state: row.container_state }
  }
  setContainer(planId: string, state: 'pending' | 'dispatched' | 'verified' | 'uncertain', id?: string): void {
    this.db.prepare('UPDATE file_backup_plans SET container_state=?,container_id=COALESCE(?,container_id) WHERE id=?').run(state, id ?? null, planId)
  }
  savePreview(kind: 'backup' | 'restore' | 'prune', document: PreviewDocument): void {
    this.db.prepare('INSERT INTO file_backup_previews(id,plan_id,kind,data) VALUES(?,?,?,?)').run(document.preview.id, document.preview.planId, kind, JSON.stringify(document))
  }
  preview<T extends PreviewDocument>(id: string, kind: 'backup' | 'restore' | 'prune'): T | undefined {
    const row = this.db.prepare('SELECT data FROM file_backup_previews WHERE id=? AND kind=?').get(id, kind) as JsonRow | undefined
    return row ? JSON.parse(row.data) as T : undefined
  }
  snapshot(id: string): FileBackupSnapshot | undefined {
    const row = this.db.prepare('SELECT data FROM file_backup_snapshots WHERE id=?').get(id) as JsonRow | undefined
    return row ? JSON.parse(row.data) as FileBackupSnapshot : undefined
  }
  snapshots(planId: string, includeDeleted = false): FileBackupSnapshot[] {
    return (this.db.prepare(`SELECT data FROM file_backup_snapshots WHERE plan_id=? ${includeDeleted ? '' : "AND status<>'deleted'"} ORDER BY rowid DESC`).all(planId) as JsonRow[]).map(row => JSON.parse(row.data) as FileBackupSnapshot)
  }
  patchSnapshot(id: string, patch: Partial<FileBackupSnapshot>): FileBackupSnapshot {
    const snapshot = { ...this.snapshot(id)!, ...patch }
    this.db.prepare('UPDATE file_backup_snapshots SET status=?,data=? WHERE id=?').run(snapshot.status, JSON.stringify(snapshot), id)
    return snapshot
  }
  createSnapshot(plan: FileBackupPlan, document: StoredBackupPreview): FileBackupSnapshot {
    const snapshot: FileBackupSnapshot = { id: randomUUID(), planId: plan.id, planVersion: plan.version, status: 'queued', fingerprint: document.preview.fingerprint,
      sourcePath: plan.sourcePath, createdAt: this.now(), fileCount: document.preview.fileCount, directoryCount: document.preview.directoryCount,
      totalBytes: document.preview.totalBytes, uploadedFiles: 0, reusedFiles: 0 }
    this.db.prepare('INSERT INTO file_backup_snapshots(id,plan_id,status,data) VALUES(?,?,?,?)').run(snapshot.id, plan.id, snapshot.status, JSON.stringify(snapshot))
    const insert = this.db.prepare('INSERT INTO file_backup_entries(snapshot_id,ordinal,relative_path,data) VALUES(?,?,?,?)')
    document.source.forEach((file, ordinal) => {
      const entry: FileBackupEntry = { relativePath: file.relativePath, isDir: file.isDir, size: file.size, sha256: file.sha256 }
      if (!entry.isDir) {
        const object = this.findObject(plan.id, entry.sha256!, entry.size) ?? this.createObject(plan.id, 'data', entry.sha256!, entry.size)
        entry.objectId = object.objectId; this.addReference(snapshot.id, object.objectId)
      }
      insert.run(snapshot.id, ordinal, entry.relativePath, JSON.stringify(entry))
    })
    this.patchPlan(plan.id, { latestSnapshotId: snapshot.id })
    return snapshot
  }
  entries(snapshotId: string): FileBackupEntry[] {
    return (this.db.prepare('SELECT data FROM file_backup_entries WHERE snapshot_id=? ORDER BY ordinal').all(snapshotId) as JsonRow[]).map(row => JSON.parse(row.data) as FileBackupEntry)
  }
  entryPage(snapshotId: string, page: number, pageSize: number): FileBackupEntry[] {
    return (this.db.prepare('SELECT data FROM file_backup_entries WHERE snapshot_id=? ORDER BY ordinal LIMIT ? OFFSET ?').all(snapshotId, pageSize, (page - 1) * pageSize) as JsonRow[]).map(row => JSON.parse(row.data) as FileBackupEntry)
  }
  manifestObject(snapshotId: string): BackupObject | undefined {
    const row = this.db.prepare('SELECT manifest_object_id id FROM file_backup_snapshots WHERE id=?').get(snapshotId) as { id: string | null } | undefined
    return row?.id ? this.object(row.id) : undefined
  }
  attachManifest(snapshotId: string, objectId: string): void {
    this.db.prepare('UPDATE file_backup_snapshots SET manifest_object_id=? WHERE id=?').run(objectId, snapshotId)
    this.addReference(snapshotId, objectId)
  }
  private toObject(row: Record<string, unknown>): BackupObject {
    const objectId = row.id as string
    const referenceCount = (this.db.prepare('SELECT COUNT(*) count FROM file_backup_refs WHERE object_id=?').get(objectId) as { count: number }).count
    return { objectId, planId: row.plan_id as string, kind: row.kind as BackupObject['kind'], sha256: row.sha256 as string, size: row.size as number,
      name: row.name as string, state: row.state as BackupObject['state'], remoteId: (row.remote_id ?? undefined) as string | undefined,
      verifiedAt: (row.verified_at ?? undefined) as number | undefined, error: (row.error ?? undefined) as string | undefined, referenceCount }
  }
  object(id: string): BackupObject | undefined {
    const row = this.db.prepare('SELECT * FROM file_backup_objects WHERE id=?').get(id) as Record<string, unknown> | undefined
    return row ? this.toObject(row) : undefined
  }
  findObject(planId: string, sha256: string, size: number): BackupObject | undefined {
    const row = this.db.prepare("SELECT * FROM file_backup_objects WHERE plan_id=? AND kind='data' AND sha256=? AND size=? AND state NOT IN ('deleted','corrupt') ORDER BY CASE WHEN state='verified' THEN 0 ELSE 1 END,rowid LIMIT 1")
      .get(planId, sha256, size) as Record<string, unknown> | undefined
    return row ? this.toObject(row) : undefined
  }
  createObject(planId: string, kind: BackupObject['kind'], sha256: string, size: number, name?: string): BackupObject {
    const id = randomUUID()
    this.db.prepare("INSERT INTO file_backup_objects(id,plan_id,kind,sha256,size,name,state) VALUES(?,?,?,?,?,?,'pending')")
      .run(id, planId, kind, sha256, size, name ?? `obj-${id}-${sha256}.bin`)
    return this.object(id)!
  }
  patchObject(id: string, patch: Partial<Pick<BackupObject, 'state' | 'remoteId' | 'verifiedAt' | 'error'>>): BackupObject {
    const item = { ...this.object(id)!, ...patch }
    this.db.prepare('UPDATE file_backup_objects SET state=?,remote_id=?,verified_at=?,error=? WHERE id=?').run(item.state, item.remoteId ?? null, item.verifiedAt ?? null, item.error ?? null, id)
    return item
  }
  references(objectId: string): string[] { return (this.db.prepare('SELECT snapshot_id id FROM file_backup_refs WHERE object_id=? ORDER BY snapshot_id').all(objectId) as { id: string }[]).map(row => row.id) }
  addReference(snapshotId: string, objectId: string): void { this.db.prepare('INSERT OR IGNORE INTO file_backup_refs(snapshot_id,object_id) VALUES(?,?)').run(snapshotId, objectId) }
  snapshotObjects(snapshotId: string): BackupObject[] {
    return (this.db.prepare('SELECT o.* FROM file_backup_refs r JOIN file_backup_objects o ON o.id=r.object_id WHERE r.snapshot_id=? ORDER BY o.id').all(snapshotId) as Record<string, unknown>[]).map(row => this.toObject(row))
  }
  deleteSnapshotReferences(snapshotId: string): void {
    this.db.prepare('DELETE FROM file_backup_refs WHERE snapshot_id=?').run(snapshotId)
    this.db.prepare('DELETE FROM file_backup_entries WHERE snapshot_id=?').run(snapshotId)
    this.db.prepare('UPDATE file_backup_snapshots SET manifest_object_id=NULL WHERE id=?').run(snapshotId)
    this.patchSnapshot(snapshotId, { status: 'deleted' })
  }
  createJob(planId: string, previewId: string, kind: FileBackupJob['kind'], totalItems: number, snapshotId?: string): FileBackupJob {
    const job: FileBackupJob = { id: randomUUID(), planId, previewId, kind, snapshotId, status: 'queued', totalItems, completedItems: 0, createdAt: this.now(), updatedAt: this.now() }
    this.db.prepare('INSERT INTO file_backup_jobs(id,plan_id,data) VALUES(?,?,?)').run(job.id, planId, JSON.stringify(job))
    this.patchPlan(planId, { latestJobId: job.id })
    return job
  }
  job(id: string): FileBackupJob | undefined { const row = this.db.prepare('SELECT data FROM file_backup_jobs WHERE id=?').get(id) as JsonRow | undefined; return row ? JSON.parse(row.data) : undefined }
  jobs(planId: string, limit: number | null = 200): FileBackupJob[] {
    return (this.db.prepare(`SELECT data FROM file_backup_jobs WHERE plan_id=? ORDER BY rowid DESC${limit === null ? '' : ' LIMIT ?'}`).all(...(limit === null ? [planId] : [planId, limit])) as JsonRow[]).map(row => JSON.parse(row.data) as FileBackupJob)
  }
  interruptedJobs(): FileBackupJob[] {
    return (this.db.prepare("SELECT data FROM file_backup_jobs WHERE json_extract(data,'$.status') IN ('queued','running') ORDER BY rowid").all() as JsonRow[]).map(row => JSON.parse(row.data) as FileBackupJob)
  }
  assertOwner(jobId: string, token: string): void {
    if (!this.db.prepare('SELECT 1 FROM file_backup_jobs WHERE id=? AND owner_token=?').get(jobId, token)) throw new Error('TASK_SUPERSEDED')
  }
  claimJob(jobId: string, taskId: string, token: string): FileBackupJob {
    const job = this.job(jobId)
    if (!job || job.taskId !== taskId || !token) throw new Error('TASK_SUPERSEDED')
    this.db.prepare('UPDATE file_backup_jobs SET owner_token=? WHERE id=?').run(token, jobId)
    return this.patchJob(jobId, { status: 'running', error: undefined }, token)
  }
  patchJob(id: string, patch: Partial<FileBackupJob>, token?: string): FileBackupJob {
    if (token) this.assertOwner(id, token)
    const job = { ...this.job(id)!, ...patch, updatedAt: this.now() }
    this.db.prepare('UPDATE file_backup_jobs SET data=? WHERE id=?').run(JSON.stringify(job), id)
    return job
  }
  putJobItem(id: string, item: Omit<FileBackupJobItem, 'updatedAt'>, token: string): void {
    this.assertOwner(id, token)
    this.db.prepare('INSERT INTO file_backup_job_items(job_id,item_id,data) VALUES(?,?,?) ON CONFLICT(job_id,item_id) DO UPDATE SET data=excluded.data')
      .run(id, item.itemId, JSON.stringify({ ...item, updatedAt: this.now() }))
    const completedItems = (this.db.prepare("SELECT COUNT(*) count FROM file_backup_job_items WHERE job_id=? AND json_extract(data,'$.status')='success'").get(id) as { count: number }).count
    this.patchJob(id, { completedItems }, token)
  }
  jobItems(id: string): FileBackupJobItem[] { return (this.db.prepare('SELECT data FROM file_backup_job_items WHERE job_id=? ORDER BY rowid').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as FileBackupJobItem) }
}
