import { contextBridge, ipcRenderer } from 'electron'
import { createAiWorkflowClient } from '../../src/shared/ai-workflow'
contextBridge.exposeInMainWorld('aiWorkflowAPI', createAiWorkflowClient((channel, ...args) => ipcRenderer.invoke(channel, ...args)))
contextBridge.exposeInMainWorld('electronAPI', {
  getSetting: async () => ({ success: true, value: 'light' }),
  onAppNavigate: () => () => undefined,
  onClipboardShareDetected: () => () => undefined,
  getAppLockStatus: async () => ({ success: true, enabled: false, locked: false }),
  onAppLockChanged: () => () => undefined,
  aiDocumentList: () => ipcRenderer.invoke('fixture:documents'),
  aiTaskList: async () => ({ success: true, tasks: [] }),
  aiProviderGet: async () => ({ success: true, config: { id: 'fixture', name: '隔离测试模型', type: 'openai-compatible', baseUrl: 'http://127.0.0.1', model: 'fixture-only', transcriptionModel: '', embeddingModel: '', hasApiKey: false } }),
  aiConversationList: async () => ({ success: true, conversations: [] }),
  aiLocalToolsGet: async () => ({ success: true, tools: [] }),
  aiProcessingPolicyGet: async () => ({ success: true, policy: { allowModelFallback: false, useSemanticIndex: false } }),
  onAiProviderChanged: () => () => undefined,
  onAiTaskUpdated: () => () => undefined,
  onAiAskStreamEvent: () => () => undefined,
  aiCitationPreview: input => ipcRenderer.invoke('ai:citation-preview', input),
  aiCitationPreviewCleanup: id => ipcRenderer.invoke('ai:citation-preview-cleanup', id),
})
