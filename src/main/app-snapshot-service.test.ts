import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { AppSnapshotService, processPendingAppSnapshotOperation, type AppSnapshotOptions } from './app-snapshot-service'
import type { AppSnapshotResult } from '../shared/app-snapshots'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function ok<T extends object>(result: AppSnapshotResult<T>): T { if (result.success === false) throw new Error(`${result.code}: ${result.error}`); return result }
const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
function fixture() {
  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-app-snapshot-test-'))
  cleanup.push(() => fs.rmSync(profilePath, { recursive: true, force: true }))
  const databasePath = path.join(profilePath, 'panlite.db')
  // Exit without db.close(): the subsequent backup must include committed WAL
  // pages. The profile has no open writer when the bootstrap operation starts.
  const setup = spawnSync(process.execPath, ['-e', `const Database=require('better-sqlite3'); const db=new Database(process.argv[1]);
    db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0');
    db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE _migrations(id TEXT PRIMARY KEY); CREATE TABLE catalog_schema(version INTEGER); CREATE TABLE ai_documents(id TEXT,source_path TEXT); INSERT INTO catalog_schema VALUES(1); INSERT INTO _migrations VALUES('001_base'); INSERT INTO settings VALUES('fixture','before'); INSERT INTO settings VALUES('credential','DPAPI-ENCRYPTED-BYTES');");
    db.prepare('INSERT INTO ai_documents VALUES(?,?)').run('managed',process.argv[2]);
    db.prepare('INSERT INTO ai_documents VALUES(?,?)').run('external','D:/outside/user-original.pdf'); process.exit(0);`, databasePath, path.join(profilePath, 'ai-attachments', 'documents', 'note.txt')], { cwd: process.cwd(), env: process.env, encoding: 'utf8' })
  if (setup.status !== 0) throw new Error(setup.stderr)
  expect(fs.existsSync(databasePath + '-wal')).toBe(true)
  fs.mkdirSync(path.join(profilePath, 'ai-attachments', 'documents'), { recursive: true })
  fs.mkdirSync(path.join(profilePath, 'ai-attachments', 'empty'), { recursive: true })
  fs.writeFileSync(path.join(profilePath, 'ai-attachments', 'documents', 'note.txt'), 'before attachment')
  fs.writeFileSync(path.join(profilePath, 'url-crypto.key'), 'PROTECTED-URL-KEY')
  for (const name of ['Cookies', 'Local State', 'unmanaged-user-note.txt']) fs.writeFileSync(path.join(profilePath, name), `keep ${name}`)
  for (const directory of ['ai-cloud-downloads', 'Cache', 'Partitions', 'transfer-resume']) { fs.mkdirSync(path.join(profilePath, directory)); fs.writeFileSync(path.join(profilePath, directory, 'temporary'), 'excluded') }
  const options: AppSnapshotOptions = { profilePath, appVersion: '0.2.0', supportedMigrationIds: ['001_base'], supportedSchemaVersions: { catalog_schema: 1 }, machineId: 'same-user-same-machine' }
  const service = new AppSnapshotService(options)
  const readValue = (): string => { const db = new Database(databasePath); try { return (db.prepare("SELECT value FROM settings WHERE key='fixture'").get() as { value: string }).value } finally { db.close() } }
  const change = (): void => {
    const db = new Database(databasePath); try { db.prepare("UPDATE settings SET value='after' WHERE key='fixture'").run() } finally { db.close() }
    fs.writeFileSync(path.join(profilePath, 'ai-attachments', 'documents', 'note.txt'), 'after attachment')
    fs.writeFileSync(path.join(profilePath, 'ai-attachments', 'added.txt'), 'new attachment')
    fs.writeFileSync(path.join(profilePath, 'url-crypto.key'), 'NEW-PROTECTED-KEY')
  }
  const snapshot = async (): Promise<string> => {
    const request = ok(await service.requestSnapshot('恢复点'))
    await processPendingAppSnapshotOperation(profilePath, options)
    return request.pending.snapshotId
  }
  return { profilePath, databasePath, options, service, readValue, change, snapshot }
}
function rewriteManifest(directory: string, change: (manifest: Record<string, any>) => void): void {
  const file = path.join(directory, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  change(manifest)
  const data = JSON.stringify(manifest)
  fs.writeFileSync(file, data); fs.writeFileSync(path.join(directory, 'READY'), JSON.stringify({ manifestSha256: digest(data) }))
}

describe('application snapshots before database initialization', () => {
  it('captures committed WAL data, protected keys, AI attachments and empty directories in an explicit scope', async () => {
    const f = fixture(), id = await f.snapshot()
    const inspected = ok(await f.service.inspectSnapshot(id))
    expect(inspected).toMatchObject({ verified: true, migrationIds: ['001_base'], schemaVersions: { catalog_schema: 1 }, snapshot: { state: 'ready', sameMachineOnly: true, externalAiSources: 1 } })
    expect(inspected.files.map(file => file.path)).toEqual(['ai-attachments/documents/note.txt', 'panlite.db', 'url-crypto.key'])
    const snapshotRoot = path.join(f.profilePath, 'app-snapshots', id)
    const db = new Database(path.join(snapshotRoot, 'data', 'panlite.db'), { readonly: true })
    try {
      expect(db.prepare("SELECT value FROM settings WHERE key='fixture'").get()).toEqual({ value: 'before' })
      expect(db.prepare("SELECT value FROM settings WHERE key='credential'").get()).toEqual({ value: 'DPAPI-ENCRYPTED-BYTES' })
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    } finally { db.close() }
    expect(fs.existsSync(path.join(snapshotRoot, 'data', 'ai-attachments', 'empty'))).toBe(true)
    expect(fs.existsSync(path.join(snapshotRoot, 'data', 'Cookies'))).toBe(false)
    expect(ok(await f.service.getPendingOperation()).pending).toBeNull()
  })
  it('only records a restart request while the running application can continue using its database', async () => {
    const f = fixture(), db = new Database(f.databasePath)
    try {
      const request = ok(await f.service.requestSnapshot('用户确认的重启请求'))
      expect(request.restartRequired).toBe(true)
      expect(ok(await f.service.listSnapshots()).snapshots).toHaveLength(0)
      db.prepare("UPDATE settings SET value='latest-before-exit' WHERE key='fixture'").run()
      expect(await f.service.requestSnapshot('重复')).toMatchObject({ success: false, code: 'SNAPSHOT_BUSY' })
    } finally { db.close() }
    await processPendingAppSnapshotOperation(f.profilePath, f.options)
    expect(ok(await f.service.listSnapshots()).snapshots).toHaveLength(1)
  })
  it('restores exactly managed roots, retains a usable rollback snapshot, and preserves browser/session files', async () => {
    const f = fixture(), id = await f.snapshot()
    f.change(); ok(await f.service.requestRestore(id))
    expect(f.readValue()).toBe('after')
    const result = await processPendingAppSnapshotOperation(f.profilePath, f.options)
    expect(result.rollbackSnapshotId).toBeTruthy()
    expect(f.readValue()).toBe('before')
    expect(fs.readFileSync(path.join(f.profilePath, 'ai-attachments', 'documents', 'note.txt'), 'utf8')).toBe('before attachment')
    expect(fs.existsSync(path.join(f.profilePath, 'ai-attachments', 'added.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(f.profilePath, 'url-crypto.key'), 'utf8')).toBe('PROTECTED-URL-KEY')
    expect(fs.readFileSync(path.join(f.profilePath, 'Cookies'), 'utf8')).toBe('keep Cookies')
    expect(fs.readFileSync(path.join(f.profilePath, 'unmanaged-user-note.txt'), 'utf8')).toBe('keep unmanaged-user-note.txt')
    expect(fs.readFileSync(path.join(f.profilePath, 'transfer-resume', 'temporary'), 'utf8')).toBe('excluded')
    ok(await f.service.requestRestore(result.rollbackSnapshotId!))
    await processPendingAppSnapshotOperation(f.profilePath, f.options)
    expect(f.readValue()).toBe('after')
    expect(fs.existsSync(path.join(f.profilePath, 'ai-attachments', 'added.txt'))).toBe(true)
  })
  it.each(['after-original:panlite.db', 'after-installed:panlite.db', 'after-installed:ai-attachments', 'restore-committed'])('resumes an interrupted restore at %s before allowing database initialization', async point => {
    const f = fixture(), id = await f.snapshot()
    f.change(); ok(await f.service.requestRestore(id))
    await expect(processPendingAppSnapshotOperation(f.profilePath, { ...f.options, checkpoint: name => { if (name === point) throw new Error('simulated process interruption') } })).rejects.toMatchObject({ code: 'SNAPSHOT_STARTUP_FAILED' })
    expect(ok(await f.service.getPendingOperation()).pending).toMatchObject({ status: 'failed', canCancel: point === 'restore-committed' })
    if (point !== 'restore-committed') expect(await f.service.cancelPendingOperation()).toMatchObject({ success: false, code: 'RESTORE_IN_PROGRESS' })
    const restarted = await processPendingAppSnapshotOperation(f.profilePath, f.options)
    expect(restarted).toMatchObject({ processed: true, kind: 'restore', recovered: true })
    expect(f.readValue()).toBe('before')
    expect(fs.readFileSync(path.join(f.profilePath, 'ai-attachments', 'documents', 'note.txt'), 'utf8')).toBe('before attachment')
    expect(ok(await f.service.getPendingOperation()).pending).toBeNull()
  })
  it('does not advertise an incomplete snapshot when a managed AI attachment referenced by SQLite is missing', async () => {
    const f = fixture(); fs.unlinkSync(path.join(f.profilePath, 'ai-attachments', 'documents', 'note.txt'))
    ok(await f.service.requestSnapshot('必须失败'))
    await expect(processPendingAppSnapshotOperation(f.profilePath, f.options)).rejects.toThrow('持久 AI 附件缺失')
    expect(ok(await f.service.listSnapshots()).snapshots).toHaveLength(0)
    expect(ok(await f.service.getPendingOperation()).pending).toMatchObject({ status: 'failed', canCancel: true })
    ok(await f.service.cancelPendingOperation())
    expect(f.readValue()).toBe('before')
  })
  it('rejects corrupted or missing snapshot files before touching the live profile', async () => {
    const f = fixture(), id = await f.snapshot(), snapshot = path.join(f.profilePath, 'app-snapshots', id)
    f.change()
    fs.writeFileSync(path.join(snapshot, 'data', 'ai-attachments', 'documents', 'note.txt'), 'corruption')
    expect(await f.service.inspectSnapshot(id)).toMatchObject({ success: false })
    expect(await f.service.requestRestore(id)).toMatchObject({ success: false })
    expect(ok(await f.service.listSnapshots()).snapshots[0].state).toBe('invalid')
    expect(f.readValue()).toBe('after')
  })
  it('rejects a forged traversal path even when its ready-marker checksum is recomputed', async () => {
    const f = fixture(), id = await f.snapshot(), snapshot = path.join(f.profilePath, 'app-snapshots', id)
    const outside = path.join(f.profilePath, 'unmanaged-user-note.txt')
    rewriteManifest(snapshot, manifest => { manifest.files[0].path = '../unmanaged-user-note.txt' })
    expect(await f.service.requestRestore(id)).toMatchObject({ success: false })
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep unmanaged-user-note.txt')
    expect(f.readValue()).toBe('before')
  })
  it('rejects future database migrations and leaves a visible failed startup request without mutating current data', async () => {
    const f = fixture(), id = await f.snapshot(), snapshot = path.join(f.profilePath, 'app-snapshots', id), file = path.join(snapshot, 'data', 'panlite.db')
    const db = new Database(file); db.prepare('INSERT INTO _migrations VALUES(?)').run('999_future'); db.close()
    rewriteManifest(snapshot, manifest => {
      manifest.migrationIds.push('999_future')
      const entry = manifest.files.find((entry: { path: string }) => entry.path === 'panlite.db')
      const bytes = fs.readFileSync(file); entry.size = bytes.length; entry.sha256 = digest(bytes)
      manifest.snapshot.totalBytes = manifest.files.reduce((sum: number, entry: { size: number }) => sum + entry.size, 0)
    })
    f.change()
    expect(await f.service.inspectSnapshot(id)).toMatchObject({ success: false, code: 'SNAPSHOT_SCHEMA_INCOMPATIBLE' })
    expect(await f.service.requestRestore(id)).toMatchObject({ success: false, code: 'SNAPSHOT_SCHEMA_INCOMPATIBLE' })
    expect(ok(await f.service.getPendingOperation()).pending).toBeNull()
    // A request prepared by a newer binary still has to pass the older
    // binary's startup compatibility gate after a downgrade.
    ok(await new AppSnapshotService({ ...f.options, supportedMigrationIds: ['001_base', '999_future'] }).requestRestore(id))
    await expect(processPendingAppSnapshotOperation(f.profilePath, f.options)).rejects.toMatchObject({ code: 'SNAPSHOT_SCHEMA_INCOMPATIBLE' })
    expect(f.readValue()).toBe('after')
    expect(ok(await f.service.getPendingOperation()).pending).toMatchObject({ status: 'failed' })
    ok(await f.service.cancelPendingOperation())
  })
  it('refuses another machine identity and rejects symlinked managed attachment trees', async () => {
    const f = fixture(), id = await f.snapshot()
    expect(await new AppSnapshotService({ ...f.options, machineId: 'another-machine' }).requestRestore(id)).toMatchObject({ success: false, code: 'SNAPSHOT_MACHINE_MISMATCH' })
    const external = path.join(f.profilePath, 'Cache')
    fs.symlinkSync(external, path.join(f.profilePath, 'ai-attachments', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    ok(await f.service.requestSnapshot('不能跟随目录联接'))
    await expect(processPendingAppSnapshotOperation(f.profilePath, f.options)).rejects.toThrow('符号链接')
    expect(fs.readFileSync(path.join(external, 'temporary'), 'utf8')).toBe('excluded')
  })
  it('rejects a malformed SQLite database even when the file and manifest checksums have been recomputed', async () => {
    const f = fixture(), id = await f.snapshot(), snapshot = path.join(f.profilePath, 'app-snapshots', id), file = path.join(snapshot, 'data', 'panlite.db')
    const bytes = fs.readFileSync(file); bytes.fill(0, 0, 128); fs.writeFileSync(file, bytes)
    rewriteManifest(snapshot, manifest => { manifest.files.find((entry: { path: string }) => entry.path === 'panlite.db').sha256 = digest(bytes) })
    f.change()
    expect(await f.service.requestRestore(id)).toMatchObject({ success: false })
    expect(f.readValue()).toBe('after')
    expect(ok(await f.service.getPendingOperation()).pending).toBeNull()
  })
  it('rejects newer independent module schema versions before the first replacement', async () => {
    const f = fixture(), id = await f.snapshot(), snapshot = path.join(f.profilePath, 'app-snapshots', id), file = path.join(snapshot, 'data', 'panlite.db')
    const db = new Database(file); db.prepare('UPDATE catalog_schema SET version=2').run(); db.close()
    rewriteManifest(snapshot, manifest => {
      manifest.schemaVersions.catalog_schema = 2
      const entry = manifest.files.find((entry: { path: string }) => entry.path === 'panlite.db'), bytes = fs.readFileSync(file)
      entry.sha256 = digest(bytes); entry.size = bytes.length
      manifest.snapshot.totalBytes = manifest.files.reduce((sum: number, item: { size: number }) => sum + item.size, 0)
    })
    f.change()
    expect(await f.service.inspectSnapshot(id)).toMatchObject({ success: false, code: 'SNAPSHOT_SCHEMA_INCOMPATIBLE' })
    expect(await f.service.requestRestore(id)).toMatchObject({ success: false, code: 'SNAPSHOT_SCHEMA_INCOMPATIBLE' })
    expect(ok(await f.service.getPendingOperation()).pending).toBeNull()
    ok(await new AppSnapshotService({ ...f.options, supportedSchemaVersions: { catalog_schema: 2 } }).requestRestore(id))
    await expect(processPendingAppSnapshotOperation(f.profilePath, f.options)).rejects.toMatchObject({ code: 'SNAPSHOT_SCHEMA_INCOMPATIBLE' })
    expect(f.readValue()).toBe('after')
    expect(fs.readFileSync(path.join(f.profilePath, 'url-crypto.key'), 'utf8')).toBe('NEW-PROTECTED-KEY')
  })
  it('validates persisted restore-root paths before resuming a tampered transaction', async () => {
    const f = fixture(), id = await f.snapshot(); f.change()
    const operation = ok(await f.service.requestRestore(id)).pending
    await expect(processPendingAppSnapshotOperation(f.profilePath, { ...f.options, checkpoint: point => { if (point === 'restore-prepared') throw new Error('interrupted') } })).rejects.toThrow()
    const journalPath = path.join(f.profilePath, 'app-snapshot-state', `operation-${operation.id}`, 'restore-journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')); journal.roots[0].name = '../unmanaged-user-note.txt'; fs.writeFileSync(journalPath, JSON.stringify(journal))
    await expect(processPendingAppSnapshotOperation(f.profilePath, f.options)).rejects.toThrow('恢复事务记录损坏')
    expect(f.readValue()).toBe('after')
    expect(fs.readFileSync(path.join(f.profilePath, 'unmanaged-user-note.txt'), 'utf8')).toBe('keep unmanaged-user-note.txt')
  })
})
