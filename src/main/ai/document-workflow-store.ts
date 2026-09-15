import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { AiWorkflowBatch, AiWorkflowCoverage, AiWorkflowRun, AiWorkflowStartInput, AiWorkflowStatus, AiWorkflowTemplate } from '../../shared/ai-workflow'
import { citationTimeLabel } from '../../shared/ai-citation-preview'
import { aggregateWorkflowResult, planWorkflowBatches, validateWorkflowTemplate, type WorkflowBatchInput, type WorkflowBatchOutput, type WorkflowChunkRow, type WorkflowCompletedBatch } from './document-workflow'

interface RunRecord { id: string; status: AiWorkflowStatus; metadata: string; updated_at: number; error: string | null }
interface BatchRecord { id: string; run_id: string; batch_index: number; status: AiWorkflowStatus; input: string; output: string | null; attempts: number; error: string | null }
interface RunMetadata { input: AiWorkflowStartInput; title: string; createdAt: number; coverage: AiWorkflowCoverage[]; template?: AiWorkflowTemplate }
interface DocumentRow { id: string; name: string; sha256: string; status: string; parse_coverage?: string | null }

export function initializeAiWorkflowSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ai_workflow_runs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, metadata TEXT NOT NULL,
      updated_at INTEGER NOT NULL, error TEXT
    );
    CREATE TABLE IF NOT EXISTS ai_workflow_batches (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, batch_index INTEGER NOT NULL,
      status TEXT NOT NULL, input TEXT NOT NULL, output TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
      FOREIGN KEY (run_id) REFERENCES ai_workflow_runs(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_workflow_batch_order ON ai_workflow_batches(run_id, batch_index);
    CREATE TABLE IF NOT EXISTS ai_workflow_templates (id TEXT PRIMARY KEY, definition TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `)
}

export class DocumentWorkflowStore {
  constructor(readonly database: Database.Database) { initializeAiWorkflowSchema(database) }

  /** Startup recovery only changes state. It never sends any content to a model. */
  recoverInterrupted(): void {
    this.database.transaction(() => {
      this.database.prepare("UPDATE ai_workflow_runs SET status = 'failed', error = '应用关闭时处理中断，可继续未完成分段', updated_at = ? WHERE status = 'running'").run(Date.now())
      this.database.prepare("UPDATE ai_workflow_batches SET status = 'pending', error = '应用关闭时中断' WHERE status = 'running'").run()
    })()
  }

  create(inputValue: AiWorkflowStartInput): AiWorkflowRun {
    if (!inputValue || !['summary', 'compare', 'extract'].includes(inputValue.mode)) throw new Error('请选择有效的处理模式')
    if (!Array.isArray(inputValue.documentIds) || !inputValue.documentIds.length || inputValue.documentIds.length > 100 || inputValue.documentIds.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('请选择 1 到 100 份文档')
    const documentIds = [...new Set(inputValue.documentIds)]
    if (inputValue.mode === 'compare' && documentIds.length !== 2) throw new Error('文档对比需要按左右顺序选择两份不同文档')
    if (inputValue.instruction != null && (typeof inputValue.instruction !== 'string' || inputValue.instruction.length > 2_000)) throw new Error('处理要求不能超过 2000 个字符')
    const input = { mode: inputValue.mode, documentIds, instruction: inputValue.instruction || '', templateId: inputValue.templateId }
    const template = input.mode === 'extract' ? this.getTemplate(String(input.templateId || '')) : undefined
    if (input.mode === 'extract' && !template) throw new Error('请选择一个已保存的字段模板')
    const documents = documentIds.map(id => {
      const row = this.database.prepare('SELECT * FROM ai_documents WHERE id = ?').get(id) as DocumentRow | undefined
      if (!row || row.status !== 'ready') throw new Error('所选文档不存在或尚未完成解析')
      return row
    })
    const id = randomUUID(), now = Date.now()
    const metadata: RunMetadata = { input, title: `${{ summary: '完整摘要', compare: '文档对比', extract: '字段提取' }[input.mode]} · ${documents.map(document => document.name).join('、')}`, createdAt: now, coverage: [], template }
    this.database.transaction(() => {
      this.database.prepare('INSERT INTO ai_workflow_runs(id,status,metadata,updated_at) VALUES (?, ?, ?, ?)').run(id, 'pending', JSON.stringify(metadata), now)
      const insert = this.database.prepare('INSERT INTO ai_workflow_batches(id,run_id,batch_index,status,input) VALUES (?, ?, ?, ?, ?)')
      let index = 0
      for (const document of documents) {
        let parsed: Record<string, unknown> = {}
        try { parsed = JSON.parse(document.parse_coverage || '{}') || {} } catch { /* Legacy parse state remains unknown. */ }
        const sourceComplete = parsed.version === 1 && parsed.sourceComplete === true && parsed.partial !== true
        const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter(value => typeof value === 'string') : []
        const parseNotice = [sourceComplete ? '解析器已确认原件范围完整' : '原件解析完整性未确认，不能将片段处理率视为原件覆盖率',
          parsed.sourceUnits != null ? `已解析 ${parsed.parsedUnits ?? '?'} / ${parsed.sourceUnits} ${parsed.unit || ''}` : '',
          Array.isArray(parsed.missingUnits) && parsed.missingUnits.length ? `未解析位置：${parsed.missingUnits.join('、')}` : '', ...warnings].filter(Boolean).join('；')
        const totalChunks = (this.database.prepare('SELECT count(*) AS count FROM ai_document_chunks WHERE document_id = ?').get(document.id) as { count: number }).count
        if (!totalChunks) throw new Error(`${document.name} 没有已解析片段，请重新解析`)
        let totalBatches = 0
        const rows = this.documentChunks(document.id)
        for (const batch of planWorkflowBatches(document, rows)) {
          insert.run(randomUUID(), id, index++, 'pending', JSON.stringify(batch)); totalBatches++
        }
        if (!totalBatches) throw new Error(`${document.name} 没有可处理文字`)
        metadata.coverage.push({ documentId: document.id, documentName: document.name, sourceSha256: document.sha256,
          totalChunks, processedChunks: 0, totalBatches, completedBatches: 0, sourceComplete, parseNotice, pendingRanges: [] })
      }
      this.database.prepare('UPDATE ai_workflow_runs SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), id)
    })()
    return this.get(id)
  }

  private row(id: string): RunRecord {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('处理任务 ID 无效')
    const row = this.database.prepare('SELECT * FROM ai_workflow_runs WHERE id = ?').get(id) as RunRecord | undefined
    if (!row) throw new Error('处理任务不存在')
    return row
  }
  private *documentChunks(documentId: string): Generator<WorkflowChunkRow> {
    // A live better-sqlite3 iterator prevents writes on the same connection.
    // Keyset pages release the read before persisting each prepared batch.
    const query = this.database.prepare('SELECT * FROM ai_document_chunks WHERE document_id = ? AND chunk_index > ? ORDER BY chunk_index LIMIT 256')
    let cursor = -1
    while (true) {
      const rows = query.all(documentId, cursor) as WorkflowChunkRow[]
      if (!rows.length) return
      for (const row of rows) yield row
      cursor = rows[rows.length - 1].chunk_index
    }
  }
  metadata(id: string): RunMetadata { return JSON.parse(this.row(id).metadata) as RunMetadata }

  get(id: string): AiWorkflowRun {
    const row = this.row(id), metadata = JSON.parse(row.metadata) as RunMetadata
    const rows = this.database.prepare('SELECT * FROM ai_workflow_batches WHERE run_id = ? ORDER BY batch_index').all(id) as BatchRecord[]
    const completed: WorkflowCompletedBatch[] = [], batches: AiWorkflowBatch[] = []
    const doneByDocument = new Map<string, Set<string>>(), pendingByDocument = new Map<string, Set<string>>()
    for (const batch of rows) {
      const input = JSON.parse(batch.input) as WorkflowBatchInput
      batches.push({ id: batch.id, index: batch.batch_index, documentId: input.documentId, title: input.title, status: batch.status,
        chunkCount: new Set(input.chunks.map(chunk => chunk.chunkId)).size, attempts: batch.attempts, error: batch.error || undefined })
      const map = batch.status === 'completed' ? doneByDocument : pendingByDocument
      const ids = map.get(input.documentId) || new Set<string>()
      input.chunks.forEach(chunk => { if (chunk.chunkId) ids.add(chunk.chunkId) }); map.set(input.documentId, ids)
      if (batch.status === 'completed' && batch.output) completed.push({ input, output: JSON.parse(batch.output) as WorkflowBatchOutput })
    }
    const coverage = metadata.coverage.map(document => {
      const relevant = batches.filter(batch => batch.documentId === document.documentId)
      return { ...document, completedBatches: relevant.filter(batch => batch.status === 'completed').length,
        processedChunks: [...(doneByDocument.get(document.documentId) || [])].filter(chunk => !pendingByDocument.get(document.documentId)?.has(chunk)).length,
        pendingRanges: relevant.filter(batch => batch.status !== 'completed').map(batch => `${batch.title}${batch.error ? `：${batch.error}` : ''}`) }
    })
    return { id, mode: metadata.input.mode, title: metadata.title, documentIds: metadata.input.documentIds, status: row.status,
      totalBatches: batches.length, completedBatches: completed.length, createdAt: metadata.createdAt, updatedAt: row.updated_at,
      error: row.error || undefined, coverage, batches, result: aggregateWorkflowResult(metadata.input.mode, completed, coverage, metadata.template) }
  }

  /** List summaries avoid repeatedly transferring large result tables while polling. */
  list(): AiWorkflowRun[] {
    const rows = this.database.prepare('SELECT * FROM ai_workflow_runs ORDER BY updated_at DESC LIMIT 100').all() as RunRecord[]
    return rows.map(row => {
      const metadata = JSON.parse(row.metadata) as RunMetadata
      const count = this.database.prepare("SELECT count(*) AS total, sum(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed FROM ai_workflow_batches WHERE run_id = ?").get(row.id) as { total: number; completed: number }
      return { id: row.id, mode: metadata.input.mode, title: metadata.title, documentIds: metadata.input.documentIds,
        status: row.status, totalBatches: count.total, completedBatches: count.completed || 0, createdAt: metadata.createdAt,
        updatedAt: row.updated_at, error: row.error || undefined, coverage: [], batches: [], result: { sections: [], differences: [], fields: [], notice: '' } }
    })
  }
  setStatus(id: string, status: AiWorkflowStatus, error?: string): void {
    this.database.prepare('UPDATE ai_workflow_runs SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, error || null, Date.now(), id)
  }
  nextBatch(id: string): { id: string; input: WorkflowBatchInput; attempts: number } | undefined {
    const row = this.database.prepare("SELECT * FROM ai_workflow_batches WHERE run_id = ? AND status != 'completed' ORDER BY batch_index LIMIT 1").get(id) as BatchRecord | undefined
    return row ? { id: row.id, input: JSON.parse(row.input) as WorkflowBatchInput, attempts: row.attempts } : undefined
  }
  startBatch(id: string): void {
    this.database.prepare("UPDATE ai_workflow_batches SET status = 'running', attempts = attempts + 1, error = NULL WHERE id = ?").run(id)
  }
  finishBatch(id: string, status: AiWorkflowStatus, output?: WorkflowBatchOutput, error?: string): void {
    this.database.prepare('UPDATE ai_workflow_batches SET status = ?, output = ?, error = ? WHERE id = ?').run(status, output ? JSON.stringify(output) : null, error || null, id)
  }
  saveTemplate(input: unknown): AiWorkflowTemplate {
    const validated = validateWorkflowTemplate(input)
    const value: AiWorkflowTemplate = { ...validated, id: validated.id || randomUUID(), updatedAt: Date.now() }
    this.database.prepare('INSERT INTO ai_workflow_templates(id,definition,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition, updated_at=excluded.updated_at').run(value.id, JSON.stringify(value), value.updatedAt)
    return value
  }
  getTemplate(id: string): AiWorkflowTemplate | undefined {
    const row = this.database.prepare('SELECT definition FROM ai_workflow_templates WHERE id = ?').get(id) as { definition: string } | undefined
    return row ? JSON.parse(row.definition) as AiWorkflowTemplate : undefined
  }
  templates(): AiWorkflowTemplate[] {
    return (this.database.prepare('SELECT definition FROM ai_workflow_templates ORDER BY updated_at DESC').all() as { definition: string }[]).map(row => JSON.parse(row.definition) as AiWorkflowTemplate)
  }
  deleteTemplate(id: string): void { this.database.prepare('DELETE FROM ai_workflow_templates WHERE id = ?').run(id) }
}

export function exportWorkflowMarkdown(run: AiWorkflowRun): string {
  const lines = [`# ${run.title}`, '', `状态：${run.status} · 完成 ${run.completedBatches}/${run.totalBatches} 分段`, '', run.result.notice, '', '## 覆盖范围', '']
  for (const document of run.coverage) lines.push(`### ${document.documentName}`, '', `已处理片段：${document.processedChunks}/${document.totalChunks}`, document.parseNotice, ...document.pendingRanges.map(range => `- 未完成：${range}`), '')
  const cite = (citations: import('../../shared/ai-types').AiCitation[]) => {
    for (const citation of citations) lines.push(`> ${citation.documentName} · ${citation.pageNumber ? `第 ${citation.pageNumber} 页` : citation.startSeconds !== undefined ? `${citationTimeLabel(citation.startSeconds)}${citation.endSeconds !== undefined ? ` – ${citationTimeLabel(citation.endSeconds)}` : ''}` : citation.section || ''} · 片段 ${citation.chunkId || ''}`, `> ${citation.quote.replace(/\n/g, '\n> ')}`, '')
  }
  for (const section of run.result.sections) { lines.push(`## ${section.title}`, '', section.summary, ''); cite(section.citations) }
  for (const difference of run.result.differences) { lines.push(`## ${difference.field} (${difference.change})`, '', `左：${difference.leftValue ?? '未找到'}`, `右：${difference.rightValue ?? '未找到'}`, ''); cite(difference.citations) }
  for (const field of run.result.fields) { lines.push(`## ${field.label} (${field.status})`, '', String(field.value ?? '未确认'), ''); cite(field.citations) }
  return lines.join('\n')
}
