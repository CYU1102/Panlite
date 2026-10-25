import type { AiCitationPreviewBridge } from '@shared/ai-citation-preview'
import { plainIpcData } from './plain-ipc-data'

function bridge(): AiCitationPreviewBridge {
  const value = window.electronAPI as unknown as AiCitationPreviewBridge
  if (!value?.aiCitationPreview) throw new Error('请重新启动应用以加载引用预览功能')
  return value
}

export const aiCitationPreviewApi: AiCitationPreviewBridge = {
  aiCitationPreview: input => bridge().aiCitationPreview(plainIpcData(input)),
  aiCitationPreviewCleanup: sessionId => bridge().aiCitationPreviewCleanup(sessionId),
}
