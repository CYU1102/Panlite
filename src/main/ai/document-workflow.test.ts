import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./ai-provider', () => ({ callAiModelStream: vi.fn() }))
import { DocumentWorkflowStore, exportWorkflowMarkdown } from './document-workflow-store'
import { DocumentWorkflowRuntime, type WorkflowModel } from './document-workflow-runtime'
import { planWorkflowBatches, validateWorkflowOutput, validateWorkflowTemplate } from './document-workflow'

let database: Database.Database, store: DocumentWorkflowStore
beforeEach(() => {
  database = new Database(':memory:')
  database.exec(`CREATE TABLE ai_documents(id TEXT PRIMARY KEY, name TEXT, sha256 TEXT, status TEXT, parse_coverage TEXT);
    CREATE TABLE ai_document_chunks(id TEXT PRIMARY KEY,document_id TEXT,chunk_index INTEGER,content TEXT,page_number INTEGER,section TEXT,start_seconds REAL,end_seconds REAL);`)
  store = new DocumentWorkflowStore(database)
})
afterEach(() => database.close())

function addDocument(id: string, count = 1, complete: boolean | null = true) {
  database.prepare('INSERT INTO ai_documents VALUES(?,?,?,?,?)').run(id, `${id}.txt`, 'a'.repeat(64), 'ready', complete === null ? null : JSON.stringify({ version: 1, sourceComplete: complete, partial: !complete, unit: 'sections', sourceUnits: count, parsedUnits: count, warnings: complete ? [] : ['第 2 页无法识别'] }))
  const insert = database.prepare('INSERT INTO ai_document_chunks(id,document_id,chunk_index,content,section) VALUES(?,?,?,?,?)')
  database.transaction(() => { for (let index = 0; index < count; index++) insert.run(`${id}-${index}`, id, index, `事实 ${index}：${index === count - 1 ? '最终章节特别结论：预算降为42万元。' : '这里有不同章节的合同和说明文字。'.repeat(3)}`, '正文') })()
}
const summaryModel: WorkflowModel = async (_system, user) => {
  const data = JSON.parse(user) as { untrustedContent: { chunkId: string; text: string }[] }
  const last = data.untrustedContent[data.untrustedContent.length - 1]
  return JSON.stringify({ summary: last.text, citations: [{ chunkId: last.chunkId, quote: last.text.slice(0, 80) }] })
}

describe('complete document workflow', () => {
  it('processes every one of 5,010 chunks, including facts beyond retrieval and eight batches', async () => {
    addDocument('large', 5_010)
    const call = vi.fn(summaryModel), runtime = new DocumentWorkflowRuntime(store, call)
    const run = runtime.start({ mode: 'summary', documentIds: ['large'] })
    expect(run.totalBatches).toBeGreaterThan(8)
    await runtime.settled(run.id)
    const result = store.get(run.id)
    expect(result.status).toBe('completed')
    expect(result.coverage[0]).toMatchObject({ totalChunks: 5010, processedChunks: 5010, sourceComplete: true })
    expect(result.result.sections[result.result.sections.length - 1].summary).toContain('预算降为42万元')
    expect(call).toHaveBeenCalledTimes(result.totalBatches)
    expect(new DocumentWorkflowStore(database).get(run.id).result).toEqual(result.result)
    expect(exportWorkflowMarkdown(result)).toContain('预算降为42万元')
  })

  it('retains successful batches after malformed JSON and resumes only unfinished input', async () => {
    addDocument('resume', 450)
    let failing = true, calls = 0
    const call: WorkflowModel = async (system, user, signal) => { calls++; return calls > 1 && failing ? '{broken' : summaryModel(system, user, signal) }
    const runtime = new DocumentWorkflowRuntime(store, call)
    const run = runtime.start({ mode: 'summary', documentIds: ['resume'] })
    await runtime.settled(run.id)
    const failed = store.get(run.id)
    expect(failed.status).toBe('failed'); expect(failed.completedBatches).toBe(1)
    expect(failed.batches[1].attempts).toBe(2)
    const first = failed.result.sections[0]
    failing = false
    runtime.resume(run.id); await runtime.settled(run.id)
    const completed = store.get(run.id)
    expect(completed.status).toBe('completed'); expect(completed.result.sections[0]).toEqual(first)
    expect(completed.batches[0].attempts).toBe(1)
  })

  it('cancels the in-flight model, preserves pending ranges, and resumes after reopening', async () => {
    addDocument('cancel', 300, false)
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const model: WorkflowModel = async (_system, _user, signal) => new Promise((resolve, reject) => { began(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); void resolve })
    const runtime = new DocumentWorkflowRuntime(store, model)
    const run = runtime.start({ mode: 'summary', documentIds: ['cancel'] })
    await started; runtime.cancel(run.id); await runtime.settled(run.id)
    const cancelled = store.get(run.id)
    expect(cancelled.status).toBe('cancelled'); expect(cancelled.coverage[0].pendingRanges.length).toBeGreaterThan(0)
    expect(cancelled.coverage[0].processedChunks).toBe(0)
    const reopened = new DocumentWorkflowRuntime(new DocumentWorkflowStore(database), summaryModel)
    reopened.resume(run.id); await reopened.settled(run.id)
    const complete = store.get(run.id)
    expect(complete.status).toBe('completed'); expect(complete.coverage[0].sourceComplete).toBe(false)
    expect(complete.result.notice).toContain('原件可能有未解析内容')
  })

  it('treats legacy parser metadata as unknown and validates immutable template snapshots', async () => {
    addDocument('legacy', 1, null)
    const template = store.saveTemplate({ name: '合同', fields: [{ key: 'budget', label: '预算', type: 'number' }] })
    const runtime = new DocumentWorkflowRuntime(store, async (_system, user) => {
      const input = JSON.parse(user); const chunk = input.untrustedContent[0]
      return JSON.stringify({ facts: [{ field: 'budget', value: 42, citations: [{ chunkId: chunk.chunkId, quote: '预算降为42万元' }] }] })
    })
    const run = runtime.start({ mode: 'extract', documentIds: ['legacy'], templateId: template.id })
    store.deleteTemplate(template.id)
    await runtime.settled(run.id)
    const result = store.get(run.id)
    expect(result.status).toBe('completed'); expect(result.coverage[0].sourceComplete).toBe(false)
    expect(result.result.fields[0]).toMatchObject({ key: 'budget', label: '预算', value: 42, status: 'found' })
  })

  it('builds a difference table with both source citations and marks unverified absence uncertain', async () => {
    addDocument('left'); addDocument('right', 1, false)
    database.prepare('UPDATE ai_document_chunks SET content=? WHERE id=?').run('预算：40万元。责任人：甲。', 'left-0')
    const runtime = new DocumentWorkflowRuntime(store, async (_system, user) => {
      const input = JSON.parse(user); const chunk = input.untrustedContent[0]
      const citation = { chunkId: chunk.chunkId, quote: chunk.text }
      return JSON.stringify({ facts: [{ field: '预算', value: chunk.chunkId.startsWith('left') ? 40 : 42, citations: [citation] }, ...(chunk.chunkId.startsWith('left') ? [{ field: '责任人', value: '甲', citations: [citation] }] : [])] })
    })
    const run = runtime.start({ mode: 'compare', documentIds: ['left', 'right'] })
    await runtime.settled(run.id)
    const result = store.get(run.id)
    expect(result.result.differences[0]).toMatchObject({ leftValue: 40, rightValue: 42, change: 'changed' })
    expect(result.result.differences[0].citations.map(citation => citation.documentId)).toEqual(['left', 'right'])
    expect(result.result.differences[1].change).toBe('uncertain')
  })

  it('rejects invented quotes, unknown template fields and wrong scalar types', () => {
    const batch = [...planWorkflowBatches({ id: 'd', name: 'd', sha256: 'a'.repeat(64) }, [{ id: 'c', chunk_index: 0, content: '金额：42', section: '正文', page_number: null }])][0]
    expect(() => validateWorkflowOutput(JSON.stringify({ summary: '总结', citations: [{ chunkId: 'c', quote: '金额：99' }] }), 'summary', batch)).toThrow('不在本批原文')
    const template = store.saveTemplate({ name: '测试', fields: [{ key: 'amount', label: '金额', type: 'number' }] })
    expect(() => validateWorkflowOutput(JSON.stringify({ facts: [{ field: 'unknown', value: 42, citations: [{ chunkId: 'c', quote: '42' }] }] }), 'extract', batch, template)).toThrow('不存在的字段')
    expect(() => validateWorkflowOutput(JSON.stringify({ facts: [{ field: 'amount', value: '42', citations: [{ chunkId: 'c', quote: '42' }] }] }), 'extract', batch, template)).toThrow('必须返回数字')
    expect(() => validateWorkflowTemplate({ name: '重复', fields: [{ key: 'a', label: '甲', type: 'text' }, { key: 'a', label: '乙', type: 'text' }] })).toThrow('唯一')
  })
})
