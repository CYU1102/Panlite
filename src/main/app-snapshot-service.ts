import Database from 'better-sqlite3'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { AppSnapshotInfo, AppSnapshotInspection, AppSnapshotResult, AppSnapshotsApi, PendingAppSnapshotOperation } from '../shared/app-snapshots'
import { AppSnapshotError, SNAPSHOT_FORMAT, SNAPSHOT_ROOTS, RESTORE_ROOTS, UUID_PATTERN, copyVerified, durableJson, exists, fileDigest, ownedDirectory, readJson, regular, removeOwnedChild, safeRelative, sha256Text, syncDirectory, syncFile, tree } from './app-snapshot-files'
export { AppSnapshotError } from './app-snapshot-files'

export interface AppSnapshotOptions {
  profilePath: string
  appVersion: string
  supportedMigrationIds?: readonly string[]
  supportedSchemaVersions?: Readonly<Record<string, number>>
  /** Optional stronger host/user binding supplied by the application. */
  machineId?: string
  /** Fault injection for crash-recovery tests only. */
  checkpoint?: (point: string) => void | Promise<void>
}
interface Manifest extends AppSnapshotInspection {
  format: typeof SNAPSHOT_FORMAT
  machineHash: string
  directories: string[]
  managedAiReferences: string[]
}
interface RootStep { name: typeof RESTORE_ROOTS[number]; hadOriginal: boolean; hasReplacement: boolean; state: 'pending' | 'original-moved' | 'installed' }
interface RestoreJournal {
  format: typeof SNAPSHOT_FORMAT; operationId: string; snapshotId: string; rollbackSnapshotId: string; appVersion: string
  manifestHash: string; phase: 'applying' | 'committed'; roots: RootStep[]
}
interface Layout { profile: string; snapshots: string; state: string; pendingPath: string }
const running = new Set<string>()
const ROOT_NAMES = [...SNAPSHOT_ROOTS]
const identifier = (value: unknown): string => { if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new AppSnapshotError('快照标识不正确'); return value }
const fixedError = (error: unknown): string => error instanceof AppSnapshotError ? error.message : '应用快照处理失败，原有文件及回滚副本已保留'

async function layout(options: AppSnapshotOptions): Promise<Layout> {
  if (!options.appVersion || options.appVersion.length > 64) throw new AppSnapshotError('应用版本不正确')
  await fsp.mkdir(path.resolve(options.profilePath), { recursive: true })
  await regular(path.resolve(options.profilePath), true)
  const profile = await fsp.realpath(options.profilePath)
  const snapshots = await ownedDirectory(profile, 'app-snapshots'), state = await ownedDirectory(profile, 'app-snapshot-state')
  return { profile, snapshots, state, pendingPath: path.join(state, 'pending.json') }
}
function machineHash(options: AppSnapshotOptions, profile: string): string {
  return sha256Text(JSON.stringify([options.machineId ?? `${process.platform}:${os.hostname()}:${os.userInfo().username}`, process.platform === 'win32' ? profile.toLowerCase() : profile]))
}
async function pending(layout: Layout): Promise<PendingAppSnapshotOperation | null> {
  if (!await exists(layout.pendingPath)) return null
  const operation = await readJson(layout.pendingPath, 8192) as PendingAppSnapshotOperation
  identifier(operation?.id); identifier(operation?.snapshotId)
  if (!['snapshot', 'restore'].includes(operation.kind) || !['requested', 'running', 'failed'].includes(operation.status) || !Number.isFinite(operation.requestedAt)) throw new AppSnapshotError('待执行快照请求已损坏')
  return operation
}
function databaseMetadata(database: Database.Database): { migrationIds: string[]; schemaVersions: Record<string, number>; externalAiSources: number } {
  const names = (database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name)
  const migrationIds = names.includes('_migrations') ? (database.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: string }[]).map(row => row.id) : []
  const schemaVersions: Record<string, number> = {}
  for (const name of names.filter(name => /^[a-z_]+_schema$/.test(name))) {
    const columns = database.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]
    if (!columns.some(column => column.name === 'version')) continue
    const rows = database.prepare(`SELECT version FROM "${name}"`).all() as { version: number }[]
    if (rows.length !== 1 || !Number.isSafeInteger(rows[0].version) || rows[0].version < 0) throw new AppSnapshotError('数据库独立模块版本不正确')
    schemaVersions[name] = rows[0].version
  }
  // AI imports currently retain references to external originals or temporary
  // cloud downloads. Their parsed chunks/conversations are in panlite.db.
  let externalAiSources = 0
  if (names.includes('ai_documents')) {
    const columns = database.prepare('PRAGMA table_info(ai_documents)').all() as { name: string }[]
    if (columns.some(column => column.name === 'source_path')) externalAiSources = (database.prepare("SELECT count(*) n FROM ai_documents WHERE source_path IS NOT NULL AND source_path<>''").get() as { n: number }).n
  }
  return { migrationIds, schemaVersions, externalAiSources }
}
function integrity(database: Database.Database): void {
  const rows = database.pragma('integrity_check') as Array<{ integrity_check: string }>
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new AppSnapshotError('数据库完整性检查失败')
}
function aiReferences(database: Database.Database, profile: string): { managed: string[]; external: number } {
  const present = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_documents'").get()
  if (!present || !(database.prepare('PRAGMA table_info(ai_documents)').all() as { name: string }[]).some(column => column.name === 'source_path')) return { managed: [], external: 0 }
  const rows = database.prepare("SELECT source_path FROM ai_documents WHERE source_path IS NOT NULL AND source_path<>''").all() as { source_path: string }[]
  const managed = new Set<string>(); let external = 0
  for (const row of rows) {
    const relative = path.relative(profile, path.resolve(row.source_path)).split(path.sep).join('/')
    if (relative.startsWith('ai-attachments/')) managed.add(safeRelative(relative))
    else external++
  }
  return { managed: [...managed].sort(), external }
}
async function sqliteMetadata(file: string): Promise<ReturnType<typeof databaseMetadata>> {
  await regular(file)
  const database = new Database(file, { readonly: true, fileMustExist: true })
  try { integrity(database); return databaseMetadata(database) } finally { database.close() }
}
function validateManifest(value: unknown): Manifest {
  const manifest = value as Manifest, info = manifest?.snapshot
  if (manifest?.format !== SNAPSHOT_FORMAT || !info || info.formatVersion !== 1 || info.state !== 'ready' || !info.sameMachineOnly
    || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories) || manifest.files.length + manifest.directories.length > 100_000
    || !Array.isArray(manifest.migrationIds) || !Array.isArray(manifest.managedAiReferences) || !manifest.schemaVersions || typeof manifest.schemaVersions !== 'object' || Array.isArray(manifest.schemaVersions)
    || !/^[a-f\d]{64}$/.test(manifest.machineHash) || !Array.isArray(info.managedRoots) || JSON.stringify(info.managedRoots) !== JSON.stringify(ROOT_NAMES)) throw new AppSnapshotError('快照格式或完成状态不正确')
  identifier(info.id)
  const seen = new Set<string>()
  for (const entry of manifest.files) {
    const relative = safeRelative(entry.path), key = relative.toLowerCase()
    if (seen.has(key) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f\d]{64}$/.test(entry.sha256)) throw new AppSnapshotError('快照文件清单不正确')
    seen.add(key)
  }
  for (const directory of manifest.directories) {
    const relative = safeRelative(directory, true), key = relative.toLowerCase()
    if (seen.has(key)) throw new AppSnapshotError('快照路径重复或类型冲突')
    seen.add(key)
  }
  if (manifest.files.filter(entry => entry.path === 'panlite.db').length !== 1 || info.fileCount !== manifest.files.length
    || info.totalBytes !== manifest.files.reduce((sum, entry) => sum + entry.size, 0)) throw new AppSnapshotError('快照缺少数据库或文件统计不一致')
  if (manifest.migrationIds.some(id => typeof id !== 'string' || id.length > 256)) throw new AppSnapshotError('数据库迁移清单不正确')
  for (const reference of manifest.managedAiReferences) if (!safeRelative(reference).startsWith('ai-attachments/') || !manifest.files.some(entry => entry.path === reference)) throw new AppSnapshotError('快照遗漏了数据库引用的持久 AI 附件')
  for (const [name, version] of Object.entries(manifest.schemaVersions)) if (!/^[a-z_]+_schema$/.test(name) || !Number.isSafeInteger(version) || version < 0) throw new AppSnapshotError('数据库模块版本清单不正确')
  return manifest
}
async function readManifest(directory: string): Promise<Manifest> {
  await regular(directory, true)
  const manifestPath = path.join(directory, 'manifest.json'), ready = await readJson(path.join(directory, 'READY'), 1024) as { manifestSha256?: string }
  const digest = await fileDigest(manifestPath)
  if (digest.sha256 !== ready.manifestSha256) throw new AppSnapshotError('快照完成标记与清单不一致')
  return validateManifest(await readJson(manifestPath))
}
async function verifyContent(root: string, manifest: Manifest): Promise<void> {
  await regular(root, true)
  if ((await fsp.readdir(root)).some(name => !ROOT_NAMES.includes(name as typeof ROOT_NAMES[number]))) throw new AppSnapshotError('快照数据目录包含未登记文件')
  const actual = await tree(root)
  if (JSON.stringify(actual.files) !== JSON.stringify(manifest.files) || JSON.stringify(actual.directories) !== JSON.stringify(manifest.directories)) throw new AppSnapshotError('快照文件缺失、损坏或存在未登记文件')
  const metadata = await sqliteMetadata(path.join(root, 'panlite.db'))
  if (JSON.stringify(metadata.migrationIds) !== JSON.stringify(manifest.migrationIds) || JSON.stringify(metadata.schemaVersions) !== JSON.stringify(manifest.schemaVersions)) throw new AppSnapshotError('数据库版本与快照清单不一致')
}
async function compatibility(manifest: Manifest, options: AppSnapshotOptions, paths: Layout, readCurrent = true): Promise<void> {
  if (manifest.machineHash !== machineHash(options, paths.profile)) throw new AppSnapshotError('仅支持同一台机器、同一系统用户和原应用目录内恢复；凭据不可跨机器迁移', 'SNAPSHOT_MACHINE_MISMATCH')
  let current: ReturnType<typeof databaseMetadata> | undefined
  if (readCurrent && (!options.supportedMigrationIds || !options.supportedSchemaVersions) && await exists(path.join(paths.profile, 'panlite.db'))) current = await sqliteMetadata(path.join(paths.profile, 'panlite.db'))
  if (!options.supportedMigrationIds && manifest.snapshot.appVersion !== options.appVersion) throw new AppSnapshotError('应用版本不兼容，无法确认数据库迁移支持范围', 'SNAPSHOT_SCHEMA_INCOMPATIBLE')
  const ids = options.supportedMigrationIds ?? current?.migrationIds ?? []
  const versions = options.supportedSchemaVersions ?? current?.schemaVersions ?? {}
  if (manifest.migrationIds.some(id => !ids.includes(id)) || Object.entries(manifest.schemaVersions).some(([name, version]) => versions[name] === undefined || version > versions[name])) throw new AppSnapshotError('快照数据库版本高于当前应用支持范围', 'SNAPSHOT_SCHEMA_INCOMPATIBLE')
}
async function capture(paths: Layout, options: AppSnapshotOptions, snapshotId: string, name: string, workspace: string): Promise<Manifest> {
  const destination = path.join(paths.snapshots, snapshotId)
  if (await exists(destination)) {
    const existing = await readManifest(destination); await verifyContent(path.join(destination, 'data'), existing); return existing
  }
  await removeOwnedChild(workspace, 'capture')
  const staging = path.join(workspace, 'capture'), data = path.join(staging, 'data')
  await fsp.mkdir(data, { recursive: true })
  const sourceDatabase = path.join(paths.profile, 'panlite.db')
  await regular(sourceDatabase)
  const database = new Database(sourceDatabase, { readonly: true, fileMustExist: true })
  try { integrity(database); await database.backup(path.join(data, 'panlite.db')) } finally { database.close() }
  const backedUp = new Database(path.join(data, 'panlite.db'))
  let metadata: ReturnType<typeof databaseMetadata>
  let references: ReturnType<typeof aiReferences>
  try { backedUp.pragma('journal_mode=DELETE'); integrity(backedUp); metadata = databaseMetadata(backedUp); references = aiReferences(backedUp, paths.profile) } finally { backedUp.close() }
  await syncFile(path.join(data, 'panlite.db'))
  const before = await tree(paths.profile)
  for (const directory of before.directories) await fsp.mkdir(path.join(data, ...directory.split('/')), { recursive: true })
  for (const entry of before.files.filter(entry => entry.path !== 'panlite.db')) await copyVerified(paths.profile, data, entry)
  const after = await tree(paths.profile)
  const attachments = (entries: Awaited<ReturnType<typeof tree>>) => ({ files: entries.files.filter(entry => entry.path !== 'panlite.db'), directories: entries.directories })
  if (JSON.stringify(attachments(before)) !== JSON.stringify(attachments(after))) throw new AppSnapshotError('附件在快照过程中发生变化，快照未完成')
  const contents = await tree(data)
  for (const reference of references.managed) if (!contents.files.some(entry => entry.path === reference)) throw new AppSnapshotError('持久 AI 附件缺失，快照不能标记为完成')
  const info: AppSnapshotInfo = { id: snapshotId, name, createdAt: Date.now(), appVersion: options.appVersion, formatVersion: 1, state: 'ready',
    fileCount: contents.files.length, totalBytes: contents.files.reduce((sum, entry) => sum + entry.size, 0), sameMachineOnly: true, managedRoots: ROOT_NAMES,
    externalAiSources: references.external }
  const manifest: Manifest = { format: SNAPSHOT_FORMAT, snapshot: info, files: contents.files, directories: contents.directories,
    migrationIds: metadata.migrationIds, schemaVersions: metadata.schemaVersions, verified: true, machineHash: machineHash(options, paths.profile), managedAiReferences: references.managed }
  await durableJson(path.join(staging, 'manifest.json'), manifest)
  await verifyContent(data, manifest)
  await durableJson(path.join(staging, 'READY'), { manifestSha256: (await fileDigest(path.join(staging, 'manifest.json'))).sha256 })
  await options.checkpoint?.('snapshot-ready')
  await fsp.rename(staging, destination); await syncDirectory(paths.snapshots)
  return manifest
}
async function verifyInstalledRoot(profile: string, name: typeof RESTORE_ROOTS[number], manifest: Manifest): Promise<void> {
  if (name.endsWith('-wal') || name.endsWith('-shm')) { if (await exists(path.join(profile, name))) throw new AppSnapshotError('恢复后的数据库仍有旧日志文件'); return }
  const expectedFiles = manifest.files.filter(entry => entry.path === name || entry.path.startsWith(name + '/'))
  const expectedDirectories = manifest.directories.filter(entry => entry === name || entry.startsWith(name + '/'))
  if (!expectedFiles.length && !expectedDirectories.length) { if (await exists(path.join(profile, name))) throw new AppSnapshotError('恢复目标包含意外文件'); return }
  for (const directory of expectedDirectories) await regular(path.join(profile, ...directory.split('/')), true)
  for (const entry of expectedFiles) {
    const actual = await fileDigest(path.join(profile, ...entry.path.split('/')))
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new AppSnapshotError('已恢复文件校验失败，应用不会打开部分数据')
  }
}
async function restore(paths: Layout, options: AppSnapshotOptions, operation: PendingAppSnapshotOperation, workspace: string): Promise<string> {
  const journalPath = path.join(workspace, 'restore-journal.json'), manifestPath = path.join(workspace, 'restore-manifest.json')
  let journal: RestoreJournal, manifest: Manifest
  if (await exists(journalPath)) {
    journal = await readJson(journalPath, 8192) as RestoreJournal
    manifest = validateManifest(await readJson(manifestPath))
    if (journal.format !== SNAPSHOT_FORMAT || journal.operationId !== operation.id || journal.snapshotId !== operation.snapshotId || journal.appVersion !== options.appVersion
      || journal.manifestHash !== (await fileDigest(manifestPath)).sha256 || !['applying', 'committed'].includes(journal.phase)
      || !Array.isArray(journal.roots) || JSON.stringify(journal.roots.map(step => step.name)) !== JSON.stringify(RESTORE_ROOTS)
      || journal.roots.some(step => typeof step.hadOriginal !== 'boolean' || typeof step.hasReplacement !== 'boolean' || !['pending', 'original-moved', 'installed'].includes(step.state))) throw new AppSnapshotError('恢复事务记录损坏或应用版本变化，不能打开部分数据')
    identifier(journal.rollbackSnapshotId)
    if (manifest.machineHash !== machineHash(options, paths.profile)) throw new AppSnapshotError('恢复事务不属于当前应用目录')
  } else {
    const source = path.join(paths.snapshots, operation.snapshotId)
    manifest = await readManifest(source); await verifyContent(path.join(source, 'data'), manifest)
    await compatibility(manifest, options, paths)
    await removeOwnedChild(workspace, 'staged')
    const staged = path.join(workspace, 'staged'); await fsp.mkdir(staged)
    for (const directory of manifest.directories) await fsp.mkdir(path.join(staged, ...directory.split('/')), { recursive: true })
    for (const entry of manifest.files) await copyVerified(path.join(source, 'data'), staged, entry)
    await verifyContent(staged, manifest)
    const rollbackSnapshotId = randomUUID()
    await capture(paths, options, rollbackSnapshotId, `恢复前回滚副本 · ${manifest.snapshot.name}`, workspace)
    await fsp.mkdir(path.join(workspace, 'originals'), { recursive: true })
    const roots: RootStep[] = []
    for (const name of RESTORE_ROOTS) {
      if (await exists(path.join(paths.profile, name))) await regular(path.join(paths.profile, name), name === 'ai-attachments')
      roots.push({ name, hadOriginal: await exists(path.join(paths.profile, name)), hasReplacement: await exists(path.join(staged, name)), state: 'pending' })
    }
    await durableJson(manifestPath, manifest)
    journal = { format: SNAPSHOT_FORMAT, operationId: operation.id, snapshotId: operation.snapshotId, rollbackSnapshotId, appVersion: options.appVersion,
      manifestHash: (await fileDigest(manifestPath)).sha256, phase: 'applying', roots }
    await durableJson(journalPath, journal)
    await options.checkpoint?.('restore-prepared')
  }
  if (journal.phase !== 'committed') for (const step of journal.roots) {
    const live = path.join(paths.profile, step.name), original = path.join(workspace, 'originals', step.name), staged = path.join(workspace, 'staged', step.name)
    if (step.state === 'pending') {
      if (step.hadOriginal) {
        if (!await exists(original)) {
          if (!await exists(live)) throw new AppSnapshotError('原数据缺失，恢复事务已停止')
          await regular(live, step.name === 'ai-attachments'); await fsp.rename(live, original)
        } else if (await exists(live)) throw new AppSnapshotError('原数据与恢复事务发生冲突')
      } else if (await exists(live)) throw new AppSnapshotError('恢复过程中出现未登记的新文件')
      await options.checkpoint?.(`after-original:${step.name}`)
      step.state = 'original-moved'; await durableJson(journalPath, journal)
    }
    if (step.state === 'original-moved') {
      if (step.hasReplacement) {
        if (await exists(staged)) {
          if (await exists(live)) throw new AppSnapshotError('恢复目标已被其他写入占用')
          await regular(staged, step.name === 'ai-attachments'); await fsp.rename(staged, live)
        } else if (!await exists(live)) throw new AppSnapshotError('待恢复文件缺失')
      }
      await options.checkpoint?.(`after-installed:${step.name}`)
      await verifyInstalledRoot(paths.profile, step.name, manifest)
      step.state = 'installed'; await durableJson(journalPath, journal)
    }
  }
  for (const name of RESTORE_ROOTS) await verifyInstalledRoot(paths.profile, name, manifest)
  const live = await tree(paths.profile)
  if (JSON.stringify(live.files) !== JSON.stringify(manifest.files) || JSON.stringify(live.directories) !== JSON.stringify(manifest.directories)) throw new AppSnapshotError('恢复后的受管范围与快照不一致')
  await sqliteMetadata(path.join(paths.profile, 'panlite.db'))
  journal.phase = 'committed'; await durableJson(journalPath, journal); await syncDirectory(paths.profile)
  await options.checkpoint?.('restore-committed')
  return journal.rollbackSnapshotId
}

/** Call only after the single-instance lock, before initDatabase and all services. Throws on any incomplete operation. */
export async function processPendingAppSnapshotOperation(profilePath: string, input: Omit<AppSnapshotOptions, 'profilePath'>): Promise<{ processed: boolean; kind?: 'snapshot' | 'restore'; snapshotId?: string; rollbackSnapshotId?: string; recovered?: boolean }> {
  const options: AppSnapshotOptions = { ...input, profilePath }, paths = await layout(options)
  const operation = await pending(paths)
  if (!operation) return { processed: false }
  if (running.has(paths.profile)) throw new AppSnapshotError('应用快照操作正在执行', 'SNAPSHOT_BUSY')
  running.add(paths.profile)
  const recovered = operation.status !== 'requested'
  try {
    const workspace = await ownedDirectory(paths.state, `operation-${operation.id}`)
    operation.status = 'running'; delete operation.error; await durableJson(paths.pendingPath, operation)
    let rollbackSnapshotId: string | undefined
    if (operation.kind === 'snapshot') await capture(paths, options, operation.snapshotId, operation.name || '应用快照', workspace)
    else rollbackSnapshotId = await restore(paths, options, operation, workspace)
    await durableJson(path.join(paths.state, 'last-operation.json'), { operationId: operation.id, kind: operation.kind, snapshotId: operation.snapshotId, rollbackSnapshotId, completedAt: Date.now() })
    await fsp.unlink(paths.pendingPath); await syncDirectory(paths.state)
    return { processed: true, kind: operation.kind, snapshotId: operation.snapshotId, rollbackSnapshotId, recovered }
  } catch (error) {
    operation.status = 'failed'; operation.error = fixedError(error)
    await durableJson(paths.pendingPath, operation)
    throw new AppSnapshotError(operation.error, error instanceof AppSnapshotError ? error.code : 'SNAPSHOT_STARTUP_FAILED')
  } finally { running.delete(paths.profile) }
}

export class AppSnapshotService implements AppSnapshotsApi {
  constructor(readonly options: AppSnapshotOptions) {}
  private async result<T extends object>(work: (paths: Layout) => T | Promise<T>): Promise<AppSnapshotResult<T>> {
    try { return { success: true, ...await work(await layout(this.options)) } }
    catch (error) { return { success: false, error: fixedError(error), code: error instanceof AppSnapshotError ? error.code : 'SNAPSHOT_ERROR' } }
  }
  listSnapshots(): ReturnType<AppSnapshotsApi['listSnapshots']> {
    return this.result(async paths => {
      const snapshots: AppSnapshotInfo[] = []
      for (const entry of await fsp.readdir(paths.snapshots, { withFileTypes: true })) {
        if (!UUID_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue
        try { const directory = path.join(paths.snapshots, entry.name), manifest = await readManifest(directory); await verifyContent(path.join(directory, 'data'), manifest); snapshots.push(manifest.snapshot) }
        catch { snapshots.push({ id: entry.name, name: '无法验证的快照', createdAt: 0, appVersion: '', formatVersion: 1, state: 'invalid', fileCount: 0, totalBytes: 0, sameMachineOnly: true, managedRoots: ROOT_NAMES, externalAiSources: 0, error: '快照清单损坏或未完成' }) }
      }
      return { snapshots: snapshots.sort((a, b) => b.createdAt - a.createdAt) }
    })
  }
  inspectSnapshot(id: string): ReturnType<AppSnapshotsApi['inspectSnapshot']> {
    return this.result(async paths => {
      const directory = path.join(paths.snapshots, identifier(id)), manifest = await readManifest(directory)
      await verifyContent(path.join(directory, 'data'), manifest)
      // Normal UI inspection never opens or inspects the live database.
      if (manifest.machineHash !== machineHash(this.options, paths.profile)) throw new AppSnapshotError('快照不属于当前机器和应用目录', 'SNAPSHOT_MACHINE_MISMATCH')
      if (this.options.supportedMigrationIds && this.options.supportedSchemaVersions) await compatibility(manifest, this.options, paths, false)
      return { snapshot: manifest.snapshot, files: manifest.files, migrationIds: manifest.migrationIds, schemaVersions: manifest.schemaVersions, verified: true }
    })
  }
  private request(kind: 'snapshot' | 'restore', nameOrId: string): ReturnType<AppSnapshotsApi['requestSnapshot']> {
    return this.result(async paths => {
      if (running.has(paths.profile) || await pending(paths)) throw new AppSnapshotError('已有待重启执行的快照请求', 'SNAPSHOT_BUSY')
      if (kind === 'snapshot' && (typeof nameOrId !== 'string' || !nameOrId.trim() || nameOrId.length > 200 || nameOrId.includes('\0'))) throw new AppSnapshotError('快照名称不正确')
      const snapshotId = kind === 'snapshot' ? randomUUID() : identifier(nameOrId)
      if (kind === 'restore') {
        const directory = path.join(paths.snapshots, snapshotId), manifest = await readManifest(directory)
        await verifyContent(path.join(directory, 'data'), manifest)
        if (manifest.machineHash !== machineHash(this.options, paths.profile)) throw new AppSnapshotError('仅允许恢复当前机器和原应用目录内的快照', 'SNAPSHOT_MACHINE_MISMATCH')
        if (this.options.supportedMigrationIds && this.options.supportedSchemaVersions) await compatibility(manifest, this.options, paths, false)
      }
      const request: PendingAppSnapshotOperation = { id: randomUUID(), kind, status: 'requested', snapshotId, requestedAt: Date.now(), ...(kind === 'snapshot' ? { name: nameOrId.trim() } : {}) }
      try { await durableJson(paths.pendingPath, request, true) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppSnapshotError('已有待重启执行的快照请求', 'SNAPSHOT_BUSY'); throw error }
        return { pending: { ...request, canCancel: true }, restartRequired: true }
    })
  }
  requestSnapshot(name: string): ReturnType<AppSnapshotsApi['requestSnapshot']> { return this.request('snapshot', name) }
  requestRestore(id: string): ReturnType<AppSnapshotsApi['requestRestore']> { return this.request('restore', id) }
  getPendingOperation(): ReturnType<AppSnapshotsApi['getPendingOperation']> {
    return this.result(async paths => {
      const request = await pending(paths)
      if (!request) return { pending: null }
      let canCancel = !running.has(paths.profile)
      const journal = path.join(paths.state, `operation-${request.id}`, 'restore-journal.json')
      if (await exists(journal)) {
        try { canCancel &&= (await readJson(journal) as RestoreJournal).phase === 'committed' }
        catch { canCancel = false }
      }
      return { pending: { ...request, canCancel } }
    })
  }
  cancelPendingOperation(): ReturnType<AppSnapshotsApi['cancelPendingOperation']> {
    return this.result(async paths => {
      if (running.has(paths.profile)) throw new AppSnapshotError('快照处理期间不能取消', 'SNAPSHOT_BUSY')
      const request = await pending(paths)
      if (!request) return {}
      const journal = path.join(paths.state, `operation-${request.id}`, 'restore-journal.json')
      if (await exists(journal) && (await readJson(journal) as RestoreJournal).phase !== 'committed') throw new AppSnapshotError('恢复事务已开始，必须在启动时完成恢复后才能打开数据库', 'RESTORE_IN_PROGRESS')
      await fsp.unlink(paths.pendingPath); await syncDirectory(paths.state); return {}
    })
  }
}
