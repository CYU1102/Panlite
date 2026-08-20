import { getDb } from '../db'
import { generateId } from '../../shared/utils'
import type {
  AiCitation,
  AiConversation,
  AiConversationCreateInput,
  AiConversationMessage,
  AiConversationMessageAppendInput,
  AiConversationMessageRole,
  AiConversationSearchHit,
} from '../../shared/ai-types'

export const AI_CONVERSATION_LIMITS = {
  title: 120,
  documentCount: 100,
  documentId: 200,
  userMessage: 20_000,
  assistantMessage: 100_000,
  citations: 50,
  citationQuote: 2_000,
  messagePage: 500,
} as const

type ConversationRow = {
  id: string
  title: string
  document_ids: string
  created_at: number
  updated_at: number
}

type MessageRow = {
  id: string
  conversation_id: string
  message_index: number
  role: AiConversationMessageRole
  content: string
  citations: string | null
  created_at: number
}

function requireId(value: unknown, label: string): string {
  const id = String(value || '').trim()
  if (!id) throw new Error(`${label}不能为空`)
  if (id.length > AI_CONVERSATION_LIMITS.documentId) {
    throw new RangeError(`${label}不能超过 ${AI_CONVERSATION_LIMITS.documentId} 个字符`)
  }
  return id
}

export function normalizeAiConversationTitle(value: unknown, allowDefault = false): string {
  const title = String(value || '').trim().replace(/\s+/g, ' ')
  if (!title) {
    if (allowDefault) return '新对话'
    throw new Error('会话标题不能为空')
  }
  if (title.length > AI_CONVERSATION_LIMITS.title) {
    throw new RangeError(`会话标题不能超过 ${AI_CONVERSATION_LIMITS.title} 个字符`)
  }
  return title
}

export function normalizeAiConversationDocumentIds(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new TypeError('documentIds 必须是数组')
  if (value.length > AI_CONVERSATION_LIMITS.documentCount) {
    throw new RangeError(`单个会话最多关联 ${AI_CONVERSATION_LIMITS.documentCount} 个文档`)
  }
  const ids = value.map(item => requireId(item, '文档 ID'))
  return [...new Set(ids)]
}

export function normalizeAiConversationMessage(
  role: unknown,
  value: unknown,
): { role: AiConversationMessageRole; content: string } {
  if (role !== 'user' && role !== 'assistant') throw new TypeError('消息角色无效')
  const content = String(value || '').trim()
  if (!content) throw new Error('消息内容不能为空')
  const maximum = role === 'user'
    ? AI_CONVERSATION_LIMITS.userMessage
    : AI_CONVERSATION_LIMITS.assistantMessage
  if (content.length > maximum) throw new RangeError(`消息内容不能超过 ${maximum} 个字符`)
  return { role, content }
}

function normalizeCitations(value: unknown): AiCitation[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value)) throw new TypeError('citations 必须是数组')
  if (value.length > AI_CONVERSATION_LIMITS.citations) {
    throw new RangeError(`单条消息最多保存 ${AI_CONVERSATION_LIMITS.citations} 个引用`)
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new TypeError('引用数据无效')
    const citation = item as AiCitation
    const quote = String(citation.quote || '').trim()
    if (quote.length > AI_CONVERSATION_LIMITS.citationQuote) {
      throw new RangeError(`引用原文不能超过 ${AI_CONVERSATION_LIMITS.citationQuote} 个字符`)
    }
    return {
      documentId: requireId(citation.documentId, '引用文档 ID'),
      documentName: String(citation.documentName || '').trim().slice(0, 500),
      pageNumber: citation.pageNumber,
      section: citation.section == null ? undefined : String(citation.section).slice(0, 500),
      quote,
    }
  })
}

function parseJsonArray<T>(value: string | null): T[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function mapConversation(row: ConversationRow): AiConversation {
  return {
    id: row.id,
    title: row.title,
    documentIds: parseJsonArray<string>(row.document_ids).filter(item => typeof item === 'string'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapMessage(row: MessageRow): AiConversationMessage {
  const citations = parseJsonArray<AiCitation>(row.citations)
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    citations: citations.length ? citations : undefined,
    createdAt: row.created_at,
  }
}

function findConversation(id: string): AiConversation | null {
  const row = getDb().prepare('SELECT * FROM ai_conversations WHERE id = ?').get(id) as ConversationRow | undefined
  return row ? mapConversation(row) : null
}

export function listAiConversations(): AiConversation[] {
  const rows = getDb().prepare(
    'SELECT * FROM ai_conversations ORDER BY updated_at DESC, created_at DESC',
  ).all() as ConversationRow[]
  return rows.map(mapConversation)
}

export function createAiConversation(input: AiConversationCreateInput = {}): AiConversation {
  const now = Date.now()
  const conversation: AiConversation = {
    id: generateId(),
    title: normalizeAiConversationTitle(input.title, true),
    documentIds: normalizeAiConversationDocumentIds(input.documentIds),
    createdAt: now,
    updatedAt: now,
  }
  getDb().prepare(`
    INSERT INTO ai_conversations (id, title, document_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(conversation.id, conversation.title, JSON.stringify(conversation.documentIds), now, now)
  return conversation
}

export function renameAiConversation(idValue: string, titleValue: string): AiConversation | null {
  const id = requireId(idValue, '会话 ID')
  const title = normalizeAiConversationTitle(titleValue)
  const now = Date.now()
  const result = getDb().prepare(
    'UPDATE ai_conversations SET title = ?, updated_at = ? WHERE id = ?',
  ).run(title, now, id)
  return result.changes ? findConversation(id) : null
}

export function setAiConversationDocumentIds(idValue: string, value: string[]): AiConversation | null {
  const id = requireId(idValue, '会话 ID')
  const documentIds = normalizeAiConversationDocumentIds(value)
  const now = Date.now()
  const result = getDb().prepare(
    'UPDATE ai_conversations SET document_ids = ?, updated_at = ? WHERE id = ?',
  ).run(JSON.stringify(documentIds), now, id)
  return result.changes ? findConversation(id) : null
}

export function deleteAiConversation(idValue: string): boolean {
  const id = requireId(idValue, '会话 ID')
  return getDb().transaction(() => {
    // Keep deletion correct even if this database was opened without FK enforcement.
    getDb().prepare('DELETE FROM ai_conversation_messages WHERE conversation_id = ?').run(id)
    return getDb().prepare('DELETE FROM ai_conversations WHERE id = ?').run(id).changes > 0
  })()
}

export function listAiConversationMessages(conversationIdValue: string, limitValue = 200): AiConversationMessage[] {
  const conversationId = requireId(conversationIdValue, '会话 ID')
  const limit = Math.max(1, Math.min(AI_CONVERSATION_LIMITS.messagePage, Math.trunc(limitValue) || 200))
  const rows = getDb().prepare(`
    SELECT * FROM (
      SELECT * FROM ai_conversation_messages
      WHERE conversation_id = ?
      ORDER BY message_index DESC
      LIMIT ?
    ) ORDER BY message_index ASC
  `).all(conversationId, limit) as MessageRow[]
  return rows.map(mapMessage)
}

export function appendAiConversationMessage(input: AiConversationMessageAppendInput): AiConversationMessage {
  const conversationId = requireId(input.conversationId, '会话 ID')
  const { role, content } = normalizeAiConversationMessage(input.role, input.content)
  const citations = normalizeCitations(input.citations)
  const now = Date.now()
  const message: AiConversationMessage = {
    id: generateId(),
    conversationId,
    role,
    content,
    citations,
    createdAt: now,
  }

  getDb().transaction(() => {
    const exists = getDb().prepare('SELECT 1 FROM ai_conversations WHERE id = ?').get(conversationId)
    if (!exists) throw new Error('会话不存在或已被删除')
    const indexRow = getDb().prepare(`
      SELECT COALESCE(MAX(message_index), -1) + 1 AS next_index
      FROM ai_conversation_messages WHERE conversation_id = ?
    `).get(conversationId) as { next_index: number }
    getDb().prepare(`
      INSERT INTO ai_conversation_messages
        (id, conversation_id, message_index, role, content, citations, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(message.id, conversationId, indexRow.next_index, role, content,
      citations ? JSON.stringify(citations) : null, now)
    getDb().prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)
  })()
  return message
}

export function truncateAiConversationFromMessage(conversationIdValue: string, messageIdValue: string): boolean {
  const conversationId = requireId(conversationIdValue, '会话 ID')
  const messageId = requireId(messageIdValue, '消息 ID')
  return getDb().transaction(() => {
    const row = getDb().prepare(
      'SELECT message_index FROM ai_conversation_messages WHERE id = ? AND conversation_id = ?',
    ).get(messageId, conversationId) as { message_index: number } | undefined
    if (!row) return false
    getDb().prepare(
      'DELETE FROM ai_conversation_messages WHERE conversation_id = ? AND message_index >= ?',
    ).run(conversationId, row.message_index)
    getDb().prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conversationId)
    return true
  })()
}

export function deleteLastAiConversationAssistant(conversationIdValue: string): boolean {
  const conversationId = requireId(conversationIdValue, '会话 ID')
  const row = getDb().prepare(`
    SELECT id FROM ai_conversation_messages
    WHERE conversation_id = ? AND role = 'assistant'
    ORDER BY message_index DESC LIMIT 1
  `).get(conversationId) as { id: string } | undefined
  if (!row) return false
  return getDb().prepare('DELETE FROM ai_conversation_messages WHERE id = ?').run(row.id).changes > 0
}

export function searchAiConversations(queryValue: string): AiConversationSearchHit[] {
  const query = String(queryValue || '').trim().slice(0, 100)
  if (!query) return []
  const pattern = `%${query.replace(/[%_\\]/g, value => `\\${value}`)}%`
  const rows = getDb().prepare(`
    SELECT c.id AS conversation_id, c.title, c.updated_at,
      COALESCE((
        SELECT m.content FROM ai_conversation_messages m
        WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\'
        ORDER BY m.message_index DESC LIMIT 1
      ), '') AS snippet
    FROM ai_conversations c
    WHERE c.title LIKE ? ESCAPE '\\'
       OR EXISTS (
         SELECT 1 FROM ai_conversation_messages m
         WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\'
       )
    ORDER BY c.updated_at DESC
    LIMIT 50
  `).all(pattern, pattern, pattern) as Array<{ conversation_id: string; title: string; updated_at: number; snippet: string }>
  return rows.map(row => ({
    conversationId: row.conversation_id,
    title: row.title,
    snippet: row.snippet.replace(/\s+/g, ' ').slice(0, 180),
    updatedAt: row.updated_at,
  }))
}

export function exportAiConversationMarkdown(idValue: string): { title: string; markdown: string } {
  const id = requireId(idValue, '会话 ID')
  const conversation = findConversation(id)
  if (!conversation) throw new Error('会话不存在或已被删除')
  const messages = listAiConversationMessages(id, AI_CONVERSATION_LIMITS.messagePage)
  const lines = [`# ${conversation.title}`, '', `> 导出时间：${new Date().toLocaleString('zh-CN')}`, '']
  for (const message of messages) {
    lines.push(`## ${message.role === 'user' ? '用户' : 'PanLite AI'}`, '', message.content, '')
    if (message.citations?.length) {
      lines.push('### 引用', '')
      message.citations.forEach((citation, index) => {
        const location = citation.pageNumber ? `第 ${citation.pageNumber} 页` : citation.section || ''
        lines.push(`${index + 1}. **${citation.documentName}**${location ? `（${location}）` : ''}：${citation.quote}`)
      })
      lines.push('')
    }
  }
  return { title: conversation.title, markdown: lines.join('\n') }
}
