import { describe, expect, it } from 'vitest'
import {
  AI_CONVERSATION_LIMITS,
  normalizeAiConversationDocumentIds,
  normalizeAiConversationMessage,
  normalizeAiConversationTitle,
} from './conversation-service'

describe('AI conversation input validation', () => {
  it('normalizes titles and supplies the create default', () => {
    expect(normalizeAiConversationTitle('  项目   总结  ')).toBe('项目 总结')
    expect(normalizeAiConversationTitle(undefined, true)).toBe('新对话')
    expect(() => normalizeAiConversationTitle(' '.repeat(3))).toThrow('会话标题不能为空')
  })

  it('enforces the title length limit', () => {
    expect(() => normalizeAiConversationTitle('a'.repeat(AI_CONVERSATION_LIMITS.title + 1)))
      .toThrow(`会话标题不能超过 ${AI_CONVERSATION_LIMITS.title} 个字符`)
  })

  it('deduplicates document ids and rejects oversized selections', () => {
    expect(normalizeAiConversationDocumentIds(['doc-1', ' doc-1 ', 'doc-2']))
      .toEqual(['doc-1', 'doc-2'])
    expect(() => normalizeAiConversationDocumentIds(
      Array.from({ length: AI_CONVERSATION_LIMITS.documentCount + 1 }, (_, index) => `doc-${index}`),
    )).toThrow(`单个会话最多关联 ${AI_CONVERSATION_LIMITS.documentCount} 个文档`)
  })

  it('uses separate user and assistant message limits', () => {
    expect(normalizeAiConversationMessage('user', '  你好  ')).toEqual({ role: 'user', content: '你好' })
    expect(() => normalizeAiConversationMessage(
      'user',
      'a'.repeat(AI_CONVERSATION_LIMITS.userMessage + 1),
    )).toThrow(`消息内容不能超过 ${AI_CONVERSATION_LIMITS.userMessage} 个字符`)
    expect(() => normalizeAiConversationMessage('system', '不可保存')).toThrow('消息角色无效')
  })
})
