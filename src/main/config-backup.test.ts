import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createConfigBackup,
  importConfigBackup,
  parseConfigBackup,
  previewConfigBackupImport,
  serializeConfigBackup,
} from './config-backup'

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, nickname TEXT, login_type TEXT NOT NULL,
      encrypted_credential TEXT NOT NULL, user_agent TEXT, status TEXT, bind_machine INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_check_at INTEGER
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, encrypted INTEGER DEFAULT 0, updated_at INTEGER NOT NULL);
    CREATE TABLE search_sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, platform TEXT NOT NULL,
      url TEXT NOT NULL, method TEXT, params TEXT, headers TEXT, field_map TEXT, html_selectors TEXT,
      max_count INTEGER, weight INTEGER, status INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE tg_channels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, channel TEXT NOT NULL, platform TEXT NOT NULL,
      max_count INTEGER, weight INTEGER, status INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE crawler_sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, platform TEXT NOT NULL,
      max_count INTEGER, weight INTEGER, status INTEGER, html_item TEXT, html_title TEXT,
      html_url TEXT, html_url2 TEXT, html_type INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE kk_sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, api_type INTEGER,
      max_count INTEGER, weight INTEGER, status INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
}

function seedSource(database: Database.Database): void {
  const now = 1_700_000_000_000
  database.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('account-1', 'quark', '主账号', 'cookie', 'ciphertext-value', 'secret-user-agent', 'active', 1, now, now, null)
  database.prepare('INSERT INTO settings VALUES (?, ?, ?, ?)').run('requestDelayMs', '500', 0, now)
  database.prepare('INSERT INTO settings VALUES (?, ?, ?, ?)').run('baiduClientSecret', 'plain-secret-setting', 0, now)
  database.prepare('INSERT INTO settings VALUES (?, ?, ?, ?)').run('bannedKeywords', '广告,推广', 0, now)
  database.prepare(`INSERT INTO search_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'source-1', '测试源', 'api', 'quark', 'https://example.com/search?token=url-secret&q={keyword}',
      'GET', JSON.stringify({ q: '{keyword}', apiKey: 'params-secret' }),
      JSON.stringify({ Accept: 'application/json', Authorization: 'Bearer header-secret' }),
      null, null, 20, 1, 1, now, now,
    )
}

describe('config backup', () => {
  let source: Database.Database
  let target: Database.Database

  beforeEach(() => {
    source = new Database(':memory:')
    target = new Database(':memory:')
    createSchema(source)
    createSchema(target)
    seedSource(source)
  })

  afterEach(() => {
    source.close()
    target.close()
  })

  it('exports a checksummed backup with all plaintext credentials omitted', () => {
    const serialized = serializeConfigBackup(source)
    const backup = parseConfigBackup(serialized)

    expect(backup.version).toBe(1)
    expect(backup.security.credentials).toBe('omitted')
    expect(backup.data.accounts[0]).not.toHaveProperty('encrypted_credential')
    expect(backup.data.accounts[0]).not.toHaveProperty('user_agent')
    for (const secret of [
      'ciphertext-value', 'secret-user-agent', 'plain-secret-setting', 'url-secret',
      'params-secret', 'header-secret',
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(backup.data.settings.map((row) => row.key)).toEqual(['requestDelayMs', 'bannedKeywords'])
    expect(() => parseConfigBackup(serialized.replace('500', '501'))).toThrow(/校验和/)
  })

  it('previews without writes and restores safe data transactionally', () => {
    const backup = createConfigBackup(source)
    const preview = previewConfigBackupImport(backup, { mode: 'merge' }, target)
    expect(preview.totals.inserts).toBeGreaterThan(0)
    expect(target.prepare('SELECT COUNT(*) AS count FROM settings').get()).toEqual({ count: 0 })

    const result = importConfigBackup(backup, { mode: 'merge' }, target)
    expect(result.restoredAt).toBeTruthy()
    expect(target.prepare('SELECT value FROM settings WHERE key = ?').get('requestDelayMs')).toEqual({ value: '500' })
    expect(target.prepare('SELECT status, encrypted_credential FROM accounts WHERE id = ?').get('account-1'))
      .toEqual({ status: 'expired', encrypted_credential: '' })
  })

  it('preserves credentials for existing accounts', () => {
    const now = Date.now()
    target.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('account-1', 'quark', '旧名称', 'cookie', 'existing-ciphertext', 'existing-agent', 'active', 1, now, now, null)
    importConfigBackup(createConfigBackup(source), {}, target)
    expect(target.prepare('SELECT nickname, encrypted_credential, user_agent, status FROM accounts WHERE id = ?').get('account-1'))
      .toEqual({ nickname: '主账号', encrypted_credential: 'existing-ciphertext', user_agent: 'existing-agent', status: 'active' })
  })

  it('rolls back all changes when any restore statement fails', () => {
    const backup = createConfigBackup(source)
    target.prepare('INSERT INTO settings VALUES (?, ?, ?, ?)').run('requestDelayMs', '100', 0, Date.now())
    target.exec(`
      CREATE TRIGGER reject_source BEFORE INSERT ON search_sources
      WHEN NEW.id = 'source-1'
      BEGIN SELECT RAISE(ABORT, 'rejected by test'); END;
    `)

    expect(() => importConfigBackup(backup, { mode: 'replace' }, target)).toThrow(/rejected by test/)
    expect(target.prepare('SELECT value FROM settings WHERE key = ?').get('requestDelayMs')).toEqual({ value: '100' })
    expect(target.prepare('SELECT COUNT(*) AS count FROM accounts').get()).toEqual({ count: 0 })
  })
})
