import type Database from 'better-sqlite3'
import type { AiProcessingCoverage } from '../../shared/ai-processing-coverage'

export function initializeAiProcessingCoverageSchema(db: Database.Database): void {
  const documents = new Set((db.prepare('PRAGMA table_info(ai_documents)').all() as Array<{ name: string }>).map(row => row.name))
  if (documents.size && !documents.has('parse_coverage')) db.exec('ALTER TABLE ai_documents ADD COLUMN parse_coverage TEXT')
  const chunks = new Set((db.prepare('PRAGMA table_info(ai_document_chunks)').all() as Array<{ name: string }>).map(row => row.name))
  if (chunks.size && !chunks.has('start_seconds')) db.exec('ALTER TABLE ai_document_chunks ADD COLUMN start_seconds REAL')
  if (chunks.size && !chunks.has('end_seconds')) db.exec('ALTER TABLE ai_document_chunks ADD COLUMN end_seconds REAL')
}

export function saveAiProcessingCoverage(db: Database.Database, documentId: string, coverage: AiProcessingCoverage | undefined): void {
  db.prepare('UPDATE ai_documents SET parse_coverage = ? WHERE id = ?').run(coverage ? JSON.stringify(coverage) : null, documentId)
}
