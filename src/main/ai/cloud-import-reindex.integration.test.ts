import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ root: '', db: vi.fn(), account: vi.fn(), download: vi.fn(), parse: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.root }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../db', () => ({ getDb: fixture.db, getAccountById: fixture.account }))
vi.mock('../crypto', () => ({ decryptCredential: () => '{}' }))
vi.mock('../../adapters/registry', () => ({ getAdapter: () => ({ download: fixture.download }) }))
vi.mock('./document-parser', () => ({ parseAiDocument: fixture.parse }))
vi.mock('./processing-policy', () => ({ getAiProcessingPolicy: () => ({ allowModelFallback: false, useSemanticIndex: false }) }))
vi.mock('./ai-provider', () => ({ getAiProviderConfig: () => ({ model: '', embeddingModel: '' }), embedAiTexts: vi.fn(), callAiModel: vi.fn(), callAiModelStream: vi.fn() }))

import { importAiCloudFiles } from './cloud-import'
import { reindexAiDocument } from './ai-service'
import { initializeAiProcessingCoverageSchema } from './processing-coverage-store'

let database: Database.Database
beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-cloud-reindex-'))
  vi.clearAllMocks()
  database = new Database(':memory:')
  database.exec(`
    CREATE TABLE ai_documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, source_type TEXT, source_account_id TEXT, source_file_id TEXT,
      source_path TEXT, extension TEXT, mime_type TEXT, size INTEGER, sha256 TEXT, status TEXT, content_preview TEXT, error_message TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE ai_tasks (id TEXT PRIMARY KEY, task_type TEXT, title TEXT, document_id TEXT, status TEXT, progress INTEGER,
      message TEXT, error_message TEXT, created_at INTEGER, updated_at INTEGER, finished_at INTEGER);
    CREATE TABLE ai_document_chunks (id TEXT PRIMARY KEY, document_id TEXT, chunk_index INTEGER, page_number INTEGER, section TEXT,
      content TEXT, created_at INTEGER, embedding TEXT);
  `)
  initializeAiProcessingCoverageSchema(database)
  fixture.db.mockReturnValue(database)
  fixture.account.mockReturnValue({ id: 'account', platform: 'quark', status: 'active', created_at: 1, updated_at: 1 })
  fixture.parse.mockResolvedValue({ status: 'ready', preview: 'Indexed content', sections: [{ content: 'Indexed content' }], message: '文件内容已提取' })
  fixture.download.mockImplementation(async (_account, _id, directory: string, options: { fileName: string }) => {
    const localPath = path.join(directory, options.fileName)
    fs.writeFileSync(localPath, 'cloud source')
    return { success: true, localPath }
  })
})
afterEach(() => {
  database.close()
  const root = path.resolve(fixture.root)
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('panlite-cloud-reindex-')) throw new Error('Unexpected fixture root')
  fs.rmSync(root, { recursive: true, force: true })
})

it('preserves the AI document source and can reindex it after a later cloud import', async () => {
  const request = { accountId: 'account', fileId: 'file', fileName: 'document.txt' }
  const first = await importAiCloudFiles([request])
  expect(first.success).toBe(true)
  const document = first.documents[0]
  expect(document.sourcePath).toBeTruthy()
  const relative = path.relative(fs.realpathSync.native(fixture.root), document.sourcePath!).split(path.sep).join('/')
  expect(relative.startsWith('ai-attachments/cloud-downloads/')).toBe(true)
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
  fs.utimesSync(path.dirname(document.sourcePath!), old, old)
  fixture.account.mockReturnValueOnce(null)
  expect((await importAiCloudFiles([request])).success).toBe(false)
  expect(fs.readFileSync(document.sourcePath!, 'utf8')).toBe('cloud source')
  const reindexed = await reindexAiDocument(document.id)
  expect(reindexed.success).toBe(true)
  expect(reindexed.document?.status).toBe('ready')
})
