import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const testUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-db-migration-'))
process.env.PANLITE_TEST_USER_DATA = testUserDataDir

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.PANLITE_TEST_USER_DATA,
  },
}))

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { getDb, initDatabase } from './db'

describe('database repair migrations', () => {
  beforeAll(() => {
    vi.useFakeTimers()
  })

  afterAll(() => {
    vi.useRealTimers()
    if (getDb().open) getDb().close()
    fs.rmSync(testUserDataDir, { recursive: true, force: true })
  })

  it('creates share_subscriptions when migration 004 is recorded but the table is missing', () => {
    initDatabase()
    const database = getDb()
    expect(database.prepare("SELECT id FROM _migrations WHERE id = '004_add_ai_workspace_tables'").get()).toBeTruthy()

    database.exec(`
      DROP TABLE share_subscriptions;
      DELETE FROM _migrations WHERE id = '010_repair_share_subscriptions_table';
    `)
    database.close()

    initDatabase()
    const repaired = getDb()
    expect(repaired.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'share_subscriptions'").get()).toBeTruthy()
    expect(repaired.prepare("SELECT id FROM _migrations WHERE id = '010_repair_share_subscriptions_table'").get()).toBeTruthy()
    expect(repaired.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_share_subscriptions_account'").get()).toBeTruthy()
  })
})
