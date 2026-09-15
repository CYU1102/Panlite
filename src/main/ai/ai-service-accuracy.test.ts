import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), parse: vi.fn(), config: vi.fn(), embed: vi.fn(), policy: vi.fn(), call: vi.fn(), stream: vi.fn() }))
vi.mock('../db', () => ({ getDb: mocks.getDb }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./document-parser', () => ({ parseAiDocument: mocks.parse }))
vi.mock('./processing-policy', () => ({ getAiProcessingPolicy: mocks.policy }))
vi.mock('./ai-provider', () => ({
  getAiProviderConfig: mocks.config, embedAiTexts: mocks.embed, callAiModel: mocks.call, callAiModelStream: mocks.stream,
}))

import { askAiDocuments, importAiFiles, listAiDocuments, listAiTasks, reindexAiDocument, streamAiDocuments } from './ai-service'
import { initializeAiProcessingCoverageSchema } from './processing-coverage-store'

let database: Database.Database
let directory: string

beforeEach(() => {
  vi.resetAllMocks()
  database = new Database(':memory:')
  database.exec(`
    CREATE TABLE ai_documents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, source_type TEXT, source_account_id TEXT, source_file_id TEXT,
      source_path TEXT, extension TEXT, mime_type TEXT, size INTEGER, sha256 TEXT, status TEXT,
      content_preview TEXT, error_message TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE ai_tasks (
      id TEXT PRIMARY KEY, task_type TEXT, title TEXT, document_id TEXT, status TEXT, progress INTEGER,
      message TEXT, error_message TEXT, created_at INTEGER, updated_at INTEGER, finished_at INTEGER
    );
    CREATE TABLE ai_document_chunks (
      id TEXT PRIMARY KEY, document_id TEXT, chunk_index INTEGER, page_number INTEGER, section TEXT,
      content TEXT, created_at INTEGER, embedding TEXT
    );
  `)
  initializeAiProcessingCoverageSchema(database)
  mocks.getDb.mockReturnValue(database)
  mocks.config.mockReturnValue({ model: '', embeddingModel: '' })
  mocks.policy.mockReturnValue({ allowModelFallback: false, useSemanticIndex: false })
  mocks.call.mockResolvedValue('根据本地文档回答')
  mocks.stream.mockResolvedValue('根据本地文档回答')
  mocks.parse.mockResolvedValue({ status: 'ready', preview: 'Original text', sections: [{ content: 'Original text' }], message: '文件内容已提取' })
  directory = mkdtempSync(join(tmpdir(), 'panlite-ai-service-accuracy-'))
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true })
})

function fixture(name = 'document.txt', text = 'Unchanged original bytes'): string {
  const filePath = join(directory, name)
  writeFileSync(filePath, text)
  return filePath
}

describe('AI document accuracy persistence', () => {
  it('explicitly reparses an unchanged ready document and replaces its old index', async () => {
    const imported = await importAiFiles([{ localPath: fixture() }])
    const original = imported.documents[0]
    mocks.parse.mockResolvedValue({ status: 'ready', preview: 'Corrected text', sections: [{ content: 'Corrected text' }], message: '解析器修复后的内容' })

    const rebuilt = await reindexAiDocument(original.id)

    expect(rebuilt.success).toBe(true)
    expect(mocks.parse).toHaveBeenCalledTimes(2)
    expect(rebuilt.document?.sha256).toBe(original.sha256)
    expect(rebuilt.document?.contentPreview).toBe('Corrected text')
    expect(database.prepare('SELECT content FROM ai_document_chunks WHERE document_id = ?').all(original.id)).toEqual([{ content: 'Corrected text' }])
    expect(listAiTasks().find(task => task.id === rebuilt.taskId)?.message).toContain('解析器修复后的内容')
  })

  it('marks parser failures as failed tasks and returns the failure to the importer', async () => {
    mocks.parse.mockResolvedValue({ status: 'failed', message: 'PDF 文件损坏' })
    const result = await importAiFiles([{ localPath: fixture('damaged.pdf') }])

    expect(result.success).toBe(false)
    expect(result.error).toBe('PDF 文件损坏')
    expect(result.documents[0]).toMatchObject({ status: 'failed', errorMessage: 'PDF 文件损坏', parseMessage: 'PDF 文件损坏' })
    expect(listAiTasks()[0]).toMatchObject({ status: 'failed', errorMessage: 'PDF 文件损坏' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM ai_document_chunks').get()).toEqual({ count: 0 })
  })

  it('retains mixed-batch successful documents while reporting the failed document truthfully', async () => {
    mocks.parse.mockResolvedValueOnce({ status: 'failed', message: 'Broken first file' })
    const result = await importAiFiles([{ localPath: fixture('one.txt', 'one') }, { localPath: fixture('two.txt', 'two') }])
    expect(result.success).toBe(true)
    expect(result.documents.map(document => document.status)).toEqual(['failed', 'ready'])
    expect(listAiTasks().map(task => task.status).sort()).toEqual(['failed', 'success'])
  })

  it('keeps missing-dependency explanations available on the persisted document', async () => {
    mocks.parse.mockResolvedValue({ status: 'awaiting_parser', message: '需要安装 LibreOffice 后重新解析' })
    const result = await importAiFiles([{ localPath: fixture('legacy.doc') }])
    expect(result.success).toBe(true)
    expect(listAiDocuments()[0]).toMatchObject({ status: 'awaiting_parser', parseMessage: '需要安装 LibreOffice 后重新解析' })
  })

  it('keeps partial parsing limits visible after reload and duplicate import', async () => {
    mocks.parse.mockResolvedValue({ status: 'ready', partial: true, preview: 'Known text', sections: [{ content: 'Known text' }], message: '有 2 个文件未完整解析' })
    const localPath = fixture('archive.zip')
    const first = await importAiFiles([{ localPath }])
    const second = await importAiFiles([{ localPath }])

    expect(mocks.parse).toHaveBeenCalledOnce()
    expect(second.documents[0].id).toBe(first.documents[0].id)
    expect(second.documents[0].parseMessage).toContain('部分解析')
    expect(listAiDocuments()[0].parseMessage).toContain('有 2 个文件未完整解析')
  })

  it.each(['import', 'reindex'])('preserves embedding failures in final %s messages and document details', async operation => {
    mocks.policy.mockReturnValue({ allowModelFallback: false, useSemanticIndex: true })
    const localPath = fixture()
    let documentId: string | undefined
    if (operation === 'reindex') documentId = (await importAiFiles([{ localPath }])).documents[0].id
    mocks.config.mockReturnValue({ model: '', embeddingModel: 'fixture-embedding' })
    mocks.embed.mockRejectedValue(new Error('Synthetic embedding endpoint unavailable'))

    const result = operation === 'import'
      ? await importAiFiles([{ localPath }])
      : await reindexAiDocument(documentId!)

    expect(result.success).toBe(true)
    const lastTask = listAiTasks().find(task => task.message?.includes('语义索引失败'))
    expect(lastTask).toMatchObject({ status: 'success' })
    expect(lastTask?.message).toContain('Synthetic embedding endpoint unavailable')
    expect(lastTask?.message).toContain('已保留文本索引')
    expect(listAiDocuments()[0].parseMessage).toContain('语义索引失败')
    expect(database.prepare('SELECT content, embedding FROM ai_document_chunks').all()).toEqual([{ content: 'Original text', embedding: null }])
  })

  it.each(['import', 'reindex'])('uses only a text index by default during %s even with a configured embedding model', async operation => {
    const localPath = fixture()
    let documentId: string | undefined
    if (operation === 'reindex') documentId = (await importAiFiles([{ localPath }])).documents[0].id
    mocks.config.mockReturnValue({ model: 'configured-chat', embeddingModel: 'configured-embedding' })
    const result = operation === 'import' ? await importAiFiles([{ localPath }]) : await reindexAiDocument(documentId!)
    expect(result.success).toBe(true)
    expect(mocks.embed).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.stream).not.toHaveBeenCalled()
    expect(database.prepare('SELECT content, embedding FROM ai_document_chunks').all()).toEqual([{ content: 'Original text', embedding: null }])
  })

  it.each(['ask', 'stream'])('does not generate query embeddings by default but retains explicit %s requests', async operation => {
    const imported = await importAiFiles([{ localPath: fixture() }])
    mocks.config.mockReturnValue({ model: 'configured-chat', embeddingModel: 'configured-embedding' })
    database.prepare('UPDATE ai_document_chunks SET embedding = ?').run('[1, 0]')
    const input = { question: 'Original text是什么？', documentIds: [imported.documents[0].id] }
    const result = operation === 'ask' ? await askAiDocuments(input) : await streamAiDocuments(input, { onDelta: vi.fn() })
    expect(result.success).toBe(true)
    expect(mocks.embed).not.toHaveBeenCalled()
    expect(operation === 'ask' ? mocks.call : mocks.stream).toHaveBeenCalledOnce()
  })

  it('generates query embeddings only when semantic indexing is explicitly enabled', async () => {
    const imported = await importAiFiles([{ localPath: fixture() }])
    mocks.config.mockReturnValue({ model: 'configured-chat', embeddingModel: 'configured-embedding' })
    mocks.policy.mockReturnValue({ allowModelFallback: false, useSemanticIndex: true })
    mocks.embed.mockResolvedValue([[1, 0]])
    database.prepare('UPDATE ai_document_chunks SET embedding = ?').run('[1, 0]')
    expect((await askAiDocuments({ question: 'Original text是什么？', documentIds: [imported.documents[0].id] })).success).toBe(true)
    expect(mocks.embed).toHaveBeenCalledOnce()
  })

  it('does not replace completed parsing information with a running or unrelated task', async () => {
    const imported = await importAiFiles([{ localPath: fixture() }])
    const documentId = imported.documents[0].id
    database.prepare(`INSERT INTO ai_tasks (id, document_id, task_type, status, message, created_at, updated_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('running-task', documentId, 'index', 'running', '正在生成语义索引', Date.now() + 100, Date.now() + 100, null)
    database.prepare(`INSERT INTO ai_tasks (id, document_id, task_type, status, message, created_at, updated_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('chat-task', documentId, 'chat', 'success', '回答完成', Date.now() + 200, Date.now() + 200, Date.now() + 200)

    expect(listAiDocuments()[0].parseMessage).toContain('文件内容已提取')
    expect(listAiDocuments()[0].parseMessage).not.toContain('正在生成')
  })
  it.each(['ask', 'stream'])('does not call a model without matching source evidence for %s', async operation => {
    const imported = await importAiFiles([{ localPath: fixture() }])
    const input = { question: '不存在的订单 ZX-999 金额是多少？', documentIds: [imported.documents[0].id] }
    const result = operation === 'ask' ? await askAiDocuments(input) : await streamAiDocuments(input, { onDelta: vi.fn() })
    expect(result.success).toBe(false)
    expect(result.error).toContain('未检索到与问题相关的文档依据')
    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.stream).not.toHaveBeenCalled()
    expect(mocks.embed).not.toHaveBeenCalled()
  })
  it.each(['ask', 'stream'])('attaches the relevant exact quote and page metadata to an explicit %s answer', async operation => {
    const content = `${'一般说明。'.repeat(100)}\n\tA-12\t\t12.50\t\n付款人：林青\n${'附注。'.repeat(60)}`
    mocks.parse.mockResolvedValue({ status: 'ready', preview: content, sections: [{ pageNumber: 7, section: '账目', content }], message: '已提取' })
    const imported = await importAiFiles([{ localPath: fixture() }])
    const input = { question: 'A-12 的金额是多少？', documentIds: [imported.documents[0].id] }
    const result = operation === 'ask' ? await askAiDocuments(input) : await streamAiDocuments(input, { onDelta: vi.fn() })
    expect(result.success).toBe(true)
    expect(result.citations?.[0]).toMatchObject({ documentId: imported.documents[0].id, pageNumber: 7, section: '账目' })
    expect(result.citations?.[0].quote).toContain('\tA-12\t\t12.50\t\n')
    expect(content.includes(result.citations![0].quote)).toBe(true)
  })
  it.each(['ask', 'stream'])('discloses sampled summary scope and skips unneeded query embeddings for %s', async operation => {
    const imported = await importAiFiles([{ localPath: fixture() }])
    mocks.policy.mockReturnValue({ allowModelFallback: false, useSemanticIndex: true })
    mocks.config.mockReturnValue({ model: 'configured-chat', embeddingModel: 'configured-embedding' })
    database.prepare('UPDATE ai_document_chunks SET embedding = ?').run('[1, 0]')
    const input = { question: '总结这些文档的核心内容', documentIds: [imported.documents[0].id] }
    const result = operation === 'ask' ? await askAiDocuments(input) : await streamAiDocuments(input, { onDelta: vi.fn() })
    expect(result.success).toBe(true)
    expect(mocks.embed).not.toHaveBeenCalled()
    const called = operation === 'ask' ? mocks.call : mocks.stream
    expect(called.mock.calls[0][1]).toContain('不保证覆盖全文')
    expect(called.mock.calls[0][1]).toContain('不得将片段中未出现的信息断言为全文不存在')
    expect(listAiTasks().find(task => task.taskType === 'chat')?.message).toContain('摘要使用抽样片段，不保证覆盖全文')
  })
})
