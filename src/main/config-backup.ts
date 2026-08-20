import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import { getDb } from './db'

export const CONFIG_BACKUP_FORMAT = 'panlite-config-backup'
export const CONFIG_BACKUP_VERSION = 1

export type BackupImportMode = 'merge' | 'replace'

export interface BackupAccount {
  id: string
  platform: string
  nickname: string | null
  login_type: string
  status: 'reauth_required'
  created_at: number
  updated_at: number
  credential_omitted: true
}

export interface BackupData {
  accounts: BackupAccount[]
  settings: Record<string, unknown>[]
  search_sources: Record<string, unknown>[]
  tg_channels: Record<string, unknown>[]
  crawler_sources: Record<string, unknown>[]
  kk_sources: Record<string, unknown>[]
}

export interface ConfigBackup {
  format: typeof CONFIG_BACKUP_FORMAT
  version: typeof CONFIG_BACKUP_VERSION
  createdAt: string
  data: BackupData
  security: {
    credentials: 'omitted'
    redactedFields: number
    notes: string[]
  }
  checksum: string
}

export interface BackupTablePreview {
  table: keyof BackupData
  incoming: number
  inserts: number
  updates: number
  deletes: number
}

export interface BackupImportPreview {
  valid: true
  version: number
  createdAt: string
  checksum: string
  mode: BackupImportMode
  tables: BackupTablePreview[]
  totals: { incoming: number; inserts: number; updates: number; deletes: number }
  warnings: string[]
}

export interface BackupImportResult extends BackupImportPreview {
  restoredAt: string
}

interface TableSpec {
  table: Exclude<keyof BackupData, 'accounts'>
  key: string
  columns: string[]
  required: string[]
}

const MAX_BACKUP_BYTES = 20 * 1024 * 1024
const SAFE_SETTING_KEYS = new Set([
  'quarkPageSize',
  'baiduPageSize',
  'requestDelayMs',
  'adFilterEnabled',
  'bannedKeywords',
])
const SECRET_KEY = /(?:password|passwd|pwd|token|secret|cookie|authorization|api[_-]?key|credential|client[_-]?id)/i
const REDACTED = Symbol('redacted')

const TABLE_SPECS: TableSpec[] = [
  {
    table: 'settings',
    key: 'key',
    columns: ['key', 'value', 'encrypted', 'updated_at'],
    required: ['key', 'value'],
  },
  {
    table: 'search_sources',
    key: 'id',
    columns: ['id', 'name', 'type', 'platform', 'url', 'method', 'params', 'headers', 'field_map', 'html_selectors', 'max_count', 'weight', 'status', 'created_at', 'updated_at'],
    required: ['id', 'name', 'type', 'platform', 'url'],
  },
  {
    table: 'tg_channels',
    key: 'id',
    columns: ['id', 'name', 'channel', 'platform', 'max_count', 'weight', 'status', 'created_at', 'updated_at'],
    required: ['id', 'name', 'channel', 'platform'],
  },
  {
    table: 'crawler_sources',
    key: 'id',
    columns: ['id', 'name', 'url', 'platform', 'max_count', 'weight', 'status', 'html_item', 'html_title', 'html_url', 'html_url2', 'html_type', 'created_at', 'updated_at'],
    required: ['id', 'name', 'url', 'platform'],
  },
  {
    table: 'kk_sources',
    key: 'id',
    columns: ['id', 'name', 'platform', 'api_type', 'max_count', 'weight', 'status', 'created_at', 'updated_at'],
    required: ['id', 'name', 'platform'],
  },
]

function databaseOrDefault(database?: Database.Database): Database.Database {
  return database || getDb()
}

function tableExists(database: Database.Database, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(',')}}`
}

export function calculateBackupChecksum(backup: Omit<ConfigBackup, 'checksum'> | ConfigBackup): string {
  const { checksum: _checksum, ...unsigned } = backup as ConfigBackup
  return createHash('sha256').update(canonicalize(unsigned), 'utf8').digest('hex')
}

function sanitizeUrl(raw: string, onRedaction: () => void): string {
  try {
    const url = new URL(raw)
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY.test(key)) {
        url.searchParams.delete(key)
        onRedaction()
      }
    }
    if (url.username || url.password) {
      url.username = ''
      url.password = ''
      onRedaction()
    }
    return url.toString()
  } catch {
    return raw.replace(/([?&](?:password|token|secret|api[_-]?key|authorization)=)[^&\s]*/gi, (_match, prefix: string) => {
      onRedaction()
      return `${prefix}[REDACTED]`
    })
  }
}

function sanitizeValue(value: unknown, key: string | undefined, onRedaction: () => void): unknown | typeof REDACTED {
  if (key && SECRET_KEY.test(key)) {
    onRedaction()
    return REDACTED
  }
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return sanitizeUrl(value, onRedaction)
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, undefined, onRedaction)).filter((item) => item !== REDACTED)
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeValue(childValue, childKey, onRedaction)
      if (sanitized !== REDACTED) result[childKey] = sanitized
    }
    return result
  }
  return value
}

function sanitizeStructuredText(value: unknown, onRedaction: () => void): unknown {
  if (typeof value !== 'string' || !value.trim()) return value
  try {
    return JSON.stringify(sanitizeValue(JSON.parse(value), undefined, onRedaction))
  } catch {
    return sanitizeUrl(value, onRedaction)
  }
}

function selectRows(database: Database.Database, table: string, columns: string[]): Record<string, unknown>[] {
  if (!tableExists(database, table)) return []
  return database.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all() as Record<string, unknown>[]
}

function exportAccounts(database: Database.Database): BackupAccount[] {
  if (!tableExists(database, 'accounts')) return []
  const rows = database.prepare(`
    SELECT id, platform, nickname, login_type, created_at, updated_at
    FROM accounts ORDER BY created_at
  `).all() as Array<Omit<BackupAccount, 'status' | 'credential_omitted'>>
  return rows.map((row) => ({ ...row, status: 'reauth_required', credential_omitted: true }))
}

export function createConfigBackup(database?: Database.Database): ConfigBackup {
  const db = databaseOrDefault(database)
  let redactedFields = 0
  const onRedaction = (): void => { redactedFields += 1 }
  const settings = selectRows(db, 'settings', ['key', 'value', 'encrypted', 'updated_at'])
    .filter((row) => row.encrypted === 0 && SAFE_SETTING_KEYS.has(String(row.key)))
    .map((row) => ({ ...row, encrypted: 0 }))
  const searchSources = selectRows(db, 'search_sources', TABLE_SPECS[1].columns).map((row) => ({
    ...row,
    url: sanitizeUrl(String(row.url || ''), onRedaction),
    params: sanitizeStructuredText(row.params, onRedaction),
    headers: sanitizeStructuredText(row.headers, onRedaction),
    field_map: sanitizeStructuredText(row.field_map, onRedaction),
    html_selectors: sanitizeStructuredText(row.html_selectors, onRedaction),
  }))
  const crawlerSources = selectRows(db, 'crawler_sources', TABLE_SPECS[3].columns).map((row) => ({
    ...row,
    url: sanitizeUrl(String(row.url || ''), onRedaction),
  }))
  const unsigned: Omit<ConfigBackup, 'checksum'> = {
    format: CONFIG_BACKUP_FORMAT,
    version: CONFIG_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    data: {
      accounts: exportAccounts(db),
      settings,
      search_sources: searchSources,
      tg_channels: selectRows(db, 'tg_channels', TABLE_SPECS[2].columns),
      crawler_sources: crawlerSources,
      kk_sources: selectRows(db, 'kk_sources', TABLE_SPECS[4].columns),
    },
    security: {
      credentials: 'omitted',
      redactedFields,
      notes: [
        '账号凭据、加密设置和认证信息未包含在备份中。',
        '恢复后的新增账号处于失效状态，需要重新登录。',
      ],
    },
  }
  return { ...unsigned, checksum: calculateBackupChecksum(unsigned) }
}

export function serializeConfigBackup(database?: Database.Database): string {
  return JSON.stringify(createConfigBackup(database), null, 2)
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效`)
}

function normalizeRow(row: unknown, spec: TableSpec, index: number): Record<string, unknown> {
  assertRecord(row, `${spec.table}[${index}]`)
  const result: Record<string, unknown> = {}
  for (const column of spec.columns) {
    if (Object.prototype.hasOwnProperty.call(row, column)) result[column] = row[column]
  }
  for (const required of spec.required) {
    if (result[required] === undefined || result[required] === null || result[required] === '') {
      throw new Error(`${spec.table}[${index}] 缺少 ${required}`)
    }
  }
  if (spec.table === 'settings') {
    const key = String(result.key)
    if (!SAFE_SETTING_KEYS.has(key) || Number(result.encrypted || 0) !== 0) throw new Error(`设置 ${key} 不允许导入`)
    result.encrypted = 0
  }
  return result
}

function normalizeAccount(row: unknown, index: number): BackupAccount {
  assertRecord(row, `accounts[${index}]`)
  const id = String(row.id || '').trim()
  const platform = String(row.platform || '').trim()
  const loginType = String(row.login_type || '').trim()
  if (!id || !platform || !loginType || row.credential_omitted !== true) throw new Error(`accounts[${index}] 格式无效`)
  return {
    id,
    platform,
    nickname: row.nickname === null || row.nickname === undefined ? null : String(row.nickname),
    login_type: loginType,
    status: 'reauth_required',
    created_at: Number(row.created_at) || Date.now(),
    updated_at: Number(row.updated_at) || Date.now(),
    credential_omitted: true,
  }
}

export function parseConfigBackup(input: string | unknown): ConfigBackup {
  if (typeof input === 'string' && Buffer.byteLength(input, 'utf8') > MAX_BACKUP_BYTES) throw new Error('备份文件过大')
  const parsed: unknown = typeof input === 'string' ? JSON.parse(input) : input
  assertRecord(parsed, '备份')
  if (parsed.format !== CONFIG_BACKUP_FORMAT) throw new Error('不是 PanLite 配置备份')
  if (parsed.version !== CONFIG_BACKUP_VERSION) throw new Error(`不支持的备份版本: ${String(parsed.version)}`)
  if (typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))) throw new Error('备份时间无效')
  if (typeof parsed.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.checksum)) throw new Error('备份校验和无效')
  assertRecord(parsed.data, '备份数据')
  assertRecord(parsed.security, '安全信息')
  if (parsed.security.credentials !== 'omitted') throw new Error('拒绝导入包含凭据的备份')
  if (calculateBackupChecksum(parsed as unknown as ConfigBackup) !== parsed.checksum) {
    throw new Error('备份校验和不匹配，文件可能已损坏或被修改')
  }

  const accountsRaw = parsed.data.accounts
  if (!Array.isArray(accountsRaw)) throw new Error('accounts 格式无效')
  const data = { accounts: accountsRaw.map(normalizeAccount) } as BackupData
  for (const spec of TABLE_SPECS) {
    const rows = parsed.data[spec.table]
    if (!Array.isArray(rows) || rows.length > 100_000) throw new Error(`${spec.table} 格式无效`)
    data[spec.table] = rows.map((row, index) => normalizeRow(row, spec, index))
  }

  const unsigned: Omit<ConfigBackup, 'checksum'> = {
    format: CONFIG_BACKUP_FORMAT,
    version: CONFIG_BACKUP_VERSION,
    createdAt: parsed.createdAt,
    data,
    security: {
      credentials: 'omitted',
      redactedFields: Number(parsed.security.redactedFields) || 0,
      notes: Array.isArray(parsed.security.notes) ? parsed.security.notes.map(String) : [],
    },
  }
  return { ...unsigned, checksum: calculateBackupChecksum(unsigned) }
}

function existingKeys(database: Database.Database, table: string, key: string): Set<string> {
  if (!tableExists(database, table)) return new Set()
  return new Set((database.prepare(`SELECT ${key} AS value FROM ${table}`).all() as Array<{ value: unknown }>).map((row) => String(row.value)))
}

function previewTable(
  database: Database.Database,
  table: keyof BackupData,
  key: string,
  rows: Array<Record<string, unknown> | BackupAccount>,
  mode: BackupImportMode,
): BackupTablePreview {
  const existing = existingKeys(database, table, key)
  const incoming = new Set(rows.map((row) => String((row as unknown as Record<string, unknown>)[key])))
  let updates = 0
  for (const value of incoming) if (existing.has(value)) updates += 1
  let deletes = 0
  if (mode === 'replace' && table !== 'accounts') {
    for (const value of existing) if (!incoming.has(value)) deletes += 1
  }
  return { table, incoming: rows.length, inserts: rows.length - updates, updates, deletes }
}

export function previewConfigBackupImport(
  input: string | unknown,
  options: { mode?: BackupImportMode } = {},
  database?: Database.Database,
): BackupImportPreview {
  const db = databaseOrDefault(database)
  const backup = parseConfigBackup(input)
  const mode = options.mode || 'merge'
  if (mode !== 'merge' && mode !== 'replace') throw new Error('导入模式无效')
  const tables: BackupTablePreview[] = [
    previewTable(db, 'accounts', 'id', backup.data.accounts, mode),
    ...TABLE_SPECS.map((spec) => previewTable(db, spec.table, spec.key, backup.data[spec.table], mode)),
  ]
  const totals = tables.reduce((sum, table) => ({
    incoming: sum.incoming + table.incoming,
    inserts: sum.inserts + table.inserts,
    updates: sum.updates + table.updates,
    deletes: sum.deletes + table.deletes,
  }), { incoming: 0, inserts: 0, updates: 0, deletes: 0 })
  const warnings = [
    '备份不含账号凭据；新增账号恢复后必须重新登录。',
    '现有账号的凭据和登录状态不会被覆盖。',
    '敏感设置不会导入，也不会在替换模式下删除。',
  ]
  if (mode === 'replace') warnings.push('替换模式会删除备份中不存在的搜索源。')
  return {
    valid: true,
    version: backup.version,
    createdAt: backup.createdAt,
    checksum: backup.checksum,
    mode,
    tables,
    totals,
    warnings,
  }
}

function deleteReplaceableRows(database: Database.Database, backup: ConfigBackup): void {
  for (const spec of TABLE_SPECS) {
    if (!tableExists(database, spec.table)) continue
    if (spec.table === 'settings') {
      const incoming = new Set(backup.data.settings.map((row) => String(row.key)))
      const existing = database.prepare('SELECT key, encrypted FROM settings').all() as Array<{ key: string; encrypted: number }>
      const remove = existing.filter((row) => row.encrypted === 0 && SAFE_SETTING_KEYS.has(row.key) && !incoming.has(row.key))
      const statement = database.prepare('DELETE FROM settings WHERE key = ?')
      for (const row of remove) statement.run(row.key)
    } else {
      database.prepare(`DELETE FROM ${spec.table}`).run()
    }
  }
}

function restoreAccounts(database: Database.Database, accounts: BackupAccount[]): void {
  if (!tableExists(database, 'accounts')) return
  const statement = database.prepare(`
    INSERT INTO accounts (
      id, platform, nickname, login_type, encrypted_credential, user_agent,
      status, bind_machine, created_at, updated_at, last_check_at
    ) VALUES (?, ?, ?, ?, '', NULL, 'expired', 1, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      platform = excluded.platform,
      nickname = excluded.nickname,
      login_type = excluded.login_type,
      updated_at = excluded.updated_at
  `)
  for (const account of accounts) {
    statement.run(account.id, account.platform, account.nickname, account.login_type, account.created_at, account.updated_at)
  }
}

function restoreRows(database: Database.Database, spec: TableSpec, rows: Record<string, unknown>[]): void {
  if (!tableExists(database, spec.table)) {
    if (rows.length > 0) throw new Error(`当前数据库缺少 ${spec.table} 表`)
    return
  }
  const placeholders = spec.columns.map(() => '?').join(', ')
  const updates = spec.columns.filter((column) => column !== spec.key)
    .map((column) => `${column} = excluded.${column}`).join(', ')
  const statement = database.prepare(`
    INSERT INTO ${spec.table} (${spec.columns.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(${spec.key}) DO UPDATE SET ${updates}
  `)
  const now = Date.now()
  for (const row of rows) {
    const values = spec.columns.map((column) => {
      if ((column === 'created_at' || column === 'updated_at') && row[column] === undefined) return now
      return row[column] === undefined ? null : row[column]
    })
    statement.run(...values)
  }
}

export function importConfigBackup(
  input: string | unknown,
  options: { mode?: BackupImportMode } = {},
  database?: Database.Database,
): BackupImportResult {
  const db = databaseOrDefault(database)
  const backup = parseConfigBackup(input)
  const preview = previewConfigBackupImport(backup, options, db)
  db.transaction(() => {
    if (preview.mode === 'replace') deleteReplaceableRows(db, backup)
    restoreAccounts(db, backup.data.accounts)
    for (const spec of TABLE_SPECS) restoreRows(db, spec, backup.data[spec.table])
  })()
  return { ...preview, restoredAt: new Date().toISOString() }
}
