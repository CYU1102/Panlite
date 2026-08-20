export type AiSourceType = 'local' | 'cloud'

export type AiDocumentStatus = 'queued' | 'processing' | 'ready' | 'awaiting_parser' | 'unsupported' | 'failed'

export type AiTaskType = 'import' | 'parse' | 'ocr' | 'transcribe' | 'index' | 'chat' | 'workflow'

export type AiTaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled'

export interface AiDocument {
  id: string
  name: string
  sourceType: AiSourceType
  sourceAccountId?: string
  sourceFileId?: string
  sourcePath?: string
  extension: string
  mimeType: string
  size: number
  sha256: string
  status: AiDocumentStatus
  contentPreview?: string
  errorMessage?: string
  createdAt: number
  updatedAt: number
}

export interface AiTask {
  id: string
  taskType: AiTaskType
  title: string
  documentId?: string
  status: AiTaskStatus
  progress: number
  message?: string
  errorMessage?: string
  createdAt: number
  updatedAt: number
  finishedAt?: number
}

export interface AiImportFileInput {
  localPath: string
  fileName?: string
}

export interface AiSelectFilesResult {
  success: boolean
  files?: Array<{ localPath: string; fileName: string; fileSize: number }>
  error?: string
}

export interface AiDocumentListResult {
  success: boolean
  documents?: AiDocument[]
  error?: string
}

export interface AiTaskListResult {
  success: boolean
  tasks?: AiTask[]
  error?: string
}

export type AiProviderType = 'openai-compatible' | 'ollama'

export interface AiProviderConfig {
  id: string
  name: string
  type: AiProviderType
  baseUrl: string
  model: string
  transcriptionModel: string
  embeddingModel: string
  hasApiKey: boolean
}

export interface AiProviderSaveInput {
  id?: string
  name?: string
  type: AiProviderType
  baseUrl: string
  model: string
  transcriptionModel?: string
  embeddingModel?: string
  apiKey?: string
  clearApiKey?: boolean
}

export interface AiProviderUsage {
  profileId: string
  requestCount: number
  failureCount: number
  inputCharacters: number
  outputCharacters: number
  lastUsedAt?: number
  lastLatencyMs?: number
}

export interface AiChatHistoryItem {
  role: 'user' | 'assistant'
  content: string
}

export interface AiAskInput {
  question: string
  documentIds?: string[]
  history?: AiChatHistoryItem[]
  conversationId?: string
  regenerate?: boolean
}

export interface AiCitation {
  documentId: string
  documentName: string
  pageNumber?: number
  section?: string
  quote: string
}

export interface AiConversationSearchHit {
  conversationId: string
  title: string
  snippet: string
  updatedAt: number
}

export type AiLocalToolKey = 'tesseract' | 'ffmpeg' | 'whisper' | 'libreoffice'

export interface AiLocalToolsConfig {
  tesseractPath: string
  ffmpegPath: string
  whisperPath: string
  libreOfficePath: string
  ocrLanguage: string
  whisperModel: string
  whisperModelPath: string
}

export interface AiLocalToolStatus {
  key: AiLocalToolKey
  name: string
  available: boolean
  resolvedPath?: string
  version?: string
  message: string
}

export interface AiAskResult {
  success: boolean
  answer?: string
  citations?: AiCitation[]
  error?: string
}

export type AiAskStreamEventType = 'started' | 'delta' | 'completed' | 'cancelled' | 'error'

export interface AiAskStreamEvent {
  requestId: string
  type: AiAskStreamEventType
  delta?: string
  answer?: string
  citations?: AiCitation[]
  error?: string
}

export type AiConversationMessageRole = 'user' | 'assistant'

export interface AiConversation {
  id: string
  title: string
  documentIds: string[]
  createdAt: number
  updatedAt: number
}

export interface AiConversationMessage {
  id: string
  conversationId: string
  role: AiConversationMessageRole
  content: string
  citations?: AiCitation[]
  createdAt: number
}

export interface AiConversationCreateInput {
  title?: string
  documentIds?: string[]
}

export interface AiConversationMessageAppendInput {
  conversationId: string
  role: AiConversationMessageRole
  content: string
  citations?: AiCitation[]
}
