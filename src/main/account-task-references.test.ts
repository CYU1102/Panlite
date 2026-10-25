import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.directory } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
import { getDb, getTasksByAccount, initDatabase, deleteAccountCascade } from './db'

beforeAll(() => {
  fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-account-task-'))
  vi.useFakeTimers()
  initDatabase()
  const database = getDb()
  for (const id of ['source', 'target', 'unrelated']) {
    database.prepare(`INSERT INTO accounts (id, platform, nickname, login_type, encrypted_credential, status, created_at, updated_at)
      VALUES (?, 'quark', ?, 'cookie', '', 'active', 1, 1)`).run(id, id)
  }
  const task = database.prepare(`INSERT INTO tasks (id, account_id, platform, task_type, title, payload, status, progress, retry_count, created_at, updated_at)
    VALUES (?, 'source', 'quark', ?, 'fixture', ?, ?, 0, 0, 1, 1)`)
  for (const status of ['pending', 'running', 'paused']) {
    task.run(status, 'cloud_transfer', JSON.stringify({ sourceAccountId: 'source', targetAccountId: 'target' }), status)
  }
  task.run('ordinary', 'download', '{}', 'running')
  task.run('corrupted', 'cloud_transfer', 'legacy-invalid-json', 'failed')
  task.run('planned', 'planned_transfer', JSON.stringify({ sourceAccountId: 'source', targetAccountId: 'target' }), 'paused')
  database.prepare("UPDATE tasks SET account_id = 'target' WHERE id = 'planned'").run()
})

afterAll(() => {
  getDb().close()
  vi.clearAllTimers()
  vi.useRealTimers()
  // This directory is created only for this test, never a user profile.
  fs.rmSync(fixture.directory, { recursive: true, force: true })
})

describe('account deletion task references', () => {
  it('finds active migrations when the selected account is only their target', () => {
    expect(getTasksByAccount('target').map(task => task.id).sort()).toEqual(['paused', 'pending', 'planned', 'running'])
  })
  it('retains source task lookup and safely skips unrelated or invalid payloads', () => {
    expect(getTasksByAccount('source')).toHaveLength(6)
    expect(getTasksByAccount('unrelated')).toEqual([])
  })
  it('keeps an account while retained backup versions require its identity and permits removal after explicit pruning', () => {
    const db = getDb()
    db.prepare('INSERT INTO file_backup_plans(id,version,data) VALUES(?,?,?)').run('retained-plan', 1, JSON.stringify({ target: { accountId: 'unrelated' } }))
    db.prepare('INSERT INTO file_backup_snapshots(id,plan_id,status,data) VALUES(?,?,?,?)').run('retained-version', 'retained-plan', 'ready', '{}')
    expect(() => deleteAccountCascade('unrelated')).toThrow('避免失去恢复入口')
    expect(db.prepare("SELECT id FROM accounts WHERE id='unrelated'").get()).toEqual({ id: 'unrelated' })
    expect(db.prepare("SELECT status FROM file_backup_snapshots WHERE id='retained-version'").get()).toEqual({ status: 'ready' })
    db.prepare("UPDATE file_backup_snapshots SET status='deleted' WHERE id='retained-version'").run()
    expect(deleteAccountCascade('unrelated').accounts).toBe(1)
  })
})
