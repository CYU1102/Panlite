import fs from 'node:fs'
import { dialog } from 'electron'
import { getDb } from '../db'
import type { IpcRegistrar } from '../ipc/types'
import { AI_WORKFLOW_CHANNELS } from '../../shared/ai-workflow'
import { DocumentWorkflowStore, exportWorkflowMarkdown } from './document-workflow-store'
import { DocumentWorkflowRuntime } from './document-workflow-runtime'

let runtime: DocumentWorkflowRuntime | undefined
export function getDocumentWorkflowRuntime(): DocumentWorkflowRuntime {
  if (!runtime) runtime = new DocumentWorkflowRuntime(new DocumentWorkflowStore(getDb()))
  return runtime
}
export function cleanupDocumentWorkflowRuntime(): void { runtime?.dispose(); runtime = undefined }

export function registerDocumentWorkflowIpc(ipc: IpcRegistrar): void {
  const handle = (channel: string, action: (...args: any[]) => unknown) => ipc.handle(channel, async (_event, ...args: unknown[]) => {
    try { return { success: true, data: await action(...args) } } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
  handle(AI_WORKFLOW_CHANNELS.list, () => getDocumentWorkflowRuntime().store.list())
  handle(AI_WORKFLOW_CHANNELS.get, id => getDocumentWorkflowRuntime().store.get(id))
  handle(AI_WORKFLOW_CHANNELS.start, input => getDocumentWorkflowRuntime().start(input))
  handle(AI_WORKFLOW_CHANNELS.resume, id => getDocumentWorkflowRuntime().resume(id))
  handle(AI_WORKFLOW_CHANNELS.cancel, id => getDocumentWorkflowRuntime().cancel(id))
  handle(AI_WORKFLOW_CHANNELS.templates, () => getDocumentWorkflowRuntime().store.templates())
  handle(AI_WORKFLOW_CHANNELS.saveTemplate, input => getDocumentWorkflowRuntime().store.saveTemplate(input))
  handle(AI_WORKFLOW_CHANNELS.deleteTemplate, id => { getDocumentWorkflowRuntime().store.deleteTemplate(id); return null })
  ipc.handle(AI_WORKFLOW_CHANNELS.export, async (_event, id: string, format: string) => {
    try {
      if (format !== 'json' && format !== 'markdown') throw new Error('导出格式无效')
      const run = getDocumentWorkflowRuntime().store.get(id)
      const extension = format === 'json' ? 'json' : 'md'
      const selected = await dialog.showSaveDialog({ title: '导出文档处理结果', defaultPath: `PanLite-${run.id}.${extension}`, filters: [{ name: format === 'json' ? '结构化 JSON' : 'Markdown', extensions: [extension] }] })
      if (selected.canceled || !selected.filePath) return { success: true, canceled: true }
      await fs.promises.writeFile(selected.filePath, format === 'json' ? JSON.stringify(run, null, 2) : exportWorkflowMarkdown(run), 'utf8')
      return { success: true, filePath: selected.filePath, data: null }
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  })
}
