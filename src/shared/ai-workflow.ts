import type { AiCitation } from './ai-types'

export type AiWorkflowMode = 'summary' | 'compare' | 'extract'
export type AiWorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type AiWorkflowFieldType = 'text' | 'number' | 'date' | 'boolean'
export interface AiWorkflowTemplateField { key: string; label: string; type: AiWorkflowFieldType; description?: string }
export interface AiWorkflowTemplate { id: string; name: string; fields: AiWorkflowTemplateField[]; updatedAt: number }
export interface AiWorkflowStartInput {
  mode: AiWorkflowMode
  documentIds: string[]
  templateId?: string
  /** Optional instruction; the complete selected content still passes through every batch. */
  instruction?: string
}
export interface AiWorkflowCoverage {
  documentId: string
  documentName: string
  sourceSha256: string
  totalChunks: number
  processedChunks: number
  totalBatches: number
  completedBatches: number
  /** Only true when parser metadata explicitly establishes complete extraction. */
  sourceComplete: boolean
  parseNotice: string
  pendingRanges: string[]
}
export interface AiWorkflowSummarySection { title: string; documentId: string; summary: string; citations: AiCitation[] }
export interface AiWorkflowDifference {
  field: string
  leftValue: string | number | boolean | null
  rightValue: string | number | boolean | null
  change: 'added' | 'removed' | 'changed' | 'unchanged' | 'uncertain'
  citations: AiCitation[]
}
export interface AiWorkflowExtractedField {
  key: string
  label: string
  value: string | number | boolean | null
  status: 'found' | 'missing' | 'conflict' | 'unknown'
  citations: AiCitation[]
}
export interface AiWorkflowResult {
  sections: AiWorkflowSummarySection[]
  differences: AiWorkflowDifference[]
  fields: AiWorkflowExtractedField[]
  notice: string
}
export interface AiWorkflowBatch {
  id: string
  index: number
  documentId: string
  title: string
  status: AiWorkflowStatus
  chunkCount: number
  attempts: number
  error?: string
}
export interface AiWorkflowRun {
  id: string
  mode: AiWorkflowMode
  title: string
  documentIds: string[]
  status: AiWorkflowStatus
  totalBatches: number
  completedBatches: number
  createdAt: number
  updatedAt: number
  error?: string
  coverage: AiWorkflowCoverage[]
  result: AiWorkflowResult
  batches: AiWorkflowBatch[]
}
export interface AiWorkflowResponse<T> { success: boolean; data?: T; error?: string; canceled?: boolean; filePath?: string }
export const AI_WORKFLOW_CHANNELS = {
  list: 'ai:workflow-list', get: 'ai:workflow-get', start: 'ai:workflow-start',
  resume: 'ai:workflow-resume', cancel: 'ai:workflow-cancel', export: 'ai:workflow-export',
  templates: 'ai:workflow-templates', saveTemplate: 'ai:workflow-template-save', deleteTemplate: 'ai:workflow-template-delete',
} as const
export interface AiWorkflowApi {
  list(): Promise<AiWorkflowResponse<AiWorkflowRun[]>>
  get(id: string): Promise<AiWorkflowResponse<AiWorkflowRun>>
  start(input: AiWorkflowStartInput): Promise<AiWorkflowResponse<AiWorkflowRun>>
  resume(id: string): Promise<AiWorkflowResponse<AiWorkflowRun>>
  cancel(id: string): Promise<AiWorkflowResponse<AiWorkflowRun>>
  export(id: string, format: 'json' | 'markdown'): Promise<AiWorkflowResponse<null>>
  templates(): Promise<AiWorkflowResponse<AiWorkflowTemplate[]>>
  saveTemplate(input: Omit<AiWorkflowTemplate, 'id' | 'updatedAt'> & { id?: string }): Promise<AiWorkflowResponse<AiWorkflowTemplate>>
  deleteTemplate(id: string): Promise<AiWorkflowResponse<null>>
}

export function createAiWorkflowClient(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): AiWorkflowApi {
  return Object.fromEntries(Object.entries(AI_WORKFLOW_CHANNELS).map(([key, channel]) => [key, (...args: unknown[]) => invoke(channel, ...args)])) as unknown as AiWorkflowApi
}
