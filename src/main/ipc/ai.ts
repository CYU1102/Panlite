import { dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import { IPC_CHANNELS } from '../../shared/constants'
import { generateId } from '../../shared/utils'
import { askAiDocuments, deleteAiDocument, importAiFiles, listAiDocuments, listAiTasks, reindexAiDocument, streamAiDocuments, writeAiKnowledgeMarkdown } from '../ai/ai-service'
import { getAiProviderConfig, listProviderModels, queryAiProviderBalance, saveAiProviderConfig, testAiProvider, testAiProviderConfig } from '../ai/ai-provider'
import { importAiCloudFiles } from '../ai/cloud-import'
import { activateAiProviderProfile, deleteAiProviderProfile, duplicateAiProviderProfile, getAiProviderUsage, listAiProviderProfiles } from '../ai/ai-provider-store'
import { notifyAiProviderChanged } from '../runtime-services'
import { getAiLocalToolsConfig, listAiLocalToolStatuses, saveAiLocalToolsConfig } from '../ai/local-ai-tools'
import { getAiProcessingPolicy, saveAiProcessingPolicy } from '../ai/processing-policy'
import type { AiAskInput, AiAskStreamEvent, AiConversationCreateInput, AiConversationMessageAppendInput, AiProviderDraftInput, AiProviderSaveInput } from '../../shared/ai-types'
import { appendAiConversationMessage, createAiConversation, deleteAiConversation, listAiConversationMessages, listAiConversations, renameAiConversation, setAiConversationDocumentIds, searchAiConversations, exportAiConversationMarkdown, truncateAiConversationFromMessage, deleteLastAiConversationAssistant } from '../ai/conversation-service'
import type { IpcRegistrar } from './types'

const activeAiStreams = new Map<string, { controller: AbortController; senderId: number }>()

export function cleanupAiIpc(): void {
  for (const stream of activeAiStreams.values()) stream.controller.abort()
  activeAiStreams.clear()
}

export function registerAiIpcHandlers(ipcMain: IpcRegistrar): void {
  // ---- Independent AI workspace ----
  // AI imports are explicit user actions and never enqueue share/transfer tasks.
  ipcMain.handle(IPC_CHANNELS.AI_SELECT_FILES, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要导入 AI 工作台的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文档、媒体与压缩包', extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'json', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'srt', 'vtt', 'ass', 'ssa', 'lrc', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'mp4', 'mkv', 'avi', 'mov', 'webm', 'zip', 'rar', '7z', 'tar', 'gz', 'tgz'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled) return { success: true, files: [] }
    const files = result.filePaths.flatMap((localPath) => {
      try {
        const stat = fs.statSync(localPath)
        return stat.isFile() ? [{ localPath, fileName: path.basename(localPath), fileSize: stat.size }] : []
      } catch {
        return []
      }
    })
    return { success: true, files }
  })
  ipcMain.handle(IPC_CHANNELS.AI_IMPORT_FILES, async (_event, inputs: Array<{ localPath: string; fileName?: string }>) => {
    try {
      return await importAiFiles(inputs)
    } catch (error) {
      return { success: false, documents: [], taskIds: [], error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.AI_IMPORT_CLOUD_FILE, async (_event, requests: Array<{ accountId: string; fileId: string; fileName: string }>) => {
    try {
      return await importAiCloudFiles(Array.isArray(requests) ? requests : [])
    } catch (error) {
      return { success: false, documents: [], taskIds: [], error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.AI_DOCUMENT_LIST, async () => ({ success: true, documents: listAiDocuments() }))
  ipcMain.handle(IPC_CHANNELS.AI_DOCUMENT_DELETE, async (_event, id: string) => ({ success: deleteAiDocument(String(id || '')) }))
  ipcMain.handle(IPC_CHANNELS.AI_DOCUMENT_REINDEX, async (_event, id: string) => reindexAiDocument(String(id || '')))
  ipcMain.handle(IPC_CHANNELS.AI_TASK_LIST, async () => ({ success: true, tasks: listAiTasks() }))
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_GET, async () => {
    try {
      return { success: true, config: getAiProviderConfig() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_SAVE, async (_event, input: AiProviderSaveInput) => {
    try {
      const config = saveAiProviderConfig(input)
      const active = getAiProviderConfig()
      notifyAiProviderChanged(active)
      return { success: true, config, active }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_TEST, async () => {
    try {
      return { success: true, message: await testAiProvider() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_LIST, async () => ({ success: true, profiles: listAiProviderProfiles(), active: getAiProviderConfig() }))
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_TEST_CONFIG, async (_event, input: AiProviderDraftInput) => {
    try {
      return { success: true, ...(await testAiProviderConfig(input)) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_LIST_MODELS, async (_event, input: AiProviderDraftInput) => {
    try {
      return { success: true, models: await listProviderModels(input) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_QUERY_BALANCE, async (_event, input: AiProviderDraftInput) => {
    try {
      return { success: true, balance: await queryAiProviderBalance(input) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_ACTIVATE, async (_event, id: string) => {
    try {
      const config = activateAiProviderProfile(String(id || ''))
      notifyAiProviderChanged(config)
      return { success: true, config }
    }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_DELETE, async (_event, id: string) => {
    try {
      const success = deleteAiProviderProfile(String(id || ''))
      if (success) notifyAiProviderChanged(getAiProviderConfig())
      return { success }
    }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_DUPLICATE, async (_event, id: string) => {
    try {
      const config = duplicateAiProviderProfile(String(id || ''))
      const active = getAiProviderConfig()
      notifyAiProviderChanged(active)
      return { success: true, config, active }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_PROVIDER_USAGE, async () => ({ success: true, usage: getAiProviderUsage() }))
  ipcMain.handle(IPC_CHANNELS.AI_PROCESSING_POLICY_GET, async () => ({ success: true, policy: getAiProcessingPolicy() }))
  ipcMain.handle(IPC_CHANNELS.AI_PROCESSING_POLICY_SAVE, async (_event, input: unknown) => {
    try { return { success: true, policy: saveAiProcessingPolicy(input) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_LOCAL_TOOLS_GET, async () => {
    try { return { success: true, config: getAiLocalToolsConfig(), tools: await listAiLocalToolStatuses() } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_LOCAL_TOOLS_SAVE, async (_event, input: Record<string, unknown>) => {
    try {
      const config = saveAiLocalToolsConfig(input)
      return { success: true, config, tools: await listAiLocalToolStatuses() }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_LOCAL_TOOLS_SELECT, async (_event, key: string) => {
    const isModel = key === 'whisperModelPath'
    const result = await dialog.showOpenDialog({
      title: isModel ? '选择 Whisper GGML 模型文件' : '选择本地能力工具',
      properties: ['openFile'],
      filters: isModel
        ? [{ name: 'Whisper 模型', extensions: ['bin', 'gguf'] }, { name: '所有文件', extensions: ['*'] }]
        : [{ name: '可执行程序', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }],
    })
    return { success: true, filePath: result.canceled ? undefined : result.filePaths[0] }
  })
  ipcMain.handle(IPC_CHANNELS.AI_ASK, async (_event, input: AiAskInput) => askAiDocuments(input))
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_LIST, async () => ({ success: true, conversations: listAiConversations() }))
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_CREATE, async (_event, input: AiConversationCreateInput) => {
    try { return { success: true, conversation: createAiConversation(input || {}) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_RENAME, async (_event, id: string, title: string) => {
    try {
      const conversation = renameAiConversation(id, title)
      return conversation ? { success: true, conversation } : { success: false, error: '会话不存在' }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_DELETE, async (_event, id: string) => {
    try { return { success: deleteAiConversation(id) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_SET_DOCUMENTS, async (_event, id: string, documentIds: string[]) => {
    try {
      const conversation = setAiConversationDocumentIds(id, documentIds)
      return conversation ? { success: true, conversation } : { success: false, error: '会话不存在' }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_MESSAGES, async (_event, id: string) => {
    try { return { success: true, messages: listAiConversationMessages(id) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_SEARCH, async (_event, query: string) => {
    try { return { success: true, hits: searchAiConversations(query) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_TRUNCATE, async (_event, conversationId: string, messageId: string) => {
    try { return { success: truncateAiConversationFromMessage(conversationId, messageId) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_CONVERSATION_EXPORT, async (_event, id: string) => {
    try {
      const exported = exportAiConversationMarkdown(id)
      const safeTitle = exported.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'AI 对话'
      const selected = await dialog.showSaveDialog({
        title: '导出 AI 对话', defaultPath: `${safeTitle}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (selected.canceled || !selected.filePath) return { success: true, canceled: true }
      fs.writeFileSync(selected.filePath, exported.markdown, 'utf8')
      return { success: true, filePath: selected.filePath }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_KNOWLEDGE_EXPORT, async () => {
    try {
      const selected = await dialog.showSaveDialog({
        title: '导出完整 AI 知识库', defaultPath: `PanLite-AI-Knowledge-${new Date().toISOString().slice(0, 10)}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (selected.canceled || !selected.filePath) return { success: true, canceled: true }
      return { success: true, filePath: selected.filePath, ...writeAiKnowledgeMarkdown(selected.filePath) }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.AI_ASK_STREAM_START, async (event, input: AiAskInput) => {
    const requestId = generateId()
    const controller = new AbortController()
    const sender = event.sender
    activeAiStreams.set(requestId, { controller, senderId: sender.id })
    const send = (payload: Omit<AiAskStreamEvent, 'requestId'>): void => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.AI_ASK_STREAM_EVENT, { requestId, ...payload } satisfies AiAskStreamEvent)
    }

    void (async () => {
      try {
        const question = String(input?.question || '').trim()
        if (question.length < 2 || question.length > 2_000) throw new Error('问题长度应为 2 到 2000 个字符')
        let history = input.history || []
        if (input.conversationId) {
          if (input.regenerate) deleteLastAiConversationAssistant(input.conversationId)
          const previous = listAiConversationMessages(input.conversationId)
          const historyMessages = input.regenerate
            ? previous.slice(0, Math.max(0, previous.map(message => message.role).lastIndexOf('user')))
            : previous
          history = historyMessages.map(message => ({ role: message.role, content: message.content })).slice(-8)
          setAiConversationDocumentIds(input.conversationId, input.documentIds || [])
          if (!input.regenerate) appendAiConversationMessage({ conversationId: input.conversationId, role: 'user', content: question })
        }
        send({ type: 'started' })
        const result = await streamAiDocuments({ ...input, question, history }, {
          signal: controller.signal,
          onDelta: delta => send({ type: 'delta', delta }),
        })
        if (controller.signal.aborted) {
          send({ type: 'cancelled', error: '已停止生成' })
        } else if (result.success && result.answer) {
          if (input.conversationId) {
            const message: AiConversationMessageAppendInput = {
              conversationId: input.conversationId,
              role: 'assistant',
              content: result.answer,
              citations: result.citations,
            }
            appendAiConversationMessage(message)
          }
          send({ type: 'completed', answer: result.answer, citations: result.citations })
        } else {
          send({ type: 'error', error: result.error || '生成失败' })
        }
      } catch (error) {
        send({ type: controller.signal.aborted ? 'cancelled' : 'error', error: controller.signal.aborted ? '已停止生成' : error instanceof Error ? error.message : String(error) })
      } finally {
        activeAiStreams.delete(requestId)
      }
    })()
    return { success: true, requestId }
  })
  ipcMain.handle(IPC_CHANNELS.AI_ASK_STREAM_CANCEL, async (event, requestId: string) => {
    const stream = activeAiStreams.get(String(requestId || ''))
    if (!stream || stream.senderId !== event.sender.id) return { success: false, error: '生成任务不存在或已经结束' }
    stream.controller.abort(new DOMException('用户停止生成', 'AbortError'))
    return { success: true }
  })

}
