import type { AiCitation } from './ai-types'
import type { FilePreviewSessionDto } from './file-preview'

export const AI_CITATION_PREVIEW_CHANNELS = {
  create: 'ai:citation-preview',
  cleanup: 'ai:citation-preview-cleanup',
} as const

export interface AiCitationPreviewInput {
  documentId: string
  citation: AiCitation
}

export interface AiCitationPreviewResult {
  success: boolean
  preview?: FilePreviewSessionDto
  /** Values resolved and checked against the stored document and chunk. */
  citation?: AiCitation
  error?: string
}

export interface AiCitationPreviewBridge {
  aiCitationPreview(input: AiCitationPreviewInput): Promise<AiCitationPreviewResult>
  aiCitationPreviewCleanup(sessionId: string): Promise<{ success: boolean; error?: string }>
}

/** Legacy subtitle locations, including parser labels, without inventing speech timing. */
export function subtitleTimeRange(section: string | undefined): { startSeconds?: number; endSeconds?: number } {
  const value = String(section || '')
  const stamp = '(?:\\d{1,3}:)?\\d{1,2}:\\d{2}(?:[.,]\\d{1,3})?'
  const match = new RegExp(`(?:^|[\\s·\\[])(${stamp})(?:\\s*(?:→|-->)\\s*(${stamp}))?(?:$|[\\s\\]])`).exec(value)
  if (!match) return {}
  const seconds = (text: string) => {
    const parts = text.replace(',', '.').split(':').map(Number)
    if (parts.length < 2 || parts.some(part => !Number.isFinite(part) || part < 0) || parts[parts.length - 1] >= 60 || (parts.length === 3 && parts[1] >= 60)) return undefined
    return parts.reduce((total, part) => total * 60 + part, 0)
  }
  const startSeconds = seconds(match[1])
  const endSeconds = match[2] ? seconds(match[2]) : undefined
  if (startSeconds === undefined || (endSeconds !== undefined && endSeconds < startSeconds)) return {}
  return { startSeconds, endSeconds }
}

export function citationTimeLabel(seconds: number): string {
  const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor(value % 3600 / 60)
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`
}
