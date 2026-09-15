export interface AiProcessingCoverage {
  version: 1
  unit: 'pages' | 'bytes' | 'sections'
  sourceUnits?: number
  parsedUnits: number
  missingUnits?: number[]
  /** Processing coverage is independent of OCR/transcription factual accuracy. */
  sourceComplete: boolean
  partial: boolean
  warnings: string[]
}
