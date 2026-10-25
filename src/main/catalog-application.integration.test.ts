import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CatalogApi } from '../shared/catalog'
import { createCatalogClient } from '../shared/catalog-client'

const environment = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => environment.directory } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { getDb, initDatabase, deleteAccountById } from './db'
import { CatalogStore } from './catalog-store'
import { CatalogService } from './catalog-service'
import { registerCatalogIpcHandlers } from './ipc/catalog'

let service: CatalogService
let api: CatalogApi

beforeAll(() => {
  environment.directory = mkdtempSync(join(tmpdir(), 'panlite-catalog-application-'))
  const legacy = new Database(join(environment.directory, 'panlite.db'))
  legacy.exec(`CREATE TABLE accounts (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, nickname TEXT, login_type TEXT NOT NULL,
    encrypted_credential TEXT NOT NULL, user_agent TEXT, status TEXT NOT NULL,
    bind_machine INTEGER DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_check_at INTEGER
  ); INSERT INTO accounts VALUES('legacy','webdav','Existing','password','opaque-test-value',NULL,'active',1,1,2,NULL);`)
  legacy.close()
  vi.useFakeTimers()
  initDatabase()
  vi.clearAllTimers()
  vi.useRealTimers()
  service = new CatalogService(new CatalogStore(getDb()), {
    getAccount(id) {
      const row = getDb().prepare('SELECT id,nickname,platform,status FROM accounts WHERE id=?').get(id)
      return row as { id: string; nickname: string; platform: 'webdav'; status: 'active' } | undefined
    },
    async listFiles(accountId, parentId) {
      return { parentId, hasMore: false, files: [{ id: 'report', parentId, name: '季度报告.pdf',
        accountId, platform: 'webdav', isDir: false, size: 42, createdAt: 1, updatedAt: 2,
        raw: { authorization: 'this-must-not-cross-ipc' } }] }
    },
  })
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerCatalogIpcHandlers({ handle(channel, listener) { handlers.set(channel, listener as (...args: unknown[]) => unknown) } }, service)
  api = createCatalogClient(async (channel, ...args) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error('unregistered channel')
    return handler({}, ...args)
  })
})

afterAll(() => {
  service?.dispose()
  if (getDb().open) getDb().close()
  const directory = resolve(environment.directory)
  if (dirname(directory) !== resolve(tmpdir()) || !directory.split(/[\\/]/).pop()!.startsWith('panlite-catalog-application-')) {
    throw new Error('Unexpected test cleanup path')
  }
  rmSync(directory, { recursive: true, force: true })
})

async function waitForCompleted(id: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await api.listScopes()
    if (result.success && result.scopes.find(scope => scope.id === id)?.status === 'completed') return
    await new Promise(resolveWait => setTimeout(resolveWait, 5))
  }
  throw new Error('catalog scan did not complete')
}

describe('catalog application integration', () => {
  it('adds the catalog to a legacy profile without changing its credential or identity', () => {
    expect(getDb().prepare('SELECT id,encrypted_credential,created_at FROM accounts WHERE id=?').get('legacy'))
      .toEqual({ id: 'legacy', encrypted_credential: 'opaque-test-value', created_at: 1 })
    expect(getDb().prepare("SELECT id FROM _migrations WHERE id='011_add_personal_file_catalog'").get()).toBeTruthy()
  })

  it('scans, searches and persists labels through the same client and IPC handlers used by the page', async () => {
    const added = await api.addScope({ accountId: 'legacy', rootId: '0', rootPath: '/' })
    expect(added.success).toBe(true)
    if (!added.success) throw new Error(added.error)
    expect((await api.startScan(added.scope.id)).success).toBe(true)
    await waitForCompleted(added.scope.id)
    const found = await api.search({ keyword: '报告', pageSize: 10 })
    expect(found.success).toBe(true)
    if (!found.success) throw new Error(found.error)
    expect(found.entries).toHaveLength(1)
    expect(JSON.stringify(found)).not.toMatch(/authorization|this-must-not-cross-ipc|opaque-test-value/)
    expect((await api.setTags({ accountId: 'legacy', fileId: 'report', tags: ['项目'] })).success).toBe(true)
    expect((await api.setFavorite({ accountId: 'legacy', fileId: 'report', favorite: true })).success).toBe(true)
    const collection = await api.saveCollection({ name: '交付资料' })
    if (!collection.success) throw new Error(collection.error)
    await api.setEntryCollections({ accountId: 'legacy', fileId: 'report', collectionIds: [collection.collection.id] })
    const result = await api.search({ tags: ['项目'], favorite: true, collectionId: collection.collection.id })
    expect(result.success && result.total).toBe(1)
    service.dispose()
    const persisted = new CatalogStore(getDb()).search({ keyword: '报告', tags: ['项目'] })
    expect(persisted.entries[0].favorite).toBe(true)
  })

  it('deleting an account also clears its catalog references and labels in the database transaction', () => {
    deleteAccountById('legacy')
    expect(new CatalogStore(getDb()).search({}).total).toBe(0)
    for (const table of ['catalog_accounts', 'catalog_scopes', 'catalog_tags', 'catalog_collection_members']) {
      expect(getDb().prepare(`SELECT COUNT(*) count FROM ${table}`).get()).toEqual({ count: 0 })
    }
  })
})
