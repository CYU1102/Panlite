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
  /** Last completed parsing result, including omissions and indexing limitations. */
  parseMessage?: string
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
  /** 从网盘导入时标记来源 */
  sourceAccountId?: string
  sourceFileId?: string
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

export type AiProviderType = 'openai-compatible' | 'openai-responses' | 'anthropic' | 'gemini' | 'ollama'

export interface AiProviderConfig {
  id: string
  name: string
  type: AiProviderType
  baseUrl: string
  model: string
  transcriptionModel: string
  embeddingModel: string
  hasApiKey: boolean
  /** 已保存的 Key 池数量 */
  keyCount?: number
  /** 掩码后的 Key 预览（不回传明文） */
  keyPreviews?: string[]
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
  /** 追加到 Key 池的 Key（每行一个由调用方拆好） */
  appendKeys?: string[]
  /** 从 Key 池中移除指定下标 */
  removeKeyAt?: number
  /** 从原 Key 池中移除多个指定下标 */
  removeKeyIndices?: number[]
  clearApiKey?: boolean
  /** 默认保存后启用；false 仅保存，不切换当前配置。 */
  activate?: boolean
}

export interface AiProviderDraftInput {
  type: AiProviderType
  baseUrl: string
  model?: string
  apiKey?: string
  clearApiKey?: boolean
  appendKeys?: string[]
  removeKeyAt?: number
  removeKeyIndices?: number[]
  /** 已保存配置的 ID；仅协议和规范化接口地址均相同时可复用原密钥。 */
  profileId?: string
}

export interface AiProviderBalance {
  total?: number
  used?: number
  remaining?: number
  unlimited?: boolean
  currency: string
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
  chunkId?: string
  sourceSha256?: string
  startSeconds?: number
  endSeconds?: number
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

export type AiLocalToolKey = 'tesseract' | 'ffmpeg' | 'whisper' | 'libreoffice' | 'pdftoppm'

export interface AiLocalToolsConfig {
  tesseractPath: string
  ffmpegPath: string
  whisperPath: string
  libreOfficePath: string
  pdftoppmPath: string
  ocrLanguage: string
  whisperModel: string
  whisperModelPath: string
}

export interface AiLocalToolStatus {
  key: AiLocalToolKey
  name: string
  available: boolean
  /** Executable and required local dependencies have passed detection; not an accuracy guarantee. */
  ready?: boolean
  subtitleAvailable?: boolean
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
