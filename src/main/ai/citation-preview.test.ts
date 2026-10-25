import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../db', () => ({ getDb: vi.fn(), getAccountById: vi.fn() }))
vi.mock('../../adapters/registry', () => ({ getAdapter: vi.fn() }))
vi.mock('../ipc/account-mapping', () => ({ dbAccountToDriveAccount: vi.fn() }))
vi.mock('../preview-download', () => ({ downloadPreviewSource: vi.fn() }))
import { FilePreviewService } from '../file-preview'
import { fileSha256, prepareAiCitationPreview } from './citation-preview'
import { subtitleTimeRange } from '../../shared/ai-citation-preview'

let database: Database.Database, directory: string, previews: FilePreviewService, source: string
beforeEach(async () => {
  database = new Database(':memory:')
  database.exec(`CREATE TABLE ai_documents(id TEXT PRIMARY KEY,name TEXT,sha256 TEXT,source_path TEXT,source_account_id TEXT,source_file_id TEXT,size INTEGER);
    CREATE TABLE ai_document_chunks(id TEXT PRIMARY KEY,document_id TEXT,content TEXT,page_number INTEGER,section TEXT,chunk_index INTEGER,start_seconds REAL,end_seconds REAL);`)
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-citation-test-'))
  previews = new FilePreviewService({ tempRoot: path.join(directory, 'sessions') })
  source = path.join(directory, 'source.pdf'); fs.writeFileSync(source, '%PDF-1.4\nverified original')
  database.prepare('INSERT INTO ai_documents VALUES(?,?,?,?,?,?,?)').run('doc', 'source.pdf', await fileSha256(source), source, 'account', 'file', fs.statSync(source).size)
  database.prepare('INSERT INTO ai_document_chunks(id,document_id,content,page_number,section,chunk_index) VALUES(?,?,?,?,?,?)').run('chunk', 'doc', '这是引用的原文。', 3, '第 3 页', 0)
})
afterEach(() => { previews.cleanupAll(); database.close(); fs.rmSync(directory, { recursive: true, force: true }) })
const input = () => ({ documentId: 'doc', citation: { documentId: 'doc', documentName: 'spoofed', chunkId: 'chunk', quote: '引用的原文', pageNumber: 3 } })

describe('trusted original citation previews', () => {
  it('resolves stored locations and serves a verified snapshot after the source changes', async () => {
    const result = await prepareAiCitationPreview(input(), { database, previews })
    expect(result.success).toBe(true); expect(result.citation).toMatchObject({ documentName: 'source.pdf', chunkId: 'chunk', pageNumber: 3 })
    fs.writeFileSync(source, 'changed source')
    const response = await previews.handleRequest(new Request(result.preview!.assetUrl!))
    expect(await response.text()).toBe('%PDF-1.4\nverified original')
  })
  it('rejects changed bytes and forged citations before displaying a different source', async () => {
    fs.writeFileSync(source, 'changed source')
    const changed = await prepareAiCitationPreview(input(), { database, previews })
    expect(changed.success).toBe(false); expect(changed.error).toContain('内容已经变化')
    const forged = await prepareAiCitationPreview({ ...input(), citation: { ...input().citation, pageNumber: 9 } }, { database, previews })
    expect(forged.error).toContain('索引不符')
    expect(fs.readdirSync(path.join(directory, 'sessions'))).toEqual([])
  })
  it('re-downloads expired cloud cache and validates the same version', async () => {
    fs.unlinkSync(source)
    const downloadCloud = vi.fn(async (_document, context) => {
      const localPath = path.join(context.directory, context.fileName)
      fs.writeFileSync(localPath, '%PDF-1.4\nverified original'); return localPath
    })
    const result = await prepareAiCitationPreview(input(), { database, previews, downloadCloud })
    expect(result.success).toBe(true); expect(downloadCloud).toHaveBeenCalledOnce()
    expect(result.citation?.sourceSha256).toHaveLength(64)
  })
  it('rejects a newer cloud version and ignores arbitrary renderer paths', async () => {
    fs.unlinkSync(source)
    const result = await prepareAiCitationPreview({ ...input(), sourcePath: 'C:/Windows/system.ini' } as ReturnType<typeof input>, {
      database, previews, downloadCloud: async (_document, context) => { const localPath = path.join(context.directory, context.fileName); fs.writeFileSync(localPath, 'new version'); return localPath },
    })
    expect(result.error).toContain('版本不同')
  })
  it('preserves real subtitle times without inventing timing for whole-text transcripts', async () => {
    database.prepare('UPDATE ai_document_chunks SET page_number=NULL,section=?,start_seconds=12.25,end_seconds=15 WHERE id=?').run('外挂字幕 · 00:00:12.250 → 00:00:15.000', 'chunk')
    const request = input(); delete (request.citation as { pageNumber?: number }).pageNumber
    const result = await prepareAiCitationPreview(request, { database, previews })
    expect(result.citation).toMatchObject({ startSeconds: 12.25, endSeconds: 15 })
    expect(subtitleTimeRange('本地 Whisper 转写')).toEqual({})
    expect(subtitleTimeRange('外挂字幕 · 01:02:03,500 → 01:02:04,100')).toEqual({ startSeconds: 3723.5, endSeconds: 3724.1 })
    expect(subtitleTimeRange('00:99:00 → 01:00:00')).toEqual({})
  })
})
