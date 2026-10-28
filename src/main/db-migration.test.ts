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

  it('migrates an existing version 1 catalog without losing entries or annotations', () => {
    const database = getDb()
    database.exec(`
      INSERT INTO catalog_accounts(id,nickname,platform,status) VALUES('migration-account','old','webdav','active');
      INSERT INTO catalog_scopes(id,account_id,root_id,root_path,created_at,updated_at) VALUES('migration-scope','migration-account','root','/',1,1);
      INSERT INTO catalog_entries(account_id,file_id,parent_id,name,search_name,path,search_path,is_dir,size,created_at,updated_at,indexed_at,file_type,favorite)
        VALUES('migration-account','file','root','old.txt','old.txt','/old.txt','/old.txt',0,100,1,2,3,'document',1);
      INSERT INTO catalog_members(scope_id,account_id,file_id) VALUES('migration-scope','migration-account','file');
      INSERT INTO catalog_tags(account_id,file_id,tag) VALUES('migration-account','file','keep');
      DROP TABLE catalog_staged_entries;
      UPDATE catalog_schema SET version=1;
      DELETE FROM _migrations WHERE id='024_stage_catalog_directory_metadata';
    `)
    database.close()
    initDatabase()
    const migrated = getDb()
    expect(migrated.prepare('SELECT version FROM catalog_schema').get()).toEqual({ version: 2 })
    expect(migrated.prepare("SELECT name,path,size,favorite FROM catalog_entries WHERE account_id='migration-account' AND file_id='file'").get())
      .toEqual({ name: 'old.txt', path: '/old.txt', size: 100, favorite: 1 })
    expect(migrated.prepare("SELECT tag FROM catalog_tags WHERE account_id='migration-account' AND file_id='file'").get()).toEqual({ tag: 'keep' })
    expect(migrated.prepare("SELECT id FROM _migrations WHERE id='024_stage_catalog_directory_metadata'").get()).toBeTruthy()
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
