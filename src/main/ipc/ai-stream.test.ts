import Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../shared/constants'
import type { AiAskResult, AiAskStreamEvent } from '../../shared/ai-types'

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), stream: vi.fn() }))
vi.mock('../db', () => ({ getDb: mocks.getDb }))
vi.mock('electron', () => ({ dialog: {} }))
vi.mock('../ai/ai-service', () => ({ streamAiDocuments: mocks.stream }))
vi.mock('../ai/ai-provider', () => ({}))
vi.mock('../ai/cloud-import', () => ({}))
vi.mock('../ai/ai-provider-store', () => ({}))
vi.mock('../runtime-services', () => ({}))
vi.mock('../ai/local-ai-tools', () => ({}))
vi.mock('../ai/processing-policy', () => ({}))

import { cleanupAiIpc, registerAiIpcHandlers } from './ai'
import { appendAiConversationMessage, createAiConversation, deleteAiConversation, listAiConversationMessages, listAiConversations } from '../ai/conversation-service'

let database: Database.Database
let handlers: Record<string, (...args: any[]) => any>
let events: AiAskStreamEvent[]
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const sender = Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false, send: (_channel: string, event: AiAskStreamEvent) => events.push(event) })

beforeEach(() => {
  vi.resetAllMocks()
  database = new Database(':memory:')
  database.exec(`
    CREATE TABLE ai_conversations(id TEXT PRIMARY KEY,title TEXT,document_ids TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE ai_conversation_messages(id TEXT PRIMARY KEY,conversation_id TEXT,message_index INTEGER,role TEXT,content TEXT,citations TEXT,created_at INTEGER);
    CREATE UNIQUE INDEX message_order ON ai_conversation_messages(conversation_id,message_index);
  `)
  mocks.getDb.mockReturnValue(database)
  handlers = {}; events = []
  registerAiIpcHandlers({ handle: (channel, handler) => { handlers[channel] = handler } })
})
afterEach(() => { cleanupAiIpc(); sender.removeAllListeners(); database.close() })

function fixture() {
  const conversation = createAiConversation({ title: '保留已有答案', documentIds: ['original-document'] })
  appendAiConversationMessage({ conversationId: conversation.id, role: 'user', content: '付款日期是什么？' })
  const answer = appendAiConversationMessage({ conversationId: conversation.id, role: 'assistant', content: '原回答：星期一',
    citations: [{ documentId: 'original-document', documentName: '原件', chunkId: 'chunk1', quote: '星期一' }] })
  return { conversation, answer, input: { conversationId: conversation.id, question: '付款日期是什么？', documentIds: ['new-document'], regenerate: true } }
}
function deferred() {
  let resolve!: (result: AiAskResult) => void
  const promise = new Promise<AiAskResult>(done => { resolve = done })
  return { resolve, promise }
}

describe('AI stream regeneration persistence', () => {
  it.each(['destroyed', 'render-process-gone', 'did-start-navigation'])('cancels the owning stream after %s and never persists its late result', async lifecycle => {
    const { conversation, answer, input } = fixture(), pending = deferred()
    let destroyed = false, signal: AbortSignal | undefined
    const owner = Object.assign(new EventEmitter(), { id: 77, isDestroyed: () => destroyed, send: sender.send })
    mocks.stream.mockImplementation((_input, options) => { signal = options.signal; return pending.promise })
    await handlers[IPC_CHANNELS.AI_ASK_STREAM_START]({ sender: owner }, input)
    destroyed = lifecycle === 'destroyed'
    owner.emit(lifecycle, { isMainFrame: true, isSameDocument: false })
    const cancelledBeforeCompletion = signal?.aborted
    pending.resolve({ success: true, answer: '窗口已关闭后的迟到回答' }); await flush()
    expect(cancelledBeforeCompletion).toBe(true)
    expect(listAiConversationMessages(conversation.id)[1]).toEqual(answer)
    expect(events.some(event => event.type === 'completed')).toBe(false)
    expect(owner.listenerCount('destroyed')).toBe(0)
    expect(owner.listenerCount('render-process-gone')).toBe(0)
    expect(owner.listenerCount('did-start-navigation')).toBe(0)
  })

  it.each([{ isMainFrame: false, isSameDocument: false }, { isMainFrame: true, isSameDocument: true }])('retains generation through in-app/subframe navigation %j', async navigation => {
    const { conversation, input } = fixture(), pending = deferred()
    let signal: AbortSignal | undefined
    mocks.stream.mockImplementation((_input, options) => { signal = options.signal; return pending.promise })
    await handlers[IPC_CHANNELS.AI_ASK_STREAM_START]({ sender }, input)
    sender.emit('did-start-navigation', navigation)
    expect(signal?.aborted).toBe(false)
    pending.resolve({ success: true, answer: '导航后正常完成' }); await flush()
    expect(listAiConversationMessages(conversation.id)[1].content).toBe('导航后正常完成')
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })

  it('releases stream owner listeners after successful completion and app cleanup', async () => {
    const first = fixture(), pending = deferred()
    mocks.stream.mockReturnValue(pending.promise)
    await handlers[IPC_CHANNELS.AI_ASK_STREAM_START]({ sender }, first.input)
    expect(sender.listenerCount('destroyed')).toBe(1)
    expect(sender.listenerCount('render-process-gone')).toBe(1)
    expect(sender.listenerCount('did-start-navigation')).toBe(1)
    pending.resolve({ success: true, answer: '正常回答' }); await flush()
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(sender.listenerCount('render-process-gone')).toBe(0)
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
    const second = fixture()
    mocks.stream.mockReturnValue(new Promise(() => {}))
    await handlers[IPC_CHANNELS.AI_ASK_STREAM_START]({ sender }, second.input)
    cleanupAiIpc()
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(sender.listenerCount('render-process-gone')).toBe(0)
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
  })
  it('retains the original answer, citations and scope when generation fails', async () => {
    const { conversation, answer, input } = fixture()
    mocks.stream.mockResolvedValue({ success: false, error: '模拟模型离线' })
    await handlers[IPC_CHANNELS.AI_ASK_STREAM_START]({ sender }, input)
    await flush()
    expect(listAiConversationMessages(conversation.id)).toHaveLength(2)
    expect(listAiConversationMessages(conversation.id)[1]).toEqual(answer)
    expect(listAiConversations()[0].documentIds).toEqual(['original-document'])
    expect(events[events.length - 1]).toMatchObject({ type: 'error', error: '模拟模型离线' })
  })

  it('retains the old answer when stopped even if the provider later resolves successfully', async () => {
    const { conversation, answer, input } = fixture(), pending = deferred()
    mocks.stream.mockReturnValue(pending.promise)
    const started = await handlers[IPC_CHANNELS.AI_ASK_STREAM_START]({ sender }, input)
    await handlers[IPC_CHANNELS.AI_ASK_STREAM_CANCEL]({ sender }, started.requestId)
    pending.resolve({ success: true, answer: '不应保存的迟到回答' })
    await flush()
    expect(listAiConversationMessages(conversation.id)[1]).toEqual(answer)
    expect(listAiConversations()[0].documentIds).toEqual(['original-document'])
    expect(events[events.length - 1]?.type).toBe('cancelled')
  })

  it('atomically replaces only the captured final answer after success', async () => {
    const { conversation, answer, input } = fixture(), pending = deferred()
    mocks.stream.mockReturnValue(pending.promise)
    await handlers[IPC_CHANNELS.AI_ASK_STREAM_START]({ sender }, input)
    expect(listAiConversationMessages(conversation.id)[1]).toEqual(answer)
    pending.resolve({ success: true, answer: '新回答：星期二', citations: [{ documentId: 'new-document', documentName: '新版', quote: '星期二' }] })
    await flush()
    const saved = listAiConversationMessages(conversation.id)
    expect(saved).toHaveLength(2)
    expect(saved[1]).toMatchObject({ id: answer.id, content: '新回答：星期二', citations: [{ documentId: 'new-document', quote: '星期二' }] })
    expect(listAiConversations()[0].documentIds).toEqual(['new-document'])
    expect(events[events.length - 1]?.type).toBe('completed')
  })

  it('rolls back both answer and scope when persistence fails during replacement', async () => {
    const { conversation, answer, input } = fixture()
    database.exec("CREATE TRIGGER fail_scope BEFORE UPDATE OF document_ids ON ai_conversations BEGIN SELECT RAISE(ABORT,'模拟保存失败'); END")
    mocks.stream.mockResolvedValue({ success: true, answer: '不应覆盖的回答' })
    await handlers[IPC_CHANNELS.AI_ASK_STREAM_START]({ sender }, input)
    await flush()
    expect(listAiConversationMessages(conversation.id)[1]).toEqual(answer)
    expect(listAiConversations()[0].documentIds).toEqual(['original-document'])
    expect(events[events.length - 1]).toMatchObject({ type: 'error', error: '模拟保存失败' })
  })

  it('rejects overlapping requests for one conversation without blocking another conversation', async () => {
    const first = fixture(), second = fixture(), pendingFirst = deferred(), pendingSecond = deferred()
    mocks.stream.mockReturnValueOnce(pendingFirst.promise).mockReturnValueOnce(pendingSecond.promise)
    await handlers[IPC_CHANNELS.AI_ASK_STREAM_START]({ sender }, first.input)
    expect(await handlers[IPC_CHANNELS.AI_ASK_STREAM_START]({ sender }, first.input)).toMatchObject({ success: false })
    const secondSender = Object.assign(new EventEmitter(), { id: 42, isDestroyed: sender.isDestroyed, send: sender.send })
    await handlers[IPC_CHANNELS.AI_ASK_STREAM_START]({ sender: secondSender }, second.input)
    expect(mocks.stream).toHaveBeenCalledTimes(2)
    pendingSecond.resolve({ success: true, answer: '第二会话回答' }); await flush()
    pendingFirst.resolve({ success: true, answer: '第一会话回答' }); await flush()
    expect(listAiConversationMessages(first.conversation.id)[1].content).toBe('第一会话回答')
    expect(listAiConversationMessages(second.conversation.id)[1].content).toBe('第二会话回答')
  })

  it('does not overwrite an earlier answer or append a stale answer after a newer question', async () => {
    const { conversation, answer, input } = fixture(), pending = deferred()
    mocks.stream.mockReturnValue(pending.promise)
    await handlers[IPC_CHANNELS.AI_ASK_STREAM_START]({ sender }, input)
    appendAiConversationMessage({ conversationId: conversation.id, role: 'user', content: '后来追加的新问题' })
    pending.resolve({ success: true, answer: '过时的生成结果' }); await flush()
    expect(listAiConversationMessages(conversation.id)).toHaveLength(3)
    expect(listAiConversationMessages(conversation.id)[1]).toEqual(answer)
    expect(events[events.length - 1]?.type).toBe('error')
  })

  it('does not recreate a conversation deleted while its regeneration was in flight', async () => {
    const { conversation, input } = fixture(), pending = deferred()
    mocks.stream.mockReturnValue(pending.promise)
    await handlers[IPC_CHANNELS.AI_ASK_STREAM_START]({ sender }, input)
    deleteAiConversation(conversation.id)
    pending.resolve({ success: true, answer: '已删除会话的迟到回答' }); await flush()
    expect(listAiConversations()).toEqual([])
    expect(listAiConversationMessages(conversation.id)).toEqual([])
    expect(events[events.length - 1]?.type).toBe('error')
  })
})
